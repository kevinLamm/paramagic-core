import { isCanvasOriginReference } from '../CanvasOrigin.js';
import { isArcMidpointReference } from '../ArcGeometry.js';
import { evaluateFillet } from '../FilletSystem.js';

const DIFFERENTIABILITY_EPSILON = 1e-9;
const TAU = Math.PI * 2;

const dot = (first, second) => first[0] * second[0] + first[1] * second[1];
const cross = (first, second) => first[0] * second[1] - first[1] * second[0];
const normalizeAngle = (angle) => (angle + TAU) % TAU;

function addDerivative(derivatives, variableId, value) {
  derivatives.set(variableId, (derivatives.get(variableId) || 0) + value);
}

function addScaledGradient(target, source, multiplier = 1) {
  for (const [variableId, derivative] of source) addDerivative(target, variableId, derivative * multiplier);
}

function directPoint(binding, prefix) {
  const x = binding.variables.get(`${prefix}.x`);
  const y = binding.variables.get(`${prefix}.y`);
  if (!x || !y) return null;
  return {
    value: [x.value, y.value],
    derivatives: new Map([[x.id, [1, 0]], [y.id, [0, 1]]]),
  };
}

function tablePoint(binding, index) {
  const x = binding.variables.get('x');
  const y = binding.variables.get('y');
  const width = binding.variables.get('width');
  const height = binding.variables.get('height');
  if (!x || !y || !width || !height) return null;
  const points = [
    [x.value, y.value],
    [x.value + width.value, y.value],
    [x.value + width.value, y.value + height.value],
    [x.value, y.value + height.value],
  ];
  const value = points[index];
  if (!value) return null;
  const derivatives = new Map();
  const add = (variable, derivative) => derivatives.set(variable.id, derivative);
  add(x, [1, 0]);
  add(y, [0, 1]);
  if (index === 1 || index === 2) add(width, [1, 0]);
  if (index === 2 || index === 3) add(height, [0, 1]);
  return { value, derivatives };
}

function combinePoints(points) {
  const value = [0, 0];
  const derivatives = new Map();
  for (const { point, weight } of points) {
    value[0] += point.value[0] * weight;
    value[1] += point.value[1] * weight;
    for (const [variableId, derivative] of point.derivatives) {
      const current = derivatives.get(variableId) || [0, 0];
      derivatives.set(variableId, [
        current[0] + derivative[0] * weight,
        current[1] + derivative[1] * weight,
      ]);
    }
  }
  return { value, derivatives };
}

function bindingPoint(binding, index) {
  if (binding.type === 'point') return index === 0 ? directPoint(binding, 'point') : null;
  if (binding.type === 'text') return index === 0 ? directPoint(binding, 'anchor') : null;
  if (binding.type === 'control') {
    if (index === 0) return directPoint(binding, 'anchor');
    if (index === 1) return directPoint(binding, 'middle');
    return null;
  }
  if (binding.type === 'table') return tablePoint(binding, index);
  if (binding.type === 'line') {
    if (index === 0) return directPoint(binding, 'start');
    if (index === 2) return directPoint(binding, 'end');
    if (index === 1) {
      return combinePoints([
        { point: directPoint(binding, 'start'), weight: 0.5 },
        { point: directPoint(binding, 'end'), weight: 0.5 },
      ]);
    }
    return null;
  }
  if (['polygon', 'polyline', 'curve'].includes(binding.type)) {
    return index >= 0 && index < binding.metadata.pointCount ? directPoint(binding, `p${index}`) : null;
  }
  if (binding.type === 'circle') {
    const center = directPoint(binding, 'center');
    if (index === 0) return center;
    const directions = [null, [-1, 0], [0, -1], [1, 0], [0, 1]];
    const direction = directions[index];
    const radius = binding.variables.get('radius');
    if (!center || !direction || !radius) return null;
    const sign = Math.sign(radius.value) || 1;
    const derivatives = new Map(center.derivatives);
    derivatives.set(radius.id, [direction[0] * sign, direction[1] * sign]);
    return {
      value: [
        center.value[0] + direction[0] * Math.abs(radius.value),
        center.value[1] + direction[1] * Math.abs(radius.value),
      ],
      derivatives,
    };
  }
  if (binding.type === 'arc') {
    if (index === 0) return directPoint(binding, 'start');
    if (index === 2) return directPoint(binding, 'end');
    if (index === 3) return directPoint(binding, 'center');
    return null;
  }
  return null;
}

function segmentPoints(model, reference) {
  const binding = model.binding(reference?.recordId || reference?.entityId);
  const index = Number(reference?.index) || 0;
  if (!binding) return null;
  if (binding.type === 'line' && index === 0) {
    return { start: directPoint(binding, 'start'), end: directPoint(binding, 'end') };
  }
  if (binding.type === 'table' && index >= 0 && index < 4) {
    return {
      start: tablePoint(binding, index),
      end: tablePoint(binding, (index + 1) % 4),
    };
  }
  if (binding.type === 'polygon' || binding.type === 'polyline') {
    const closed = binding.type === 'polygon';
    const limit = closed ? binding.metadata.pointCount : binding.metadata.pointCount - 1;
    if (index < 0 || index >= limit) return null;
    return {
      start: directPoint(binding, `p${index}`),
      end: directPoint(binding, `p${(index + 1) % binding.metadata.pointCount}`),
    };
  }
  return null;
}

function vectorBetween(start, end) {
  const derivatives = new Map();
  for (const [variableId, derivative] of start.derivatives) {
    derivatives.set(variableId, [-derivative[0], -derivative[1]]);
  }
  for (const [variableId, derivative] of end.derivatives) {
    const current = derivatives.get(variableId) || [0, 0];
    derivatives.set(variableId, [current[0] + derivative[0], current[1] + derivative[1]]);
  }
  return {
    value: [end.value[0] - start.value[0], end.value[1] - start.value[1]],
    derivatives,
  };
}

function bilinearScalar(first, second, operation) {
  const value = operation === 'cross'
    ? cross(first.value, second.value)
    : dot(first.value, second.value);
  const gradient = new Map();
  const variableIds = new Set([...first.derivatives.keys(), ...second.derivatives.keys()]);
  for (const variableId of variableIds) {
    const firstDerivative = first.derivatives.get(variableId) || [0, 0];
    const secondDerivative = second.derivatives.get(variableId) || [0, 0];
    const derivative = operation === 'cross'
      ? cross(firstDerivative, second.value) + cross(first.value, secondDerivative)
      : dot(firstDerivative, second.value) + dot(first.value, secondDerivative);
    gradient.set(variableId, derivative);
  }
  return { value, gradient };
}

function squaredLengthScalar(vector) {
  const gradient = new Map();
  for (const [variableId, derivative] of vector.derivatives) {
    gradient.set(variableId, 2 * dot(vector.value, derivative));
  }
  return { value: dot(vector.value, vector.value), gradient };
}

function lengthScalar(vector) {
  const value = Math.hypot(...vector.value);
  if (value < DIFFERENTIABILITY_EPSILON) return null;
  const gradient = new Map();
  for (const [variableId, derivative] of vector.derivatives) {
    gradient.set(variableId, dot(vector.value, derivative) / value);
  }
  return { value, gradient };
}

function normalizedVector(vector) {
  const size = lengthScalar(vector);
  if (!size) return null;
  const derivatives = new Map();
  for (const [variableId, derivative] of vector.derivatives) {
    const sizeDerivative = size.gradient.get(variableId) || 0;
    derivatives.set(variableId, [
      derivative[0] / size.value - vector.value[0] * sizeDerivative / (size.value ** 2),
      derivative[1] / size.value - vector.value[1] * sizeDerivative / (size.value ** 2),
    ]);
  }
  return {
    value: [vector.value[0] / size.value, vector.value[1] / size.value],
    derivatives,
  };
}

function perpendicularVector(vector) {
  return {
    value: [-vector.value[1], vector.value[0]],
    derivatives: new Map([...vector.derivatives].map(([variableId, derivative]) => (
      [variableId, [-derivative[1], derivative[0]]]
    ))),
  };
}

function scaledVector(vector, scalar) {
  const derivatives = new Map();
  const variableIds = new Set([...vector.derivatives.keys(), ...scalar.gradient.keys()]);
  for (const variableId of variableIds) {
    const vectorDerivative = vector.derivatives.get(variableId) || [0, 0];
    const scalarDerivative = scalar.gradient.get(variableId) || 0;
    derivatives.set(variableId, [
      vectorDerivative[0] * scalar.value + vector.value[0] * scalarDerivative,
      vectorDerivative[1] * scalar.value + vector.value[1] * scalarDerivative,
    ]);
  }
  return {
    value: [vector.value[0] * scalar.value, vector.value[1] * scalar.value],
    derivatives,
  };
}

function translatedPoint(point, vector) {
  const derivatives = new Map(point.derivatives);
  for (const [variableId, derivative] of vector.derivatives) {
    const current = derivatives.get(variableId) || [0, 0];
    derivatives.set(variableId, [current[0] + derivative[0], current[1] + derivative[1]]);
  }
  return {
    value: [point.value[0] + vector.value[0], point.value[1] + vector.value[1]],
    derivatives,
  };
}

function productScalar(first, second) {
  const gradient = new Map();
  addScaledGradient(gradient, first.gradient, second.value);
  addScaledGradient(gradient, second.gradient, first.value);
  return { value: first.value * second.value, gradient };
}

function squareScalar(scalar) {
  return {
    value: scalar.value ** 2,
    gradient: new Map([...scalar.gradient].map(([id, derivative]) => [id, 2 * scalar.value * derivative])),
  };
}

function sumScalar(first, second, secondMultiplier = 1) {
  const gradient = new Map();
  addScaledGradient(gradient, first.gradient);
  addScaledGradient(gradient, second.gradient, secondMultiplier);
  return { value: first.value + second.value * secondMultiplier, gradient };
}

function quotientScalar(numerator, denominator) {
  if (Math.abs(denominator.value) < DIFFERENTIABILITY_EPSILON) return null;
  const gradient = new Map();
  addScaledGradient(gradient, numerator.gradient, 1 / denominator.value);
  addScaledGradient(gradient, denominator.gradient, -numerator.value / (denominator.value ** 2));
  return { value: numerator.value / denominator.value, gradient };
}

function normalizedByScale(numerator, scaleCandidate) {
  const tolerance = DIFFERENTIABILITY_EPSILON * Math.max(1, Math.abs(scaleCandidate.value));
  if (Math.abs(scaleCandidate.value - 1) <= tolerance) return null;
  const scale = Math.max(1, Math.abs(scaleCandidate.value));
  const scaleGradient = scaleCandidate.value > 1
    ? scaleCandidate.gradient
    : scaleCandidate.value < -1
      ? new Map([...scaleCandidate.gradient].map(([id, derivative]) => [id, -derivative]))
      : new Map();
  const gradient = new Map();
  addScaledGradient(gradient, numerator.gradient, 1 / scale);
  addScaledGradient(gradient, scaleGradient, -numerator.value / (scale ** 2));
  return { value: numerator.value / scale, gradient };
}

function normalizedDifference(first, second) {
  const numerator = { value: first.value - second.value, gradient: new Map() };
  addScaledGradient(numerator.gradient, first.gradient);
  addScaledGradient(numerator.gradient, second.gradient, -1);
  const scale = Math.max(1, Math.abs(first.value), Math.abs(second.value));
  const tolerance = DIFFERENTIABILITY_EPSILON * scale;
  let scaleGradient = new Map();
  if (Math.abs(first.value - second.value) <= tolerance && scale > 1 + tolerance) {
    // The numerator is zero at an equal-magnitude tie, so the derivative of
    // the piecewise denominator makes no first-order contribution.
    scaleGradient = new Map();
  } else if (Math.abs(Math.abs(first.value) - scale) <= tolerance) {
    if (Math.abs(Math.abs(first.value) - 1) <= tolerance) return null;
    scaleGradient = new Map([...first.gradient].map(([id, derivative]) => [id, Math.sign(first.value) * derivative]));
  } else if (Math.abs(Math.abs(second.value) - scale) <= tolerance) {
    if (Math.abs(Math.abs(second.value) - 1) <= tolerance) return null;
    scaleGradient = new Map([...second.gradient].map(([id, derivative]) => [id, Math.sign(second.value) * derivative]));
  }
  const gradient = new Map();
  addScaledGradient(gradient, numerator.gradient, 1 / scale);
  addScaledGradient(gradient, scaleGradient, -numerator.value / (scale ** 2));
  return { value: numerator.value / scale, gradient };
}

function pointValueAndDerivatives(model, reference) {
  if (!reference) return null;
  if (isCanvasOriginReference(reference)) return { value: [0, 0], derivatives: new Map() };
  if (isArcMidpointReference(reference)) return null;
  if (reference.type === 'segment-start' || reference.type === 'segment-end' || reference.type === 'segment-point') {
    const segment = segmentPoints(model, reference);
    if (!segment) return null;
    if (reference.type === 'segment-start') return segment.start;
    if (reference.type === 'segment-end') return segment.end;
    const ratio = Math.max(0, Math.min(1, Number(reference.ratio) || 0));
    return combinePoints([
      { point: segment.start, weight: 1 - ratio },
      { point: segment.end, weight: ratio },
    ]);
  }
  const binding = model.binding(reference.recordId || reference.entityId);
  if (!binding) return null;
  if (reference.type === 'center') return directPoint(binding, 'center');
  return bindingPoint(binding, Number(reference.index) || 0);
}

function entityCenter(model, reference) {
  const binding = model.binding(reference?.recordId || reference?.entityId);
  if (!binding || (binding.type !== 'circle' && binding.type !== 'arc')) return null;
  return directPoint(binding, 'center');
}

function accumulatePointGradient(gradient, point, coordinateGradient, multiplier = 1) {
  for (const [variableId, derivative] of point.derivatives) {
    addDerivative(
      gradient,
      variableId,
      multiplier * (coordinateGradient[0] * derivative[0] + coordinateGradient[1] * derivative[1]),
    );
  }
}

function pointDifferenceRows(first, second) {
  const x = new Map();
  const y = new Map();
  accumulatePointGradient(x, first, [1, 0]);
  accumulatePointGradient(x, second, [1, 0], -1);
  accumulatePointGradient(y, first, [0, 1]);
  accumulatePointGradient(y, second, [0, 1], -1);
  return [x, y];
}

function matrixFromRows(rows, variables) {
  return rows.map((row) => variables.map((variable) => row.get(variable.id) || 0));
}

function targetValue(constraint, dimensions) {
  if (constraint.dimensionRef) return dimensions.value(constraint.dimensionRef);
  return Number.isFinite(constraint.value) ? constraint.value : null;
}

function radiusValueAndGradient(model, reference) {
  const binding = model.binding(reference?.recordId || reference?.entityId);
  if (!binding) return null;
  if (binding.type === 'circle') {
    const radius = binding.variables.get('radius');
    if (!radius) return null;
    return {
      value: Math.abs(radius.value),
      gradient: new Map([[radius.id, Math.sign(radius.value) || 1]]),
    };
  }
  if (binding.type !== 'arc') return null;
  const metrics = binding.arcMetrics?.();
  if (!metrics) return null;
  const center = directPoint(binding, 'center');
  const start = directPoint(binding, 'start');
  const end = directPoint(binding, 'end');
  const startVector = metrics.startVector;
  const endVector = metrics.endVector;
  const startLength = metrics.startRadius;
  const endLength = metrics.endRadius;
  if (startLength < DIFFERENTIABILITY_EPSILON || endLength < DIFFERENTIABILITY_EPSILON) return null;
  const gradient = new Map();
  accumulatePointGradient(gradient, start, startVector, 0.5 / startLength);
  accumulatePointGradient(gradient, center, startVector, -0.5 / startLength);
  accumulatePointGradient(gradient, end, endVector, 0.5 / endLength);
  accumulatePointGradient(gradient, center, endVector, -0.5 / endLength);
  return { value: (startLength + endLength) / 2, gradient };
}

function roundGeometry(model, reference) {
  const center = entityCenter(model, reference);
  const radius = radiusValueAndGradient(model, reference);
  return center && radius ? { center, radius } : null;
}

function arcLengthValueAndGradient(model, reference) {
  const binding = model.binding(reference?.recordId || reference?.entityId);
  if (binding?.type !== 'arc') return null;
  const metrics = binding.arcMetrics?.();
  if (!metrics) return null;
  const center = directPoint(binding, 'center');
  const start = directPoint(binding, 'start');
  const end = directPoint(binding, 'end');
  const startVector = vectorBetween(center, start);
  const endVector = vectorBetween(center, end);
  const startSquared = metrics.startSquared;
  const endSquared = metrics.endSquared;
  if (startSquared < DIFFERENTIABILITY_EPSILON || endSquared < DIFFERENTIABILITY_EPSILON) return null;
  const startAngle = metrics.startAngle;
  const endAngle = metrics.endAngle;
  const sweepValue = metrics.sweep;
  if (sweepValue < DIFFERENTIABILITY_EPSILON || TAU - sweepValue < DIFFERENTIABILITY_EPSILON) return null;
  const angleScalar = (vector, angle, squaredLength) => {
    const coordinateGradient = [-vector.value[1] / squaredLength, vector.value[0] / squaredLength];
    const gradient = new Map();
    for (const [variableId, derivative] of vector.derivatives) {
      gradient.set(variableId, dot(coordinateGradient, derivative));
    }
    return { value: angle, gradient };
  };
  const startAngleScalar = angleScalar(startVector, startAngle, startSquared);
  const endAngleScalar = angleScalar(endVector, endAngle, endSquared);
  const sweep = { value: sweepValue, gradient: new Map() };
  addScaledGradient(sweep.gradient, metrics.ccw ? endAngleScalar.gradient : startAngleScalar.gradient);
  addScaledGradient(sweep.gradient, metrics.ccw ? startAngleScalar.gradient : endAngleScalar.gradient, -1);
  return productScalar(radiusValueAndGradient(model, reference), sweep);
}

function segmentSquaredLength(model, reference) {
  const segment = segmentPoints(model, reference);
  return segment ? squaredLengthScalar(vectorBetween(segment.start, segment.end)) : null;
}

function coincident({ model, constraint, variables }) {
  const [first, second] = (constraint.featureRefs || []).map((reference) => pointValueAndDerivatives(model, reference));
  if (!first || !second) return null;
  return matrixFromRows(pointDifferenceRows(first, second), variables);
}

function axisAligned({ model, constraint, variables }, coordinate) {
  const line = segmentPoints(model, constraint.featureRefs?.[0]);
  if (!line) return null;
  const row = new Map();
  accumulatePointGradient(row, line.start, coordinate === 0 ? [1, 0] : [0, 1]);
  accumulatePointGradient(row, line.end, coordinate === 0 ? [1, 0] : [0, 1], -1);
  return matrixFromRows([row], variables);
}

function distance({ model, constraint, dimensions, variables }) {
  const first = pointValueAndDerivatives(model, constraint.anchors?.start || constraint.featureRefs?.[0]);
  const second = pointValueAndDerivatives(model, constraint.anchors?.end || constraint.featureRefs?.[1]);
  const desired = targetValue(constraint, dimensions);
  if (!first || !second || !Number.isFinite(desired)) return null;
  const delta = [first.value[0] - second.value[0], first.value[1] - second.value[1]];
  const measuredSquared = delta[0] ** 2 + delta[1] ** 2;
  const desiredSquared = desired ** 2;
  const fixedScale = Math.max(1, desiredSquared);
  const scaleTolerance = DIFFERENTIABILITY_EPSILON * Math.max(1, measuredSquared, desiredSquared);
  if (Math.abs(measuredSquared - fixedScale) <= scaleTolerance && measuredSquared !== desiredSquared) return null;
  const residualDerivative = measuredSquared > fixedScale
    ? desiredSquared / (measuredSquared ** 2)
    : 1 / fixedScale;
  const row = new Map();
  accumulatePointGradient(row, first, delta, 2 * residualDerivative);
  accumulatePointGradient(row, second, delta, -2 * residualDerivative);
  return matrixFromRows([row], variables);
}

function axisDistance({ model, constraint, dimensions, variables }, coordinate) {
  const first = pointValueAndDerivatives(model, constraint.anchors?.start || constraint.featureRefs?.[0]);
  const second = pointValueAndDerivatives(model, constraint.anchors?.end || constraint.featureRefs?.[1]);
  const desired = targetValue(constraint, dimensions);
  if (!first || !second || !Number.isFinite(desired)) return null;
  const row = new Map();
  accumulatePointGradient(row, second, coordinate === 0 ? [1, 0] : [0, 1]);
  accumulatePointGradient(row, first, coordinate === 0 ? [1, 0] : [0, 1], -1);
  return matrixFromRows([row], variables);
}

function projectedPointOnSegment(point, line, projectionMode = 'segment') {
  const direction = vectorBetween(line.start, line.end);
  const directionSquared = squaredLengthScalar(direction);
  if (directionSquared.value < DIFFERENTIABILITY_EPSILON) return null;
  const offset = vectorBetween(line.start, point);
  const ratio = quotientScalar(bilinearScalar(offset, direction, 'dot'), directionSquared);
  if (!ratio) return null;
  if (projectionMode === 'line') return translatedPoint(line.start, scaledVector(direction, ratio));
  const boundaryTolerance = DIFFERENTIABILITY_EPSILON * Math.max(1, Math.abs(ratio.value));
  if (Math.abs(ratio.value) <= boundaryTolerance || Math.abs(ratio.value - 1) <= boundaryTolerance) return null;
  const clampedRatio = ratio.value <= 0
    ? { value: 0, gradient: new Map() }
    : ratio.value >= 1
      ? { value: 1, gradient: new Map() }
      : ratio;
  return translatedPoint(line.start, scaledVector(direction, clampedRatio));
}

function pointLineDistance({ model, constraint, dimensions, variables }) {
  const point = pointValueAndDerivatives(model, constraint.featureRefs?.[0]);
  const line = segmentPoints(model, constraint.featureRefs?.[1]);
  const desired = targetValue(constraint, dimensions);
  if (!point || !line || !Number.isFinite(desired)) return null;
  const projected = projectedPointOnSegment(point, line, constraint.projectionMode);
  if (!projected) return null;
  if (constraint.subtype === 'horizontal' || constraint.subtype === 'vertical') {
    const coordinate = constraint.subtype === 'horizontal' ? 0 : 1;
    const row = new Map();
    accumulatePointGradient(row, point, coordinate === 0 ? [1, 0] : [0, 1]);
    accumulatePointGradient(row, projected, coordinate === 0 ? [1, 0] : [0, 1], -1);
    return matrixFromRows([row], variables);
  }
  const measuredSquared = squaredLengthScalar(vectorBetween(projected, point));
  const normalized = normalizedDifference(measuredSquared, { value: desired ** 2, gradient: new Map() });
  return normalized ? matrixFromRows([normalized.gradient], variables) : null;
}

function lineLineDistance({ model, constraint, dimensions, variables }) {
  const [reference, measured] = (constraint.featureRefs || []).map((reference) => segmentPoints(model, reference));
  const desired = targetValue(constraint, dimensions);
  if (!reference || !measured || !Number.isFinite(desired)) return null;
  const referenceVector = vectorBetween(reference.start, reference.end);
  const measuredVector = vectorBetween(measured.start, measured.end);
  const referenceLength = lengthScalar(referenceVector);
  const measuredLength = lengthScalar(measuredVector);
  if (!referenceLength || !measuredLength) return null;
  const parallel = normalizedByScale(
    bilinearScalar(referenceVector, measuredVector, 'cross'),
    productScalar(referenceLength, measuredLength),
  );
  const measuredMidpoint = translatedPoint(
    measured.start,
    scaledVector(vectorBetween(measured.start, measured.end), { value: 0.5, gradient: new Map() }),
  );
  const signedNumerator = bilinearScalar(
    referenceVector,
    vectorBetween(reference.start, measuredMidpoint),
    'cross',
  );
  const signedDistance = quotientScalar(
    signedNumerator,
    referenceLength,
  );
  if (!parallel || !signedDistance) return null;
  return matrixFromRows([parallel.gradient, signedDistance.gradient], variables);
}

function roundSize(context, multiplier) {
  const round = radiusValueAndGradient(context.model, context.constraint.featureRefs?.[0]);
  if (!round) return null;
  return matrixFromRows([
    new Map([...round.gradient].map(([variableId, derivative]) => [variableId, derivative * multiplier])),
  ], context.variables);
}

function concentric({ model, constraint, variables }) {
  const [first, second] = (constraint.featureRefs || []).map((reference) => entityCenter(model, reference));
  if (!first || !second) return null;
  return matrixFromRows(pointDifferenceRows(first, second), variables);
}

function parallelOrPerpendicular({ model, constraint, variables }, operation) {
  const [first, second] = (constraint.featureRefs || []).map((reference) => segmentPoints(model, reference));
  if (!first || !second) return null;
  const firstVector = vectorBetween(first.start, first.end);
  const secondVector = vectorBetween(second.start, second.end);
  const firstLength = lengthScalar(firstVector);
  const secondLength = lengthScalar(secondVector);
  if (!firstLength || !secondLength) return null;
  const normalized = normalizedByScale(
    bilinearScalar(firstVector, secondVector, operation),
    productScalar(firstLength, secondLength),
  );
  return normalized ? matrixFromRows([normalized.gradient], variables) : null;
}

function equal({ model, constraint, variables }) {
  const references = constraint.featureRefs || [];
  if (references.length !== 2 || references[0]?.kind !== references[1]?.kind) return null;
  let values;
  if (references[0].kind === 'segment') {
    values = references.map((reference) => segmentSquaredLength(model, reference));
  } else if (references[0].kind === 'circle') {
    values = references.map((reference) => radiusValueAndGradient(model, reference));
  } else if (references[0].kind === 'arc') {
    values = references.map((reference) => arcLengthValueAndGradient(model, reference));
  } else {
    return null;
  }
  if (!values[0] || !values[1]) return null;
  const normalized = normalizedDifference(values[0], values[1]);
  return normalized ? matrixFromRows([normalized.gradient], variables) : null;
}

function lengthConstraint({ model, constraint, dimensions, variables }) {
  const reference = constraint.featureRefs?.[0];
  let measured;
  if (reference?.kind === 'segment') {
    const segment = segmentPoints(model, reference);
    measured = segment ? lengthScalar(vectorBetween(segment.start, segment.end)) : null;
  } else if (reference?.kind === 'arc') {
    measured = arcLengthValueAndGradient(model, reference);
  }
  const desired = targetValue(constraint, dimensions);
  if (!measured || !Number.isFinite(desired)) return null;
  const normalized = normalizedDifference(measured, { value: desired, gradient: new Map() });
  return normalized ? matrixFromRows([normalized.gradient], variables) : null;
}

function normalizedLineCross(point, line) {
  const offset = vectorBetween(line.start, point);
  const direction = vectorBetween(line.start, line.end);
  const directionLength = lengthScalar(direction);
  if (!directionLength) return null;
  return normalizedByScale(bilinearScalar(offset, direction, 'cross'), directionLength);
}

function collinear({ model, constraint, variables }) {
  const [driver, follower] = (constraint.featureRefs || []).map((reference) => segmentPoints(model, reference));
  if (!driver || !follower) return null;
  const startResidual = normalizedLineCross(follower.start, driver);
  const endResidual = normalizedLineCross(follower.end, driver);
  if (!startResidual || !endResidual) return null;
  return matrixFromRows([startResidual.gradient, endResidual.gradient], variables);
}

function midpoint({ model, constraint, variables }) {
  const point = pointValueAndDerivatives(model, constraint.featureRefs?.[0]);
  const line = segmentPoints(model, constraint.featureRefs?.[1]);
  if (!point || !line) return null;
  const middle = combinePoints([
    { point: line.start, weight: 0.5 },
    { point: line.end, weight: 0.5 },
  ]);
  return matrixFromRows(pointDifferenceRows(point, middle), variables);
}

function pointOnLine({ model, constraint, variables }) {
  const point = pointValueAndDerivatives(model, constraint.featureRefs?.[0]);
  const line = segmentPoints(model, constraint.featureRefs?.[1]);
  if (!point || !line) return null;
  const residual = normalizedLineCross(point, line);
  return residual ? matrixFromRows([residual.gradient], variables) : null;
}

function radialPointOnRound(model, pointReference, roundReference) {
  const point = pointValueAndDerivatives(model, pointReference);
  const round = roundGeometry(model, roundReference);
  if (!point || !round) return null;
  const measuredSquared = squaredLengthScalar(vectorBetween(round.center, point));
  const radiusSquared = squareScalar(round.radius);
  return normalizedDifference(measuredSquared, radiusSquared);
}

function pointOnCircle({ model, constraint, variables }) {
  const residual = radialPointOnRound(model, constraint.featureRefs?.[0], constraint.featureRefs?.[1]);
  return residual ? matrixFromRows([residual.gradient], variables) : null;
}

function pointOnArc({ model, constraint, variables }) {
  const pointReference = constraint.featureRefs?.[0];
  const arcReference = constraint.featureRefs?.[1];
  const radial = radialPointOnRound(model, pointReference, arcReference);
  const point = pointValueAndDerivatives(model, pointReference);
  const binding = model.binding(arcReference?.recordId || arcReference?.entityId);
  if (!radial || !point || binding?.type !== 'arc') return null;
  const center = directPoint(binding, 'center').value;
  const start = directPoint(binding, 'start').value;
  const end = directPoint(binding, 'end').value;
  const startAngle = Math.atan2(start[1] - center[1], start[0] - center[0]);
  const endAngle = Math.atan2(end[1] - center[1], end[0] - center[0]);
  const pointAngle = Math.atan2(point.value[1] - center[1], point.value[0] - center[0]);
  const span = binding.metadata.ccw
    ? normalizeAngle(endAngle - startAngle)
    : normalizeAngle(startAngle - endAngle);
  const traveled = binding.metadata.ccw
    ? normalizeAngle(pointAngle - startAngle)
    : normalizeAngle(startAngle - pointAngle);
  const angularMargin = 1e-5;
  if (traveled <= angularMargin || traveled >= span - angularMargin || span < angularMargin) return null;
  return matrixFromRows([radial.gradient, new Map()], variables);
}

function filletRadius(definition, dimensions) {
  const value = definition.radiusDimensionId
    ? dimensions.value(definition.radiusDimensionId)
    : Number(definition.radius);
  return Number.isFinite(value) && value > DIFFERENTIABILITY_EPSILON
    ? { value, gradient: new Map() }
    : null;
}

function filletRay(binding, endpointIndex) {
  let innerIndex;
  if (binding?.type === 'line') innerIndex = endpointIndex === 0 ? 2 : 0;
  else if (binding?.type === 'curve') {
    innerIndex = endpointIndex === 0 ? 1 : binding.metadata.pointCount - 2;
  } else return null;
  const endpoint = bindingPoint(binding, endpointIndex);
  const inner = bindingPoint(binding, innerIndex);
  if (!endpoint || !inner) return null;
  const direction = normalizedVector(vectorBetween(endpoint, inner));
  return direction ? { endpoint, direction } : null;
}

function filletSourceEquation(model, sourceReference, selectedCenter, radius) {
  const binding = model.binding(sourceReference?.recordId || sourceReference?.entityId);
  if (!binding) return null;
  if (binding.type === 'line' || binding.type === 'curve') {
    const ray = filletRay(binding, Number(sourceReference.index));
    if (!ray) return null;
    const normal = perpendicularVector(ray.direction);
    const centerOffset = [
      selectedCenter[0] - ray.endpoint.value[0],
      selectedCenter[1] - ray.endpoint.value[1],
    ];
    const signedOffset = dot(centerOffset, normal.value);
    const side = Math.sign(signedOffset);
    const offsetTolerance = 2e-6 * Math.max(1, radius.value);
    if (!side || Math.abs(Math.abs(signedOffset) - radius.value) > offsetTolerance) return null;
    const offsetOrigin = combinePoints([
      { point: ray.endpoint, weight: 1 },
      { point: scaledVector(normal, { value: side * radius.value, gradient: new Map() }), weight: 1 },
    ]);
    const center = { value: selectedCenter, derivatives: new Map() };
    const equation = bilinearScalar(vectorBetween(offsetOrigin, center), ray.direction, 'cross');
    const equationTolerance = 2e-6 * Math.max(1, radius.value);
    if (Math.abs(equation.value) > equationTolerance) return null;
    return {
      equation,
      centerGradient: [ray.direction.value[1], -ray.direction.value[0]],
    };
  }
  if (binding.type === 'arc') {
    const round = roundGeometry(model, { kind: 'arc', recordId: binding.id });
    if (!round) return null;
    const centerOffset = [
      selectedCenter[0] - round.center.value[0],
      selectedCenter[1] - round.center.value[1],
    ];
    const selectedDistance = Math.hypot(...centerOffset);
    const candidateRadii = [sumScalar(round.radius, radius)];
    const innerRadius = sumScalar(round.radius, radius, -1);
    if (innerRadius.value > DIFFERENTIABILITY_EPSILON) candidateRadii.push(innerRadius);
    const offsetRadius = candidateRadii
      .sort((first, second) => Math.abs(first.value - selectedDistance) - Math.abs(second.value - selectedDistance))[0];
    const offsetTolerance = 2e-6 * Math.max(1, selectedDistance, offsetRadius.value);
    if (!offsetRadius || Math.abs(offsetRadius.value - selectedDistance) > offsetTolerance) return null;
    const center = { value: selectedCenter, derivatives: new Map() };
    const equation = sumScalar(
      squaredLengthScalar(vectorBetween(round.center, center)),
      squareScalar(offsetRadius),
      -1,
    );
    if (Math.abs(equation.value) > offsetTolerance * Math.max(1, selectedDistance)) return null;
    return {
      equation,
      centerGradient: [2 * centerOffset[0], 2 * centerOffset[1]],
    };
  }
  return null;
}

function derivedFilletGeometry(model, reference, dimensions) {
  const definition = model.derivedEntity(reference?.recordId || reference?.entityId);
  const radius = definition ? filletRadius(definition, dimensions) : null;
  if (!definition || !radius) return null;
  const sourceIds = [definition.sourceA?.recordId, definition.sourceB?.recordId];
  if (sourceIds.some((recordId) => !recordId)) return null;
  const evaluated = evaluateFillet(
    { ...definition, radius: radius.value },
    new Map(sourceIds.map((recordId) => [recordId, model.entity(recordId)])),
  );
  if (!evaluated.valid || !evaluated.arc) return null;
  const selectedCenter = [...evaluated.arc.center];
  const equations = [definition.sourceA, definition.sourceB]
    .map((source) => filletSourceEquation(model, source, selectedCenter, radius));
  if (equations.some((equation) => !equation)) return null;
  const [[a00, a01], [a10, a11]] = equations.map(({ centerGradient }) => centerGradient);
  const determinant = a00 * a11 - a01 * a10;
  const determinantScale = Math.max(1, Math.hypot(a00, a01) * Math.hypot(a10, a11));
  if (Math.abs(determinant) <= DIFFERENTIABILITY_EPSILON * determinantScale) return null;
  const variableIds = new Set(equations.flatMap(({ equation }) => [...equation.gradient.keys()]));
  const derivatives = new Map();
  for (const variableId of variableIds) {
    const first = equations[0].equation.gradient.get(variableId) || 0;
    const second = equations[1].equation.gradient.get(variableId) || 0;
    derivatives.set(variableId, [
      (-first * a11 + a01 * second) / determinant,
      (-a00 * second + first * a10) / determinant,
    ]);
  }
  return { center: { value: selectedCenter, derivatives }, radius, arc: evaluated.arc };
}

function pointOnFillet({ model, constraint, dimensions, variables }) {
  const pointReference = constraint.featureRefs?.[0];
  const filletReference = constraint.featureRefs?.[1];
  const point = pointValueAndDerivatives(model, pointReference);
  const fillet = derivedFilletGeometry(model, filletReference, dimensions);
  if (!point || !fillet) return null;
  const measuredSquared = squaredLengthScalar(vectorBetween(fillet.center, point));
  const radial = normalizedDifference(measuredSquared, squareScalar(fillet.radius));
  if (!radial) return null;
  const { arc } = fillet;
  const startAngle = Math.atan2(arc.start[1] - arc.center[1], arc.start[0] - arc.center[0]);
  const endAngle = Math.atan2(arc.end[1] - arc.center[1], arc.end[0] - arc.center[0]);
  const pointAngle = Math.atan2(point.value[1] - arc.center[1], point.value[0] - arc.center[0]);
  const span = arc.ccw ? normalizeAngle(endAngle - startAngle) : normalizeAngle(startAngle - endAngle);
  const traveled = arc.ccw ? normalizeAngle(pointAngle - startAngle) : normalizeAngle(startAngle - pointAngle);
  const angularMargin = 1e-5;
  if (traveled <= angularMargin || traveled >= span - angularMargin || span < angularMargin) return null;
  return matrixFromRows([radial.gradient, new Map()], variables);
}

function tangentLineRound(model, constraint, lineReference, roundReference) {
  const line = segmentPoints(model, lineReference);
  const round = roundGeometry(model, roundReference);
  if (!line || !round) return null;
  const direction = vectorBetween(line.start, line.end);
  let tangentResidual;
  if (roundReference.kind === 'arc' && constraint.tangentPoint) {
    const tangentPoint = pointValueAndDerivatives(model, constraint.tangentPoint);
    const directionLength = lengthScalar(direction);
    if (!tangentPoint || !directionLength) return null;
    const radial = vectorBetween(tangentPoint, round.center);
    tangentResidual = normalizedByScale(
      bilinearScalar(direction, radial, 'dot'),
      productScalar(directionLength, round.radius),
    );
  } else {
    const directionSquared = squaredLengthScalar(direction);
    const denominatorTolerance = DIFFERENTIABILITY_EPSILON * Math.max(1, directionSquared.value);
    if (Math.abs(directionSquared.value - 1e-12) <= denominatorTolerance) return null;
    const denominator = directionSquared.value > 1e-12
      ? directionSquared
      : { value: 1e-12, gradient: new Map() };
    const centerOffset = vectorBetween(line.start, round.center);
    const area = bilinearScalar(direction, centerOffset, 'cross');
    const distanceSquared = quotientScalar(squareScalar(area), denominator);
    tangentResidual = distanceSquared ? normalizedDifference(distanceSquared, squareScalar(round.radius)) : null;
  }
  if (!tangentResidual) return null;

  const tangentOrientation = Math.sign(Number(constraint.tangentOrientation));
  if (!tangentOrientation) return [tangentResidual];
  const referencePoint = constraint.tangentPoint
    ? pointValueAndDerivatives(model, constraint.tangentPoint)
    : line.start;
  const directionLength = lengthScalar(direction);
  if (!referencePoint || !directionLength) return null;
  const centerOffset = vectorBetween(referencePoint, round.center);
  const signedDistanceRatio = quotientScalar(
    bilinearScalar(direction, centerOffset, 'cross'),
    productScalar(directionLength, round.radius),
  );
  if (!signedDistanceRatio) return null;
  const orientedSide = {
    value: signedDistanceRatio.value * tangentOrientation,
    gradient: new Map([...signedDistanceRatio.gradient].map(([id, derivative]) => [
      id,
      derivative * tangentOrientation,
    ])),
  };
  if (Math.abs(orientedSide.value) < DIFFERENTIABILITY_EPSILON) return null;
  const branchResidual = orientedSide.value < 0
    ? orientedSide
    : { value: 0, gradient: new Map() };
  return [tangentResidual, branchResidual];
}

function tangentRoundRound(model, constraint, references) {
  const [first, second] = references.map((reference) => roundGeometry(model, reference));
  if (!first || !second) return null;
  const centerDistanceSquared = squaredLengthScalar(vectorBetween(first.center, second.center));
  let targetDistance;
  if (constraint.tangentMode === 'internal') {
    const difference = sumScalar(first.radius, second.radius, -1);
    if (Math.abs(difference.value) < DIFFERENTIABILITY_EPSILON) return null;
    const sign = Math.sign(difference.value);
    targetDistance = {
      value: Math.abs(difference.value),
      gradient: new Map([...difference.gradient].map(([id, derivative]) => [id, sign * derivative])),
    };
  } else {
    targetDistance = sumScalar(first.radius, second.radius);
  }
  return normalizedDifference(centerDistanceSquared, squareScalar(targetDistance));
}

function tangent({ model, constraint, variables }) {
  const references = constraint.featureRefs || [];
  const lineReference = references.find((reference) => reference.kind === 'segment');
  const roundReferences = references.filter((reference) => reference.kind === 'circle' || reference.kind === 'arc');
  const residuals = lineReference && roundReferences.length === 1
    ? tangentLineRound(model, constraint, lineReference, roundReferences[0])
    : !lineReference && roundReferences.length === 2
      ? [tangentRoundRound(model, constraint, roundReferences)]
      : null;
  return residuals?.every(Boolean)
    ? matrixFromRows(residuals.map((residual) => residual.gradient), variables)
    : null;
}

export function intrinsicArcJacobian({ binding, variables }) {
  if (binding?.type !== 'arc') return null;
  const center = directPoint(binding, 'center');
  const startRadius = lengthScalar(vectorBetween(center, directPoint(binding, 'start')));
  const endRadius = lengthScalar(vectorBetween(center, directPoint(binding, 'end')));
  if (!startRadius || !endRadius) return null;
  const residual = sumScalar(startRadius, endRadius, -1);
  return matrixFromRows([residual.gradient], variables);
}

export const analyticalJacobianImplementations = {
  Coincident: coincident,
  Horizontal: (context) => axisAligned(context, 1),
  Vertical: (context) => axisAligned(context, 0),
  Distance: distance,
  'Horizontal Distance': (context) => axisDistance(context, 0),
  'Vertical Distance': (context) => axisDistance(context, 1),
  'Point Line Distance': pointLineDistance,
  'Line Line Distance': lineLineDistance,
  Radius: (context) => roundSize(context, 1),
  Diameter: (context) => roundSize(context, 2),
  Concentric: concentric,
  Parallel: (context) => parallelOrPerpendicular(context, 'cross'),
  Perpendicular: (context) => parallelOrPerpendicular(context, 'dot'),
  Equal: equal,
  Length: lengthConstraint,
  Collinear: collinear,
  Midpoint: midpoint,
  'Point-on Line': pointOnLine,
  'Point-on Circle': pointOnCircle,
  'Point-on Arc': pointOnArc,
  'Point-on Fillet': pointOnFillet,
  Tangent: tangent,
};
