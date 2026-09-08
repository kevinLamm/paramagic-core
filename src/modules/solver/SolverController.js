import { GLOBAL_LAYER_ID, normalizeStackFrame, stackFrameFor, transformStackEntity } from '../StackCoordinates.js';
import { solveStackPlacements, translateStackPlacementComponent } from './StackPlacementSolver.js';
import { ConstraintRegistry } from './ConstraintRegistry.js';
import { ConstraintGraph } from './ConstraintGraph.js';
import { solveConstraintComponents, solveConstraintScope } from './ComponentSolver.js';
import {
  DEFAULT_SOLVE_TOLERANCE,
  DimensionRepository,
  featureLength,
  isSuccessfulSolve,
} from './NumericSolverCore.js';
import { SketchModel } from './SolverModel.js';
import { createUuid } from '../IdentitySystem.js';
import { findDrivingDimensionLoop, formatDrivingDimensionLoopMessage } from './DimensionConflictDiagnostics.js';
import { formatUnitlessValue, formatValueOnlyDimensionValue, unitFactors } from './Units.js';
import { remapCurvePointIndex } from '../DrawingTools.js';
import { isCanvasOriginReference } from '../CanvasOrigin.js';
import {
  buildDocumentVariables,
  cloneDocumentMetadata,
  documentMetadataPatch,
  normalizeDocumentMetadata,
} from '../DocumentVariables.js';
import {
  STACK_ARCHITECTURE_VERSION,
  collectRecordReferences,
  defaultStackId as resolveDefaultStackId,
  normalizeStackArchitectureState,
} from '../StackArchitecture.js';
import {
  STACK_FRAME_RELATIONSHIP_SOLVE_DOMAIN,
  isStackFrameRelationship,
  normalizedStackRelationshipSolveDomain,
} from '../StackRelationshipSystem.js';
import {
  aggregateStackSolveResults,
  buildStackParticipationGraph,
  stackParticipationGroups,
  transitiveParticipantStackIds,
} from './StackSolveSystem.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const projectionOnSegment = (point, segment, projectionMode = 'segment') => {
  const dx = segment.end[0] - segment.start[0];
  const dy = segment.end[1] - segment.start[1];
  const sizeSquared = dx * dx + dy * dy;
  if (!sizeSquared) return [...segment.start];
  const rawRatio = ((point[0] - segment.start[0]) * dx + (point[1] - segment.start[1]) * dy) / sizeSquared;
  const ratio = projectionMode === 'line' ? rawRatio : Math.max(0, Math.min(1, rawRatio));
  return [segment.start[0] + dx * ratio, segment.start[1] + dy * ratio];
};
const signedLineLineDistance = (reference, measured) => {
  if (!reference || !measured) return null;
  const dx = reference.end[0] - reference.start[0];
  const dy = reference.end[1] - reference.start[1];
  const size = Math.hypot(dx, dy);
  if (!size) return null;
  const midpoint = [
    (measured.start[0] + measured.end[0]) / 2,
    (measured.start[1] + measured.end[1]) / 2,
  ];
  return (dx * (midpoint[1] - reference.start[1]) - dy * (midpoint[0] - reference.start[0])) / size;
};
const normalizedDirection = (value) => {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  const size = Math.hypot(x, y);
  return Number.isFinite(size) && size > 1e-12 ? [x / size, y / size] : null;
};
const drawingUnits = new Set(['in', 'mm', 'cm', 'm', 'ft']);
const simpleLength = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)\s*(in|mm|cm|m|ft)?$/i;
const maximumDimensionContinuationSteps = 64;
const proactiveDimensionContinuationThreshold = 0.25;
const dimensionContinuationStepsPerRange = 32;
const interactivePreviewSquaredErrorLimit = 1e-8;
const rigidFirstConstraintSolveDefault = true;

const rigidPlacementEntityTypes = new Set([
  'arc',
  'circle',
  'control',
  'curve',
  'line',
  'point',
  'polygon',
  'polyline',
  'table',
  'text',
]);

function referenceEntityId(reference) {
  return reference?.recordId || reference?.entityId || null;
}

function canvasOriginStackIds(value) {
  const stackIds = [];
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    if (isCanvasOriginReference(item) && item.stackId) stackIds.push(String(item.stackId));
    Object.values(item).forEach((child) => {
      if (child && typeof child === 'object') pending.push(child);
    });
  }
  return [...new Set(stackIds)];
}

function shiftedPoint(point, dx, dy) {
  return Array.isArray(point) && point.length >= 2
    ? [point[0] + dx, point[1] + dy]
    : point;
}

function translatedEntity(entity, dx, dy) {
  if (!entity || !rigidPlacementEntityTypes.has(entity.type)) return null;
  const next = clone(entity);
  if (entity.type === 'arc') {
    next.start = shiftedPoint(entity.start, dx, dy);
    next.arcPoint = shiftedPoint(entity.arcPoint, dx, dy);
    next.end = shiftedPoint(entity.end, dx, dy);
    next.center = shiftedPoint(entity.center, dx, dy);
    return next;
  }
  if (entity.type === 'circle') {
    next.center = shiftedPoint(entity.center, dx, dy);
    return next;
  }
  if (entity.type === 'line' || entity.type === 'point') {
    if (entity.type === 'line') {
      next.start = shiftedPoint(entity.start, dx, dy);
      next.end = shiftedPoint(entity.end, dx, dy);
    } else next.point = shiftedPoint(entity.point, dx, dy);
    return next;
  }
  if (['polygon', 'polyline', 'curve'].includes(entity.type)) {
    next.points = (entity.points || []).map((point) => shiftedPoint(point, dx, dy));
    return next;
  }
  next.x = Number(entity.x) + dx;
  next.y = Number(entity.y) + dy;
  return next;
}

function acceptsInteractivePreview(result, constraintTolerance) {
  if (result?.status !== 'preview') return false;
  const finalError = Number(result.finalError);
  const tolerance = Number(constraintTolerance);
  const squaredErrorLimit = Number.isFinite(tolerance) && tolerance >= 0
    ? Math.max(interactivePreviewSquaredErrorLimit, tolerance ** 2)
    : interactivePreviewSquaredErrorLimit;
  return Number.isFinite(finalError) && finalError <= squaredErrorLimit;
}

function convertedLengthExpression(expression, previousUnit, nextUnit) {
  const match = simpleLength.exec(String(expression ?? '').trim());
  if (!match) return expression;
  const sourceUnit = match[2]?.toLowerCase() || previousUnit;
  const value = Number(match[1]) * unitFactors[sourceUnit] / unitFactors[nextUnit];
  const rounded = Math.round((value + Number.EPSILON) * 1e9) / 1e9;
  return String(rounded);
}

function expressionWithoutUnitSuffixes(expression) {
  return String(expression ?? '')
    .replace(/\s+(?:mm|cm|m|in|ft|deg)\b/gi, '')
    .trim();
}

function dimensionContinuationStepCount(startValue, targetValue, { force = false } = {}) {
  if (!Number.isFinite(startValue) || !Number.isFinite(targetValue) || startValue === targetValue) return 1;
  const range = Math.max(Math.abs(startValue), Math.abs(targetValue), Number.EPSILON);
  const relativeChange = Math.abs(targetValue - startValue) / range;
  if (!force && relativeChange < proactiveDimensionContinuationThreshold) return 1;
  return Math.min(
    maximumDimensionContinuationSteps,
    Math.max(force ? 8 : 2, Math.ceil(relativeChange * dimensionContinuationStepsPerRange)),
  );
}

function exactDimensionValueExpression(value, unit = null) {
  const factor = unitFactors[unit] || 1;
  const numeric = value / factor;
  return unit ? `${numeric} ${unit}` : String(numeric);
}

function dimensionTargetContinuationStepCount(beforeEntries, targetEntries, dimensionIds, { force = false } = {}) {
  const beforeById = new Map(beforeEntries.map((entry) => [entry.id, entry]));
  const targetById = new Map(targetEntries.map((entry) => [entry.id, entry]));
  return [...dimensionIds].reduce((largest, dimensionId) => {
    const startValue = Number(beforeById.get(dimensionId)?.value);
    const targetValue = Number(targetById.get(dimensionId)?.value);
    return Math.max(
      largest,
      dimensionContinuationStepCount(startValue, targetValue, { force }),
    );
  }, 1);
}

function combineContinuationResults(results) {
  const final = results.at(-1);
  if (!final || results.length === 1) return final;
  const timingKeys = ['residualMs', 'jacobianMs', 'linearSolveMs', 'totalMs'];
  const timings = Object.fromEntries(timingKeys.map((key) => [
    key,
    results.reduce((sum, result) => sum + (Number(result.timings?.[key]) || 0), 0),
  ]));
  return {
    ...final,
    changedEntityIds: isSuccessfulSolve(final)
      ? [...new Set(results.flatMap((result) => result.changedEntityIds || []))]
      : [],
    timings,
    continuationSteps: results.length,
    continuationIterations: results.reduce((sum, result) => sum + (Number(result.iterations) || 0), 0),
    continuationAcceptedSteps: results.reduce((sum, result) => sum + (Number(result.acceptedSteps) || 0), 0),
    continuationRejectedSteps: results.reduce((sum, result) => sum + (Number(result.rejectedSteps) || 0), 0),
    message: isSuccessfulSolve(final)
      ? `Constraints converged through ${results.length} continuation steps.`
      : final.message,
  };
}

function withDrivingDimensionLoopDiagnostic(result, {
  model,
  dimensions,
  dimensionIds,
  beforeEntries,
  sourceName,
  requestedExpression,
}) {
  if (isSuccessfulSolve(result)) return result;
  const beforeById = new Map(beforeEntries.map((entry) => [entry.id, entry]));
  for (const dimensionId of dimensionIds) {
    const diagnostic = findDrivingDimensionLoop(model, dimensions, dimensionId);
    if (!diagnostic) continue;
    const previous = beforeById.get(dimensionId);
    return {
      ...result,
      conflictType: 'driving-dimension-loop',
      conflictingDimensionIds: [dimensionId, ...diagnostic.relatedDimensionIds],
      message: formatDrivingDimensionLoopMessage({
        diagnostic,
        sourceName,
        requestedExpression,
        requiredValue: previous
          ? formatUnitlessValue(previous.value, previous.unit)
          : null,
      }),
    };
  }
  return result;
}

function restoreEntities(model, snapshot) {
  snapshot.forEach((entity) => model.updateEntity(entity));
}

function endpointTangentPoint(model, constraint) {
  if (constraint?.type !== 'Tangent' || constraint.tangentPoint) return constraint?.tangentPoint || null;
  const lineRef = constraint.featureRefs?.find((ref) => ref.kind === 'segment');
  const arcRef = constraint.featureRefs?.find((ref) => ref.kind === 'arc');
  if (!lineRef || !arcRef) return null;
  const line = model.resolveSegment(lineRef);
  const arc = model.resolveEntity(arcRef);
  if (!line || !arc) return null;
  const tolerance = Math.max(1e-7, Math.min(1e-3, distance(line.start, line.end) * 1e-6));
  return [
    { kind: 'point', recordId: arcRef.recordId, index: 0, point: arc.start },
    { kind: 'point', recordId: arcRef.recordId, index: 2, point: arc.end },
  ]
    .filter((candidate) => Array.isArray(candidate.point) && candidate.point.length >= 2)
    .map((candidate) => ({
      ...candidate,
      separation: distance(candidate.point, projectionOnSegment(candidate.point, line)),
    }))
    .filter((candidate) => candidate.separation <= tolerance)
    .sort((first, second) => first.separation - second.separation)
    .map(({ point: _point, separation: _separation, ...ref }) => ref)[0] || null;
}

function tangentBranchOrientation(model, constraint) {
  if (constraint?.type !== 'Tangent') return null;
  const stored = Math.sign(Number(constraint.tangentOrientation));
  if (stored) return stored;
  const lineRef = constraint.featureRefs?.find((ref) => ref.kind === 'segment');
  const roundRef = constraint.featureRefs?.find((ref) => ref.kind === 'circle' || ref.kind === 'arc');
  if (!lineRef || !roundRef) return null;
  const line = model.resolveSegment(lineRef);
  const round = model.resolveEntity(roundRef);
  if (!line || !round?.center) return null;
  const referencePoint = constraint.tangentPoint
    ? model.resolvePoint(constraint.tangentPoint)
    : line.start;
  if (!referencePoint) return null;
  const direction = [line.end[0] - line.start[0], line.end[1] - line.start[1]];
  const offset = [round.center[0] - referencePoint[0], round.center[1] - referencePoint[1]];
  return Math.sign(direction[0] * offset[1] - direction[1] * offset[0]) || 1;
}

function completeTangentConstraint(model, constraint) {
  if (constraint?.type !== 'Tangent') return constraint;
  const tangentPoint = endpointTangentPoint(model, constraint);
  if (tangentPoint) constraint.tangentPoint = tangentPoint;
  const orientation = tangentBranchOrientation(model, constraint);
  if (orientation) constraint.tangentOrientation = orientation;
  return constraint;
}

function remapCurveReferences(value, recordId, edit, remainingPointCount) {
  if (Array.isArray(value)) return value.map((item) => remapCurveReferences(item, recordId, edit, remainingPointCount));
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    remapCurveReferences(item, recordId, edit, remainingPointCount),
  ]));
  if (
    (result.recordId === recordId || result.entityId === recordId)
    && (result.kind === 'point' || result.type === 'point')
    && Number.isInteger(result.index)
  ) {
    const remapped = remapCurvePointIndex(result.index, edit);
    result.index = remapped === null ? Math.min(edit.index, remainingPointCount - 1) : remapped;
  }
  return result;
}

function referencesRecord(value, recordId, visited = new Set()) {
  if (!value || typeof value !== 'object' || visited.has(value)) return false;
  visited.add(value);
  if (value.recordId === recordId || value.entityId === recordId) return true;
  return Object.values(value).some((item) => referencesRecord(item, recordId, visited));
}

function referencedRecordIds(value, result = new Set(), visited = new Set()) {
  if (!value || typeof value !== 'object' || visited.has(value)) return result;
  visited.add(value);
  const recordId = value.recordId || value.entityId;
  if (recordId) result.add(recordId);
  Object.values(value).forEach((item) => referencedRecordIds(item, result, visited));
  return result;
}

function dimensionValue(entity) {
  if (Number.isFinite(entity?.measuredValue)) return Number(entity.measuredValue);
  if (entity.type === 'dimension-line') {
    const a = entity.measureStart || entity.start;
    const b = entity.measureEnd || entity.end;
    if (entity.subtype === 'horizontal') return Math.abs(b[0] - a[0]);
    if (entity.subtype === 'vertical') return Math.abs(b[1] - a[1]);
    return distance(entity.start, entity.end);
  }
  if (entity.type === 'radius-dimension') {
    return entity.subtype === 'diameter' ? entity.radius * 2 : entity.radius;
  }
  if (entity.type === 'angle-dimension') {
    const a = Math.atan2(entity.start[1] - entity.vertex[1], entity.start[0] - entity.vertex[0]);
    const b = Math.atan2(entity.end[1] - entity.vertex[1], entity.end[0] - entity.vertex[0]);
    return Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))) * 180 / Math.PI;
  }
  return 0;
}

function axisOrientation(subtype, start, end) {
  if (!start || !end) return null;
  if (subtype === 'horizontal') return Math.sign(end[0] - start[0]) || 1;
  if (subtype === 'vertical') return Math.sign(end[1] - start[1]) || 1;
  return null;
}

function normalizeDimensionOrientation(dimension) {
  if (dimension?.type !== 'dimension-line' || !['horizontal', 'vertical'].includes(dimension.subtype)) return dimension;
  const stored = Math.sign(Number(dimension.orientation));
  if (stored) {
    dimension.orientation = stored;
    return dimension;
  }
  dimension.orientation = axisOrientation(
    dimension.subtype,
    dimension.measureStart || dimension.start,
    dimension.measureEnd || dimension.end,
  );
  return dimension;
}

function dimensionMeasurementPoints(dimension, model) {
  const lineToLine = dimension?.anchors?.lineToLine;
  if (lineToLine && model) {
    const reference = model.resolveSegment(lineToLine.reference);
    const measured = model.resolveSegment(lineToLine.measured);
    if (reference && measured) {
      const measuredPoint = lineToLine.measuredEndpoint === 'start'
        ? [...measured.start]
        : lineToLine.measuredEndpoint === 'end'
          ? [...measured.end]
          : [
            (measured.start[0] + measured.end[0]) / 2,
            (measured.start[1] + measured.end[1]) / 2,
          ];
      return [projectionOnSegment(measuredPoint, reference, 'line'), measuredPoint];
    }
  }
  const pointToSegment = dimension?.anchors?.pointToSegment;
  if (pointToSegment && model) {
    const point = model.resolvePoint(pointToSegment.point);
    const segment = model.resolveSegment(pointToSegment.segment);
    if (point && segment) {
      return [projectionOnSegment(point, segment, pointToSegment.projectionMode), point];
    }
  }
  if (model) {
    const start = model.resolvePoint(dimension?.anchors?.measureStart || dimension?.anchors?.start);
    const end = model.resolvePoint(dimension?.anchors?.measureEnd || dimension?.anchors?.end);
    if (start && end) return [start, end];
  }
  const start = dimension?.measureStart || dimension?.start;
  const end = dimension?.measureEnd || dimension?.end;
  return Array.isArray(start) && Array.isArray(end) ? [start, end] : null;
}

function derivedDimensionDirection(dimension, model = null) {
  const stored = normalizedDirection(dimension?.direction);
  if (stored) return stored;
  if (dimension?.type === 'dimension-line') {
    const points = dimensionMeasurementPoints(dimension, model);
    if (!points) return null;
    const [start, end] = points;
    if (dimension.subtype === 'horizontal') {
      return [Math.sign(end[0] - start[0]) || 1, 0];
    }
    if (dimension.subtype === 'vertical') {
      return [0, Math.sign(end[1] - start[1]) || 1];
    }
    return normalizedDirection([end[0] - start[0], end[1] - start[1]]) || [1, 0];
  }
  if (dimension?.type === 'radius-dimension') {
    const center = model?.resolvePoint(dimension.anchors?.center) || dimension.center;
    const target = dimension.elbow || dimension.label || dimension.target;
    return center && target
      ? normalizedDirection([target[0] - center[0], target[1] - center[1]]) || [1, 0]
      : [1, 0];
  }
  if (dimension?.type === 'angle-dimension') {
    const target = dimension.label || dimension.start;
    return dimension.vertex && target
      ? normalizedDirection([target[0] - dimension.vertex[0], target[1] - dimension.vertex[1]]) || [1, 0]
      : [1, 0];
  }
  return null;
}

function normalizeDimensionDirection(dimension, model = null) {
  const direction = derivedDimensionDirection(dimension, model);
  if (direction) dimension.direction = direction;
  return dimension;
}

function constraintDirection(constraint, annotation, model) {
  return normalizedDirection(constraint?.direction)
    || derivedDimensionDirection(annotation, model);
}

function constraintOrientation(constraint, annotation, model) {
  const stored = Math.sign(Number(constraint?.orientation));
  if (stored) return stored;
  const annotationOrientation = Math.sign(Number(annotation?.orientation));
  if (annotationOrientation) return annotationOrientation;
  if (constraint?.type === 'Horizontal Distance' || constraint?.type === 'Vertical Distance') {
    const subtype = constraint.type === 'Horizontal Distance' ? 'horizontal' : 'vertical';
    const start = model.resolvePoint(constraint.anchors?.start || constraint.featureRefs?.[0]);
    const end = model.resolvePoint(constraint.anchors?.end || constraint.featureRefs?.[1]);
    return axisOrientation(subtype, start, end);
  }
  if (constraint?.type === 'Point Line Distance' && ['horizontal', 'vertical'].includes(constraint.subtype)) {
    const point = model.resolvePoint(constraint.featureRefs?.[0]);
    const segment = model.resolveSegment(constraint.featureRefs?.[1]);
    if (!point || !segment) return null;
    return axisOrientation(constraint.subtype, projectionOnSegment(point, segment), point);
  }
  if (constraint?.type === 'Line Line Distance') {
    const reference = model.resolveSegment(constraint.featureRefs?.[0]);
    const measured = model.resolveSegment(constraint.featureRefs?.[1]);
    const signedDistance = signedLineLineDistance(reference, measured);
    return Number.isFinite(signedDistance) ? Math.sign(signedDistance) || 1 : null;
  }
  return null;
}

function dimensionValueFromModel(entity, model) {
  if (entity?.coordinateSpace !== 'global' && entity?.stackId && model.stackFrame) {
    entity = transformStackEntity(entity, entity.coordinateFrame || model.stackFrame(entity.stackId), true);
    model = model.constraintModel(entity);
  }
  if (entity?.useRenderedMeasurement && Number.isFinite(entity?.measuredValue)) return Number(entity.measuredValue);
  if (entity.type === 'dimension-line') {
    const lineToLine = entity.anchors?.lineToLine;
    if (lineToLine) {
      const reference = model.resolveSegment(lineToLine.reference);
      const measured = model.resolveSegment(lineToLine.measured);
      const signedDistance = signedLineLineDistance(reference, measured);
      return Number.isFinite(signedDistance) ? Math.abs(signedDistance) : dimensionValue(entity);
    }
    const pointToSegment = entity.anchors?.pointToSegment;
    if (pointToSegment) {
      const point = model.resolvePoint(pointToSegment.point);
      const segment = model.resolveSegment(pointToSegment.segment);
      if (!point || !segment) return dimensionValue(entity);
      const projected = projectionOnSegment(point, segment, pointToSegment.projectionMode);
      if (entity.subtype === 'horizontal') return Math.abs(point[0] - projected[0]);
      if (entity.subtype === 'vertical') return Math.abs(point[1] - projected[1]);
      return distance(point, projected);
    }
    const startAnchor = entity.anchors?.measureStart || entity.anchors?.start;
    const endAnchor = entity.anchors?.measureEnd || entity.anchors?.end;
    const a = model.resolvePoint(startAnchor) || entity.measureStart || entity.start;
    const b = model.resolvePoint(endAnchor) || entity.measureEnd || entity.end;
    if (entity.subtype === 'horizontal') return Math.abs(b[0] - a[0]);
    if (entity.subtype === 'vertical') return Math.abs(b[1] - a[1]);
    return distance(a, b);
  }
  if (entity.type === 'radius-dimension') {
    const radius = model.resolveEntity({ recordId: entity.anchors?.center?.recordId })?.radius ?? entity.radius;
    return entity.subtype === 'diameter' ? radius * 2 : radius;
  }
  if (entity.type === 'angle-dimension') {
    const first = model.resolveSegment(segmentRefFromAnchors(entity.anchors?.firstSegment));
    const second = model.resolveSegment(segmentRefFromAnchors(entity.anchors?.secondSegment));
    if (!first || !second) return dimensionValue(entity);
    const firstAngle = Math.atan2(
      (first.end[1] - first.start[1]) * (entity.firstRaySign || 1),
      (first.end[0] - first.start[0]) * (entity.firstRaySign || 1),
    );
    const secondAngle = Math.atan2(
      (second.end[1] - second.start[1]) * (entity.secondRaySign || 1),
      (second.end[0] - second.start[0]) * (entity.secondRaySign || 1),
    );
    return Math.abs(Math.atan2(Math.sin(secondAngle - firstAngle), Math.cos(secondAngle - firstAngle))) * 180 / Math.PI;
  }
  if (entity.type === 'multi-curve-length-dimension') {
    return (entity.anchors?.features || []).reduce((total, ref) => {
      const feature = model.resolveFeature(ref);
      if (feature?.kind === 'segment') return total + distance(feature.start, feature.end);
      if (feature?.kind === 'circle') return total + Math.PI * 2 * feature.radius;
      if (feature?.kind === 'arc') {
        const startAngle = Math.atan2(feature.start[1] - feature.center[1], feature.start[0] - feature.center[0]);
        const endAngle = Math.atan2(feature.end[1] - feature.center[1], feature.end[0] - feature.center[0]);
        const tau = Math.PI * 2;
        const normalize = (angle) => (angle + tau) % tau;
        const span = feature.ccw ? normalize(endAngle - startAngle) : normalize(startAngle - endAngle);
        return total + feature.radius * span;
      }
      if (feature?.kind === 'curve') return total + feature.points.slice(1).reduce((sum, point, index) => sum + distance(feature.points[index], point), 0);
      return total;
    }, 0);
  }
  return dimensionValue(entity);
}

function segmentRefFromAnchors(anchors) {
  const anchor = anchors?.start || anchors?.end;
  return anchor ? { kind: 'segment', recordId: anchor.recordId, index: anchor.index || 0 } : null;
}

export class SolverController {
  constructor({
    jacobianMode = 'dense',
    matrixFreeVariableThreshold,
    rigidFirstConstraintSolve = rigidFirstConstraintSolveDefault,
  } = {}) {
    this.model = new SketchModel();
    this.model.stackFrame = (id) => stackFrameFor(this.stackState, id || this.defaultStackId());
    this.dimensions = new DimensionRepository();
    this.registry = new ConstraintRegistry();
    this.constraintGraph = null;
    this.listeners = new Set();
    this.lastResult = null;
    this.dragLocks = new Set();
    this.pendingDragEntities = [];
    this.dimensionConstraints = new Map();
    this.dimensionAnnotations = new Map();
    this.entityStackIds = new Map();
    this.entityIdsByStack = new Map();
    this.stackParticipationGraphCache = null;
    this.recordsForDimension = new Map();
    this.dimensionsForRecord = new Map();
    this.drawingUnit = 'in';
    this.dxfExportUnit = 'in';
    this.filletRadius = unitFactors[this.drawingUnit];
    this.documentMetadata = normalizeDocumentMetadata();
    this.documentContext = { fileName: '', filePath: '' };
    this.stackState = normalizeStackArchitectureState();
    this.enabledStackIds = new Set(this.stackState.stacks.map(({ id }) => id));
    this.activationFiltering = false;
    this.externalStackRelationships = [];
    this.externalStackRelationshipFingerprint = '[]';
    this.jacobianMode = jacobianMode === 'blocks' ? 'blocks' : 'dense';
    this.matrixFreeVariableThreshold = matrixFreeVariableThreshold;
    // This trial is intentionally reversible while the interaction is being
    // evaluated. Set rigidFirstConstraintSolve to false to restore the prior
    // one-pass solver behavior without changing constraint data.
    this.rigidFirstConstraintSolve = rigidFirstConstraintSolve !== false;
    this.dimensions.setDefaultLengthUnit(this.drawingUnit);
    this.dimensions.setStackState(this.stackState, { rewriteExpressions: false, emit: false });
    this.refreshDocumentVariables();
  }

  setStackState(value, { rewriteExpressions = true, emit = true } = {}) {
    const previousEnabledStackIds = new Set(this.enabledStackIds);
    this.stackState = normalizeStackArchitectureState(value);
    this.enabledStackIds = this.activationFiltering
      ? new Set(this.stackState.stacks
        .map(({ id }) => id)
        .filter((id) => previousEnabledStackIds.has(id)))
      : new Set(this.stackState.stacks.map(({ id }) => id));
    this.dimensions.setStackState(this.stackState, { rewriteExpressions, emit: false });
    this.dimensions.setEnabledStackIds(this.activationFiltering ? this.enabledStackIds : null, { emit: false });
    this.invalidateStackParticipationGraph();
    if (emit) this.emit();
    return clone(this.stackState);
  }

  setStackFrame(stackId, requestedFrame, options = {}) {
    const target = this.stackState.stacks.find(({ id }) => id === stackId);
    if (!target?.frame || stackId === GLOBAL_LAYER_ID || !this.isStackEnabled(stackId)) {
      return {
        changed: false,
        result: { status: 'invalid', message: 'The Stack cannot be moved.', changedEntityIds: [] },
        snapshot: this.getGeometrySnapshot(),
        snapshotMode: 'full',
      };
    }
    const beforeFrames = new Map(this.stackState.stacks.map(({ id, frame }) => [id, clone(frame || {})]));
    const beforeAnnotations = new Map([...this.dimensionAnnotations].map(([id, annotation]) => [id, clone(annotation)]));
    const previousTargetFrame = normalizeStackFrame(target.frame);
    const nextTargetFrame = normalizeStackFrame({ ...target.frame, ...requestedFrame });
    translateStackPlacementComponent(
      this,
      stackId,
      nextTargetFrame.x - previousTargetFrame.x,
      nextTargetFrame.y - previousTargetFrame.y,
    );
    target.frame = nextTargetFrame;
    const placement = solveStackPlacements(this, { ...options, lockedStackIds: [stackId] });
    if (!isSuccessfulSolve(placement)) {
      this.stackState.stacks.forEach((stack) => {
        if (beforeFrames.has(stack.id)) stack.frame = clone(beforeFrames.get(stack.id));
      });
      this.dimensionAnnotations = new Map(beforeAnnotations);
      this.lastResult = placement;
      return {
        changed: false,
        result: placement,
        snapshot: this.getGeometrySnapshot(),
        snapshotMode: 'full',
      };
    }
    const changedStackIds = this.stackState.stacks
      .filter((stack) => JSON.stringify(stack.frame || {}) !== JSON.stringify(beforeFrames.get(stack.id) || {}))
      .map(({ id }) => id);
    const changedSet = new Set(changedStackIds);
    for (const annotation of this.dimensionAnnotations.values()) {
      if (!changedSet.has(annotation.stackId)) continue;
      const previousFrame = annotation.coordinateFrame || beforeFrames.get(annotation.stackId);
      const nextFrame = stackFrameFor(this.stackState, annotation.stackId);
      const localAnnotation = transformStackEntity(annotation, previousFrame, true);
      Object.assign(annotation, transformStackEntity(localAnnotation, nextFrame), { coordinateFrame: { ...nextFrame } });
    }
    const changedEntityIds = [...new Set(changedStackIds.flatMap((id) => [
      ...(this.entityIdsByStack.get(id) || []),
    ]))];
    this.lastResult = {
      ...placement,
      status: changedStackIds.length ? 'converged' : 'unchanged',
      changedStackIds,
      changedEntityIds,
    };
    if (changedStackIds.length) {
      this.refreshComputedDimensionsForStackIds([GLOBAL_LAYER_ID, ...changedStackIds]);
    }
    return {
      changed: changedStackIds.length > 0,
      result: this.lastResult,
      snapshot: this.getGeometrySnapshot(),
      snapshotMode: 'full',
    };
  }

  captureStackPlacementState() {
    return {
      frames: this.stackState.stacks.map(({ id, frame }) => [id, clone(frame || {})]),
      annotations: [...this.dimensionAnnotations].map(([id, annotation]) => [id, clone(annotation)]),
    };
  }

  restoreStackPlacementState(snapshot = {}) {
    const frames = new Map(snapshot.frames || []);
    this.stackState.stacks.forEach((stack) => {
      if (frames.has(stack.id)) stack.frame = normalizeStackFrame(frames.get(stack.id));
    });
    this.dimensionAnnotations = new Map((snapshot.annotations || []).map(([id, annotation]) => [id, clone(annotation)]));
    this.refreshComputedDimensionsForStackIds(this.stackState.stacks.map(({ id }) => id));
    return {
      changed: true,
      snapshot: this.getGeometrySnapshot(),
      snapshotMode: 'full',
    };
  }

  defaultStackId() {
    return resolveDefaultStackId(this.stackState);
  }

  isStackEnabled(stackId) {
    return this.enabledStackIds.has(String(stackId || this.defaultStackId()));
  }

  stackParticipationForValue(value, fallback = null) {
    fallback ||= this.defaultStackId();
    if (this.entityStackIds.size !== this.model.entities.size) this.rebuildEntityStackIndex();
    let stackId = this.stackIdForValue(value, fallback);
    const referencedIds = collectRecordReferences(value, this.entityStackIds);
    const referencedStackIds = [...referencedIds]
      .map((recordId) => this.entityStackIds.get(recordId))
      .filter(Boolean);
    const originStacks = canvasOriginStackIds(value);
    referencedStackIds.push(...originStacks);
    const participantIds = referencedIds.size || originStacks.length
      ? referencedStackIds
      : (value?.participantStackIds || []);
    const participants = [...new Set(participantIds.map(String))];
    if (participants.length > 1) stackId = GLOBAL_LAYER_ID;
    else if (participants.length === 1) stackId = participants[0];
    return {
      stackId,
      participantStackIds: [...new Set(participantIds.map(String))]
        .filter((participantId) => participantId && participantId !== stackId),
    };
  }

  relationshipStackIds(value, fallback = null) {
    const participation = this.stackParticipationForValue(value, fallback);
    return [...new Set([
      participation.stackId,
      ...(value?.participantStackIds || []).map(String),
      ...participation.participantStackIds,
    ].filter(Boolean))];
  }

  relationshipIsEnabled(value) {
    return this.relationshipStackIds(value)
      .every((stackId) => this.isStackEnabled(stackId));
  }

  setEnabledStackIds(stackIds = null) {
    const known = new Set(this.stackState.stacks.map(({ id }) => id));
    const next = stackIds === null
      ? new Set(known)
      : new Set([...stackIds].map(String).filter((stackId) => known.has(stackId)));
    next.add(GLOBAL_LAYER_ID);
    const changed = next.size !== this.enabledStackIds.size
      || [...next].some((stackId) => !this.enabledStackIds.has(stackId));
    this.activationFiltering = stackIds !== null;
    if (!changed) return { changed: false, enabledStackIds: new Set(this.enabledStackIds) };
    const previous = new Set(this.enabledStackIds);
    this.enabledStackIds = next;
    this.dimensions.setEnabledStackIds(next, { emit: false });
    this.invalidateConstraintGraph();
    return {
      changed: true,
      enabledStackIds: new Set(next),
      enabled: [...next].filter((stackId) => !previous.has(stackId)),
      disabled: [...previous].filter((stackId) => !next.has(stackId)),
    };
  }

  stackIdForValue(value, fallback = null) {
    fallback ||= this.defaultStackId();
    const dimensionStackId = value?.dimensionRef
      ? this.dimensions.get(value.dimensionRef)?.stackId
      : null;
    if (dimensionStackId) return dimensionStackId;
    if (value?.stackId) return value.stackId;
    const firstRecordId = referencedRecordIds(value).values().next().value;
    return this.entityStackIds.get(firstRecordId) || fallback;
  }

  withStackParticipation(value, fallback = null) {
    const participation = this.stackParticipationForValue(value, fallback);
    const result = { ...value, ...participation };
    if (participation.stackId === GLOBAL_LAYER_ID) {
      const inherited = value.dimensionRef ? this.dimensionAnnotations.get(value.dimensionRef) : null;
      const participants = participation.participantStackIds;
      const hasGlobalOrigin = canvasOriginStackIds(value).includes(GLOBAL_LAYER_ID)
        || canvasOriginStackIds(inherited).includes(GLOBAL_LAYER_ID);
      const solveDomain = normalizedStackRelationshipSolveDomain(
        value.solveDomain || inherited?.solveDomain,
      );
      Object.assign(result, { coordinateSpace: 'global', solveDomain });
      if (solveDomain === STACK_FRAME_RELATIONSHIP_SOLVE_DOMAIN) {
        const referenceStackId = hasGlobalOrigin ? GLOBAL_LAYER_ID : value.referenceStackId || inherited?.referenceStackId
          || (participants.includes(this.stackState.activeStackId) ? this.stackState.activeStackId : participants[0]);
        Object.assign(result, {
          referenceStackId,
          movingStackId: value.movingStackId || inherited?.movingStackId || participants.find((id) => id !== referenceStackId),
        });
      } else {
        delete result.referenceStackId;
        delete result.movingStackId;
      }
    } else {
      result.coordinateSpace = 'local';
      delete result.solveDomain;
      delete result.referenceStackId;
      delete result.movingStackId;
    }
    this.invalidateStackParticipationGraph();
    return result;
  }

  invalidateStackParticipationGraph() {
    this.stackParticipationGraphCache = null;
  }

  setEntityStackIndex(entityId, stackId = null) {
    stackId ||= this.defaultStackId();
    const previousStackId = this.entityStackIds.get(entityId);
    if (previousStackId === stackId) return;
    if (previousStackId) {
      this.entityIdsByStack.get(previousStackId)?.delete(entityId);
      if (!this.entityIdsByStack.get(previousStackId)?.size) this.entityIdsByStack.delete(previousStackId);
    }
    this.entityStackIds.set(entityId, stackId);
    if (!this.entityIdsByStack.has(stackId)) this.entityIdsByStack.set(stackId, new Set());
    this.entityIdsByStack.get(stackId).add(entityId);
    this.invalidateStackParticipationGraph();
  }

  removeEntityStackIndex(entityId) {
    const stackId = this.entityStackIds.get(entityId);
    this.entityStackIds.delete(entityId);
    this.entityIdsByStack.get(stackId)?.delete(entityId);
    if (!this.entityIdsByStack.get(stackId)?.size) this.entityIdsByStack.delete(stackId);
    this.invalidateStackParticipationGraph();
  }

  rebuildEntityStackIndex() {
    this.entityStackIds.clear();
    this.entityIdsByStack.clear();
    this.model.entities.forEach((_binding, id) => {
      const stackId = this.model.entity(id)?.stackId || this.defaultStackId();
      this.entityStackIds.set(id, stackId);
      if (!this.entityIdsByStack.has(stackId)) this.entityIdsByStack.set(stackId, new Set());
      this.entityIdsByStack.get(stackId).add(id);
    });
    this.invalidateStackParticipationGraph();
  }

  stackEntityRecords() {
    if (this.entityStackIds.size !== this.model.entities.size) this.rebuildEntityStackIndex();
    return [...this.entityStackIds].map(([id, stackId]) => ({ id, stackId }));
  }

  setExternalStackRelationships(relationships = []) {
    const next = (relationships || []).map(clone);
    const fingerprint = JSON.stringify(next.map((relationship) => ({
      id: relationship.id,
      stackId: relationship.stackId,
      participantStackIds: relationship.participantStackIds,
      featureRefs: relationship.featureRefs,
      externalTarget: relationship.externalTarget,
      externalDrivingTarget: relationship.externalDrivingTarget,
    })));
    if (fingerprint === this.externalStackRelationshipFingerprint) return clone(this.externalStackRelationships);
    this.externalStackRelationships = next;
    this.externalStackRelationshipFingerprint = fingerprint;
    this.invalidateStackParticipationGraph();
    return clone(this.externalStackRelationships);
  }

  stackParticipationGraph() {
    if (this.stackParticipationGraphCache) return this.stackParticipationGraphCache;
    const constraints = this.constraints().map((constraint) => ({
      ...constraint,
      ...this.stackParticipationForValue(constraint, constraint.stackId || this.defaultStackId()),
    }));
    const dimensions = this.dimensions.list()
      .filter(({ kind }) => kind === 'dimension')
      .map((entry) => {
        const annotation = this.dimensionAnnotations.get(entry.id);
        return annotation
          ? { ...entry, ...this.stackParticipationForValue(annotation, entry.stackId || this.defaultStackId()) }
          : entry;
      });
    const relationships = this.externalStackRelationships.map((relationship) => {
      const stackIds = this.relationshipStackIds(relationship, relationship.stackId || this.defaultStackId());
      const stackId = relationship.stackId || stackIds[0] || this.defaultStackId();
      return {
        ...relationship,
        stackId,
        participantStackIds: stackIds.filter((participantId) => participantId !== stackId),
      };
    });
    this.stackParticipationGraphCache = buildStackParticipationGraph({
      stackIds: this.stackState.stacks.map(({ id }) => id),
      enabledStackIds: this.enabledStackIds,
      entities: this.stackEntityRecords(),
      constraints,
      dimensions,
      relationships,
      defaultStackId: this.defaultStackId(),
    });
    return this.stackParticipationGraphCache;
  }

  stackIdsForScope(scope, { seedConstraintIds = [], seedDimensionIds = [] } = {}) {
    const ids = new Set([...(scope?.entityIds || [])]
      .map((entityId) => this.entityStackIds.get(entityId) || this.defaultStackId()));
    seedConstraintIds.forEach((constraintId) => {
      const constraint = this.model.constraints.get(constraintId);
      if (!constraint) return;
      this.relationshipStackIds(constraint).forEach((stackId) => ids.add(stackId));
    });
    seedDimensionIds.forEach((dimensionId) => {
      const dimension = this.dimensions.get(dimensionId);
      if (!dimension) return;
      const annotation = this.dimensionAnnotations.get(dimensionId);
      this.relationshipStackIds(annotation || dimension, dimension.stackId)
        .forEach((stackId) => ids.add(stackId));
    });
    return new Set([...ids].filter((stackId) => stackId !== GLOBAL_LAYER_ID && this.isStackEnabled(stackId)));
  }

  solveStackSet(stackIds, solveOptions, graph = this.getConstraintGraph()) {
    const requested = new Set([...stackIds].filter((stackId) => this.isStackEnabled(stackId)));
    const entityIds = [...requested].flatMap((stackId) => [...(this.entityIdsByStack.get(stackId) || [])]);
    const scope = graph.scopeForSeeds({ entityIds });
    if (!scope) {
      return {
        status: 'unchanged',
        iterations: 0,
        finalError: 0,
        changedEntityIds: [],
        problematicConstraintIds: [],
        componentStats: {
          componentCount: 0,
          solvedComponentCount: 0,
          constrainedComponentCount: 0,
          largestVariableCount: 0,
          largestConstraintCount: 0,
        },
      };
    }
    const scopedModel = graph.scopedModel(scope);
    const scopedGraph = new ConstraintGraph(scopedModel);
    const computedDependencyIds = this.dimensions.computedDependencyIds(scope.dimensionIds);
    const result = solveConstraintComponents({
      ...solveOptions,
      model: scopedModel,
      graph: scopedGraph,
      computedDimensionIds: computedDependencyIds,
    });
    this.refreshComputedDimensionsForStackIds(requested);
    result.solveScope = {
      mode: 'stack-set',
      stackIds: [...requested],
      componentCount: result.componentStats?.componentCount || 0,
      variableCount: scope.variableIds.size,
      constraintCount: scope.constraintIds.size,
      entityCount: scope.entityIds.size,
    };
    return result;
  }

  refreshComputedDimensionsForStackIds(stackIds = []) {
    const requested = new Set([...stackIds].filter((stackId) => this.isStackEnabled(stackId)));
    if (!requested.size) return new Map();
    const computedDimensionIds = new Set(this.dimensions.list()
      .filter((entry) => (
        entry.kind === 'dimension'
        && entry.computed
        && this.dimensions.isEntryAvailable(entry)
        && requested.has(entry.stackId || this.defaultStackId())
      ))
      .map(({ id }) => id));
    return this.dimensions.evaluateDirty({
      strict: false,
      refreshComputed: true,
      refreshComputedIds: computedDimensionIds,
    });
  }

  decorateStackFailure(result, stackIds) {
    if (isSuccessfulSolve(result) || result?.status === 'preview') return result;
    const problematicConstraintId = result?.problematicConstraintIds?.[0] || null;
    const constraint = problematicConstraintId ? this.model.constraints.get(problematicConstraintId) : null;
    const dimension = constraint?.dimensionRef ? this.dimensions.get(constraint.dimensionRef) : null;
    const names = [...stackIds].map((stackId) => (
      this.stackState.stacks.find(({ id }) => id === stackId)?.name || stackId
    ));
    const offender = dimension
      ? this.dimensions.qualifiedName(dimension)
      : constraint ? `${constraint.type} (${constraint.id})` : 'unknown relationship';
    return {
      ...result,
      message: `${result?.message || 'Solve failed.'} Stack ${names.map((name) => `"${name}"`).join(', ')}; offender: ${offender}.`,
      offender: {
        stackIds: [...stackIds],
        constraintId: constraint?.id || null,
        dimensionId: dimension?.id || null,
      },
    };
  }

  decorateParameterFailure(entry, message) {
    const errorMessage = String(message || 'The expression is invalid.');
    if (entry?.kind === 'dimension') {
      const stackId = entry.stackId || this.defaultStackId();
      const stackName = this.stackState.stacks.find(({ id }) => id === stackId)?.name || stackId;
      return {
        status: 'invalid',
        message: `Stack "${stackName}", dimension ${this.dimensions.qualifiedName(entry)} failed: ${errorMessage}`,
        offender: { stackIds: [stackId], dimensionId: entry.id, constraintId: null },
      };
    }
    return {
      status: 'invalid',
      message: `Global ${entry?.kind === 'control' ? 'Control' : 'Parameter'} "${entry?.name || 'unknown'}" failed: ${errorMessage}`,
      offender: { stackIds: [], dimensionId: null, constraintId: null, parameterId: entry?.id || null },
    };
  }

  emit(entityIds = null) {
    const requestedIds = entityIds === null ? null : new Set(entityIds);
    const snapshot = this.getGeometrySnapshot(requestedIds);
    this.documentMetadata.modifiedDate = new Date().toISOString().slice(0, 10);
    const boundsAreReferenced = this.dimensions.referencesExternalVariables([
      'BoundingBoxWidth',
      'BoundingBoxHeight',
    ]);
    if (requestedIds === null || boundsAreReferenced) {
      this.refreshDocumentVariables(
        requestedIds === null
          ? this.enabledGeometrySnapshot(snapshot)
          : this.enabledGeometrySnapshot(),
      );
    }
    this.listeners.forEach((listener) => listener(snapshot, this.lastResult, {
      snapshotMode: requestedIds === null ? 'full' : 'delta',
    }));
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  invalidateConstraintGraph() {
    this.constraintGraph = null;
    this.invalidateStackParticipationGraph();
  }

  getConstraintGraph() {
    if (!this.constraintGraph) this.constraintGraph = new ConstraintGraph(this.model, {
      includeEntity: (entityId) => this.isStackEnabled(
        this.entityStackIds.get(entityId)
        || this.model.entity(entityId)?.stackId
        || this.model.derivedEntity(entityId)?.stackId
        || this.defaultStackId(),
      ),
      includeConstraint: (constraint) => !isStackFrameRelationship(constraint) && this.relationshipIsEnabled(constraint),
    });
    return this.constraintGraph;
  }

  constraintGraphDiagnostics() {
    return this.getConstraintGraph().diagnostics({ registry: this.registry, dimensions: this.dimensions });
  }

  setDimensionAnnotation(dimensionId, annotation) {
    this.deleteDimensionAnnotation(dimensionId);
    const stored = this.withStackParticipation(clone(annotation), annotation?.stackId || this.defaultStackId());
    const entry = this.dimensions.get(dimensionId);
    const currentParticipants = [...(entry?.participantStackIds || [])].map(String).sort();
    const nextParticipants = [...(stored.participantStackIds || [])].map(String).sort();
    if (
      entry?.kind === 'dimension'
      && (
        (entry.stackId || this.defaultStackId()) !== stored.stackId
        || currentParticipants.join('\u0000') !== nextParticipants.join('\u0000')
      )
    ) {
      this.dimensions.updateDimensionScope(dimensionId, {
        stackId: stored.stackId,
        participantStackIds: stored.participantStackIds,
        emit: false,
      });
    }
    this.dimensionAnnotations.set(dimensionId, stored);
    const recordIds = referencedRecordIds(stored);
    this.recordsForDimension.set(dimensionId, recordIds);
    recordIds.forEach((recordId) => {
      if (!this.dimensionsForRecord.has(recordId)) this.dimensionsForRecord.set(recordId, new Set());
      this.dimensionsForRecord.get(recordId).add(dimensionId);
    });
    return stored;
  }

  deleteDimensionAnnotation(dimensionId) {
    this.recordsForDimension.get(dimensionId)?.forEach((recordId) => {
      const dimensionIds = this.dimensionsForRecord.get(recordId);
      dimensionIds?.delete(dimensionId);
      if (!dimensionIds?.size) this.dimensionsForRecord.delete(recordId);
    });
    this.recordsForDimension.delete(dimensionId);
    return this.dimensionAnnotations.delete(dimensionId);
  }

  clearDimensionAnnotations() {
    this.dimensionAnnotations.clear();
    this.recordsForDimension.clear();
    this.dimensionsForRecord.clear();
  }

  snapshotGeometryForSeeds(seeds, { fallbackToFull = false } = {}) {
    const scope = this.getConstraintGraph().scopeForSeeds(seeds);
    if ([...this.model.constraints.values()].some((constraint) => constraint.coordinateSpace === 'global')) {
      return { scope, entities: this.model.snapshot(), full: true,
        frames: this.stackState.stacks.map(({ id, frame }) => [id, clone(frame || {})]),
        annotations: [...this.dimensionAnnotations.entries()].map(([id, annotation]) => [id, clone(annotation)]),
      };
    }
    if (!scope) {
      return {
        scope: null,
        entities: fallbackToFull ? this.model.snapshot() : [],
        full: fallbackToFull,
      };
    }
    return {
      scope,
      entities: [...scope.entityIds].map((id) => this.model.entity(id)).filter(Boolean),
      full: false,
    };
  }

  restoreGeometryTransaction(transaction) {
    if (transaction?.frames) {
      const frames = new Map(transaction.frames);
      this.stackState.stacks.forEach((stack) => { if (stack.frame && frames.has(stack.id)) stack.frame = clone(frames.get(stack.id)); });
      transaction.annotations.forEach(([id, annotation]) => this.setDimensionAnnotation(id, annotation));
    }
    if (transaction?.entities?.length) {
      restoreEntities(this.model, transaction.entities);
      this.rebuildEntityStackIndex();
    }
  }

  addEntity(entity) {
    const created = this.model.addEntity(entity);
    this.setEntityStackIndex(created.id, created.stackId || this.defaultStackId());
    if (this.constraintGraph) this.constraintGraph.addEntity(created.id);
    this.emit([created.id]);
    return created;
  }

  removeEntity(entityId) {
    const graph = this.constraintGraph;
    const hasDerivedDependency = graph?.hasDerivedDependency(entityId);
    const canRemoveIncrementally = graph && !hasDerivedDependency;
    const removedVariableIds = canRemoveIncrementally ? graph.variableIdsForEntity(entityId) : null;
    const removedConstraintIds = canRemoveIncrementally
      ? new Set([...graph.constraintIdsForRecord(entityId), ...graph.constraintIdsForEntity(entityId)])
      : null;
    if (removedConstraintIds) {
      for (const constraint of this.model.constraints.values()) {
        if (constraint.coordinateSpace === 'global' && JSON.stringify(constraint).includes(`"${entityId}"`)) {
          removedConstraintIds.add(constraint.id);
        }
      }
    }
    const removed = this.model.removeEntity(entityId, {
      constraintIds: canRemoveIncrementally ? removedConstraintIds : null,
    });
    if (removed) {
      this.removeEntityStackIndex(entityId);
      if (canRemoveIncrementally) graph.removeEntity(entityId, removedConstraintIds, removedVariableIds);
      else if (graph) this.invalidateConstraintGraph();
      this.emit();
    }
    return removed;
  }

  updateEntityAppearances(updates = []) {
    const changed = [];
    updates.forEach(({ id, appearance }) => {
      const current = this.model.entity(id);
      if (!current || current.construction) return;
      changed.push(this.model.updateEntity({ ...current, appearance: clone(appearance) }));
    });
    if (changed.length) this.emit();
    return changed;
  }

  updateEntitySubtraction(updates = []) {
    const changed = [];
    updates.forEach(({ id, subtract, subtractExpression }) => {
      const current = this.model.entity(id);
      if (!current || current.construction) return;
      changed.push(this.model.updateEntity({
        ...current,
        subtract: Boolean(subtract),
        subtractExpression: String(subtractExpression ?? (subtract ? 'TRUE' : 'FALSE')),
      }));
    });
    if (changed.length) this.emit();
    return changed;
  }

  updateEntityConstruction(entityIds = [], construction = false) {
    const changed = [];
    entityIds.forEach((id) => {
      const current = this.model.entity(id);
      if (!current) return;
      changed.push(this.model.updateEntity({ ...current, construction: Boolean(construction) }));
    });
    if (changed.length) this.emit();
    return changed;
  }

  updateEntity(entity) {
    const changed = this.model.updateEntity(entity);
    this.setEntityStackIndex(changed.id, changed.stackId || this.defaultStackId());
    this.emit([changed.id]);
    return changed;
  }

  updateCurveControlPoints(entityId, points, edit) {
    const current = this.model.entity(entityId);
    if (current?.type !== 'curve' || !Array.isArray(points) || points.length < 2) {
      throw new Error('Curve control-point editing requires a valid curve.');
    }
    const graph = this.getConstraintGraph();
    const previousVariableIds = graph.variableIdsForEntity(entityId);
    const affectedConstraintIds = new Set([
      ...graph.constraintIdsForRecord(entityId),
      ...graph.constraintIdsForEntity(entityId),
    ]);
    affectedConstraintIds.forEach((id) => {
      const constraint = this.model.constraints.get(id);
      if (constraint) this.model.constraints.set(id, remapCurveReferences(constraint, entityId, edit, points.length));
    });
    new Set(this.dimensionsForRecord.get(entityId) || []).forEach((id) => {
      const annotation = this.dimensionAnnotations.get(id);
      if (annotation) this.setDimensionAnnotation(id, remapCurveReferences(annotation, entityId, edit, points.length));
    });
    const changed = this.model.updateEntity({ ...current, points: clone(points) });
    this.model.refreshFixedVariables();
    graph.updateEntity(entityId, previousVariableIds, affectedConstraintIds);
    this.lastResult = this.solve({ seedEntityIds: [entityId] });
    this.emit([entityId, ...(this.lastResult?.changedEntityIds || [])]);
    return changed;
  }

  evaluateParameterExpression(expression, options = {}) {
    return this.dimensions.evaluateExpression(expression, options);
  }

  parameterExpressionSymbols(options = {}) {
    return this.dimensions.expressionSymbols(options).map(clone);
  }

  parameterExpressionEntries(options = {}) {
    return this.dimensions.expressionEntries(options).map(clone);
  }

  evaluateScalarExpression(expression, options = {}) {
    return this.dimensions.evaluateScalarExpression(expression, options);
  }

  evaluateDrawingLengthExpression(expression, options = {}) {
    return this.dimensions.evaluateLengthExpression(expression, options);
  }

  clear() {
    this.model.clear();
    this.invalidateConstraintGraph();
    this.releaseDragLocks();
    this.dimensions.clear();
    this.entityStackIds.clear();
    this.entityIdsByStack.clear();
    this.dimensionConstraints.clear();
    this.clearDimensionAnnotations();
    this.drawingUnit = 'in';
    this.dxfExportUnit = 'in';
    this.filletRadius = unitFactors[this.drawingUnit];
    this.documentMetadata = normalizeDocumentMetadata();
    this.documentContext = { fileName: '', filePath: '' };
    this.stackState = normalizeStackArchitectureState();
    this.enabledStackIds = new Set(this.stackState.stacks.map(({ id }) => id));
    this.activationFiltering = false;
    this.dimensions.setDefaultLengthUnit(this.drawingUnit);
    this.dimensions.setStackState(this.stackState, { rewriteExpressions: false, emit: false });
    this.lastResult = null;
    this.emit();
  }

  loadSketch(snapshot) {
    this.model.clear();
    this.invalidateConstraintGraph();
    this.releaseDragLocks();
    this.dimensions.clear();
    this.entityStackIds.clear();
    this.entityIdsByStack.clear();
    this.dimensionConstraints.clear();
    this.clearDimensionAnnotations();
    this.drawingUnit = snapshot?.drawingUnit || 'in';
    this.dxfExportUnit = snapshot?.dxfExportUnit || this.drawingUnit;
    this.filletRadius = Number.isFinite(Number(snapshot?.filletRadius)) && Number(snapshot.filletRadius) > 0
      ? Number(snapshot.filletRadius)
      : unitFactors[this.drawingUnit];
    this.documentMetadata = normalizeDocumentMetadata(snapshot?.documentMetadata);
    this.documentContext = {
      fileName: String(snapshot?.documentContext?.fileName ?? ''),
      filePath: String(snapshot?.documentContext?.filePath ?? ''),
    };
    this.stackState = normalizeStackArchitectureState(snapshot?.stackState || snapshot?.extensions?.stacks);
    this.enabledStackIds = new Set(this.stackState.stacks.map(({ id }) => id));
    this.activationFiltering = false;
    this.dimensions.setDefaultLengthUnit(this.drawingUnit);
    this.dimensions.setStackState(this.stackState, { rewriteExpressions: false, emit: false });
    this.refreshDocumentVariables();
    (snapshot?.entities || []).forEach((entity) => {
      const created = this.model.addEntity(entity);
      this.setEntityStackIndex(created.id, created.stackId || this.defaultStackId());
    });
    (snapshot?.derivedEntities || []).forEach((entity) => this.model.setDerivedEntity(entity));
    const parameters = snapshot?.parameters || snapshot?.dimensions;
    if (parameters) this.dimensions.restore(parameters);
    (snapshot?.dimensionAnnotations || []).forEach((annotation) => {
      if (annotation.dimensionId) {
        const owned = this.withStackParticipation(annotation);
        const frame = this.model.stackFrame(owned.stackId);
        const localAnnotation = transformStackEntity(owned, owned.coordinateFrame || frame, true);
        normalizeDimensionDirection(normalizeDimensionOrientation(localAnnotation), this.model.constraintModel(owned));
        this.setDimensionAnnotation(
          annotation.dimensionId,
          { ...transformStackEntity(localAnnotation, frame), coordinateFrame: { ...frame } },
        );
      }
    });
    this.dimensions.list().forEach((entry) => {
      if (!entry.computed) return;
      this.dimensions.setComputedResolver(entry.id, () => {
        const annotation = this.dimensionAnnotations.get(entry.id);
        return annotation ? dimensionValueFromModel(annotation, this.model) : entry.value;
      });
    });
    this.dimensions.evaluateDirty({ strict: false });
    const loadWarnings = [];
    const restoredConstraints = [];
    (snapshot?.constraints || []).forEach((inputConstraint) => {
      const constraint = this.withStackParticipation(completeTangentConstraint(this.model, clone(inputConstraint)));
      const constraintModel = this.model.constraintModel(constraint);
      const annotation = this.dimensionAnnotations.get(constraint.dimensionRef);
      const localAnnotation = annotation && transformStackEntity(annotation, this.model.stackFrame(annotation.stackId), true);
      const orientation = constraintOrientation(
        constraint,
        localAnnotation,
        constraintModel,
      );
      if (orientation) constraint.orientation = orientation;
      const direction = constraintDirection(
        constraint,
        localAnnotation,
        constraintModel,
      );
      if (direction) constraint.direction = direction;
      if (constraint.enabled !== false) {
        try {
          if (constraint.type === 'Length' && !Number.isFinite(Number(constraint.value))) {
            constraint.value = featureLength(this.model, constraint.featureRefs?.[0]);
          }
          this.registry.validate(this.model, constraint, this.dimensions);
        } catch (error) {
          constraint.enabled = false;
          constraint.loadError = error.message || 'Constraint could not be restored.';
          loadWarnings.push({ id: constraint.id, type: constraint.type, message: constraint.loadError });
        }
      }
      restoredConstraints.push(constraint);
      if (constraint.dimensionRef) this.dimensionConstraints.set(constraint.dimensionRef, constraint.id);
    });
    this.model.addConstraints(restoredConstraints);
    this.lastResult = this.solve({ fullSolve: true });
    if (loadWarnings.length) {
      this.lastResult.loadWarnings = loadWarnings;
    }
    this.emit();
    return this.lastResult;
  }

  getSketchSnapshot() {
    const parameters = this.dimensions.snapshot();
    return {
      stackArchitectureVersion: STACK_ARCHITECTURE_VERSION,
      stackState: clone(this.stackState),
      drawingUnit: this.drawingUnit,
      dxfExportUnit: this.dxfExportUnit,
      filletRadius: this.filletRadius,
      entities: this.getGeometrySnapshot(),
      constraints: this.constraints(),
      parameters,
      dimensions: clone(parameters),
      dimensionAnnotations: [...this.dimensionAnnotations.values()].map(clone),
      documentMetadata: cloneDocumentMetadata(this.documentMetadata),
      documentContext: { ...this.documentContext },
    };
  }

  solve(options = {}) {
    const enabledRelationships = [...this.model.constraints.values()].filter((constraint) => (
      constraint.enabled !== false && this.relationshipIsEnabled(constraint)
    ));
    const hasStackFrameRelationships = enabledRelationships.some(isStackFrameRelationship);
    const hasEntityCrossStackRelationships = enabledRelationships.some((constraint) => (
      constraint.coordinateSpace === 'global' && !isStackFrameRelationship(constraint)
    ));
    const requestedTolerance = Number(options.tolerance);
    const solveOptions = hasEntityCrossStackRelationships && options.solveMode !== 'interactive'
      ? {
        ...options,
        tolerance: Math.min(Number.isFinite(requestedTolerance) ? requestedTolerance : Infinity, 1e-8),
      }
      : options;
    if (!hasStackFrameRelationships) return this.solveLocal(solveOptions);
    const localSolveOptions = {
      ...solveOptions,
      seedConstraintIds: (solveOptions.seedConstraintIds || []).filter((constraintId) => (
        !isStackFrameRelationship(this.model.constraints.get(constraintId))
      )),
      seedDimensionIds: (solveOptions.seedDimensionIds || []).filter((dimensionId) => {
        const constraintId = this.dimensionConstraints.get(dimensionId);
        return !isStackFrameRelationship(this.model.constraints.get(constraintId));
      }),
    };
    const before = this.model.snapshot();
    const frames = this.stackState.stacks.map((stack) => [stack, clone(stack.frame || {})]);
    const local = this.solveLocal(localSolveOptions);
    if (!isSuccessfulSolve(local)) return local;
    const placement = solveStackPlacements(this, solveOptions);
    if (!isSuccessfulSolve(placement)) {
      frames.forEach(([stack, frame]) => { if (stack.frame) stack.frame = frame; });
      restoreEntities(this.model, before);
      this.lastResult = { ...local, ...placement };
    } else {
      const movedStackIds = new Set(placement.changedStackIds || []);
      const previousFrames = new Map(frames.map(([stack, frame]) => [stack.id, frame]));
      for (const annotation of this.dimensionAnnotations.values()) {
        if (!movedStackIds.has(annotation.stackId)) continue;
        const frame = this.model.stackFrame(annotation.stackId);
        const localAnnotation = transformStackEntity(annotation, annotation.coordinateFrame || previousFrames.get(annotation.stackId), true);
        Object.assign(annotation, transformStackEntity(localAnnotation, frame), { coordinateFrame: { ...frame } });
      }
      this.lastResult = {
        ...local,
        status: placement.changedStackIds?.length ? 'converged' : local.status,
        changedStackIds: placement.changedStackIds || [],
        changedEntityIds: [...new Set([...(local.changedEntityIds || []), ...(placement.changedEntityIds || [])])],
        solveScope: placement.solveScope || local.solveScope,
      };
      this.refreshComputedDimensionsForStackIds([GLOBAL_LAYER_ID, ...(placement.changedStackIds || [])]);
    }
    return this.lastResult;
  }

  solveLocal({
    seedVariableIds = [],
    seedEntityIds = [],
    seedConstraintIds = [],
    seedDimensionIds = [],
    fullSolve = false,
    solveMode = 'final',
    maxIterations,
    timeBudgetMs,
    shouldCancel,
    jacobianMode = this.jacobianMode,
    matrixFreeVariableThreshold = this.matrixFreeVariableThreshold,
    tolerance,
  } = {}) {
    const hasSeeds = Boolean(seedVariableIds.length || seedEntityIds.length || seedConstraintIds.length || seedDimensionIds.length);
    const graph = this.getConstraintGraph();
    const seedScope = !fullSolve && hasSeeds
      ? graph.scopeForSeeds({
        variableIds: seedVariableIds,
        entityIds: seedEntityIds,
        constraintIds: seedConstraintIds,
        dimensionIds: seedDimensionIds,
      })
      : null;
    const participantGraph = this.stackParticipationGraph();
    const seededStackIds = this.stackIdsForScope(seedScope, { seedConstraintIds, seedDimensionIds });
    const affectedStackIds = !fullSolve && hasSeeds && seededStackIds.size
      ? transitiveParticipantStackIds(participantGraph, [...seededStackIds])
      : null;
    const scope = affectedStackIds?.size
      ? graph.scopeForSeeds({
        entityIds: [...affectedStackIds]
          .flatMap((stackId) => [...(this.entityIdsByStack.get(stackId) || [])]),
        dimensionIds: seedDimensionIds,
        constraintIds: seedConstraintIds,
      })
      : seedScope;
    const solveOptions = {
      registry: this.registry,
      dimensions: this.dimensions,
      solveMode,
      ...(maxIterations === undefined ? {} : { maxIterations }),
      ...(timeBudgetMs === undefined ? {} : { timeBudgetMs }),
      ...(shouldCancel === undefined ? {} : { shouldCancel }),
      ...(tolerance === undefined ? {} : { tolerance }),
      ...(jacobianMode === undefined ? {} : { jacobianMode }),
      ...(matrixFreeVariableThreshold === undefined ? {} : { matrixFreeVariableThreshold }),
    };
    if (scope) {
      const scopedModel = graph.scopedModel(scope);
      this.lastResult = solveConstraintComponents({
        ...solveOptions,
        model: scopedModel,
        graph: new ConstraintGraph(scopedModel),
        computedDimensionIds: this.dimensions.computedDependencyIds(scope.dimensionIds),
      });
      this.lastResult.solveScope = affectedStackIds?.size ? {
        mode: 'stack-set',
        stackIds: [...affectedStackIds],
        componentCount: this.lastResult.componentStats?.componentCount || 0,
        variableCount: scope.variableIds.size,
        constraintCount: scope.constraintIds.size,
        entityCount: scope.entityIds.size,
      } : {
        mode: 'component',
        componentKeys: [...scope.componentKeys],
        variableCount: scope.variableIds.size,
        constraintCount: scope.constraintIds.size,
        entityCount: scope.entityIds.size,
      };
      this.lastResult = this.decorateStackFailure(this.lastResult, affectedStackIds || seededStackIds);
      this.refreshComputedDimensionsForStackIds(affectedStackIds || seededStackIds);
    } else if (fullSolve || !hasSeeds) {
      const results = stackParticipationGroups(participantGraph).map((stackIds) => ({
        stackIds,
        result: this.decorateStackFailure(this.solveStackSet(stackIds, solveOptions, graph), stackIds),
      }));
      this.lastResult = aggregateStackSolveResults(results);
      this.lastResult.solveScope = {
        mode: 'stack-partitions',
        stackGroupCount: results.length,
        componentCount: this.lastResult.componentStats.componentCount,
        solvedComponentCount: this.lastResult.componentStats.solvedComponentCount,
        constrainedComponentCount: this.lastResult.componentStats.constrainedComponentCount,
        largestVariableCount: this.lastResult.componentStats.largestVariableCount,
        largestConstraintCount: this.lastResult.componentStats.largestConstraintCount,
        variableCount: graph.variableConstraints.size,
        constraintCount: graph.componentForConstraint.size,
        entityCount: [...this.enabledStackIds]
          .reduce((count, stackId) => count + (this.entityIdsByStack.get(stackId)?.size || 0), 0),
      };
    } else {
      this.lastResult = {
        status: 'unchanged',
        iterations: 0,
        initialError: 0,
        finalError: 0,
        acceptedSteps: 0,
        rejectedSteps: 0,
        changedEntityIds: [],
        problematicConstraintIds: [],
        message: 'No constraints are connected to the requested geometry.',
        solveMode: solveMode === 'interactive' ? 'interactive' : 'final',
        timings: { residualMs: 0, jacobianMs: 0, linearSolveMs: 0, totalMs: 0 },
        jacobianStats: {
          requestedMode: jacobianMode === 'blocks' ? 'blocks' : 'dense',
          mode: 'not-required',
          totalBlocks: 0,
          analyticalBlocks: 0,
          fallbackBlocks: 0,
          residualRows: 0,
        },
        solveScope: { mode: 'none' },
      };
    }
    return this.lastResult;
  }

  updateEntities(entities, {
    lockedVariableIds = [],
    solveOptions = {},
    previewConstraintTolerance,
  } = {}) {
    if (this.dragLocks.size) this.pendingDragEntities = entities.map(clone);
    const locks = new Set([...this.dragLocks, ...lockedVariableIds]);
    const seedEntityIds = entities.map((entity) => entity.id);
    const graph = this.getConstraintGraph();
    const rollbackScope = graph.scopeForSeeds({
      entityIds: seedEntityIds,
      variableIds: [...locks],
    });
    const before = rollbackScope
      ? [...rollbackScope.entityIds].map((id) => this.model.entity(id)).filter(Boolean)
      : this.model.snapshot();
    const rollbackVariables = rollbackScope
      ? [...rollbackScope.variableIds].map((id) => graph.variablesById.get(id)).filter(Boolean)
      : this.model.allVariables();
    const fixedValues = new Map(rollbackVariables
      .filter((variable) => variable.fixed)
      .map((variable) => [variable.id, variable.value]));
    try {
      entities.forEach((entity) => {
        const changed = this.model.updateEntity(entity);
        this.setEntityStackIndex(changed.id, changed.stackId || this.defaultStackId());
      });
      fixedValues.forEach((value, id) => { const variable = this.model.variableById(id); if (variable) variable.value = value; });
    } catch (error) {
      restoreEntities(this.model, before);
      this.rebuildEntityStackIndex();
      this.lastResult = { status: 'invalid', message: error.message, changedEntityIds: [] };
      this.emit(seedEntityIds);
      return {
        result: this.lastResult,
        snapshot: this.getGeometrySnapshot(seedEntityIds),
        snapshotMode: 'delta',
      };
    }
    locks.forEach((id) => { const variable = this.model.variableById(id); if (variable) variable.locked = true; });
    let result = this.solve({
      seedEntityIds,
      seedVariableIds: [...locks],
      ...solveOptions,
    });
    locks.forEach((id) => { const variable = this.model.variableById(id); if (variable) variable.locked = false; });
    const interactivePreview = solveOptions.solveMode === 'interactive' && result.status === 'preview';
    const acceptedPreview = interactivePreview && acceptsInteractivePreview(result, previewConstraintTolerance);
    if (!isSuccessfulSolve(result) && !acceptedPreview) {
      restoreEntities(this.model, before);
      this.rebuildEntityStackIndex();
    }
    if (interactivePreview && !acceptedPreview) {
      result = {
        ...result,
        changedEntityIds: [],
        restoredInteractivePreview: true,
        message: 'Interactive preview was rejected because the requested drag left the constraint component inconsistent.',
      };
      this.lastResult = result;
    }
    this.emit(new Set([...seedEntityIds, ...(result.changedEntityIds || [])]));
    return {
      result,
      snapshot: this.getGeometrySnapshot(new Set([...seedEntityIds, ...(result.changedEntityIds || [])])),
      snapshotMode: 'delta',
    };
  }

  applyAuthoritativeEntities(entities = [], workerResult = {}) {
    if (workerResult.stackState) this.setStackState(workerResult.stackState, { rewriteExpressions: false, emit: false });
    const changedEntityIds = [];
    try {
      entities.forEach((entity) => {
        if (!entity?.id || !this.model.binding(entity.id)) return;
        const updated = this.model.updateEntity(entity);
        this.setEntityStackIndex(updated.id, updated.stackId || this.defaultStackId());
        changedEntityIds.push(entity.id);
      });
    } catch (error) {
      this.lastResult = { status: 'invalid', message: error.message, changedEntityIds: [] };
      this.emit(changedEntityIds);
      return { result: this.lastResult, snapshot: this.getGeometrySnapshot() };
    }
    this.dimensions.evaluateDirty({ strict: false, refreshComputed: true });
    this.lastResult = {
      status: workerResult.status || (changedEntityIds.length ? 'converged' : 'unchanged'),
      ...(workerResult.message ? { message: workerResult.message } : {}),
      changedEntityIds,
      ...(workerResult.diagnostics?.solveScope ? { solveScope: workerResult.diagnostics.solveScope } : {}),
      ...(Number.isFinite(workerResult.diagnostics?.iterations)
        ? { iterations: workerResult.diagnostics.iterations }
        : {}),
      ...(workerResult.diagnostics?.solveMode ? { solveMode: workerResult.diagnostics.solveMode } : {}),
      ...(workerResult.diagnostics?.cancellationReason
        ? { cancellationReason: workerResult.diagnostics.cancellationReason }
        : {}),
    };
    this.emit(changedEntityIds);
    return {
      result: this.lastResult,
      snapshot: this.getGeometrySnapshot(changedEntityIds),
      snapshotMode: 'delta',
    };
  }

  applyAuthoritativeState({
    entities = [],
    parameters = [],
    constraints = [],
    removedConstraintIds = [],
  } = {}, workerResult = {}) {
    removedConstraintIds.forEach((constraintId) => {
      if (!this.model.removeConstraint(constraintId)) return;
      this.constraintGraph?.removeConstraint(constraintId);
    });
    constraints.forEach((constraint) => {
      if (!constraint?.id) return;
      this.model.addConstraint(constraint);
      if (!isStackFrameRelationship(constraint)) this.constraintGraph?.addConstraint(constraint.id);
    });
    if (parameters.length) this.dimensions.restoreEntries(parameters, { emit: false });
    return this.applyAuthoritativeEntities(entities, workerResult);
  }

  rigidPlacementCandidates(constraint) {
    if (constraint?.coordinateSpace === 'global' || !this.rigidFirstConstraintSolve || constraint?.type !== 'Coincident') return [];
    if ([...this.model.constraints.values()].some(isStackFrameRelationship)) return [];
    const refs = constraint.featureRefs || [];
    if (refs.length !== 2 || refs.some((ref) => ref?.kind !== 'point')) return [];
    const graph = this.getConstraintGraph();
    const sourceIndex = isCanvasOriginReference(refs[0]) ? 1 : 0;
    const sourceRef = refs[sourceIndex];
    const targetRef = refs[sourceIndex === 0 ? 1 : 0];
    const sourceId = referenceEntityId(sourceRef);
    const targetId = referenceEntityId(targetRef);
    if (!sourceId || isCanvasOriginReference(sourceRef)) return [];
    const sourcePoint = this.model.resolvePoint(sourceRef);
    const targetPoint = this.model.resolvePoint(targetRef);
    if (!sourcePoint || !targetPoint) return [];
    const sourceScope = graph.scopeForSeeds({ entityIds: [sourceId] });
    const entityIds = new Set(sourceScope?.entityIds || [sourceId]);
    if (!entityIds.has(sourceId) || (targetId && entityIds.has(targetId))) return [];
    const entities = [...entityIds].map((entityId) => this.model.entity(entityId)).filter(Boolean);
    if (!entities.length || entities.some((entity) => !translatedEntity(entity, 0, 0))) return [];
    return [{ entityIds, sourcePoint, targetPoint }];
  }

  tryRigidFirstConstraintSolve(constraint, candidates, beforeEntities) {
    if (!candidates.length) return { attempted: false, accepted: false, result: null };
    const graph = this.getConstraintGraph();
    const solveScope = graph.scopeForSeeds({ constraintIds: [constraint.id] });
    if (!solveScope) return { attempted: false, accepted: false, result: null };
    let lastResult = null;
    for (const candidate of candidates) {
      restoreEntities(this.model, beforeEntities);
      const dx = candidate.targetPoint[0] - candidate.sourcePoint[0];
      const dy = candidate.targetPoint[1] - candidate.sourcePoint[1];
      const movedEntities = [...candidate.entityIds]
        .map((entityId) => this.model.entity(entityId))
        .map((entity) => translatedEntity(entity, dx, dy));
      if (movedEntities.some((entity) => !entity)) continue;
      movedEntities.forEach((entity) => this.model.updateEntity(entity));

      const previousLocks = new Map([...solveScope.variableIds].map((id) => {
        const variable = this.model.variableById(id);
        return [id, Boolean(variable?.locked)];
      }));
      try {
        solveScope.variableIds.forEach((id) => {
          const variable = this.model.variableById(id);
          if (variable) variable.locked = true;
        });
        lastResult = this.solve({ seedConstraintIds: [constraint.id] });
      } finally {
        previousLocks.forEach((locked, id) => {
          const variable = this.model.variableById(id);
          if (variable) variable.locked = locked;
        });
      }
      if (isSuccessfulSolve(lastResult)) {
        return {
          attempted: true,
          accepted: true,
          result: lastResult,
          changedEntityIds: [...candidate.entityIds],
        };
      }
    }
    restoreEntities(this.model, beforeEntities);
    return { attempted: true, accepted: false, result: lastResult };
  }

  addConstraint(input, { dimensionSolve = false } = {}) {
    const before = this.model.snapshot();
    const constraint = this.withStackParticipation(completeTangentConstraint(this.model, { ...clone(input), id: input.id || createUuid() }));
    try {
      if (constraint.type === 'Length' && !Number.isFinite(Number(constraint.value))) {
        constraint.value = featureLength(this.model, constraint.featureRefs?.[0]);
      }
      this.registry.validate(this.model, constraint, this.dimensions);
    } catch (error) {
      this.lastResult = { status: 'invalid', message: error.message, changedEntityIds: [] };
      this.emit();
      return { constraint: null, result: this.lastResult, snapshot: this.getGeometrySnapshot() };
    }
    const rigidCandidates = this.rigidPlacementCandidates(constraint);
    this.model.addConstraint(constraint);
    if (!isStackFrameRelationship(constraint)) this.getConstraintGraph().addConstraint(constraint.id);
    const rigidTrial = this.tryRigidFirstConstraintSolve(constraint, rigidCandidates, before);
    let result = rigidTrial.accepted
      ? rigidTrial.result
      : this.solve({ seedConstraintIds: [constraint.id] });
    if (rigidTrial.accepted && rigidTrial.changedEntityIds?.length) {
      result = { ...result, changedEntityIds: rigidTrial.changedEntityIds };
    }
    if (rigidTrial.attempted) {
      result = {
        ...result,
        rigidFirstSolveAttempted: true,
        rigidFirstSolveAccepted: Boolean(rigidTrial.accepted),
        ...(rigidTrial.accepted ? {} : { rigidFirstSolveFallback: true }),
      };
      this.lastResult = result;
    }
    if (dimensionSolve && !isSuccessfulSolve(result)) {
      // Preserve the ordinary strict path when it converges so synchronous
      // and worker-loaded snapshots remain identical. Dimension creation can
      // still recover from the small residual floor common in legacy fillets.
      result = this.solveDimensionStep({ seedConstraintIds: [constraint.id] });
    }
    if (!isSuccessfulSolve(result)) {
      this.model.removeConstraint(constraint.id);
      this.invalidateConstraintGraph();
      restoreEntities(this.model, before);
      this.emit();
      return { constraint: null, result, snapshot: this.getGeometrySnapshot() };
    }
    this.emit();
    return { constraint, result, snapshot: this.getGeometrySnapshot() };
  }

  applyConstraintBatch({ entities = [], constraints = [], removeConstraintIds = [] } = {}) {
    const before = this.getSketchSnapshot();
    const acceptedConstraints = [];
    let solveResult = null;
    try {
      const removableConstraintIds = removeConstraintIds.filter((constraintId) => this.model.constraints.has(constraintId));
      this.model.removeConstraints(removableConstraintIds);
      this.constraintGraph?.removeConstraints(removableConstraintIds);
      entities.forEach((entity) => {
        if (this.model.binding(entity?.id)) this.model.updateEntity(entity);
        else {
          this.model.addEntity(entity);
          this.constraintGraph?.addEntity(entity.id);
        }
        if (entity?.id) this.setEntityStackIndex(entity.id, entity.stackId || this.defaultStackId());
      });
      const stagedConstraints = constraints.map((input) => {
        const constraint = this.withStackParticipation(completeTangentConstraint(this.model, { ...clone(input), id: input.id || createUuid() }));
        if (constraint.type === 'Length' && !Number.isFinite(Number(constraint.value))) {
          constraint.value = featureLength(this.model, constraint.featureRefs?.[0]);
        }
        this.registry.validate(this.model, constraint, this.dimensions);
        acceptedConstraints.push(constraint);
        return constraint;
      });
      this.model.addConstraints(stagedConstraints);
      stagedConstraints.forEach((constraint) => this.constraintGraph?.addConstraint(constraint.id));
      const solveOptions = { seedConstraintIds: acceptedConstraints.map(({ id }) => id) };
      solveResult = this.solve(solveOptions);
      // A batch can start very close to a solution while still being poorly
      // conditioned for the dense Jacobian (this is common when a fillet
      // trims an arc that participates in an Equal constraint). Retry the
      // same staged transaction with the block Jacobian before rejecting it.
      // The model is intentionally left staged by the failed solve so the
      // retry starts from the exact same candidate geometry.
      if (solveResult?.status === 'max-iterations') {
        solveResult = this.solve({
          ...solveOptions,
          jacobianMode: 'blocks',
          maxIterations: 5000,
        });
      }
      if (!isSuccessfulSolve(solveResult)) throw new Error(solveResult.message || 'Constraint batch could not be solved.');
      this.emit();
      return {
        committed: true,
        constraints: acceptedConstraints,
        result: solveResult,
        snapshot: this.getGeometrySnapshot(),
      };
    } catch (error) {
      this.loadSketch(before);
      this.lastResult = {
        ...(solveResult || {}),
        status: solveResult?.status || 'rejected',
        message: error.message || solveResult?.message || 'Constraint batch could not be applied.',
        changedEntityIds: [],
      };
      this.emit();
      return {
        committed: false,
        constraints: [],
        result: this.lastResult,
        snapshot: this.getGeometrySnapshot(),
      };
    }
  }

  removeConstraint(id) {
    const graph = this.getConstraintGraph();
    const previousScope = graph.scopeForSeeds({ constraintIds: [id] });
    const removed = this.model.removeConstraint(id);
    if (removed) {
      this.invalidateStackParticipationGraph();
      graph.removeConstraint(id);
      this.lastResult = this.solve({ seedVariableIds: [...(previousScope?.variableIds || [])] });
      this.emit();
    }
    return removed;
  }

  constraints() {
    return [...this.model.constraints.values()].map(clone);
  }

  constraintsForRecordIds(recordIds = []) {
    const graph = this.getConstraintGraph();
    const constraintIds = new Set();
    [...recordIds].forEach((recordId) => {
      graph.constraintIdsForRecord(recordId).forEach((constraintId) => constraintIds.add(constraintId));
    });
    return [...constraintIds]
      .map((constraintId) => this.model.constraints.get(constraintId))
      .filter(Boolean)
      .map(clone);
  }

  beginDrag(variableIds) {
    this.dragLocks = new Set(variableIds);
    this.pendingDragEntities = [];
  }

  releaseDragLocks() {
    this.dragLocks.clear();
    this.pendingDragEntities = [];
  }

  commitDragEntities(entities, lockedVariableIds = [], solveOptions = {}) {
    return this.updateEntities(entities, {
      lockedVariableIds,
      solveOptions: { ...solveOptions, solveMode: 'final' },
    }).result;
  }

  endDrag() {
    const seedVariableIds = [...this.dragLocks];
    const pendingEntities = this.pendingDragEntities.map(clone);
    if (pendingEntities.length) {
      const result = this.commitDragEntities(pendingEntities, seedVariableIds);
      this.releaseDragLocks();
      return result;
    }
    this.dragLocks.clear();
    const result = this.solve({ seedVariableIds });
    this.emit();
    return result;
  }

  variableIdsForFeature(feature) {
    return this.model.variableIdsForFeature(feature);
  }

  dragVariableIdsForFeature(feature) {
    const variableIds = this.variableIdsForFeature(feature);
    const recordId = feature?.recordId || feature?.entityId;
    if (!recordId || feature?.kind !== 'point') return variableIds;
    const controlledAxes = new Set();
    const oppositeAxisLocks = new Set();
    this.constraintsForRecordIds([recordId]).forEach((constraint) => {
      if (constraint.source !== 'dimension' || !constraint.dimensionRef) return;
      const parameter = this.dimensions.get(constraint.dimensionRef);
      if (!parameter?.driving || parameter.enabled === false) return;
      const annotation = this.dimensionAnnotations.get(constraint.dimensionRef);
      if (annotation?.type !== 'dimension-line') return;
      let controlledAxis = null;
      if (annotation.subtype === 'horizontal') controlledAxis = 'x';
      else if (annotation.subtype === 'vertical') controlledAxis = 'y';
      else {
        const start = annotation.measureStart || annotation.start;
        const end = annotation.measureEnd || annotation.end;
        if (!start || !end) return;
        const dx = Math.abs(end[0] - start[0]);
        const dy = Math.abs(end[1] - start[1]);
        if (dy > dx * 2) controlledAxis = 'y';
        else if (dx > dy * 2) controlledAxis = 'x';
      }
      if (!controlledAxis) return;
      controlledAxes.add(controlledAxis);
      const references = [...(constraint.featureRefs || [])];
      if (!references.length && constraint.anchors) {
        const pending = [constraint.anchors];
        while (pending.length) {
          const anchor = pending.pop();
          if (!anchor || typeof anchor !== 'object') continue;
          if (anchor.recordId || anchor.entityId) {
            references.push(anchor);
            continue;
          }
          Object.values(anchor).forEach((value) => {
            if (value && typeof value === 'object') pending.push(value);
          });
        }
      }
      references
        .filter((reference) => (reference.recordId || reference.entityId) !== recordId)
        .flatMap((reference) => this.variableIdsForFeature(reference))
        .filter((variableId) => this.model.variableById(variableId)?.parameterKey?.endsWith(`.${controlledAxis}`))
        .forEach((variableId) => oppositeAxisLocks.add(variableId));
    });
    const draggedAxisLocks = variableIds.filter((variableId) => (
      !controlledAxes.has('x') || !this.model.variableById(variableId)?.parameterKey?.endsWith('.x')
    ) && (
      !controlledAxes.has('y') || !this.model.variableById(variableId)?.parameterKey?.endsWith('.y')
    ));
    return [...new Set([...draggedAxisLocks, ...oppositeAxisLocks])];
  }

  variableIdsForEntity(entityId) {
    return this.model.binding(entityId)?.allVariables().map((variable) => variable.id) || [];
  }

  addDimension(entity) {
    const owned = this.withStackParticipation(clone({ id: entity.id || createUuid(), ...entity }), entity.stackId || this.defaultStackId());
    const frame = this.model.stackFrame(owned.stackId);
    const local = normalizeDimensionDirection(normalizeDimensionOrientation(transformStackEntity(owned, frame, true)), this.model.constraintModel(owned));
    const dimension = transformStackEntity(local, frame);
    dimension.coordinateFrame = { ...frame };
    const value = dimensionValue(transformStackEntity(dimension, this.model.stackFrame(dimension.stackId), true));
    const driving = dimension.dimensionMode === 'driving';
    const unit = dimension.type === 'angle-dimension' ? 'deg' : this.drawingUnit;
    const entry = this.dimensions.addDimension({
      id: dimension.dimensionId || createUuid(),
      name: dimension.dimensionName,
      expression: this.dimensions.formatValue(value, unit),
      value,
      driving,
      unit,
      annotationId: dimension.id,
      stackId: dimension.stackId,
      participantStackIds: dimension.participantStackIds,
    });
    dimension.dimensionId = entry.id;
    dimension.dimensionName = entry.name;
    this.setDimensionAnnotation(entry.id, dimension);
    const fallbackToDriven = (result) => {
      this.dimensions.remove(entry.id, { allowDimension: true });
      const drivenEntity = { ...dimension, dimensionMode: 'driven' };
      const drivenEntry = this.dimensions.addDimension({
        id: entry.id,
        name: entry.name,
        value,
        driving: false,
        unit: entry.unit,
        annotationId: dimension.id,
        stackId: dimension.stackId,
        participantStackIds: dimension.participantStackIds,
      });
      this.setDimensionAnnotation(drivenEntry.id, drivenEntity);
      this.dimensions.setComputedResolver(drivenEntry.id, () => dimensionValueFromModel(this.dimensionAnnotations.get(drivenEntry.id), this.model));
      return { entity: drivenEntity, result };
    };
    if (!driving) {
      this.dimensions.setComputedResolver(entry.id, () => dimensionValueFromModel(this.dimensionAnnotations.get(entry.id), this.model));
      return { entity: dimension, result: null };
    }
    if (dimension.externalDrivingTarget) {
      return { entity: dimension, result: { status: 'unchanged', message: 'External driving dimension registered.' } };
    }
    let constraint = null;
    if (dimension.type === 'dimension-line') {
      const lineToLine = dimension.anchors?.lineToLine;
      const pointToSegment = dimension.anchors?.pointToSegment;
      constraint = lineToLine ? {
        type: 'Line Line Distance',
        source: 'dimension',
        subtype: 'aligned',
        orientation: dimension.orientation,
        direction: dimension.direction,
        featureRefs: [lineToLine.reference, lineToLine.measured],
        dimensionRef: entry.id,
      } : pointToSegment ? {
        type: 'Point Line Distance',
        source: 'dimension',
        subtype: dimension.subtype,
        orientation: dimension.orientation,
        direction: dimension.direction,
        ...(pointToSegment.projectionMode ? { projectionMode: pointToSegment.projectionMode } : {}),
        featureRefs: [
          { kind: 'point', ...pointToSegment.point },
          pointToSegment.segment,
        ],
        dimensionRef: entry.id,
      } : {
        type: dimension.subtype === 'horizontal' ? 'Horizontal Distance' : dimension.subtype === 'vertical' ? 'Vertical Distance' : 'Distance',
        source: 'dimension',
        anchors: { start: dimension.anchors?.measureStart || dimension.anchors?.start, end: dimension.anchors?.measureEnd || dimension.anchors?.end },
        featureRefs: [],
        dimensionRef: entry.id,
        orientation: dimension.orientation,
        direction: dimension.direction,
      };
    }
    if (dimension.type === 'radius-dimension') {
      constraint = {
        type: dimension.subtype === 'diameter' ? 'Diameter' : 'Radius',
        source: 'dimension',
        featureRefs: [{ kind: 'circle', recordId: dimension.anchors?.center?.recordId }],
        dimensionRef: entry.id,
        direction: dimension.direction,
      };
    }
    if (dimension.type === 'angle-dimension') {
      constraint = {
        type: 'Angle',
        source: 'dimension',
        featureRefs: [segmentRefFromAnchors(dimension.anchors?.firstSegment), segmentRefFromAnchors(dimension.anchors?.secondSegment)],
        dimensionRef: entry.id,
        firstRaySign: dimension.firstRaySign || 1,
        secondRaySign: dimension.secondRaySign || 1,
        angleOrientation: dimension.angleOrientation || 1,
        direction: dimension.direction,
      };
    }
    if (!constraint || constraint.featureRefs?.some((ref) => !ref) || (constraint.anchors && (!constraint.anchors.start || !constraint.anchors.end))) {
      return fallbackToDriven({ status: 'invalid', message: 'Driving dimension is not linked to solvable geometry.' });
    }
    let added;
    try {
      added = this.addConstraint(constraint, { dimensionSolve: true });
    } catch (error) {
      return fallbackToDriven({ status: 'invalid', message: error.message });
    }
    if (!added.constraint) {
      return fallbackToDriven(added.result);
    }
    this.dimensionConstraints.set(entry.id, added.constraint.id);
    return { entity: dimension, result: added.result };
  }

  setDimension(idOrName, expression) {
    const existing = this.dimensions.get(idOrName);
    if (!existing) return { status: 'invalid', message: `Unknown dimension: ${idOrName}` };
    const affectedParameterIds = this.dimensions.affectedIds(existing.id);
    const beforeDimensions = this.dimensions.snapshotEntries(affectedParameterIds);
    const affectedDimensionIds = [...affectedParameterIds]
      .filter((id) => this.dimensions.get(id)?.kind === 'dimension');
    const annotation = this.dimensionAnnotations.get(existing.id);
    const hasSolverDimensionDependency = affectedDimensionIds.some((id) => this.dimensionConstraints.has(id));
    if (annotation?.externalDrivingTarget && !hasSolverDimensionDependency) {
      try {
        this.dimensions.set({ ...existing, expression });
      } catch (error) {
        this.dimensions.restoreEntries(beforeDimensions, { emit: false });
        return { status: 'invalid', message: error.message };
      }
      this.lastResult = {
        status: 'unchanged',
        message: 'External driving dimension updated.',
        changedEntityIds: [],
        solveScope: { mode: 'none' },
      };
      this.emit();
      return this.lastResult;
    }
    const beforeGeometry = this.snapshotGeometryForSeeds({ dimensionIds: affectedDimensionIds });
    let targetValue;
    try {
      this.dimensions.set({ ...existing, expression });
      targetValue = Number(this.dimensions.get(existing.id)?.value);
    } catch (error) {
      this.dimensions.restoreEntries(beforeDimensions, { emit: false });
      return { status: 'invalid', message: error.message };
    }
    const startValue = Number(existing.value);
    let stepCount = dimensionContinuationStepCount(startValue, targetValue);
    let result;
    if (stepCount > 1) {
      this.dimensions.restoreEntries(beforeDimensions, { emit: false });
      result = this.solveDimensionContinuation(existing, expression, targetValue, stepCount, affectedDimensionIds);
    } else {
      result = this.solveDimensionStep({ seedDimensionIds: affectedDimensionIds });
      if (!isSuccessfulSolve(result)) {
        stepCount = dimensionContinuationStepCount(startValue, targetValue, { force: true });
        if (stepCount > 1) {
          this.dimensions.restoreEntries(beforeDimensions, { emit: false });
          result = this.solveDimensionContinuation(existing, expression, targetValue, stepCount, affectedDimensionIds);
        }
      }
    }
    if (!isSuccessfulSolve(result)) {
      result = withDrivingDimensionLoopDiagnostic(result, {
        model: this.model,
        dimensions: this.dimensions,
        dimensionIds: affectedDimensionIds,
        beforeEntries: beforeDimensions,
        sourceName: existing.name,
        requestedExpression: expression,
      });
      this.lastResult = result;
      this.restoreGeometryTransaction(beforeGeometry);
      this.dimensions.restoreEntries(beforeDimensions, { emit: false });
    }
    this.emit();
    return result;
  }

  solveDimensionContinuation(existing, expression, targetValue, stepCount, affectedDimensionIds = [existing.id]) {
    const startValue = Number(existing.value);
    const results = [];
    for (let step = 1; step <= stepCount; step += 1) {
      const fraction = step / stepCount;
      const intermediateValue = startValue + (targetValue - startValue) * fraction;
      const stepExpression = step === stepCount
        ? expression
        : exactDimensionValueExpression(intermediateValue, existing.unit);
      try {
        this.dimensions.set({ ...this.dimensions.get(existing.id), expression: stepExpression });
      } catch (error) {
        return {
          status: 'invalid',
          message: error.message,
          changedEntityIds: [],
          continuationSteps: step,
        };
      }
      const result = this.solveDimensionStep({ seedDimensionIds: affectedDimensionIds });
      results.push(result);
      if (!isSuccessfulSolve(result)) return combineContinuationResults(results);
    }
    this.lastResult = combineContinuationResults(results);
    return this.lastResult;
  }

  restoreDimensionSnapshot(snapshot) {
    this.dimensions.restore(snapshot, { emit: false });
    this.dimensions.list().forEach((entry) => {
      if (!entry.computed) return;
      this.dimensions.setComputedResolver(entry.id, () => {
        const annotation = this.dimensionAnnotations.get(entry.id);
        return annotation ? dimensionValueFromModel(annotation, this.model) : entry.value;
      });
    });
    this.dimensions.evaluateDirty({ strict: false });
  }

  setDimensionEnabledStates(states = []) {
    const requested = states instanceof Map ? states : new Map(states);
    let changed = false;
    const graph = this.getConstraintGraph();
    const affectedVariableIds = new Set();
    requested.forEach((enabledValue, dimensionId) => {
      const entry = this.dimensions.get(dimensionId);
      if (entry?.kind !== 'dimension') return;
      const annotation = this.dimensionAnnotations.get(dimensionId);
      const enabled = Boolean(enabledValue)
        && this.dimensions.isEntryAvailable(entry)
        && this.relationshipIsEnabled(annotation || entry);
      if ((entry.enabled !== false) !== enabled) {
        this.dimensions.setEnabled(dimensionId, enabled, { evaluate: false, emit: false });
        changed = true;
      }
      const constraintId = this.dimensionConstraints.get(dimensionId);
      const constraint = constraintId ? this.model.constraints.get(constraintId) : null;
      if (constraint && constraint.enabled !== enabled) {
        graph.scopeForSeeds({ constraintIds: [constraint.id] })?.variableIds
          .forEach((id) => affectedVariableIds.add(id));
        constraint.enabled = enabled;
        if (enabled) {
          graph.addConstraint(constraint.id);
          graph.scopeForSeeds({ constraintIds: [constraint.id] })?.variableIds
            .forEach((id) => affectedVariableIds.add(id));
        } else {
          graph.removeConstraint(constraint.id, { retainReferences: true })
            .forEach((id) => affectedVariableIds.add(id));
        }
        changed = true;
      }
    });
    if (!changed) {
      return {
        changed: false,
        result: this.lastResult,
        snapshot: this.getGeometrySnapshot(),
      };
    }
    this.dimensions.evaluateDirty({ strict: false });
    this.lastResult = affectedVariableIds.size
      ? this.solve({ seedVariableIds: [...affectedVariableIds] })
      : { status: 'unchanged', message: 'Dimension state updated.', changedEntityIds: [], solveScope: { mode: 'none' } };
    this.emit();
    return {
      changed: true,
      result: this.lastResult,
      snapshot: this.getGeometrySnapshot(),
    };
  }

  removeDimension(dimensionId) {
    const constraintId = this.dimensionConstraints.get(dimensionId);
    let affectedVariableIds = new Set();
    if (constraintId) {
      const graph = this.getConstraintGraph();
      const previousScope = graph.scopeForSeeds({ constraintIds: [constraintId] });
      affectedVariableIds = new Set(previousScope?.variableIds || []);
      this.model.removeConstraint(constraintId);
      graph.removeConstraint(constraintId);
    }
    this.dimensionConstraints.delete(dimensionId);
    this.deleteDimensionAnnotation(dimensionId);
    const removed = this.dimensions.remove(dimensionId, { allowDimension: true });
    if (removed) {
      this.invalidateStackParticipationGraph();
      this.lastResult = affectedVariableIds.size
        ? this.solve({ seedVariableIds: [...affectedVariableIds] })
        : { status: 'unchanged', message: 'Dimension removed.', changedEntityIds: [], solveScope: { mode: 'none' } };
      this.emit();
    }
    return removed;
  }

  removeStackData(stackId, recordIds = []) {
    return this.removeStackDataMany([stackId], recordIds);
  }

  removeStackDataMany(stackIds = [], recordIds = []) {
    const removedStackIds = new Set(stackIds.map(String));
    const removedRecordIds = new Set(recordIds.map(String));
    const dimensionIds = this.dimensions.list()
      .filter((entry) => entry.kind === 'dimension' && (
        removedStackIds.has(entry.stackId)
        || entry.participantStackIds?.some((stackId) => removedStackIds.has(stackId))
        || [...(this.recordsForDimension.get(entry.id) || [])].some((id) => removedRecordIds.has(String(id)))
      ))
      .map(({ id }) => id);
    const dimensionIdSet = new Set(dimensionIds);
    const annotationIds = dimensionIds
      .map((id) => this.dimensionAnnotations.get(id)?.id)
      .filter(Boolean);
    const constraintIds = [...this.model.constraints.values()]
      .filter((constraint) => (
        removedStackIds.has(constraint.stackId)
        || constraint.participantStackIds?.some((stackId) => removedStackIds.has(stackId))
        || dimensionIdSet.has(constraint.dimensionRef)
        || [...referencedRecordIds(constraint)].some((id) => removedRecordIds.has(String(id)))
      ))
      .map(({ id }) => id);
    dimensionIds.forEach((dimensionId) => {
      const drivingConstraintId = this.dimensionConstraints.get(dimensionId);
      if (drivingConstraintId) this.model.removeConstraint(drivingConstraintId);
      this.dimensionConstraints.delete(dimensionId);
      this.deleteDimensionAnnotation(dimensionId);
    });
    constraintIds.forEach((constraintId) => this.model.removeConstraint(constraintId));
    this.dimensions.removeMany(dimensionIds, { allowDimension: true });
    if (dimensionIds.length || constraintIds.length) {
      this.invalidateConstraintGraph();
      this.lastResult = {
        status: 'unchanged',
        message: 'Stack-owned dimensions and constraints removed.',
        changedEntityIds: [],
        solveScope: { mode: 'none' },
      };
      this.emit();
    }
    return { dimensionIds, annotationIds, constraintIds };
  }

  updateDimensionAnnotation(dimensionId, entity) {
    if (!this.dimensionAnnotations.has(dimensionId)) return false;
    const next = this.withStackParticipation(entity, entity?.stackId || this.defaultStackId());
    const entry = this.dimensions.updateDimensionScope(dimensionId, {
      stackId: next.stackId,
      participantStackIds: next.participantStackIds,
      emit: false,
    });
    this.setDimensionAnnotation(dimensionId, {
      ...next,
      ...(entry ? { dimensionName: entry.name } : {}),
    });
    this.dimensions.emit();
    return true;
  }

  refreshStackParticipation() {
    this.model.constraints.forEach((constraint, id) => {
      this.model.constraints.set(id, this.withStackParticipation(constraint, constraint.stackId || this.defaultStackId()));
    });
    [...this.dimensionAnnotations.entries()].forEach(([dimensionId, annotation]) => {
      const next = this.withStackParticipation(annotation, annotation.stackId || this.defaultStackId());
      const entry = this.dimensions.updateDimensionScope(dimensionId, {
        stackId: next.stackId,
        participantStackIds: next.participantStackIds,
        emit: false,
      });
      this.setDimensionAnnotation(dimensionId, {
        ...next,
        ...(entry ? { dimensionName: entry.name } : {}),
      });
    });
    this.dimensions.emit();
    this.emit();
    return {
      constraints: this.constraints(),
      dimensions: this.parameters().filter(({ kind }) => kind === 'dimension'),
    };
  }

  restoreFilletRadiusDimension(dimensionId, recordId) {
    const entry = this.dimensions.get(dimensionId);
    const annotation = this.dimensionAnnotations.get(dimensionId);
    if (!entry || entry.kind !== 'dimension' || !annotation || annotation.type !== 'radius-dimension') {
      return { status: 'invalid', message: 'The fillet radius dimension is not available.' };
    }
    if (!this.model.binding(recordId)) {
      return { status: 'invalid', message: 'The linked fillet arc is not available.' };
    }
    const existingConstraintId = this.dimensionConstraints.get(dimensionId);
    if (existingConstraintId) {
      const nextAnnotation = clone(annotation);
      delete nextAnnotation.externalDrivingTarget;
      this.setDimensionAnnotation(dimensionId, nextAnnotation);
      return { status: 'unchanged', message: 'Fillet radius dimension is already solver-driven.' };
    }
    const beforeEntities = this.getGeometrySnapshot();
    const constraint = {
      id: createUuid(),
      type: annotation.subtype === 'diameter' ? 'Diameter' : 'Radius',
      source: 'dimension',
      featureRefs: [{ kind: 'circle', recordId }],
      dimensionRef: dimensionId,
      direction: annotation.direction,
    };
    let result = null;
    try {
      this.registry.validate(this.model, constraint, this.dimensions);
      this.model.addConstraint(constraint);
      if (!isStackFrameRelationship(constraint)) this.getConstraintGraph().addConstraint(constraint.id);
      this.dimensionConstraints.set(dimensionId, constraint.id);
      const solveOptions = { seedConstraintIds: [constraint.id] };
      result = this.solveDimensionStep(solveOptions);
      if (!isSuccessfulSolve(result)) throw new Error(result?.message || 'Fillet radius constraint could not be restored.');
      const nextAnnotation = clone(annotation);
      delete nextAnnotation.externalDrivingTarget;
      this.setDimensionAnnotation(dimensionId, nextAnnotation);
      this.emit();
      return result;
    } catch (error) {
      this.model.removeConstraint(constraint.id);
      this.constraintGraph?.removeConstraint(constraint.id);
      this.dimensionConstraints.delete(dimensionId);
      restoreEntities(this.model, beforeEntities);
      this.lastResult = {
        ...(result || {}),
        status: result?.status || 'rejected',
        message: error.message || 'Fillet radius constraint could not be restored.',
        changedEntityIds: [],
      };
      this.emit();
      return this.lastResult;
    }
  }

  solveDimensionStep(options = {}) {
    let result = this.solve({ ...options, tolerance: options.tolerance ?? DEFAULT_SOLVE_TOLERANCE });
    if (result?.status === 'max-iterations') {
      result = this.solve({
        ...options,
        tolerance: options.tolerance ?? DEFAULT_SOLVE_TOLERANCE,
        jacobianMode: 'blocks',
        maxIterations: 10000,
      });
    }
    return result;
  }

  promoteExternalDimension(dimensionId, externalDrivingTarget) {
    const constraintId = this.dimensionConstraints.get(dimensionId);
    if (constraintId) {
      this.model.removeConstraint(constraintId);
      this.constraintGraph?.removeConstraint(constraintId);
      this.dimensionConstraints.delete(dimensionId);
    }
    const annotation = this.dimensionAnnotations.get(dimensionId);
    if (annotation) {
      this.setDimensionAnnotation(dimensionId, {
        ...annotation,
        externalDrivingTarget: clone(externalDrivingTarget),
      });
    }
    return true;
  }

  parameters() {
    this.dimensions.evaluateDirty({ strict: false });
    return this.dimensions.list();
  }

  enabledGeometrySnapshot(snapshot = null) {
    if (snapshot) {
      if (!this.activationFiltering) return snapshot;
      return snapshot.filter((entity) => this.isStackEnabled(
        entity.stackId || this.entityStackIds.get(entity.id) || this.defaultStackId(),
      ));
    }
    if (!this.activationFiltering) return this.model.snapshot();
    if (this.entityStackIds.size !== this.model.entities.size) this.rebuildEntityStackIndex();
    return this.getGeometrySnapshot([...this.enabledStackIds]
      .flatMap((stackId) => [...(this.entityIdsByStack.get(stackId) || [])]));
  }

  refreshDocumentVariables(entities = this.enabledGeometrySnapshot()) {
    const variables = buildDocumentVariables({
      metadata: this.documentMetadata,
      context: this.documentContext,
      drawingUnit: this.drawingUnit,
      entities,
    });
    this.dimensions.setExternalVariables(variables);
    return variables;
  }

  documentVariables() {
    return buildDocumentVariables({
      metadata: this.documentMetadata,
      context: this.documentContext,
      drawingUnit: this.drawingUnit,
      entities: this.enabledGeometrySnapshot(),
    });
  }

  getDocumentMetadata() {
    return cloneDocumentMetadata(this.documentMetadata);
  }

  setDocumentMetadata(patch = {}) {
    this.documentMetadata = documentMetadataPatch(this.documentMetadata, patch);
    this.emit();
    return this.getDocumentMetadata();
  }

  setDocumentContext(patch = {}) {
    this.documentContext = {
      ...this.documentContext,
      ...(patch.fileName !== undefined ? { fileName: String(patch.fileName ?? '') } : {}),
      ...(patch.filePath !== undefined ? { filePath: String(patch.filePath ?? '') } : {}),
    };
    this.emit();
    return { ...this.documentContext };
  }

  getDimensionText(idOrName, mode = 'named-value') {
    this.dimensions.evaluateDirty({ strict: false });
    const entry = this.dimensions.get(idOrName);
    if (!entry) return '';
    if (mode === 'expression') return `${entry.name} = ${expressionWithoutUnitSuffixes(entry.expression)}`;
    const valueText = formatUnitlessValue(entry.value, entry.unit);
    if (mode === 'value') {
      const annotation = this.dimensionAnnotations.get(entry.id);
      const prefix = annotation?.type === 'multi-curve-length-dimension' ? 'PERIM ' : '';
      const useReadOnlyValueFormat = !entry.driving || annotation?.includeInValueOnly === true;
      return useReadOnlyValueFormat
        ? `${prefix}${formatValueOnlyDimensionValue(entry.value, entry.unit)}`
        : valueText;
    }
    return `${entry.name} = ${valueText}`;
  }

  createParameter(input = {}) {
    return this.dimensions.createUser(input);
  }

  createControlParameter(input = {}) {
    return this.dimensions.createControl(input);
  }

  updateParameter(id, patch) {
    const affectedBefore = this.dimensions.affectedIds(id);
    const beforeDimensions = this.dimensions.snapshotEntries(affectedBefore);
    const affectedDimensionsBefore = [...affectedBefore]
      .filter((affectedId) => this.dimensions.get(affectedId)?.kind === 'dimension');
    const beforeGeometry = this.snapshotGeometryForSeeds({ dimensionIds: affectedDimensionsBefore });
    let entry;
    try {
      entry = this.dimensions.update(id, patch, { strict: false });
    } catch (error) {
      const failedEntry = this.dimensions.get(id);
      return { entry: failedEntry, result: this.decorateParameterFailure(failedEntry, error.message) };
    }
    const invalidDriving = this.dimensions.list().find((candidate) => candidate.kind === 'dimension' && candidate.driving && candidate.error);
    if (invalidDriving || entry.error) {
      const offender = entry.error ? entry : invalidDriving;
      return { entry, result: this.decorateParameterFailure(offender, offender?.error || 'A driving expression is invalid.') };
    }
    const affectedDimensionIds = [...this.dimensions.affectedIds(entry.id)]
      .filter((affectedId) => this.dimensions.get(affectedId)?.kind === 'dimension');
    const targetDimensions = this.dimensions.snapshotEntries(this.dimensions.affectedIds(entry.id));
    const continuationDimensionIds = affectedDimensionIds
      .filter((dimensionId) => this.dimensionConstraints.has(dimensionId));
    let result;
    if (affectedDimensionIds.length) {
      let stepCount = dimensionTargetContinuationStepCount(
        beforeDimensions,
        targetDimensions,
        continuationDimensionIds,
      );
      if (stepCount > 1) {
        this.dimensions.restoreEntries(beforeDimensions, { emit: false });
        result = this.solveParameterContinuation(
          beforeDimensions,
          targetDimensions,
          continuationDimensionIds,
          stepCount,
        );
      } else {
        result = this.solve({ seedDimensionIds: affectedDimensionIds });
        if (!isSuccessfulSolve(result) && continuationDimensionIds.length) {
          stepCount = dimensionTargetContinuationStepCount(
            beforeDimensions,
            targetDimensions,
            continuationDimensionIds,
            { force: true },
          );
          if (stepCount > 1) {
            this.dimensions.restoreEntries(beforeDimensions, { emit: false });
            result = this.solveParameterContinuation(
              beforeDimensions,
              targetDimensions,
              continuationDimensionIds,
              stepCount,
            );
          }
        }
      }
    } else {
      result = {
        status: 'unchanged',
        message: 'No solver dimensions depend on this parameter.',
        changedEntityIds: [],
        solveScope: { mode: 'none' },
      };
    }
    this.lastResult = result;
    if (!isSuccessfulSolve(result)) {
      result = withDrivingDimensionLoopDiagnostic(result, {
        model: this.model,
        dimensions: this.dimensions,
        dimensionIds: affectedDimensionIds,
        beforeEntries: beforeDimensions,
        sourceName: entry.name,
        requestedExpression: entry.expression,
      });
      this.lastResult = result;
      this.dimensions.restoreEntries(beforeDimensions, { emit: false });
      this.restoreGeometryTransaction(beforeGeometry);
    }
    this.emit();
    return { entry: this.dimensions.get(id), result };
  }

  solveParameterContinuation(beforeEntries, targetEntries, dimensionIds, stepCount) {
    const beforeById = new Map(beforeEntries.map((entry) => [entry.id, entry]));
    const targetById = new Map(targetEntries.map((entry) => [entry.id, entry]));
    const interpolatedDimensions = dimensionIds
      .map((dimensionId) => ({
        before: beforeById.get(dimensionId),
        target: targetById.get(dimensionId),
      }))
      .filter(({ before, target }) => (
        before
        && target
        && Number.isFinite(Number(before.value))
        && Number.isFinite(Number(target.value))
      ));
    if (!interpolatedDimensions.length) {
      this.dimensions.restoreEntries(targetEntries, { emit: false });
      return this.solve({ seedDimensionIds: dimensionIds });
    }
    const results = [];
    for (let step = 1; step <= stepCount; step += 1) {
      const fraction = step / stepCount;
      interpolatedDimensions.forEach(({ before, target }) => {
        const intermediateValue = Number(before.value)
          + (Number(target.value) - Number(before.value)) * fraction;
        this.dimensions.set({
          ...this.dimensions.get(target.id),
          expression: exactDimensionValueExpression(intermediateValue, target.unit),
        });
      });
      const result = this.solve({ seedDimensionIds: dimensionIds });
      results.push(result);
      if (!isSuccessfulSolve(result)) return combineContinuationResults(results);
    }
    this.dimensions.restoreEntries(targetEntries, { emit: false });
    this.lastResult = combineContinuationResults(results);
    return this.lastResult;
  }

  removeParameter(id) {
    const removed = this.dimensions.remove(id);
    if (removed) {
      this.lastResult = this.solve();
      this.emit();
    }
    return removed;
  }

  reorderParameter(id, beforeId = null) {
    return this.dimensions.reorder(id, beforeId);
  }

  setDrawingProperties({
    drawingUnit = this.drawingUnit,
    dxfExportUnit = this.dxfExportUnit,
    filletRadius = null,
  } = {}) {
    const nextDrawingUnit = drawingUnits.has(drawingUnit) ? drawingUnit : this.drawingUnit;
    const nextDxfExportUnit = drawingUnits.has(dxfExportUnit) ? dxfExportUnit : this.dxfExportUnit;
    const unitChanged = nextDrawingUnit !== this.drawingUnit;
    const previousDrawingUnit = this.drawingUnit;
    this.drawingUnit = nextDrawingUnit;
    this.dxfExportUnit = nextDxfExportUnit;
    const requestedFilletRadius = Number(filletRadius);
    if (Number.isFinite(requestedFilletRadius) && requestedFilletRadius > 0) {
      this.filletRadius = requestedFilletRadius * unitFactors[nextDrawingUnit];
    }
    this.dimensions.setDefaultLengthUnit(nextDrawingUnit);
    if (unitChanged) {
      this.dimensions.list()
        .filter((entry) => entry.kind === 'dimension' && entry.unit !== 'deg')
        .forEach((entry) => this.dimensions.update(entry.id, {
          unit: nextDrawingUnit,
          ...(entry.computed ? {} : { expression: convertedLengthExpression(entry.expression, previousDrawingUnit, nextDrawingUnit) }),
        }, { strict: false }));
      this.solve();
    }
    this.emit();
    return {
      drawingUnit: this.drawingUnit,
      dxfExportUnit: this.dxfExportUnit,
      filletRadius: this.filletRadius,
    };
  }

  getGeometrySnapshot(entityIds = null) {
    if (entityIds === null || entityIds === undefined) return this.model.snapshot();
    return [...new Set(entityIds)]
      .map((entityId) => this.model.entity(entityId))
      .filter(Boolean);
  }

  getEntity(entityId) {
    return this.model.entity(entityId);
  }

  setDerivedEntity(entity) {
    const result = this.model.setDerivedEntity(entity);
    if (this.constraintGraph) this.constraintGraph.updateDerivedEntity(result.id);
    return result;
  }

  removeDerivedEntity(entityId) {
    const graph = this.constraintGraph;
    const removedConstraintIds = graph
      ? graph.constraintIdsForRecord(entityId)
      : new Set([...this.model.constraints]
        .filter(([, constraint]) => referencesRecord(constraint, entityId))
        .map(([constraintId]) => constraintId));
    const removed = this.model.removeDerivedEntity(entityId);
    if (!removed) return false;
    this.model.removeConstraints(removedConstraintIds);
    if (graph) graph.removeDerivedEntity(entityId, removedConstraintIds);
    return true;
  }
}

export function createSolverController(options = {}) {
  return new SolverController(options);
}
