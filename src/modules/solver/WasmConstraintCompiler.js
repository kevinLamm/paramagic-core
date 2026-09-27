import { isCanvasOriginReference } from '../CanvasOrigin.js';
import { compileFillet } from './WasmFilletCompiler.js';

// Opcode order is part of native ABI 4 (native/constraint_program.h).
const operations = ['literal', 'variable', 'parameter', 'add', 'sub', 'mul', 'div', 'neg', 'abs', 'sqrt',
  'hypot', 'sin', 'cos', 'atan2', 'modTau', 'min', 'max', 'lt', 'le', 'gt', 'ge', 'select', 'difference', 'normalized', 'roundNine', 'guard', 'dependent', 'swellValue'];
class Expression { constructor(index) { this.index = index; } }

// This builder runs only when topology changes. No expressions, objects, or JS
// callbacks are evaluated inside an iteration: the native module owns the tape,
// numerical values, reverse derivative scratch, and CSR entries.
export class ConstraintProgram {
  constructor(model, constraint, variableIndex, parameter, dependencies = new Map(), swell = null) {
    this.model = model; this.constraint = constraint; this.variableIndex = variableIndex; this.parameterIndex = parameter;
    this.code = []; this.data = []; this.updates = []; this.cache = new Map(); this.variableIds = new Set();
    this.dependencies = dependencies;
    this.swell = swell;
    this.forceDifference = constraint.coordinateSpace === 'global' || ['Angle', 'Meta'].includes(constraint.type);
    for (const name of operations.slice(3)) this[name] = (...args) => this.node(name, ...args);
  }
  raw(op, a = -1, b = -1, c = -1, value = 0) {
    const key = [op, a, b, c, value].join(':');
    if (this.cache.has(key)) return this.cache.get(key);
    const result = new Expression(this.data.length);
    this.code.push(operations.indexOf(op), a, b, c); this.data.push(value); this.cache.set(key, result);
    return result;
  }
  number(value) { return value instanceof Expression ? value : this.raw('literal', -1, -1, -1, value); }
  node(op, ...args) { return this.raw(op, ...args.map(value => this.number(value).index)); }
  dynamic(read) {
    const result = new Expression(this.data.length);
    this.code.push(0, -1, -1, -1); this.data.push(0); this.updates.push({ index: result.index, read }); return result;
  }
  field(key, fallback = 0) { return this.dynamic(model => model.constraints.get(this.constraint.id)?.[key] ?? fallback); }
  target() {
    if (this.constraint.dimensionRef) return this.raw('parameter', this.parameterIndex(this.constraint.dimensionRef));
    return this.field('value');
  }
  variable(binding, key) {
    const variable = binding.variables.get(key);
    if (!variable) throw new Error(`Native feature requires ${binding.type}.${key}.`);
    return this.variableId(variable.id);
  }
  variableId(id) {
    if (this.dependencies.has(id)) {
      const expression = this.dependencies.get(id).map(({ variable, weight }) => this.mul(this.variableId(variable.id), weight)).reduce((a, b) => this.add(a, b));
      return this.raw('dependent', this.variableIndex.get(id), expression.index);
    }
    const index = this.variableIndex.get(id);
    if (index === undefined) throw new Error(`Missing native variable ${id}.`);
    this.variableIds.add(id); return this.raw('variable', index);
  }
  xy(binding, key) { return ['x', 'y'].map(axis => this.variable(binding, `${key}.${axis}`)); }
  addv(a, b) { return a.map((v, i) => this.add(v, b[i])); }
  subv(a, b) { return a.map((v, i) => this.sub(v, b[i])); }
  scale(a, k) { return a.map(v => this.mul(v, k)); }
  dot(a, b) { return this.add(this.mul(a[0], b[0]), this.mul(a[1], b[1])); }
  cross(a, b) { return this.sub(this.mul(a[0], b[1]), this.mul(a[1], b[0])); }
  length(a) { return this.hypot(...a); }
  square(a) { return this.mul(a, a); }
  midpoint(a, b) { return this.scale(this.addv(a, b), 0.5); }
  perpendicular(a) { return [this.neg(a[1]), a[0]]; }
  unit(a) { return this.scale(a, this.div(1, this.length(a))); }
  angle(a) { return this.atan2(a[1], a[0]); }
  sign(a) { return this.select(this.lt(a, 0), -1, this.select(this.gt(a, 0), 1, 0)); }
  or(a, b) { return this.select(a, a, b); }
  all(...values) { return values.reduce((a, b) => this.mul(a, b), this.number(1)); }
  choose(condition, a, b) { return a.map((v, i) => this.select(condition, v, b[i])); }
  swellFeature(ref) {
    if (!this.swell) throw new Error('Native Swell world is missing.');
    const request = this.swell.request(ref, this.constraint.coordinateSpace === 'global');
    // The JS oracle uses numerical derivatives for derived Swell features.
    // Preserve that contract, executing every perturbation inside WASM.
    this.forceDifference = true;
    const field = index => this.raw('swellValue', request, index);
    return { start: [field(0), field(1)], end: [field(2), field(3)],
      center: [field(4), field(5)], radius: field(6), ccw: field(7), span: field(8),
      point: [field(9), field(10)], type: field(11) };
  }
  binding(ref) {
    if (ref?.derivedFeature) throw new Error(`Native derived provider ${ref.derivedFeature.provider} is not supported.`);
    const binding = this.model.binding(ref?.recordId || ref?.entityId);
    if (!binding) throw new Error('Native feature binding is missing.');
    return binding;
  }
  transform(point, ref) {
    if (this.constraint.coordinateSpace !== 'global') return point;
    const frameVariables = this.model.placementVariables?.get(ref?.stackId || this.model.binding(ref?.recordId || ref?.entityId)?.stackId);
    if (frameVariables) {
      const [x, y, rotation] = frameVariables.map(v => this.variableId(v.id));
      const c = this.cos(rotation), s = this.sin(rotation);
      return [this.add(this.sub(this.mul(c, point[0]), this.mul(s, point[1])), x),
        this.add(this.add(this.mul(s, point[0]), this.mul(c, point[1])), y)];
    }
    const read = key => this.dynamic(model => {
      while (model.source) model = model.source;
      return model.frameForReference(ref)?.[key] || 0;
    });
    const rotation = read('rotation'), c = this.cos(rotation), s = this.sin(rotation);
    return [this.add(this.sub(this.mul(c, point[0]), this.mul(s, point[1])), read('x')),
      this.add(this.add(this.mul(s, point[0]), this.mul(c, point[1])), read('y'))];
  }
  localPoint(binding, index, role = null) {
    switch (binding.type) {
      case 'point': if (index === 0) return this.xy(binding, 'point'); break;
      case 'line': return index === 0 ? this.xy(binding, 'start') : index === 2 ? this.xy(binding, 'end') : this.midpoint(this.xy(binding, 'start'), this.xy(binding, 'end'));
      case 'text': if (index === 0) return this.xy(binding, 'anchor'); break;
      case 'control': return this.xy(binding, index === 0 ? 'anchor' : 'middle');
      case 'table': {
        const x = this.variable(binding, 'x'), y = this.variable(binding, 'y'), w = this.variable(binding, 'width'), h = this.variable(binding, 'height');
        return [[x, y], [this.add(x, w), y], [this.add(x, w), this.add(y, h)], [x, this.add(y, h)]][index];
      }
      case 'polygon': case 'polyline': case 'curve': return this.xy(binding, `p${index}`);
      case 'circle': {
        const center = this.xy(binding, 'center'); if (index === 0) return center;
        const radius = this.abs(this.variable(binding, 'radius')), d = [[0, 0], [-1, 0], [0, -1], [1, 0], [0, 1]][index];
        if (d) return this.addv(center, this.scale(d, radius)); break;
      }
      case 'arc': {
        if (role !== 'arc-midpoint' && index !== 1) return this.xy(binding, index === 0 ? 'start' : index === 2 ? 'end' : 'center');
        const arc = this.arc(binding);
        const ratio = role === 'arc-midpoint' ? 0.5 : this.dynamic(model => model.binding(binding.id).metadata.middleRatio ?? 0.5);
        const angle = this.add(arc.startAngle, this.mul(arc.span, ratio));
        return this.addv(arc.center, this.scale([this.cos(angle), this.sin(angle)], arc.radius));
      }
    }
    throw new Error(`Unsupported native point ${binding.type}:${index}.`);
  }
  point(ref) {
    if (ref?.derivedFeature) return this.swellFeature(ref).point;
    if (isCanvasOriginReference(ref)) return this.transform([0, 0], ref);
    if (['segment-start', 'segment-end', 'segment-point'].includes(ref?.type)) {
      const line = this.segment(ref);
      return ref.type === 'segment-start' ? line.start : ref.type === 'segment-end' ? line.end
        : this.addv(line.start, this.scale(this.subv(line.end, line.start), Math.max(0, Math.min(1, Number(ref.ratio) || 0))));
    }
    const binding = this.binding(ref);
    const value = ref.type === 'center' ? this.xy(binding, 'center') : this.localPoint(binding, Number(ref.index) || 0, ref.pointRole);
    return this.transform(value, ref);
  }
  segment(ref) {
    if (ref?.derivedFeature) {
      const feature = this.swellFeature(ref), valid = this.or(this.le(feature.type, 1), this.ge(feature.type, 4));
      return { start: this.choose(valid, feature.start, [NaN, NaN]), end: this.choose(valid, feature.end, [NaN, NaN]) };
    }
    const b = this.binding(ref), index = Number(ref.index) || 0;
    let points;
    if (b.type === 'line' && index === 0) points = [this.xy(b, 'start'), this.xy(b, 'end')];
    else if (b.type === 'table') points = [this.localPoint(b, index), this.localPoint(b, (index + 1) % 4)];
    else if (['polygon', 'polyline'].includes(b.type)) points = [this.xy(b, `p${index}`), this.xy(b, `p${(index + 1) % b.metadata.pointCount}`)];
    else throw new Error(`Unsupported native segment ${b.type}.`);
    return { start: this.transform(points[0], ref), end: this.transform(points[1], ref) };
  }
  arc(binding) {
    const center = this.xy(binding, 'center'), start = this.xy(binding, 'start'), end = this.xy(binding, 'end');
    const startVector = this.subv(start, center), endVector = this.subv(end, center);
    const startRadius = this.length(startVector), endRadius = this.length(endVector);
    const radius = this.mul(this.add(startRadius, endRadius), 0.5);
    const startAngle = this.angle(startVector), endAngle = this.angle(endVector);
    const ccw = this.dynamic(model => model.binding(binding.id).metadata.ccw ? 1 : 0);
    const delta = this.modTau(this.sub(endAngle, startAngle));
    const span = this.select(ccw, delta, this.sub(delta, Math.PI * 2));
    return { center, start, end, radius, ccw, span, startAngle, endAngle, startRadius, endRadius };
  }
  round(ref, local = false) {
    if (ref?.derivedFeature) return this.swellFeature(ref);
    const b = this.binding(ref);
    let result;
    if (b.type === 'arc') result = this.arc(b);
    else if (b.type === 'circle') result = { center: this.xy(b, 'center'), radius: this.abs(this.variable(b, 'radius')) };
    else throw new Error(`Unsupported native round feature ${b.type}.`);
    if (!local) for (const key of ['center', 'start', 'end']) if (result[key]) result[key] = this.transform(result[key], ref);
    return result;
  }
  featureLength(ref) {
    if (ref.kind === 'segment') { const s = this.segment(ref); return this.length(this.subv(s.end, s.start)); }
    const a = this.round(ref, true); return this.mul(a.radius, this.abs(a.span));
  }
  lineCross(p, line) { const d = this.subv(line.end, line.start); return this.normalized(this.cross(this.subv(p, line.start), d), this.length(d)); }
  branch(offset, target) {
    const c = this.constraint, direction = c.direction;
    if (!Array.isArray(direction) || !Number.isFinite(Math.hypot(...direction)) || Math.hypot(...direction) <= 1e-12) return [];
    const d = [0, 1].map(index => this.dynamic(model => { const v = model.constraints.get(c.id).direction; return v[index] / Math.hypot(...v); }));
    return [this.min(0, this.div(this.dot(offset, d), this.max(1, this.abs(target))))];
  }
  pointOnArc(p, arc) {
    const radial = this.difference(this.dot(this.subv(p, arc.center), this.subv(p, arc.center)), this.square(arc.radius));
    const start = this.angle(this.subv(arc.start, arc.center)), end = this.angle(this.subv(arc.end, arc.center)), angle = this.angle(this.subv(p, arc.center));
    const travel = (a, b) => this.modTau(this.select(arc.ccw, this.sub(b, a), this.sub(a, b)));
    const span = travel(start, end), traveled = travel(start, angle);
    const distance = (a, b) => this.min(this.modTau(this.sub(a, b)), this.modTau(this.sub(b, a)));
    const domain = this.select(this.le(traveled, this.add(span, 1e-9)), 0, this.min(distance(angle, start), distance(angle, end)));
    this.guard(this.all(this.gt(traveled, 1e-5), this.lt(traveled, this.sub(span, 1e-5))));
    return [radial, domain];
  }
  compile() {
    const c = this.constraint, f = c.featureRefs || [], target = () => this.target();
    const pair = () => f.map(ref => this.segment(ref));
    const vectors = () => pair().map(s => this.subv(s.end, s.start));
    let result;
    switch (c.type) {
      case 'Intrinsic': { const a = this.arc(this.model.binding(c.entityId)); result = [this.sub(a.startRadius, a.endRadius)]; break; }
      case 'Coincident': result = this.subv(this.point(f[0]), this.point(f[1])); break;
      case 'Horizontal': case 'Vertical': {
        const s = this.segment(f[0]), i = c.type === 'Horizontal' ? 1 : 0;
        if (c.axisDirection && c.solveDomain === 'stack-frame') {
          const d = this.subv(s.end, s.start), sign = this.field('axisDirection');
          const angle = c.type === 'Horizontal' ? this.atan2(this.mul(sign, d[1]), this.mul(sign, d[0]))
            : this.atan2(this.neg(this.mul(sign, d[0])), this.mul(sign, d[1]));
          result = [this.mul(this.length(d), angle)];
        } else result = [this.sub(s.start[i], s.end[i])];
        break;
      }
      case 'Parallel': case 'Perpendicular': { const [a, b] = vectors(); result = [this.normalized(c.type === 'Parallel' ? this.cross(a, b) : this.dot(a, b), this.mul(this.length(a), this.length(b)))]; break; }
      case 'Point-on Line': result = [this.lineCross(this.point(f[0]), this.segment(f[1]))]; break;
      case 'Collinear': { const [a, b] = pair(); result = [this.lineCross(b.start, a), this.lineCross(b.end, a)]; break; }
      case 'Equal': {
        if (f[0]?.kind !== f[1]?.kind) throw new Error('Equal requires matching feature kinds.');
        const measure = ref => { if (ref.kind === 'circle') return this.round(ref).radius; if (ref.kind === 'arc') return this.featureLength(ref); const s = this.segment(ref), d = this.subv(s.end, s.start); return this.dot(d, d); };
        result = [this.difference(measure(f[0]), measure(f[1]))]; break;
      }
      case 'Length':
        if (f.length !== 1 || !['segment', 'arc'].includes(f[0]?.kind)) throw new Error('Length requires one segment or arc.');
        result = [this.difference(this.featureLength(f[0]), this.field('value'))]; break;
      case 'Midpoint': { const s = this.segment(f[1]); result = this.subv(this.point(f[0]), this.midpoint(s.start, s.end)); break; }
      case 'Concentric': result = this.subv(this.round(f[0]).center, this.round(f[1]).center); break;
      case 'Radius': case 'Diameter': result = [this.sub(this.mul(this.round(f[0]).radius, c.type === 'Diameter' ? 2 : 1), target())]; break;
      case 'Point-on Circle': { const p = this.point(f[0]), r = this.round(f[1]), d = this.subv(p, r.center); result = [this.difference(this.dot(d, d), this.square(r.radius))]; break; }
      case 'Point-on Arc': result = this.pointOnArc(this.point(f[0]), this.round(f[1])); break;
      case 'Point-on Fillet': result = this.pointOnArc(this.point(f[0]), compileFillet(this, f[1])); break;
      case 'Distance': case 'Horizontal Distance': case 'Vertical Distance': {
        const a = this.point(c.anchors?.start || f[0]), b = this.point(c.anchors?.end || f[1]), d = this.subv(b, a), t = target();
        if (c.type === 'Distance') result = [this.difference(this.dot(d, d), this.square(t)), ...this.branch(d, t)];
        else { const delta = d[c.type === 'Horizontal Distance' ? 0 : 1]; result = [this.sub(delta, this.mul(this.or(this.field('orientation'), this.or(this.sign(delta), 1)), t))]; } break;
      }
      case 'Point Line Distance': {
        const p = this.point(f[0]), s = this.segment(f[1]), d = this.subv(s.end, s.start), size = this.dot(d, d);
        const raw = this.div(this.dot(this.subv(p, s.start), d), size);
        const ratio = c.projectionMode === 'line' ? raw : this.max(0, this.min(1, raw));
        const projection = this.choose(this.lt(size, 1e-12), s.start, this.addv(s.start, this.scale(d, ratio)));
        const offset = this.subv(p, projection), t = target();
        this.guard(this.all(this.gt(size, 1e-18), c.projectionMode === 'line' ? 1 : this.all(this.gt(this.abs(raw), 1e-9), this.gt(this.abs(this.sub(raw, 1)), 1e-9))));
        if (['horizontal', 'vertical'].includes(c.subtype)) { const delta = offset[c.subtype === 'horizontal' ? 0 : 1]; result = [this.sub(delta, this.mul(this.or(this.field('orientation'), this.or(this.sign(delta), 1)), t))]; }
        else result = [this.difference(this.dot(offset, offset), this.square(t)), ...this.branch(offset, t)]; break;
      }
      case 'Line Line Distance': {
        const [a, b] = pair(), av = this.subv(a.end, a.start), bv = this.subv(b.end, b.start);
        const distance = this.normalized(this.cross(av, this.subv(this.midpoint(b.start, b.end), a.start)), this.length(av));
        result = [this.normalized(this.cross(av, bv), this.mul(this.length(av), this.length(bv))),
          this.sub(distance, this.mul(this.or(this.sign(this.field('orientation')), this.or(this.sign(distance), 1)), target()))]; break;
      }
      case 'Angle': {
        const [a, b] = vectors(), av = this.scale(a, this.or(this.field('firstRaySign'), 1)), bv = this.scale(b, this.or(this.field('secondRaySign'), 1));
        const delta = this.sub(this.atan2(this.cross(av, bv), this.dot(av, bv)), this.mul(this.mul(this.or(this.field('angleOrientation'), 1), target()), Math.PI / 180));
        result = [this.atan2(this.sin(delta), this.cos(delta))]; break;
      }
      case 'Meta': result = [this.sub(this.variableId(c.parameterRef), target())]; break;
      case 'Fixed': {
        if (c.fixedFrame && c.solveDomain === 'stack-frame') {
          const variables = this.model.placementVariables?.get(c.movingStackId);
          const delta = ['x', 'y', 'rotation'].map((key, i) => this.sub(
            variables ? this.variableId(variables[i].id) : this.dynamic(model => model.stackFrame(c.movingStackId)[key]),
            this.dynamic(model => model.constraints.get(c.id).fixedFrame[key]),
          ));
          result = [delta[0], delta[1], this.atan2(this.sin(delta[2]), this.cos(delta[2]))];
        } else {
          const ref = f.find(ref => ref.kind === 'point' || ref.type === 'point');
          result = !ref || !c.fixedPoint ? [] : this.subv(this.point(ref), [0, 1].map(i => this.dynamic(model => model.constraints.get(c.id).fixedPoint[i])));
        }
        break;
      }
      case 'Tangent': result = this.tangent(); break;
      default: throw new Error(`Native constraint ${c.type} is not supported.`);
    }
    return result.map(value => this.number(value).index);
  }
  tangent() {
    const c = this.constraint, f = c.featureRefs, lineRef = f.find(r => r.kind === 'segment'), rounds = f.filter(r => ['circle', 'arc'].includes(r.kind));
    if (lineRef && rounds.length === 1) {
      const line = this.segment(lineRef), round = this.round(rounds[0]), d = this.subv(line.end, line.start);
      const length = this.length(d), tangentPoint = c.tangentPoint ? this.point(c.tangentPoint) : null;
      const area = this.cross(d, this.subv(round.center, line.start)), squaredDistance = this.div(this.square(area), this.max(1e-12, this.dot(d, d)));
      const residual = rounds[0].kind === 'arc' && tangentPoint
        ? this.normalized(this.dot(d, this.subv(round.center, tangentPoint)), this.mul(length, round.radius))
        : this.difference(squaredDistance, this.square(round.radius));
      if (!Math.sign(Number(c.tangentOrientation))) return [residual];
      const branch = this.mul(this.sign(this.field('tangentOrientation')), this.div(this.cross(d, this.subv(round.center, tangentPoint || line.start)), this.max(1e-12, this.mul(length, this.abs(round.radius)))));
      this.guard(this.gt(this.abs(branch), 1e-9)); return [residual, this.min(0, branch)];
    }
    if (!lineRef && rounds.length === 2) {
      const [a, b] = rounds.map(ref => this.round(ref));
      if (c.tangentPoint && rounds.every(ref => ref.kind === 'arc')) {
        const joint = this.point(c.tangentPoint), av = this.subv(a.center, joint), bv = this.subv(b.center, joint);
        const al = this.length(av), bl = this.length(bv), scale = this.max(1e-12, this.mul(al, bl));
        const other = c.tangentPoint.recordId === rounds[0].recordId ? [bl, b.radius] : [al, a.radius];
        const alignment = this.div(this.mul(c.tangentMode === 'internal' ? 1 : -1, this.dot(av, bv)), scale);
        this.guard(this.gt(this.abs(alignment), 1e-9));
        return [this.div(this.cross(av, bv), scale), this.difference(...other), this.min(0, alignment)];
      }
      const d = this.subv(a.center, b.center), radius = c.tangentMode === 'internal' ? this.abs(this.sub(a.radius, b.radius)) : this.add(a.radius, b.radius);
      if (c.tangentMode === 'internal') this.guard(this.gt(radius, 1e-9));
      return [this.difference(this.dot(d, d), this.square(radius))];
    }
    throw new Error('Invalid native tangency features.');
  }
}
