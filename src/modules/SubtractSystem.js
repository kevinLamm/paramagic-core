import { sampleNotchFeature, projectPointToNotchFeature } from './NotchSystem.js';
import { resolveClosedBoundaries } from './BoundaryTopology.js';
import {
  evaluateArrayDefinition,
  materializeArraySubtractOwners,
} from './ArrayTools.js';
import { arcSweepFromAngles } from './ArcGeometry.js';

const EPSILON = 1e-9;
const MIN_TOPOLOGY_TOLERANCE = 1e-6;
const RELATIVE_TOPOLOGY_TOLERANCE = 1e-7;
const DEFAULT_CIRCLE_SEGMENTS = 96;
const TAU = Math.PI * 2;

const clone = (value) => JSON.parse(JSON.stringify(value));
const clonePoint = (point) => [Number(point[0]), Number(point[1])];
const subtract = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const scale = (point, amount) => [point[0] * amount, point[1] * amount];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const normalizeAngle = (value) => ((value % TAU) + TAU) % TAU;
const finitePoint = (point) => Array.isArray(point) && point.length >= 2
  && point.slice(0, 2).every((value) => Number.isFinite(Number(value)));

// --- Subtract Geometry Helpers ---

export function isSubtractableEntity(entity) {
  return Boolean(entity)
    && entity.construction !== true
    && ['circle', 'rect', 'polygon'].includes(entity.type);
}

export function subtractParentIds(entity) {
  return [...new Set((Array.isArray(entity?.subtractFrom) ? entity.subtractFrom : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

export function isSubtractCutterEntity(entity) {
  return subtractParentIds(entity).length > 0 || entity?.subtract === true;
}

export function subtractCutterAppliesTo(cutter, parentId) {
  const parents = subtractParentIds(cutter);
  return parents.length ? parents.includes(String(parentId || '')) : cutter?.subtract === true;
}

export function subtractPresentationDependsOn(dependencyRecordIds, changedRecordIds = null) {
  if (!changedRecordIds) return true;
  return [...changedRecordIds].some((recordId) => dependencyRecordIds.has(recordId));
}

export function normalizeSubtractExpression(expression, fallback = 'FALSE') {
  const value = String(expression ?? '').trim();
  return value || fallback;
}

export function evaluateSubtractExpression(expression, evaluate) {
  const normalized = normalizeSubtractExpression(expression);
  if (typeof evaluate !== 'function') return { value: false, error: 'Boolean evaluator is unavailable.' };
  try {
    const value = evaluate(normalized);
    if (typeof value !== 'boolean') return { value: false, error: 'Subtract expression must evaluate to TRUE or FALSE.' };
    return { value, error: null };
  } catch (error) {
    return { value: false, error: error.message || 'Subtract expression is invalid.' };
  }
}

export function polygonForSubtractEntity(entity, circleSegments = DEFAULT_CIRCLE_SEGMENTS) {
  if (!entity) return [];
  if (Array.isArray(entity.boundaryPolygon) && entity.boundaryPolygon.length >= 3) {
    return entity.boundaryPolygon.map(clonePoint);
  }
  if (entity.type === 'circle') {
    const count = Math.max(24, Math.floor(circleSegments));
    return Array.from({ length: count }, (_, index) => {
      const angle = Math.PI * 2 * index / count;
      return [
        entity.center[0] + Math.cos(angle) * Math.abs(entity.radius),
        entity.center[1] + Math.sin(angle) * Math.abs(entity.radius),
      ];
    });
  }
  if (entity.type === 'rect') {
    return [
      [entity.x, entity.y],
      [entity.x + entity.width, entity.y],
      [entity.x + entity.width, entity.y + entity.height],
      [entity.x, entity.y + entity.height],
    ];
  }
  if (entity.type === 'polygon') return (entity.points || []).map(clonePoint);
  return [];
}

export function subtractGeometryTolerance(target, cutters = []) {
  const points = [target, ...cutters]
    .filter(isSubtractableEntity)
    .flatMap((entity) => polygonForSubtractEntity(entity));
  if (!points.length) return MIN_TOPOLOGY_TOLERANCE;
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1);
  return Math.max(MIN_TOPOLOGY_TOLERANCE, span * RELATIVE_TOPOLOGY_TOLERANCE);
}

export function subtractPathForEntity(entity) {
  const points = polygonForSubtractEntity(entity);
  if (points.length < 3) return '';
  return `${points.map((point, index) => `${index ? 'L' : 'M'} ${point[0]} ${point[1]}`).join(' ')} Z`;
}

export function pointOnSegment(point, start, end, tolerance = 1e-7) {
  const segment = subtract(end, start);
  const relative = subtract(point, start);
  const lengthSquared = segment[0] ** 2 + segment[1] ** 2;
  if (lengthSquared <= EPSILON) return Math.hypot(relative[0], relative[1]) <= tolerance;
  if (Math.abs(cross(segment, relative)) > tolerance * Math.max(1, Math.sqrt(lengthSquared))) return false;
  const projection = relative[0] * segment[0] + relative[1] * segment[1];
  return projection >= -tolerance && projection <= lengthSquared + tolerance;
}

export function pointInSubtractPolygon(point, polygon) {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const current = polygon[index];
    const prior = polygon[previous];
    if (pointOnSegment(point, prior, current)) return true;
    const crosses = (current[1] > point[1]) !== (prior[1] > point[1])
      && point[0] < (prior[0] - current[0]) * (point[1] - current[1])
        / ((prior[1] - current[1]) || EPSILON) + current[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

export function subtractMaterialTarget(boundaryPoint, tangent, target, cutters = [], distances = [6.35, 3.175, 0.635, 0.0635]) {
  if (!boundaryPoint || !tangent || !isSubtractableEntity(target)) return null;
  const targetPolygon = polygonForSubtractEntity(target);
  const cutterPolygons = cutters
    .filter(isSubtractableEntity)
    .map((cutter) => polygonForSubtractEntity(cutter));
  const normal = unitNormal(tangent);
  for (const distance of distances) {
    for (const direction of [normal, scale(normal, -1)]) {
      const candidate = add(boundaryPoint, scale(direction, distance));
      if (
        pointInSubtractPolygon(candidate, targetPolygon)
        && cutterPolygons.every((polygon) => !pointInSubtractPolygon(candidate, polygon))
      ) return candidate;
    }
  }
  return null;
}

function pointInSubtractPolygonStrict(point, polygon) {
  if (polygon.some((start, index) => pointOnSegment(point, start, polygon[(index + 1) % polygon.length]))) return false;
  return pointInSubtractPolygon(point, polygon);
}

function segmentIntersectionParameters(first, second, tolerance = EPSILON) {
  const start = first.start;
  const direction = subtract(first.end, first.start);
  const otherStart = second.start;
  const otherDirection = subtract(second.end, second.start);
  const firstLength = Math.hypot(direction[0], direction[1]);
  const secondLength = Math.hypot(otherDirection[0], otherDirection[1]);
  if (firstLength <= EPSILON || secondLength <= EPSILON) return [];
  const firstParameterTolerance = tolerance / firstLength;
  const secondParameterTolerance = tolerance / secondLength;
  const denominator = cross(direction, otherDirection);
  const delta = subtract(otherStart, start);
  const parallelThreshold = EPSILON * Math.max(1, firstLength * secondLength);
  if (Math.abs(denominator) <= parallelThreshold) {
    if (Math.abs(cross(delta, direction)) / firstLength > tolerance) return [];
    const lengthSquared = direction[0] ** 2 + direction[1] ** 2;
    if (lengthSquared <= EPSILON) return [];
    const t0 = (delta[0] * direction[0] + delta[1] * direction[1]) / lengthSquared;
    const t1 = (subtract(second.end, start)[0] * direction[0] + subtract(second.end, start)[1] * direction[1]) / lengthSquared;
    return [t0, t1]
      .filter((value) => value >= -firstParameterTolerance && value <= 1 + firstParameterTolerance)
      .map((value) => Math.max(0, Math.min(1, value)));
  }
  const t = cross(delta, otherDirection) / denominator;
  const u = cross(delta, direction) / denominator;
  return t >= -firstParameterTolerance
    && t <= 1 + firstParameterTolerance
    && u >= -secondParameterTolerance
    && u <= 1 + secondParameterTolerance
    ? [Math.max(0, Math.min(1, t))]
    : [];
}

function boundarySegments(entity) {
  const polygon = Array.isArray(entity?.rawBoundaryPolygon) && entity.rawBoundaryPolygon.length >= 3
    ? entity.rawBoundaryPolygon.map(clonePoint)
    : polygonForSubtractEntity(entity);
  return polygon.map((start, index) => ({
    start,
    end: polygon[(index + 1) % polygon.length],
    sourceFeatureIndex: index,
    sourceStart: index / polygon.length,
    sourceEnd: (index + 1) / polygon.length,
  }));
}

function circlePoint(entity, angle) {
  return [
    entity.center[0] + Math.cos(angle) * Math.abs(entity.radius),
    entity.center[1] + Math.sin(angle) * Math.abs(entity.radius),
  ];
}

function lineCircleIntersectionParameters(segment, circle, tolerance = EPSILON) {
  const radius = Math.abs(circle.radius);
  const direction = subtract(segment.end, segment.start);
  const relative = subtract(segment.start, circle.center);
  const a = direction[0] ** 2 + direction[1] ** 2;
  if (a <= EPSILON) return [];
  const b = 2 * (relative[0] * direction[0] + relative[1] * direction[1]);
  const c = relative[0] ** 2 + relative[1] ** 2 - radius ** 2;
  const discriminant = b ** 2 - 4 * a * c;
  if (discriminant < -EPSILON) return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  const parameterTolerance = tolerance / Math.max(Math.sqrt(a), tolerance);
  return [(-b - root) / (2 * a), (-b + root) / (2 * a)]
    .filter((parameter) => parameter >= -parameterTolerance && parameter <= 1 + parameterTolerance)
    .map((parameter) => Math.max(0, Math.min(1, parameter)));
}

function circleLineIntersectionAngles(circle, segment, tolerance) {
  return lineCircleIntersectionParameters(segment, circle, tolerance).map((parameter) => {
    const point = segmentPoint(segment, parameter);
    return Math.atan2(point[1] - circle.center[1], point[0] - circle.center[0]);
  });
}

function circleCircleIntersectionAngles(first, second) {
  const firstRadius = Math.abs(first.radius);
  const secondRadius = Math.abs(second.radius);
  const delta = subtract(second.center, first.center);
  const dist = Math.hypot(delta[0], delta[1]);
  if (
    dist <= EPSILON
    || dist > firstRadius + secondRadius + EPSILON
    || dist < Math.abs(firstRadius - secondRadius) - EPSILON
  ) return [];
  const along = (firstRadius ** 2 - secondRadius ** 2 + dist ** 2) / (2 * dist);
  const heightSquared = firstRadius ** 2 - along ** 2;
  if (heightSquared < -EPSILON) return [];
  const height = Math.sqrt(Math.max(0, heightSquared));
  const base = [
    first.center[0] + delta[0] * along / dist,
    first.center[1] + delta[1] * along / dist,
  ];
  const normal = [-delta[1] / dist, delta[0] / dist];
  return [
    [base[0] + normal[0] * height, base[1] + normal[1] * height],
    [base[0] - normal[0] * height, base[1] - normal[1] * height],
  ].map((point) => Math.atan2(point[1] - first.center[1], point[0] - first.center[0]));
}

function circleBoundaryAngles(circle, shapes, tolerance) {
  const angles = [0, TAU];
  shapes.forEach((shape) => {
    if (shape.type === 'circle') {
      circleCircleIntersectionAngles(circle, shape).forEach((angle) => angles.push((angle + TAU) % TAU));
      return;
    }
    boundarySegments(shape).forEach((segment) => {
      circleLineIntersectionAngles(circle, segment, tolerance).forEach((angle) => angles.push((angle + TAU) % TAU));
    });
  });
  const angleTolerance = tolerance / Math.max(Math.abs(circle.radius), 1);
  return angles.sort((a, b) => a - b).reduce((unique, angle) => {
    if (!unique.length || Math.abs(angle - unique.at(-1)) > angleTolerance) unique.push(angle);
    return unique;
  }, []);
}

function shapeContainsPoint(entity, point) {
  if (entity.type === 'circle') {
    return Math.hypot(point[0] - entity.center[0], point[1] - entity.center[1]) <= Math.abs(entity.radius) + EPSILON;
  }
  return pointInSubtractPolygon(point, polygonForSubtractEntity(entity));
}

function quantize(value) {
  return Math.round(value * 1e6) / 1e6;
}

function stableFeatureKey(targetId, sourceId, role, sourceFeatureIndex, start, end) {
  return [targetId, sourceId, role, sourceFeatureIndex, quantize(start), quantize(end)].join(':');
}

function splitBoundarySegment(segment, allSegments, circles = [], tolerance = EPSILON) {
  const parameters = [0, 1];
  allSegments.forEach((other) => {
    segmentIntersectionParameters(segment, other, tolerance).forEach((parameter) => {
      if (parameter > EPSILON && parameter < 1 - EPSILON) parameters.push(parameter);
    });
  });
  circles.forEach((circle) => {
    lineCircleIntersectionParameters(segment, circle, tolerance).forEach((parameter) => {
      if (parameter > EPSILON && parameter < 1 - EPSILON) parameters.push(parameter);
    });
  });
  const len = Math.hypot(
    segment.end[0] - segment.start[0],
    segment.end[1] - segment.start[1],
  );
  const parameterTolerance = tolerance / Math.max(len, tolerance);
  return parameters
    .map((parameter) => Math.max(0, Math.min(1, parameter)))
    .sort((a, b) => a - b)
    .reduce((unique, parameter) => {
      if (!unique.length || Math.abs(parameter - unique.at(-1)) > parameterTolerance) unique.push(parameter);
      return unique;
    }, []);
}

function segmentPoint(segment, parameter) {
  return add(segment.start, scale(subtract(segment.end, segment.start), parameter));
}

function unitNormal(vector) {
  const size = Math.hypot(vector[0], vector[1]) || 1;
  return [-vector[1] / size, vector[0] / size];
}

function materialContainsPoint(target, cutters, point) {
  return shapeContainsPoint(target, point)
    && cutters.every((cutter) => !shapeContainsPoint(cutter, point));
}

const boundaryApproximationCache = new WeakMap();

function pointSegmentDistance(point, start, end) {
  const direction = subtract(end, start);
  const lengthSquared = dot(direction, direction);
  if (lengthSquared <= EPSILON) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const parameter = Math.max(0, Math.min(1, dot(subtract(point, start), direction) / lengthSquared));
  const projection = add(start, scale(direction, parameter));
  return Math.hypot(point[0] - projection[0], point[1] - projection[1]);
}

function boundaryApproximationAllowance(entity) {
  if (!entity || !Array.isArray(entity.boundaryFeatures) || !entity.boundaryFeatures.length) return 0;
  if (boundaryApproximationCache.has(entity)) return boundaryApproximationCache.get(entity);
  const polygonSegments = boundarySegments(entity);
  const allowance = entity.boundaryFeatures.reduce((largest, feature) => {
    if (feature.kind === 'arc' && Number.isFinite(Number(feature.radius))) {
      const sampled = sampleNotchFeature(feature);
      const sagitta = sampled.slice(1).reduce((maximum, point, index) => {
        const chord = Math.hypot(point[0] - sampled[index][0], point[1] - sampled[index][1]);
        const radius = Math.abs(Number(feature.radius));
        const value = radius - Math.sqrt(Math.max(0, radius * radius - chord * chord / 4));
        return Math.max(maximum, value);
      }, 0);
      return Math.max(largest, sagitta);
    }
    if (feature.kind === 'curve') {
      const sampled = sampleNotchFeature(feature, 96);
      const deviation = sampled.reduce((maximum, point) => Math.max(
        maximum,
        Math.min(...polygonSegments.map((segment) => pointSegmentDistance(point, segment.start, segment.end))),
      ), 0);
      return Math.max(largest, deviation);
    }
    return largest;
  }, 0);
  boundaryApproximationCache.set(entity, allowance);
  return allowance;
}

function boundarySeparatesMaterial(target, cutters, point, tangent, tolerance, featureLength) {
  const normal = unitNormal(tangent);
  const approximationAllowance = Math.max(
    boundaryApproximationAllowance(target),
    ...cutters.map(boundaryApproximationAllowance),
  );
  const requestedOffsets = [
    tolerance * 4,
    approximationAllowance * 2 + tolerance * 4,
  ];
  return requestedOffsets.some((requestedOffset) => {
    const offset = Number.isFinite(featureLength) && featureLength > 0
      ? Math.min(requestedOffset, Math.max(tolerance, featureLength * 0.2))
      : requestedOffset;
    const first = materialContainsPoint(target, cutters, add(point, scale(normal, offset)));
    const second = materialContainsPoint(target, cutters, add(point, scale(normal, -offset)));
    return first !== second;
  });
}

function boundaryFeatureArcSweep(feature) {
  const start = Math.atan2(feature.start[1] - feature.center[1], feature.start[0] - feature.center[0]);
  const middle = Math.atan2(feature.arcPoint[1] - feature.center[1], feature.arcPoint[0] - feature.center[0]);
  const end = Math.atan2(feature.end[1] - feature.center[1], feature.end[0] - feature.center[0]);
  const ccw = ((end - start) % TAU + TAU) % TAU;
  const middleCcw = ((middle - start) % TAU + TAU) % TAU;
  return { start, sweep: middleCcw <= ccw ? ccw : ccw - TAU };
}

function boundaryFeaturePoint(feature, parameter) {
  if (feature.kind === 'arc') {
    const { start, sweep } = boundaryFeatureArcSweep(feature);
    return circlePoint(feature, start + sweep * parameter);
  }
  return segmentPoint(feature, parameter);
}

function boundaryFeatureParameter(feature, point, tolerance) {
  if (feature.kind !== 'arc') {
    const direction = subtract(feature.end, feature.start);
    const lengthSquared = direction[0] ** 2 + direction[1] ** 2;
    if (lengthSquared <= EPSILON) return null;
    const parameter = (
      (point[0] - feature.start[0]) * direction[0]
      + (point[1] - feature.start[1]) * direction[1]
    ) / lengthSquared;
    const parameterTolerance = tolerance / Math.max(Math.sqrt(lengthSquared), tolerance);
    return parameter >= -parameterTolerance && parameter <= 1 + parameterTolerance
      ? Math.max(0, Math.min(1, parameter))
      : null;
  }
  const { start, sweep } = boundaryFeatureArcSweep(feature);
  if (Math.abs(sweep) <= EPSILON) return null;
  const angle = Math.atan2(point[1] - feature.center[1], point[0] - feature.center[0]);
  const travel = sweep > 0
    ? ((angle - start) % TAU + TAU) % TAU
    : -(((start - angle) % TAU + TAU) % TAU);
  const parameter = travel / sweep;
  const parameterTolerance = tolerance / Math.max(Math.abs(sweep) * Math.abs(feature.radius), tolerance);
  return parameter >= -parameterTolerance && parameter <= 1 + parameterTolerance
    ? Math.max(0, Math.min(1, parameter))
    : null;
}

function actualBoundarySegments(entity) {
  const polygon = polygonForSubtractEntity(entity);
  return polygon.map((start, index) => ({ start, end: polygon[(index + 1) % polygon.length] }));
}

function circleCircleIntersectionPoints(first, second, tolerance) {
  const firstRadius = Math.abs(first.radius);
  const secondRadius = Math.abs(second.radius);
  const delta = subtract(second.center, first.center);
  const centerDistance = Math.hypot(delta[0], delta[1]);
  if (
    centerDistance <= tolerance
    || centerDistance > firstRadius + secondRadius + tolerance
    || centerDistance < Math.abs(firstRadius - secondRadius) - tolerance
  ) return [];
  const along = (firstRadius ** 2 - secondRadius ** 2 + centerDistance ** 2) / (2 * centerDistance);
  const heightSquared = firstRadius ** 2 - along ** 2;
  if (heightSquared < -(tolerance ** 2)) return [];
  const height = Math.sqrt(Math.max(0, heightSquared));
  const base = [
    first.center[0] + delta[0] * along / centerDistance,
    first.center[1] + delta[1] * along / centerDistance,
  ];
  const normal = [-delta[1] / centerDistance, delta[0] / centerDistance];
  return [
    [base[0] + normal[0] * height, base[1] + normal[1] * height],
    [base[0] - normal[0] * height, base[1] - normal[1] * height],
  ];
}

function boundaryFeatureIntersectionPoints(first, second, tolerance) {
  const firstArc = first.kind === 'arc';
  const secondArc = second.kind === 'arc';
  if (firstArc && secondArc) {
    return circleCircleIntersectionPoints(first, second, tolerance).filter((point) => (
      boundaryFeatureParameter(first, point, tolerance) !== null
      && boundaryFeatureParameter(second, point, tolerance) !== null
    ));
  }
  if (firstArc || secondArc) {
    const arc = firstArc ? first : second;
    const segment = firstArc ? second : first;
    return lineCircleIntersectionParameters(segment, arc, tolerance)
      .map((parameter) => segmentPoint(segment, parameter))
      .filter((point) => boundaryFeatureParameter(arc, point, tolerance) !== null);
  }
  return segmentIntersectionParameters(first, second, tolerance)
    .map((parameter) => segmentPoint(first, parameter));
}

function boundaryFeatureIntersectionParameters(feature, shapes, tolerance) {
  const parameters = [0, 1];
  const addPoint = (point) => {
    const parameter = boundaryFeatureParameter(feature, point, tolerance);
    if (parameter !== null) parameters.push(parameter);
  };
  shapes.forEach((shape) => {
    if (Array.isArray(shape.boundaryFeatures) && shape.boundaryFeatures.length) {
      booleanBoundaryFeatures(shape.boundaryFeatures)
        .flatMap((other) => boundaryFeatureIntersectionPoints(feature, other, tolerance))
        .forEach(addPoint);
      return;
    }
    if (feature.kind === 'arc') {
      if (shape.type === 'circle') {
        circleCircleIntersectionPoints(feature, shape, tolerance).forEach(addPoint);
      } else {
        actualBoundarySegments(shape).forEach((segment) => {
          lineCircleIntersectionParameters(segment, feature, tolerance)
            .map((parameter) => segmentPoint(segment, parameter))
            .forEach(addPoint);
        });
      }
      return;
    }
    if (shape.type === 'circle') {
      lineCircleIntersectionParameters(feature, shape, tolerance).forEach((parameter) => parameters.push(parameter));
      return;
    }
    actualBoundarySegments(shape).forEach((segment) => {
      segmentIntersectionParameters(feature, segment, tolerance).forEach((parameter) => parameters.push(parameter));
    });
  });
  const featureLength = feature.kind === 'arc'
    ? Math.abs(boundaryFeatureArcSweep(feature).sweep) * Math.abs(feature.radius)
    : Math.hypot(feature.end[0] - feature.start[0], feature.end[1] - feature.start[1]);
  const parameterTolerance = tolerance / Math.max(featureLength, tolerance);
  return parameters
    .map((parameter) => Math.max(0, Math.min(1, parameter)))
    .sort((a, b) => a - b)
    .reduce((unique, parameter) => {
      if (!unique.length || Math.abs(parameter - unique.at(-1)) > parameterTolerance) unique.push(parameter);
      return unique;
    }, []);
}

function analyticBoundaryPiece(target, feature, role, start, end, outputIndex) {
  const parameterStart = Number.isFinite(Number(feature.parameterStart)) ? Number(feature.parameterStart) : 0;
  const parameterEnd = Number.isFinite(Number(feature.parameterEnd)) ? Number(feature.parameterEnd) : 1;
  const sourceStart = parameterStart + (parameterEnd - parameterStart) * start;
  const sourceEnd = parameterStart + (parameterEnd - parameterStart) * end;
  const piece = {
    ...feature,
    recordId: target.id,
    targetId: target.id,
    boundaryRole: role,
    index: outputIndex,
    parameterStart: sourceStart,
    parameterEnd: sourceEnd,
    start: boundaryFeaturePoint(feature, start),
    end: boundaryFeaturePoint(feature, end),
    stableKey: stableFeatureKey(
      target.id,
      feature.sourceId,
      role,
      feature.sourceFeatureIndex,
      sourceStart,
      sourceEnd,
    ),
  };
  if (feature.kind === 'arc') piece.arcPoint = boundaryFeaturePoint(feature, (start + end) / 2);
  delete piece.rawStart;
  delete piece.rawEnd;
  return piece;
}

function booleanBoundaryFeatures(sourceFeatures = []) {
  return sourceFeatures.flatMap((feature) => {
    if (feature.kind === 'segment' || feature.kind === 'arc') return [feature];
    if (feature.kind !== 'curve' && feature.kind !== 'polyline') return [];
    const sampled = sampleNotchFeature(feature, 48);
    const segmentCount = sampled.length - 1;
    if (segmentCount < 1) return [];
    return sampled.slice(0, -1).map((start, index) => {
      const segment = {
        ...feature,
        kind: 'segment',
        sourceBoundaryKind: feature.kind,
        start: [...start],
        end: [...sampled[index + 1]],
        parameterStart: index / segmentCount,
        parameterEnd: (index + 1) / segmentCount,
        stableKey: `${feature.stableKey || `${feature.sourceId}:${feature.sourceFeatureIndex || 0}`}:boolean-segment:${index}`,
      };
      delete segment.points;
      return segment;
    });
  });
}

export function subtractAnalyticBoundaryFeatures(
  target,
  cutters,
  source,
  role,
  sourceFeatures = [],
  tolerance = subtractGeometryTolerance(target, cutters),
) {
  if (!isSubtractableEntity(target) || !isSubtractableEntity(source)) return [];
  const validCutters = cutters.filter(isSubtractableEntity);
  const intersectionShapes = role === 'outer'
    ? validCutters
    : [target, ...validCutters.filter((cutter) => cutter.id !== source.id)];
  const pieces = [];
  booleanBoundaryFeatures(sourceFeatures).forEach((feature) => {
    const parameters = boundaryFeatureIntersectionParameters(feature, intersectionShapes, tolerance);
    for (let index = 1; index < parameters.length; index += 1) {
      const start = parameters[index - 1];
      const end = parameters[index];
      if (end - start <= EPSILON) continue;
      const midpointParameter = (start + end) / 2;
      const midpoint = boundaryFeaturePoint(feature, midpointParameter);
      const tangent = feature.kind === 'arc'
        ? (() => {
          const { start: startAngle, sweep } = boundaryFeatureArcSweep(feature);
          const angle = startAngle + sweep * midpointParameter;
          return [-Math.sin(angle) * Math.sign(sweep || 1), Math.cos(angle) * Math.sign(sweep || 1)];
        })()
        : subtract(feature.end, feature.start);
      const featureLength = feature.kind === 'arc'
        ? Math.abs(boundaryFeatureArcSweep(feature).sweep) * Math.abs(feature.radius) * (end - start)
        : Math.hypot(tangent[0], tangent[1]) * (end - start);
      if (boundarySeparatesMaterial(target, validCutters, midpoint, tangent, tolerance, featureLength)) {
        pieces.push(analyticBoundaryPiece(target, feature, role, start, end, pieces.length));
      }
    }
  });
  return deduplicateBoundaryFeatures(pieces, tolerance);
}

function pointGeometryKey(point, tolerance) {
  return `${Math.round(point[0] / tolerance)},${Math.round(point[1] / tolerance)}`;
}

function featureGeometryKey(feature, tolerance) {
  if (feature.kind === 'circle') {
    return `circle:${pointGeometryKey(feature.center, tolerance)}:${Math.round(feature.radius / tolerance)}`;
  }
  const start = pointGeometryKey(feature.start, tolerance);
  const end = pointGeometryKey(feature.end, tolerance);
  const endpoints = [start, end].sort().join('|');
  if (feature.kind === 'arc') {
    return `arc:${pointGeometryKey(feature.center, tolerance)}:${Math.round(feature.radius / tolerance)}:${endpoints}:${pointGeometryKey(feature.arcPoint, tolerance)}`;
  }
  return `segment:${endpoints}`;
}

function deduplicateBoundaryFeatures(features, tolerance) {
  const unique = new Map();
  features.forEach((feature) => {
    const key = featureGeometryKey(feature, tolerance);
    const current = unique.get(key);
    if (!current || (current.boundaryRole !== 'outer' && feature.boundaryRole === 'outer')) unique.set(key, feature);
  });
  return [...unique.values()].map((feature, index) => ({ ...feature, index }));
}

function featureForPiece(target, source, role, segment, localStart, localEnd, outputIndex) {
  const sourceStart = segment.sourceStart + (segment.sourceEnd - segment.sourceStart) * localStart;
  const sourceEnd = segment.sourceStart + (segment.sourceEnd - segment.sourceStart) * localEnd;
  const start = segmentPoint(segment, localStart);
  const end = segmentPoint(segment, localEnd);
  return {
    recordId: target.id,
    targetId: target.id,
    sourceId: source.id,
    entityType: source.type,
    kind: 'segment',
    index: outputIndex,
    sourceFeatureIndex: segment.sourceFeatureIndex,
    parameterStart: sourceStart,
    parameterEnd: sourceEnd,
    boundaryRole: role,
    stableKey: stableFeatureKey(target.id, source.id, role, segment.sourceFeatureIndex, sourceStart, sourceEnd),
    start,
    end,
  };
}

function featureForCirclePiece(target, source, role, startAngle, endAngle, outputIndex) {
  const sourceStart = Math.max(0, Math.min(1, startAngle / TAU));
  const sourceEnd = Math.max(0, Math.min(1, endAngle / TAU));
  const start = circlePoint(source, startAngle);
  const end = circlePoint(source, endAngle);
  const fullCircle = endAngle - startAngle >= TAU - 1e-6;
  const feature = {
    recordId: target.id,
    targetId: target.id,
    sourceId: source.id,
    entityType: source.type,
    kind: fullCircle ? 'circle' : 'arc',
    index: outputIndex,
    sourceFeatureIndex: 0,
    parameterStart: sourceStart,
    parameterEnd: fullCircle ? 1 : sourceEnd,
    boundaryRole: role,
    stableKey: stableFeatureKey(target.id, source.id, role, 0, sourceStart, fullCircle ? 1 : sourceEnd),
    center: [...source.center],
    radius: Math.abs(source.radius),
  };
  if (!fullCircle) {
    feature.start = start;
    feature.arcPoint = circlePoint(source, startAngle + (endAngle - startAngle) / 2);
    feature.end = end;
  }
  return feature;
}

function circleBoundaryPieces(target, source, role, cutters, outputIndex, tolerance) {
  const otherShapes = [target, ...cutters].filter((shape) => shape.id !== source.id);
  const angles = circleBoundaryAngles(source, otherShapes, tolerance);
  const pieces = [];
  for (let index = 1; index < angles.length; index += 1) {
    const startAngle = angles[index - 1];
    const endAngle = angles[index];
    if (endAngle - startAngle <= EPSILON) continue;
    const midpointAngle = (startAngle + endAngle) / 2;
    const midpoint = circlePoint(source, midpointAngle);
    const tangent = [-Math.sin(midpointAngle), Math.cos(midpointAngle)];
    const visible = boundarySeparatesMaterial(
      target,
      cutters,
      midpoint,
      tangent,
      tolerance,
      Math.abs(endAngle - startAngle) * Math.abs(source.radius),
    );
    if (visible) pieces.push(featureForCirclePiece(target, source, role, startAngle, endAngle, outputIndex + pieces.length));
  }
  return pieces;
}

export function subtractBoundaryFeatures(target, cutters = []) {
  if (!isSubtractableEntity(target)) return [];
  const validCutters = cutters.filter(isSubtractableEntity);
  if (!validCutters.length) return [];
  const targetPolygon = polygonForSubtractEntity(target);
  const cutterPolygons = validCutters.map((entity) => ({ entity, polygon: polygonForSubtractEntity(entity) }));
  const nonCircularEntities = [target, ...validCutters].filter((entity) => entity.type !== 'circle');
  const allSegments = nonCircularEntities.flatMap((entity) => boundarySegments(entity));
  const circles = [target, ...validCutters].filter((entity) => entity.type === 'circle');
  const tolerance = subtractGeometryTolerance(target, validCutters);
  const features = [];
  const addPieces = (source, role, segments) => {
    segments.forEach((segment) => {
      const parameters = splitBoundarySegment(segment, allSegments, circles, tolerance);
      for (let index = 1; index < parameters.length; index += 1) {
        const start = parameters[index - 1];
        const end = parameters[index];
        if (end - start <= EPSILON) continue;
        const midpoint = segmentPoint(segment, (start + end) / 2);
        const tangent = subtract(segment.end, segment.start);
        const visible = boundarySeparatesMaterial(
          target,
          validCutters,
          midpoint,
          tangent,
          tolerance,
          Math.hypot(tangent[0], tangent[1]) * (end - start),
        );
        if (visible) features.push(featureForPiece(target, source, role, segment, start, end, features.length));
      }
    });
  };
  if (target.type === 'circle') features.push(...circleBoundaryPieces(target, target, 'outer', validCutters, features.length, tolerance));
  else addPieces(target, 'outer', boundarySegments(target));
  cutterPolygons.forEach(({ entity }) => {
    if (entity.type === 'circle') features.push(...circleBoundaryPieces(target, entity, 'subtract', validCutters, features.length, tolerance));
    else addPieces(entity, 'subtract', boundarySegments(entity));
  });
  return deduplicateBoundaryFeatures(features, tolerance);
}

function reverseContourFeature(feature) {
  if (!feature.start || !feature.end) return { ...feature };
  return {
    ...feature,
    start: [...feature.end],
    end: [...feature.start],
    parameterStart: feature.parameterEnd,
    parameterEnd: feature.parameterStart,
  };
}

function endpointsMatch(first, second, tolerance) {
  return Math.hypot(first[0] - second[0], first[1] - second[1]) <= tolerance * 4;
}

export function subtractBoundaryContours(features = [], tolerance = MIN_TOPOLOGY_TOLERANCE) {
  const normalizedTolerance = Math.max(MIN_TOPOLOGY_TOLERANCE, Number(tolerance) || 0);
  const circles = features
    .filter((feature) => feature.kind === 'circle')
    .map((feature) => ({ closed: true, features: [{ ...feature }] }));
  const remaining = features
    .filter((feature) => feature.kind !== 'circle' && feature.start && feature.end)
    .map((feature) => ({ ...feature, start: [...feature.start], end: [...feature.end] }));
  const contours = [];
  while (remaining.length) {
    const chain = [remaining.shift()];
    const firstPoint = chain[0].start;
    let endPoint = chain[0].end;
    while (!endpointsMatch(endPoint, firstPoint, normalizedTolerance) && remaining.length) {
      const matches = remaining
        .map((feature, index) => ({
          feature,
          index,
          reverse: endpointsMatch(endPoint, feature.end, normalizedTolerance),
          matches: endpointsMatch(endPoint, feature.start, normalizedTolerance)
            || endpointsMatch(endPoint, feature.end, normalizedTolerance),
        }))
        .filter(({ matches }) => matches)
        .sort((a, b) => String(a.feature.stableKey).localeCompare(String(b.feature.stableKey)));
      if (!matches.length) break;
      const match = matches[0];
      remaining.splice(match.index, 1);
      const next = match.reverse ? reverseContourFeature(match.feature) : match.feature;
      chain.push(next);
      endPoint = next.end;
    }
    contours.push({ closed: endpointsMatch(endPoint, firstPoint, normalizedTolerance), features: chain });
  }
  return [...contours, ...circles];
}

function arcPathCommand(feature) {
  const startAngle = Math.atan2(feature.start[1] - feature.center[1], feature.start[0] - feature.center[0]);
  const middleAngle = Math.atan2(feature.arcPoint[1] - feature.center[1], feature.arcPoint[0] - feature.center[0]);
  const endAngle = Math.atan2(feature.end[1] - feature.center[1], feature.end[0] - feature.center[0]);
  const sweep = arcSweepFromAngles(startAngle, endAngle, middleAngle, {
    major: typeof feature.major === 'boolean' ? feature.major : null,
    ccw: typeof feature.ccw === 'boolean' ? feature.ccw : null,
  });
  return `A ${feature.radius} ${feature.radius} 0 ${Math.abs(sweep.span) > Math.PI ? 1 : 0} ${sweep.ccw ? 1 : 0} ${feature.end[0]} ${feature.end[1]}`;
}

function contourPath(contour) {
  const first = contour.features[0];
  if (!first || !contour.closed) return '';
  if (first.kind === 'circle') {
    const [cx, cy] = first.center;
    const radius = Math.abs(first.radius);
    return `M ${cx + radius} ${cy} A ${radius} ${radius} 0 1 0 ${cx - radius} ${cy} A ${radius} ${radius} 0 1 0 ${cx + radius} ${cy} Z`;
  }
  const commands = contour.features.map((feature) => (
    feature.kind === 'arc'
      ? arcPathCommand(feature)
      : `L ${feature.end[0]} ${feature.end[1]}`
  ));
  return `M ${first.start[0]} ${first.start[1]} ${commands.join(' ')} Z`;
}

export function subtractBoundaryPath(features = [], tolerance = MIN_TOPOLOGY_TOLERANCE) {
  const contours = subtractBoundaryContours(features, tolerance);
  return {
    contours,
    closed: contours.length > 0 && contours.every((contour) => contour.closed),
    d: contours.map(contourPath).filter(Boolean).join(' '),
  };
}

export function subtractPlan(target, cutters = []) {
  const validCutters = cutters.filter(isSubtractableEntity);
  if (!validCutters.length) {
    return { targetId: target.id, cutters: [], intersects: false, materialEmpty: false, features: [], tolerance: subtractGeometryTolerance(target) };
  }
  const tolerance = subtractGeometryTolerance(target, validCutters);
  const features = subtractBoundaryFeatures(target, validCutters);
  const materialEmpty = features.length === 0;
  const intersections = materialEmpty || features.some((feature) => feature.boundaryRole === 'subtract');
  return {
    targetId: target.id,
    cutters: validCutters.map((cutter) => cutter.id),
    intersects: intersections,
    materialEmpty,
    features: intersections ? features : [],
    tolerance,
  };
}

export function subtractPlanForOwners(targetOwner, cutterOwners = []) {
  if (!targetOwner?.entity) {
    return { targetId: null, cutters: [], intersects: false, materialEmpty: false, features: [], tolerance: MIN_TOPOLOGY_TOLERANCE };
  }
  const validCutterOwners = cutterOwners.filter((owner) => isSubtractableEntity(owner?.entity));
  const cutters = validCutterOwners.map((owner) => owner.entity);
  const plan = subtractPlan(targetOwner.entity, cutters);
  if (!plan.intersects) return plan;
  const replacedCutterIds = new Set(validCutterOwners.filter((owner) => owner.boundary).map((owner) => owner.id));
  const outerFeatures = targetOwner.boundary
    ? subtractAnalyticBoundaryFeatures(
      targetOwner.entity,
      cutters,
      targetOwner.entity,
      'outer',
      targetOwner.boundary.features,
      plan.tolerance,
    )
    : plan.features.filter((feature) => feature.boundaryRole === 'outer');
  const primitiveCutFeatures = plan.features.filter((feature) => (
    feature.boundaryRole !== 'outer' && !replacedCutterIds.has(feature.sourceId)
  ));
  const analyticCutFeatures = validCutterOwners
    .filter((owner) => owner.boundary)
    .flatMap((owner) => subtractAnalyticBoundaryFeatures(
      targetOwner.entity,
      cutters,
      owner.entity,
      'subtract',
      owner.boundary.features,
      plan.tolerance,
    ));
  const features = [...outerFeatures, ...primitiveCutFeatures, ...analyticCutFeatures];
  const intersects = plan.materialEmpty || features.some((feature) => feature.boundaryRole === 'subtract');
  return { ...plan, intersects, features: intersects ? features : [] };
}

// --- Subtract Drawing Helpers ---

function entityBoundsPoints(entity) {
  if (!entity) return [];
  if (entity.type === 'line') return [entity.start, entity.end];
  if (entity.type === 'circle' && finitePoint(entity.center)) {
    const radius = Math.abs(Number(entity.radius));
    return Number.isFinite(radius) ? [
      [entity.center[0] - radius, entity.center[1] - radius],
      [entity.center[0] + radius, entity.center[1] + radius],
    ] : [];
  }
  if (entity.type === 'rect') return [
    [entity.x, entity.y],
    [entity.x + entity.width, entity.y + entity.height],
  ];
  if (['polygon', 'polyline', 'curve'].includes(entity.type)) return entity.points || [];
  if (entity.type === 'arc') {
    const radius = Math.abs(Number(entity.radius));
    if (finitePoint(entity.center) && Number.isFinite(radius)) return [
      [entity.center[0] - radius, entity.center[1] - radius],
      [entity.center[0] + radius, entity.center[1] + radius],
    ];
    return [entity.start, entity.arcPoint, entity.end];
  }
  if (['image', 'control', 'text'].includes(entity.type)) {
    const x = Number(entity.x); const y = Number(entity.y);
    const width = Number(entity.width) || 0; const height = Number(entity.height) || 0;
    return [[x, y], [x + width, y + height]];
  }
  return [];
}

function boundsForSourceIds(rawById, sourceIds = []) {
  const points = sourceIds.flatMap((id) => entityBoundsPoints(rawById.get(id))).filter(finitePoint);
  if (!points.length) return null;
  const xs = points.map((point) => Number(point[0]));
  const ys = points.map((point) => Number(point[1]));
  const x = Math.min(...xs); const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function centerPointForDefinition(definition, rawById) {
  const entity = rawById.get(definition.centerRef?.recordId);
  const index = Number(definition.centerRef?.index) || 0;
  let point = null;
  if (entity?.type === 'line') point = index === 0 ? entity.start : index === 1
    ? [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2]
    : entity.end;
  else if (entity?.type === 'circle') point = entity.center;
  else if (entity?.type === 'arc') point = [entity.start, entity.arcPoint, entity.end][index] || entity.center;
  else if (['polygon', 'polyline', 'curve'].includes(entity?.type)) point = entity.points?.[index];
  else if (['rect', 'image', 'control', 'text'].includes(entity?.type)) point = [entity.x, entity.y];
  return finitePoint(point) ? [Number(point[0]), Number(point[1])]
    : finitePoint(definition.centerPoint) ? definition.centerPoint.map(Number) : null;
}

function subtractEnabled(entity, evaluateExpression) {
  if (!entity) return false;
  if (typeof evaluateExpression !== 'function') return entity.subtract === true;
  const result = evaluateSubtractExpression(
    String(entity.subtractExpression ?? (entity.subtract ? 'TRUE' : 'FALSE')),
    evaluateExpression,
  );
  return result.error ? entity.subtract === true : result.value;
}

export function subtractDrawingOwners(drawing = {}, { evaluateExpression = null } = {}) {
  const raw = Array.isArray(drawing.entities) ? drawing.entities : [];
  const rawById = new Map(raw.filter(({ id }) => id).map((entity) => [entity.id, entity]));
  const resolvedBoundaries = resolveClosedBoundaries(raw, drawing.constraints || []);
  const owners = [];

  raw.filter(isSubtractableEntity).forEach((entity) => {
    const owner = {
      id: entity.id,
      entity: {
        ...clone(entity),
        subtract: subtractEnabled(entity, evaluateExpression),
        subtractFrom: subtractParentIds(entity),
      },
      recordIds: [entity.id],
      kind: 'primitive',
      appearanceEntity: entity,
    };
    const boundary = resolvedBoundaries.find((candidate) => candidate.id === entity.id);
    if (entity.type !== 'circle' && boundary?.features?.length) {
      owner.boundary = {
        features: boundary.features.map((feature) => clone(feature)),
        polygon: boundary.polygon.map((point) => [...point]),
      };
      owner.entity.boundaryFeatures = boundary.features.map((feature) => clone(feature));
      owner.entity.boundaryPolygon = boundary.polygon.map((point) => [...point]);
    }
    owners.push(owner);
  });

  resolvedBoundaries.filter(({ kind }) => kind === 'cycle').forEach((boundary) => {
    const boundaryEntities = boundary.recordIds.map((id) => rawById.get(id)).filter(Boolean);
    const stateEntity = boundaryEntities.find((entity) => (
      Object.prototype.hasOwnProperty.call(entity, 'subtract')
      || Object.prototype.hasOwnProperty.call(entity, 'subtractExpression')
      || Object.prototype.hasOwnProperty.call(entity, 'subtractFrom')
    )) || boundaryEntities[0];
    if (!stateEntity || boundary.polygon.length < 3) return;
    const points = boundary.polygon.map((point) => [...point]);
    const owner = {
      id: boundary.id,
      entity: {
        id: boundary.id,
        type: 'polygon',
        points,
        rawBoundaryPolygon: points.map((point) => [...point]),
        boundaryPolygon: points.map((point) => [...point]),
        boundaryFeatures: boundary.features.map((feature) => clone(feature)),
        subtract: subtractEnabled(stateEntity, evaluateExpression),
        subtractExpression: String(stateEntity.subtractExpression ?? (stateEntity.subtract ? 'TRUE' : 'FALSE')),
        subtractFrom: subtractParentIds(stateEntity),
      },
      recordIds: [...boundary.recordIds],
      kind: 'composite',
      appearanceEntity: rawById.get(boundary.appearanceSourceId) || stateEntity,
      boundary: {
        features: boundary.features.map((feature) => clone(feature)),
        polygon: points.map((point) => [...point]),
      },
    };
    owners.push(owner);
  });

  return owners;
}

function arraySubtractorOwners(drawing, owners, {
  evaluateNumeric = Number,
  evaluateLength = evaluateNumeric,
} = {}) {
  const raw = Array.isArray(drawing.entities) ? drawing.entities : [];
  const rawById = new Map(raw.filter(({ id }) => id).map((entity) => [entity.id, entity]));
  return (drawing.extensions?.arrayTools?.arrays || []).flatMap((definition) => {
    const sourceBounds = boundsForSourceIds(rawById, definition.sourceIds);
    const centerPoint = definition.arrayType === 'circular'
      ? centerPointForDefinition(definition, rawById)
      : null;
    const evaluated = evaluateArrayDefinition(definition, {
      evaluateNumeric,
      evaluateLength,
      sourceBounds,
      centerPoint,
    });
    return materializeArraySubtractOwners(definition, evaluated, owners, { centerPoint });
  });
}

function resultPoints(features) {
  return features.flatMap((feature) => sampleNotchFeature(feature));
}

export function subtractDrawingResults(drawing = {}, options = {}) {
  const owners = subtractDrawingOwners(drawing, options);
  const cutters = [
    ...owners.filter((owner) => isSubtractCutterEntity(owner.entity)),
    ...arraySubtractorOwners(drawing, owners, options),
  ];
  const results = [];
  const suppressedRecordIds = new Set(cutters.flatMap((owner) => owner.recordIds));
  owners.filter((owner) => !(owner.entity.subtract === true && !subtractParentIds(owner.entity).length)).forEach((owner) => {
    const applicableCutters = cutters.filter((cutter) => (
      cutter.id !== owner.id && subtractCutterAppliesTo(cutter.entity, owner.id)
    ));
    if (!applicableCutters.length) return;
    const plan = subtractPlanForOwners(owner, applicableCutters);
    if (!plan.intersects) return;
    owner.recordIds.forEach((id) => suppressedRecordIds.add(id));
    const boundary = subtractBoundaryPath(plan.features, plan.tolerance);
    if (plan.materialEmpty || !boundary.closed || !boundary.d) return;
    results.push({
      id: `subtract-result:${owner.id}`,
      ownerId: owner.id,
      recordIds: [...owner.recordIds],
      stackId: owner.appearanceEntity?.stackId || 'stack-default',
      appearance: clone(owner.appearanceEntity?.appearance || {}),
      d: boundary.d,
      points: resultPoints(plan.features),
      plan,
    });
  });
  return { owners: [...owners, ...cutters.filter((owner) => owner.kind === 'array-derived')], results, suppressedRecordIds };
}

// --- Subtract Tool ---

export function createSubtractTools({ toolbar, canvas }) {
  const button = toolbar?.querySelector('[data-subtract-tool]');
  let active = false;
  let parentId = null;

  function selectedParent() {
    return canvas.getSelectedSubtractParent?.() || null;
  }

  function syncAvailability() {
    const available = Boolean(selectedParent());
    if (button) button.disabled = !available && !active;
    if (active && !parentId) deactivate();
  }

  function deactivate() {
    if (!active) return;
    active = false;
    parentId = null;
    button?.classList.remove('active');
    button?.setAttribute('aria-pressed', 'false');
    canvas.setFeatureCommandDelegate(null);
    syncAvailability();
  }

  function activate() {
    const parent = selectedParent();
    if (!parent) return false;
    active = true;
    parentId = parent.id;
    button?.classList.add('active');
    button?.setAttribute('aria-pressed', 'true');
    window.dispatchEvent(new CustomEvent('paramagic:tool-activated', { detail: { source: 'subtract' } }));
    canvas.setFeatureCommandDelegate(delegate);
    return true;
  }

  function toggle() {
    if (active) deactivate();
    else activate();
  }

  const delegate = {
    pointerDown(event) {
      if (!active || event.button !== 0) return false;
      const cutter = canvas.getSubtractOwnerFromEvent?.(event);
      if (!cutter) return false;
      event.preventDefault();
      event.stopPropagation();
      const result = canvas.addSubtractRelation?.(parentId, cutter.id);
      if (result?.success) deactivate();
      return true;
    },
    pointerMove() {
      return false;
    },
    keyDown(event) {
      if (!active || event.key !== 'Escape') return false;
      event.preventDefault();
      deactivate();
      return true;
    },
  };

  button?.addEventListener('click', toggle);
  canvas.onSelectionChange?.(syncAvailability);
  window.addEventListener('paramagic:tool-activated', (event) => {
    if (event.detail?.source !== 'subtract' && active) deactivate();
  });
  syncAvailability();

  return { activate, deactivate, isActive: () => active };
}

// --- Subtract System Manager ---

export function createSubtractSystem({
  records,
  selectedIds = new Set(),
  solver,
  addSvg,
  closedRegionNodes,
  geometryAppearance,
  applyGeometryAppearance,
  fillPaint = (_entity, appearance) => appearance.fillColor,
  getScale = () => 1,
  evaluateFilletedGeometry = (entities) => entities,
  getClosedCycles = () => [],
  getResolvedBoundaries = null,
  getDerivedSubtractorOwners = () => [],
  requestHistoryCheckpoint = () => {},
  notifyObjectChange = () => {},
  syncState = () => {},
  showStatusMessage = () => {},
}) {
  let presentationDependencyRecordIds = new Set();
  const subtractResultNodes = new Map();
  const subtractPlans = new Map();

  function expressionFor(entity) {
    return String(entity?.subtractExpression ?? (entity?.subtract ? 'TRUE' : 'FALSE'));
  }

  function hasState(entity) {
    return Object.prototype.hasOwnProperty.call(entity || {}, 'subtract')
      || Object.prototype.hasOwnProperty.call(entity || {}, 'subtractExpression')
      || Object.prototype.hasOwnProperty.call(entity || {}, 'subtractFrom');
  }

  function arcSweep(feature) {
    const start = Math.atan2(feature.start[1] - feature.center[1], feature.start[0] - feature.center[0]);
    const middle = Math.atan2(feature.arcPoint[1] - feature.center[1], feature.arcPoint[0] - feature.center[0]);
    const end = Math.atan2(feature.end[1] - feature.center[1], feature.end[0] - feature.center[0]);
    const sweep = arcSweepFromAngles(start, end, middle, {
      major: typeof feature.major === 'boolean' ? feature.major : null,
      ccw: typeof feature.ccw === 'boolean' ? feature.ccw : null,
    });
    return { start, sweep: sweep.span, ccw: sweep.ccw, major: sweep.major };
  }

  function reverseBoundaryFeature(feature) {
    return {
      ...feature,
      start: feature.end ? [...feature.end] : feature.start,
      end: feature.start ? [...feature.start] : feature.end,
      ...(feature.kind === 'arc' ? { arcPoint: [...feature.arcPoint] } : {}),
    };
  }

  function boundaryFeatureForEntity(entity, owner) {
    if (!entity || !['line', 'arc'].includes(entity.type)) return null;
    const sourceRecord = records.find((record) => record.id === entity.id && record.recordType === 'geometry');
    const sourceFeatureIndex = entity.type === 'line'
      ? Number(entity.composite?.index ?? 0)
      : 0;
    const base = {
      recordId: owner.recordIds[0],
      targetId: owner.id,
      sourceId: entity.id,
      entityType: entity.type,
      kind: entity.type === 'line' ? 'segment' : 'arc',
      index: sourceFeatureIndex,
      sourceFeatureIndex,
      boundaryRole: 'outer',
    };
    if (entity.type === 'line') {
      return {
        ...base,
        start: [...entity.start],
        end: [...entity.end],
        rawStart: sourceRecord?.entity?.start ? [...sourceRecord.entity.start] : [...entity.start],
        rawEnd: sourceRecord?.entity?.end ? [...sourceRecord.entity.end] : [...entity.end],
        parameterStart: 0,
        parameterEnd: 1,
        stableKey: `${owner.id}:${entity.id}:outer:${sourceFeatureIndex}`,
      };
    }
    const { start, sweep, ccw, major } = arcSweep(entity);
    return {
      ...base,
      center: [...entity.center],
      radius: Math.abs(entity.radius),
      start: [...entity.start],
      arcPoint: [...entity.arcPoint],
      end: [...entity.end],
      ccw,
      major,
      parameterStart: normalizeAngle(start) / TAU,
      parameterEnd: normalizeAngle(start + sweep) / TAU,
      stableKey: `${owner.id}:${entity.id}:outer:arc`,
    };
  }

  function boundaryPolygon(features) {
    const points = [];
    features.forEach((feature, index) => {
      const sampled = sampleNotchFeature(feature);
      if (!sampled.length) return;
      points.push(...(index ? sampled.slice(1) : sampled));
    });
    if (points.length > 1 && distance(points[0], points.at(-1)) <= EPSILON) points.pop();
    return points;
  }

  function filletedBoundaryForOwner(owner) {
    const resolved = typeof getResolvedBoundaries === 'function'
      ? getResolvedBoundaries().find((boundary) => (
        boundary.id === owner.id
        || owner.recordIds.every((recordId) => boundary.recordIds.includes(recordId))
      ))
      : null;
    if (resolved?.polygon?.length >= 3) {
      return {
        features: resolved.features.map((feature) => ({
          ...feature,
          recordId: owner.recordIds[0],
          targetId: owner.id,
        })),
        polygon: resolved.polygon.map((point) => [...point]),
      };
    }
    const drawable = records
      .filter((record) => record.recordType === 'geometry' || record.recordType === 'fillet')
      .map((record) => record.entity);
    const evaluated = evaluateFilletedGeometry(drawable);
    const byId = new Map(evaluated.map((entity) => [entity.id, entity]));
    const cycle = getClosedCycles().find((candidate) => owner.recordIds.every((id) => (
      candidate.some(({ entityId }) => entityId === id)
    )));
    if (!cycle) return null;
    const features = cycle
      .map(({ entityId, reversed }) => {
        const feature = boundaryFeatureForEntity(byId.get(entityId), owner);
        return feature && reversed ? reverseBoundaryFeature(feature) : feature;
      })
      .filter(Boolean);
    const polygon = boundaryPolygon(features);
    return polygon.length >= 3 ? { features, polygon } : null;
  }

  function compositeRecordsFor(record) {
    const composite = record?.entity?.composite;
    if (!composite?.closed || !composite.id) return [];
    const group = records
      .filter((candidate) => (
        candidate.recordType === 'geometry'
        && candidate.entity.composite?.closed === true
        && candidate.entity.composite.id === composite.id
        && !candidate.entity.construction
      ))
      .sort((a, b) => Number(a.entity.composite.index) - Number(b.entity.composite.index));
    const count = Number(composite.count);
    if (!Number.isInteger(count) || count < 3 || group.length !== count) return [];
    if (!group.every((candidate) => candidate.entity.type === 'line')) return [];
    return group;
  }

  function resolvedBoundaries() {
    if (typeof getResolvedBoundaries === 'function') return getResolvedBoundaries();
    const drawable = records
      .filter((record) => record.recordType === 'geometry' || record.recordType === 'fillet')
      .map((record) => record.entity);
    return resolveClosedBoundaries(drawable, solver.constraints?.() || []);
  }

  function resolvedCycleOwnerForRecord(recordId, boundaries = resolvedBoundaries()) {
    const boundary = boundaries.find((candidate) => (
      candidate.kind === 'cycle' && candidate.recordIds.includes(recordId)
    ));
    if (!boundary?.polygon?.length || boundary.polygon.length < 3) return null;
    const boundaryRecords = boundary.recordIds
      .map((id) => records.find((record) => record.id === id && record.recordType === 'geometry'))
      .filter(Boolean);
    const stateRecord = boundaryRecords.find((candidate) => hasState(candidate.entity));
    const appearanceRecord = records.find((candidate) => candidate.id === boundary.appearanceSourceId)
      || stateRecord
      || boundaryRecords[0];
    if (!appearanceRecord) return null;
    const points = boundary.polygon.map((point) => [...point]);
    return {
      id: boundary.id,
      entity: {
        id: boundary.id,
        type: 'polygon',
        points,
        rawBoundaryPolygon: points.map((point) => [...point]),
        boundaryPolygon: points.map((point) => [...point]),
        boundaryFeatures: boundary.features.map((feature) => ({ ...feature })),
        subtract: stateRecord?.entity.subtract === true,
        subtractExpression: stateRecord ? expressionFor(stateRecord.entity) : 'FALSE',
        subtractFrom: stateRecord ? subtractParentIds(stateRecord.entity) : [],
      },
      recordIds: [...boundary.recordIds],
      kind: 'composite',
      appearanceEntity: appearanceRecord.entity,
      boundary: {
        features: boundary.features.map((feature) => ({
          ...feature,
          targetId: boundary.id,
        })),
        polygon: points.map((point) => [...point]),
      },
    };
  }

  function ownerForRecord(recordId, boundaries = null) {
    const record = records.find((candidate) => candidate.id === recordId && candidate.recordType === 'geometry');
    if (!record) return null;
    const currentBoundaries = boundaries || resolvedBoundaries();
    if (isSubtractableEntity(record.entity)) {
      const owner = { id: record.id, entity: record.entity, recordIds: [record.id], kind: 'primitive' };
      const boundary = record.entity.type === 'circle'
        ? null
        : currentBoundaries.find((candidate) => candidate.id === record.id);
      if (boundary?.features?.length) {
        owner.boundary = {
          features: boundary.features.map((feature) => ({ ...feature })),
          polygon: boundary.polygon.map((point) => [...point]),
        };
      }
      return owner;
    }
    const resolvedOwner = resolvedCycleOwnerForRecord(recordId, currentBoundaries);
    if (resolvedOwner) return resolvedOwner;
    const group = compositeRecordsFor(record);
    if (!group.length) return null;
    const first = group[0].entity;
    const owner = {
      id: first.composite.id,
      entity: {
        id: first.composite.id,
        type: 'polygon',
        points: group.map((candidate) => [...candidate.entity.start]),
        rawBoundaryPolygon: group.map((candidate) => [...candidate.entity.start]),
        ...(hasState(first) ? {
          subtract: first.subtract === true,
          subtractExpression: expressionFor(first),
          subtractFrom: subtractParentIds(first),
        } : {}),
      },
      recordIds: group.map((candidate) => candidate.id),
      kind: 'composite',
    };
    const boundary = filletedBoundaryForOwner(owner);
    if (boundary) {
      owner.boundary = boundary;
      owner.entity.boundaryPolygon = boundary.polygon;
    }
    return owner;
  }

  function owners() {
    const result = new Map();
    const boundaries = resolvedBoundaries();
    records.filter((record) => record.recordType === 'geometry').forEach((record) => {
      const owner = ownerForRecord(record.id, boundaries);
      if (owner && !result.has(owner.id)) result.set(owner.id, owner);
    });
    return [...result.values()];
  }

  function refreshState() {
    owners().forEach((owner) => {
      const stateRecord = owner.recordIds
        .map((id) => records.find((record) => record.id === id))
        .find((record) => hasState(record?.entity));
      if (!stateRecord) {
        owner.recordIds.forEach((id) => {
          const record = records.find((candidate) => candidate.id === id);
          if (record) record.subtractError = null;
        });
        return;
      }
      const parents = subtractParentIds(stateRecord.entity);
      const result = evaluateSubtractExpression(
        expressionFor(stateRecord.entity),
        (expression) => solver.evaluateParameterExpression(expression),
      );
      owner.recordIds.forEach((id) => {
        const record = records.find((candidate) => candidate.id === id);
        if (!record) return;
        record.entity.subtract = result.value;
        record.entity.subtractExpression = expressionFor(stateRecord.entity);
        if (parents.length || Object.prototype.hasOwnProperty.call(stateRecord.entity, 'subtractFrom')) {
          record.entity.subtractFrom = [...parents];
        }
        record.subtractError = result.error;
      });
    });
  }

  function targetOwners() {
    return owners().filter((owner) => (
      owner.entity.subtract !== true || subtractParentIds(owner.entity).length > 0
    ));
  }

  function activeSubtractorOwners(excludeId = null, parentId = null) {
    const baseOwners = owners();
    const derivedOwners = typeof getDerivedSubtractorOwners === 'function'
      ? getDerivedSubtractorOwners(baseOwners)
      : [];
    const unique = new Map([...baseOwners, ...(Array.isArray(derivedOwners) ? derivedOwners : [])]
      .filter((owner) => owner?.id && isSubtractCutterEntity(owner?.entity))
      .map((owner) => [owner.id, owner]));
    return [...unique.values()].filter((owner) => (
      owner.id !== excludeId
      && (!parentId || subtractCutterAppliesTo(owner.entity, parentId))
    ));
  }

  function activeSubtractors(excludeId = null, parentId = null) {
    return activeSubtractorOwners(excludeId, parentId).map((owner) => owner.entity);
  }

  function planForOwner(owner, cutters = activeSubtractors(owner.id, owner.id)) {
    const requestedIds = new Set(cutters.map((cutter) => cutter.id));
    const cutterOwners = activeSubtractorOwners(owner.id, owner.id)
      .filter((cutter) => requestedIds.has(cutter.id));
    return subtractPlanForOwners(owner, cutterOwners);
  }

  function featuresForRecord(recordId) {
    const owner = ownerForRecord(recordId);
    if (!owner) return [];
    const cutters = activeSubtractors(owner.id, owner.id);
    if (!cutters.length) return [];
    const plan = planForOwner(owner, cutters);
    if (!plan.intersects) return [];
    return plan.features.map((feature) => ({ ...feature, recordId }));
  }

  function featuresForHost(host) {
    const features = featuresForRecord(host?.recordId);
    if (features.length) return features;
    const subtractor = ownerForRecord(host?.recordId);
    if (!subtractor || !isSubtractCutterEntity(subtractor.entity)) return [];
    return targetOwners()
      .filter((target) => subtractCutterAppliesTo(subtractor.entity, target.id))
      .flatMap((target) => featuresForRecord(target.recordIds[0]))
      .filter((feature) => feature.sourceId === subtractor.id);
  }

  function pointOnFeature(point, feature) {
    const projection = projectPointToNotchFeature(point, feature);
    if (projection) return { point: projection.point, distance: projection.distance };
    return null;
  }

  function featureForHost(host, context = null) {
    if (!host?.recordId) return null;
    const features = featuresForHost(host);
    if (!features.length) return null;
    if (host.stableKey) {
      const exact = features.find((feature) => feature.stableKey === host.stableKey);
      if (exact) return exact;
    }
    const sourceMatch = features.filter((feature) => (
      (!host.sourceId || feature.sourceId === host.sourceId || feature.targetId === host.sourceId)
      && (host.sourceFeatureIndex === undefined || feature.sourceFeatureIndex === host.sourceFeatureIndex)
    ));
    const candidates = sourceMatch.length ? sourceMatch : features;
    const contextParameter = Number(context?.parameter);
    const sourceParameter = Number.isFinite(Number(host.sourceParameter))
      ? Number(host.sourceParameter)
      : Number.isFinite(contextParameter) && ['circle', 'arc'].includes(host.kind)
        ? (((contextParameter % TAU) + TAU) % TAU) / TAU
        : contextParameter;
    if (Number.isFinite(sourceParameter)) {
      const containing = candidates.filter((feature) => (
        Number.isFinite(Number(feature.parameterStart))
        && Number.isFinite(Number(feature.parameterEnd))
        && sourceParameter >= Math.min(feature.parameterStart, feature.parameterEnd) - 1e-7
        && sourceParameter <= Math.max(feature.parameterStart, feature.parameterEnd) + 1e-7
      ));
      if (containing.length) {
        return containing.reduce((best, feature) => {
          const midpoint = (Number(feature.parameterStart) + Number(feature.parameterEnd)) / 2;
          return !best || Math.abs(sourceParameter - midpoint) < best.distance
            ? { feature, distance: Math.abs(sourceParameter - midpoint) }
            : best;
        }, null)?.feature || null;
      }
    }
    const referencePoint = host.referencePoint || context?.point;
    if (referencePoint) {
      return candidates.reduce((best, feature) => {
        const projection = pointOnFeature(referencePoint, feature);
        return projection && (!best || projection.distance < best.distance) ? { feature, ...projection } : best;
      }, null)?.feature || null;
    }
    return candidates[0] || null;
  }

  function inwardTargetForFeature(feature, boundaryPoint, tangent) {
    if (feature?.boundaryRole !== 'subtract') return null;
    const targetOwner = owners().find((owner) => owner.id === feature.targetId)
      || ownerForRecord(feature.recordId);
    if (!targetOwner) return null;
    return subtractMaterialTarget(
      boundaryPoint,
      tangent,
      targetOwner.entity,
      activeSubtractors(targetOwner.id, targetOwner.id),
    );
  }

  function featureFromWorld(world, preferredRecordId = null) {
    const preferredOwnerId = ownerForRecord(preferredRecordId)?.id;
    const candidates = targetOwners().flatMap((owner) => featuresForRecord(owner.recordIds[0]));
    const preferred = candidates.filter((feature) => feature.targetId === preferredOwnerId);
    const ordered = preferred.length ? [...preferred, ...candidates.filter((feature) => feature.recordId !== preferredRecordId)] : candidates;
    const nearest = ordered.reduce((best, feature) => {
      const projection = pointOnFeature(world, feature);
      return projection && (!best || projection.distance < best.distance)
        ? { feature, ...projection }
        : best;
    }, null);
    return nearest && nearest.distance <= 14 / getScale()
      ? { ...nearest.feature, pickedPoint: nearest.point }
      : null;
  }

  function clearMasks() {
    subtractResultNodes.forEach((node) => node.remove());
    subtractResultNodes.clear();
    subtractPlans.clear();
    records.filter((record) => record.recordType === 'geometry').forEach((record) => {
      record.node?.removeAttribute('mask');
      record.group?.classList.remove('subtract-source-record');
    });
    closedRegionNodes.forEach((region) => {
      region.removeAttribute('mask');
      region.classList.remove('subtract-source-region');
    });
  }

  function markSourceOwner(owner) {
    owner.recordIds.forEach((recordId) => {
      records.find((record) => record.id === recordId)?.group?.classList.add('subtract-source-record');
    });
  }

  function createResultPresentation(owner, plan) {
    if (!plan?.intersects || plan.materialEmpty) return null;
    const result = subtractBoundaryPath(plan.features, plan.tolerance);
    if (!result.closed || !result.d) return null;
    const source = records.find((record) => record.id === owner.recordIds[0]);
    if (!source?.group) return null;
    const appearance = geometryAppearance(source.entity);
    const paint = fillPaint(source.entity, appearance);
    const node = addSvg(source.group, 'path', {
      d: result.d,
      class: 'subtract-result-boundary',
      'data-subtract-result': owner.id,
      fill: paint,
      'fill-rule': 'evenodd',
      'fill-opacity': appearance.fillOpacity,
      stroke: appearance.strokeColor || '#000000',
      'stroke-width': appearance.strokeThickness,
      'stroke-opacity': appearance.strokeOpacity,
      'vector-effect': 'non-scaling-stroke',
      'pointer-events': 'none',
    });
    if (!node) return null;
    source.group.insertBefore(node, source.group.firstChild);
    subtractResultNodes.set(owner.id, node);
    return node;
  }

  function applySourcePresentation(record) {
    if (!record?.group?.classList.contains('subtract-source-record') || !record.node) return;
    record.node.setAttribute('fill', 'transparent');
    record.node.setAttribute('fill-opacity', 0);
    record.node.style?.setProperty?.('fill', 'transparent', 'important');
    if (record.node.style) record.node.style.fillOpacity = '0';
  }

  function applyRegionPresentation() {
    closedRegionNodes.forEach((region) => {
      const parentIds = String(region.dataset.parentIds || '').split(',').filter(Boolean);
      if (!parentIds.length) return;
      const owner = ownerForRecord(parentIds[0]);
      const ownerBoundaryIds = new Set([
        ...(owner?.recordIds || []),
        ...(owner?.boundary?.features || []).map((feature) => feature.sourceId).filter(Boolean),
      ]);
      if (!owner || owner.kind !== 'composite' || !parentIds.every((id) => ownerBoundaryIds.has(id))) return;
      const source = records.find((record) => record.id === parentIds[0]);
      const appearance = geometryAppearance(source?.entity || {});
      const paint = fillPaint(source?.entity || {}, appearance);
      const plan = subtractPlans.get(owner.id);
      const cutterOwnsPresentation = isSubtractCutterEntity(owner.entity);
      const suppressFill = cutterOwnsPresentation || plan?.materialEmpty === true;
      const resultOwnsPresentation = plan?.intersects === true;
      region.classList.toggle('subtract-source-region', resultOwnsPresentation || cutterOwnsPresentation);
      if (region.classList.contains('closed-region-hit')) {
        region.setAttribute('fill', 'transparent');
        region.setAttribute('fill-opacity', 0);
        region.style.setProperty('--region-fill', paint);
        region.removeAttribute('mask');
        return;
      }
      region.setAttribute('fill', suppressFill || resultOwnsPresentation ? 'transparent' : paint);
      region.setAttribute('fill-opacity', suppressFill || resultOwnsPresentation ? 0 : appearance.fillOpacity);
      region.style.setProperty('--region-fill', paint);
      region.removeAttribute('mask');
    });
  }

  function refreshPresentation({ changedRecordIds = null } = {}) {
    if (!subtractPresentationDependsOn(presentationDependencyRecordIds, changedRecordIds)) return false;
    refreshState();
    clearMasks();
    activeSubtractorOwners().forEach(markSourceOwner);
    targetOwners().forEach((owner) => {
      const cutters = activeSubtractors(owner.id, owner.id);
      if (!cutters.length) return;
      const plan = planForOwner(owner, cutters);
      subtractPlans.set(owner.id, plan);
      if (!plan.intersects) return;
      markSourceOwner(owner);
      createResultPresentation(owner, plan);
    });
    records.filter((record) => record.recordType === 'geometry').forEach(applyGeometryAppearance);
    records.filter((record) => record.recordType === 'geometry').forEach(applySourcePresentation);
    applyRegionPresentation();
    const currentOwners = owners();
    const baseCutters = currentOwners.filter((owner) => isSubtractCutterEntity(owner.entity));
    const derivedCutters = typeof getDerivedSubtractorOwners === 'function'
      ? getDerivedSubtractorOwners(currentOwners).filter((owner) => isSubtractCutterEntity(owner?.entity))
      : [];
    const cutters = [...baseCutters, ...derivedCutters];
    presentationDependencyRecordIds = new Set();
    currentOwners.forEach((owner) => {
      const applicable = cutters.filter((cutter) => (
        cutter.id !== owner.id && subtractCutterAppliesTo(cutter.entity, owner.id)
      ));
      if (!applicable.length) return;
      owner.recordIds.forEach((recordId) => presentationDependencyRecordIds.add(recordId));
      applicable.forEach((cutter) => (
        (cutter.recordIds || []).forEach((recordId) => presentationDependencyRecordIds.add(recordId))
      ));
    });
    return true;
  }

  function selectedParentOwner() {
    if (!selectedIds.size) return null;
    return owners().find((owner) => (
      owner.recordIds.length === selectedIds.size
      && owner.recordIds.every((recordId) => selectedIds.has(recordId))
    )) || null;
  }

  function ownerFromEvent(event) {
    const target = event?.paramagicSelectionTarget || event?.target;
    const region = target?.closest?.('.closed-constrained-region');
    if (region?.dataset?.boundaryId) {
      const exact = owners().find((owner) => owner.id === region.dataset.boundaryId);
      if (exact) return exact;
    }
    const recordId = target?.closest?.('.canvas-record, .canvas-handle-group')?.dataset?.recordId;
    return recordId ? ownerForRecord(recordId) : null;
  }

  function updateOwnerParents(owner, parentIds) {
    const normalized = [...new Set(parentIds.map((value) => String(value || '').trim()).filter(Boolean))];
    owner.recordIds.forEach((recordId) => {
      const record = records.find((candidate) => candidate.id === recordId && candidate.recordType === 'geometry');
      if (!record) return;
      const updated = solver.updateEntity({
        ...record.entity,
        subtract: false,
        subtractExpression: 'FALSE',
        subtractFrom: normalized,
      });
      record.entity = clone(updated || {
        ...record.entity,
        subtract: false,
        subtractExpression: 'FALSE',
        subtractFrom: normalized,
      });
      record.subtractError = null;
    });
  }

  function addSubtractRelation(parentId, cutterId) {
    const currentOwners = owners();
    const parent = currentOwners.find((owner) => owner.id === parentId);
    const cutter = currentOwners.find((owner) => owner.id === cutterId);
    if (!parent || !cutter) {
      const error = 'Select a closed region to subtract.';
      showStatusMessage(error);
      return { success: false, error };
    }
    if (parent.id === cutter.id) {
      const error = 'A region cannot be subtracted from itself.';
      showStatusMessage(error);
      return { success: false, error };
    }
    const parents = subtractParentIds(cutter.entity);
    if (parents.includes(parent.id)) {
      return { success: true, changed: false, parentId: parent.id, cutterId: cutter.id };
    }
    requestHistoryCheckpoint('subtract-parent-add');
    updateOwnerParents(cutter, [...parents, parent.id]);
    refreshPresentation();
    syncState();
    notifyObjectChange({ history: 'commit' });
    return { success: true, changed: true, parentId: parent.id, cutterId: cutter.id };
  }

  function isCutterRecord(recordId) {
    const owner = ownerForRecord(recordId);
    return Boolean(owner && isSubtractCutterEntity(owner.entity));
  }

  return {
    expressionFor,
    evaluateExpression: (expression) => evaluateSubtractExpression(expression, (value) => solver.evaluateParameterExpression(value)),
    ownerForRecord,
    owners,
    targetOwners,
    activeSubtractors,
    activeSubtractorOwners,
    selectedParentOwner,
    ownerFromEvent,
    addSubtractRelation,
    isCutterRecord,
    featuresForRecord,
    featuresForHost,
    featureForHost,
    inwardTargetForFeature,
    featureFromWorld,
    planFor: (recordId) => {
      const owner = ownerForRecord(recordId);
      return subtractPlans.get(owner?.id || recordId) || null;
    },
    applyRegionPresentation,
    refreshState,
    refreshPresentation,
    clearMasks,
  };
}
