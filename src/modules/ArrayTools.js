import { resolveVectorDrawingPoint } from './DrawingTools.js';
import { IDENTITY_FRAME, stackFrameFor } from './StackCoordinates.js';
import { createUuid, deriveUuidForKey } from './IdentitySystem.js';
import { valueInUnit } from './solver/Units.js';
import { clampPanelPosition, positionHeaderToolMenu } from './CanvasUIControls.js';
import {
  nearestDimensionFeature,
  resolveDimensionFeatureSet,
  transformDimensionFeatureSet,
} from './DimensionSystem.js';
import {
  directClosedRegionNodesForSourceIds,
  splitDerivedPresentationNodes,
} from './CanvasPaintOrder.js';
import { prepareNotchDerivativePresentationClone } from './NotchSystem.js';
import { registerIdentitySchema } from './DrawingIdentitySystem.js';
import { constructionHiddenInValueOnly } from './CanvasPresentation.js';
import { resolveWindowSelectionIds } from './CanvasSelection.js';

registerIdentitySchema('arrayTools', {
  declarations: (value) => (value?.arrays || []).map((object, index) => ({
    object, key: 'id', value: object.id, path: ['extensions', 'arrayTools', 'arrays', String(index), 'id'], kind: 'array-definition',
  })),
  liveReferenceKeys: ['stackId', 'recordId', 'sourceId', 'targetId', 'ownerId', 'arrayId', 'copyId'],
  liveReferenceArrayKeys: ['sourceIds'],
  lineageReferenceKeys: ['sourceDefinitionId', 'sourceStackId'],
  targetKindsByKey: {
    stackId: ['stack'],
    recordId: ['entity'],
    sourceId: ['entity'],
    targetId: ['entity'],
    ownerId: ['entity'],
    arrayId: ['array-definition'],
    copyId: ['linked-copy-definition'],
    sourceIds: ['entity'],
  },
});

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_ARRAY_ITEMS = 500;
const clone = (value) => JSON.parse(JSON.stringify(value));

export const arrayToolTypes = Object.freeze(['Rectangular Array', 'Circular Array']);

export const ARRAY_TOOL_ICONS = Object.freeze({
  Array: `
    <rect x="4" y="5" width="5" height="5"/><rect x="15" y="5" width="5" height="5"/>
    <rect x="4" y="14" width="5" height="5"/><rect x="15" y="14" width="5" height="5"/>
  `,
  'Rectangular Array': `
    <rect x="3.5" y="4" width="5" height="5"/><rect x="9.5" y="4" width="5" height="5"/><rect x="15.5" y="4" width="5" height="5"/>
    <rect x="3.5" y="10" width="5" height="5"/><rect x="9.5" y="10" width="5" height="5"/><rect x="15.5" y="10" width="5" height="5"/>
    <rect x="3.5" y="16" width="5" height="5"/><rect x="9.5" y="16" width="5" height="5"/><rect x="15.5" y="16" width="5" height="5"/>
  `,
  'Circular Array': `
    <circle cx="12" cy="12" r="2"/>
    <rect x="10" y="2.5" width="4" height="4"/><rect x="17.5" y="7.5" width="4" height="4"/>
    <rect x="14.5" y="16.5" width="4" height="4"/><rect x="5.5" y="16.5" width="4" height="4"/>
    <rect x="2.5" y="7.5" width="4" height="4"/>
  `,
});

const arrayTypeKeys = Object.freeze({
  'Rectangular Array': 'rectangular',
  'Circular Array': 'circular',
});

const arrayTypeLabels = Object.freeze({
  rectangular: 'Rectangular Array',
  circular: 'Circular Array',
});

const ARRAY_VISIBLE_GEOMETRY_SELECTORS = [
  '.selectable-entity:not(.hit-target):not(.segment-select-line)',
  '.subtract-result-boundary',
  '.resolved-boundary-visual',
  '.seam-line-path',
];
const ARRAY_VISIBLE_GEOMETRY_SELECTOR = ARRAY_VISIBLE_GEOMETRY_SELECTORS.join(',');
const ARRAY_WINDOW_GEOMETRY_SELECTOR = ARRAY_VISIBLE_GEOMETRY_SELECTORS
  .map((selector) => `.array-item > .array-item-template .array-item-content ${selector}`)
  .join(',');
const ARRAY_STROKE_HIT_ELEMENTS = new Set([
  'circle',
  'ellipse',
  'line',
  'path',
  'polygon',
  'polyline',
  'rect',
]);

export function isArrayCenterPointEntity(entity, arrayId = null) {
  return entity?.type === 'point'
    && entity.composite?.kind === 'array-center'
    && (arrayId === null || entity.composite.arrayId === arrayId);
}

export function createArrayCenterPointEntity(definition, point, id = createUuid()) {
  const center = finitePoint(point, [0, 0]);
  return {
    id,
    type: 'point',
    point: center,
    stackId: definition?.stackId ? String(definition.stackId) : null,
    composite: {
      kind: 'array-center',
      arrayId: String(definition?.id || ''),
    },
  };
}

export function arrayDerivedRecordId(arrayId, placementIndex, sourceId) {
  return deriveUuidForKey('array-placement', arrayId, Number(placementIndex), sourceId);
}

export function arrayDimensionReference(arrayId, placementIndex, sourceId) {
  return {
    recordId: String(sourceId),
    derivedFeature: {
      provider: 'array',
      arrayId: String(arrayId),
      placementIndex: Number(placementIndex),
      sourceId: String(sourceId),
    },
  };
}

export function parseArrayDerivedRecordId(recordId) {
  const match = /^array-derived:([^:]+):(\d+):(.+)$/.exec(String(recordId || ''));
  if (!match) return null;
  try {
    return {
      arrayId: decodeURIComponent(match[1]),
      placementIndex: Number(match[2]),
      sourceId: decodeURIComponent(match[3]),
    };
  } catch {
    return null;
  }
}

export function arrayPlacementTransform(placement, centerPoint = null) {
  if (Number.isFinite(Number(placement?.angle)) && finitePoint(centerPoint, null)) {
    const radians = Number(placement.angle) * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    return ([x, y]) => {
      const dx = x - centerPoint[0];
      const dy = y - centerPoint[1];
      return [
        centerPoint[0] + dx * cosine - dy * sine,
        centerPoint[1] + dx * sine + dy * cosine,
      ];
    };
  }
  const translateX = Number(placement?.translateX) || 0;
  const translateY = Number(placement?.translateY) || 0;
  return ([x, y]) => [x + translateX, y + translateY];
}

export function isArrayOriginPlacement(definition, placement) {
  return definition?.arrayType === 'circular'
    ? Math.abs(Number(placement?.angle) || 0) < 1e-9
    : Math.abs(Number(placement?.translateX) || 0) < 1e-9
      && Math.abs(Number(placement?.translateY) || 0) < 1e-9;
}

export function arrayDerivedOwnerId(arrayId, placementIndex, sourceOwnerId) {
  return deriveUuidForKey('array-subtract-placement', arrayId, Number(placementIndex), sourceOwnerId);
}

function ownerBoundaryPolygon(owner) {
  if (owner?.boundary?.polygon?.length >= 3) return owner.boundary.polygon;
  const entity = owner?.entity;
  if (entity?.boundaryPolygon?.length >= 3) return entity.boundaryPolygon;
  if (entity?.type === 'rect') {
    return [
      [entity.x, entity.y],
      [entity.x + entity.width, entity.y],
      [entity.x + entity.width, entity.y + entity.height],
      [entity.x, entity.y + entity.height],
    ];
  }
  if (entity?.type === 'polygon') return entity.points || [];
  return [];
}

function transformArrayBoundaryFeature(feature, transform, derivedOwnerId, arrayId, arrayPlacementIndex) {
  const transformed = {
    ...clone(feature),
    recordId: derivedOwnerId,
    targetId: derivedOwnerId,
    sourceId: derivedOwnerId,
    arrayId,
    arrayPlacementIndex,
    arraySourceId: feature.sourceId,
    arraySourceStableKey: feature.stableKey,
    stableKey: `${derivedOwnerId}:${feature.kind}:${Number(feature.sourceFeatureIndex ?? feature.index) || 0}`,
  };
  ['start', 'end', 'arcPoint', 'center', 'rawStart', 'rawEnd'].forEach((key) => {
    if (finitePoint(feature[key], null)) transformed[key] = transform(feature[key]);
  });
  if (Array.isArray(feature.points)) transformed.points = feature.points.map(transform);
  return transformed;
}

function transformArraySubtractEntity(owner, definition, placement, transform, derivedOwnerId) {
  const entity = owner.entity;
  const common = {
    ...clone(entity),
    id: derivedOwnerId,
    construction: false,
    subtract: entity.subtract === true,
    subtractExpression: entity.subtractExpression ?? (entity.subtract ? 'TRUE' : 'FALSE'),
    subtractFrom: Array.isArray(entity.subtractFrom) ? [...entity.subtractFrom] : [],
    arrayId: definition.id,
    arrayPlacementIndex: placement.index,
    arraySourceOwnerId: owner.id,
  };
  if (entity.type === 'circle' && finitePoint(entity.center, null)) {
    return { ...common, center: transform(entity.center), radius: Math.abs(Number(entity.radius)) };
  }
  if (entity.type === 'rect' && definition.arrayType === 'rectangular') {
    const origin = transform([entity.x, entity.y]);
    return { ...common, x: origin[0], y: origin[1], width: entity.width, height: entity.height };
  }
  const polygon = ownerBoundaryPolygon(owner).filter((point) => finitePoint(point, null)).map(transform);
  return {
    ...common,
    type: 'polygon',
    points: polygon,
    boundaryPolygon: polygon,
    rawBoundaryPolygon: polygon,
  };
}

/**
 * Materializes non-origin array placements as transient Subtract owners.
 * The returned owners never become editable canvas records; their stable IDs
 * only identify the generated cutter boundaries across refreshes.
 */
export function materializeArraySubtractOwners(definition, evaluated, baseOwners = [], { centerPoint = null } = {}) {
  if (!evaluated?.valid) return [];
  const normalized = normalizeArrayDefinition(definition);
  const selected = new Set(normalized.sourceIds);
  const sourceOwners = baseOwners.filter((owner) => (
    (owner?.entity?.subtract === true || owner?.entity?.subtractFrom?.length > 0)
    && owner.recordIds?.length
    && owner.recordIds.every((recordId) => selected.has(recordId))
  ));
  return (evaluated.placements || []).flatMap((rawPlacement, placementIndex) => {
    if (isArrayOriginPlacement(normalized, rawPlacement)) return [];
    const placement = { ...rawPlacement, index: placementIndex };
    const transform = arrayPlacementTransform(placement, centerPoint);
    return sourceOwners.map((owner) => {
      const id = arrayDerivedOwnerId(normalized.id, placementIndex, owner.id);
      const entity = transformArraySubtractEntity(owner, normalized, placement, transform, id);
      const sourceFeatures = owner.boundary?.features || [];
      const supportsAnalyticBoundary = sourceFeatures.length > 0
        && sourceFeatures.every((feature) => ['segment', 'arc'].includes(feature.kind));
      const recordIds = owner.recordIds.map((recordId) => (
        arrayDerivedRecordId(normalized.id, placementIndex, recordId)
      ));
      return {
        id,
        entity,
        recordIds,
        sourceRecordIds: [...owner.recordIds],
        sourceOwnerId: owner.id,
        arrayId: normalized.id,
        placementIndex,
        kind: 'array-derived',
        ...(supportsAnalyticBoundary ? {
          boundary: {
            features: sourceFeatures.map((feature) => transformArrayBoundaryFeature(
              feature,
              transform,
              id,
              normalized.id,
              placementIndex,
            )),
            polygon: owner.boundary.polygon.map(transform),
          },
        } : {}),
      };
    }).filter((owner) => (
      owner.entity.type === 'circle'
      || owner.entity.type === 'rect'
      || owner.entity.points?.length >= 3
    ));
  });
}

function finitePoint(value, fallback = null) {
  if (!Array.isArray(value) || value.length < 2) return fallback;
  const point = [Number(value[0]), Number(value[1])];
  return point.every(Number.isFinite) ? point : fallback;
}

function uniqueIds(values = []) {
  return [...new Set(values.map((value) => String(value || '')).filter(Boolean))];
}

export function arraySourceReferenceKey(reference = {}) {
  if (reference.kind === 'array-placement') {
    return `array-placement:${String(reference.arrayId || '')}:${Number(reference.placementIndex)}`;
  }
  if (reference.kind === 'linked-copy') return `linked-copy:${String(reference.copyId || '')}`;
  if (reference.kind === 'swell-piece') {
    return `swell-piece:${String(reference.ownerId || '')}:${Number(reference.pieceIndex)}`;
  }
  if (reference.kind === 'seam-line') {
    const features = Array.isArray(reference.sourceFeatures) ? reference.sourceFeatures : [];
    return `seam-line:${features.map((feature) => [
      String(feature.sourceId || feature.recordId || ''),
      Number(feature.sourceFeatureIndex ?? feature.index ?? 0) || 0,
      String(feature.boundaryRole || 'outer'),
      String(feature.kind || 'segment'),
      Number.isFinite(Number(feature.sourceParameter)) ? Number(feature.sourceParameter) : '',
    ].join('|')).sort().join('::')}`;
  }
  return '';
}

export function normalizeArraySourceReferences(values = []) {
  const references = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    let reference = null;
    if (value?.kind === 'array-placement' && value.arrayId && Number.isInteger(Number(value.placementIndex))) {
      reference = { kind: 'array-placement', arrayId: String(value.arrayId), placementIndex: Number(value.placementIndex) };
    }
    if (value?.kind === 'linked-copy' && value.copyId) {
      reference = { kind: 'linked-copy', copyId: String(value.copyId) };
    }
    if (value?.kind === 'swell-piece' && value.ownerId && Number.isInteger(Number(value.pieceIndex))) {
      reference = { kind: 'swell-piece', ownerId: String(value.ownerId), pieceIndex: Number(value.pieceIndex) };
    }
    if (value?.kind === 'seam-line' && Array.isArray(value.sourceFeatures) && value.sourceFeatures.length) {
      const sourceFeatures = value.sourceFeatures.map((feature) => ({
        sourceId: String(feature?.sourceId || feature?.recordId || ''),
        sourceFeatureIndex: Number(feature?.sourceFeatureIndex ?? feature?.index ?? 0) || 0,
        boundaryRole: String(feature?.boundaryRole || 'outer'),
        kind: String(feature?.kind || 'segment'),
        ...(Number.isFinite(Number(feature?.sourceParameter))
          ? { sourceParameter: Number(feature.sourceParameter) }
          : {}),
      })).filter(({ sourceId }) => sourceId);
      if (sourceFeatures.length) reference = { kind: 'seam-line', sourceFeatures };
    }
    const key = reference && arraySourceReferenceKey(reference);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    references.push(reference);
  }
  return references;
}

export function orderArrayDefinitionsByDependencies(definitions = []) {
  const byId = new Map(definitions.map((definition) => [String(definition.id), definition]));
  const ordered = [];
  const cyclicIds = new Set();
  const state = new Map();
  const visit = (definition, lineage = []) => {
    const id = String(definition.id);
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      const start = lineage.indexOf(id);
      (start >= 0 ? lineage.slice(start) : [id]).forEach((value) => cyclicIds.add(value));
      cyclicIds.add(id);
      return;
    }
    state.set(id, 'visiting');
    normalizeArraySourceReferences(definition.sourceRefs).forEach((reference) => {
      if (reference.kind === 'array-placement' && byId.has(reference.arrayId)) {
        visit(byId.get(reference.arrayId), [...lineage, id]);
      }
    });
    state.set(id, 'done');
    ordered.push(definition);
  };
  definitions.forEach((definition) => visit(definition));
  return { ordered, cyclicIds };
}

function arrayType(value) {
  return arrayTypeLabels[value] ? value : arrayTypeKeys[value] || 'rectangular';
}

export function normalizeArrayDefinition(input = {}) {
  const id = String(input.id || createUuid());
  const stackId = input.stackId ? String(input.stackId) : null;
  const type = arrayType(input.arrayType || input.type);
  const centerPoint = finitePoint(input.centerPoint, null);
  const centerRef = input.centerRef?.recordId && Number.isInteger(Number(input.centerRef.index))
    ? {
      kind: 'point',
      recordId: String(input.centerRef.recordId),
      index: Number(input.centerRef.index),
    }
    : null;
  return {
    id,
    sourceDefinitionId: String(input.sourceDefinitionId || id),
    sourceStackId: input.sourceStackId || stackId ? String(input.sourceStackId || stackId) : null,
    stackId,
    arrayType: type,
    sourceIds: uniqueIds(input.sourceIds),
    sourceRefs: normalizeArraySourceReferences(input.sourceRefs),
    rowCountExpression: String(input.rowCountExpression ?? '2'),
    columnCountExpression: String(input.columnCountExpression ?? '2'),
    rowSpacingExpression: String(input.rowSpacingExpression ?? '100'),
    columnSpacingExpression: String(input.columnSpacingExpression ?? '100'),
    rowCentroidSpacing: input.rowCentroidSpacing === true,
    columnCentroidSpacing: input.columnCentroidSpacing === true,
    rowDirection: ['up', 'center', 'down'].includes(input.rowDirection) ? input.rowDirection : 'down',
    columnDirection: ['left', 'center', 'right'].includes(input.columnDirection) ? input.columnDirection : 'right',
    countExpression: String(input.countExpression ?? '6'),
    fullCircle: input.fullCircle !== false,
    stopAngleExpression: String(input.stopAngleExpression ?? '180'),
    centerPoint,
    centerRef,
    parentVisibleExpression: input.parentVisibleExpression == null
      ? null
      : String(input.parentVisibleExpression),
    parentVisibleManuallyEnabled: input.parentVisibleManuallyEnabled == null
      ? null
      : input.parentVisibleManuallyEnabled !== false,
  };
}

export function arraySelectionPropertyPatch(
  definition,
  visibilityProperties = {},
) {
  if (!definition?.id) return null;
  const visible = definition.parentVisibleManuallyEnabled == null
    ? visibilityProperties.visible ?? null
    : definition.parentVisibleManuallyEnabled;
  const visibleExpression = definition.parentVisibleExpression == null
    ? visibilityProperties.visibleExpression ?? null
    : definition.parentVisibleExpression;
  return {
    selectionCount: 1,
    recordIds: [],
    ids: [definition.id],
    arrayCount: 1,
    canEditVisible: visibilityProperties.canEditVisible === true,
    visible,
    mixedVisible: visibilityProperties.mixedVisible === true,
    visibleExpression,
    errors: {
      visible: visibilityProperties.errors?.visible || null,
    },
  };
}

export function migrateArrayDefinition(input = {}, version = 3) {
  const migrated = { ...input };
  const sourceVersion = Number.isFinite(Number(version)) ? Number(version) : 1;
  if (arrayType(migrated.arrayType || migrated.type) === 'circular' && sourceVersion < 3 && migrated.fullCircle === false) {
    const start = String(migrated.startAngleExpression ?? '0').trim() || '0';
    const stop = String(migrated.stopAngleExpression ?? '180').trim() || '180';
    migrated.stopAngleExpression = /^[-+]?0(?:\.0+)?$/.test(start)
      ? stop
      : `(${stop}) - (${start})`;
  }
  delete migrated.radiusExpression;
  delete migrated.spacingFromCenterExpression;
  delete migrated.startAngleExpression;
  return normalizeArrayDefinition(migrated);
}

function evaluateValue(expression, evaluate, label, errors, { integer = false, minimum = null } = {}) {
  let value;
  try {
    value = Number(evaluate(String(expression ?? '').trim()));
  } catch (error) {
    errors[label] = error.message || `${label} is invalid.`;
    return null;
  }
  if (!Number.isFinite(value)) {
    errors[label] = `${label} must resolve to a finite number.`;
    return null;
  }
  if (integer && Math.abs(value - Math.round(value)) > 1e-6) {
    errors[label] = `${label} must resolve to a whole number.`;
    return null;
  }
  if (minimum !== null && value < minimum) {
    errors[label] = `${label} must be at least ${minimum}.`;
    return null;
  }
  return integer ? Math.round(value) : value;
}

export function evaluateArrayCountExpression(expression, { evaluateLength, drawingUnit }) {
  return valueInUnit(evaluateLength(expression), drawingUnit);
}

function directionalOffsets(count, spacing, direction, negativeDirection, positiveDirection) {
  if (count <= 0) return [];
  if (direction === 'center') {
    const offsets = [0];
    for (let distance = 1; offsets.length < count; distance += 1) {
      offsets.push(-distance * spacing);
      if (offsets.length < count) offsets.push(distance * spacing);
    }
    return offsets;
  }
  const sign = direction === negativeDirection ? -1 : direction === positiveDirection ? 1 : 1;
  return Array.from({ length: count }, (_, index) => {
    const value = index * spacing * sign;
    return Object.is(value, -0) ? 0 : value;
  });
}

export function rectangularArrayOffsets({
  rowCount,
  columnCount,
  rowSpacing,
  columnSpacing,
  objectWidth = 0,
  objectHeight = 0,
  rowCentroidSpacing = false,
  columnCentroidSpacing = false,
  rowDirection = 'right',
  columnDirection = 'down',
}) {
  const columnPitch = columnCentroidSpacing ? columnSpacing : Math.max(0, objectWidth) + columnSpacing;
  const rowPitch = rowCentroidSpacing ? rowSpacing : Math.max(0, objectHeight) + rowSpacing;
  const xOffsets = directionalOffsets(columnCount, columnPitch, columnDirection, 'left', 'right');
  const yOffsets = directionalOffsets(rowCount, rowPitch, rowDirection, 'up', 'down');
  return yOffsets.flatMap((translateY) => xOffsets.map((translateX) => ({ translateX, translateY })));
}

export function circularArrayAngles({ count, fullCircle = true, stopAngle = 360 }) {
  if (count <= 0) return [];
  if (fullCircle) return Array.from({ length: count }, (_, index) => index * 360 / count);
  if (count === 1) return [0];
  return Array.from({ length: count }, (_, index) => {
    const angle = stopAngle * index / (count - 1);
    return Object.is(angle, -0) ? 0 : angle;
  });
}

export function arrayPlacementCount(evaluated) {
  if (!evaluated?.valid) return null;
  if (evaluated.definition?.arrayType === 'rectangular') {
    return Number(evaluated.values?.rowCount) * Number(evaluated.values?.columnCount);
  }
  return Number(evaluated.values?.count);
}

export function arrayParentVisibilityExpression(definition, parentExpression = 'TRUE') {
  const normalized = normalizeArrayDefinition(definition);
  const requestedBase = String(parentExpression ?? '').trim();
  const base = requestedBase || 'FALSE';
  const gate = normalized.arrayType === 'rectangular'
    ? `((${normalized.rowCountExpression}) > 0 && (${normalized.columnCountExpression}) > 0)`
    : `((${normalized.countExpression}) > 0)`;
  return base.toUpperCase() === 'TRUE' ? gate : `((${base}) && ${gate})`;
}

export function arrayPaintAnchorRecordId(definition, paintOrder = []) {
  const sources = new Set(uniqueIds(definition?.sourceIds));
  return [...paintOrder].reverse().find((recordId) => sources.has(recordId)) || null;
}

export function boundsCentroid(bounds) {
  const x = Number(bounds?.x);
  const y = Number(bounds?.y);
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return [x + width / 2, y + height / 2];
}

export function evaluateArrayDefinition(input, {
  evaluateNumeric = Number,
  evaluateLength = evaluateNumeric,
  sourceBounds = null,
  centerPoint = null,
  coordinateFrame = IDENTITY_FRAME,
} = {}) {
  const definition = normalizeArrayDefinition(input);
  const errors = {};
  const sourceCount = definition.sourceIds.length + definition.sourceRefs.length;
  if (!sourceCount) errors.sources = 'Select at least one drawing object.';
  if (definition.arrayType === 'rectangular') {
    const rowCount = evaluateValue(definition.rowCountExpression, evaluateNumeric, 'rowCount', errors, { integer: true, minimum: 0 });
    const columnCount = evaluateValue(definition.columnCountExpression, evaluateNumeric, 'columnCount', errors, { integer: true, minimum: 0 });
    const rowSpacing = evaluateValue(definition.rowSpacingExpression, evaluateLength, 'rowSpacing', errors, { minimum: 0 });
    const columnSpacing = evaluateValue(definition.columnSpacingExpression, evaluateLength, 'columnSpacing', errors, { minimum: 0 });
    const itemCount = rowCount && columnCount ? rowCount * columnCount : 0;
    if (itemCount > MAX_ARRAY_ITEMS) errors.itemCount = `An array may contain at most ${MAX_ARRAY_ITEMS} items.`;
    return {
      definition,
      valid: Object.keys(errors).length === 0,
      errors,
      values: { rowCount, columnCount, rowSpacing, columnSpacing },
      placements: Object.keys(errors).length === 0
        ? rectangularArrayOffsets({
          rowCount,
          columnCount,
          rowSpacing,
          columnSpacing,
          objectWidth: Number(sourceBounds?.width) || 0,
          objectHeight: Number(sourceBounds?.height) || 0,
          rowCentroidSpacing: definition.rowCentroidSpacing,
          columnCentroidSpacing: definition.columnCentroidSpacing,
          rowDirection: definition.rowDirection,
          columnDirection: definition.columnDirection,
        }).map((placement) => ({
          ...placement,
          translateX: placement.translateX * Math.cos(coordinateFrame.rotation) - placement.translateY * Math.sin(coordinateFrame.rotation),
          translateY: placement.translateX * Math.sin(coordinateFrame.rotation) + placement.translateY * Math.cos(coordinateFrame.rotation),
        }))
        : [],
    };
  }

  const count = evaluateValue(definition.countExpression, evaluateNumeric, 'count', errors, { integer: true, minimum: 0 });
  const stopAngle = definition.fullCircle
    ? 360
    : evaluateValue(definition.stopAngleExpression, evaluateNumeric, 'stopAngle', errors);
  const resolvedCenter = finitePoint(centerPoint, finitePoint(definition.centerPoint, null));
  const sourceCentroid = boundsCentroid(sourceBounds);
  const radius = resolvedCenter && sourceCentroid
    ? Math.hypot(sourceCentroid[0] - resolvedCenter[0], sourceCentroid[1] - resolvedCenter[1])
    : null;
  if (count !== 0 && !resolvedCenter) errors.center = 'Select the circular array center point.';
  if (count !== 0 && !sourceCentroid && sourceCount) errors.sources = 'The selected drawing objects are unavailable.';
  if (count !== 0 && radius !== null && radius <= 1e-9) errors.center = 'The center point must differ from the selected objects\' centroid.';
  if (count !== 0 && !definition.fullCircle && stopAngle !== null && Math.abs(stopAngle) <= 1e-9) {
    errors.stopAngle = 'Stop Angle must be positive or negative, not zero.';
  }
  if (count > MAX_ARRAY_ITEMS) errors.itemCount = `An array may contain at most ${MAX_ARRAY_ITEMS} items.`;
  return {
    definition,
    valid: Object.keys(errors).length === 0,
    errors,
    values: { count, radius, stopAngle, sourceCentroid, centerPoint: resolvedCenter },
    placements: Object.keys(errors).length === 0
      ? circularArrayAngles({ count, fullCircle: definition.fullCircle, stopAngle })
        .map((angle) => ({ angle }))
      : [],
  };
}

function createSvg(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value));
  return node;
}

function isArrayableEntity(entity) {
  if (!entity?.id || String(entity.type || '').includes('dimension')) return false;
  if (isArrayCenterPointEntity(entity)) return false;
  if (entity.composite?.kind === 'symmetric-centerline') return false;
  return true;
}

export function arraySourceIdsFromSelection(recordIds = [], entities = new Map()) {
  return uniqueIds(recordIds).filter((id) => isArrayableEntity(entities.get(id)));
}

export function arrayIdsFromWindow(groups = [], matchesNode = () => false, bottomUp = false) {
  return uniqueIds([...groups].filter((group) => {
    const targets = [...(group?.querySelectorAll?.(ARRAY_WINDOW_GEOMETRY_SELECTOR) || [])];
    if (!targets.length) return false;
    return bottomUp
      ? targets.some((target) => matchesNode(target))
      : targets.every((target) => matchesNode(target));
  }).map((group) => group?.dataset?.arrayId));
}

export function arraySourceReferencesFromWindow(
  candidates = [],
  referenceFromTarget = () => null,
  matchesNode = () => false,
  bottomUp = false,
) {
  return normalizeArraySourceReferences([...candidates].flatMap((candidate) => {
    const targets = [
      ...(candidate?.matches?.(ARRAY_VISIBLE_GEOMETRY_SELECTOR) ? [candidate] : []),
      ...(candidate?.querySelectorAll?.(ARRAY_VISIBLE_GEOMETRY_SELECTOR) || []),
    ];
    const matches = targets.length
      ? (bottomUp
        ? targets.some((target) => matchesNode(target))
        : targets.every((target) => matchesNode(target)))
      : matchesNode(candidate);
    return matches ? [referenceFromTarget(candidate)] : [];
  }));
}

export function arrayDerivativeSourceVisible(node) {
  if (!node) return false;
  const owner = node.closest?.(
    '.array-group, .linked-copy-group, .swell-derived-group, .canvas-record',
  ) || node;
  return !owner.classList.contains('object-visibility-hidden')
    && !owner.classList.contains('stack-hidden');
}

function sanitizeClone(node) {
  prepareNotchDerivativePresentationClone(node);
  [
    'id',
    'data-record-id',
    'data-array-id',
    'data-array-placement-index',
    'data-linked-copy-id',
    'data-swell-owner-id',
    'data-swell-piece-id',
    'data-swell-piece-index',
    'data-swell-segment-index',
  ].forEach((attribute) => node.removeAttribute(attribute));
  node.removeAttribute('aria-label');
  node.removeAttribute('role');
  node.classList.remove(
    'canvas-record',
    'selected',
    'hovered',
    'smart-selected',
    'overlap-cycle-selected',
    'array-source-selected',
    'stack-hidden',
    'stack-inactive',
  );
  node.classList.add('array-item-content');
  node.style.removeProperty('display');
  node.style.removeProperty('visibility');
  node.style.pointerEvents = 'none';
  node.querySelectorAll('*').forEach((child) => {
    child.removeAttribute('id');
    child.removeAttribute('data-record-id');
    child.removeAttribute('data-array-id');
    child.removeAttribute('data-array-placement-index');
    child.removeAttribute('data-linked-copy-id');
    child.removeAttribute('data-swell-owner-id');
    child.removeAttribute('data-swell-piece-id');
    child.removeAttribute('data-swell-piece-index');
    child.removeAttribute('data-swell-segment-index');
    child.removeAttribute('aria-label');
    child.removeAttribute('role');
    child.removeAttribute('contenteditable');
    child.classList.remove('selected', 'hovered', 'smart-selected', 'overlap-cycle-selected', 'array-source-selected', 'stack-hidden', 'stack-inactive');
    child.style.pointerEvents = 'none';
    if ('tabIndex' in child) child.tabIndex = -1;
  });
  node.querySelectorAll([
    '.handle-group',
    '.segment-selection-layer',
    '.hit-target',
    '.image-context-toolbar',
    '.text-selection-frame',
    '.text-resize-handle',
    '.text-rotation-handle',
    '.text-rotation-stem',
    '.notch-hit',
    '.array-item-hit-definitions',
    '.array-item-hit-layer',
    '.array-item-hit-template',
    '.array-item-geometry-hit',
    '.array-item-area-hit',
    '.array-item-bounds-hit',
    '.linked-copy-hit',
    '.swell-derived-hit',
    '.seam-line-hit',
  ].join(',')).forEach((child) => child.remove());
  return node;
}

export function arrayDependentVisualIds(entityMap, sourceIds) {
  const selected = new Set(sourceIds);
  return [...entityMap.values()].filter((entity) => {
    if (selected.has(entity.id)) return false;
    if (entity.type === 'notch') return selected.has(entity.host?.recordId);
    if (entity.composite?.kind !== 'finish-size-offset') return false;
    const owners = [...new Set((entity.composite.sourceFeatures || []).map(({ recordId }) => recordId).filter(Boolean))];
    return owners.length > 0 && owners.every((id) => selected.has(id));
  }).map(({ id }) => id);
}

function firstError(errors = {}) {
  return Object.values(errors).find(Boolean) || '';
}

export function createArrayTools({ toolbar, canvas, derivativeSourceProviders = [] }) {
  const button = toolbar?.querySelector('[data-array-toggle]');
  const menu = toolbar?.querySelector('[data-array-menu]');
  const tool = toolbar?.classList?.contains('menu-tool') ? toolbar : button?.closest('.menu-tool');
  const canvasElement = canvas.getCanvasElement();
  const svg = canvasElement.querySelector('.drawing-plane');
  const objectLayer = canvas.getObjectLayer?.() || svg?.querySelector('g > g:nth-child(2)');
  const popup = document.createElement('section');
  const arrays = [];
  let mode = 'idle';
  let activeType = null;
  let pendingSourceIds = new Set();
  let pendingSourceRefs = new Map();
  let selectedArrayId = null;
  const windowSelectedArrayIds = new Set();
  let editingDraft = null;
  let editingSourceBounds = null;
  let editingIsNew = false;
  let editingHistoryCheckpointed = false;
  let closeTimer = null;
  let renderFrame = null;
  let hitTemplateSerial = 0;
  let suppressNextOutsideClick = false;
  let preserveArraySelectionDuringCanvasClear = false;
  let popupPosition = null;
  let popupDrag = null;

  if (!objectLayer) return { activate: () => false, deactivate: () => false, render: () => {} };
  if (menu && menu.parentElement !== document.body) document.body.appendChild(menu);

  popup.className = 'floating-panel array-settings-popup';
  popup.hidden = true;
  popup.setAttribute('data-canvas-ui', 'true');
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Array settings');
  popup.innerHTML = `
    <header class="array-settings-header">
      <h2 data-array-title>Array</h2>
      <button type="button" class="panel-close-button array-settings-close" data-array-close aria-label="Close array settings" title="Close">&times;</button>
    </header>
    <form class="array-settings-form" novalidate>
      <div class="array-object-selection-controls">
        <button type="button" data-array-select-objects>Select Objects</button>
        <output data-array-source-count>0 objects selected</output>
      </div>
      <div class="array-rectangular-fields" data-array-rectangular>
        <label><span>Row Count</span><input class="array-expression-input" name="rowCountExpression" data-expression-source="arrayParameterNames" autocomplete="off" spellcheck="false" /></label>
        <label><span>Row Spacing</span><input class="array-expression-input" name="rowSpacingExpression" data-expression-source="arrayParameterNames" autocomplete="off" spellcheck="false" /></label>
        <label class="array-checkbox-field" title="Use Row Spacing as the centroid-to-centroid distance"><span>Row Centroid Spacing</span><input type="checkbox" name="rowCentroidSpacing" aria-label="Use centroid-to-centroid row spacing" /></label>
        <label><span>Row Direction</span><select name="rowDirection"><option value="up">Up</option><option value="center">Center</option><option value="down">Down</option></select></label>
        <label><span>Column Count</span><input class="array-expression-input" name="columnCountExpression" data-expression-source="arrayParameterNames" autocomplete="off" spellcheck="false" /></label>
        <label><span>Column Spacing</span><input class="array-expression-input" name="columnSpacingExpression" data-expression-source="arrayParameterNames" autocomplete="off" spellcheck="false" /></label>
        <label class="array-checkbox-field" title="Use Column Spacing as the centroid-to-centroid distance"><span>Column Centroid Spacing</span><input type="checkbox" name="columnCentroidSpacing" aria-label="Use centroid-to-centroid column spacing" /></label>
        <label><span>Column Direction</span><select name="columnDirection"><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
      </div>
      <div class="array-circular-fields" data-array-circular hidden>
        <div class="array-center-controls">
          <button type="button" class="array-center-button" data-array-center>Select Center Point</button>
          <output class="array-center-value" data-array-center-value>No center selected</output>
        </div>
        <label><span>Object Count</span><input class="array-expression-input" name="countExpression" data-expression-source="arrayParameterNames" autocomplete="off" spellcheck="false" /></label>
        <label class="array-checkbox-field"><span>Full 360 Circle</span><input type="checkbox" name="fullCircle" /></label>
        <div class="array-angle-fields" data-array-angles>
          <label><span>Stop Angle</span><input class="array-expression-input" name="stopAngleExpression" data-expression-source="arrayParameterNames" autocomplete="off" spellcheck="false" /></label>
        </div>
      </div>
      <datalist id="arrayParameterNames"></datalist>
      <p class="array-settings-error" data-array-error role="alert" aria-live="polite"></p>
    </form>
  `;
  document.body.appendChild(popup);

  const form = popup.querySelector('form');
  const title = popup.querySelector('[data-array-title]');
  const selectObjectsButton = popup.querySelector('[data-array-select-objects]');
  const sourceCount = popup.querySelector('[data-array-source-count]');
  const rectangularFields = popup.querySelector('[data-array-rectangular]');
  const circularFields = popup.querySelector('[data-array-circular]');
  const angleFields = popup.querySelector('[data-array-angles]');
  const centerValue = popup.querySelector('[data-array-center-value]');
  const errorText = popup.querySelector('[data-array-error]');
  const parameterNames = popup.querySelector('#arrayParameterNames');

  function definitionsById() {
    return new Map(arrays.map((definition) => [definition.id, definition]));
  }

  function entityMap() {
    const drawing = canvas.getProcessingDrawingData?.() || canvas.getDrawingData();
    return new Map((drawing.entities || []).map((entity) => [entity.id, entity]));
  }

  const definitionProcessingEnabled = (definition) => (
    canvas.isStackEnabled?.(definition?.stackId) !== false
  );

  function evaluateDefinition(definition, bounds) {
    const coordinateFrame = stackFrameFor(canvas.getStackState?.(), definition.stackId);
    const localBounds = definition.arrayType === 'rectangular' && coordinateFrame.rotation;
    const resolvedBounds = localBounds ? sourceBounds(definition.sourceIds, coordinateFrame, definition.sourceRefs)
      : bounds === undefined ? sourceBounds(definition.sourceIds, null, definition.sourceRefs) : bounds;
    return evaluateArrayDefinition(definition, {
      evaluateNumeric: (expression) => evaluateArrayCountExpression(expression, {
        evaluateLength: (value) => canvas.evaluateLengthExpression(value, definition),
        drawingUnit: canvas.getDrawingUnit?.(),
      }),
      evaluateLength: (expression) => canvas.evaluateLengthExpression(expression, definition),
      sourceBounds: resolvedBounds,
      centerPoint: definition.arrayType === 'circular' ? resolveCenter(definition) : null,
      coordinateFrame,
    });
  }

  function sameSourceIds(first = [], second = []) {
    const left = uniqueIds(first);
    const right = uniqueIds(second);
    return left.length === right.length && left.every((id) => right.includes(id));
  }

  function captureParentVisibility(definition) {
    if (
      definition.parentVisibleExpression !== null
      && definition.parentVisibleManuallyEnabled !== null
    ) {
      return {
        expression: definition.parentVisibleExpression,
        manuallyEnabled: definition.parentVisibleManuallyEnabled,
      };
    }
    const properties = canvas.getVisibilityProperties?.(definition.sourceIds);
    definition.parentVisibleExpression = properties?.visibleExpression
      ?? '';
    definition.parentVisibleManuallyEnabled = properties?.visible !== false;
    return {
      expression: definition.parentVisibleExpression,
      manuallyEnabled: definition.parentVisibleManuallyEnabled,
    };
  }

  function sameSourceSelection(first, second) {
    if (!sameSourceIds(first?.sourceIds, second?.sourceIds)) return false;
    const left = normalizeArraySourceReferences(first?.sourceRefs).map(arraySourceReferenceKey);
    const right = normalizeArraySourceReferences(second?.sourceRefs).map(arraySourceReferenceKey);
    return left.length === right.length && left.every((key) => right.includes(key));
  }

  function applyArrayParentVisibility(definition, { restore = false } = {}) {
    if (!definition?.sourceIds?.length) return false;
    const properties = canvas.getVisibilityProperties?.(definition.sourceIds);
    if (properties?.canEditVisible !== true) return false;
    const parent = captureParentVisibility(definition);
    const visibleManuallyEnabled = restore ? parent.manuallyEnabled : false;
    const visibleExpression = restore
      ? parent.expression
      : arrayParentVisibilityExpression(
        definition,
        parent.manuallyEnabled ? 'TRUE' : parent.expression,
      );
    if (
      properties.visible === visibleManuallyEnabled
      && properties.visibleExpression === visibleExpression
    ) return true;
    return canvas.setRecordVisibility?.(
      definition.sourceIds,
      { visible: visibleManuallyEnabled, visibleExpression },
      { history: false, notify: false },
    )?.success === true;
  }

  function resolveCenter(definition) {
    const ref = definition.centerRef;
    if (ref) {
      const feature = canvas.getPointFeature?.(ref.recordId, ref.index, { rendered: true });
      if (feature?.point) return [...feature.point];
    }
    return finitePoint(definition.centerPoint, null);
  }

  function ownedCenterEntity(definition) {
    return [...entityMap().values()].find((entity) => isArrayCenterPointEntity(entity, definition.id)) || null;
  }

  function reconcileCenterControl(definition) {
    if (definition?.arrayType !== 'circular') return definition;
    const owned = ownedCenterEntity(definition);
    const referenced = definition.centerRef
      ? canvas.getPointFeature?.(definition.centerRef.recordId, definition.centerRef.index, { rendered: true })
      : null;
    const referencedEntity = definition.centerRef
      ? entityMap().get(definition.centerRef.recordId)
      : null;
    const usesExternalPoint = Boolean(referenced?.point && !isArrayCenterPointEntity(referencedEntity, definition.id));
    if (usesExternalPoint) {
      definition.centerPoint = [...referenced.point];
      if (owned) canvas.deleteRecords?.([owned.id], { checkpoint: false, notify: false });
      return definition;
    }
    const center = referenced?.point || finitePoint(definition.centerPoint, null);
    if (!center) return definition;
    const entity = createArrayCenterPointEntity(
      definition,
      center,
      owned?.id || createUuid(),
    );
    const saved = canvas.upsertAuxiliaryGeometry?.(entity) || entity;
    definition.centerPoint = [...center];
    definition.centerRef = { kind: 'point', recordId: saved.id, index: 0 };
    return definition;
  }

  const subtractOperandProvider = {
    owners(baseOwners = []) {
      return arrays.filter(definitionProcessingEnabled).flatMap((definition) => {
        const bounds = sourceBounds(definition.sourceIds, null, definition.sourceRefs);
        const evaluated = evaluateDefinition(definition, bounds);
        if (!evaluated.valid) return [];
        return materializeArraySubtractOwners(definition, evaluated, baseOwners, {
          centerPoint: definition.arrayType === 'circular' ? resolveCenter(definition) : null,
        });
      });
    },
  };

  function selectedDefinitionValue() {
    if (editingDraft?.id === selectedArrayId) return editingDraft;
    const selectionId = selectedArrayId
      || (windowSelectedArrayIds.size === 1 ? [...windowSelectedArrayIds][0] : null);
    return arrays.find(({ id }) => id === selectionId) || null;
  }

  const selectionPropertyProvider = {
    selectionProperties() {
      const definition = selectedDefinitionValue();
      if (!definition) return null;
      const visibilityProperties = canvas.getVisibilityProperties?.(definition.sourceIds) || {
        canEditVisible: false,
        visible: null,
        mixedVisible: false,
        visibleExpression: null,
        errors: { visible: null },
      };
      return arraySelectionPropertyPatch(definition, visibilityProperties);
    },
    setSelectedVisibility(patch = {}) {
      const definition = selectedDefinitionValue();
      if (!definition) return { success: false, error: 'No array selected.' };
      captureParentVisibility(definition);
      if (patch.visibleExpression !== undefined) {
        definition.parentVisibleExpression = String(patch.visibleExpression ?? '').trim();
      }
      if (typeof patch.visible === 'boolean') {
        definition.parentVisibleManuallyEnabled = patch.visible;
      }
      const result = applyArrayParentVisibility(definition)
        ? { success: true, error: null }
        : { success: false, error: 'The array source objects could not be updated.' };
      if (result.success) {
        if (editingDraft?.id === definition.id) {
          editingDraft.parentVisibleExpression = definition.parentVisibleExpression;
          editingDraft.parentVisibleManuallyEnabled = definition.parentVisibleManuallyEnabled;
        }
      }
      return result;
    },
  };

  function escaped(value) {
    return globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/["\\]/g, '\\$&');
  }

  function recordNode(recordId) {
    return svg.querySelector(`.canvas-record[data-record-id="${escaped(recordId)}"]`);
  }

  function ownDerivativeReferenceFromTarget(target) {
    const item = target?.closest?.('.array-item[data-array-placement-index]');
    const group = item?.parentElement?.matches?.('.array-group[data-array-id]')
      ? item.parentElement
      : null;
    if (!group) return null;
    return normalizeArraySourceReferences([{
      kind: 'array-placement',
      arrayId: group.dataset.arrayId,
      placementIndex: Number(item.dataset.arrayPlacementIndex),
    }])[0] || null;
  }

  function ownDerivativeNodeForReference(reference) {
    if (reference?.kind !== 'array-placement') return null;
    const group = objectLayer.querySelector(`.array-group[data-array-id="${escaped(reference.arrayId)}"]`);
    return [...(group?.children || [])].find((node) => (
      node.matches?.('.array-item[data-array-placement-index]')
      && Number(node.dataset.arrayPlacementIndex) === Number(reference.placementIndex)
    )) || null;
  }

  function derivativeReferenceFromTarget(target) {
    const ownReference = ownDerivativeReferenceFromTarget(target);
    if (ownReference) return ownReference;
    for (const provider of derivativeSourceProviders) {
      const reference = normalizeArraySourceReferences([provider?.referenceFromTarget?.(target)])[0];
      if (reference) return reference;
    }
    return null;
  }

  function derivativeNodeForReference(reference) {
    const ownNode = ownDerivativeNodeForReference(reference);
    if (ownNode) return ownNode;
    for (const provider of derivativeSourceProviders) {
      const node = provider?.nodeForReference?.(reference);
      if (node) return node;
    }
    return null;
  }

  function arrayDependsOn(arrayId, targetArrayId, visited = new Set()) {
    const sourceId = String(arrayId || '');
    const targetId = String(targetArrayId || '');
    if (!sourceId || !targetId) return false;
    if (sourceId === targetId) return true;
    if (visited.has(sourceId)) return false;
    visited.add(sourceId);
    const definition = arrays.find(({ id }) => id === sourceId);
    return Boolean(definition?.sourceRefs?.some((reference) => (
      reference.kind === 'array-placement'
      && arrayDependsOn(reference.arrayId, targetId, visited)
    )));
  }

  function derivativeReferenceCreatesCycle(reference) {
    return reference?.kind === 'array-placement'
      && editingDraft?.id
      && arrayDependsOn(reference.arrayId, editingDraft.id);
  }

  function derivativeSourceVisible(reference) {
    return arrayDerivativeSourceVisible(derivativeNodeForReference(reference));
  }

  function regionNodesFor(sourceIds) {
    return directClosedRegionNodesForSourceIds(objectLayer, sourceIds);
  }

  function templateFor(definition, entities) {
    const template = createSvg('g', { class: 'array-item-template' });
    const dimensionTextMode = canvas.getDimensionTextMode?.() || 'named-value';
    const explicitDependentIds = definition.sourceIds.filter((recordId) => {
      const entity = entities.get(recordId);
      return entity?.type === 'notch' || entity?.composite?.kind === 'finish-size-offset';
    });
    const sourceIds = definition.sourceIds.filter((recordId) => !explicitDependentIds.includes(recordId));
    const dependentIds = uniqueIds([
      ...explicitDependentIds,
      ...arrayDependentVisualIds(entities, definition.sourceIds),
    ]);
    const derivedPresentationNodes = canvas.getDerivedPresentationNodes?.(definition.sourceIds) || [];
    const derived = splitDerivedPresentationNodes(derivedPresentationNodes);
    derived.before.forEach((node) => {
      template.appendChild(sanitizeClone(node.cloneNode(true)));
    });
    sourceIds.forEach((recordId) => {
      if (constructionHiddenInValueOnly(entities.get(recordId), dimensionTextMode)) return;
      const node = recordNode(recordId);
      if (node) {
        const copy = sanitizeClone(node.cloneNode(true));
        copy.setAttribute('data-array-source-id', recordId);
        template.appendChild(copy);
      }
    });
    derived.after.forEach((node) => {
      template.appendChild(sanitizeClone(node.cloneNode(true)));
    });
    (canvas.getSeamLinePresentationNodes?.(definition.sourceIds) || [])
      .filter((node) => !derivedPresentationNodes.some((presentation) => presentation.contains(node)))
      .forEach((node) => {
        template.appendChild(sanitizeClone(node.cloneNode(true)));
      });
    dependentIds.forEach((recordId) => {
      if (constructionHiddenInValueOnly(entities.get(recordId), dimensionTextMode)) return;
      const node = recordNode(recordId);
      if (node) {
        const copy = sanitizeClone(node.cloneNode(true));
        copy.setAttribute('data-array-source-id', recordId);
        template.appendChild(copy);
      }
    });
    definition.sourceRefs.forEach((reference) => {
      const node = derivativeNodeForReference(reference);
      if (node) template.appendChild(sanitizeClone(node.cloneNode(true)));
    });
    regionNodesFor(definition.sourceIds).forEach((region) => {
      template.insertBefore(sanitizeClone(region.cloneNode(true)), template.firstChild);
    });
    return template;
  }

  function hitTemplateFor(template) {
    const hitLayer = template.cloneNode(true);
    hitLayer.setAttribute('class', 'array-item-hit-template');
    const hitTargets = [...hitLayer.querySelectorAll(ARRAY_VISIBLE_GEOMETRY_SELECTOR)];
    const retained = new Set([hitLayer]);
    hitTargets.forEach((node) => {
      const hitClass = ARRAY_STROKE_HIT_ELEMENTS.has(node.localName)
        ? 'array-item-geometry-hit'
        : 'array-item-area-hit';
      node.classList.add('array-item-hit', hitClass);
      let ancestor = node;
      while (ancestor && ancestor !== hitLayer) {
        retained.add(ancestor);
        ancestor = ancestor.parentElement;
      }
      if (hitClass === 'array-item-area-hit') {
        node.querySelectorAll('*').forEach((descendant) => retained.add(descendant));
      }
    });
    [...hitLayer.querySelectorAll('*')].reverse().forEach((node) => {
      if (!retained.has(node)) node.remove();
    });
    return hitTargets.length ? hitLayer : null;
  }

  function itemWithHitTarget(template, bounds, hitTemplateId = null) {
    const item = createSvg('g', { class: 'array-item' });
    const hitLayer = createSvg('g', { class: 'array-item-hit-layer' });
    if (hitTemplateId) {
      hitLayer.appendChild(createSvg('use', {
        class: 'array-item-hit-use',
        href: `#${hitTemplateId}`,
      }));
    } else {
      hitLayer.appendChild(createSvg('rect', {
        class: 'array-item-bounds-hit',
        x: bounds.x,
        y: bounds.y,
        width: Math.max(bounds.width, 0.001),
        height: Math.max(bounds.height, 0.001),
      }));
    }
    item.appendChild(hitLayer);
    item.appendChild(template.cloneNode(true));
    return item;
  }

  function definitionRenderData(definition, entities) {
    const center = definition.arrayType === 'circular' ? resolveCenter(definition) : null;
    if (definition.arrayType === 'circular' && !center) return null;
    const template = templateFor(definition, entities);
    if (!template.childNodes.length) return null;
    objectLayer.appendChild(template);
    let bounds;
    try {
      bounds = template.getBBox();
    } catch {
      bounds = null;
    }
    template.remove();
    if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return null;
    const evaluated = evaluateDefinition(definition, bounds);
    if (!evaluated.valid) return null;
    return { center, template, hitTemplate: hitTemplateFor(template), bounds, evaluated };
  }

  function renderDefinition(definition, entities) {
    if (!definitionProcessingEnabled(definition)) return;
    const stackId = definition.stackId;
    const stackVisible = canvas.isStackVisible?.(stackId) !== false;
    const stackActive = !canvas.getActiveStackId?.() || canvas.isStackActive?.(stackId) !== false;
    const objectVisible = definition.sourceIds.some((recordId) => (
      canvas.isObjectVisible?.(recordId) !== false
    )) || definition.sourceRefs.some(derivativeSourceVisible);
    const renderData = definitionRenderData(definition, entities);
    if (!renderData) return;
    const { center, template, hitTemplate, bounds, evaluated } = renderData;
    const paintAnchorId = arrayPaintAnchorRecordId(
      definition,
      canvas.getObjectPaintOrder?.() || [],
    );
    const group = createSvg('g', {
      class: `array-group${selectedArrayId === definition.id || windowSelectedArrayIds.has(definition.id) ? ' selected' : ''}${stackVisible ? '' : ' stack-hidden'}${stackActive ? '' : ' stack-inactive'}${objectVisible ? '' : ' object-visibility-hidden'}`,
      'data-array-id': definition.id,
      'data-stack-id': stackId,
      'data-object-visible': String(objectVisible),
      'data-paint-derived': 'true',
      'data-paint-after-record-id': paintAnchorId || '',
      'aria-label': `${arrayTypeLabels[definition.arrayType]} group`,
    });
    let hitTemplateId = null;
    if (hitTemplate) {
      hitTemplateId = `array-hit-${++hitTemplateSerial}`;
      hitTemplate.setAttribute('id', hitTemplateId);
      const definitions = createSvg('defs', { class: 'array-item-hit-definitions' });
      definitions.appendChild(hitTemplate);
      group.appendChild(definitions);
    }
    evaluated.placements.forEach((placement, placementIndex) => {
      if (
        (definition.arrayType === 'rectangular'
          && Math.abs(placement.translateX) < 1e-9
          && Math.abs(placement.translateY) < 1e-9)
        || (definition.arrayType === 'circular' && Math.abs(placement.angle) < 1e-9)
      ) return;
      const item = itemWithHitTarget(template, bounds, hitTemplateId);
      item.setAttribute('data-array-placement-index', String(placementIndex));
      if (definition.arrayType === 'rectangular') {
        item.setAttribute('transform', `translate(${placement.translateX} ${placement.translateY})`);
      } else {
        item.setAttribute('transform', `rotate(${placement.angle} ${center[0]} ${center[1]})`);
      }
      group.appendChild(item);
    });
    if (group.childNodes.length) objectLayer.appendChild(group);
  }

  function definitionsForRender() {
    if (!editingDraft) return arrays.filter(definitionProcessingEnabled);
    const existing = arrays.some(({ id }) => id === editingDraft.id);
    const evaluated = evaluateDefinition(editingDraft, editingSourceBounds);
    const draftIsRenderable = evaluated.valid
      && (editingDraft.arrayType !== 'circular' || Boolean(resolveCenter(editingDraft)));
    if (!draftIsRenderable) return arrays.filter(definitionProcessingEnabled);
    if (!existing) return [...arrays, editingDraft].filter(definitionProcessingEnabled);
    return arrays
      .map((definition) => definition.id === editingDraft.id ? editingDraft : definition)
      .filter(definitionProcessingEnabled);
  }

  function syncCenterHandle() {
    objectLayer.querySelectorAll('.array-center-handle').forEach((handle) => {
      handle.classList.remove('array-center-handle');
      handle.removeAttribute('data-preserve-feature-selection');
    });
    objectLayer.querySelectorAll('.array-center-control-record').forEach((record) => {
      record.classList.remove('array-center-control-record');
    });
    const entities = entityMap();
    entities.forEach((entity) => {
      if (isArrayCenterPointEntity(entity)) recordNode(entity.id)?.classList.add('array-center-control-record');
    });
    const definition = selectedDefinitionValue();
    if (definition?.arrayType !== 'circular' || !definition.centerRef) return;
    const handle = recordNode(definition.centerRef.recordId)?.querySelector(
      `.point-handle[data-handle-index="${Number(definition.centerRef.index) || 0}"]`,
    );
    if (!handle) return;
    handle.classList.add('array-center-handle');
    handle.setAttribute('data-preserve-feature-selection', '');
  }

  function renderNow() {
    renderFrame = null;
    objectLayer.querySelectorAll('.array-group').forEach((node) => node.remove());
    const entities = entityMap();
    const { ordered, cyclicIds } = orderArrayDefinitionsByDependencies(definitionsForRender());
    ordered
      .filter((definition) => !cyclicIds.has(String(definition.id)))
      .forEach((definition) => renderDefinition(definition, entities));
    syncSourceHighlights();
    syncCenterHandle();
    canvas.syncGeometryStacking?.();
  }

  function render() {
    if (renderFrame !== null) cancelAnimationFrame(renderFrame);
    renderFrame = requestAnimationFrame(renderNow);
  }

  function dimensionSourceIds(definition, entities) {
    return uniqueIds([
      ...definition.sourceIds,
      ...arrayDependentVisualIds(entities, definition.sourceIds),
    ]);
  }

  function derivedFeatureSet(definition, placementIndex, sourceId, entities, renderData, node = null) {
    const placement = renderData?.evaluated?.placements?.[placementIndex];
    if (!placement) return null;
    const sourceSet = canvas.getDimensionFeatureSet?.(sourceId, { rendered: true });
    if (!sourceSet) return null;
    const recordId = arrayDerivedRecordId(definition.id, placementIndex, sourceId);
    const transformed = transformDimensionFeatureSet(
      sourceSet,
      arrayPlacementTransform(placement, renderData.center),
      recordId,
      node,
    );
    transformed.features = (transformed.features || []).map((feature) => ({
      ...feature,
      dimensionReference: arrayDimensionReference(definition.id, placementIndex, sourceId),
      derivedKind: 'array-placement',
      arrayId: definition.id,
      arrayPlacementIndex: placementIndex,
      arraySourceId: sourceId,
    }));
    return transformed;
  }

  function resolveArrayDerivedTarget(recordId) {
    const legacy = parseArrayDerivedRecordId(recordId);
    if (legacy) return legacy;
    const entities = entityMap();
    for (const definition of arrays) {
      const renderData = definitionRenderData(definition, entities);
      if (!renderData) continue;
      const sourceIds = dimensionSourceIds(definition, entities);
      for (let placementIndex = 0; placementIndex < renderData.evaluated.placements.length; placementIndex += 1) {
        for (const sourceId of sourceIds) {
          if (arrayDerivedRecordId(definition.id, placementIndex, sourceId) === recordId) {
            return { arrayId: definition.id, placementIndex, sourceId };
          }
        }
      }
    }
    return null;
  }

  function derivedFeatureFromEvent({ target, world, mode = 'driven' }) {
    if (mode === 'driving') return null;
    const group = target?.closest?.('.array-group[data-array-id]');
    const item = target?.closest?.('.array-item[data-array-placement-index]');
    if (!group || !item) return null;
    const definition = definitionsById().get(group.dataset.arrayId);
    if (!definition) return null;
    const placementIndex = Number(item.dataset.arrayPlacementIndex);
    const entities = entityMap();
    const renderData = definitionRenderData(definition, entities);
    if (!renderData) return null;
    const exactSourceId = target.closest?.('[data-array-source-id]')?.dataset.arraySourceId || null;
    const sourceIds = exactSourceId
      ? [exactSourceId]
      : dimensionSourceIds(definition, entities);
    const featureSets = sourceIds.map((sourceId) => {
      const node = item.querySelector?.(`[data-array-source-id="${escaped(sourceId)}"]`) || item;
      return derivedFeatureSet(definition, placementIndex, sourceId, entities, renderData, node);
    }).filter(Boolean);
    return nearestDimensionFeature(featureSets, world, {
      pointTolerance: canvas.getWorldTolerance?.(10) || 10,
    });
  }

  function resolveDerivedFeature(request) {
    const selector = request?.derivedFeature;
    const parsed = selector?.provider === 'array' && selector.arrayId
      ? {
        arrayId: String(selector.arrayId),
        placementIndex: Number(selector.placementIndex),
        sourceId: String(selector.sourceId || request.recordId),
      }
      : request?.derivedKind === 'array-placement'
      ? {
        arrayId: request.arrayId,
        placementIndex: Number(request.arrayPlacementIndex),
        sourceId: request.arraySourceId,
      }
      : resolveArrayDerivedTarget(request?.recordId);
    if (!parsed) return null;
    const definition = definitionsById().get(parsed.arrayId);
    if (!definition) return null;
    const entities = entityMap();
    if (!dimensionSourceIds(definition, entities).includes(parsed.sourceId)) return null;
    const renderData = definitionRenderData(definition, entities);
    if (!renderData) return null;
    const item = objectLayer.querySelector?.(
      `.array-group[data-array-id="${escaped(parsed.arrayId)}"] .array-item[data-array-placement-index="${parsed.placementIndex}"]`,
    );
    const node = item?.querySelector?.(`[data-array-source-id="${escaped(parsed.sourceId)}"]`) || item || null;
    const featureSet = derivedFeatureSet(
      definition,
      parsed.placementIndex,
      parsed.sourceId,
      entities,
      renderData,
      node,
    );
    return resolveDimensionFeatureSet(featureSet, request);
  }

  function derivedFeatureDependsOn(recordId, changedRecordIds) {
    const parsed = resolveArrayDerivedTarget(recordId);
    if (!parsed || !changedRecordIds) return false;
    const definition = definitionsById().get(parsed.arrayId);
    if (!definition) return false;
    return changedRecordIds.has(parsed.sourceId)
      || definition.sourceIds.some((sourceId) => changedRecordIds.has(sourceId))
      || Boolean(definition.centerRef?.recordId && changedRecordIds.has(definition.centerRef.recordId));
  }

  const derivedDimensionProvider = {
    featureFromEvent: derivedFeatureFromEvent,
    resolveFeature: resolveDerivedFeature,
    dependsOn: derivedFeatureDependsOn,
  };

  function populateExpressionOptions() {
    parameterNames.replaceChildren(...(canvas.getParameterExpressionSymbols?.(editingDraft) || canvas.getParameters?.() || [])
      .filter((entry) => entry.name && !entry.error)
      .map((entry) => {
        const option = document.createElement('option');
        option.value = entry.name;
        option.label = entry.kind === 'dimension' ? `${entry.name} (dimension)` : entry.name;
        return option;
      }));
  }

  function updatePopupFromDraft() {
    if (!editingDraft) return;
    title.textContent = arrayTypeLabels[editingDraft.arrayType];
    const selectedCount = editingDraft.sourceIds.length + editingDraft.sourceRefs.length;
    sourceCount.textContent = `${selectedCount} object${selectedCount === 1 ? '' : 's'} selected`;
    selectObjectsButton.textContent = mode === 'selecting-sources' ? 'Finish Selection' : 'Select Objects';
    selectObjectsButton.classList.toggle('active', mode === 'selecting-sources');
    rectangularFields.hidden = editingDraft.arrayType !== 'rectangular';
    circularFields.hidden = editingDraft.arrayType !== 'circular';
    angleFields.hidden = editingDraft.fullCircle;
    [...form.elements].forEach((control) => {
      if (!control.name || !(control.name in editingDraft)) return;
      if (control.type === 'checkbox') control.checked = Boolean(editingDraft[control.name]);
      else if (document.activeElement !== control) control.value = editingDraft[control.name];
    });
    const center = resolveCenter(editingDraft);
    centerValue.textContent = center
      ? `${canvas.formatDrawingLength?.(center[0]) || center[0].toFixed(3)}, ${canvas.formatDrawingLength?.(center[1]) || center[1].toFixed(3)}`
      : 'No center selected';
    const evaluated = evaluateDefinition(editingDraft, editingSourceBounds);
    const error = firstError(evaluated.errors);
    errorText.textContent = error;
    [...form.querySelectorAll('input[name], select[name]')].forEach((control) => {
      control.setAttribute('aria-invalid', String(Boolean(evaluated.errors[control.name.replace('Expression', '')])));
    });
    render();
  }

  function popupSafeTop() {
    const toolbarBottom = document.querySelector('.app-header')?.getBoundingClientRect().bottom || 48;
    return Math.ceil(Math.max(8, toolbarBottom) + 8);
  }

  function popupSafeRight(margin = 8) {
    const configured = Number.parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--floating-panel-max-right'));
    return Number.isFinite(configured) ? configured : window.innerWidth - margin;
  }

  function positionPopup({ initialize = false } = {}) {
    if (popup.hidden) return;
    const margin = 8;
    const width = popup.offsetWidth || 340;
    const safeTop = popupSafeTop();
    const safeRight = popupSafeRight(margin);
    if (!popupPosition || initialize) {
      popupPosition = popupPosition || {
        left: safeRight - width - 8,
        top: safeTop,
      };
    }
    const availableHeight = Math.max(180, window.innerHeight - safeTop - margin);
    popup.style.maxHeight = `${availableHeight}px`;
    const height = Math.min(popup.scrollHeight || popup.offsetHeight || 330, availableHeight);
    popupPosition = clampPanelPosition({ ...popupPosition, width, height }, {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      margin,
      minTop: safeTop,
      maxRight: safeRight,
    });
    popup.style.left = `${popupPosition.left}px`;
    popup.style.top = `${popupPosition.top}px`;
    popup.style.maxHeight = `${Math.max(180, window.innerHeight - popupPosition.top - margin)}px`;
  }

  function openEditor(definition, { isNew = false } = {}) {
    windowSelectedArrayIds.clear();
    editingDraft = normalizeArrayDefinition(definition);
    editingSourceBounds = sourceBounds(editingDraft.sourceIds, null, editingDraft.sourceRefs);
    editingIsNew = isNew;
    editingHistoryCheckpointed = false;
    selectedArrayId = editingDraft.id;
    mode = 'editing';
    popup.hidden = false;
    canvas.setFeatureCommandDelegate(null);
    canvas.clearObjectSnapCandidate?.();
    populateExpressionOptions();
    updateButton();
    updatePopupFromDraft();
    canvas.syncState?.();
    requestAnimationFrame(() => positionPopup({ initialize: true }));
  }

  function closeEditor({ deselect = true, releaseFeatureDelegate = true } = {}) {
    editingDraft = null;
    editingSourceBounds = null;
    editingIsNew = false;
    editingHistoryCheckpointed = false;
    popup.hidden = true;
    popup.classList.remove('selecting-center');
    errorText.textContent = '';
    if (deselect) {
      selectedArrayId = null;
      windowSelectedArrayIds.clear();
    }
    mode = 'idle';
    activeType = null;
    pendingSourceIds.clear();
    pendingSourceRefs.clear();
    if (releaseFeatureDelegate) canvas.setFeatureCommandDelegate(null);
    canvas.clearObjectSnapCandidate?.();
    updateButton();
    render();
    canvas.syncState?.();
  }

  function derivativeWindowSourceCandidates() {
    return [...objectLayer.querySelectorAll([
      ':scope > .array-group[data-array-id] > .array-item[data-array-placement-index]',
      ':scope > .linked-copy-group[data-linked-copy-id]',
      '.swell-derived-group > .swell-derived-piece[data-swell-piece-index]',
      '.seam-line-presentation[data-seam-line-id]',
    ].join(','))].filter((node) => (
      !node.closest('.array-item-hit-definitions')
      && (!node.closest('.array-item') || node.matches('.array-item[data-array-placement-index]'))
    ));
  }

  function syncPendingSourceSelection(recordIds = []) {
    if (!editingDraft) return;
    pendingSourceIds = new Set(arraySourceIdsFromSelection(recordIds, entityMap()));
    editingDraft.sourceIds = [...pendingSourceIds];
    editingDraft.sourceRefs = [...pendingSourceRefs.values()];
    editingSourceBounds = sourceBounds(editingDraft.sourceIds, null, editingDraft.sourceRefs);
    syncSourceHighlights();
    updatePopupFromDraft();
    commitDraft();
  }

  const selectionProvider = {
    clearSelection() {
      if (
        preserveArraySelectionDuringCanvasClear
        || mode === 'selecting-sources'
        || mode === 'selecting-center'
      ) return false;
      const hadSelection = Boolean(selectedArrayId || windowSelectedArrayIds.size);
      if (!hadSelection) return false;
      if (!popup.hidden || editingDraft) closeEditor({ deselect: true });
      else {
        selectedArrayId = null;
        windowSelectedArrayIds.clear();
        render();
      }
      return true;
    },
    selectWindow({ matchesNode, bottomUp = false, additive = false } = {}) {
      if (mode === 'selecting-sources') {
        const references = arraySourceReferencesFromWindow(
          derivativeWindowSourceCandidates(),
          derivativeReferenceFromTarget,
          matchesNode,
          bottomUp,
        ).filter((reference) => (
          !derivativeReferenceCreatesCycle(reference) && derivativeSourceVisible(reference)
        ));
        if (!additive) pendingSourceRefs.clear();
        const remove = additive
          && references.length > 0
          && references.every((reference) => pendingSourceRefs.has(arraySourceReferenceKey(reference)));
        references.forEach((reference) => {
          const key = arraySourceReferenceKey(reference);
          if (remove) pendingSourceRefs.delete(key);
          else pendingSourceRefs.set(key, reference);
        });
        syncPendingSourceSelection(canvas.getSelectedRecordIds?.() || []);
        return { recordIds: [] };
      }
      if (mode === 'selecting-center') return { recordIds: [] };
      const matchedIds = arrayIdsFromWindow(
        objectLayer.querySelectorAll('.array-group[data-array-id]'),
        matchesNode,
        bottomUp,
      );
      const currentIds = [...windowSelectedArrayIds];
      if (selectedArrayId) currentIds.push(selectedArrayId);
      if ((!popup.hidden || editingDraft) && (!additive || matchedIds.length)) {
        closeEditor({ deselect: !additive });
      }
      const nextIds = resolveWindowSelectionIds(currentIds, matchedIds, additive);
      selectedArrayId = null;
      windowSelectedArrayIds.clear();
      nextIds.forEach((id) => windowSelectedArrayIds.add(id));
      suppressNextOutsideClick = windowSelectedArrayIds.size > 0;
      render();
      return { recordIds: [] };
    },
  };

  function updateButton() {
    const active = !popup.hidden;
    canvas.setInactiveStackHitTestingBlocked?.('array-tools', active);
    objectLayer.classList.toggle('array-source-selection-active', mode === 'selecting-sources');
    button?.classList.toggle('active', active);
    button?.setAttribute('aria-pressed', String(active));
  }

  function syncSourceHighlights() {
    svg.querySelectorAll('.array-source-selected').forEach((node) => node.classList.remove('array-source-selected'));
    if (mode !== 'selecting-sources') return;
    pendingSourceIds.forEach((id) => recordNode(id)?.classList.add('array-source-selected'));
    (canvas.getDerivedPresentationNodes?.([...pendingSourceIds]) || [])
      .forEach((node) => node.classList.add('array-source-selected'));
    pendingSourceRefs.forEach((reference) => {
      derivativeNodeForReference(reference)?.classList.add('array-source-selected');
    });
  }

  function deactivate() {
    mode = popup.hidden ? 'idle' : 'editing';
    activeType = null;
    pendingSourceIds.clear();
    pendingSourceRefs.clear();
    canvas.setFeatureCommandDelegate(null);
    canvas.clearObjectSnapCandidate?.();
    updateButton();
    syncSourceHighlights();
    return true;
  }

  function activate(type) {
    if (!arrayToolTypes.includes(type)) return false;
    closeEditor({ deselect: true });
    activeType = type;
    window.dispatchEvent(new CustomEvent('paramagic:tool-activated', { detail: { source: 'array' } }));
    openEditor(normalizeArrayDefinition({
      id: createUuid(),
      stackId: canvas.getActiveStackId?.() || null,
      arrayType: arrayTypeKeys[type],
      sourceIds: [],
      rowSpacingExpression: '20',
      columnSpacingExpression: '20',
    }), { isNew: true });
    updateButton();
    return true;
  }

  function beginSourceSelection() {
    if (!editingDraft) return false;
    if (mode === 'selecting-sources') return finishSourceSelection();
    mode = 'selecting-sources';
    pendingSourceIds = new Set(editingDraft.sourceIds);
    pendingSourceRefs = new Map(editingDraft.sourceRefs.map((reference) => [
      arraySourceReferenceKey(reference),
      reference,
    ]));
    canvas.setFeatureCommandDelegate(delegate);
    if (canvas.selectRecords) canvas.selectRecords([...pendingSourceIds]);
    else canvas.clearSelection();
    updateButton();
    updatePopupFromDraft();
    syncSourceHighlights();
    return true;
  }

  function sourceBounds(sourceIds, coordinateFrame = null, sourceRefs = []) {
    const group = createSvg('g');
    sourceIds.forEach((id) => {
      const node = recordNode(id);
      if (node) group.appendChild(sanitizeClone(node.cloneNode(true)));
    });
    (canvas.getDerivedPresentationNodes?.(sourceIds) || [])
      .forEach((node) => group.appendChild(sanitizeClone(node.cloneNode(true))));
    normalizeArraySourceReferences(sourceRefs).forEach((reference) => {
      const node = derivativeNodeForReference(reference);
      if (node) group.appendChild(sanitizeClone(node.cloneNode(true)));
    });
    if (!group.childNodes.length) return null;
    const holder = createSvg('g');
    if (coordinateFrame?.rotation) group.setAttribute('transform', `rotate(${-coordinateFrame.rotation * 180 / Math.PI})`);
    holder.appendChild(group);
    objectLayer.appendChild(holder);
    let bounds;
    try { bounds = holder.getBBox(); } catch { bounds = null; }
    holder.remove();
    return bounds;
  }

  function finishSourceSelection() {
    if (mode !== 'selecting-sources') return false;
    editingDraft.sourceIds = [...pendingSourceIds];
    editingDraft.sourceRefs = [...pendingSourceRefs.values()];
    editingSourceBounds = sourceBounds(editingDraft.sourceIds, null, editingDraft.sourceRefs);
    pendingSourceIds.clear();
    pendingSourceRefs.clear();
    activeType = null;
    canvas.setFeatureCommandDelegate(null);
    mode = 'editing';
    preserveArraySelectionDuringCanvasClear = true;
    try {
      canvas.clearSelection();
    } finally {
      preserveArraySelectionDuringCanvasClear = false;
    }
    syncSourceHighlights();
    updateButton();
    updatePopupFromDraft();
    commitDraft();
    return true;
  }

  function beginCenterSelection() {
    if (!editingDraft || editingDraft.arrayType !== 'circular') return;
    mode = 'selecting-center';
    popup.classList.add('selecting-center');
    canvas.setFeatureCommandDelegate(delegate);
    updateButton();
  }

  function finishCenterSelection(event) {
    const raw = canvas.screenToWorld(event.clientX, event.clientY);
    const result = resolveVectorDrawingPoint({
      rawPoint: raw,
      anchor: null,
      event,
      getNearestObjectPoint: canvas.getNearestObjectPoint,
    });
    const snap = result.snap;
    editingDraft.centerPoint = [...result.point];
    editingDraft.centerRef = snap?.recordId && Number.isInteger(Number(snap.index))
      ? { kind: 'point', recordId: snap.recordId, index: Number(snap.index) }
      : null;
    mode = 'editing';
    suppressNextOutsideClick = true;
    popup.classList.remove('selecting-center');
    canvas.setFeatureCommandDelegate(null);
    canvas.clearObjectSnapCandidate?.();
    updateButton();
    updatePopupFromDraft();
    commitDraft();
  }

  function commitDraft() {
    if (!editingDraft) return false;
    const evaluated = evaluateDefinition(editingDraft, editingSourceBounds);
    if (
      !evaluated.valid
      || (
        editingDraft.arrayType === 'circular'
        && arrayPlacementCount(evaluated) > 0
        && !resolveCenter(editingDraft)
      )
    ) return false;
    if (!editingHistoryCheckpointed) {
      canvas.requestHistoryCheckpoint?.(editingIsNew ? 'add-array' : 'edit-array');
      editingHistoryCheckpointed = true;
    }
    reconcileCenterControl(editingDraft);
    let committed = normalizeArrayDefinition(editingDraft);
    const index = arrays.findIndex(({ id }) => id === committed.id);
    const previous = index >= 0 ? arrays[index] : null;
    if (previous && !sameSourceSelection(previous, committed)) {
      applyArrayParentVisibility(previous, { restore: true });
      committed.parentVisibleExpression = null;
      committed.parentVisibleManuallyEnabled = null;
    }
    captureParentVisibility(committed);
    applyArrayParentVisibility(committed);
    if (index >= 0) arrays[index] = committed;
    else arrays.push(committed);
    editingIsNew = false;
    editingDraft = clone(committed);
    selectedArrayId = committed.id;
    canvas.notifyObjectChange({ history: 'coalesce' });
    return true;
  }

  function selectArray(arrayId) {
    const definition = definitionsById().get(arrayId);
    if (!definition) return false;
    deactivate();
    canvas.clearSelection();
    selectedArrayId = arrayId;
    openEditor(definition, { isNew: false });
    render();
    return true;
  }

  function deleteSelectedArray() {
    const selectedIds = selectedArrayId ? [selectedArrayId] : [...windowSelectedArrayIds];
    if (!selectedIds.length) return false;
    if (selectedIds.length === 1) return removeDefinition(selectedIds[0]);
    canvas.requestHistoryCheckpoint?.('delete-array-selection');
    const removed = selectedIds.reduce((changed, id) => (
      removeDefinition(id, { history: false }) || changed
    ), false);
    if (removed) canvas.notifyObjectChange({ history: 'commit' });
    return removed;
  }

  function arrayDefinitionAndDependentIds(arrayId) {
    const removedIds = new Set([String(arrayId)]);
    let changed = true;
    while (changed) {
      changed = false;
      arrays.forEach((definition) => {
        if (removedIds.has(definition.id)) return;
        if (!definition.sourceRefs.some((reference) => (
          reference.kind === 'array-placement' && removedIds.has(reference.arrayId)
        ))) return;
        removedIds.add(definition.id);
        changed = true;
      });
    }
    return removedIds;
  }

  function removeDefinitionsById(removedIds) {
    const ids = new Set([...removedIds].map(String));
    const removed = arrays.filter(({ id }) => ids.has(id));
    if (!removed.length) return false;
    const referencesRemovedArray = (value, visited = new Set()) => {
      if (typeof value === 'string') return false;
      if (!value || typeof value !== 'object' || visited.has(value)) return false;
      if (ids.has(value.arrayId)) return true;
      visited.add(value);
      return Object.values(value).some((item) => referencesRemovedArray(item, visited));
    };
    const annotationIds = (canvas.getDrawingData?.().dimensionAnnotations || [])
      .filter((annotation) => referencesRemovedArray(annotation))
      .map(({ id }) => id);
    const centerControlIds = removed
      .map((definition) => ownedCenterEntity(definition)?.id)
      .filter(Boolean);
    removed.forEach((definition) => applyArrayParentVisibility(definition, { restore: true }));
    for (let index = arrays.length - 1; index >= 0; index -= 1) {
      if (ids.has(arrays[index].id)) arrays.splice(index, 1);
    }
    if (ids.has(selectedArrayId) || ids.has(editingDraft?.id)) {
      selectedArrayId = null;
      editingDraft = null;
      editingSourceBounds = null;
      editingIsNew = false;
      editingHistoryCheckpointed = false;
      popup.hidden = true;
      mode = 'idle';
      pendingSourceIds.clear();
      pendingSourceRefs.clear();
      canvas.setFeatureCommandDelegate(null);
      syncSourceHighlights();
      updateButton();
    }
    ids.forEach((id) => windowSelectedArrayIds.delete(id));
    const dependentRecordIds = uniqueIds([...annotationIds, ...centerControlIds]);
    if (dependentRecordIds.length) {
      canvas.deleteRecords?.(dependentRecordIds, { checkpoint: false, notify: false });
    }
    renderNow();
    return true;
  }

  function removeDefinition(arrayId, { history = true } = {}) {
    if (!arrays.some(({ id }) => id === arrayId)) return false;
    if (history) canvas.requestHistoryCheckpoint?.('delete-array');
    const removed = removeDefinitionsById(arrayDefinitionAndDependentIds(arrayId));
    if (removed) canvas.notifyObjectChange({ history: history ? 'commit' : 'none' });
    return removed;
  }

  function setDefinitionStack(arrayId, stackId) {
    const definition = arrays.find(({ id }) => id === arrayId);
    if (!definition || !canvas.getStackState?.().stacks.some(({ id }) => id === stackId)) return false;
    canvas.requestHistoryCheckpoint?.('move-array-to-stack');
    definition.stackId = stackId;
    if (editingDraft?.id === arrayId) editingDraft.stackId = stackId;
    renderNow();
    canvas.notifyObjectChange({ history: 'commit' });
    return true;
  }

  function reassignStack(fromStackId, toStackId, { history = false } = {}) {
    const affected = arrays.filter(({ stackId }) => stackId === fromStackId);
    if (!affected.length) return false;
    if (history) canvas.requestHistoryCheckpoint?.('move-arrays-to-stack');
    affected.forEach((definition) => { definition.stackId = toStackId; });
    if (editingDraft?.stackId === fromStackId) editingDraft.stackId = toStackId;
    renderNow();
    if (history) canvas.notifyObjectChange({ history: 'commit' });
    return true;
  }

  function externalDerivativeReferenceExists(reference) {
    let handled = false;
    for (const provider of derivativeSourceProviders) {
      const exists = provider?.hasReference?.(reference);
      if (typeof exists !== 'boolean') continue;
      handled = true;
      if (exists) return true;
    }
    return !handled;
  }

  function removeReferences({ stackId = null, recordIds = [] } = {}) {
    const removedRecordIds = new Set(recordIds.map(String));
    const removeStack = stackId !== null && stackId !== undefined;
    const initiallyRemoved = arrays.filter((definition) => (
      (removeStack && definition.stackId === stackId)
      || definition.sourceIds.some((id) => removedRecordIds.has(String(id)))
      || definition.sourceRefs.some((reference) => (
        (reference.kind === 'swell-piece' && removedRecordIds.has(reference.ownerId))
        || (reference.kind === 'seam-line' && reference.sourceFeatures.some((feature) => (
          removedRecordIds.has(feature.sourceId)
        )))
        || (reference.kind === 'array-placement' && !arrays.some(({ id }) => id === reference.arrayId))
        || (reference.kind === 'linked-copy' && !externalDerivativeReferenceExists(reference))
      ))
      || removedRecordIds.has(String(definition.centerRef?.recordId || ''))
    ));
    if (!initiallyRemoved.length) return false;
    const removedArrayIds = new Set();
    initiallyRemoved.forEach(({ id }) => {
      arrayDefinitionAndDependentIds(id).forEach((dependentId) => removedArrayIds.add(dependentId));
    });
    return removeDefinitionsById(removedArrayIds);
  }

  function removeOrphanedDefinitions() {
    const entities = entityMap();
    const missingRecordIds = uniqueIds(arrays.flatMap((definition) => [
      ...definition.sourceIds,
      ...(definition.centerRef?.recordId ? [definition.centerRef.recordId] : []),
      ...definition.sourceRefs.flatMap((reference) => {
        if (reference.kind === 'swell-piece') return [reference.ownerId];
        if (reference.kind === 'seam-line') {
          return reference.sourceFeatures.map(({ sourceId }) => sourceId);
        }
        return [];
      }),
    ])).filter((id) => !entities.has(id));
    return removeReferences({ recordIds: missingRecordIds });
  }

  function removeStackReferences(stackId, recordIds = []) {
    return removeReferences({ stackId, recordIds });
  }

  function removeRecordReferences(recordIds = []) {
    return removeReferences({ recordIds });
  }

  const delegate = {
    get purpose() {
      return mode === 'selecting-sources' ? 'array-source-selection' : 'array-center-selection';
    },
    pointerDown(event) {
      if (event.button !== 0 || !editingDraft) return false;
      if (mode === 'selecting-sources') {
        const target = event.paramagicSelectionTarget || event.target;
        const additive = event.ctrlKey || event.metaKey;
        const reference = derivativeReferenceFromTarget(target);
        if (reference) {
          event.preventDefault();
          event.stopPropagation();
          if (derivativeReferenceCreatesCycle(reference)) {
            errorText.textContent = 'An Array cannot use one of its own dependent placements.';
            return true;
          }
          if (!additive) {
            pendingSourceIds.clear();
            pendingSourceRefs.clear();
            canvas.clearSelection();
          }
          const key = arraySourceReferenceKey(reference);
          if (additive && pendingSourceRefs.has(key)) pendingSourceRefs.delete(key);
          else pendingSourceRefs.set(key, reference);
          editingDraft.sourceIds = [...pendingSourceIds];
          editingDraft.sourceRefs = [...pendingSourceRefs.values()];
          editingSourceBounds = sourceBounds(editingDraft.sourceIds, null, editingDraft.sourceRefs);
          syncSourceHighlights();
          updatePopupFromDraft();
          commitDraft();
          return true;
        }
        const recordId = target?.closest?.('.canvas-record[data-record-id]')?.dataset.recordId;
        if (!recordId) return false;
        event.preventDefault();
        event.stopPropagation();
        if (!additive) pendingSourceRefs.clear();
        if (isArrayableEntity(entityMap().get(recordId))) {
          canvas.selectRecord?.(recordId, { additive });
        }
        return true;
      }
      if (mode !== 'selecting-center') return false;
      event.preventDefault();
      event.stopPropagation();
      finishCenterSelection(event);
      return true;
    },
    pointerMove(event) {
      if (mode !== 'selecting-center') return false;
      const result = resolveVectorDrawingPoint({
        rawPoint: canvas.screenToWorld(event.clientX, event.clientY),
        anchor: null,
        event,
        getNearestObjectPoint: canvas.getNearestObjectPoint,
      });
      canvas.setObjectSnapCandidate?.(result.snap);
      return true;
    },
    keyDown(event) {
      if (mode === 'selecting-center' && event.key === 'Escape') {
        event.preventDefault();
        mode = 'editing';
        popup.classList.remove('selecting-center');
        canvas.setFeatureCommandDelegate(null);
        canvas.clearObjectSnapCandidate?.();
        updateButton();
        return true;
      }
      return false;
    },
  };

  function hideMenu() {
    clearTimeout(closeTimer);
    tool?.classList.remove('open');
    menu?.classList.remove('open');
    button?.setAttribute('aria-expanded', 'false');
  }

  function showMenu() {
    clearTimeout(closeTimer);
    if (!menu || !button || button.disabled) {
      hideMenu();
      return;
    }
    tool?.classList.add('open');
    menu.classList.add('open');
    positionHeaderToolMenu(button, menu);
    button.setAttribute('aria-expanded', 'true');
  }

  function scheduleMenuClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(hideMenu, 120);
  }

  form.addEventListener('input', (event) => {
    if (!editingDraft || !event.target.name) return;
    editingDraft[event.target.name] = event.target.type === 'checkbox'
      ? event.target.checked
      : event.target.value;
    if (event.target.classList.contains('array-expression-input')) {
      commitDraft();
      return;
    }
    updatePopupFromDraft();
    commitDraft();
  });
  form.addEventListener('change', (event) => {
    if (!editingDraft || !event.target.name) return;
    editingDraft[event.target.name] = event.target.type === 'checkbox'
      ? event.target.checked
      : event.target.value;
    updatePopupFromDraft();
    commitDraft();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
  });
  popup.querySelectorAll('.array-expression-input').forEach((input) => {
    input.addEventListener('focus', () => {
      populateExpressionOptions();
      errorText.textContent = '';
      input.setAttribute('aria-invalid', 'false');
    });
  });
  popup.querySelector('[data-array-center]').addEventListener('click', beginCenterSelection);
  selectObjectsButton.addEventListener('click', beginSourceSelection);
  popup.querySelector('[data-array-close]').addEventListener('click', () => closeEditor({ deselect: true }));
  popup.addEventListener('pointerdown', (event) => {
    if (
      event.button !== 0
      || event.target.closest?.('button, input, select, textarea, label, [contenteditable="true"]')
    ) return;
    const rect = popup.getBoundingClientRect();
    popupPosition = { left: rect.left, top: rect.top };
    popupDrag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    popup.classList.add('dragging');
    try { popup.setPointerCapture?.(event.pointerId); } catch { /* window listeners keep the drag active */ }
    event.preventDefault();
    event.stopPropagation();
  });
  const movePopupDrag = (event) => {
    if (!popupDrag || event.pointerId !== popupDrag.pointerId) return;
    popupPosition = {
      left: event.clientX - popupDrag.offsetX,
      top: event.clientY - popupDrag.offsetY,
    };
    positionPopup();
    event.preventDefault();
    event.stopPropagation();
  };
  const finishPopupDrag = (event) => {
    if (!popupDrag || event.pointerId !== popupDrag.pointerId) return;
    const pointerId = popupDrag.pointerId;
    popupDrag = null;
    popup.classList.remove('dragging');
    if (popup.hasPointerCapture?.(pointerId)) popup.releasePointerCapture(pointerId);
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener('pointermove', movePopupDrag, true);
  window.addEventListener('pointerup', finishPopupDrag, true);
  window.addEventListener('pointercancel', finishPopupDrag, true);
  popup.addEventListener('lostpointercapture', () => {
    popupDrag = null;
    popup.classList.remove('dragging');
  });
  ['pointerdown', 'click', 'dblclick', 'keydown'].forEach((name) => popup.addEventListener(name, (event) => event.stopPropagation()));

  button?.addEventListener('pointerenter', showMenu);
  button?.addEventListener('pointerleave', scheduleMenuClose);
  button?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideMenu();
      return;
    }
    const openKey = button.closest('.header-section-vertical') ? 'ArrowLeft' : 'ArrowDown';
    if (event.key !== openKey) return;
    event.preventDefault();
    showMenu();
    menu?.querySelector('button')?.focus();
  });
  button?.addEventListener('click', () => activate(button.dataset.selectedArray || 'Rectangular Array'));
  menu?.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  menu?.addEventListener('pointerleave', scheduleMenuClose);
  menu?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    hideMenu();
    button?.focus();
  });
  menu?.querySelectorAll('[data-array-tool]').forEach((item) => item.addEventListener('click', (event) => {
    const selected = event.currentTarget.dataset.arrayTool;
    button.dataset.selectedArray = selected;
    button.innerHTML = event.currentTarget.innerHTML;
    button.title = selected;
    button.setAttribute('aria-label', selected);
    menu.querySelectorAll('[data-array-tool]').forEach((candidate) => {
      const stored = candidate === event.currentTarget;
      candidate.classList.toggle('stored-constraint', stored);
      if (stored) candidate.setAttribute('aria-current', 'true');
      else candidate.removeAttribute('aria-current');
    });
    hideMenu();
    activate(selected);
  }));

  window.addEventListener('pointerdown', (event) => {
    if (canvas.getSmartDimensionMode?.() === 'driven') return;
    if (mode === 'selecting-sources' || mode === 'selecting-center') return;
    const group = event.target.closest?.('.array-group[data-array-id]');
    if (!group) return;
    const definition = arrays.find(({ id }) => id === group.dataset.arrayId);
    if (!canvas.getActiveStackId?.() || canvas.isStackActive?.(definition?.stackId) === false) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    selectArray(group.dataset.arrayId);
  }, true);
  window.addEventListener('click', (event) => {
    if (canvas.getSmartDimensionMode?.() === 'driven') return;
    if (mode === 'selecting-sources' || mode === 'selecting-center') return;
    if (suppressNextOutsideClick) {
      suppressNextOutsideClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const group = event.target.closest?.('.array-group[data-array-id]');
    if (group) {
      const definition = arrays.find(({ id }) => id === group.dataset.arrayId);
      if (!canvas.getActiveStackId?.() || canvas.isStackActive?.(definition?.stackId) === false) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      selectArray(group.dataset.arrayId);
      return;
    }
    if (
      (selectedArrayId || windowSelectedArrayIds.size)
      && !popup.contains(event.target)
      && !menu?.contains(event.target)
      && event.target !== button
      && !event.target.closest?.(
        '[data-preserve-feature-selection], .stack-panel, .constraint-tool, [data-dimension-tool]',
      )
    ) selectionProvider.clearSelection();
  }, true);
  window.addEventListener('keydown', (event) => {
    if (
      mode === 'selecting-sources'
      && ['Enter', 'Escape'].includes(event.key)
      && !event.target.closest?.('input, textarea, select, [contenteditable="true"]')
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      finishSourceSelection();
      return;
    }
    if ((!selectedArrayId && !windowSelectedArrayIds.size) || !['Delete', 'Backspace'].includes(event.key)) return;
    if (event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    deleteSelectedArray();
  }, true);
  window.addEventListener('resize', () => {
    if (!popup.hidden) positionPopup();
  });
  canvasElement.addEventListener('pointermove', (event) => {
    if ((event.buttons & 1) && arrays.length) render();
    const hovered = event.target.closest?.('.array-group[data-array-id]');
    objectLayer.querySelectorAll('.array-group').forEach((group) => group.classList.toggle('hovered', group === hovered));
  });
  canvasElement.addEventListener('pointerup', () => {
    if (arrays.length) render();
  });
  canvasElement.addEventListener('pointerleave', () => {
    objectLayer.querySelectorAll('.array-group.hovered').forEach((group) => group.classList.remove('hovered'));
  });

  canvas.onSelectionChange((properties = {}) => {
    if (mode !== 'selecting-sources') return;
    syncPendingSourceSelection(
      canvas.getSelectedRecordIds?.() || properties.recordIds || [],
    );
  });
  canvas.onObjectsChange(() => {
    removeOrphanedDefinitions();
    arrays.filter(definitionProcessingEnabled).forEach((definition) => {
      const center = definition.arrayType === 'circular' ? resolveCenter(definition) : null;
      if (center) definition.centerPoint = [...center];
    });
    if (editingDraft?.arrayType === 'circular') {
      const center = resolveCenter(editingDraft);
      if (center) editingDraft.centerPoint = [...center];
    }
    if (editingDraft) {
      editingSourceBounds = sourceBounds(editingDraft.sourceIds, null, editingDraft.sourceRefs);
    }
    render();
    canvas.refreshLinkedDimensions?.();
  });
  canvas.onPresentationChange?.(() => render());
  canvas.onStackChange?.(() => render());
  canvas.registerDrawingExtension?.('arrayTools', {
    serialize() {
      return arrays.length ? { version: 6, arrays: arrays.map(normalizeArrayDefinition) } : null;
    },
    restore(value) {
      const version = value?.version ?? 1;
      arrays.splice(0, arrays.length, ...(value?.arrays || []).map((definition) => migrateArrayDefinition(definition, version)));
      removeOrphanedDefinitions();
      arrays.forEach(reconcileCenterControl);
      arrays.forEach((definition) => {
        captureParentVisibility(definition);
        applyArrayParentVisibility(definition);
      });
      selectedArrayId = null;
      windowSelectedArrayIds.clear();
      suppressNextOutsideClick = false;
      preserveArraySelectionDuringCanvasClear = false;
      editingDraft = null;
      editingSourceBounds = null;
      popup.hidden = true;
      mode = 'idle';
      updateButton();
      render();
    },
    clear() {
      arrays.splice(0);
      selectedArrayId = null;
      windowSelectedArrayIds.clear();
      suppressNextOutsideClick = false;
      preserveArraySelectionDuringCanvasClear = false;
      editingDraft = null;
      editingSourceBounds = null;
      popup.hidden = true;
      mode = 'idle';
      updateButton();
      objectLayer.querySelectorAll('.array-group').forEach((node) => node.remove());
    },
    removeStackReferences,
    removeRecordReferences,
  });
  window.addEventListener('paramagic:tool-activated', (event) => {
    if (event.detail?.source === 'array') return;
    if (!popup.hidden) {
      const preserveCenterSelection = ['constraint', 'dimension'].includes(event.detail?.source)
        && selectedDefinitionValue()?.arrayType === 'circular';
      closeEditor({
        deselect: !preserveCenterSelection,
        releaseFeatureDelegate: !preserveCenterSelection,
      });
    }
  });

  render();
  return {
    activate,
    deactivate,
    render,
    selectArray,
    deleteSelectedArray,
    definitions: () => arrays.map(clone),
    selectedDefinition: () => clone(selectedDefinitionValue()),
    removeDefinition,
    setDefinitionStack,
    reassignStack,
    removeStackReferences,
    removeRecordReferences,
    derivedDimensionProvider,
    subtractOperandProvider,
    selectionProvider,
    selectionPropertyProvider,
  };
}
