import { drawingCurveCubicPoint, drawingCurveCubicSegment } from './DrawingTools.js';

export const DXF_BOUNDARY_ENTITY_TYPE = 'dxf-boundary';
export const DXF_CURVE_TOLERANCE = 0.25;

const TAU = Math.PI * 2;
const EPSILON = 1e-9;
const clone = (value) => JSON.parse(JSON.stringify(value));
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const subtract = (a, b) => [a[0] - b[0], a[1] - b[1]];
const scale = (point, amount) => [point[0] * amount, point[1] * amount];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const length = (point) => Math.hypot(point[0], point[1]);
const distance = (a, b) => length(subtract(a, b));
const midpoint = (a, b) => scale(add(a, b), 0.5);
const perpendicular = (point) => [-point[1], point[0]];
const finitePoint = (point) => Array.isArray(point) && point.length >= 2
  && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]));
const normalizeAngle = (angle) => ((angle % TAU) + TAU) % TAU;

function unit(point, fallback = null) {
  const magnitude = length(point);
  return magnitude > EPSILON ? scale(point, 1 / magnitude) : fallback;
}

function lerp(a, b, ratio) {
  return add(scale(a, 1 - ratio), scale(b, ratio));
}

function cubicDerivative(segment, t) {
  const inverse = 1 - t;
  return add(
    add(
      scale(subtract(segment[1], segment[0]), 3 * inverse * inverse),
      scale(subtract(segment[2], segment[1]), 6 * inverse * t),
    ),
    scale(subtract(segment[3], segment[2]), 3 * t * t),
  );
}

function drawingCurveEvaluation(points, parameter) {
  const maximum = Math.max(0, points.length - 1);
  const clamped = Math.max(0, Math.min(maximum, Number(parameter) || 0));
  const index = Math.min(points.length - 2, Math.floor(clamped));
  const t = index === points.length - 2 && clamped === maximum ? 1 : clamped - index;
  const cubic = drawingCurveCubicSegment(points, index);
  const point = drawingCurveCubicPoint(cubic, t);
  return {
    point,
    tangent: unit(cubicDerivative(cubic, t), unit(subtract(cubic[3], cubic[0]), [1, 0])),
  };
}

function lineSegment(start, end) {
  return { type: 'line', start: [...start], end: [...end] };
}

function arcFromStartTangent(start, tangentInput, end) {
  const tangent = unit(tangentInput);
  const chord = subtract(end, start);
  if (!tangent || length(chord) <= EPSILON) return null;
  const normal = perpendicular(tangent);
  const denominator = 2 * dot(chord, normal);
  if (Math.abs(denominator) <= EPSILON * Math.max(1, length(chord))) {
    return lineSegment(start, end);
  }
  const offset = dot(chord, chord) / denominator;
  const center = add(start, scale(normal, offset));
  const radius = distance(start, center);
  if (!Number.isFinite(radius) || radius <= EPSILON) return lineSegment(start, end);
  const startAngle = Math.atan2(start[1] - center[1], start[0] - center[0]);
  const endAngle = Math.atan2(end[1] - center[1], end[0] - center[0]);
  const radial = unit(subtract(start, center));
  const followsCcw = dot(perpendicular(radial), tangent) >= 0;
  const sweep = followsCcw
    ? normalizeAngle(endAngle - startAngle)
    : -normalizeAngle(startAngle - endAngle);
  if (Math.abs(sweep) <= EPSILON || Math.abs(sweep) >= TAU - 1e-7) {
    return lineSegment(start, end);
  }
  const middleAngle = startAngle + sweep / 2;
  return {
    type: 'arc',
    start: [...start],
    arcPoint: [
      center[0] + Math.cos(middleAngle) * radius,
      center[1] + Math.sin(middleAngle) * radius,
    ],
    end: [...end],
    center,
    radius,
  };
}

function reverseSegment(segment) {
  return segment.type === 'arc'
    ? {
      ...segment,
      start: [...segment.end],
      arcPoint: [...segment.arcPoint],
      end: [...segment.start],
      center: [...segment.center],
    }
    : lineSegment(segment.end, segment.start);
}

function fitBiarc(start, startTangent, end, endTangent, ratio = 1) {
  const chord = subtract(end, start);
  const chordLength = length(chord);
  if (chordLength <= EPSILON) return null;

  const normalizedRatio = Math.max(1e-4, Number(ratio) || 1);
  const a = 2 * normalizedRatio * (1 - dot(startTangent, endTangent));
  const b = 2 * dot(chord, add(startTangent, scale(endTangent, normalizedRatio)));
  const c = -dot(chord, chord);
  let firstDistance;
  if (Math.abs(a) <= EPSILON) {
    firstDistance = Math.abs(b) > EPSILON ? -c / b : chordLength / 3;
  } else {
    const discriminant = Math.max(0, b * b - 4 * a * c);
    firstDistance = (-b + Math.sqrt(discriminant)) / (2 * a);
  }
  if (!Number.isFinite(firstDistance) || firstDistance <= EPSILON) {
    firstDistance = chordLength / 3;
  }
  const secondDistance = firstDistance * normalizedRatio;

  const firstTangentPoint = add(start, scale(startTangent, firstDistance));
  const secondTangentPoint = subtract(end, scale(endTangent, secondDistance));
  const join = scale(
    add(scale(firstTangentPoint, secondDistance), scale(secondTangentPoint, firstDistance)),
    1 / (firstDistance + secondDistance),
  );
  if (distance(join, start) <= EPSILON || distance(join, end) <= EPSILON) return null;

  const first = arcFromStartTangent(start, startTangent, join);
  const backwardSecond = arcFromStartTangent(end, scale(endTangent, -1), join);
  if (!first || !backwardSecond) return null;
  return [first, reverseSegment(backwardSecond)];
}

function arcSweep(segment) {
  const start = Math.atan2(
    segment.start[1] - segment.center[1],
    segment.start[0] - segment.center[0],
  );
  const middle = Math.atan2(
    segment.arcPoint[1] - segment.center[1],
    segment.arcPoint[0] - segment.center[0],
  );
  const end = Math.atan2(
    segment.end[1] - segment.center[1],
    segment.end[0] - segment.center[0],
  );
  const ccw = normalizeAngle(end - start);
  return {
    start,
    sweep: normalizeAngle(middle - start) <= ccw + 1e-9 ? ccw : ccw - TAU,
  };
}

function distanceToLineSegment(point, start, end) {
  const delta = subtract(end, start);
  const denominator = dot(delta, delta);
  const ratio = denominator > EPSILON
    ? Math.max(0, Math.min(1, dot(subtract(point, start), delta) / denominator))
    : 0;
  return distance(point, lerp(start, end, ratio));
}

function distanceToArc(point, segment) {
  const { start, sweep } = arcSweep(segment);
  const pointAngle = Math.atan2(
    point[1] - segment.center[1],
    point[0] - segment.center[0],
  );
  const travel = sweep >= 0
    ? normalizeAngle(pointAngle - start)
    : normalizeAngle(start - pointAngle);
  if (travel <= Math.abs(sweep) + 1e-9) {
    return Math.abs(distance(point, segment.center) - segment.radius);
  }
  return Math.min(distance(point, segment.start), distance(point, segment.end));
}

function distanceToSegment(point, segment) {
  return segment.type === 'arc'
    ? distanceToArc(point, segment)
    : distanceToLineSegment(point, segment.start, segment.end);
}

function biarcRangeError(points, parameterStart, parameterEnd, segments) {
  const sampleCount = Math.max(32, Math.ceil((parameterEnd - parameterStart) * 64));
  let error = 0;
  let parameterAtError = (parameterStart + parameterEnd) / 2;
  for (let sample = 0; sample <= sampleCount; sample += 1) {
    const parameter = parameterStart
      + (parameterEnd - parameterStart) * sample / sampleCount;
    const point = drawingCurveEvaluation(points, parameter).point;
    const sampleError = Math.min(...segments.map((segment) => distanceToSegment(point, segment)));
    if (sampleError > error) {
      error = sampleError;
      parameterAtError = parameter;
    }
  }
  return { error, parameterAtError };
}

function bestBiarcForRange(points, parameterStart, parameterEnd) {
  const start = drawingCurveEvaluation(points, parameterStart);
  const end = drawingCurveEvaluation(points, parameterEnd);
  const ratios = [1, 0.5, 2, 0.25, 4, 0.125, 8];
  return ratios.reduce((best, ratio) => {
    const segments = fitBiarc(start.point, start.tangent, end.point, end.tangent, ratio);
    if (!segments) return best;
    const measured = biarcRangeError(points, parameterStart, parameterEnd, segments);
    const candidate = { segments, ...measured };
    return !best || candidate.error < best.error ? candidate : best;
  }, null);
}

function approximateCurveRange(points, parameterStart, parameterEnd, tolerance, depth = 0) {
  const fitted = bestBiarcForRange(points, parameterStart, parameterEnd);
  if (fitted && (fitted.error <= tolerance || depth >= 14)) return fitted.segments;
  if (depth >= 14) {
    const start = drawingCurveEvaluation(points, parameterStart).point;
    const end = drawingCurveEvaluation(points, parameterEnd).point;
    return fitted?.segments || [lineSegment(start, end)];
  }
  const range = parameterEnd - parameterStart;
  let split = fitted?.parameterAtError ?? (parameterStart + parameterEnd) / 2;
  if (split - parameterStart < range * 0.15 || parameterEnd - split < range * 0.15) {
    split = (parameterStart + parameterEnd) / 2;
  }
  return [
    ...approximateCurveRange(points, parameterStart, split, tolerance, depth + 1),
    ...approximateCurveRange(points, split, parameterEnd, tolerance, depth + 1),
  ];
}

export function drawingCurveToDxfSegments(points, tolerance = DXF_CURVE_TOLERANCE) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const normalizedTolerance = Math.max(1e-6, Number(tolerance) || DXF_CURVE_TOLERANCE);
  return approximateCurveRange(
    points,
    0,
    points.length - 1,
    normalizedTolerance,
  ).filter((segment) => distance(segment.start, segment.end) > EPSILON);
}

function polylineSegments(points, closed = false) {
  const usable = (points || []).filter(finitePoint).map((point) => point.map(Number));
  if (usable.length < 2) return [];
  const segmentCount = closed ? usable.length : usable.length - 1;
  return Array.from({ length: segmentCount }, (_, index) => (
    lineSegment(usable[index], usable[(index + 1) % usable.length])
  )).filter((segment) => distance(segment.start, segment.end) > EPSILON);
}

export function boundaryFeaturesToDxfSegments(features = [], {
  curveTolerance = DXF_CURVE_TOLERANCE,
} = {}) {
  return features.flatMap((feature) => {
    if (feature.kind === 'segment') return [lineSegment(feature.start, feature.end)];
    if (feature.kind === 'polyline') return polylineSegments(feature.points);
    if (feature.kind === 'curve') return drawingCurveToDxfSegments(feature.points, curveTolerance);
    if (feature.kind === 'arc') {
      return [{
        type: 'arc',
        start: [...feature.start],
        arcPoint: [...feature.arcPoint],
        end: [...feature.end],
        center: [...feature.center],
        radius: Number(feature.radius),
      }];
    }
    if (feature.kind === 'circle') {
      const center = feature.center.map(Number);
      const radius = Math.abs(Number(feature.radius));
      const right = [center[0] + radius, center[1]];
      const left = [center[0] - radius, center[1]];
      return [
        {
          type: 'arc',
          start: right,
          arcPoint: [center[0], center[1] - radius],
          end: left,
          center: [...center],
          radius,
        },
        {
          type: 'arc',
          start: left,
          arcPoint: [center[0], center[1] + radius],
          end: right,
          center: [...center],
          radius,
        },
      ];
    }
    return [];
  }).filter((segment) => (
    finitePoint(segment.start)
    && finitePoint(segment.end)
    && distance(segment.start, segment.end) > EPSILON
  ));
}

export function transformDxfBoundary(boundary, transformPoint) {
  return {
    ...clone(boundary),
    segments: boundary.segments.map((segment) => ({
      ...segment,
      start: transformPoint(segment.start),
      end: transformPoint(segment.end),
      ...(segment.type === 'arc' ? {
        arcPoint: transformPoint(segment.arcPoint),
        center: transformPoint(segment.center),
      } : {}),
    })),
  };
}

function transformedArcBulge(segment, transformPoint) {
  const transformed = {
    ...segment,
    start: transformPoint(segment.start),
    arcPoint: transformPoint(segment.arcPoint),
    end: transformPoint(segment.end),
    center: transformPoint(segment.center),
  };
  const { sweep } = arcSweep(transformed);
  return Math.abs(sweep) <= EPSILON ? 0 : Math.tan(sweep / 4);
}

export function dxfBoundaryVertices(boundary, transformPoint = (point) => [...point]) {
  const vertices = (boundary.segments || []).map((segment) => ({
    point: transformPoint(segment.start),
    bulge: segment.type === 'arc' ? transformedArcBulge(segment, transformPoint) : 0,
  }));
  if (boundary.closed !== true && boundary.segments?.length) {
    vertices.push({
      point: transformPoint(boundary.segments.at(-1).end),
      bulge: 0,
    });
  }
  return vertices;
}
