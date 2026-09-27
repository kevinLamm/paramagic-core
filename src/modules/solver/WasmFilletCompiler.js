// Lower FilletSystem.evaluateGenericFillet into the resident native program.
// Candidate order, trim limits, nine-decimal offset radii, and score selection
// follow that implementation. Selection is repeated natively as geometry moves.
export function compileFillet(p, reference) {
  const definition = p.model.derivedEntity(reference.recordId);
  if (definition?.type !== 'fillet') throw new Error('Native fillet definition is missing.');
  if (definition.sourceA?.recordId === definition.sourceB?.recordId) throw new Error('Fillet sources must be distinct.');
  const radius = definition.radiusDimensionId ? p.raw('parameter', p.parameterIndex(definition.radiusDimensionId))
    : p.dynamic(model => model.derivedEntity(reference.recordId).radius);
  const endpoint = ref => {
    const b = p.binding(ref), index = Number(ref.index), arc = b.type === 'arc' ? p.round(ref) : null;
    if (!['line', 'arc', 'curve'].includes(b.type)) throw new Error(`Unsupported native fillet source ${b.type}.`);
    if (![0, b.type === 'curve' ? b.metadata.pointCount - 1 : 2].includes(index)) throw new Error('Fillet source endpoints are invalid.');
    const point = arc ? (index === 0 ? arc.start : arc.end) : p.transform(b.type === 'line'
      ? p.xy(b, index === 0 ? 'start' : 'end') : p.xy(b, `p${index}`), ref);
    if (arc) {
      const ray = p.scale(p.perpendicular(p.unit(p.subv(point, arc.center))), p.mul(p.select(arc.ccw, 1, -1), index === 0 ? 1 : -1));
      return { point, ray, arc, index };
    }
    const inner = p.transform(b.type === 'line' ? p.xy(b, index === 0 ? 'end' : 'start')
      : p.xy(b, `p${index === 0 ? 1 : b.metadata.pointCount - 2}`), ref);
    const delta = p.subv(inner, point);
    return { point, ray: p.unit(delta), available: p.length(delta), index };
  };
  const a = endpoint(definition.sourceA), b = endpoint(definition.sourceB);
  const options = source => source.arc ? [1, -1].map(sign => {
    const r = p.add(source.arc.radius, p.mul(sign, radius));
    return { center: source.arc.center, radius: p.roundNine(r), valid: sign === 1 ? p.number(1) : p.gt(r, 1e-8) };
  }) : [1, -1].map(sign => ({ point: p.addv(source.point, p.scale(p.perpendicular(source.ray), p.mul(sign, radius))), dir: source.ray, valid: p.number(1) }));
  const intersections = (first, second) => {
    const valid = p.all(first.valid, second.valid);
    if (first.dir && second.dir) {
      const divisor = p.cross(first.dir, second.dir), ratio = p.div(p.cross(p.subv(second.point, first.point), second.dir), divisor);
      return [{ center: p.addv(first.point, p.scale(first.dir, ratio)), valid: p.all(valid, p.ge(p.abs(divisor), 1e-8)) }];
    }
    if (first.dir || second.dir) {
      const line = first.dir ? first : second, circle = first.dir ? second : first, axis = p.unit(line.dir);
      const rel = p.subv(line.point, circle.center), bv = p.mul(2, p.dot(axis, rel)), cv = p.sub(p.dot(rel, rel), p.square(circle.radius));
      const discriminant = p.sub(p.square(bv), p.mul(4, cv));
      const root = p.select(p.le(p.abs(discriminant), 1e-8), 0, p.sqrt(p.max(0, discriminant)));
      return [1, -1].map(sign => ({ center: p.addv(line.point, p.scale(axis, p.div(p.add(p.neg(bv), p.mul(sign, root)), 2))),
        valid: p.all(valid, p.ge(discriminant, -1e-8), sign === 1 ? 1 : p.gt(p.abs(discriminant), 1e-8)) }));
    }
    const delta = p.subv(second.center, first.center), d = p.length(delta);
    const distance = p.div(p.add(p.sub(p.square(first.radius), p.square(second.radius)), p.square(d)), p.mul(2, d));
    const hSquared = p.sub(p.square(first.radius), p.square(distance)), axis = p.scale(delta, p.div(1, d));
    const base = p.addv(first.center, p.scale(axis, distance));
    const h = p.select(p.le(p.abs(hSquared), 1e-8), 0, p.sqrt(p.max(0, hSquared)));
    return [1, -1].map(sign => ({ center: p.addv(base, p.scale(p.perpendicular(axis), p.mul(sign, h))), valid: p.all(valid,
      p.ge(d, 1e-8), p.le(d, p.add(p.add(first.radius, second.radius), 1e-8)),
      p.ge(d, p.sub(p.abs(p.sub(first.radius, second.radius)), 1e-8)), p.ge(hSquared, -1e-8), sign === 1 ? 1 : p.gt(p.abs(hSquared), 1e-8)) }));
  };
  const tangency = (source, center) => {
    if (!source.arc) {
      const axis = p.unit(source.ray), trim = p.dot(p.subv(center, source.point), axis);
      return { point: p.addv(source.point, p.scale(axis, trim)), trim, valid: p.all(p.gt(trim, 1e-8), p.lt(trim, p.sub(source.available, 1e-7))) };
    }
    const arc = source.arc, delta = p.subv(center, arc.center), direction = p.unit(delta);
    const point = p.addv(arc.center, p.scale(direction, arc.radius)), angle = p.angle(p.subv(point, arc.center));
    const start = p.angle(p.subv(arc.start, arc.center)), end = p.angle(p.subv(arc.end, arc.center));
    const travel = source.index === 0 ? p.modTau(p.select(arc.ccw, p.sub(angle, start), p.sub(start, angle)))
      : p.modTau(p.select(arc.ccw, p.sub(end, angle), p.sub(angle, end)));
    return { point, trim: p.mul(travel, arc.radius), valid: p.all(p.gt(p.length(delta), 1e-8), p.gt(travel, 1e-6), p.lt(travel, p.sub(p.abs(arc.span), 1e-6))) };
  };
  let score = p.number(Infinity), center = [NaN, NaN], start = [NaN, NaN], end = [NaN, NaN], middle = [NaN, NaN];
  for (const first of options(a)) for (const second of options(b)) for (const candidate of intersections(first, second)) {
    const ta = tangency(a, candidate.center), tb = tangency(b, candidate.center);
    const sum = p.addv(p.subv(ta.point, candidate.center), p.subv(tb.point, candidate.center));
    const valid = p.all(candidate.valid, ta.valid, tb.valid, p.gt(p.length(sum), 1e-8));
    const cost = p.add(p.add(ta.trim, tb.trim), p.mul(p.length(p.subv(candidate.center, p.midpoint(a.point, b.point))), 0.01));
    const select = p.all(valid, p.lt(cost, score));
    center = p.choose(select, candidate.center, center); start = p.choose(select, ta.point, start); end = p.choose(select, tb.point, end);
    middle = p.choose(select, p.addv(candidate.center, p.scale(p.unit(sum), radius)), middle); score = p.select(select, cost, score);
  }
  // acos(dot) corner check in FilletSystem, expressed as monotonic comparisons.
  const corner = p.all(p.gt(radius, 1e-8), p.lt(p.abs(p.dot(a.ray, b.ray)), Math.cos(1e-5)));
  center = p.choose(corner, center, [NaN, NaN]);
  return { center, start, end, radius, ccw: p.gt(p.cross(p.subv(start, center), p.subv(middle, center)), 0) };
}
