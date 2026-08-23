import { rememberRepeatableTool } from './CanvasUIControls.js';
import { resolvedBoundaryForHost } from './BoundaryTopology.js';

// --- Notch Features & Constants ---
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const subtract = (a, b) => [a[0] - b[0], a[1] - b[1]];
const scale = (point, value) => [point[0] * value, point[1] * value];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const length = (point) => Math.hypot(point[0], point[1]);
const unit = (point, fallback = [1, 0]) => {
  const size = length(point);
  return size > 1e-9 ? scale(point, 1 / size) : fallback;
};

export const notchLength = 6.35;
export const DEFAULT_NOTCH_TYPE = 'v-notch';
export const LEGACY_NOTCH_TYPE = 'straight-slit';
export const NOTCH_TYPE_OPTIONS = Object.freeze([
  { value: 'v-notch', label: 'V-Notch', dxfLayer: 'V-Notch' },
  { value: 'u-notch', label: 'U-Notch', dxfLayer: 'U-Notch' },
  { value: 'straight-slit', label: 'Straight Slit', dxfLayer: 'Straight Slit Notch' },
]);
export const vNotchHalfWidth = 3.175;
export const uNotchHalfWidth = 1.5875;
export const isNotchEntity = (entity) => entity?.type === 'notch' && entity.host?.recordId;

const notchTypeValues = new Set(NOTCH_TYPE_OPTIONS.map(({ value }) => value));

export function normalizeNotchType(value, fallback = LEGACY_NOTCH_TYPE) {
  const normalized = String(value || '').trim().toLowerCase();
  if (notchTypeValues.has(normalized)) return normalized;
  const aliases = {
    v: 'v-notch',
    u: 'u-notch',
    slit: 'straight-slit',
    straight: 'straight-slit',
    'straight-slit-notch': 'straight-slit',
  };
  return aliases[normalized] || (notchTypeValues.has(fallback) ? fallback : LEGACY_NOTCH_TYPE);
}

export function notchTypeForEntity(entity) {
  return normalizeNotchType(entity?.notchType, LEGACY_NOTCH_TYPE);
}

export function notchFillColor(entity) {
  return notchTypeForEntity(entity) === 'straight-slit' ? 'none' : '#000000';
}

export function notchDxfLayer(entityOrType) {
  const type = typeof entityOrType === 'string'
    ? normalizeNotchType(entityOrType)
    : notchTypeForEntity(entityOrType);
  return NOTCH_TYPE_OPTIONS.find(({ value }) => value === type)?.dxfLayer || 'Straight Slit Notch';
}

function samePoint(a, b, tolerance = 1e-9) {
  return Math.hypot(Number(a?.[0]) - Number(b?.[0]), Number(a?.[1]) - Number(b?.[1])) <= tolerance;
}

function notchFrame(entity) {
  if (!Array.isArray(entity?.point) || !Array.isArray(entity?.end)) return null;
  const point = [Number(entity.point[0]), Number(entity.point[1])];
  const end = [Number(entity.end[0]), Number(entity.end[1])];
  if (![...point, ...end].every(Number.isFinite)) return null;
  const inwardVector = subtract(end, point);
  const depth = length(inwardVector);
  if (depth <= 1e-9) return null;
  const inward = scale(inwardVector, 1 / depth);
  return { point, end, depth, inward, tangent: [-inward[1], inward[0]] };
}

export function notchGeometryPrimitives(entity) {
  const frame = notchFrame(entity);
  if (!frame) return [];
  const { point, end, depth, inward, tangent } = frame;
  const type = notchTypeForEntity(entity);
  if (type === 'straight-slit') return [{ type: 'line', start: point, end }];
  if (type === 'v-notch') {
    const first = add(point, scale(tangent, -vNotchHalfWidth));
    const second = add(point, scale(tangent, vNotchHalfWidth));
    return [
      { type: 'line', start: first, end },
      { type: 'line', start: end, end: second },
    ];
  }
  const radius = Math.min(uNotchHalfWidth, depth);
  const sideLength = Math.max(0, depth - radius);
  const first = add(point, scale(tangent, -uNotchHalfWidth));
  const second = add(point, scale(tangent, uNotchHalfWidth));
  const center = add(point, scale(inward, sideLength));
  const arcStart = add(center, scale(tangent, -radius));
  const arcEnd = add(center, scale(tangent, radius));
  const arcPoint = add(center, scale(inward, radius));
  return [
    { type: 'line', start: first, end: arcStart },
    { type: 'arc', start: arcStart, arcPoint, end: arcEnd, center, radius },
    { type: 'line', start: arcEnd, end: second },
  ];
}

function normalizedPositiveAngle(angle) {
  const tau = Math.PI * 2;
  return ((angle % tau) + tau) % tau;
}

function arcDirection(primitive) {
  const angle = (point) => Math.atan2(point[1] - primitive.center[1], point[0] - primitive.center[0]);
  const start = angle(primitive.start);
  const middle = angle(primitive.arcPoint);
  const end = angle(primitive.end);
  const positiveSweep = normalizedPositiveAngle(end - start);
  const positiveMiddle = normalizedPositiveAngle(middle - start);
  return {
    start,
    sweep: positiveMiddle <= positiveSweep + 1e-9
      ? positiveSweep
      : -(Math.PI * 2 - positiveSweep),
  };
}

export function notchGeometryPoints(entity, arcSamples = 16) {
  return notchGeometryPrimitives(entity).flatMap((primitive, index) => {
    if (primitive.type === 'line') return index ? [primitive.end] : [primitive.start, primitive.end];
    const { start, sweep } = arcDirection(primitive);
    const count = Math.max(4, Number(arcSamples) || 16);
    return Array.from({ length: count + 1 }, (_, sample) => {
      const angle = start + sweep * sample / count;
      return add(primitive.center, scale([Math.cos(angle), Math.sin(angle)], primitive.radius));
    });
  });
}

export function notchSvgPath(entity) {
  const primitives = notchGeometryPrimitives(entity);
  let current = null;
  const commands = [];
  primitives.forEach((primitive) => {
    if (!current || !samePoint(current, primitive.start)) {
      commands.push(`M ${primitive.start[0]} ${primitive.start[1]}`);
    }
    if (primitive.type === 'line') {
      commands.push(`L ${primitive.end[0]} ${primitive.end[1]}`);
    } else {
      const { sweep } = arcDirection(primitive);
      commands.push(`A ${primitive.radius} ${primitive.radius} 0 ${Math.abs(sweep) > Math.PI + 1e-9 ? 1 : 0} ${sweep >= 0 ? 1 : 0} ${primitive.end[0]} ${primitive.end[1]}`);
    }
    current = primitive.end;
  });
  return commands.join(' ');
}

function segmentProjection(point, start, end) {
  const vector = subtract(end, start);
  const sizeSquared = dot(vector, vector);
  const t = sizeSquared ? Math.max(0, Math.min(1, dot(subtract(point, start), vector) / sizeSquared)) : 0;
  return { t, point: add(start, scale(vector, t)), tangent: unit(vector) };
}

const segmentAnchorParameters = {
  start: 0,
  midpoint: 0.5,
  end: 1,
};

export function createSegmentLocationMemory(feature, parameter) {
  return createNotchLocationMemory(feature, parameter);
}

export function createNotchLocationMemory(feature, parameter) {
  const metrics = notchFeatureMetrics(feature);
  if (!metrics || metrics.length <= 1e-9) return null;
  if (feature.kind === 'circle') return createCircleQuadrantLocationMemory(feature, parameter, metrics);
  const t = metrics.parameterToProgress(parameter);
  const anchor = Object.entries(segmentAnchorParameters).reduce((nearest, entry) => (
    Math.abs(t - entry[1]) < Math.abs(t - nearest[1]) ? entry : nearest
  ), ['start', 0]);
  const availableLength = anchor[0] === 'midpoint' ? metrics.length / 2 : metrics.length;
  const signedDistance = (t - anchor[1]) * metrics.length;
  return {
    anchor: anchor[0],
    signedDistance,
    signedRatio: availableLength > 1e-9 ? signedDistance / availableLength : 0,
  };
}

export function segmentParameterFromLocationMemory(memory, feature, forceProportional = false) {
  return notchParameterFromLocationMemory(memory, feature, forceProportional);
}

export function notchParameterFromLocationMemory(memory, feature, forceProportional = false) {
  const metrics = notchFeatureMetrics(feature);
  if (!memory || !metrics || metrics.length <= 1e-9) return null;
  if (feature.kind === 'circle') {
    if (!isCircleQuadrantLocationMemory(memory)) return null;
    const anchorAngle = Number(memory.quadrant) * circleQuadrantAngle;
    const angularOffset = forceProportional
      ? Number(memory.signedRatio || 0) * Math.PI * 2
      : Number(memory.signedDistance || 0) / feature.radius;
    return normalizeAngle(anchorAngle + angularOffset);
  }
  const anchorParameter = segmentAnchorParameters[memory.anchor];
  if (!Number.isFinite(anchorParameter)) return null;
  const absoluteProgress = anchorParameter + Number(memory.signedDistance || 0) / metrics.length;
  if (!forceProportional && absoluteProgress >= 0 && absoluteProgress <= 1) {
    return metrics.progressToParameter(absoluteProgress);
  }
  const parameterSpan = memory.anchor === 'midpoint' ? 0.5 : 1;
  const proportionalProgress = Math.max(
    0,
    Math.min(1, anchorParameter + Number(memory.signedRatio || 0) * parameterSpan),
  );
  return metrics.progressToParameter(proportionalProgress);
}

function circleProjection(point, center, radius) {
  const radial = unit(subtract(point, center));
  return {
    angle: Math.atan2(radial[1], radial[0]),
    point: add(center, scale(radial, radius)),
    tangent: [-radial[1], radial[0]],
    inward: scale(radial, -1),
  };
}

const normalizeAngle = (angle) => {
  const tau = Math.PI * 2;
  return ((angle % tau) + tau) % tau;
};

const circleQuadrantAngle = Math.PI / 2;

function signedAngleDifference(angle, reference) {
  const normalized = normalizeAngle(angle - reference);
  return normalized > Math.PI ? normalized - Math.PI * 2 : normalized;
}

function createCircleQuadrantLocationMemory(feature, parameter, metrics) {
  const angle = normalizeAngle(Number(parameter) || 0);
  let nearest = { quadrant: 0, offset: signedAngleDifference(angle, 0) };
  for (let quadrant = 1; quadrant < 4; quadrant += 1) {
    const offset = signedAngleDifference(angle, quadrant * circleQuadrantAngle);
    if (Math.abs(offset) < Math.abs(nearest.offset)) nearest = { quadrant, offset };
  }
  const signedDistance = nearest.offset * feature.radius;
  return {
    anchor: 'quadrant',
    quadrant: nearest.quadrant,
    signedDistance,
    signedRatio: metrics.length > 1e-9 ? signedDistance / metrics.length : 0,
  };
}

export function isCircleQuadrantLocationMemory(memory) {
  const quadrant = Number(memory?.quadrant);
  return memory?.anchor === 'quadrant'
    && Number.isInteger(quadrant)
    && quadrant >= 0
    && quadrant < 4;
}

function arcSweep(feature) {
  const start = Math.atan2(feature.start[1] - feature.center[1], feature.start[0] - feature.center[0]);
  const middle = Math.atan2(feature.arcPoint[1] - feature.center[1], feature.arcPoint[0] - feature.center[0]);
  const end = Math.atan2(feature.end[1] - feature.center[1], feature.end[0] - feature.center[0]);
  const ccw = normalizeAngle(end - start);
  const middleCcw = normalizeAngle(middle - start);
  return { start, sweep: middleCcw <= ccw ? ccw : ccw - Math.PI * 2 };
}

export function notchFeatureParameterDomain(feature, referenceParameter = 0) {
  if (feature.kind === 'segment') return [0, 1];
  if (feature.kind === 'curve' || feature.kind === 'polyline') {
    return [0, Math.max(0, feature.points.length - 1)];
  }
  if (feature.kind === 'arc') {
    const { start, sweep } = arcSweep(feature);
    return [Math.min(start, start + sweep), Math.max(start, start + sweep)];
  }
  return [referenceParameter - Math.PI, referenceParameter + Math.PI];
}

function cubicSegment(points, index, t) {
  const current = points[index];
  const next = points[index + 1];
  const previous = points[Math.max(0, index - 1)];
  const after = points[Math.min(points.length - 1, index + 2)];
  const c1 = add(current, scale(subtract(next, previous), 0.18));
  const c2 = add(next, scale(subtract(current, after), 0.18));
  const u = 1 - t;
  const point = add(
    add(scale(current, u ** 3), scale(c1, 3 * u * u * t)),
    add(scale(c2, 3 * u * t * t), scale(next, t ** 3)),
  );
  const tangent = add(
    add(scale(subtract(c1, current), 3 * u * u), scale(subtract(c2, c1), 6 * u * t)),
    scale(subtract(next, c2), 3 * t * t),
  );
  return { point, tangent: unit(tangent, unit(subtract(next, current))) };
}

function sampledCurveMetrics(feature, samplesPerSegment = 80) {
  const samples = [{ parameter: 0, distance: 0 }];
  let previous = feature.points[0];
  let total = 0;
  for (let index = 0; index < feature.points.length - 1; index += 1) {
    for (let sample = 1; sample <= samplesPerSegment; sample += 1) {
      const parameter = index + sample / samplesPerSegment;
      const point = cubicSegment(feature.points, index, sample / samplesPerSegment).point;
      total += length(subtract(point, previous));
      samples.push({ parameter, distance: total });
      previous = point;
    }
  }
  const interpolate = (target, inputKey, outputKey) => {
    const clamped = Math.max(0, Math.min(total, target));
    for (let index = 1; index < samples.length; index += 1) {
      if (samples[index][inputKey] < clamped) continue;
      const previousSample = samples[index - 1];
      const nextSample = samples[index];
      const span = nextSample[inputKey] - previousSample[inputKey] || 1;
      const ratio = (clamped - previousSample[inputKey]) / span;
      return previousSample[outputKey] + (nextSample[outputKey] - previousSample[outputKey]) * ratio;
    }
    return samples.at(-1)?.[outputKey] || 0;
  };
  return {
    length: total,
    parameterToProgress(parameter) {
      if (!total) return 0;
      const maxParameter = Math.max(0, feature.points.length - 1);
      const target = Math.max(0, Math.min(maxParameter, Number(parameter) || 0));
      const sampleIndex = Math.min(samples.length - 1, Math.max(0, Math.round(target * samplesPerSegment)));
      return samples[sampleIndex].distance / total;
    },
    progressToParameter(progress) {
      return interpolate(Math.max(0, Math.min(1, progress)) * total, 'distance', 'parameter');
    },
  };
}

function polylineMetrics(feature) {
  const distances = [0];
  let total = 0;
  for (let index = 1; index < feature.points.length; index += 1) {
    total += length(subtract(feature.points[index], feature.points[index - 1]));
    distances.push(total);
  }
  return {
    length: total,
    parameterToProgress(parameter) {
      if (!total) return 0;
      const clamped = Math.max(0, Math.min(feature.points.length - 1, Number(parameter) || 0));
      const index = Math.min(feature.points.length - 2, Math.floor(clamped));
      const ratio = clamped - index;
      const distance = distances[index] + (distances[index + 1] - distances[index]) * ratio;
      return distance / total;
    },
    progressToParameter(progress) {
      const target = Math.max(0, Math.min(1, progress)) * total;
      for (let index = 1; index < distances.length; index += 1) {
        if (distances[index] < target) continue;
        const span = distances[index] - distances[index - 1] || 1;
        return index - 1 + (target - distances[index - 1]) / span;
      }
      return Math.max(0, feature.points.length - 1);
    },
  };
}

function notchFeatureMetrics(feature) {
  if (feature?.kind === 'segment') {
    const total = length(subtract(feature.end, feature.start));
    return {
      length: total,
      parameterToProgress: (parameter) => Math.max(0, Math.min(1, Number(parameter) || 0)),
      progressToParameter: (progress) => Math.max(0, Math.min(1, progress)),
    };
  }
  if (feature?.kind === 'curve' && feature.points?.length > 1) return sampledCurveMetrics(feature);
  if (feature?.kind === 'polyline' && feature.points?.length > 1) return polylineMetrics(feature);
  if (feature?.kind === 'arc') {
    const { start, sweep } = arcSweep(feature);
    const total = Math.abs(sweep) * feature.radius;
    return {
      length: total,
      parameterToProgress(parameter) {
        return sweep
          ? Math.max(0, Math.min(1, ((Number(parameter) || start) - start) / sweep))
          : 0;
      },
      progressToParameter: (progress) => start + sweep * Math.max(0, Math.min(1, progress)),
    };
  }
  if (feature?.kind === 'circle') {
    const total = Math.PI * 2 * feature.radius;
    return {
      length: total,
      parameterToProgress: (parameter) => normalizeAngle(Number(parameter) || 0) / (Math.PI * 2),
      progressToParameter: (progress) => Math.max(0, Math.min(1, progress)) * Math.PI * 2,
    };
  }
  return null;
}

export function notchFeatureLength(feature) {
  return notchFeatureMetrics(feature)?.length || 0;
}

function curveProjection(world, points) {
  let best = null;
  for (let index = 0; index < points.length - 1; index += 1) {
    for (let sample = 0; sample <= 40; sample += 1) {
      const t = sample / 40;
      const evaluated = cubicSegment(points, index, t);
      const distance = length(subtract(world, evaluated.point));
      if (!best || distance < best.distance) best = { ...evaluated, parameter: index + t, distance };
    }
  }
  return best;
}

function polylineProjection(world, points) {
  return points.slice(1).reduce((best, point, index) => {
    const projected = segmentProjection(world, points[index], point);
    const distance = length(subtract(world, projected.point));
    return !best || distance < best.distance
      ? { ...projected, parameter: index + projected.t, distance }
      : best;
  }, null);
}

export function sampleNotchFeature(feature, samplesPerCurveSegment = 24) {
  if (feature.kind === 'segment') return [[...feature.start], [...feature.end]];
  if (feature.kind === 'polyline') return feature.points.map((point) => [...point]);
  if (feature.kind === 'circle') {
    const count = 48;
    return Array.from({ length: count }, (_, index) => {
      const angle = Math.PI * 2 * index / count;
      return add(feature.center, scale([Math.cos(angle), Math.sin(angle)], feature.radius));
    });
  }
  if (feature.kind === 'curve') {
    const sampled = [];
    for (let index = 0; index < feature.points.length - 1; index += 1) {
      for (let sample = index ? 1 : 0; sample <= samplesPerCurveSegment; sample += 1) {
        sampled.push(cubicSegment(feature.points, index, sample / samplesPerCurveSegment).point);
      }
    }
    return sampled;
  }
  if (feature.kind === 'arc') {
    const { start, sweep } = arcSweep(feature);
    const count = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI / 24)));
    return Array.from({ length: count + 1 }, (_, index) => {
      const angle = start + sweep * index / count;
      return add(feature.center, scale([Math.cos(angle), Math.sin(angle)], feature.radius));
    });
  }
  return [];
}

function inwardTargetPoint(inwardTarget, projection) {
  return typeof inwardTarget === 'function'
    ? inwardTarget(projection.point, projection.tangent)
    : inwardTarget;
}

function normalTowardTarget(projection, inwardTarget) {
  const leftNormal = [-projection.tangent[1], projection.tangent[0]];
  const target = inwardTargetPoint(inwardTarget, projection);
  return dot(leftNormal, subtract(target || projection.point, projection.point)) >= 0
    ? leftNormal
    : scale(leftNormal, -1);
}

export function projectPointToNotchFeature(world, feature) {
  if (feature.kind === 'segment') {
    const projected = segmentProjection(world, feature.start, feature.end);
    return { ...projected, parameter: projected.t, distance: length(subtract(world, projected.point)) };
  }
  if (feature.kind === 'curve') return curveProjection(world, feature.points);
  if (feature.kind === 'polyline') return polylineProjection(world, feature.points);
  if (feature.kind === 'arc') {
    const { start, sweep } = arcSweep(feature);
    const angle = Math.atan2(world[1] - feature.center[1], world[0] - feature.center[0]);
    const progress = sweep >= 0
      ? Math.max(0, Math.min(sweep, normalizeAngle(angle - start)))
      : Math.min(0, Math.max(sweep, -normalizeAngle(start - angle)));
    const parameter = start + progress;
    const point = add(feature.center, scale([Math.cos(parameter), Math.sin(parameter)], feature.radius));
    return { parameter, point, distance: length(subtract(world, point)) };
  }
  if (feature.kind === 'circle') {
    const projected = circleProjection(world, feature.center, feature.radius);
    return { ...projected, parameter: projected.angle, distance: length(subtract(world, projected.point)) };
  }
  return null;
}

export function createNotchEntity(
  feature,
  pickedPoint,
  inwardTarget,
  id = `notch-${crypto.randomUUID()}`,
  notchType = DEFAULT_NOTCH_TYPE,
) {
  if (feature.kind === 'segment' || feature.kind === 'curve' || feature.kind === 'polyline') {
    const projection = projectPointToNotchFeature(pickedPoint, feature);
    const host = hostMetadataForFeature(feature, projection.parameter);
    const inward = normalTowardTarget(projection, inwardTarget);
    return {
      id,
      type: 'notch',
      notchType: normalizeNotchType(notchType, DEFAULT_NOTCH_TYPE),
      host,
      parameter: projection.parameter,
      locationMemory: createNotchLocationMemory(feature, projection.parameter),
      point: projection.point,
      end: add(projection.point, scale(inward, notchLength)),
      length: notchLength,
      implicitConstraints: ['Point-on', 'Perpendicular'],
    };
  }
  if (feature.kind === 'arc') {
    const projection = projectPointToNotchFeature(pickedPoint, feature);
    const host = hostMetadataForFeature(feature, projection.parameter);
    const radial = unit(subtract(projection.point, feature.center));
    projection.tangent = [-radial[1], radial[0]];
    const inward = normalTowardTarget(projection, inwardTarget);
    return {
      id,
      type: 'notch',
      notchType: normalizeNotchType(notchType, DEFAULT_NOTCH_TYPE),
      host,
      parameter: projection.parameter,
      locationMemory: createNotchLocationMemory(feature, projection.parameter),
      point: projection.point,
      end: add(projection.point, scale(inward, notchLength)),
      length: notchLength,
      implicitConstraints: ['Point-on', 'Perpendicular'],
    };
  }
  const projection = circleProjection(pickedPoint, feature.center, feature.radius);
  const host = hostMetadataForFeature(feature, projection.angle);
  const inward = normalTowardTarget(projection, inwardTarget);
  return {
    id,
    type: 'notch',
    notchType: normalizeNotchType(notchType, DEFAULT_NOTCH_TYPE),
    host,
    parameter: projection.angle,
    locationMemory: createNotchLocationMemory(feature, projection.angle),
    point: projection.point,
    end: add(projection.point, scale(inward, notchLength)),
    length: notchLength,
    implicitConstraints: ['Point-on', 'Perpendicular'],
  };
}

function hostMetadataForFeature(feature, parameter) {
  const host = { recordId: feature.recordId, kind: feature.kind, index: feature.index ?? 0 };
  if (feature.sourceId) host.sourceId = feature.sourceId;
  if (feature.targetId) host.targetId = feature.targetId;
  if (feature.sourceFeatureIndex !== undefined) host.sourceFeatureIndex = feature.sourceFeatureIndex;
  if (feature.boundaryRole) host.boundaryRole = feature.boundaryRole;
  if (feature.stableKey) host.stableKey = feature.stableKey;
  if (
    Number.isFinite(Number(feature.parameterStart))
    && Number.isFinite(Number(feature.parameterEnd))
    && Number.isFinite(Number(parameter))
  ) {
    const sourceParameter = feature.kind === 'arc'
      ? (((Number(parameter) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)
      : Number(feature.parameterStart)
        + (Number(feature.parameterEnd) - Number(feature.parameterStart)) * Number(parameter);
    host.sourceParameter = sourceParameter;
  }
  return host;
}

function rememberedSegmentParameter(notch, feature) {
  const rememberedParameter = segmentParameterFromLocationMemory(
    notch.locationMemory,
    feature,
    notch.locationMemory?.forceProportional,
  );
  if (rememberedParameter !== null) return rememberedParameter;

  const sourceParameter = Number(notch.host?.sourceParameter);
  const parameterStart = Number(feature.parameterStart);
  const parameterEnd = Number(feature.parameterEnd);
  if (
    Number.isFinite(sourceParameter)
    && Number.isFinite(parameterStart)
    && Number.isFinite(parameterEnd)
    && Math.abs(parameterEnd - parameterStart) > 1e-9
  ) {
    return Math.max(0, Math.min(1, (sourceParameter - parameterStart) / (parameterEnd - parameterStart)));
  }
  return null;
}

export function evaluateNotch(notch, feature, inwardTarget) {
  if (!isNotchEntity(notch) || !feature) return { valid: false, error: 'Notch host is missing.' };
  if (feature.kind === 'segment') {
    const rememberedParameter = rememberedSegmentParameter(notch, feature);
    const parameter = rememberedParameter ?? (Number(notch.parameter) || 0);
    const projection = segmentProjection(
      add(feature.start, scale(subtract(feature.end, feature.start), parameter)),
      feature.start,
      feature.end,
    );
    const inward = normalTowardTarget(projection, inwardTarget);
    return {
      valid: true,
      parameter: projection.t,
      point: projection.point,
      end: add(projection.point, scale(inward, notchLength)),
    };
  }
  if (feature.kind === 'curve') {
    const maxParameter = Math.max(0, feature.points.length - 1);
    const rememberedParameter = notchParameterFromLocationMemory(
      notch.locationMemory,
      feature,
      notch.locationMemory?.forceProportional,
    );
    const parameter = Math.max(0, Math.min(maxParameter, rememberedParameter ?? (Number(notch.parameter) || 0)));
    const index = Math.min(feature.points.length - 2, Math.floor(parameter));
    const projection = cubicSegment(feature.points, Math.max(0, index), parameter - Math.max(0, index));
    const inward = normalTowardTarget(projection, inwardTarget);
    return {
      valid: true,
      parameter,
      point: projection.point,
      end: add(projection.point, scale(inward, notchLength)),
    };
  }
  if (feature.kind === 'polyline') {
    const maxParameter = Math.max(0, feature.points.length - 1);
    const rememberedParameter = notchParameterFromLocationMemory(
      notch.locationMemory,
      feature,
      notch.locationMemory?.forceProportional,
    );
    const parameter = Math.max(0, Math.min(maxParameter, rememberedParameter ?? (Number(notch.parameter) || 0)));
    const index = Math.min(feature.points.length - 2, Math.floor(parameter));
    const projection = segmentProjection(
      feature.points[index],
      feature.points[index],
      feature.points[index + 1],
    );
    const ratio = parameter - index;
    projection.t = ratio;
    projection.point = add(feature.points[index], scale(
      subtract(feature.points[index + 1], feature.points[index]),
      ratio,
    ));
    const inward = normalTowardTarget(projection, inwardTarget);
    return {
      valid: true,
      parameter,
      point: projection.point,
      end: add(projection.point, scale(inward, notchLength)),
    };
  }
  if (feature.kind === 'circle' || feature.kind === 'arc') {
    const rememberedParameter = notchParameterFromLocationMemory(
      notch.locationMemory,
      feature,
      notch.locationMemory?.forceProportional,
    );
    const angle = rememberedParameter ?? (Number(notch.parameter) || 0);
    const radial = [Math.cos(angle), Math.sin(angle)];
    const point = add(feature.center, scale(radial, feature.radius));
    const tangent = [-radial[1], radial[0]];
    const inward = normalTowardTarget({ point, tangent }, inwardTarget);
    return { valid: true, parameter: angle, point, end: add(point, scale(inward, notchLength)) };
  }
  return { valid: false, error: 'Unsupported notch host.' };
}

export function moveNotchToPoint(notch, feature, world) {
  const projection = projectPointToNotchFeature(world, feature);
  if (projection) {
    notch.parameter = projection.parameter;
    notch.locationMemory = createNotchLocationMemory(feature, projection.parameter);
  }
  return notch;
}

// --- Notch Boundary Resolver ---
export function pointInsideNotchBoundary(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index];
    const b = polygon[previous];
    const crosses = (a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / ((b[1] - a[1]) || 1e-12) + a[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

export function inwardTargetFromBoundary(boundaryPoint, tangent, polygon, length = notchLength) {
  if (!boundaryPoint || !tangent || polygon.length < 3) return null;
  const tangentLength = Math.hypot(tangent[0], tangent[1]) || 1;
  const left = [-tangent[1] / tangentLength, tangent[0] / tangentLength];
  const candidate = (normal, distance) => [
    boundaryPoint[0] + normal[0] * distance,
    boundaryPoint[1] + normal[1] * distance,
  ];
  for (const distance of [length, length * 0.5, length * 0.1]) {
    const leftTarget = candidate(left, distance);
    const rightTarget = candidate([-left[0], -left[1]], distance);
    const leftInside = pointInsideNotchBoundary(leftTarget, polygon);
    const rightInside = pointInsideNotchBoundary(rightTarget, polygon);
    if (leftInside !== rightInside) return leftInside ? leftTarget : rightTarget;
  }
  return null;
}

export function createNotchBoundaryResolver({
  records,
  recordSegments,
  renderedEntityForRecord,
  evaluateFilletedGeometry,
  getClosedCycles,
  getEntityFeature,
  getSegmentFeature,
  arcCircle,
  screenToWorld,
  getSubtractBoundaryFeatures = () => [],
  getSubtractBoundaryFeaturesForHost = null,
  getSubtractBoundaryFeature = () => null,
  getSubtractBoundaryFeatureFromWorld = () => null,
  getSubtractBoundaryInwardTarget = () => null,
  getResolvedBoundaries = null,
}) {
  function featuresForEntity(entity) {
    if (!entity) return [];
    if (['line', 'rect', 'polygon', 'polyline'].includes(entity.type)) {
      return recordSegments(entity).map((segment) => ({
        kind: 'segment',
        recordId: entity.id,
        entityType: entity.type,
        index: segment.index,
        start: [...segment.start],
        end: [...segment.end],
      }));
    }
    if (entity.type === 'curve') {
      return [{
        kind: 'curve',
        recordId: entity.id,
        entityType: entity.type,
        index: 0,
        points: entity.points.map((point) => [...point]),
      }];
    }
    if (entity.type === 'circle') {
      return [{ kind: 'circle', recordId: entity.id, entityType: entity.type, center: [...entity.center], radius: entity.radius }];
    }
    if (entity.type === 'arc') {
      const circle = arcCircle(entity);
      return circle ? [{
        kind: 'arc',
        recordId: entity.id,
        entityType: entity.type,
        center: [...circle.center],
        radius: circle.radius,
        start: [...entity.start],
        arcPoint: [...entity.arcPoint],
        end: [...entity.end],
      }] : [];
    }
    return [];
  }

  function sourceFeatureForHost(host) {
    if (!host) return null;
    if (host.kind === 'segment') return getSegmentFeature(host.recordId, host.index, { rendered: true });
    if (host.kind === 'curve') {
      const record = records.find((candidate) => candidate.id === host.recordId && candidate.recordType === 'geometry');
      const entity = record && renderedEntityForRecord(record);
      return entity?.type === 'curve' ? featuresForEntity(entity)[0] : null;
    }
    return getEntityFeature(host.recordId, { rendered: true });
  }

  function currentResolvedBoundary(host) {
    if (typeof getResolvedBoundaries !== 'function') return null;
    return resolvedBoundaryForHost(getResolvedBoundaries(), host);
  }

  function resolvedFeatureForHost(host, context = null) {
    const boundary = currentResolvedBoundary(host);
    if (!boundary) return null;
    if (host.stableKey) {
      const exact = boundary.features.find((feature) => feature.stableKey === host.stableKey);
      if (exact) return exact;
    }
    const candidates = boundary.features.filter((feature) => (
      (!host.sourceId || feature.sourceId === host.sourceId)
      && (feature.recordId === host.recordId || feature.sourceId === host.recordId || host.targetId === boundary.id)
      && (!host.kind || feature.kind === host.kind)
      && (host.sourceFeatureIndex === undefined || feature.sourceFeatureIndex === host.sourceFeatureIndex)
      && (host.index === undefined || Number(feature.index || 0) === Number(host.index || 0))
    ));
    const available = candidates.length ? candidates : boundary.features;
    const referencePoint = host.referencePoint || context?.point || context?.pickedPoint;
    if (referencePoint) return nearestFeature(available, referencePoint);
    return available[0] || null;
  }

  function featureForHost(host, context = null) {
    if (!host) return null;
    const subtractFeature = getSubtractBoundaryFeature(host, context);
    if (subtractFeature) return subtractFeature;
    const resolvedFeature = resolvedFeatureForHost(host, context);
    if (resolvedFeature) return resolvedFeature;
    return sourceFeatureForHost(host);
  }

  function boundaryFeatures(host) {
    const subtractFeatures = getSubtractBoundaryFeaturesForHost?.(host)
      || getSubtractBoundaryFeatures(host?.recordId);
    if (subtractFeatures.length) return subtractFeatures;
    const boundary = currentResolvedBoundary(host);
    if (boundary) return boundary.features;
    const hostRecord = records.find((record) => record.id === host?.recordId);
    if (!hostRecord) return [];
    if (['circle', 'rect', 'polygon'].includes(hostRecord.entity.type)) {
      return featuresForEntity(hostRecord.entity);
    }
    const drawable = records
      .filter((record) => record.recordType === 'geometry' || record.recordType === 'fillet')
      .map((record) => record.entity);
    const evaluated = evaluateFilletedGeometry(drawable);
    const cycle = getClosedCycles().find((item) => item.some(({ entityId }) => entityId === host.recordId));
    if (!cycle) return [];
    const byId = new Map(evaluated.map((entity) => [entity.id, entity]));
    return cycle.flatMap(({ entityId }) => featuresForEntity(byId.get(entityId)));
  }

  function polygonForHost(host) {
    const boundary = currentResolvedBoundary(host);
    if (boundary?.polygon?.length >= 3) return boundary.polygon.map((point) => [...point]);
    const hostRecord = records.find((record) => record.id === host?.recordId);
    if (hostRecord?.entity.type === 'rect') {
      const { x, y, width, height } = hostRecord.entity;
      return [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
    }
    if (hostRecord?.entity.type === 'polygon') return hostRecord.entity.points.map((point) => [...point]);
    const cycle = getClosedCycles().find((item) => item.some(({ entityId }) => entityId === host?.recordId));
    if (!cycle) return [];
    const drawable = records
      .filter((record) => record.recordType === 'geometry' || record.recordType === 'fillet')
      .map((record) => record.entity);
    const byId = new Map(evaluateFilletedGeometry(drawable).map((entity) => [entity.id, entity]));
    return cycle.flatMap(({ entityId, reversed }, cycleIndex) => {
      const sampled = featuresForEntity(byId.get(entityId)).flatMap((feature) => sampleNotchFeature(feature));
      const oriented = reversed ? sampled.reverse() : sampled;
      return cycleIndex ? oriented.slice(1) : oriented;
    });
  }

  function inwardTarget(host, boundaryPoint = null, tangent = null, context = null) {
    const feature = featureForHost(host, context);
    const subtractTarget = getSubtractBoundaryInwardTarget(feature, boundaryPoint, tangent);
    if (subtractTarget) return subtractTarget;
    const polygon = polygonForHost(host);
    const localTarget = inwardTargetFromBoundary(boundaryPoint, tangent, polygon);
    if (localTarget) return localTarget;
    if (feature?.center) return feature.center;
    const hostRecord = records.find((record) => record.id === host?.recordId);
    if (hostRecord?.entity.type === 'rect') {
      return [hostRecord.entity.x + hostRecord.entity.width / 2, hostRecord.entity.y + hostRecord.entity.height / 2];
    }
    if (hostRecord?.entity.type === 'polygon') {
      const count = hostRecord.entity.points.length || 1;
      return hostRecord.entity.points.reduce(
        (sum, point) => [sum[0] + point[0] / count, sum[1] + point[1] / count],
        [0, 0],
      );
    }
    const cyclePoints = polygon.length ? polygon : [];
    const count = cyclePoints.length || 1;
    return cyclePoints.reduce(
      (sum, point) => [sum[0] + point[0] / count, sum[1] + point[1] / count],
      feature?.point || [0, 0],
    );
  }

  function isClosedHost(feature) {
    if (currentResolvedBoundary(feature)) return true;
    const record = records.find((candidate) => candidate.id === feature?.recordId);
    if (!record || record.entity.construction) return false;
    if (!['geometry', 'fillet'].includes(record.recordType)) return false;
    if (['circle', 'rect', 'polygon'].includes(record.entity.type)) return true;
    return getClosedCycles().some((cycle) => cycle.some(({ entityId }) => entityId === record.id));
  }

  function nearestFeature(features, world) {
    return features.reduce((best, feature) => {
      const projection = projectPointToNotchFeature(world, feature);
      return projection && (!best || projection.distance < best.distance)
        ? { ...feature, pickedPoint: [...projection.point], distance: projection.distance }
        : best;
    }, null);
  }

  function featureAtWorld(feature, world) {
    if (!feature) return null;
    const projection = projectPointToNotchFeature(world, feature);
    return projection ? { ...feature, pickedPoint: [...projection.point] } : feature;
  }

  function featureFromEvent(event) {
    const target = event.paramagicSelectionTarget || event.target;
    const recordElement = target.closest?.('.canvas-record, .canvas-handle-group');
    const record = records.find((candidate) => candidate.id === recordElement?.dataset.recordId);
    const world = screenToWorld(event.clientX, event.clientY);
    const subtractFeature = getSubtractBoundaryFeatureFromWorld(world, record?.id);
    if (subtractFeature) return subtractFeature;
    if (!record && target.classList?.contains('closed-constrained-region')) {
      const boundaryId = target.dataset.boundaryId;
      const resolvedBoundary = typeof getResolvedBoundaries === 'function'
        ? getResolvedBoundaries().find((boundary) => boundary.id === boundaryId)
        : null;
      if (resolvedBoundary) return nearestFeature(resolvedBoundary.features, world);
      const parentIds = new Set((target.dataset.parentIds || '').split(',').filter(Boolean));
      const drawable = records
        .filter((candidate) => parentIds.has(candidate.id) && ['geometry', 'fillet'].includes(candidate.recordType))
        .map((candidate) => candidate.entity);
      return nearestFeature(evaluateFilletedGeometry(drawable).flatMap(featuresForEntity), world);
    }
    if (!record || !['geometry', 'fillet'].includes(record.recordType)) return null;
    if (record.recordType === 'fillet') {
      return featureAtWorld(getEntityFeature(record.id, { rendered: true }), world);
    }
    const subtractFeatures = boundaryFeatures({ recordId: record.id });
    if (subtractFeatures.length) return nearestFeature(subtractFeatures, world);
    if (['line', 'rect', 'polygon', 'polyline'].includes(record.entity.type)) {
      return nearestFeature(featuresForEntity(renderedEntityForRecord(record)), world);
    }
    if (['circle', 'arc'].includes(record.entity.type)) {
      return featureAtWorld(getEntityFeature(record.id, { rendered: true }), world);
    }
    if (record.entity.type === 'curve') {
      return featureAtWorld(
        featuresForEntity(renderedEntityForRecord(record))[0] || null,
        world,
      );
    }
    return null;
  }

  return {
    boundaryForHost: currentResolvedBoundary,
    boundaryFeatures,
    featureForHost,
    featureFromEvent,
    featuresForEntity,
    inwardTarget,
    isClosedHost,
  };
}

// --- Notch Tools ---
export function createNotchTools({
  toolbar,
  canvas,
  drawingHint = null,
  button = toolbar?.querySelector('[data-notch-tool]'),
  bindButton = true,
}) {
  let active = false;
  let defaultNotchType = DEFAULT_NOTCH_TYPE;

  function setDefaultNotchType(value, { history = true } = {}) {
    const next = normalizeNotchType(value, DEFAULT_NOTCH_TYPE);
    if (next === defaultNotchType) return defaultNotchType;
    if (history) canvas.requestHistoryCheckpoint?.('notch-default-type');
    defaultNotchType = next;
    if (history) canvas.notifyObjectChange?.({ history: 'commit' });
    return defaultNotchType;
  }

  canvas.registerDrawingExtension?.('notchTools', {
    serialize: () => ({ version: 1, defaultNotchType }),
    restore(value) {
      defaultNotchType = normalizeNotchType(value?.defaultNotchType, DEFAULT_NOTCH_TYPE);
    },
    clear() {
      defaultNotchType = DEFAULT_NOTCH_TYPE;
    },
  });

  function mountDrawingPropertiesControl(container) {
    if (!container) return null;
    container.querySelector('[data-notch-type-property]')?.remove();
    const label = document.createElement('label');
    label.className = 'drawing-property-field';
    label.dataset.notchTypeProperty = 'true';
    const text = document.createElement('span');
    text.textContent = 'Notch Type';
    const select = document.createElement('select');
    select.id = 'notchTypeProperty';
    select.setAttribute('aria-label', 'Default notch type');
    NOTCH_TYPE_OPTIONS.forEach(({ value, label: optionLabel }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = optionLabel;
      option.selected = value === defaultNotchType;
      select.appendChild(option);
    });
    label.htmlFor = select.id;
    label.append(text, select);
    const footnote = container.querySelector('.drawing-properties-footnote');
    container.insertBefore(label, footnote || null);
    select.addEventListener('change', () => setDefaultNotchType(select.value));
    return select;
  }

  function deactivate() {
    if (!active) return;
    active = false;
    button?.classList.remove('active');
    button?.setAttribute('aria-pressed', 'false');
    canvas.setFeatureCommandDelegate(null);
    drawingHint?.hide();
  }

  function activate() {
    window.dispatchEvent(new CustomEvent('paramagic:tool-activated', { detail: { source: 'notch' } }));
    active = true;
    button?.classList.add('active');
    button?.setAttribute('aria-pressed', 'true');
    canvas.setFeatureCommandDelegate(delegate);
  }

  function toggle() {
    if (active) deactivate();
    else activate();
  }

  const delegate = {
    pointerDown(event) {
      if (!active || event.button !== 0) return false;
      const feature = canvas.getNotchHostFeatureFromEvent(event);
      if (!feature || !['segment', 'arc', 'circle', 'curve', 'polyline'].includes(feature.kind)) return false;
      event.preventDefault();
      event.stopPropagation();
      const point = feature.pickedPoint || canvas.screenToWorld(event.clientX, event.clientY);
      deactivate();
      const created = canvas.addNotch(feature, point, defaultNotchType);
      if (!created) activate();
      else rememberRepeatableTool(() => {
        if (active) return false;
        activate();
        return true;
      });
      return true;
    },
    pointerMove(event) {
      if (!active) {
        drawingHint?.hide();
        return false;
      }
      const feature = canvas.getNotchHostFeatureFromEvent(event);
      if (!feature || !['segment', 'arc', 'circle', 'curve', 'polyline'].includes(feature.kind)) {
        drawingHint?.hide();
        return false;
      }
      const point = canvas.screenToWorld(event.clientX, event.clientY);
      const projection = projectPointToNotchFeature(point, feature);
      const memory = projection && createNotchLocationMemory(feature, projection.parameter);
      if (!memory) {
        drawingHint?.hide();
        return false;
      }
      const text = drawingHint?.formatLength(Math.abs(memory.signedDistance))
        || canvas.formatDrawingLength?.(Math.abs(memory.signedDistance))
        || Math.abs(memory.signedDistance).toFixed(3);
      drawingHint?.show(event, `L ${text}`);
      return false;
    },
    keyDown(event) {
      if (!active || event.key !== 'Escape') return false;
      event.preventDefault();
      deactivate();
      return true;
    },
  };

  if (bindButton) button?.addEventListener('click', toggle);
  window.addEventListener('paramagic:tool-activated', (event) => {
    if (event.detail?.source !== 'notch' && active) deactivate();
  });
  return {
    activate,
    deactivate,
    toggle,
    isActive: () => active,
    getDefaultNotchType: () => defaultNotchType,
    setDefaultNotchType,
    mountDrawingPropertiesControl,
  };
}

// --- Notch System Manager ---
export function notchDotRadiusForScale(scale) {
  return 6 / Math.max(0.0001, Number(scale) || 1);
}

export function notchDependsOnRecordIds(notchEntity, changedRecordIds = null) {
  if (!changedRecordIds) return true;
  return [
    notchEntity?.id,
    notchEntity?.host?.recordId,
    notchEntity?.host?.sourceId,
    notchEntity?.host?.targetId,
  ].some((recordId) => recordId && changedRecordIds.has(recordId));
}

export function createNotchSystem({
  records,
  addSvg,
  objectLayer,
  bindRecordEvents,
  updateRecordHandles,
  featureForHost,
  inwardTargetForHost,
  boundaryFeaturesForHost,
  isClosedHostFeature,
  requestHistoryCheckpoint,
  notifyObjectChange,
  syncState,
  showStatusMessage,
  solver,
  getPointFeature,
  getSegmentFeature,
  refreshLinkedDimensions,
  reapplySolverSnapshot,
  getScale = () => 1,
  assignStack = (entity) => entity,
}) {
  let valueOnly = false;
  const inwardResolver = (host, context = null) => (point, tangent) => inwardTargetForHost(host, point, tangent, context);
  const sourceParameterForFeature = (feature, parameter) => {
    if (!Number.isFinite(Number(feature.parameterStart))
      || !Number.isFinite(Number(feature.parameterEnd))
      || !Number.isFinite(Number(parameter))) return null;
    if (feature.kind === 'arc') {
      const tau = Math.PI * 2;
      return ((Number(parameter) % tau) + tau) % tau / tau;
    }
    return Number(feature.parameterStart)
      + (Number(feature.parameterEnd) - Number(feature.parameterStart)) * Number(parameter);
  };
  const hostFromFeature = (feature, parameter = null) => ({
    recordId: feature.recordId,
    kind: feature.kind,
    index: feature.index ?? 0,
    ...(feature.sourceId ? { sourceId: feature.sourceId } : {}),
    ...(feature.targetId ? { targetId: feature.targetId } : {}),
    ...(feature.sourceFeatureIndex !== undefined ? { sourceFeatureIndex: feature.sourceFeatureIndex } : {}),
    ...(feature.boundaryRole ? { boundaryRole: feature.boundaryRole } : {}),
    ...(feature.stableKey ? { stableKey: feature.stableKey } : {}),
    ...(sourceParameterForFeature(feature, parameter) !== null
      ? { sourceParameter: sourceParameterForFeature(feature, parameter) }
      : {}),
  });

  function evaluateRecord(record) {
    const feature = featureForHost(record.entity.host, record.entity);
    const needsCircleQuadrantMemory = feature?.kind === 'circle'
      && !isCircleQuadrantLocationMemory(record.entity.locationMemory);
    if (feature && (!record.entity.locationMemory || needsCircleQuadrantMemory)) {
      record.entity.locationMemory = createNotchLocationMemory(feature, record.entity.parameter);
    }
    return evaluateNotch(record.entity, feature, inwardResolver(record.entity.host, record.entity));
  }

  function updateRecord(record) {
    const evaluated = evaluateRecord(record);
    const visible = evaluated.valid;
    record.group.style.display = visible ? '' : 'none';
    if (!visible) return evaluated;
    if (Number.isFinite(evaluated.parameter)) record.entity.parameter = evaluated.parameter;
    record.entity.point = evaluated.point;
    record.entity.end = evaluated.end;
    const path = notchSvgPath(record.entity);
    record.line.setAttribute('d', path);
    record.line.setAttribute('fill', notchFillColor(record.entity));
    record.hitNode.setAttribute('d', path);
    record.dot.setAttribute('cx', evaluated.point[0]);
    record.dot.setAttribute('cy', evaluated.point[1]);
    updateRecordHandles(record);
    return evaluated;
  }

  function createRecord(input) {
    if (!isNotchEntity(input)) return null;
    const entity = JSON.parse(JSON.stringify(input));
    entity.notchType = normalizeNotchType(entity.notchType);
    const group = addSvg(objectLayer, 'g', {
      class: 'canvas-record entity-record notch-record',
      'data-record-id': entity.id,
      'data-entity-type': 'notch',
      'aria-label': 'Notch',
    });
    const line = addSvg(group, 'path', { class: 'notch-line selectable-entity', fill: 'none' });
    const hitNode = addSvg(group, 'path', { class: 'notch-hit selectable-entity hit-target', fill: 'none' });
    const dot = addSvg(group, 'circle', {
      r: notchDotRadiusForScale(getScale()),
      class: 'notch-dot selectable-entity',
    });
    const handleGroup = addSvg(group, 'g', { class: 'handle-group' });
    const record = {
      id: entity.id, recordType: 'notch', entity, group, node: line, line, hitNode, dot, handleGroup, handles: [],
    };
    group.classList.toggle('value-only', valueOnly);
    bindRecordEvents(record);
    updateRecord(record);
    return record;
  }

  function addNotch(feature, pickedPoint, notchType = DEFAULT_NOTCH_TYPE) {
    if (!isClosedHostFeature(feature)) {
      showStatusMessage('Select an edge that belongs to a closed shape.');
      return null;
    }
    const projection = projectPointToNotchFeature(feature.pickedPoint || pickedPoint, feature);
    const host = hostFromFeature(feature, projection?.parameter);
    const entity = assignStack(createNotchEntity(
      feature,
      feature.pickedPoint || pickedPoint,
      inwardResolver(host),
      undefined,
      normalizeNotchType(notchType, DEFAULT_NOTCH_TYPE),
    ), records.find((record) => record.id === feature.recordId)?.entity?.stackId);
    requestHistoryCheckpoint('notch-add');
    const record = createRecord(entity);
    if (!record) return null;
    records.push(record);
    notifyObjectChange({ history: 'commit' });
    syncState();
    return record.entity;
  }

  function beginMove() {
    requestHistoryCheckpoint('notch-drag');
  }

  function moveRecord(record, world) {
    const features = boundaryFeaturesForHost(record.entity.host);
    const nearest = features.reduce((best, feature) => {
      const projection = projectPointToNotchFeature(world, feature);
      return projection && (!best || projection.distance < best.projection.distance)
        ? { feature, projection }
        : best;
    }, null);
    if (!nearest) return false;
    record.entity.host = hostFromFeature(nearest.feature, nearest.projection.parameter);
    record.entity.point = [...nearest.projection.point];
    moveNotchToPoint(record.entity, nearest.feature, world);
    updateRecord(record);
    refreshLinkedDimensions(new Set([record.id]));
    return true;
  }

  function resolveDimensionReference(target) {
    if (target?.otherSegment) {
      const segment = getSegmentFeature(
        target.otherSegment.recordId,
        target.otherSegment.index,
        { rendered: true },
      );
      return segment ? { kind: 'segment', start: segment.start, end: segment.end } : null;
    }
    const point = getPointFeature(
      target?.otherAnchor?.recordId,
      target?.otherAnchor?.index,
      { rendered: true },
    )?.point;
    return point ? { kind: 'point', point } : null;
  }

  function applyDistanceTarget(target, subtype, value) {
    return setDistance(target.recordId, resolveDimensionReference(target), subtype, value);
  }

  function applyDrivingDimensions(changedRecordIds = null) {
    const dimensionedNotchIds = new Set();
    records.filter((record) => (
      record.recordType === 'dimension'
      && record.entity.dimensionMode === 'driving'
      && record.entity.externalDrivingTarget?.type === 'notch-distance'
      && (!changedRecordIds || (() => {
        const notch = records.find((candidate) => (
          candidate.recordType === 'notch'
          && candidate.id === record.entity.externalDrivingTarget.recordId
        ));
        return notchDependsOnRecordIds(notch?.entity, changedRecordIds);
      })())
    )).forEach((record) => {
      const notch = records.find((candidate) => (
        candidate.recordType === 'notch'
        && candidate.id === record.entity.externalDrivingTarget.recordId
      ));
      const feature = notch && featureForHost(notch.entity.host, notch.entity);
      const entry = solver.dimensions.get(record.entity.dimensionId);
      if (entry?.enabled === false) {
        record.entity.suppressed = false;
        record.group?.classList.remove('dimension-suppressed');
        record.group?.removeAttribute('data-suppressed');
        return;
      }
      const exceedsHostLength = Boolean(
        notch?.entity.locationMemory
        && feature
        && entry
        && entry.value > notchFeatureLength(feature) + 1e-9
      );
      if (exceedsHostLength) {
        dimensionedNotchIds.add(notch.id);
        notch.entity.locationMemory.forceProportional = true;
        record.entity.suppressed = true;
        record.group?.classList.add('dimension-suppressed');
        record.group?.setAttribute('data-suppressed', 'true');
        return;
      }
      record.entity.suppressed = false;
      record.group?.classList.remove('dimension-suppressed');
      record.group?.removeAttribute('data-suppressed');
      if (entry) {
        applyDistanceTarget(
          record.entity.externalDrivingTarget,
          record.entity.subtype,
          entry.value,
        );
      }
    });
    records.filter((record) => (
      record.recordType === 'notch'
      && record.entity.locationMemory
      && notchDependsOnRecordIds(record.entity, changedRecordIds)
    ))
      .forEach((record) => {
        record.entity.locationMemory.forceProportional = dimensionedNotchIds.has(record.id);
      });
  }

  function finishMove(record) {
    const hasDrivingDimension = records.some((candidate) => (
      candidate.recordType === 'dimension'
      && candidate.entity.dimensionMode === 'driving'
      && candidate.entity.externalDrivingTarget?.type === 'notch-distance'
      && candidate.entity.externalDrivingTarget.recordId === record.id
    ));
    if (hasDrivingDimension) reapplySolverSnapshot();
    else refreshLinkedDimensions(new Set([record.id]));
    notifyObjectChange({ history: 'commit' });
  }

  function includeDependentDeletionIds(deletionIds, hostIds) {
    records.forEach((record) => {
      if (record.recordType === 'notch' && hostIds.has(record.entity.host.recordId)) {
        deletionIds.add(record.id);
      }
    });
  }

  function setDistance(recordId, reference, subtype, targetValue) {
    const record = records.find((candidate) => candidate.id === recordId && candidate.recordType === 'notch');
    const target = Number(targetValue);
    const currentFeature = record && featureForHost(record.entity.host, record.entity);
    if (
      record?.entity.locationMemory
      && currentFeature
      && Number.isFinite(target)
      && target > notchFeatureLength(currentFeature) + 1e-9
    ) {
      record.entity.locationMemory.forceProportional = true;
      updateRecord(record);
      return { valid: true, suppressed: true };
    }
    const features = record ? boundaryFeaturesForHost(record.entity.host) : [];
    if (!record || !features.length || !reference || !Number.isFinite(target) || target < 0) {
      return { valid: false, error: 'The notch driving dimension is not valid.' };
    }
    const referencePoint = (point) => {
      if (reference.kind !== 'segment') return reference.point;
      const vector = [
        reference.end[0] - reference.start[0],
        reference.end[1] - reference.start[1],
      ];
      const sizeSquared = vector[0] ** 2 + vector[1] ** 2;
      const ratio = sizeSquared
        ? Math.max(0, Math.min(1, ((point[0] - reference.start[0]) * vector[0] + (point[1] - reference.start[1]) * vector[1]) / sizeSquared))
        : 0;
      return [
        reference.start[0] + vector[0] * ratio,
        reference.start[1] + vector[1] * ratio,
      ];
    };
    const originalPoint = [...record.entity.point];
    const metric = (feature, parameter) => {
      const host = hostFromFeature(feature, parameter);
      const candidate = { ...record.entity, host, parameter, locationMemory: null };
      const evaluated = evaluateNotch(candidate, feature, inwardResolver(host));
      if (!evaluated.valid) return Number.POSITIVE_INFINITY;
      const otherPoint = referencePoint(evaluated.point);
      if (!otherPoint) return Number.POSITIVE_INFINITY;
      if (subtype === 'horizontal') return Math.abs(evaluated.point[0] - otherPoint[0]);
      if (subtype === 'vertical') return Math.abs(evaluated.point[1] - otherPoint[1]);
      return Math.hypot(evaluated.point[0] - otherPoint[0], evaluated.point[1] - otherPoint[1]);
    };
    const candidates = features.map((feature) => {
      const sameHost = (
        feature.recordId === record.entity.host.recordId
        && feature.kind === record.entity.host.kind
        && (feature.index ?? 0) === (record.entity.host.index ?? 0)
      );
      const original = sameHost ? Number(record.entity.parameter) || 0 : 0;
      const domain = notchFeatureParameterDomain(feature, original);
      const samples = Math.max(120, Math.ceil(720 / features.length));
      let best = Math.max(domain[0], Math.min(domain[1], original));
      let bestError = Math.abs(metric(feature, best) - target);
      for (let index = 0; index <= samples; index += 1) {
        const parameter = domain[0] + (domain[1] - domain[0]) * index / samples;
        const error = Math.abs(metric(feature, parameter) - target);
        if (error < bestError) {
          best = parameter;
          bestError = error;
        }
      }
      let left = Math.max(domain[0], best - (domain[1] - domain[0]) / samples);
      let right = Math.min(domain[1], best + (domain[1] - domain[0]) / samples);
      for (let index = 0; index < 48; index += 1) {
        const first = left + (right - left) / 3;
        const second = right - (right - left) / 3;
        if (Math.abs(metric(feature, first) - target) <= Math.abs(metric(feature, second) - target)) right = second;
        else left = first;
      }
      best = (left + right) / 2;
      bestError = Math.abs(metric(feature, best) - target);
      const host = hostFromFeature(feature, best);
      const evaluated = evaluateNotch(
        { ...record.entity, host, parameter: best, locationMemory: null },
        feature,
        inwardResolver(host),
      );
      return {
        feature,
        parameter: best,
        error: bestError,
        movement: evaluated.valid
          ? Math.hypot(evaluated.point[0] - originalPoint[0], evaluated.point[1] - originalPoint[1])
          : Number.POSITIVE_INFINITY,
      };
    });
    const reachable = candidates.filter(({ error }) => error <= 0.01);
    if (!reachable.length) return { valid: false, error: 'That distance cannot be reached along the notch boundary.' };
    const selected = reachable.reduce((best, candidate) => (
      candidate.movement < best.movement ? candidate : best
    ), reachable[0]);
    record.entity.host = hostFromFeature(selected.feature, selected.parameter);
    record.entity.parameter = selected.parameter;
    record.entity.locationMemory = createNotchLocationMemory(selected.feature, selected.parameter);
    updateRecord(record);
    return { valid: true };
  }

  function refresh(changedRecordIds = null) {
    records.filter((record) => (
      record.recordType === 'notch'
      && notchDependsOnRecordIds(record.entity, changedRecordIds)
    )).forEach(updateRecord);
  }

  function setValueOnly(value) {
    valueOnly = Boolean(value);
    records.filter((record) => record.recordType === 'notch')
      .forEach((record) => record.group.classList.toggle('value-only', valueOnly));
  }

  function syncScreenScale(scale) {
    records.filter((record) => record.recordType === 'notch')
      .forEach((record) => record.dot.setAttribute('r', notchDotRadiusForScale(scale)));
  }

  return {
    addNotch,
    applyDistanceTarget,
    applyDrivingDimensions,
    beginMove,
    createRecord,
    evaluateRecord,
    finishMove,
    includeDependentDeletionIds,
    moveRecord,
    refresh,
    setDistance,
    setValueOnly,
    syncScreenScale,
    updateRecord,
  };
}
