import { formatUnitlessValue } from './solver/Units.js';
import { rememberRepeatableTool } from './CanvasUIControls.js';
import { CANVAS_ORIGIN_RECORD_ID } from './CanvasOrigin.js';
import { ARC_MIDPOINT_ROLE, arcSweepFromAngles } from './ArcGeometry.js';

// --- Dimension Feature Geometry ---
const pointDistanceMath = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function distanceToSegmentMath(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx ** 2 + dy ** 2;
  if (!lengthSquared) return pointDistanceMath(point, start);
  const ratio = Math.max(0, Math.min(1, (
    (point[0] - start[0]) * dx + (point[1] - start[1]) * dy
  ) / lengthSquared));
  return pointDistanceMath(point, [start[0] + dx * ratio, start[1] + dy * ratio]);
}

function normalizeAngleMath(angle) {
  const tau = Math.PI * 2;
  return (angle + tau) % tau;
}

function arcAnglesMath(feature) {
  const startAngle = Math.atan2(feature.start[1] - feature.center[1], feature.start[0] - feature.center[0]);
  const midAngle = Math.atan2(feature.arcPoint[1] - feature.center[1], feature.arcPoint[0] - feature.center[0]);
  const endAngle = Math.atan2(feature.end[1] - feature.center[1], feature.end[0] - feature.center[0]);
  const sweep = arcSweepFromAngles(startAngle, endAngle, midAngle, {
    major: typeof feature.major === 'boolean' ? feature.major : null,
    ccw: typeof feature.ccw === 'boolean' ? feature.ccw : null,
  });
  return {
    startAngle,
    span: sweep.span,
  };
}

function angleOnArcMath(feature, angle) {
  const { startAngle, span } = arcAnglesMath(feature);
  const relative = span >= 0
    ? normalizeAngleMath(angle - startAngle)
    : normalizeAngleMath(startAngle - angle);
  return relative <= Math.abs(span) + 1e-7;
}

function curveControlPointMath(current, previous, next, tension = 0.18) {
  return [
    current[0] + (next[0] - previous[0]) * tension,
    current[1] + (next[1] - previous[1]) * tension,
  ];
}

function cubicPointMath(a, b, c, d, ratio) {
  const inverse = 1 - ratio;
  return [
    inverse ** 3 * a[0] + 3 * inverse ** 2 * ratio * b[0] + 3 * inverse * ratio ** 2 * c[0] + ratio ** 3 * d[0],
    inverse ** 3 * a[1] + 3 * inverse ** 2 * ratio * b[1] + 3 * inverse * ratio ** 2 * c[1] + ratio ** 3 * d[1],
  ];
}

function curveDistanceMath(feature, point, samplesPerSegment = 24) {
  const points = feature.points || [];
  if (points.length < 2) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (let segment = 0; segment < points.length - 1; segment += 1) {
    const start = points[segment];
    const end = points[segment + 1];
    const previous = points[Math.max(0, segment - 1)];
    const after = points[Math.min(points.length - 1, segment + 2)];
    const firstControl = curveControlPointMath(start, previous, end);
    const secondControl = curveControlPointMath(end, after, start);
    let prior = start;
    for (let sample = 1; sample <= samplesPerSegment; sample += 1) {
      const current = cubicPointMath(start, firstControl, secondControl, end, sample / samplesPerSegment);
      best = Math.min(best, distanceToSegmentMath(point, prior, current));
      prior = current;
    }
  }
  return best;
}

export function featureLength(feature) {
  if (!feature) return 0;
  if (feature.kind === 'segment') return pointDistanceMath(feature.start, feature.end);
  if (feature.kind === 'circle') return Math.PI * 2 * feature.radius;
  if (feature.kind === 'arc') return Math.abs(arcAnglesMath(feature).span) * feature.radius;
  if (feature.kind === 'curve') {
    return feature.points.slice(1).reduce((total, point, index) => total + pointDistanceMath(feature.points[index], point), 0);
  }
  return 0;
}

export function featureTargetPoint(feature) {
  if (!feature) return null;
  if (feature.kind === 'segment') return [(feature.start[0] + feature.end[0]) / 2, (feature.start[1] + feature.end[1]) / 2];
  if (feature.kind === 'curve') return feature.points[Math.floor(feature.points.length / 2)];
  if (feature.kind === 'arc') {
    const { startAngle, span } = arcAnglesMath(feature);
    const angle = startAngle + span / 2;
    return [feature.center[0] + Math.cos(angle) * feature.radius, feature.center[1] + Math.sin(angle) * feature.radius];
  }
  if (feature.kind === 'circle') return [feature.center[0] + feature.radius, feature.center[1]];
  return null;
}

export function dimensionFeatureDistance(feature, point) {
  if (!feature || !point) return Number.POSITIVE_INFINITY;
  if (feature.kind === 'point') return pointDistanceMath(feature.point, point);
  if (feature.kind === 'segment') return distanceToSegmentMath(point, feature.start, feature.end);
  if (feature.kind === 'circle') return Math.abs(pointDistanceMath(point, feature.center) - feature.radius);
  if (feature.kind === 'arc') {
    const angle = Math.atan2(point[1] - feature.center[1], point[0] - feature.center[0]);
    if (angleOnArcMath(feature, angle)) return Math.abs(pointDistanceMath(point, feature.center) - feature.radius);
    return Math.min(pointDistanceMath(point, feature.start), pointDistanceMath(point, feature.end));
  }
  if (feature.kind === 'curve') return curveDistanceMath(feature, point);
  return Number.POSITIVE_INFINITY;
}

export function transformDimensionFeature(feature, transformPoint, recordId = feature?.recordId, node = feature?.node) {
  if (!feature || typeof transformPoint !== 'function') return null;
  const transformed = { ...feature, recordId, node };
  if (feature.kind === 'point') transformed.point = transformPoint(feature.point);
  if (feature.kind === 'segment') {
    transformed.start = transformPoint(feature.start);
    transformed.end = transformPoint(feature.end);
  }
  if (feature.kind === 'circle') transformed.center = transformPoint(feature.center);
  if (feature.kind === 'arc') {
    transformed.center = transformPoint(feature.center);
    transformed.start = transformPoint(feature.start);
    transformed.arcPoint = transformPoint(feature.arcPoint);
    transformed.end = transformPoint(feature.end);
  }
  if (feature.kind === 'curve') transformed.points = feature.points.map(transformPoint);
  return transformed;
}

export function transformDimensionFeatureSet(featureSet, transformPoint, recordId, node = null) {
  if (!featureSet || typeof transformPoint !== 'function') return null;
  return {
    ...featureSet,
    recordId,
    controlPoints: (featureSet.controlPoints || []).map(transformPoint),
    features: (featureSet.features || [])
      .map((feature) => transformDimensionFeature(feature, transformPoint, recordId, node))
      .filter(Boolean),
  };
}

export function resolveDimensionFeatureSet(featureSet, request = {}) {
  if (!featureSet) return null;
  if (request.kind) {
    return featureSet.features?.find((feature) => (
      feature.kind === request.kind
      && (request.index === undefined || feature.index === request.index)
    )) || null;
  }
  const entityFeature = featureSet.features?.find((feature) => ['circle', 'arc', 'curve'].includes(feature.kind));
  return {
    ...(entityFeature || {}),
    recordId: featureSet.recordId,
    entityType: featureSet.entityType,
    controlPoints: (featureSet.controlPoints || []).map((point) => [...point]),
  };
}

export function nearestDimensionFeature(featureSets, point, { pointTolerance = 0 } = {}) {
  const features = (featureSets || []).flatMap((featureSet) => featureSet?.features || []);
  const nearest = (candidates) => candidates.reduce((best, feature) => {
    const distance = dimensionFeatureDistance(feature, point);
    return !best || distance < best.distance ? { feature, distance } : best;
  }, null);
  const nearestPoint = nearest(features.filter(({ kind }) => kind === 'point'));
  if (nearestPoint && nearestPoint.distance <= pointTolerance) return nearestPoint.feature;
  return nearest(features.filter(({ kind }) => kind !== 'point'))?.feature || null;
}

// --- Dimension Tools & Layout ---
export const dimensionTools = ['Driving Dimension', 'Driven Dimension'];

function midpoint(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function addPoints(a, b) {
  return [a[0] + b[0], a[1] + b[1]];
}

function subtractPoints(a, b) {
  return [a[0] - b[0], a[1] - b[1]];
}

function scalePoint(point, scale) {
  return [point[0] * scale, point[1] * scale];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1];
}

function pointLength(point) {
  return Math.hypot(point[0], point[1]);
}

function unitVector(point, fallback = [1, 0]) {
  const length = pointLength(point);
  return length > 0.0001 ? [point[0] / length, point[1] / length] : fallback;
}

function lineIntersection(a, b) {
  const r = subtractPoints(a.end, a.start);
  const s = subtractPoints(b.end, b.start);
  const denominator = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(denominator) < 0.0001) return null;
  const delta = subtractPoints(b.start, a.start);
  const t = (delta[0] * s[1] - delta[1] * s[0]) / denominator;
  return addPoints(a.start, scalePoint(r, t));
}

function distanceToSegment(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return pointLength(subtractPoints(point, start));
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared));
  const projection = [start[0] + dx * t, start[1] + dy * t];
  return pointLength(subtractPoints(point, projection));
}

function perpendicular(point) {
  return [-point[1], point[0]];
}

function readableAngleDegrees(vector) {
  let angle = Math.atan2(vector[1], vector[0]) * 180 / Math.PI;
  if (angle > 90) angle -= 180;
  if (angle < -90) angle += 180;
  return angle;
}

function normalizeAngle(angle) {
  const tau = Math.PI * 2;
  return (angle + tau) % tau;
}

function angleDistance(a, b) {
  const difference = Math.abs(normalizeAngle(a) - normalizeAngle(b));
  return Math.min(difference, Math.PI * 2 - difference);
}

function arrowPath(tip, direction, scale, size = 12 / scale) {
  const axis = unitVector(direction);
  const wing = perpendicular(axis);
  const base = addPoints(tip, scalePoint(axis, size));
  const halfWidth = size * 0.42;
  const a = addPoints(base, scalePoint(wing, halfWidth));
  const b = addPoints(base, scalePoint(wing, -halfWidth));
  return `M ${tip[0]} ${tip[1]} L ${a[0]} ${a[1]} L ${b[0]} ${b[1]} Z`;
}

export function distanceDimensionLayout(entity, scale) {
  const measureStart = entity.measureStart || entity.start;
  const measureEnd = entity.measureEnd || entity.end;
  let dimensionBaseStart = entity.anchors?.start ? (entity.start || measureStart) : measureStart;
  let dimensionBaseEnd = entity.anchors?.end ? (entity.end || measureEnd) : measureEnd;
  if (entity.subtype === 'horizontal') {
    dimensionBaseStart = [measureStart[0], measureStart[1]];
    dimensionBaseEnd = [measureEnd[0], measureStart[1]];
  }
  if (entity.subtype === 'vertical') {
    dimensionBaseStart = [measureStart[0], measureStart[1]];
    dimensionBaseEnd = [measureStart[0], measureEnd[1]];
  }
  const measured = subtractPoints(dimensionBaseEnd, dimensionBaseStart);
  const axis = unitVector(measured);
  const normal = perpendicular(axis);
  const measuredMid = midpoint(dimensionBaseStart, dimensionBaseEnd);
  let offset = dot(subtractPoints(entity.label, measuredMid), normal);
  if (Math.abs(offset) < 14 / scale) offset = offset < 0 ? -28 / scale : 28 / scale;
  const side = offset < 0 ? -1 : 1;
  const offsetVector = scalePoint(normal, offset);
  const extensionGap = 6 / scale;
  const extensionOvershoot = 10 / scale;
  const dimensionStart = addPoints(dimensionBaseStart, offsetVector);
  const dimensionEnd = addPoints(dimensionBaseEnd, offsetVector);
  const dimensionMid = midpoint(dimensionStart, dimensionEnd);
  const textPoint = addPoints(dimensionMid, scalePoint(normal, side * 14 / scale));
  return {
    dimensionStart,
    dimensionEnd,
    dimensionMid,
    textPoint,
    angle: readableAngleDegrees(axis),
    extensionA: {
      start: addPoints(measureStart, scalePoint(normal, extensionGap * side)),
      end: addPoints(dimensionStart, scalePoint(normal, extensionOvershoot * side)),
    },
    extensionB: {
      start: addPoints(measureEnd, scalePoint(normal, extensionGap * side)),
      end: addPoints(dimensionEnd, scalePoint(normal, extensionOvershoot * side)),
    },
    arrowA: arrowPath(dimensionStart, axis, scale),
    arrowB: arrowPath(dimensionEnd, scalePoint(axis, -1), scale),
  };
}

export function radiusDimensionLayout(entity, scale) {
  const center = entity.center;
  const elbow = entity.elbow || entity.label || addPoints(center, [-72, -48]);
  const radius = entity.radius || pointLength(subtractPoints(entity.target || center, center)) || 72;
  const radialDirection = unitVector(subtractPoints(elbow, center), [1, 0]);
  const target = addPoints(center, scalePoint(radialDirection, radius));
  const oppositeTarget = addPoints(center, scalePoint(radialDirection, -radius));
  const diameter = entity.subtype === 'diameter';
  const textSide = elbow[0] >= center[0] ? 1 : -1;
  const landingLength = 32 / scale;
  const landingEnd = addPoints(elbow, [landingLength * textSide, 0]);
  const label = [...landingEnd];
  // The arrow tip is on the circle, so its body must extend along the
  // target-to-elbow portion of the leader.  Using the center-to-elbow ray
  // fails when the elbow is inside the radius or crosses the center.
  const leaderDirection = unitVector(subtractPoints(elbow, target), radialDirection);
  const arrowA = arrowPath(
    target,
    diameter ? scalePoint(radialDirection, -1) : leaderDirection,
    scale,
  );
  const arrowB = diameter ? arrowPath(oppositeTarget, radialDirection, scale) : '';
  return {
    center,
    target,
    oppositeTarget,
    elbow,
    landingEnd,
    label,
    leaderPath: diameter
      ? `M ${oppositeTarget[0]} ${oppositeTarget[1]} L ${target[0]} ${target[1]} L ${elbow[0]} ${elbow[1]} L ${landingEnd[0]} ${landingEnd[1]}`
      : `M ${target[0]} ${target[1]} L ${elbow[0]} ${elbow[1]} L ${landingEnd[0]} ${landingEnd[1]}`,
    arrow: arrowA,
    arrowA,
    arrowB,
    textAnchor: textSide > 0 ? 'start' : 'end',
  };
}

export function angleDimensionLayout(entity, scale) {
  const vertex = entity.vertex;
  const startVector = unitVector(subtractPoints(entity.start, vertex), [1, 0]);
  const endVector = unitVector(subtractPoints(entity.end, vertex), [0, 1]);
  const radius = entity.radius || Math.max(36 / scale, pointLength(subtractPoints(entity.label, vertex)) || 58);
  const labelAngle = Math.atan2((entity.label || vertex)[1] - vertex[1], (entity.label || vertex)[0] - vertex[0]);
  const raySignOptions = entity.angleRayLocked ? [[1, 1]] : [1, -1].flatMap((startSign) => (
    [1, -1].map((endSign) => [startSign, endSign])
  ));
  const options = raySignOptions.map(([startSign, endSign]) => {
    const optionStartVector = scalePoint(startVector, startSign);
    const optionEndVector = scalePoint(endVector, endSign);
    const startAngle = Math.atan2(optionStartVector[1], optionStartVector[0]);
    const endAngle = Math.atan2(optionEndVector[1], optionEndVector[0]);
    const ccwSpan = normalizeAngle(endAngle - startAngle);
    const sweep = ccwSpan <= Math.PI ? 1 : 0;
    const span = sweep ? ccwSpan : -(Math.PI * 2 - ccwSpan);
    const middleAngle = startAngle + span / 2;
    return {
      startVector: optionStartVector,
      endVector: optionEndVector,
      sweep,
      span,
      middleAngle,
      score: angleDistance(labelAngle, middleAngle),
    };
  });
  const selected = options.reduce((best, option) => (option.score < best.score ? option : best), options[0]);
  const arcStart = addPoints(vertex, scalePoint(selected.startVector, radius));
  const arcEnd = addPoints(vertex, scalePoint(selected.endVector, radius));
  const largeArc = Math.abs(selected.span) > Math.PI ? 1 : 0;
  const textRadius = radius + 16 / scale;
  const textPoint = addPoints(vertex, [Math.cos(selected.middleAngle) * textRadius, Math.sin(selected.middleAngle) * textRadius]);
  const tangentStart = selected.sweep ? perpendicular(selected.startVector) : scalePoint(perpendicular(selected.startVector), -1);
  const tangentEnd = selected.sweep ? scalePoint(perpendicular(selected.endVector), -1) : perpendicular(selected.endVector);
  const extensionLength = radius + 16 / scale;
  return {
    vertex,
    arcStart,
    arcEnd,
    textPoint,
    angleDegrees: Math.abs(selected.span) * 180 / Math.PI,
    arcPath: `M ${arcStart[0]} ${arcStart[1]} A ${radius} ${radius} 0 ${largeArc} ${selected.sweep} ${arcEnd[0]} ${arcEnd[1]}`,
    extensionA: {
      start: vertex,
      end: addPoints(vertex, scalePoint(selected.startVector, extensionLength)),
    },
    extensionB: {
      start: vertex,
      end: addPoints(vertex, scalePoint(selected.endVector, extensionLength)),
    },
    arrowA: arrowPath(arcStart, tangentStart, scale),
    arrowB: arrowPath(arcEnd, tangentEnd, scale),
  };
}

export function mclDimensionLayout(entity, scale) {
  const target = entity.target;
  const elbow = entity.elbow || entity.label || addPoints(target, [54, -42]);
  const textSide = elbow[0] >= target[0] ? 1 : -1;
  const landingLength = 34 / scale;
  const landingEnd = addPoints(elbow, [landingLength * textSide, 0]);
  const label = [...landingEnd];
  const leaderDirection = unitVector(subtractPoints(elbow, target), [1, 0]);
  return {
    target,
    elbow,
    landingEnd,
    label,
    leaderPath: `M ${target[0]} ${target[1]} L ${elbow[0]} ${elbow[1]} L ${landingEnd[0]} ${landingEnd[1]}`,
    arrow: arrowPath(target, leaderDirection, scale),
    textAnchor: textSide > 0 ? 'start' : 'end',
  };
}

export function dimensionDisplayText(entity, text = entity.text || '') {
  if (entity.managedDimensionText) return text;
  if (!entity.dimensionName) return text;
  let measurement = String(text).replace(/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*/, '');
  measurement = measurement.replace(/^MCL\s*=\s*/i, '');
  return `${entity.dimensionName} = ${measurement}`;
}

export function isDimensionEntity(entity) {
  return ['dimension-line', 'radius-dimension', 'angle-dimension', 'multi-curve-length-dimension', 'dimension-text'].includes(entity.type);
}

export function dimensionMode(entity) {
  return entity.dimensionMode || (entity.text?.toLowerCase().includes('driven') ? 'driven' : 'driving');
}

export function dimensionExcludedFromExport(entity) {
  return dimensionMode(entity) === 'driven' && entity?.excludeFromExport === true;
}

export function dimensionHiddenInTextMode(entity, textMode = 'named-value') {
  if (textMode !== 'value') return false;
  return dimensionMode(entity) === 'driving' || dimensionExcludedFromExport(entity);
}

export function createDrivenDimensionExportPersistence({ solver, onChange } = {}) {
  return (entity) => {
    if (!entity?.dimensionId || dimensionMode(entity) !== 'driven') return false;
    const updated = solver?.updateDimensionAnnotation?.(entity.dimensionId, entity);
    if (updated) onChange?.(entity);
    return Boolean(updated);
  };
}

export function uprightDimensionControlPoint(point, textTransform = '') {
  const result = [Number(point?.[0]) || 0, Number(point?.[1]) || 0];
  if (!String(textTransform).trim().startsWith('rotate(')) return result;
  const values = String(textTransform).match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)?.map(Number) || [];
  if (!Number.isFinite(values[0])) return result;
  const radians = values[0] * Math.PI / 180;
  const originX = Number.isFinite(values[1]) ? values[1] : 0;
  const originY = Number.isFinite(values[2]) ? values[2] : 0;
  const dx = result[0] - originX;
  const dy = result[1] - originY;
  return [
    originX + dx * Math.cos(radians) - dy * Math.sin(radians),
    originY + dx * Math.sin(radians) + dy * Math.cos(radians),
  ];
}

export function radialDimensionValue(entity) {
  const radius = Number(entity?.radius) || 0;
  return entity?.type === 'radius-dimension' && entity.subtype === 'diameter'
    ? radius * 2
    : radius;
}

export function dimensionHandles(entity, scale) {
  if (entity.type === 'dimension-text') return [entity.label];
  return [];
}

export function updateDimensionNode(record, scale) {
  const entity = record.entity;
  const safeScale = Math.max(Number(scale) || 1, 0.01);
  record.scale = safeScale;
  if (record.text) {
    const textSize = 14 / safeScale;
    record.text.setAttribute('font-size', textSize);
    record.text.style.fontSize = `${textSize}px`;
  }
  if (entity.text) entity.text = dimensionDisplayText(entity, entity.text);
  if (record.text && entity.text) record.text.textContent = entity.text;
  if (entity.type === 'dimension-line') {
    const layout = distanceDimensionLayout(entity, scale);
    record.extensionA.setAttribute('d', `M ${layout.extensionA.start[0]} ${layout.extensionA.start[1]} L ${layout.extensionA.end[0]} ${layout.extensionA.end[1]}`);
    record.extensionB.setAttribute('d', `M ${layout.extensionB.start[0]} ${layout.extensionB.start[1]} L ${layout.extensionB.end[0]} ${layout.extensionB.end[1]}`);
    record.path.setAttribute('d', `M ${layout.dimensionStart[0]} ${layout.dimensionStart[1]} L ${layout.dimensionEnd[0]} ${layout.dimensionEnd[1]}`);
    record.pathHit.setAttribute('d', record.path.getAttribute('d'));
    record.arrowA.setAttribute('d', layout.arrowA);
    record.arrowB.setAttribute('d', layout.arrowB);
    record.text.setAttribute('x', layout.textPoint[0]);
    record.text.setAttribute('y', layout.textPoint[1]);
    record.text.setAttribute('transform', `rotate(${layout.angle} ${layout.textPoint[0]} ${layout.textPoint[1]})`);
    record.text.setAttribute('text-anchor', 'middle');
    record.text.setAttribute('dominant-baseline', 'central');
  }
  if (entity.type === 'radius-dimension') {
    const layout = radiusDimensionLayout(entity, scale);
    entity.target = layout.target;
    entity.label = layout.label;
    record.path.setAttribute('d', layout.leaderPath);
    record.pathHit.setAttribute('d', layout.leaderPath);
    record.arrowA.setAttribute('d', layout.arrowA);
    record.arrowB?.setAttribute('d', layout.arrowB);
    record.text.setAttribute('x', layout.label[0]);
    record.text.setAttribute('y', layout.label[1]);
    record.text.setAttribute('transform', '');
    record.text.setAttribute('text-anchor', layout.textAnchor);
    record.text.setAttribute('dominant-baseline', 'central');
  }
  if (entity.type === 'angle-dimension') {
    const layout = angleDimensionLayout(entity, scale);
    record.extensionA.setAttribute('d', `M ${layout.extensionA.start[0]} ${layout.extensionA.start[1]} L ${layout.extensionA.end[0]} ${layout.extensionA.end[1]}`);
    record.extensionB.setAttribute('d', `M ${layout.extensionB.start[0]} ${layout.extensionB.start[1]} L ${layout.extensionB.end[0]} ${layout.extensionB.end[1]}`);
    record.path.setAttribute('d', layout.arcPath);
    record.pathHit.setAttribute('d', layout.arcPath);
    record.arrowA.setAttribute('d', layout.arrowA);
    record.arrowB.setAttribute('d', layout.arrowB);
    record.text.setAttribute('x', layout.textPoint[0]);
    record.text.setAttribute('y', layout.textPoint[1]);
    record.text.setAttribute('transform', '');
    record.text.setAttribute('text-anchor', 'middle');
    record.text.setAttribute('dominant-baseline', 'central');
    if (!entity.managedDimensionText) {
      entity.text = dimensionDisplayText(entity, `${Math.round(layout.angleDegrees * 10) / 10} deg`);
      record.text.textContent = entity.text;
    }
  }
  if (entity.type === 'multi-curve-length-dimension') {
    const layout = mclDimensionLayout(entity, scale);
    entity.label = layout.label;
    record.path.setAttribute('d', layout.leaderPath);
    record.pathHit.setAttribute('d', layout.leaderPath);
    record.arrowA.setAttribute('d', layout.arrow);
    record.text.setAttribute('x', layout.label[0]);
    record.text.setAttribute('y', layout.label[1]);
    record.text.setAttribute('transform', '');
    record.text.setAttribute('text-anchor', layout.textAnchor);
    record.text.setAttribute('dominant-baseline', 'central');
  }
  if (entity.type === 'dimension-text') {
    record.text.setAttribute('x', entity.label[0]);
    record.text.setAttribute('y', entity.label[1]);
    record.text.setAttribute('transform', '');
  }
  if (record.textHit) {
    try {
      const box = record.text.getBBox();
      const padding = 8 / Math.max(Number(scale) || 1, 0.01);
      record.textHit.setAttribute('x', box.x - padding);
      record.textHit.setAttribute('y', box.y - padding);
      record.textHit.setAttribute('width', Math.max(box.width + padding * 2, padding * 2));
      record.textHit.setAttribute('height', Math.max(box.height + padding * 2, padding * 2));
      record.textHit.setAttribute('transform', record.text.getAttribute('transform') || '');
    } catch {
      // SVG text measurement is unavailable in some non-browser renderers.
    }
  }
  if (record.exportToggle) {
    const excluded = dimensionExcludedFromExport(entity);
    record.group.classList.toggle('dimension-export-excluded', excluded);
    record.exportToggle.setAttribute('aria-pressed', String(excluded));
    record.exportToggle.setAttribute(
      'aria-label',
      excluded
        ? 'Include driven dimension in exports and thumbnails'
        : 'Exclude driven dimension from exports and thumbnails',
    );
    record.exportToggle.setAttribute(
      'data-tooltip',
      excluded ? 'Include in exports and thumbnails' : 'Exclude from exports and thumbnails',
    );
    try {
      const box = record.text.getBBox();
      const centerX = box.x + box.width + 16 / safeScale;
      const centerY = box.y + box.height / 2;
      const textTransform = record.text.getAttribute('transform') || '';
      const [uprightX, uprightY] = uprightDimensionControlPoint(
        [centerX, centerY],
        textTransform,
      );
      record.exportToggle.setAttribute(
        'transform',
        `translate(${uprightX} ${uprightY}) scale(${1 / safeScale})`,
      );
    } catch {
      const label = Array.isArray(entity.label) ? entity.label : [0, 0];
      record.exportToggle.setAttribute(
        'transform',
        `translate(${label[0] + 16 / safeScale} ${label[1]}) scale(${1 / safeScale})`,
      );
    }
  }
}

export function createDimensionRecord({
  add,
  objectLayer,
  entity,
  index,
  scale,
  updateRecordHandles,
  bindRecordEvents,
  onToggleExport = null,
}) {
  const group = add(objectLayer, 'g', { class: `canvas-record entity-record dimension-record dimension-${dimensionMode(entity)}`, 'data-record-id': entity.id || `dimension-${index}` });
  let path = null;
  let extensionA = null;
  let extensionB = null;
  let arrowA = null;
  let arrowB = null;
  let pathHit = null;
  if (entity.type === 'dimension-line') {
    extensionA = add(group, 'path', { class: 'dimension-extension selectable-entity' });
    extensionB = add(group, 'path', { class: 'dimension-extension selectable-entity' });
    path = add(group, 'path', { class: 'dimension-path selectable-entity' });
    arrowA = add(group, 'path', { class: 'dimension-arrow selectable-entity' });
    arrowB = add(group, 'path', { class: 'dimension-arrow selectable-entity' });
    pathHit = add(group, 'path', { class: 'dimension-path selectable-entity hit-target' });
  }
  if (entity.type === 'angle-dimension') {
    extensionA = add(group, 'path', { class: 'dimension-extension dimension-angle-leg selectable-entity' });
    extensionB = add(group, 'path', { class: 'dimension-extension dimension-angle-leg selectable-entity' });
    path = add(group, 'path', { class: 'dimension-path dimension-angle-arc selectable-entity' });
    arrowA = add(group, 'path', { class: 'dimension-arrow selectable-entity' });
    arrowB = add(group, 'path', { class: 'dimension-arrow selectable-entity' });
    pathHit = add(group, 'path', { class: 'dimension-path dimension-angle-arc selectable-entity hit-target' });
  }
  if (entity.type === 'radius-dimension') {
    path = add(group, 'path', { class: 'dimension-path dimension-leader selectable-entity' });
    arrowA = add(group, 'path', { class: 'dimension-arrow selectable-entity' });
    arrowB = add(group, 'path', { class: 'dimension-arrow selectable-entity' });
    pathHit = add(group, 'path', { class: 'dimension-path dimension-leader selectable-entity hit-target' });
  }
  if (entity.type === 'multi-curve-length-dimension') {
    path = add(group, 'path', { class: 'dimension-path dimension-leader dimension-mcl-leader selectable-entity' });
    arrowA = add(group, 'path', { class: 'dimension-arrow selectable-entity' });
    pathHit = add(group, 'path', { class: 'dimension-path dimension-leader dimension-mcl-leader selectable-entity hit-target' });
  }
  const text = add(group, 'text', { x: entity.label[0], y: entity.label[1], class: 'dimension-text selectable-entity' });
  text.textContent = entity.text;
  const textHit = add(group, 'rect', { class: 'dimension-text-hit selectable-entity hit-target' });
  let exportToggle = null;
  if (dimensionMode(entity) === 'driven' && onToggleExport) {
    exportToggle = add(group, 'g', {
      class: 'driven-dimension-export-toggle',
      role: 'button',
      tabindex: '0',
      'aria-pressed': String(dimensionExcludedFromExport(entity)),
    });
    add(exportToggle, 'circle', { class: 'driven-dimension-export-toggle-circle', cx: 0, cy: 0, r: 10 });
    add(exportToggle, 'path', { class: 'driven-dimension-export-toggle-eye', d: 'M -6 0 Q 0 -5 6 0 Q 0 5 -6 0 Z M -2 0 A 2 2 0 1 0 2 0 A 2 2 0 1 0 -2 0' });
    add(exportToggle, 'path', { class: 'driven-dimension-export-toggle-slash', d: 'M -6 -6 L 6 6' });
  }
  const handleGroup = add(group, 'g', { class: 'handle-group' });
  const record = { id: group.dataset.recordId, recordType: 'dimension', entity, group, node: path || text, path, pathHit, extensionA, extensionB, arrowA, arrowB, text, textHit, exportToggle, handleGroup, handles: [] };
  const toggleExport = (event) => {
    event.preventDefault();
    event.stopPropagation();
    entity.excludeFromExport = !dimensionExcludedFromExport(entity);
    updateDimensionNode(record, record.scale || scale);
    if (onToggleExport?.(entity) === false) {
      entity.excludeFromExport = !entity.excludeFromExport;
      updateDimensionNode(record, record.scale || scale);
    }
  };
  exportToggle?.addEventListener('pointerdown', (event) => event.stopPropagation());
  exportToggle?.addEventListener('click', toggleExport);
  exportToggle?.addEventListener('keydown', (event) => {
    if (!['Enter', ' '].includes(event.key)) return;
    toggleExport(event);
  });
  updateDimensionNode(record, scale);
  updateRecordHandles(record);
  bindRecordEvents(record);
  return record;
}

export function moveDimensionHandle(record, handleIndex, world, startWorld, startEntity, scale) {
  const entity = record.entity;
  if (entity.type === 'radius-dimension' && handleIndex === 0) {
    entity.elbow = world;
    const textSide = world[0] >= entity.center[0] ? 1 : -1;
    entity.label = [world[0] + (32 / scale) * textSide, world[1]];
  }
  if (entity.type === 'multi-curve-length-dimension' && handleIndex === 0) {
    entity.elbow = world;
    const textSide = world[0] >= entity.target[0] ? 1 : -1;
    entity.label = [world[0] + (34 / scale) * textSide, world[1]];
  }
  if (entity.type === 'dimension-text') entity.label = world;
  updateDimensionNode(record, scale);
}

export function moveDimensionLine(record, world, startWorld, startEntity, scale) {
  const entity = record.entity;
  const dx = world[0] - startWorld[0];
  const dy = world[1] - startWorld[1];
  if (entity.type === 'dimension-line') {
    entity.label = [startEntity.label[0] + dx, startEntity.label[1] + dy];
  }
  if (entity.type === 'angle-dimension') {
    entity.radius = Math.max(18, pointLength(subtractPoints(world, entity.vertex)));
    entity.label = world;
  }
  if (entity.type === 'radius-dimension') {
    const startElbow = startEntity.elbow || startEntity.label || addPoints(startEntity.center, [-72, -48]);
    entity.elbow = [startElbow[0] + dx, startElbow[1] + dy];
    const textSide = entity.elbow[0] >= entity.center[0] ? 1 : -1;
    entity.label = [entity.elbow[0] + (32 / scale) * textSide, entity.elbow[1]];
  }
  if (entity.type === 'multi-curve-length-dimension') {
    const startElbow = startEntity.elbow || startEntity.label || addPoints(startEntity.target, [54, -42]);
    entity.elbow = [startElbow[0] + dx, startElbow[1] + dy];
    const textSide = entity.elbow[0] >= entity.target[0] ? 1 : -1;
    entity.label = [entity.elbow[0] + (34 / scale) * textSide, entity.elbow[1]];
  }
  updateDimensionNode(record, scale);
}

export function dimensionAnchorRecordIds(entity) {
  const ids = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.recordId && value.recordId !== CANVAS_ORIGIN_RECORD_ID) ids.add(value.recordId);
    Object.values(value).forEach(visit);
  };
  visit(entity.anchors);
  return ids;
}

export function dimensionParentRecordIds(entity) {
  const ids = dimensionAnchorRecordIds(entity);
  if (entity?.externalDrivingTarget?.recordId) {
    ids.add(entity.externalDrivingTarget.recordId);
  }
  return ids;
}

export function dimensionParentsVisible(entity, isRecordVisible) {
  return dimensionParentStates(entity, { isVisible: isRecordVisible }).visible;
}

export function dimensionParentStates(entity, { isVisible = () => true, isEnabled = isVisible } = {}) {
  const parentIds = dimensionParentRecordIds(entity);
  const everyParent = (resolver) => parentIds.size === 0
    || [...parentIds].every((recordId) => resolver(recordId) !== false);
  return {
    visible: everyParent(isVisible),
    enabled: everyParent(isEnabled),
  };
}

export function measureDrivenDimension(entity, features = []) {
  if (entity.type === 'dimension-line') {
    const a = entity.measureStart || entity.start;
    const b = entity.measureEnd || entity.end;
    if (entity.subtype === 'horizontal') return Math.abs(b[0] - a[0]);
    if (entity.subtype === 'vertical') return Math.abs(b[1] - a[1]);
    return pointLength(subtractPoints(a, b));
  }
  if (entity.type === 'radius-dimension') return radialDimensionValue(entity);
  if (entity.type === 'angle-dimension') {
    const first = subtractPoints(entity.start, entity.vertex);
    const second = subtractPoints(entity.end, entity.vertex);
    return Math.abs(Math.atan2(
      first[0] * second[1] - first[1] * second[0],
      first[0] * second[0] + first[1] * second[1],
    )) * 180 / Math.PI;
  }
  if (entity.type === 'multi-curve-length-dimension') {
    return features.reduce((total, feature) => total + featureLength(feature), 0);
  }
  return 0;
}

export function createDimensionLinkManager({
  records,
  recordById,
  recordHandles,
  recordSegments,
  renderedEntityForRecord,
  filletEvaluation,
  arcCircle,
  screenToWorld,
  formatDrawingLength,
  solver,
  applyManagedDimensionText,
  updateRecordHandles,
  syncScreenInvariantSizing,
  getScale,
  resolveDerivedFeature = () => null,
  derivedFeatureDependsOn = () => false,
}) {
  function resolveRecordEntity(record, rendered = false) {
    return (rendered ? renderedEntityForRecord(record) : null) || record?.entity || null;
  }

  function nearestSegmentFeature(record, world, sourceNode = null, { rendered = false } = {}) {
    const segments = recordSegments(resolveRecordEntity(record, rendered));
    if (!segments.length) return null;
    const requestedIndex = sourceNode?.dataset?.segmentIndex;
    const segment = requestedIndex === undefined
      ? segments.reduce((best, current) => {
        const distance = distanceToSegment(world, current.start, current.end);
        return !best || distance < best.distance ? { ...current, distance } : best;
      }, null)
      : segments.find((item) => String(item.index) === requestedIndex);
    if (!segment) return null;
    return {
      kind: 'segment',
      recordId: record.id,
      entityType: record.entity.type,
      start: [...segment.start],
      end: [...segment.end],
      index: segment.index,
      node: record.segmentNodes?.[segment.index] || sourceNode || record.node,
    };
  }

  function segmentFeatureFromRecord(record, index = 0, { rendered = false } = {}) {
    const segments = recordSegments(resolveRecordEntity(record, rendered));
    const segment = segments[Math.max(0, Math.min(index, segments.length - 1))];
    if (!segment) return null;
    return {
      kind: 'segment',
      recordId: record.id,
      entityType: record.entity.type,
      start: [...segment.start],
      end: [...segment.end],
      index: segment.index,
      node: record.segmentNodes?.[segment.index] || record.node,
    };
  }

  function entityFeatureFromRecord(record, { rendered = false } = {}) {
    if (!record || !['geometry', 'fillet', 'notch', 'text', 'control'].includes(record.recordType)) return null;
    if (record.recordType === 'fillet') {
      const evaluated = filletEvaluation(record);
      if (!evaluated.valid) return null;
      return {
        kind: 'arc',
        recordId: record.id,
        entityType: 'fillet',
        center: [...evaluated.arc.center],
        radius: evaluated.arc.radius,
        start: [...evaluated.arc.start],
        arcPoint: [...evaluated.arc.arcPoint],
        end: [...evaluated.arc.end],
        node: record.node,
        derivedFromFillet: true,
        filletDefinition: record.entity,
      };
    }
    const entity = resolveRecordEntity(record, rendered);
    if (entity?.type === 'circle') {
      return { kind: 'circle', recordId: record.id, center: [...entity.center], radius: entity.radius, node: record.node };
    }
    if (entity?.type === 'arc') {
      const circle = arcCircle(entity);
      if (!circle) return null;
      return {
        kind: 'arc',
        recordId: record.id,
        center: circle.center,
        radius: circle.radius,
        start: [...entity.start],
        arcPoint: [...entity.arcPoint],
        end: [...entity.end],
        node: record.node,
        derivedFromFillet: entity.derivedFromFillet === true,
      };
    }
    return null;
  }

  function getFeatureFromEvent(event, { rendered = false } = {}) {
    const recordElement = event.target.closest?.('.canvas-record, .canvas-handle-group');
    if (!recordElement) return null;
    const record = records.find((item) => item.id === recordElement.dataset.recordId);
    if (!record || !['geometry', 'fillet', 'notch', 'text', 'control'].includes(record.recordType)) return null;
    const world = screenToWorld(event.clientX, event.clientY);
    if (event.target.classList?.contains('point-handle')) {
      const index = Number(event.target.dataset.handleIndex);
      const entity = resolveRecordEntity(record, rendered);
      const point = recordHandles(entity)[index];
      return point ? {
        kind: 'point',
        recordId: record.id,
        entityType: record.entity.type,
        index,
        ...(entity.type === 'arc' && index === 1 ? { pointRole: ARC_MIDPOINT_ROLE } : {}),
        point: [...point],
        node: event.target,
      } : null;
    }
    if (record.recordType === 'fillet') {
      const feature = entityFeatureFromRecord(record, { rendered: true });
      return feature ? { ...feature, node: record.node } : null;
    }
    if (event.target.dataset?.segmentIndex !== undefined) return nearestSegmentFeature(record, world, event.target, { rendered });
    if (record.entity.type === 'line') return { ...nearestSegmentFeature(record, world, record.node, { rendered }), node: event.target };
    if (record.entity.type === 'rect' || record.entity.type === 'polyline' || record.entity.type === 'polygon') return nearestSegmentFeature(record, world, event.target, { rendered });
    if (record.entity.type === 'circle') {
      const entity = resolveRecordEntity(record, rendered);
      return { kind: 'circle', recordId: record.id, center: [...entity.center], radius: entity.radius, node: event.target };
    }
    if (record.entity.type === 'arc') {
      const entity = resolveRecordEntity(record, rendered);
      const circle = arcCircle(entity);
      if (!circle) return null;
      return {
        kind: 'arc',
        recordId: record.id,
        entityType: record.entity.type,
        center: circle.center,
        radius: circle.radius,
        start: [...entity.start],
        arcPoint: [...entity.arcPoint],
        end: [...entity.end],
        node: event.target,
        derivedFromFillet: entity.derivedFromFillet === true,
      };
    }
    if (record.entity.type === 'curve') {
      const entity = resolveRecordEntity(record, rendered);
      return {
        kind: 'curve',
        recordId: record.id,
        entityType: record.entity.type,
        points: entity.points.map((point) => [...point]),
        node: event.target,
      };
    }
    return null;
  }

  function getDimensionFeatureSet(recordId, { rendered = false } = {}) {
    const record = recordById(recordId, { includeFillets: true });
    if (!record || !['geometry', 'fillet', 'notch', 'text', 'control'].includes(record.recordType)) return null;
    if (record.recordType === 'fillet') {
      const feature = entityFeatureFromRecord(record, { rendered: true });
      if (!feature) return null;
      const controlPoints = [feature.start, feature.arcPoint, feature.end].filter(Boolean).map((point) => [...point]);
      return {
        recordId: record.id,
        entityType: 'fillet',
        controlPoints,
        features: [
          ...controlPoints.map((point, index) => ({
            kind: 'point',
            recordId: record.id,
            entityType: 'fillet',
            index,
            point,
            node: record.node,
          })),
          feature,
        ],
      };
    }
    const entity = resolveRecordEntity(record, rendered);
    if (!entity) return null;
    const controlPoints = recordHandles(entity).map((point) => [...point]);
    const features = controlPoints.map((point, index) => ({
      kind: 'point',
      recordId: record.id,
      entityType: entity.type,
      index,
      ...(entity.type === 'arc' && index === 1 ? { pointRole: ARC_MIDPOINT_ROLE } : {}),
      point,
      node: record.handles?.[index] || record.node,
    }));
    recordSegments(entity).forEach((segment) => features.push({
      kind: 'segment',
      recordId: record.id,
      entityType: entity.type,
      index: segment.index,
      start: [...segment.start],
      end: [...segment.end],
      node: record.segmentNodes?.[segment.index] || record.node,
    }));
    const entityFeature = entityFeatureFromRecord(record, { rendered });
    if (entityFeature) features.push(entityFeature);
    if (entity.type === 'curve') {
      features.push({
        kind: 'curve',
        recordId: record.id,
        entityType: entity.type,
        points: entity.points.map((point) => [...point]),
        node: record.node,
      });
    }
    return { recordId: record.id, entityType: entity.type, controlPoints, features };
  }

  function getEntityFeature(recordId, options = {}) {
    return entityFeatureFromRecord(recordById(recordId, { includeFillets: true }), options);
  }

  function getSegmentFeature(recordId, index = 0, options = {}) {
    const record = recordById(recordId);
    return record ? segmentFeatureFromRecord(record, index, options) : null;
  }

  function getPointFeature(recordId, index = 0, { rendered = false } = {}) {
    const record = recordById(recordId, { includeFillets: true });
    const entity = resolveRecordEntity(record, rendered);
    const point = entity ? recordHandles(entity)[index] : null;
    return point ? {
      kind: 'point',
      recordId: record.id,
      entityType: record.entity.type,
      index,
      ...(entity.type === 'arc' && index === 1 ? { pointRole: ARC_MIDPOINT_ROLE } : {}),
      point: [...point],
    } : null;
  }

  function resolveAnchor(anchor, { rendered = false } = {}) {
    if (!anchor) return null;
    if (anchor.recordId === CANVAS_ORIGIN_RECORD_ID) return [0, 0];
    const record = recordById(anchor.recordId, { includeFillets: true });
    if (!record) {
      const derived = resolveDerivedFeature(anchor);
      if (anchor.type === 'point') return derived?.controlPoints?.[anchor.index]?.slice() || null;
      if (anchor.type === 'segment-start' || anchor.type === 'segment-end') {
        const segment = resolveDerivedFeature({ kind: 'segment', recordId: anchor.recordId, index: anchor.index });
        return segment ? [...(anchor.type === 'segment-start' ? segment.start : segment.end)] : null;
      }
      if (anchor.type === 'segment-point') {
        const segment = resolveDerivedFeature({ kind: 'segment', recordId: anchor.recordId, index: anchor.index });
        if (!segment) return null;
        const ratio = Math.max(0, Math.min(1, Number(anchor.ratio) || 0));
        return addPoints(segment.start, scalePoint(subtractPoints(segment.end, segment.start), ratio));
      }
      if (anchor.type === 'center') return derived?.center?.slice() || null;
      if (anchor.type === 'radius') return derived?.radius ?? null;
      return null;
    }
    const entity = resolveRecordEntity(record, rendered && record.recordType !== 'fillet');
    if (anchor.type === 'point') return recordHandles(entity)[anchor.index]?.slice() || null;
    if (anchor.type === 'segment-start' || anchor.type === 'segment-end') {
      const segment = segmentFeatureFromRecord(record, anchor.index, { rendered });
      if (!segment) return null;
      return anchor.type === 'segment-start' ? [...segment.start] : [...segment.end];
    }
    if (anchor.type === 'segment-point') {
      const segment = segmentFeatureFromRecord(record, anchor.index, { rendered });
      if (!segment) return null;
      const ratio = Math.max(0, Math.min(1, Number(anchor.ratio) || 0));
      return addPoints(segment.start, scalePoint(subtractPoints(segment.end, segment.start), ratio));
    }
    if (anchor.type === 'center') return entityFeatureFromRecord(record, { rendered })?.center?.slice() || null;
    if (anchor.type === 'radius') return entityFeatureFromRecord(record, { rendered })?.radius || null;
    return null;
  }

  function resolveFeatureFromAnchor(featureAnchor, { rendered = false } = {}) {
    const record = recordById(featureAnchor?.recordId, { includeFillets: true });
    if (!record) return resolveDerivedFeature(featureAnchor);
    if (featureAnchor.kind === 'segment') return segmentFeatureFromRecord(record, featureAnchor.index, { rendered });
    if (featureAnchor.kind === 'circle' || featureAnchor.kind === 'arc') return entityFeatureFromRecord(record, { rendered });
    if (featureAnchor.kind === 'curve') {
      const entity = resolveRecordEntity(record, rendered && record.recordType !== 'fillet');
      return entity?.type === 'curve'
        ? { kind: 'curve', recordId: record.id, points: entity.points.map((point) => [...point]) }
        : null;
    }
    return null;
  }

  function computedDimensionValue(entity) {
    const features = entity.type === 'multi-curve-length-dimension'
      ? entity.anchors?.features?.map(resolveFeatureFromAnchor).filter(Boolean) || []
      : [];
    return measureDrivenDimension(entity, features);
  }

  function computedDimensionUnit(entity) {
    return entity.type === 'angle-dimension' ? 'deg' : solver.drawingUnit;
  }

  function dimensionLineText(entity) {
    const sourceStart = entity.measureStart || entity.start;
    const sourceEnd = entity.measureEnd || entity.end;
    const measured = entity.subtype === 'horizontal'
      ? Math.abs(sourceEnd[0] - sourceStart[0])
      : entity.subtype === 'vertical'
        ? Math.abs(sourceEnd[1] - sourceStart[1])
        : pointLength(subtractPoints(entity.start, entity.end));
    return formatDrawingLength(measured);
  }

  function updateLinkedDimensionEntity(entity) {
    if (!entity.anchors) return false;
    const useRendered = entity.dimensionMode === 'driven';
    if (entity.type === 'dimension-line') {
      const oldMid = midpoint(entity.measureStart || entity.start, entity.measureEnd || entity.end);
      const lineToLine = entity.anchors.lineToLine;
      if (lineToLine) {
        const reference = getSegmentFeature(
          lineToLine.reference.recordId,
          lineToLine.reference.index,
          { rendered: useRendered },
        );
        const measured = getSegmentFeature(
          lineToLine.measured.recordId,
          lineToLine.measured.index,
          { rendered: useRendered },
        );
        if (!reference || !measured) return false;
        const geometry = supportingLineDimensionGeometry(reference, measured);
        const nextMid = midpoint(geometry.projected, geometry.measuredPoint);
        entity.start = geometry.projected;
        entity.end = geometry.measuredPoint;
        entity.measureStart = geometry.projected;
        entity.measureEnd = geometry.measuredPoint;
        entity.label = addPoints(entity.label, subtractPoints(nextMid, oldMid));
        entity.text = dimensionLineText(entity);
        entity.measuredValue = computedDimensionValue(entity);
        return true;
      }
      const pointToSegment = entity.anchors.pointToSegment;
      if (pointToSegment) {
        const point = resolveAnchor(pointToSegment.point, { rendered: useRendered });
        const segment = getSegmentFeature(pointToSegment.segment.recordId, pointToSegment.segment.index, { rendered: useRendered });
        if (!point || !segment) return false;
        const projected = projectionOnSegmentSmart(point, segment, pointToSegment.projectionMode);
        const nextMid = midpoint(projected, point);
        entity.start = projected;
        entity.end = point;
        entity.measureStart = projected;
        entity.measureEnd = point;
        entity.label = addPoints(entity.label, subtractPoints(nextMid, oldMid));
        entity.text = dimensionLineText(entity);
        entity.measuredValue = computedDimensionValue(entity);
        return true;
      }
      const resolvedStart = resolveAnchor(entity.anchors.start, { rendered: useRendered });
      const resolvedEnd = resolveAnchor(entity.anchors.end, { rendered: useRendered });
      const nextMeasureStart = resolveAnchor(entity.anchors.measureStart, { rendered: useRendered })
        || resolvedStart
        || entity.measureStart
        || entity.start;
      const nextMeasureEnd = resolveAnchor(entity.anchors.measureEnd, { rendered: useRendered })
        || resolvedEnd
        || entity.measureEnd
        || entity.end;
      const nextStart = resolvedStart || nextMeasureStart;
      const nextEnd = resolvedEnd || nextMeasureEnd;
      const nextMid = midpoint(nextMeasureStart, nextMeasureEnd);
      const delta = subtractPoints(nextMid, oldMid);
      entity.start = nextStart;
      entity.end = nextEnd;
      entity.measureStart = nextMeasureStart;
      entity.measureEnd = nextMeasureEnd;
      entity.label = addPoints(entity.label, delta);
      entity.text = dimensionLineText(entity);
      entity.measuredValue = computedDimensionValue(entity);
      return true;
    }
    if (entity.type === 'radius-dimension') {
      const oldCenter = entity.center;
      const center = resolveAnchor(entity.anchors.center, { rendered: useRendered });
      const radius = resolveAnchor(entity.anchors.radius, { rendered: useRendered });
      if (!center) return false;
      const delta = subtractPoints(center, oldCenter);
      entity.center = center;
      if (radius) entity.radius = radius;
      entity.elbow = addPoints(entity.elbow || entity.label, delta);
      entity.label = addPoints(entity.label, delta);
      entity.text = formatDrawingLength(radialDimensionValue(entity));
      entity.measuredValue = computedDimensionValue(entity);
      return true;
    }
    if (entity.type === 'angle-dimension') {
      const first = entity.anchors.firstSegment;
      const second = entity.anchors.secondSegment;
      const firstSegment = first?.start && first?.end ? {
        start: resolveAnchor(first.start, { rendered: useRendered }),
        end: resolveAnchor(first.end, { rendered: useRendered }),
      } : null;
      const secondSegment = second?.start && second?.end ? {
        start: resolveAnchor(second.start, { rendered: useRendered }),
        end: resolveAnchor(second.end, { rendered: useRendered }),
      } : null;
      if (!firstSegment?.start || !firstSegment?.end || !secondSegment?.start || !secondSegment?.end) return false;
      const oldVertex = entity.vertex;
      const vertex = lineIntersection(firstSegment, secondSegment) || firstSegment.end;
      const firstVector = scalePoint(
        unitVector(subtractPoints(firstSegment.end, firstSegment.start)),
        entity.firstRaySign || 1,
      );
      const secondVector = scalePoint(
        unitVector(subtractPoints(secondSegment.end, secondSegment.start), [0, 1]),
        entity.secondRaySign || 1,
      );
      const delta = subtractPoints(vertex, oldVertex);
      entity.vertex = vertex;
      entity.start = addPoints(vertex, scalePoint(firstVector, 80));
      entity.end = addPoints(vertex, scalePoint(secondVector, 80));
      entity.label = addPoints(entity.label, delta);
      entity.measuredValue = computedDimensionValue(entity);
      return true;
    }
    if (entity.type === 'multi-curve-length-dimension') {
      const features = entity.anchors.features?.map((featureAnchor) => resolveFeatureFromAnchor(featureAnchor, { rendered: useRendered })).filter(Boolean) || [];
      if (!features.length) return false;
      const first = features[0];
      const target = featureTargetPoint(first);
      if (!target) return false;
      const delta = subtractPoints(target, entity.target);
      entity.target = target;
      entity.elbow = addPoints(entity.elbow || entity.label, delta);
      entity.label = addPoints(entity.label, delta);
      entity.measuredValue = features.reduce((total, feature) => total + featureLength(feature), 0);
      entity.text = formatDrawingLength(entity.measuredValue);
      return true;
    }
    return false;
  }

  function refreshLinkedDimensions(changedRecordIds = null) {
    records.forEach((record) => {
      if (record.recordType !== 'dimension' || !record.entity.anchors) return;
      const anchorIds = dimensionAnchorRecordIds(record.entity);
      if (changedRecordIds && ![...anchorIds].some((id) => (
        changedRecordIds.has(id) || derivedFeatureDependsOn(id, changedRecordIds)
      ))) return;
      if (!updateLinkedDimensionEntity(record.entity)) return;
      if (record.entity.dimensionId) solver.updateDimensionAnnotation?.(record.entity.dimensionId, record.entity);
      if (record.entity.dimensionMode === 'driven' && record.entity.dimensionId) {
        solver.dimensions.setComputedValue(
          record.entity.dimensionId,
          computedDimensionValue(record.entity),
          computedDimensionUnit(record.entity),
        );
      }
      applyManagedDimensionText(record.entity);
      updateDimensionNode(record, getScale());
      updateRecordHandles(record);
    });
    syncScreenInvariantSizing?.();
  }

  return {
    getEntityFeature,
    getSegmentFeature,
    getPointFeature,
    getDimensionFeatureSet,
    getFeatureFromEvent,
    refreshLinkedDimensions,
  };
}

// --- Smart Dimension Tools ---
const pointDistanceSmart = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const midpointSmart = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const subtractSmart = (a, b) => [a[0] - b[0], a[1] - b[1]];
const addSmart = (a, b) => [a[0] + b[0], a[1] + b[1]];
const scaleSmart = (point, value) => [point[0] * value, point[1] * value];
const dotSmart = (a, b) => a[0] * b[0] + a[1] * b[1];
const crossSmart = (a, b) => a[0] * b[1] - a[1] * b[0];
const lengthSmart = (point) => Math.hypot(point[0], point[1]);
const unitSmart = (point, fallback = [1, 0]) => {
  const size = lengthSmart(point);
  return size > 0.0001 ? [point[0] / size, point[1] / size] : fallback;
};

const formatDrawingLengthSmart = (value, drawingUnit) => formatUnitlessValue(value, drawingUnit || 'in');

function pointAnchor(feature) {
  return feature?.kind === 'point'
    ? {
      type: 'point',
      recordId: feature.recordId,
      index: feature.index,
      ...(feature.pointRole ? { pointRole: feature.pointRole } : {}),
    }
    : null;
}

function segmentEndpointAnchors(feature) {
  if (feature?.kind !== 'segment') return null;
  return {
    start: { type: 'segment-start', recordId: feature.recordId, index: feature.index },
    end: { type: 'segment-end', recordId: feature.recordId, index: feature.index },
  };
}

function segmentAnchor(feature) {
  return feature?.kind === 'segment' ? { kind: 'segment', recordId: feature.recordId, index: feature.index } : null;
}

function segmentPointAnchor(feature, point) {
  if (feature?.kind !== 'segment') return null;
  const vector = subtractSmart(feature.end, feature.start);
  const sizeSquared = dotSmart(vector, vector);
  const ratio = sizeSquared ? dotSmart(subtractSmart(point, feature.start), vector) / sizeSquared : 0;
  return {
    type: 'segment-point',
    recordId: feature.recordId,
    index: feature.index,
    ratio: Math.max(0, Math.min(1, ratio)),
  };
}

function entityCenterAnchor(feature) {
  return ['circle', 'arc'].includes(feature?.kind) ? { type: 'center', recordId: feature.recordId } : null;
}

function entityRadiusAnchor(feature) {
  return ['circle', 'arc'].includes(feature?.kind) ? { type: 'radius', recordId: feature.recordId } : null;
}

function featureEndpoints(feature) {
  if (feature.kind === 'segment' || feature.kind === 'arc') return [feature.start, feature.end];
  if (feature.kind === 'curve') return [feature.points[0], feature.points[feature.points.length - 1]];
  return [];
}

function projectionOnSegmentSmart(point, segment, projectionMode = 'segment') {
  const vector = subtractSmart(segment.end, segment.start);
  const sizeSquared = dotSmart(vector, vector);
  if (!sizeSquared) return segment.start;
  const rawRatio = dotSmart(subtractSmart(point, segment.start), vector) / sizeSquared;
  const t = projectionMode === 'line' ? rawRatio : Math.max(0, Math.min(1, rawRatio));
  return addSmart(segment.start, scaleSmart(vector, t));
}

function projectionOnLineSmart(point, segment) {
  const vector = subtractSmart(segment.end, segment.start);
  const sizeSquared = dotSmart(vector, vector);
  if (!sizeSquared) return segment.start;
  const t = dotSmart(subtractSmart(point, segment.start), vector) / sizeSquared;
  return addSmart(segment.start, scaleSmart(vector, t));
}

function supportingLineDimensionGeometry(reference, measured) {
  const measuredPoint = midpointSmart(measured.start, measured.end);
  const projected = projectionOnLineSmart(measuredPoint, reference);
  const referenceVector = subtractSmart(reference.end, reference.start);
  const referenceLength = Math.hypot(...referenceVector);
  const signedDistance = referenceLength
    ? crossSmart(referenceVector, subtractSmart(measuredPoint, reference.start)) / referenceLength
    : 0;
  return {
    measuredPoint,
    projected,
    signedDistance,
    measuredValue: Math.abs(signedDistance),
  };
}

function legacyParallelEdgeAnchors(annotation, constraint) {
  if (
    annotation?.type !== 'dimension-line'
    || annotation.measurementKind
    || annotation.subtype !== 'aligned'
  ) return null;
  const reference = annotation.anchors?.measureStart;
  const measured = annotation.anchors?.measureEnd;
  if (
    reference?.type !== 'segment-point'
    || !['segment-start', 'segment-end'].includes(measured?.type)
    || !reference.recordId
    || !measured.recordId
    || reference.recordId === measured.recordId
  ) return null;
  if (annotation.dimensionMode === 'driving') {
    if (
      constraint?.type !== 'Distance'
      || constraint.source !== 'dimension'
      || constraint.dimensionRef !== annotation.dimensionId
    ) return null;
  }
  return { reference, measured };
}

function storedSegment(entityById, reference) {
  const entity = entityById.get(reference?.recordId);
  const index = Number(reference?.index) || 0;
  if (Array.isArray(entity?.start) && Array.isArray(entity?.end) && index === 0) {
    return { start: entity.start, end: entity.end };
  }
  if (Array.isArray(entity?.points) && entity.points.length > 1) {
    const nextIndex = index + 1;
    if (index >= 0 && nextIndex < entity.points.length) {
      return { start: entity.points[index], end: entity.points[nextIndex] };
    }
  }
  return null;
}

function parallelEdgeSegmentAnchors(annotation, constraint) {
  if (annotation?.type !== 'dimension-line' || annotation.anchors?.lineToLine) return null;
  const pointToSegment = annotation.anchors?.pointToSegment;
  if (
    annotation.measurementKind === 'parallel-edge-distance'
    && pointToSegment?.segment?.recordId
    && pointToSegment?.point?.recordId
  ) {
    return {
      reference: { ...pointToSegment.segment, kind: 'segment' },
      measured: {
        kind: 'segment',
        recordId: pointToSegment.point.recordId,
        index: Number(pointToSegment.point.index) || 0,
      },
    };
  }
  const legacy = legacyParallelEdgeAnchors(annotation, constraint);
  if (!legacy) return null;
  return {
    reference: {
      kind: 'segment',
      recordId: legacy.reference.recordId,
      index: Number(legacy.reference.index) || 0,
    },
    measured: {
      kind: 'segment',
      recordId: legacy.measured.recordId,
      index: Number(legacy.measured.index) || 0,
    },
  };
}

export function upgradeLegacyParallelEdgeDimensions(snapshot = {}) {
  const entities = Array.isArray(snapshot.entities) ? snapshot.entities : [];
  const constraints = Array.isArray(snapshot.constraints) ? snapshot.constraints : [];
  const annotations = Array.isArray(snapshot.dimensionAnnotations) ? snapshot.dimensionAnnotations : [];
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const constraintByDimensionId = new Map(constraints
    .filter((constraint) => constraint?.dimensionRef)
    .map((constraint) => [constraint.dimensionRef, constraint]));
  const migrations = new Map();
  const dimensionAnnotations = annotations.map((annotation) => {
    const lineToLine = parallelEdgeSegmentAnchors(
      annotation,
      constraintByDimensionId.get(annotation.dimensionId),
    );
    if (!lineToLine) return annotation;
    const reference = storedSegment(entityById, lineToLine.reference);
    const measured = storedSegment(entityById, lineToLine.measured);
    if (!reference || !measured) return annotation;
    const geometry = supportingLineDimensionGeometry(reference, measured);
    const orientation = Math.sign(geometry.signedDistance) || 1;
    migrations.set(annotation.dimensionId, { lineToLine, orientation });
    return {
      ...annotation,
      measurementKind: 'parallel-edge-distance',
      subtype: 'aligned',
      orientation,
      start: geometry.projected,
      end: geometry.measuredPoint,
      measureStart: geometry.projected,
      measureEnd: geometry.measuredPoint,
      anchors: { lineToLine },
      measuredValue: geometry.measuredValue,
    };
  });
  return {
    ...snapshot,
    entities,
    dimensionAnnotations,
    constraints: constraints.map((constraint) => {
      const migration = migrations.get(constraint.dimensionRef);
      if (!migration || !['Distance', 'Point Line Distance'].includes(constraint.type)) return constraint;
      const {
        anchors: unusedAnchors,
        orientation: unusedOrientation,
        projectionMode: unusedProjectionMode,
        ...rest
      } = constraint;
      return {
        ...rest,
        type: 'Line Line Distance',
        subtype: 'aligned',
        orientation: migration.orientation,
        featureRefs: [migration.lineToLine.reference, migration.lineToLine.measured],
      };
    }),
  };
}

function parallelEndpointDimension(first, second, pointer, mode, drawingUnit) {
  const geometry = supportingLineDimensionGeometry(first, second);
  return {
    type: 'dimension-line',
    dimensionMode: mode,
    measurementKind: 'parallel-edge-distance',
    subtype: 'aligned',
    orientation: Math.sign(geometry.signedDistance) || 1,
    start: geometry.projected,
    end: geometry.measuredPoint,
    measureStart: geometry.projected,
    measureEnd: geometry.measuredPoint,
    label: pointer,
    text: formatDrawingLengthSmart(geometry.measuredValue, drawingUnit),
    anchors: {
      lineToLine: {
        reference: segmentAnchor(first),
        measured: segmentAnchor(second),
      },
    },
    measuredValue: geometry.measuredValue,
    useRenderedMeasurement: mode === 'driven',
  };
}

function linesIntersection(a, b) {
  const r = subtractSmart(a.end, a.start);
  const s = subtractSmart(b.end, b.start);
  const denominator = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(denominator) < 0.0001) return null;
  const delta = subtractSmart(b.start, a.start);
  const t = (delta[0] * s[1] - delta[1] * s[0]) / denominator;
  return addSmart(a.start, scaleSmart(r, t));
}

function areParallel(a, b) {
  const first = unitSmart(subtractSmart(a.end, a.start));
  const second = unitSmart(subtractSmart(b.end, b.start));
  return Math.abs(crossSmart(first, second)) < 0.08;
}

function featuresTouch(a, b) {
  const tolerance = 8;
  const firstPoints = featureEndpoints(a);
  const secondPoints = featureEndpoints(b);
  if (!firstPoints.length || !secondPoints.length) return true;
  return firstPoints.some((first) => secondPoints.some((second) => pointDistanceSmart(first, second) <= tolerance));
}

function isSameFeature(a, b) {
  return a.kind === b.kind && a.recordId === b.recordId && a.index === b.index;
}

function distanceSubtype(start, end, pointer) {
  const center = midpointSmart(start, end);
  const dx = Math.abs(pointer[0] - center[0]);
  const dy = Math.abs(pointer[1] - center[1]);
  if (dx > dy * 1.55) return 'vertical';
  if (dy > dx * 1.55) return 'horizontal';
  return 'aligned';
}

function distanceOrientation(subtype, start, end) {
  if (subtype === 'horizontal') return Math.sign(end[0] - start[0]) || 1;
  if (subtype === 'vertical') return Math.sign(end[1] - start[1]) || 1;
  return null;
}

function distanceDimensionSmart(start, end, pointer, mode, sourceStart = start, sourceEnd = end, anchors = null, drawingUnit = 'in') {
  const subtype = distanceSubtype(start, end, pointer);
  const orientation = distanceOrientation(subtype, sourceStart, sourceEnd);
  const measured = subtype === 'horizontal'
    ? Math.abs(sourceEnd[0] - sourceStart[0])
    : subtype === 'vertical'
      ? Math.abs(sourceEnd[1] - sourceStart[1])
      : pointDistanceSmart(start, end);
  return {
    type: 'dimension-line',
    dimensionMode: mode,
    subtype,
    start,
    end,
    measureStart: sourceStart,
    measureEnd: sourceEnd,
    label: pointer,
    text: formatDrawingLengthSmart(measured, drawingUnit),
    anchors,
    measuredValue: measured,
    useRenderedMeasurement: mode === 'driven',
    ...(orientation ? { orientation } : {}),
  };
}

function linkedPositionAxis(start, end, pointer) {
  const routed = distanceSubtype(start, end, pointer);
  if (routed === 'horizontal' || routed === 'vertical') return routed;
  return Math.abs(end[0] - start[0]) >= Math.abs(end[1] - start[1])
    ? 'horizontal'
    : 'vertical';
}

function isOrdinaryGeometryPoint(feature) {
  return feature?.kind === 'point'
    && feature.recordId !== CANVAS_ORIGIN_RECORD_ID
    && !feature.linkedCopyId
    && !['control', 'notch', 'table', 'text'].includes(feature.entityType);
}

export function linkedPositionDimension(selections, pointer, drawingUnit = 'in') {
  const linked = selections.filter((feature) => feature?.linkedCopyId);
  if (!linked.length) return undefined;
  if (
    selections.length !== 2
    || linked.length !== 1
    || selections.some((feature) => feature.kind !== 'point')
  ) return null;
  const derived = linked[0];
  const other = selections.find((feature) => feature !== derived);
  if (derived.linkedPositionBlocked || !isOrdinaryGeometryPoint(other)) return null;
  const [first, second] = selections;
  const subtype = linkedPositionAxis(first.point, second.point, pointer);
  const axis = subtype === 'horizontal' ? 0 : 1;
  const perpendicularAxis = axis === 0 ? 1 : 0;
  const measured = Math.abs(second.point[axis] - first.point[axis]);
  const orientation = distanceOrientation(subtype, first.point, second.point);
  return {
    type: 'dimension-line',
    dimensionMode: 'driving',
    subtype,
    orientation,
    start: [...first.point],
    end: [...second.point],
    measureStart: [...first.point],
    measureEnd: [...second.point],
    label: [...pointer],
    text: formatDrawingLengthSmart(measured, drawingUnit),
    measuredValue: measured,
    useRenderedMeasurement: false,
    anchors: {
      start: pointAnchor(first),
      end: pointAnchor(second),
      measureStart: pointAnchor(first),
      measureEnd: pointAnchor(second),
    },
    externalDrivingTarget: {
      type: 'linked-position',
      recordId: derived.recordId,
      copyId: derived.linkedCopyId,
      sourceId: derived.linkedSourceId,
      pointIndex: derived.index,
      otherAnchor: pointAnchor(other),
      axis: subtype,
      axisSign: Math.sign(derived.point[axis] - other.point[axis]) || 1,
      perpendicularOffset: derived.point[perpendicularAxis] - other.point[perpendicularAxis],
    },
  };
}

function angleBetweenSegments(first, second, pointer, mode) {
  const vertex = linesIntersection(first, second) || first.end;
  const firstBaseVector = unitSmart(subtractSmart(first.end, first.start));
  const secondBaseVector = unitSmart(subtractSmart(second.end, second.start));
  const pointerAngle = Math.atan2(pointer[1] - vertex[1], pointer[0] - vertex[0]);
  const angleDistanceDiff = (firstAngle, secondAngle) => {
    const difference = Math.atan2(
      Math.sin(firstAngle - secondAngle),
      Math.cos(firstAngle - secondAngle),
    );
    return Math.abs(difference);
  };
  const rayOptions = [1, -1].flatMap((firstRaySign) => [1, -1].map((secondRaySign) => {
    const firstVector = scaleSmart(firstBaseVector, firstRaySign);
    const secondVector = scaleSmart(secondBaseVector, secondRaySign);
    const signedAngle = Math.atan2(crossSmart(firstVector, secondVector), dotSmart(firstVector, secondVector));
    const firstAngle = Math.atan2(firstVector[1], firstVector[0]);
    const middleAngle = firstAngle + signedAngle / 2;
    return {
      firstRaySign,
      secondRaySign,
      signedAngle,
      score: angleDistanceDiff(pointerAngle, middleAngle),
    };
  }));
  const selectedRays = rayOptions.reduce(
    (best, option) => (option.score < best.score ? option : best),
    rayOptions[0],
  );
  const { firstRaySign, secondRaySign, signedAngle } = selectedRays;
  const firstVector = scaleSmart(firstBaseVector, firstRaySign);
  const secondVector = scaleSmart(secondBaseVector, secondRaySign);
  const measuredValue = Math.abs(signedAngle) * 180 / Math.PI;
  return {
    type: 'angle-dimension',
    dimensionMode: mode,
    vertex,
    start: addSmart(vertex, scaleSmart(firstVector, 80)),
    end: addSmart(vertex, scaleSmart(secondVector, 80)),
    radius: Math.max(24, pointDistanceSmart(vertex, pointer)),
    label: pointer,
    text: '0 deg',
    measuredValue,
    angleRayLocked: true,
    firstRaySign,
    secondRaySign,
    angleOrientation: Math.sign(signedAngle) || 1,
    useRenderedMeasurement: mode === 'driven',
    anchors: {
      firstSegment: segmentEndpointAnchors(first),
      secondSegment: segmentEndpointAnchors(second),
    },
  };
}

function radiusDimension(feature, pointer, mode, drawingUnit) {
  const subtype = feature.kind === 'circle' ? 'diameter' : 'radius';
  const measuredValue = subtype === 'diameter' ? feature.radius * 2 : feature.radius;
  return {
    type: 'radius-dimension',
    subtype,
    dimensionMode: mode,
    center: feature.center,
    radius: feature.radius,
    elbow: pointer,
    label: pointer,
    text: formatDrawingLengthSmart(measuredValue, drawingUnit),
    measuredValue,
    useRenderedMeasurement: mode === 'driven',
    anchors: {
      center: entityCenterAnchor(feature),
      radius: entityRadiusAnchor(feature),
    },
  };
}

function mclDimension(features, pointer, drawingUnit) {
  const targetFeature = features[0];
  const target = featureTargetPoint(targetFeature);
  const total = features.reduce((sum, feature) => sum + featureLength(feature), 0);
  return {
    type: 'multi-curve-length-dimension',
    dimensionMode: 'driven',
    target,
    elbow: pointer,
    label: pointer,
    text: formatDrawingLengthSmart(total, drawingUnit),
    measuredValue: total,
    useRenderedMeasurement: true,
    anchors: {
      features: features.map((feature) => ({
        kind: feature.kind,
        recordId: feature.recordId,
        index: feature.index,
      })),
    },
  };
}

export function candidateFromSelections(selections, pointer, mode, ctrlMcl = false, drawingUnit = 'in') {
  if (ctrlMcl && mode === 'driven' && selections.length) return mclDimension(selections, pointer, drawingUnit);
  if (mode === 'driving') {
    const linkedPosition = linkedPositionDimension(selections, pointer, drawingUnit);
    if (linkedPosition !== undefined) return linkedPosition;
  }
  if (selections.length === 1) {
    const [feature] = selections;
    if (mode === 'driven' && feature.finishSize && feature.kind === 'curve') {
      return mclDimension([feature], pointer, drawingUnit);
    }
    if (feature.kind === 'circle' || feature.kind === 'arc') return radiusDimension(feature, pointer, mode, drawingUnit);
    if (feature.kind === 'segment') {
      const anchors = segmentEndpointAnchors(feature);
      return distanceDimensionSmart(feature.start, feature.end, pointer, mode, feature.start, feature.end, {
        start: anchors?.start,
        end: anchors?.end,
        measureStart: anchors?.start,
        measureEnd: anchors?.end,
      }, drawingUnit);
    }
  }
  if (selections.length === 2) {
    const [first, second] = selections;
    if (first.kind === 'point' && second.kind === 'point') {
      const dimension = distanceDimensionSmart(first.point, second.point, pointer, mode, first.point, second.point, {
        start: pointAnchor(first),
        end: pointAnchor(second),
        measureStart: pointAnchor(first),
        measureEnd: pointAnchor(second),
      }, drawingUnit);
      const notch = first.entityType === 'notch' ? first : second.entityType === 'notch' ? second : null;
      const other = notch === first ? second : first;
      if (mode === 'driving' && notch) {
        dimension.externalDrivingTarget = {
          type: 'notch-distance',
          recordId: notch.recordId,
          otherAnchor: pointAnchor(other),
        };
      }
      return dimension;
    }
    if (first.kind === 'point' && second.kind === 'segment') {
      const projected = projectionOnSegmentSmart(first.point, second);
      const dimension = distanceDimensionSmart(projected, first.point, pointer, mode, projected, first.point, {
        pointToSegment: { point: pointAnchor(first), segment: segmentAnchor(second) },
      }, drawingUnit);
      if (mode === 'driving' && first.entityType === 'notch') {
        dimension.externalDrivingTarget = {
          type: 'notch-distance',
          recordId: first.recordId,
          otherSegment: segmentAnchor(second),
        };
      }
      return dimension;
    }
    if (first.kind === 'segment' && second.kind === 'point') {
      const projected = projectionOnSegmentSmart(second.point, first);
      const dimension = distanceDimensionSmart(projected, second.point, pointer, mode, projected, second.point, {
        pointToSegment: { point: pointAnchor(second), segment: segmentAnchor(first) },
      }, drawingUnit);
      if (mode === 'driving' && second.entityType === 'notch') {
        dimension.externalDrivingTarget = {
          type: 'notch-distance',
          recordId: second.recordId,
          otherSegment: segmentAnchor(first),
        };
      }
      return dimension;
    }
    if (first.kind === 'segment' && second.kind === 'segment') {
      if (areParallel(first, second)) {
        return parallelEndpointDimension(first, second, pointer, mode, drawingUnit);
      }
      return angleBetweenSegments(first, second, pointer, mode);
    }
  }
  return null;
}

export function radialCandidateUsesPlacementClick(candidate, mode, event = {}) {
  return candidate?.type === 'radius-dimension'
    && !(mode === 'driven' && event.ctrlKey);
}

export function setDimensionSelectionActive(canvas, active) {
  const canvasElement = canvas?.getCanvasElement?.();
  canvasElement?.classList?.toggle('dimension-selection-active', Boolean(active));
}

export function createSmartDimensionTools({ toolbar, canvas }) {
  let activeMode = null;
  let selections = [];
  let candidate = null;
  let ctrlMcl = false;
  const buttons = [...toolbar.querySelectorAll('[data-dimension-tool]')];

  function clearSelections() {
    selections = [];
    candidate = null;
    ctrlMcl = false;
    canvas.setSmartDimensionFeatureSelection([]);
    canvas.clearPreview();
  }

  function deactivate() {
    activeMode = null;
    setDimensionSelectionActive(canvas, false);
    canvas.setOriginPointEnabled?.(false);
    canvas.setPointHandlesEnabled?.(true);
    clearSelections();
    buttons.forEach((button) => {
      button.classList.remove('active');
      button.setAttribute('aria-pressed', 'false');
    });
    canvas.setSmartDimensionDelegate(null);
  }

  function setActiveMode(mode) {
    const nextMode = activeMode === mode ? null : mode;
    if (!nextMode) {
      deactivate();
      return;
    }
    window.dispatchEvent(new CustomEvent('paramagic:tool-activated', { detail: { source: 'dimension' } }));
    activeMode = nextMode;
    setDimensionSelectionActive(canvas, true);
    canvas.setOriginPointEnabled?.(true);
    canvas.setPointHandlesEnabled?.(true);
    clearSelections();
    buttons.forEach((button) => {
      const isActive = (button.dataset.dimensionTool.includes('Driven') ? 'driven' : 'driving') === activeMode;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
    canvas.setSmartDimensionDelegate(delegate);
  }

  function updateCandidate(pointer) {
    candidate = candidateFromSelections(selections, pointer, activeMode, ctrlMcl, canvas.getDrawingUnit?.() || 'in');
    if (candidate) canvas.setDimensionPreview(candidate);
    else canvas.clearPreview();
  }

  function addSelection(feature, event) {
    if (!feature) return;
    const shouldUseMcl = activeMode === 'driven' && (event.ctrlKey || ctrlMcl);
    if (shouldUseMcl) {
      ctrlMcl = true;
      if (!['segment', 'arc', 'circle', 'curve'].includes(feature.kind)) return;
      selections = selections.filter((selected) => ['segment', 'arc', 'circle', 'curve'].includes(selected.kind));
      if (selections.some((selected) => isSameFeature(selected, feature))) return;
      if (!selections.length || selections.some((selected) => featuresTouch(selected, feature))) selections.push(feature);
      return;
    }
    ctrlMcl = false;
    if (selections.some((selected) => isSameFeature(selected, feature))) {
      selections = selections.filter((selected) => !isSameFeature(selected, feature));
      return;
    }
    selections = selections.length >= 2 ? [feature] : [...selections, feature];
  }

  function placeCandidate() {
    if (!candidate) return false;
    const completedMode = activeMode;
    canvas.addDimension(candidate);
    deactivate();
    rememberRepeatableTool(() => {
      if (activeMode) return false;
      setActiveMode(completedMode);
      return true;
    });
    return true;
  }

  const delegate = {
    get mode() {
      return activeMode;
    },
    pointerDown(event) {
      if (!activeMode || event.button !== 0) return false;
      const pointer = canvas.screenToWorld(event.clientX, event.clientY);
      if (radialCandidateUsesPlacementClick(candidate, activeMode, event)) {
        updateCandidate(pointer);
        if (placeCandidate()) {
          event.preventDefault();
          event.stopPropagation();
          return true;
        }
      }
      const feature = canvas.getFeatureFromEvent(event, {
        rendered: true,
        dimensionMode: activeMode,
      });
      if (!feature && placeCandidate()) {
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      if (!feature) return true;
      if (feature.finishSize && activeMode !== 'driven') return true;
      event.preventDefault();
      event.stopPropagation();
      addSelection(
        feature.kind === 'segment' ? { ...feature, pickPoint: [...pointer] } : feature,
        event,
      );
      canvas.setSmartDimensionFeatureSelection(selections);
      updateCandidate(pointer);
      return true;
    },
    pointerMove(event) {
      if (!activeMode || !selections.length) return false;
      updateCandidate(canvas.screenToWorld(event.clientX, event.clientY));
      return false;
    },
    keyDown(event) {
      if (!activeMode) return false;
      if (event.key === 'Escape') {
        deactivate();
        event.preventDefault();
        return true;
      }
      if (event.key === 'Enter' && placeCandidate()) {
        event.preventDefault();
        return true;
      }
      return false;
    },
  };

  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      setActiveMode(button.dataset.dimensionTool.includes('Driven') ? 'driven' : 'driving');
    });
  });

  window.addEventListener('paramagic:tool-activated', (event) => {
    if (event.detail?.source !== 'dimension') deactivate();
  });

  return { clearSelections, deactivate };
}
