import { ConstraintRegistry } from './ConstraintRegistry.js';
import { ConstraintGraph } from './ConstraintGraph.js';
import { solveConstraintComponents, solveConstraintScope } from './ComponentSolver.js';
import { DimensionRepository, featureLength, isSuccessfulSolve } from './NumericSolverCore.js';
import { SketchModel, createStableId } from './SolverModel.js';
import { findDrivingDimensionLoop, formatDrivingDimensionLoopMessage } from './DimensionConflictDiagnostics.js';
import { formatDrivenDimensionValue, formatUnitlessValue, unitFactors } from './Units.js';
import { remapCurvePointIndex } from '../DrawingTools.js';
import { isCanvasOriginReference } from '../CanvasOrigin.js';
import {
  buildDocumentVariables,
  cloneDocumentMetadata,
  documentMetadataPatch,
  normalizeDocumentMetadata,
} from '../DocumentVariables.js';

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
    this.dimensions = new DimensionRepository();
    this.registry = new ConstraintRegistry();
    this.constraintGraph = null;
    this.listeners = new Set();
    this.lastResult = null;
    this.dragLocks = new Set();
    this.pendingDragEntities = [];
    this.dimensionConstraints = new Map();
    this.dimensionAnnotations = new Map();
    this.recordsForDimension = new Map();
    this.dimensionsForRecord = new Map();
    this.drawingUnit = 'in';
    this.dxfExportUnit = 'in';
    this.filletRadius = unitFactors[this.drawingUnit];
    this.documentMetadata = normalizeDocumentMetadata();
    this.documentContext = { fileName: '', filePath: '' };
    this.jacobianMode = jacobianMode === 'blocks' ? 'blocks' : 'dense';
    this.matrixFreeVariableThreshold = matrixFreeVariableThreshold;
    // This trial is intentionally reversible while the interaction is being
    // evaluated. Set rigidFirstConstraintSolve to false to restore the prior
    // one-pass solver behavior without changing constraint data.
    this.rigidFirstConstraintSolve = rigidFirstConstraintSolve !== false;
    this.dimensions.setDefaultLengthUnit(this.drawingUnit);
    this.refreshDocumentVariables();
  }

  emit() {
    const snapshot = this.getGeometrySnapshot();
    this.documentMetadata.modifiedDate = new Date().toISOString().slice(0, 10);
    this.refreshDocumentVariables(snapshot);
    this.listeners.forEach((listener) => listener(snapshot, this.lastResult));
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  invalidateConstraintGraph() {
    this.constraintGraph = null;
  }

  getConstraintGraph() {
    if (!this.constraintGraph) this.constraintGraph = new ConstraintGraph(this.model);
    return this.constraintGraph;
  }

  constraintGraphDiagnostics() {
    return this.getConstraintGraph().diagnostics({ registry: this.registry, dimensions: this.dimensions });
  }

  setDimensionAnnotation(dimensionId, annotation) {
    this.deleteDimensionAnnotation(dimensionId);
    const stored = clone(annotation);
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
    if (transaction?.entities?.length) restoreEntities(this.model, transaction.entities);
  }

  addEntity(entity) {
    const created = this.model.addEntity(entity);
    if (this.constraintGraph) this.constraintGraph.addEntity(created.id);
    this.emit();
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
    const removed = this.model.removeEntity(entityId, {
      constraintIds: canRemoveIncrementally ? removedConstraintIds : null,
    });
    if (removed) {
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
    this.emit();
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
    this.emit();
    return changed;
  }

  evaluateParameterExpression(expression) {
    return this.dimensions.evaluateExpression(expression);
  }

  evaluateScalarExpression(expression) {
    return this.dimensions.evaluateScalarExpression(expression);
  }

  evaluateDrawingLengthExpression(expression) {
    return this.dimensions.evaluateLengthExpression(expression);
  }

  clear() {
    this.model.clear();
    this.invalidateConstraintGraph();
    this.releaseDragLocks();
    this.dimensions.clear();
    this.dimensionConstraints.clear();
    this.clearDimensionAnnotations();
    this.drawingUnit = 'in';
    this.dxfExportUnit = 'in';
    this.filletRadius = unitFactors[this.drawingUnit];
    this.documentMetadata = normalizeDocumentMetadata();
    this.documentContext = { fileName: '', filePath: '' };
    this.dimensions.setDefaultLengthUnit(this.drawingUnit);
    this.lastResult = null;
    this.emit();
  }

  loadSketch(snapshot) {
    this.model.clear();
    this.invalidateConstraintGraph();
    this.releaseDragLocks();
    this.dimensions.clear();
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
    this.dimensions.setDefaultLengthUnit(this.drawingUnit);
    this.refreshDocumentVariables();
    (snapshot?.entities || []).forEach((entity) => this.model.addEntity(entity));
    (snapshot?.derivedEntities || []).forEach((entity) => this.model.setDerivedEntity(entity));
    const parameters = snapshot?.parameters || snapshot?.dimensions;
    if (parameters) this.dimensions.restore(parameters);
    (snapshot?.dimensionAnnotations || []).forEach((annotation) => {
      if (annotation.dimensionId) this.setDimensionAnnotation(annotation.dimensionId, normalizeDimensionOrientation(annotation));
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
      const constraint = completeTangentConstraint(this.model, clone(inputConstraint));
      const orientation = constraintOrientation(
        constraint,
        this.dimensionAnnotations.get(constraint.dimensionRef),
        this.model,
      );
      if (orientation) constraint.orientation = orientation;
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

  solve({
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
    const scope = !fullSolve && hasSeeds
      ? graph.scopeForSeeds({
        variableIds: seedVariableIds,
        entityIds: seedEntityIds,
        constraintIds: seedConstraintIds,
        dimensionIds: seedDimensionIds,
      })
      : null;
    const solveOptions = {
      registry: this.registry,
      dimensions: this.dimensions,
      solveMode,
      ...(scope ? { computedDimensionIds: scope.dimensionIds } : {}),
      ...(maxIterations === undefined ? {} : { maxIterations }),
      ...(timeBudgetMs === undefined ? {} : { timeBudgetMs }),
      ...(shouldCancel === undefined ? {} : { shouldCancel }),
      ...(tolerance === undefined ? {} : { tolerance }),
      ...(jacobianMode === undefined ? {} : { jacobianMode }),
      ...(matrixFreeVariableThreshold === undefined ? {} : { matrixFreeVariableThreshold }),
    };
    if (scope) {
      this.lastResult = solveConstraintScope({
        ...solveOptions,
        model: graph.scopedModel(scope),
      });
      this.lastResult.solveScope = {
        mode: 'component',
        componentIds: [...scope.componentIds],
        variableCount: scope.variableIds.size,
        constraintCount: scope.constraintIds.size,
        entityCount: scope.entityIds.size,
      };
    } else if (fullSolve || !hasSeeds) {
      this.lastResult = solveConstraintComponents({
        ...solveOptions,
        model: this.model,
        graph,
      });
      this.lastResult.solveScope = {
        mode: 'components',
        componentCount: this.lastResult.componentStats.componentCount,
        solvedComponentCount: this.lastResult.componentStats.solvedComponentCount,
        constrainedComponentCount: this.lastResult.componentStats.constrainedComponentCount,
        largestVariableCount: this.lastResult.componentStats.largestVariableCount,
        largestConstraintCount: this.lastResult.componentStats.largestConstraintCount,
        variableCount: graph.variableConstraints.size,
        constraintCount: graph.componentForConstraint.size,
        entityCount: this.model.entities.size,
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
    // Refresh displayed measurements after driving constraints have moved
    // their own target geometry.
    this.dimensions.evaluateDirty({
      strict: false,
      refreshComputed: true,
      refreshComputedIds: scope?.dimensionIds || null,
    });
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
      entities.forEach((entity) => this.model.updateEntity(entity));
      fixedValues.forEach((value, id) => { const variable = this.model.variableById(id); if (variable) variable.value = value; });
    } catch (error) {
      restoreEntities(this.model, before);
      this.lastResult = { status: 'invalid', message: error.message, changedEntityIds: [] };
      this.emit();
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
    if (!isSuccessfulSolve(result) && !acceptedPreview) restoreEntities(this.model, before);
    if (interactivePreview && !acceptedPreview) {
      result = {
        ...result,
        changedEntityIds: [],
        restoredInteractivePreview: true,
        message: 'Interactive preview was rejected because the requested drag left the constraint component inconsistent.',
      };
      this.lastResult = result;
    }
    this.emit();
    return {
      result,
      snapshot: this.getGeometrySnapshot(new Set([...seedEntityIds, ...(result.changedEntityIds || [])])),
      snapshotMode: 'delta',
    };
  }

  applyAuthoritativeEntities(entities = [], workerResult = {}) {
    const changedEntityIds = [];
    try {
      entities.forEach((entity) => {
        if (!entity?.id || !this.model.binding(entity.id)) return;
        this.model.updateEntity(entity);
        changedEntityIds.push(entity.id);
      });
    } catch (error) {
      this.lastResult = { status: 'invalid', message: error.message, changedEntityIds: [] };
      this.emit();
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
    this.emit();
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
      this.constraintGraph?.addConstraint(constraint.id);
    });
    if (parameters.length) this.dimensions.restoreEntries(parameters, { emit: false });
    return this.applyAuthoritativeEntities(entities, workerResult);
  }

  rigidPlacementCandidates(constraint) {
    if (!this.rigidFirstConstraintSolve || constraint?.type !== 'Coincident') return [];
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
    const constraint = completeTangentConstraint(this.model, { ...clone(input), id: input.id || createStableId('constraint') });
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
    this.getConstraintGraph().addConstraint(constraint.id);
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
      });
      const stagedConstraints = constraints.map((input) => {
        const constraint = completeTangentConstraint(this.model, { ...clone(input), id: input.id || createStableId('constraint') });
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
        .filter((variableId) => variableId.endsWith(`.${controlledAxis}`))
        .forEach((variableId) => oppositeAxisLocks.add(variableId));
    });
    const draggedAxisLocks = variableIds.filter((variableId) => (
      !controlledAxes.has('x') || !variableId.endsWith('.x')
    ) && (
      !controlledAxes.has('y') || !variableId.endsWith('.y')
    ));
    return [...new Set([...draggedAxisLocks, ...oppositeAxisLocks])];
  }

  variableIdsForEntity(entityId) {
    return this.model.binding(entityId)?.allVariables().map((variable) => variable.id) || [];
  }

  addDimension(entity) {
    const dimension = normalizeDimensionOrientation(clone({ id: entity.id || createStableId('dimension-annotation'), ...entity }));
    const value = dimensionValue(dimension);
    const driving = dimension.dimensionMode === 'driving';
    const unit = dimension.type === 'angle-dimension' ? 'deg' : this.drawingUnit;
    const entry = this.dimensions.addDimension({
      id: dimension.dimensionId || createStableId('dimension'),
      name: dimension.dimensionName,
      expression: this.dimensions.formatValue(value, unit),
      value,
      driving,
      unit,
      annotationId: dimension.id,
    });
    dimension.dimensionId = entry.id;
    dimension.dimensionName = entry.name;
    this.setDimensionAnnotation(entry.id, dimension);
    const fallbackToDriven = (result) => {
      this.dimensions.remove(entry.id, { allowDimension: true });
      const drivenEntity = { ...dimension, dimensionMode: 'driven' };
      const drivenEntry = this.dimensions.addDimension({ id: entry.id, name: entry.name, value, driving: false, unit: entry.unit, annotationId: dimension.id });
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
        featureRefs: [lineToLine.reference, lineToLine.measured],
        dimensionRef: entry.id,
      } : pointToSegment ? {
        type: 'Point Line Distance',
        source: 'dimension',
        subtype: dimension.subtype,
        orientation: dimension.orientation,
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
      };
    }
    if (dimension.type === 'radius-dimension') {
      constraint = {
        type: dimension.subtype === 'diameter' ? 'Diameter' : 'Radius',
        source: 'dimension',
        featureRefs: [{ kind: 'circle', recordId: dimension.anchors?.center?.recordId }],
        dimensionRef: entry.id,
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
      this.dimensions.set({ ...existing, expression: existing.expression });
      result = this.solveDimensionContinuation(existing, expression, targetValue, stepCount, affectedDimensionIds);
    } else {
      result = this.solveDimensionStep({ seedDimensionIds: affectedDimensionIds });
      if (!isSuccessfulSolve(result)) {
        stepCount = dimensionContinuationStepCount(startValue, targetValue, { force: true });
        if (stepCount > 1) {
          this.dimensions.set({ ...existing, expression: existing.expression });
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
      const enabled = Boolean(enabledValue);
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
      this.lastResult = affectedVariableIds.size
        ? this.solve({ seedVariableIds: [...affectedVariableIds] })
        : { status: 'unchanged', message: 'Dimension removed.', changedEntityIds: [], solveScope: { mode: 'none' } };
      this.emit();
    }
    return removed;
  }

  updateDimensionAnnotation(dimensionId, entity) {
    if (!this.dimensionAnnotations.has(dimensionId)) return false;
    this.setDimensionAnnotation(dimensionId, entity);
    return true;
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
      id: `${dimensionId}:radius`,
      type: annotation.subtype === 'diameter' ? 'Diameter' : 'Radius',
      source: 'dimension',
      featureRefs: [{ kind: 'circle', recordId }],
      dimensionRef: dimensionId,
    };
    let result = null;
    try {
      this.registry.validate(this.model, constraint, this.dimensions);
      this.model.addConstraint(constraint);
      this.getConstraintGraph().addConstraint(constraint.id);
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
    let result = this.solve({ ...options, tolerance: options.tolerance ?? 1e-6 });
    if (result?.status === 'max-iterations') {
      result = this.solve({ ...options, tolerance: options.tolerance ?? 1e-6, jacobianMode: 'blocks', maxIterations: 10000 });
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

  refreshDocumentVariables(entities = this.model.snapshot()) {
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
      entities: this.model.snapshot(),
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
      return entry.driving ? valueText : `${prefix}${formatDrivenDimensionValue(entry.value, entry.unit)}`;
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
      return { entry: this.dimensions.get(id), result: { status: 'invalid', message: error.message } };
    }
    const invalidDriving = this.dimensions.list().some((candidate) => candidate.kind === 'dimension' && candidate.driving && candidate.error);
    if (invalidDriving || entry.error) return { entry, result: { status: 'invalid', message: entry.error || 'A driving expression is invalid.' } };
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
