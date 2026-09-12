import { resolveVectorDrawingPoint } from './DrawingTools.js';
import { IDENTITY_FRAME, inverseStackFrame, stackFrameMatrix, stackFrameFor, transformStackPoint } from './StackCoordinates.js';
import { dimensionFeatureDistance, nearestDimensionFeature, resolveDimensionFeatureSet, transformDimensionFeatureSet } from './DimensionSystem.js';
import { isSwellEntity } from './SwellGeometry.js';
import {
  directClosedRegionNodesForSourceIds,
  splitDerivedPresentationNodes,
} from './CanvasPaintOrder.js';
import { evaluateVisibleExpression } from './ObjectVisibility.js';
import { replaceTableCellForeignObjects } from './TableTools.js';
import { prepareNotchDerivativePresentationClone } from './NotchSystem.js';
import { createUuid, deriveUuidForKey } from './IdentitySystem.js';
import { registerIdentitySchema } from './DrawingIdentitySystem.js';
import { constructionHiddenInValueOnly } from './CanvasPresentation.js';
import { resolveWindowSelectionIds, canvasPointHandleHitDistance } from './CanvasSelection.js';

registerIdentitySchema('linkedCopyTools', {
  declarations: (value) => [
    ...(value?.copies || []).map((object, index) => ({
      object, key: 'id', value: object.id, path: ['extensions', 'linkedCopyTools', 'copies', String(index), 'id'], kind: 'linked-copy-definition',
    })),
    ...(value?.positionConstraints || []).map((object, index) => ({
      object, key: 'id', value: object.id, path: ['extensions', 'linkedCopyTools', 'positionConstraints', String(index), 'id'], kind: 'linked-position-constraint',
    })),
  ],
  liveReferenceKeys: [
    'stackId', 'recordId', 'copyId', 'sourceId', 'linkedCopyId', 'linkedSourceId', 'dimensionId', 'parameterId',
  ],
  liveReferenceArrayKeys: ['sourceIds', 'participantStackIds'],
  lineageReferenceKeys: ['sourceDefinitionId', 'sourceRelationshipId', 'sourceStackId'],
  targetKindsByKey: {
    stackId: ['stack'],
    copyId: ['linked-copy-definition'],
    linkedCopyId: ['linked-copy-definition'],
    dimensionId: ['parameter'],
    parameterId: ['parameter'],
    participantStackIds: ['stack'],
    sourceIds: ['entity'],
    sourceId: ['entity'],
    linkedSourceId: ['entity'],
  },
});

export const DUPLICATE_ICON = '<rect x="4" y="4" width="11" height="11" rx="1"/><rect x="9" y="9" width="11" height="11" rx="1"/>';
export const SYMMETRIC_ICON = '<path d="M3.5 6.5l5.5 2.4v6.2l-5.5 2.4zM20.5 6.5L15 8.9v6.2l5.5 2.4z"/><path d="M12 3v3m0 2v4m0 2v3m0 2v2" stroke-width="2"/>';

const SVG_NS = 'http://www.w3.org/2000/svg';
const clone = (value) => JSON.parse(JSON.stringify(value));
const uniqueIds = (values = []) => [...new Set(values.filter(Boolean).map(String))];

export function linkedCopyDimensionReference(copyId, sourceId) {
  return {
    recordId: String(sourceId),
    derivedFeature: {
      provider: 'linked-copy',
      copyId: String(copyId),
      sourceId: String(sourceId),
    },
  };
}

function portableFeatureReference(feature = {}) {
  const reference = feature.dimensionReference || feature;
  return {
    recordId: String(reference.recordId),
    ...(reference.derivedFeature ? { derivedFeature: clone(reference.derivedFeature) } : {}),
  };
}

function linkedConstraintPointReference(feature) {
  const reference = portableFeatureReference(feature);
  return {
    kind: 'point',
    ...reference,
    index: Number(feature.index),
    ...(feature.pointRole ? { pointRole: feature.pointRole } : {}),
  };
}

export function normalizeLinkedPositionConstraint(value = {}) {
  const target = value.externalDrivingTarget || {};
  if (!target.copyId || !target.sourceId || !target.otherAnchor?.recordId) return null;
  const stackId = value.stackId ? String(value.stackId) : null;
  const targetReference = linkedCopyDimensionReference(target.copyId, target.sourceId);
  const legacyTargetRecordId = String(target.recordId || '');
  let assignedDerivedReference = false;
  const featureRefs = (value.featureRefs || []).map((feature) => {
    const selector = feature?.dimensionReference?.derivedFeature || feature?.derivedFeature;
    const matchesSelector = selector?.provider === 'linked-copy'
      && String(selector.copyId) === String(target.copyId)
      && String(selector.sourceId || feature.recordId) === String(target.sourceId);
    const matchesLegacyTarget = !assignedDerivedReference
      && legacyTargetRecordId
      && String(feature?.recordId) === legacyTargetRecordId
      && Number(feature?.index) === Number(target.pointIndex);
    if (matchesSelector || matchesLegacyTarget) {
      assignedDerivedReference = true;
      return linkedConstraintPointReference({
        ...feature,
        dimensionReference: targetReference,
      });
    }
    return linkedConstraintPointReference(feature);
  });
  const otherAnchorReference = portableFeatureReference(target.otherAnchor);
  return {
    id: String(value.id || createUuid()),
    ...(value.sourceRelationshipId ? { sourceRelationshipId: String(value.sourceRelationshipId) } : {}),
    ...(value.stackRelationshipBindingKey ? { stackRelationshipBindingKey: String(value.stackRelationshipBindingKey) } : {}),
    type: 'Coincident',
    source: 'geometric',
    stackId,
    participantStackIds: uniqueIds(value.participantStackIds).filter((id) => id !== stackId),
    featureRefs,
    externalDrivingTarget: {
      type: 'linked-position',
      ...targetReference,
      copyId: String(target.copyId),
      sourceId: String(target.sourceId),
      pointIndex: Number(target.pointIndex),
      otherAnchor: {
        type: 'point',
        ...otherAnchorReference,
        index: Number(target.otherAnchor.index),
        ...(target.otherAnchor.pointRole ? { pointRole: target.otherAnchor.pointRole } : {}),
      },
      axis: 'horizontal',
      axisSign: 1,
      perpendicularOffset: 0,
    },
  };
}

export function linkedCopyIdsFromWindow(groups = [], matchesNode = () => false) {
  return uniqueIds([...groups]
    .filter((group) => matchesNode(group))
    .map((group) => group?.dataset?.linkedCopyId));
}

export function moveLinkedCopyDefinitions(definitions = [], startAnchors = new Map(), delta = [0, 0]) {
  definitions.forEach((definition) => {
    const anchor = startAnchors.get(definition.id);
    if (!anchor) return;
    definition.anchor = [anchor[0] + delta[0], anchor[1] + delta[1]];
  });
  return definitions;
}

export function linkedCopyOutsideClickAction({
  suppressNextOutsideClick = false,
  hasSelection = false,
  insideLinkedCopy = false,
  preservesSelection = false,
} = {}) {
  if (suppressNextOutsideClick) {
    return { suppressNextOutsideClick: false, clearSelection: false };
  }
  return {
    suppressNextOutsideClick: false,
    clearSelection: Boolean(hasSelection && !insideLinkedCopy && !preservesSelection),
  };
}

function finitePoint(value, fallback = [0, 0]) {
  if (!Array.isArray(value) || value.length < 2) return [...fallback];
  const point = value.slice(0, 2).map(Number);
  return point.every(Number.isFinite) ? point : [...fallback];
}

function finiteLinear(value) {
  const result = { a: Number(value?.a), b: Number(value?.b), c: Number(value?.c), d: Number(value?.d) };
  return Object.values(result).every(Number.isFinite) ? result : { a: 1, b: 0, c: 0, d: 1 };
}

export function normalizeLinkedCopyDefinition(value = {}) {
  const id = String(value.id || createUuid());
  const stackId = value.stackId ? String(value.stackId) : null;
  const visibleExpression = Object.prototype.hasOwnProperty.call(value, 'visibleExpression')
    ? String(value.visibleExpression ?? '').trim()
    : '';
  const visibleManuallyEnabled = Object.prototype.hasOwnProperty.call(value, 'visibleManuallyEnabled')
    ? value.visibleManuallyEnabled !== false
    : (!visibleExpression || visibleExpression.toUpperCase() === 'TRUE')
      ? value.visible !== false
      : false;
  return {
    id,
    sourceDefinitionId: String(value.sourceDefinitionId || id),
    sourceStackId: value.sourceStackId || stackId ? String(value.sourceStackId || stackId) : null,
    type: value.type === 'symmetric' ? 'symmetric' : 'duplicate',
    sourceIds: uniqueIds(value.sourceIds),
    anchor: finitePoint(value.anchor),
    linear: finiteLinear(value.linear),
    ...(value.coordinateFrame ? { coordinateFrame: { ...value.coordinateFrame } } : {}),
    stackId,
    visible: visibleManuallyEnabled
      ? true
      : typeof value.visible === 'boolean'
        ? value.visible
        : false,
    visibleManuallyEnabled,
    visibleExpression,
    zIndex: value.zIndex !== null
      && value.zIndex !== undefined
      && Number.isFinite(Number(value.zIndex))
      ? Number(value.zIndex)
      : null,
  };
}

export function linkedCopyPaintKey(copyId) {
  return `linked-copy:${String(copyId)}`;
}

export function linkedCopyUsesOutlineHit(definition, entities) {
  const byId = entities instanceof Map
    ? (id) => entities.get(id)
    : (id) => entities?.[id];
  return (definition?.sourceIds || []).some((id) => byId(id)?.type === 'table');
}

export function linkedCopyVisibilityState(definition, evaluate) {
  const normalized = normalizeLinkedCopyDefinition(definition);
  if (normalized.visibleManuallyEnabled) {
    return {
      value: true,
      expression: normalized.visibleExpression.toUpperCase() === 'TRUE'
        ? ''
        : normalized.visibleExpression,
      error: null,
    };
  }
  return evaluateVisibleExpression(
    normalized.visibleExpression,
    (expression) => evaluate(expression, normalized),
  );
}

export function linkedCopySelectionPropertyPatch(definitions = [], evaluate, baseProperties = {}) {
  const selected = [...definitions];
  if (!selected.length) return null;
  const states = selected.map((definition) => linkedCopyVisibilityState(definition, evaluate));
  const values = new Set(selected.map((definition) => (
    normalizeLinkedCopyDefinition(definition).visibleManuallyEnabled
  )));
  const expressions = new Set(states.map(({ expression }) => expression));
  const baseSelectionCount = Number(baseProperties.selectionCount) || 0;
  const baseSupportedCount = Number(baseProperties.supportedCount) || 0;
  const canEditVisible = baseSelectionCount === 0;
  return {
    selectionCount: baseSelectionCount + selected.length,
    supportedCount: baseSupportedCount + selected.length,
    linkedCopyCount: selected.length,
    canArrange: true,
    canEditVisible,
    visible: canEditVisible && values.size === 1 ? [...values][0] : null,
    mixedVisible: canEditVisible && values.size > 1,
    visibleExpression: canEditVisible && expressions.size === 1 ? [...expressions][0] : null,
    errors: { visible: canEditVisible ? states.find(({ error }) => error)?.error || null : null },
  };
}

export function applyMatrix(matrix, [x, y]) {
  return [matrix.a * x + matrix.c * y + matrix.e, matrix.b * x + matrix.d * y + matrix.f];
}

export const reflectPoint = applyMatrix;

export function reflectionMatrix(start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  if (length < 0.000001) return null;
  const ux = dx / length;
  const uy = dy / length;
  const a = 2 * ux * ux - 1;
  const b = 2 * ux * uy;
  const c = b;
  const d = 2 * uy * uy - 1;
  return { a, b, c, d, e: start[0] - a * start[0] - c * start[1], f: start[1] - b * start[0] - d * start[1] };
}

export function linkedCopyInFrame(definition, frame) {
  const copy = normalizeLinkedCopyDefinition(definition);
  if (frame) {
    const previous = copy.coordinateFrame || IDENTITY_FRAME;
    copy.anchor = transformStackPoint(transformStackPoint(copy.anchor, previous, true), frame);
    const angle = frame.rotation - previous.rotation;
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    const { a, b, c, d } = copy.linear;
    const ra = cosine * a - sine * b, rb = sine * a + cosine * b;
    const rc = cosine * c - sine * d, rd = sine * c + cosine * d;
    copy.linear = { a: ra * cosine - rc * sine, b: rb * cosine - rd * sine,
      c: ra * sine + rc * cosine, d: rb * sine + rd * cosine };
    copy.coordinateFrame = { ...frame };
  }
  return copy;
}

export function linkedCopyMatrix(definition, sourceAnchor, frame = null) {
  const copy = linkedCopyInFrame(definition, frame);
  const [x, y] = finitePoint(sourceAnchor);
  const [targetX, targetY] = copy.anchor;
  const { a, b, c, d } = copy.linear;
  return { a, b, c, d, e: targetX - a * x - c * y, f: targetY - b * x - d * y };
}

export function linkedCopyDefinitionFromMatrix({ id, type = 'symmetric', sourceIds, sourceAnchor, matrix, stackId = null }) {
  return normalizeLinkedCopyDefinition({
    id,
    type,
    sourceIds,
    anchor: applyMatrix(matrix, finitePoint(sourceAnchor)),
    linear: matrix,
    stackId,
  });
}

export function linkedPositionAnchorUpdate(definition, currentDerivedPoint, referencePoint, target, value) {
  const axisIndex = target?.axis === 'vertical' ? 1 : target?.axis === 'horizontal' ? 0 : -1;
  const distance = Number(value);
  if (
    axisIndex < 0
    || !Number.isFinite(distance)
    || distance < 0
    || !finitePoint(currentDerivedPoint, [NaN, NaN]).every(Number.isFinite)
    || !finitePoint(referencePoint, [NaN, NaN]).every(Number.isFinite)
  ) return null;
  const derived = finitePoint(currentDerivedPoint);
  const reference = finitePoint(referencePoint);
  const perpendicularIndex = axisIndex === 0 ? 1 : 0;
  const desired = [...derived];
  desired[axisIndex] = reference[axisIndex] + (Number(target.axisSign) < 0 ? -1 : 1) * distance;
  desired[perpendicularIndex] = reference[perpendicularIndex] + Number(target.perpendicularOffset || 0);
  const normalized = normalizeLinkedCopyDefinition(definition);
  return [
    normalized.anchor[0] + desired[0] - derived[0],
    normalized.anchor[1] + desired[1] - derived[1],
  ];
}

export function linkedCoincidentPositionTarget(derived, reference) {
  if (
    derived?.kind !== 'point'
    || !derived.recordId
    || !derived.linkedCopyId
    || !derived.linkedSourceId
    || !Number.isInteger(derived.index)
    || reference?.kind !== 'point'
    || !reference.recordId
    || !Number.isInteger(reference.index)
  ) return null;
  const derivedReference = linkedCopyDimensionReference(derived.linkedCopyId, derived.linkedSourceId);
  const otherReference = portableFeatureReference(reference);
  return {
    type: 'linked-position',
    ...derivedReference,
    copyId: derived.linkedCopyId,
    sourceId: derived.linkedSourceId,
    pointIndex: derived.index,
    otherAnchor: {
      type: 'point',
      ...otherReference,
      index: reference.index,
      ...(reference.pointRole ? { pointRole: reference.pointRole } : {}),
    },
    axis: 'horizontal',
    axisSign: 1,
    perpendicularOffset: 0,
  };
}

export function linkedConstraintHelperVisible({
  definition,
  constraint,
  isStackVisible = () => true,
  isStackActive = () => true,
  isObjectVisible = () => true,
  isDefinitionVisible = null,
  isRecordInActiveStack = () => undefined,
} = {}) {
  if (!definition) return false;
  const stackId = definition.stackId;
  const hasIndependentVisibility = Object.prototype.hasOwnProperty.call(definition, 'visible')
    || Object.prototype.hasOwnProperty.call(definition, 'visibleExpression');
  const objectVisible = hasIndependentVisibility
    ? (typeof isDefinitionVisible === 'function' ? isDefinitionVisible(definition) : definition.visible !== false)
    : definition.sourceIds.some((id) => isObjectVisible(id) !== false);
  const visible = isStackVisible(stackId) !== false && objectVisible;
  if (!visible) return false;
  return isStackActive(stackId) !== false
    || (constraint?.featureRefs || []).some(({ recordId }) => isRecordInActiveStack(recordId) === true);
}

export function nearestLinkedHoverSource(featureSets, point, tolerance) {
  const limit = Number(tolerance);
  if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(limit) || limit < 0) return null;
  let nearest = null;
  (featureSets || []).forEach((featureSet) => {
    (featureSet?.features || []).forEach((feature) => {
      const distance = dimensionFeatureDistance(feature, point);
      if (!Number.isFinite(distance) || (nearest && nearest.distance <= distance)) return;
      nearest = { sourceId: feature.linkedSourceId, distance };
    });
  });
  return nearest && nearest.distance <= limit ? nearest.sourceId || null : null;
}

export function syncLinkedCopyHandleHover(groups, event, enabled = true) {
  let hoveredCount = 0;
  groups.forEach(group => {
    group.querySelectorAll('.linked-copy-driving-handle').forEach(handle => {
      const hovered = enabled && Number.isFinite(canvasPointHandleHitDistance(handle, event.clientX, event.clientY));
      handle.classList.toggle('hovered', hovered);
      if (hovered) hoveredCount++;
    });
  });
  return hoveredCount;
}

function derivedRecordUuid(kind, copyId, sourceId) {
  return deriveUuidForKey('linked-copy-derived', copyId, kind, sourceId);
}

function parseLegacyDerivedId(value, prefix) {
  const match = new RegExp(`^${prefix}:([^:]+):(.+)$`).exec(String(value || ''));
  if (!match) return null;
  try { return { copyId: decodeURIComponent(match[1]), sourceId: decodeURIComponent(match[2]) }; } catch { return null; }
}

export const symmetricDerivedRecordId = (copyId, sourceId) => derivedRecordUuid('symmetric-derived', copyId, sourceId);
export const duplicateDerivedRecordId = (copyId, sourceId) => derivedRecordUuid('duplicate-derived', copyId, sourceId);
export function parseLegacySymmetricDerivedRecordId(value) {
  const parsed = parseLegacyDerivedId(value, 'symmetric-derived');
  return parsed ? { centerlineId: parsed.copyId, sourceId: parsed.sourceId } : null;
}
export const parseLegacyDuplicateDerivedRecordId = (value) => parseLegacyDerivedId(value, 'duplicate-derived');

export function isSymmetricCenterline(entity) {
  return entity?.type === 'line' && entity.composite?.kind === 'symmetric-centerline';
}
export const isDerivedSeamEntity = (entity) => entity?.composite?.kind === 'finish-size-offset';
export function seamDependsOnSelectedSources(entity, selectedSourceIds) {
  if (!isDerivedSeamEntity(entity)) return false;
  const ownerIds = new Set((entity.composite?.sourceFeatures || []).map(({ recordId }) => recordId).filter(Boolean));
  return ownerIds.size > 0 && [...ownerIds].every((id) => selectedSourceIds.has(id));
}
export function isMirrorableEntity(entity) {
  return Boolean(
    entity?.id
    && !isSymmetricCenterline(entity)
    && (entity.construction !== true || isSwellEntity(entity))
    && !String(entity.type || '').includes('dimension')
  );
}
export function isDuplicableEntity(entity) {
  return Boolean(entity?.id && !isSymmetricCenterline(entity) && !isDerivedSeamEntity(entity) && !String(entity.type || '').includes('dimension'));
}

export function selectionIdsFromTarget(target) {
  if (!target?.closest) return [];
  const selectionSet = target.closest('[data-selection-record-ids]');
  if (selectionSet) return String(selectionSet.dataset.selectionRecordIds || '').split(',').map((id) => id.trim()).filter(Boolean);
  const region = target.closest('.closed-constrained-region[data-parent-ids]');
  if (region) return String(region.dataset.parentIds || '').split(',').map((id) => id.trim()).filter(Boolean);
  const record = target.closest([
    '.canvas-record[data-record-id]',
    '.canvas-handle-group[data-record-id]',
    '.table-handle-group[data-record-id]',
  ].join(','));
  return record?.dataset.recordId ? [record.dataset.recordId] : [];
}

function createSvg(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value));
  return node;
}

function sanitizeClone(node, type) {
  [node, ...node.querySelectorAll('*')].forEach((child) => {
    child.classList.remove('canvas-record', 'selected', 'hovered', 'smart-selected', 'overlap-cycle-selected', 'linked-copy-source-selected', 'symmetric-source-selected', 'stack-hidden', 'stack-inactive', 'object-visibility-hidden');
    ['id', 'data-record-id', 'data-object-visible', 'aria-label', 'role', 'contenteditable'].forEach((name) => child.removeAttribute(name));
    child.style.pointerEvents = 'none';
    // SVG clones are graphics, not focus targets. Keep embedded HTML editors
    // out of the tab order without making every SVG child mouse-focusable.
    if (child.namespaceURI === SVG_NS) child.removeAttribute('tabindex');
    else if ('tabIndex' in child) child.tabIndex = -1;
  });
  node.querySelectorAll('.handle-group,.segment-selection-layer,.hit-target,.image-context-toolbar,.text-selection-frame,.text-resize-handle,.text-rotation-handle,.text-rotation-stem,.notch-hit').forEach((child) => child.remove());
  node.classList.add('linked-copy-content', `${type}-copy-content`);
  if (type === 'symmetric') node.classList.add('symmetric-mirror-copy');
  return node;
}

function keepTextReadable(node) {
  const box = node.querySelector('.text-foreign-object');
  if (!box) return node;
  const x = Number(box.getAttribute('x'));
  const width = Number(box.getAttribute('width'));
  if (!Number.isFinite(x) || !Number.isFinite(width)) return node;
  const existing = node.getAttribute('transform');
  node.setAttribute('transform', [existing, `translate(${2 * (x + width / 2)} 0) scale(-1 1)`].filter(Boolean).join(' '));
  return node;
}

const boundsCenter = (bounds) => bounds ? [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2] : null;

export function createLinkedCopyTools({ toolbar, canvas }) {
  const symmetricButton = toolbar?.querySelector('[data-symmetric-tool]');
  const duplicateButton = toolbar?.querySelector('[data-duplicate-tool]');
  const canvasElement = canvas.getCanvasElement();
  const svg = canvasElement.querySelector('.drawing-plane');
  const objectLayer = canvas.getObjectLayer?.() || svg?.querySelector('g > g:nth-child(2)');
  const definitions = [];
  const positionConstraints = [];
  let mode = 'idle';
  let activeType = null;
  let firstPoint = null;
  let symmetryMatrix = null;
  let pendingSourceIds = new Set();
  let selectedCopyId = null;
  const windowSelectedCopyIds = new Set();
  let suppressNextOutsideClick = false;
  let renderFrame = null;

  if (!objectLayer) return { activate: () => false, cancel: () => false, render: () => {}, definitions: () => [], selectedDefinition: () => null, derivedDimensionProvider: {}, constraintOperation: {} };

  const snapshot = () => canvas.getProcessingDrawingData?.() || canvas.getDrawingData();
  const entityMap = () => new Map((snapshot().entities || []).map((entity) => [entity.id, entity]));
  const escaped = (value) => globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/["\\]/g, '\\$&');
  const recordNode = (id) => svg.querySelector(`.canvas-record[data-record-id="${escaped(id)}"]`);
  const accepts = (entity, type) => type === 'symmetric' ? isMirrorableEntity(entity) : isDuplicableEntity(entity);
  const derivativeSourceProvider = {
    referenceFromTarget(target) {
      const group = target?.closest?.('.linked-copy-group[data-linked-copy-id]');
      return group ? { kind: 'linked-copy', copyId: group.dataset.linkedCopyId } : null;
    },
    nodeForReference(reference) {
      if (reference?.kind !== 'linked-copy') return null;
      return [...objectLayer.children].find((node) => (
        node.classList?.contains?.('linked-copy-group')
        && node.dataset?.linkedCopyId === String(reference.copyId)
      )) || null;
    },
    hasReference(reference) {
      if (reference?.kind !== 'linked-copy') return undefined;
      return definitions.some(({ id }) => id === String(reference.copyId));
    },
  };

  function sourceBounds(sourceIds, frame = null) {
    const holder = createSvg('g');
    sourceIds.forEach((id) => {
      const node = recordNode(id);
      if (node) holder.appendChild(sanitizeClone(node.cloneNode(true), 'duplicate'));
    });
    (canvas.getDerivedPresentationNodes?.(sourceIds) || [])
      .forEach((node) => holder.appendChild(sanitizeClone(node.cloneNode(true), 'duplicate')));
    if (!holder.childNodes.length) return null;
    const outer = createSvg('g');
    if (frame) holder.setAttribute('transform', stackFrameMatrix(inverseStackFrame(frame)));
    outer.appendChild(holder);
    objectLayer.appendChild(outer);
    let bounds = null;
    try { bounds = outer.getBBox(); } catch { /* Source is not renderable yet. */ }
    outer.remove();
    return bounds && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key])) ? bounds : null;
  }

  function definitionMatrix(definition) {
    const frame = stackFrameFor(canvas.getStackState?.(), definition.stackId);
    Object.assign(definition, linkedCopyInFrame(definition, frame));
    const center = boundsCenter(sourceBounds(definition.sourceIds, frame));
    return center ? linkedCopyMatrix(definition, transformStackPoint(center, frame)) : null;
  }

  function linkedPositionAnnotations() {
    return (snapshot().dimensionAnnotations || []).filter((annotation) => (
      annotation.dimensionMode === 'driving'
      && annotation.externalDrivingTarget?.type === 'linked-position'
    ));
  }

  function hasLinkedPositionDimension(copyId) {
    return linkedPositionAnnotations().some((annotation) => (
      annotation.externalDrivingTarget.copyId === copyId
    ));
  }

  function hasLinkedPositionConstraint(copyId) {
    return positionConstraints.some((constraint) => constraint.externalDrivingTarget.copyId === copyId);
  }

  function updateButtons() {
    [['symmetric', symmetricButton], ['duplicate', duplicateButton]].forEach(([type, button]) => {
      const active = activeType === type && mode !== 'idle';
      button?.classList.toggle('active', active);
      button?.setAttribute('aria-pressed', String(active));
    });
  }

  function clearSourceHighlights() {
    svg.querySelectorAll('.linked-copy-source-selected,.symmetric-source-selected').forEach((node) => node.classList.remove('linked-copy-source-selected', 'symmetric-source-selected'));
  }
  function syncSourceHighlights() {
    clearSourceHighlights();
    pendingSourceIds.forEach((id) => recordNode(id)?.classList.add('linked-copy-source-selected'));
    (canvas.getDerivedPresentationNodes?.([...pendingSourceIds]) || [])
      .forEach((node) => node.classList.add('linked-copy-source-selected'));
  }
  function dependentIds(entities, sourceIds) {
    const selected = new Set(sourceIds);
    return [...entities.values()].filter((entity) => {
      if (selected.has(entity.id)) return false;
      if (entity.type === 'notch') return selected.has(entity.host?.recordId);
      return seamDependsOnSelectedSources(entity, selected);
    }).map(({ id }) => id);
  }
  function regionNodes(sourceIds) {
    return directClosedRegionNodesForSourceIds(objectLayer, sourceIds);
  }

  function templateFor(definition, entities) {
    const template = createSvg('g', { class: 'linked-copy-template' });
    const derivedPresentationNodes = canvas.getDerivedPresentationNodes?.(definition.sourceIds) || [];
    const explicitDependentIds = definition.sourceIds.filter((id) => {
      const entity = entities.get(id);
      return entity?.type === 'notch' || entity?.composite?.kind === 'finish-size-offset';
    });
    const sourceIds = definition.sourceIds.filter((id) => !explicitDependentIds.includes(id));
    const dependentSourceIds = uniqueIds([
      ...explicitDependentIds,
      ...dependentIds(entities, definition.sourceIds),
    ]);
    const derived = splitDerivedPresentationNodes(derivedPresentationNodes);
    derived.before.forEach((node) => {
      template.appendChild(sanitizeClone(node.cloneNode(true), definition.type));
    });
    sourceIds.forEach((id) => {
      const copy = sourcePresentationClone(definition, entities, id);
      if (!copy) return;
      template.appendChild(copy);
    });
    derived.after.forEach((node) => {
      template.appendChild(sanitizeClone(node.cloneNode(true), definition.type));
    });
    (canvas.getSeamLinePresentationNodes?.(definition.sourceIds) || [])
      .filter((node) => !derivedPresentationNodes.some((presentation) => presentation.contains(node)))
      .forEach((node) => template.appendChild(sanitizeClone(node.cloneNode(true), definition.type)));
    dependentSourceIds.forEach((id) => {
      if (constructionHiddenInValueOnly(entities.get(id), canvas.getDimensionTextMode?.())) return;
      const source = recordNode(id);
      if (!source) return;
      const sourceClone = source.cloneNode(true);
      if (entities.get(id)?.type === 'notch') prepareNotchDerivativePresentationClone(sourceClone);
      const copy = sanitizeClone(sourceClone, definition.type);
      copy.setAttribute('data-linked-copy-source-id', id);
      template.appendChild(copy);
    });
    regionNodes(definition.sourceIds).forEach((node) => template.insertBefore(sanitizeClone(node.cloneNode(true), definition.type), template.firstChild));
    return template;
  }

  function sourcePresentationClone(definition, entities, sourceId) {
    if (constructionHiddenInValueOnly(entities.get(sourceId), canvas.getDimensionTextMode?.())) return null;
    const source = recordNode(sourceId);
    if (!source) return null;
    const sourceClone = source.cloneNode(true);
    if (source.classList.contains('table-record')) replaceTableCellForeignObjects(source, sourceClone);
    if (entities.get(sourceId)?.type === 'notch') prepareNotchDerivativePresentationClone(sourceClone);
    let copy = sanitizeClone(sourceClone, definition.type);
    if (definition.type === 'symmetric' && entities.get(sourceId)?.type === 'text') copy = keepTextReadable(copy);
    copy.setAttribute('data-linked-copy-source-id', sourceId);
    return copy;
  }

  function drivingHandlesFor(definition, entities) {
    const container = createSvg('g', { class: 'linked-copy-driving-handle-container' });
    dimensionIds(definition, entities).forEach((sourceId) => {
      const featureSet = canvas.getDimensionFeatureSet?.(sourceId, { rendered: true });
      const points = (featureSet?.features || []).filter(({ kind, point, index }) => (
        kind === 'point'
        && Number.isInteger(index)
        && Array.isArray(point)
        && point.length >= 2
        && point.every(Number.isFinite)
      ));
      if (!points.length) return;
      const handles = createSvg('g', {
        class: 'linked-copy-driving-handles',
        'data-linked-copy-source-id': sourceId,
      });
      points.forEach(({ index, point }) => handles.appendChild(createSvg('circle', {
        class: 'point-handle linked-copy-driving-handle',
        'data-handle-index': index,
        cx: point[0],
        cy: point[1],
        r: 6 / Math.max(.000001, Number(canvas.getScale?.()) || 1),
      })));
      container.appendChild(handles);
    });
    return container;
  }

  function renderDefinition(definition, entities) {
    if (canvas.isStackEnabled?.(definition?.stackId) === false) return;
    const matrix = definitionMatrix(definition);
    const template = matrix && templateFor(definition, entities);
    if (!template?.childNodes.length) return;
    objectLayer.appendChild(template);
    let bounds = null;
    try { bounds = template.getBBox(); } catch { /* Source is not renderable yet. */ }
    template.remove();
    if (!bounds) return;
    const stackId = definition.stackId;
    const visibility = linkedCopyVisibilityState(definition, canvas.evaluateNumericExpression);
    const visible = visibility.value;
    definition.visibilityError = visibility.error;
    const drivingDimensionActive = canvas.getSmartDimensionMode?.() === 'driving';
    const stackActive = !canvas.getActiveStackId?.() || canvas.isStackActive?.(stackId) !== false;
    const group = createSvg('g', {
      class: `canvas-record linked-copy-group ${definition.type === 'symmetric' ? 'symmetric-mirror-group' : 'duplicate-group'}${(selectedCopyId === definition.id || windowSelectedCopyIds.has(definition.id)) && !drivingDimensionActive ? ' selected' : ''}${drivingDimensionActive ? ' linked-copy-driving-dimension' : ''}${canvas.isStackVisible?.(stackId) === false ? ' stack-hidden' : ''}${stackActive ? '' : ' stack-inactive'}${visible ? '' : ' object-visibility-hidden'}`,
      'data-record-id': definition.id,
      'data-linked-copy-id': definition.id,
      'data-linked-copy-type': definition.type,
      'data-stack-id': stackId,
      'data-object-visible': String(visible),
      'data-paint-derived': 'true',
      'data-paint-order-key': linkedCopyPaintKey(definition.id),
      ...(Number.isFinite(definition.zIndex) ? { 'data-paint-z-index': definition.zIndex } : {}),
      'aria-label': definition.type === 'symmetric' ? 'Symmetric group' : 'Duplicate group',
      transform: `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`,
    });
    const hitPadding = 8 / Math.max(.000001, Number(canvas.getScale?.()) || 1);
    const outlineHit = linkedCopyUsesOutlineHit(definition, entities);
    group.appendChild(createSvg('rect', {
      class: `linked-copy-hit${outlineHit ? ' linked-copy-table-hit' : ''}`,
      x: bounds.x - hitPadding,
      y: bounds.y - hitPadding,
      width: Math.max(.001, bounds.width) + 2 * hitPadding,
      height: Math.max(.001, bounds.height) + 2 * hitPadding,
      ...(outlineHit ? { 'stroke-width': 2 * hitPadding } : {}),
    }));
    group.appendChild(template);
    group.appendChild(drivingHandlesFor(definition, entities));
    objectLayer.appendChild(group);
  }

  function renderNow() {
    renderFrame = null;
    // Nested copies belong to their Array's retained presentation. Only replace
    // this module's direct groups; its consumers update in the following stage.
    const changedIds = new Set(definitions.map(({ id }) => id));
    objectLayer.querySelectorAll(':scope > .linked-copy-group').forEach((node) => {
      changedIds.add(node.dataset.linkedCopyId);
      node.remove();
    });
    const entities = entityMap();
    definitions
      .filter((definition) => canvas.isStackEnabled?.(definition?.stackId) !== false)
      .forEach((definition) => renderDefinition(definition, entities));
    syncSourceHighlights();
    canvas.syncGeometryStacking?.();
    return changedIds;
  }
  function render() {
    if (canvas.requestDrawingUpdate) { canvas.requestDrawingUpdate(); return; }
    if (renderFrame !== null) cancelAnimationFrame(renderFrame);
    renderFrame = requestAnimationFrame(renderNow);
  }

  function stop() {
    mode = 'idle'; activeType = null; firstPoint = null; symmetryMatrix = null;
    pendingSourceIds.clear();
    clearSourceHighlights();
    canvas.clearPreview();
    canvas.clearObjectSnapCandidate?.();
    canvas.setFeatureCommandDelegate(null);
    updateButtons();
  }
  function activate(type) {
    if (mode !== 'idle') stop();
    mode = type === 'symmetric' ? 'drawing-axis' : 'selecting-sources';
    activeType = type; selectedCopyId = null; pendingSourceIds.clear();
    canvas.clearSelection();
    window.dispatchEvent(new CustomEvent('paramagic:tool-activated', { detail: { source: type } }));
    canvas.setFeatureCommandDelegate(delegate);
    updateButtons(); render();
    return true;
  }
  function cancel() {
    if (mode === 'idle') return false;
    stop(); render(); return true;
  }
  function toggleSources(event) {
    const entities = entityMap();
    const ids = selectionIdsFromTarget(event.paramagicSelectionTarget || event.target).filter((id) => accepts(entities.get(id), activeType));
    if (!ids.length) return false;
    event.preventDefault(); event.stopPropagation();
    const remove = ids.every((id) => pendingSourceIds.has(id));
    ids.forEach((id) => remove ? pendingSourceIds.delete(id) : pendingSourceIds.add(id));
    syncSourceHighlights();
    return true;
  }
  function finishSelection() {
    if (mode !== 'selecting-sources' || !pendingSourceIds.size) return false;
    const center = boundsCenter(sourceBounds([...pendingSourceIds]));
    if (!center) return false;
    let definition;
    if (activeType === 'symmetric') {
      if (!symmetryMatrix) return false;
      definition = linkedCopyDefinitionFromMatrix({ id: createUuid(), type: 'symmetric', sourceIds: [...pendingSourceIds], sourceAnchor: center, matrix: symmetryMatrix, stackId: canvas.getActiveStackId?.() });
    } else {
      const scale = Math.max(.000001, Number(canvas.getScale?.()) || 1);
      definition = normalizeLinkedCopyDefinition({ id: createUuid(), type: 'duplicate', sourceIds: [...pendingSourceIds], anchor: [center[0] + 30 / scale, center[1] + 30 / scale], linear: { a: 1, b: 0, c: 0, d: 1 }, stackId: canvas.getActiveStackId?.() });
    }
    definition.coordinateFrame = { ...stackFrameFor(canvas.getStackState?.(), definition.stackId) };
    definition.zIndex = canvas.nextObjectZIndex?.(definition.stackId) ?? definition.zIndex;
    canvas.requestHistoryCheckpoint?.(`add-${activeType}`);
    definitions.push(definition); selectedCopyId = definition.id;
    stop(); canvas.clearSelection(); renderNow();
    canvas.notifyObjectChange({ history: 'commit' });
    return true;
  }

  function removeDefinition(id, { history = true } = {}) {
    const index = definitions.findIndex((definition) => definition.id === id);
    if (index < 0) return false;
    if (history) canvas.requestHistoryCheckpoint?.('delete-linked-copy');
    const dimensionIds = linkedPositionAnnotations()
      .filter((annotation) => annotation.externalDrivingTarget.copyId === id)
      .map(({ id: dimensionId }) => dimensionId);
    if (dimensionIds.length) canvas.deleteRecords?.(dimensionIds, { checkpoint: false, notify: false });
    for (let constraintIndex = positionConstraints.length - 1; constraintIndex >= 0; constraintIndex -= 1) {
      if (positionConstraints[constraintIndex].externalDrivingTarget.copyId === id) positionConstraints.splice(constraintIndex, 1);
    }
    definitions.splice(index, 1);
    windowSelectedCopyIds.delete(id);
    if (selectedCopyId === id) selectedCopyId = null;
    renderNow(); canvas.notifyObjectChange({ history: history ? 'commit' : 'none' });
    return true;
  }
  function setDefinitionStack(id, stackId) {
    const definition = definitions.find((item) => item.id === id);
    if (!definition || !canvas.getStackState?.().stacks.some((stack) => stack.id === stackId)) return false;
    canvas.requestHistoryCheckpoint?.('move-linked-copy-to-stack');
    definition.stackId = stackId; renderNow(); canvas.notifyObjectChange({ history: 'commit' });
    return true;
  }
  function reassignStack(from, to, { history = false } = {}) {
    const affected = definitions.filter(({ stackId }) => stackId === from);
    if (!affected.length) return false;
    if (history) canvas.requestHistoryCheckpoint?.('move-linked-copies-to-stack');
    affected.forEach((definition) => { definition.stackId = to; });
    renderNow(); if (history) canvas.notifyObjectChange({ history: 'commit' });
    return true;
  }

  function removeReferences({ stackId = null, recordIds = [] } = {}) {
    const removedRecordIds = new Set(recordIds.map(String));
    const removeStack = stackId !== null && stackId !== undefined;
    const removedDefinitions = definitions.filter((definition) => (
      (removeStack && definition.stackId === stackId)
      || definition.sourceIds.some((id) => removedRecordIds.has(String(id)))
    ));
    if (!removedDefinitions.length && !positionConstraints.some((constraint) => (
      (removeStack && constraint.stackId === stackId)
      || (removeStack && constraint.participantStackIds?.includes(stackId))
      || (constraint.featureRefs || []).some(({ recordId }) => removedRecordIds.has(String(recordId)))
    ))) return false;
    const removedDefinitionIds = new Set(removedDefinitions.map(({ id }) => id));
    const dimensionIds = linkedPositionAnnotations()
      .filter((annotation) => removedDefinitionIds.has(annotation.externalDrivingTarget?.copyId))
      .map(({ id }) => id);
    if (dimensionIds.length) canvas.deleteRecords?.(dimensionIds, { checkpoint: false, notify: false });
    for (let index = positionConstraints.length - 1; index >= 0; index -= 1) {
      const constraint = positionConstraints[index];
      if (
        removedDefinitionIds.has(constraint.externalDrivingTarget?.copyId)
        || (removeStack && constraint.stackId === stackId)
        || (removeStack && constraint.participantStackIds?.includes(stackId))
        || (constraint.featureRefs || []).some(({ recordId }) => removedRecordIds.has(String(recordId)))
      ) positionConstraints.splice(index, 1);
    }
    for (let index = definitions.length - 1; index >= 0; index -= 1) {
      if (removedDefinitionIds.has(definitions[index].id)) definitions.splice(index, 1);
    }
    removedDefinitionIds.forEach((id) => windowSelectedCopyIds.delete(id));
    if (removedDefinitionIds.has(selectedCopyId)) selectedCopyId = null;
    renderNow();
    return true;
  }

  function removeStackReferences(stackId, recordIds = []) {
    return removeReferences({ stackId, recordIds });
  }

  function removeRecordReferences(recordIds = []) {
    return removeReferences({ recordIds });
  }

  function derivedRecordId(definition, sourceId) {
    return definition.type === 'symmetric' ? symmetricDerivedRecordId(definition.id, sourceId) : duplicateDerivedRecordId(definition.id, sourceId);
  }
  function parseLinkedId(value) {
    const duplicate = parseLegacyDuplicateDerivedRecordId(value);
    if (duplicate) return duplicate;
    const symmetric = parseLegacySymmetricDerivedRecordId(value);
    if (symmetric) return { copyId: symmetric.centerlineId, sourceId: symmetric.sourceId };
    for (const definition of definitions) {
      for (const sourceId of definition.sourceIds || []) {
        if (derivedRecordId(definition, sourceId) === value) return { copyId: definition.id, sourceId };
      }
    }
    return null;
  }
  function dimensionIds(definition, entities) { return uniqueIds([...definition.sourceIds, ...dependentIds(entities, definition.sourceIds)]); }
  function featureSet(definition, sourceId, entities, matrix, node) {
    if (!dimensionIds(definition, entities).includes(sourceId)) return null;
    const source = canvas.getDimensionFeatureSet?.(sourceId, { rendered: true });
    if (!source) return null;
    const transformed = transformDimensionFeatureSet(source, (point) => applyMatrix(matrix, point), derivedRecordId(definition, sourceId), node);
    transformed.features = (transformed.features || []).map((feature) => ({
      ...feature,
      dimensionReference: linkedCopyDimensionReference(definition.id, sourceId),
      linkedCopyId: definition.id,
      linkedCopyType: definition.type,
      linkedSourceId: sourceId,
      linkedPositionBlocked: hasLinkedPositionDimension(definition.id) || hasLinkedPositionConstraint(definition.id),
    }));
    return transformed;
  }
  const derivedDimensionProvider = {
    featureFromEvent({ target, world, mode = 'driven' }) {
      const group = target?.closest?.('.linked-copy-group[data-linked-copy-id]');
      const definition = group && definitions.find(({ id }) => id === group.dataset.linkedCopyId);
      const matrix = definition && definitionMatrix(definition);
      if (!definition || !matrix) return null;
      const entities = entityMap();
      const exact = target.closest?.('[data-linked-copy-source-id]')?.dataset.linkedCopySourceId;
      const sets = (exact ? [exact] : dimensionIds(definition, entities)).map((id) => featureSet(definition, id, entities, matrix, group.querySelector?.(`[data-linked-copy-source-id="${escaped(id)}"]`) || group)).filter(Boolean);
      const feature = nearestDimensionFeature(sets, world, { pointTolerance: canvas.getWorldTolerance?.(10) || 10 });
      if (mode === 'driving' && feature?.kind !== 'point') return null;
      if (feature?.kind !== 'point') return feature;
      const handle = group.querySelector?.(`.linked-copy-driving-handles[data-linked-copy-source-id="${escaped(feature.linkedSourceId)}"] .linked-copy-driving-handle[data-handle-index="${feature.index}"]`);
      return { ...feature, node: handle || feature.node };
    },
    resolveFeature(request) {
      const selector = request?.derivedFeature;
      const parsed = selector?.provider === 'linked-copy' && selector.copyId
        ? {
          copyId: String(selector.copyId),
          sourceId: String(selector.sourceId || request.recordId),
        }
        : parseLinkedId(request?.recordId);
      const definition = parsed && definitions.find(({ id }) => id === parsed.copyId);
      const matrix = definition && definitionMatrix(definition);
      if (!definition || !matrix) return null;
      const group = objectLayer.querySelector(`.linked-copy-group[data-linked-copy-id="${escaped(definition.id)}"]`);
      const node = group?.querySelector?.(`[data-linked-copy-source-id="${escaped(parsed.sourceId)}"]`) || group;
      return resolveDimensionFeatureSet(featureSet(definition, parsed.sourceId, entityMap(), matrix, node), request);
    },
    dependsOn(recordId, changedIds) {
      const parsed = parseLinkedId(recordId);
      const definition = parsed && definitions.find(({ id }) => id === parsed.copyId);
      return Boolean(definition && changedIds && (changedIds.has(parsed.sourceId) || definition.sourceIds.some((id) => changedIds.has(id))));
    },
    isRecordVisible(recordId) {
      const parsed = parseLinkedId(recordId);
      if (!parsed) return undefined;
      const definition = definitions.find(({ id }) => id === parsed.copyId);
      if (!definition) return false;
      return canvas.isStackVisible?.(definition.stackId) !== false
        && linkedCopyVisibilityState(definition, canvas.evaluateNumericExpression).value;
    },
    isRecordShown(recordId) {
      const parsed = parseLinkedId(recordId);
      if (!parsed) return undefined;
      const definition = definitions.find(({ id }) => id === parsed.copyId);
      if (!definition) return false;
      return canvas.isStackVisible?.(definition.stackId) !== false
        && (canvas.getShowHiddenObjects?.() === true
          || linkedCopyVisibilityState(definition, canvas.evaluateNumericExpression).value);
    },
  };

  function applyLinkedPositionTarget(target, value) {
    const definition = definitions.find(({ id }) => id === target?.copyId);
    const reference = canvas.getPointFeature?.(
      target?.otherAnchor?.recordId,
      target?.otherAnchor?.index,
      {
        pointRole: target?.otherAnchor?.pointRole,
        rendered: true,
        ...(target?.otherAnchor?.derivedFeature
          ? { derivedFeature: target.otherAnchor.derivedFeature }
          : {}),
      },
    )?.point;
    const derived = definition && derivedDimensionProvider.resolveFeature({
      kind: 'point',
      recordId: target.recordId,
      index: target.pointIndex,
      derivedFeature: target.derivedFeature
        || linkedCopyDimensionReference(target.copyId, target.sourceId).derivedFeature,
    });
    if (!definition || !reference || !derived?.point) return { valid: false, changed: false };
    const anchor = linkedPositionAnchorUpdate(definition, derived.point, reference, target, value);
    if (!anchor) return { valid: false, changed: false };
    const changed = Math.hypot(anchor[0] - definition.anchor[0], anchor[1] - definition.anchor[1]) > 1e-9;
    if (changed) definition.anchor = anchor;
    return { valid: true, changed, definition };
  }

  function applyLinkedPositionDimensions() {
    const parameterMap = new Map((canvas.getParameters?.() || []).map((entry) => [entry.id, entry]));
    const appliedCopyIds = new Set();
    const changedSourceIds = new Set();
    linkedPositionAnnotations().forEach((annotation) => {
      const target = annotation.externalDrivingTarget;
      if (appliedCopyIds.has(target.copyId)) return;
      if (canvas.isStackRelationshipAvailable?.(annotation) === false) return;
      const entry = parameterMap.get(annotation.dimensionId);
      if (!entry || entry.enabled === false) return;
      const applied = applyLinkedPositionTarget(target, entry.value);
      if (!applied.valid) return;
      appliedCopyIds.add(target.copyId);
      if (applied.changed) applied.definition.sourceIds.forEach((id) => changedSourceIds.add(id));
    });
    if (changedSourceIds.size) canvas.refreshLinkedDimensions?.(changedSourceIds);
    return changedSourceIds.size > 0;
  }

  function applyLinkedPositionConstraints() {
    const changedSourceIds = new Set();
    for (let index = positionConstraints.length - 1; index >= 0; index -= 1) {
      const constraint = positionConstraints[index];
      if (canvas.isStackRelationshipAvailable?.(constraint) === false) continue;
      const applied = applyLinkedPositionTarget(constraint.externalDrivingTarget, 0);
      if (!applied.valid) {
        positionConstraints.splice(index, 1);
        continue;
      }
      if (applied.changed) applied.definition.sourceIds.forEach((id) => changedSourceIds.add(id));
    }
    if (changedSourceIds.size) canvas.refreshLinkedDimensions?.(changedSourceIds);
    return changedSourceIds.size > 0;
  }

  const constraintOperation = {
    applyConstraint({ type, features, request }) {
      const linked = features.filter((feature) => feature?.linkedCopyId);
      if (!linked.length) return undefined;
      if (
        type !== 'Coincident'
        || features.length !== 2
        || linked.length !== 1
        || features.some((feature) => feature?.kind !== 'point')
      ) return { constraint: null };
      const derived = linked[0];
      const reference = features.find((feature) => feature !== derived);
      const target = linkedCoincidentPositionTarget(derived, reference);
      if (
        !target
        || reference.linkedCopyId
        || hasLinkedPositionDimension(target.copyId)
        || hasLinkedPositionConstraint(target.copyId)
      ) return { constraint: null };
      const definition = definitions.find(({ id }) => id === target.copyId);
      const stackId = request.stackId || canvas.getActiveStackId?.() || definition?.stackId || null;
      const participantStackIds = uniqueIds([
        ...(request.participantStackIds || []),
        definition?.stackId,
        canvas.getRecordStackId?.(reference.recordId),
      ]).filter((id) => id !== stackId);
      const constraint = normalizeLinkedPositionConstraint({
        ...request,
        stackId,
        participantStackIds,
        externalDrivingTarget: target,
      });
      if (!constraint) return { constraint: null };
      canvas.requestHistoryCheckpoint?.('add-linked-copy-constraint');
      positionConstraints.push(constraint);
      const applied = applyLinkedPositionTarget(target, 0);
      if (!applied.valid) {
        positionConstraints.pop();
        return { constraint: null };
      }
      renderNow();
      return { constraint: clone(constraint) };
    },
    constraints: () => positionConstraints
      .filter((constraint) => canvas.isStackRelationshipAvailable?.(constraint) !== false)
      .map(clone),
    resolveFeature: (request) => derivedDimensionProvider.resolveFeature(request),
    dependsOn(constraint, changedRecordIds) {
      return (constraint?.featureRefs || []).some(({ recordId }) => (
        changedRecordIds.has(recordId)
        || derivedDimensionProvider.dependsOn(recordId, changedRecordIds)
      ));
    },
    isConstraintVisible(constraint) {
      const definition = definitions.find(({ id }) => id === constraint.externalDrivingTarget?.copyId);
      return linkedConstraintHelperVisible({
        definition,
        constraint,
        isStackVisible: canvas.isStackVisible,
        isStackActive: canvas.isStackActive,
        isObjectVisible: canvas.isObjectVisible,
        isDefinitionVisible: (item) => linkedCopyVisibilityState(item, canvas.evaluateNumericExpression).value,
        isRecordInActiveStack: canvas.isRecordInActiveStack,
      });
    },
    removeConstraint(id) {
      const index = positionConstraints.findIndex((constraint) => constraint.id === id);
      if (index < 0) return false;
      canvas.requestHistoryCheckpoint?.('delete-linked-copy-constraint');
      positionConstraints.splice(index, 1);
      return true;
    },
  };

  const delegate = {
    pointerDown(event) {
      if (event.button !== 0) return false;
      if (mode === 'selecting-sources') return toggleSources(event);
      if (mode !== 'drawing-axis') return false;
      event.preventDefault(); event.stopPropagation();
      const result = resolveVectorDrawingPoint({ rawPoint: canvas.screenToWorld(event.clientX, event.clientY), anchor: firstPoint, event, getNearestObjectPoint: canvas.getNearestObjectPoint });
      canvas.setObjectSnapCandidate?.(result.snap);
      if (!firstPoint) { firstPoint = result.point; return true; }
      if (Math.hypot(result.point[0] - firstPoint[0], result.point[1] - firstPoint[1]) < canvas.getWorldTolerance(4)) return true;
      symmetryMatrix = reflectionMatrix(firstPoint, result.point);
      firstPoint = null; mode = 'selecting-sources'; canvas.clearPreview(); canvas.clearObjectSnapCandidate?.();
      return true;
    },
    pointerMove(event) {
      if (mode !== 'drawing-axis' || !firstPoint) return mode === 'selecting-sources';
      const result = resolveVectorDrawingPoint({ rawPoint: canvas.screenToWorld(event.clientX, event.clientY), anchor: firstPoint, event, getNearestObjectPoint: canvas.getNearestObjectPoint });
      canvas.setObjectSnapCandidate?.(result.snap);
      canvas.setPreview({ type: 'line', start: firstPoint, end: result.point, construction: true });
      return true;
    },
    keyDown(event) {
      if (mode === 'selecting-sources' && event.key === 'Enter') { event.preventDefault(); return finishSelection(); }
      if (mode !== 'idle' && event.key === 'Escape') { event.preventDefault(); return cancel(); }
      return false;
    },
  };

  symmetricButton?.addEventListener('click', () => activate('symmetric'));
  duplicateButton?.addEventListener('click', () => activate('duplicate'));
  const selectionProvider = {
    clearSelection() {
      if (!selectedCopyId && !windowSelectedCopyIds.size) return false;
      selectedCopyId = null;
      windowSelectedCopyIds.clear();
      render();
      return true;
    },
    selectWindow({ matchesNode, additive = false } = {}) {
      const matchedIds = linkedCopyIdsFromWindow(
        objectLayer.querySelectorAll('.linked-copy-group[data-linked-copy-id]'),
        matchesNode,
      );
      const currentIds = [...windowSelectedCopyIds];
      if (selectedCopyId) currentIds.push(selectedCopyId);
      const nextIds = resolveWindowSelectionIds(currentIds, matchedIds, additive);
      selectedCopyId = null;
      windowSelectedCopyIds.clear();
      nextIds.forEach((id) => windowSelectedCopyIds.add(id));
      suppressNextOutsideClick = windowSelectedCopyIds.size > 0;
      render();
      return { recordIds: [] };
    },
    dragItems() {
      const selectedIds = new Set(windowSelectedCopyIds);
      if (selectedCopyId) selectedIds.add(selectedCopyId);
      const selectedDefinitions = definitions.filter(({ id }) => selectedIds.has(id));
      if (!selectedDefinitions.length) return [];
      const startAnchors = new Map(selectedDefinitions.map(({ id, anchor }) => [id, [...anchor]]));
      return [{
        begin: () => canvas.requestHistoryCheckpoint?.('move-linked-copy-selection'),
        move(delta) {
          moveLinkedCopyDefinitions(selectedDefinitions, startAnchors, delta);
          renderNow();
        },
      }];
    },
    selectedPaintKeys() {
      const ids = new Set(windowSelectedCopyIds);
      if (selectedCopyId) ids.add(selectedCopyId);
      return [...ids].map(linkedCopyPaintKey);
    },
    setPaintZIndices(updates = []) {
      const byKey = new Map(updates.map(({ paintKey, zIndex }) => [String(paintKey), Number(zIndex)]));
      let changed = false;
      definitions.forEach((definition) => {
        const zIndex = byKey.get(linkedCopyPaintKey(definition.id));
        if (!Number.isFinite(zIndex) || definition.zIndex === zIndex) return;
        definition.zIndex = zIndex;
        changed = true;
      });
      return changed;
    },
  };
  const selectionPropertyProvider = {
    selectionProperties(baseProperties = {}) {
      const ids = new Set(windowSelectedCopyIds);
      if (selectedCopyId) ids.add(selectedCopyId);
      return linkedCopySelectionPropertyPatch(
        definitions.filter(({ id }) => ids.has(id)),
        canvas.evaluateNumericExpression,
        baseProperties,
      );
    },
    setSelectedVisibility(patch = {}) {
      const ids = new Set(windowSelectedCopyIds);
      if (selectedCopyId) ids.add(selectedCopyId);
      const selected = definitions.filter(({ id }) => ids.has(id));
      if (!selected.length) return { success: false, error: 'No Duplicate or Symmetric object selected.' };
      const outcomes = selected.map((definition) => {
        const normalized = normalizeLinkedCopyDefinition(definition);
        const visibleManuallyEnabled = typeof patch.visible === 'boolean'
          ? patch.visible
          : normalized.visibleManuallyEnabled;
        const expression = patch.visibleExpression !== undefined
          ? String(patch.visibleExpression ?? '').trim()
          : linkedCopyVisibilityState(normalized, canvas.evaluateNumericExpression).expression;
        return {
          definition,
          visibleManuallyEnabled,
          evaluated: visibleManuallyEnabled
            ? { value: true, expression, error: null }
            : evaluateVisibleExpression(
              expression,
              (value) => canvas.evaluateNumericExpression(value, normalized),
            ),
        };
      });
      const error = outcomes.find(({ evaluated }) => evaluated.error)?.evaluated.error || null;
      if (error) {
        selected.forEach((definition) => { definition.visibilityError = error; });
        canvas.syncState?.();
        return { success: false, error };
      }
      canvas.requestHistoryCheckpoint?.('linked-copy-visibility-update');
      outcomes.forEach(({ definition, visibleManuallyEnabled, evaluated }) => {
        definition.visible = evaluated.value;
        definition.visibleManuallyEnabled = visibleManuallyEnabled;
        definition.visibleExpression = evaluated.expression;
        definition.visibilityError = null;
      });
      renderNow();
      canvas.notifyObjectChange({ history: 'commit' });
      return { success: true, error: null };
    },
  };
  window.addEventListener('pointerdown', (event) => {
    if (
      mode !== 'idle'
      || event.button !== 0
      || canvas.getSmartDimensionMode?.()
      || canvas.getFeatureCommandPurpose?.() === 'array-source-selection'
      || canvasElement.classList.contains('constraint-selection-active')
    ) return;
    const group = event.target.closest?.('.linked-copy-group[data-linked-copy-id]');
    const definition = group && definitions.find(({ id }) => id === group.dataset.linkedCopyId);
    if (!definition) return;
    if (!canvas.getActiveStackId?.() || canvas.isStackActive?.(definition.stackId) === false) return;
    const alreadySelected = selectedCopyId === definition.id || windowSelectedCopyIds.has(definition.id);
    if (!alreadySelected) {
      canvas.clearSelection();
      selectedCopyId = definition.id;
      windowSelectedCopyIds.clear();
      render();
      canvas.syncState?.();
    }
    if (!canvas.beginSelectionDrag?.(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  window.addEventListener('pointermove', (event) => {
    const drivingDimensionActive = canvas.getSmartDimensionMode?.() === 'driving';
    const groups = [...objectLayer.querySelectorAll('.linked-copy-group')];
    groups.forEach((group) => {
      group.classList.toggle('linked-copy-driving-dimension', drivingDimensionActive);
      group.classList.toggle('selected', !drivingDimensionActive && (
        selectedCopyId === group.dataset.linkedCopyId
        || windowSelectedCopyIds.has(group.dataset.linkedCopyId)
      ));
      group.classList.remove('hovered');
      group.querySelectorAll('.linked-copy-driving-handles.hovered').forEach((handles) => handles.classList.remove('hovered'));
    });
    syncLinkedCopyHandleHover(groups, event,
      canvasElement.contains(event.target) && !canvasElement.classList.contains('point-handles-disabled'));
    const hovered = event.target.closest?.('.linked-copy-group[data-linked-copy-id]');
    if (!drivingDimensionActive) {
      groups.forEach((group) => group.classList.toggle('hovered', group === hovered));
    }
    const definition = hovered && definitions.find(({ id }) => id === hovered.dataset.linkedCopyId);
    const matrix = definition && definitionMatrix(definition);
    if (!definition || !matrix) return;
    const entities = entityMap();
    const sets = dimensionIds(definition, entities).map((id) => featureSet(definition, id, entities, matrix, hovered)).filter(Boolean);
    const sourceId = nearestLinkedHoverSource(sets, canvas.screenToWorld(event.clientX, event.clientY), canvas.getWorldTolerance?.(10) || 10);
    if (!sourceId) return;
    hovered.querySelector?.(`.linked-copy-driving-handles[data-linked-copy-source-id="${escaped(sourceId)}"]`)?.classList.add('hovered');
  }, true);
  window.addEventListener('keydown', (event) => {
    if (!selectedCopyId || !['Delete', 'Backspace'].includes(event.key) || event.target.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    event.preventDefault(); event.stopImmediatePropagation(); removeDefinition(selectedCopyId);
  }, true);
  window.addEventListener('click', (event) => {
    if (mode !== 'idle' || canvas.getFeatureCommandPurpose?.() === 'array-source-selection') return;
    const action = linkedCopyOutsideClickAction({
      suppressNextOutsideClick,
      hasSelection: Boolean(selectedCopyId || windowSelectedCopyIds.size),
      insideLinkedCopy: Boolean(event.target.closest?.('.linked-copy-group')),
      preservesSelection: Boolean(event.target.closest?.(
        '[data-preserve-feature-selection],.stack-panel,.constraint-tool,[data-dimension-tool]',
      )),
    });
    suppressNextOutsideClick = action.suppressNextOutsideClick;
    if (action.clearSelection && selectionProvider.clearSelection()) canvas.syncState?.();
  }, true);

  canvas.onSelectionChange((properties = {}) => {
    if (mode !== 'selecting-sources') return;
    const entities = entityMap();
    (properties.recordIds || properties.ids || []).filter((id) => accepts(entities.get(id), activeType)).forEach((id) => pendingSourceIds.add(id));
    syncSourceHighlights();
  });
  function updateLinkedSources() {
    // Source lifetime belongs to the full drawing. The processing snapshot
    // excludes disabled Stacks and must only govern evaluation/presentation.
    const entities = new Map((canvas.getDrawingData().entities || []).map((entity) => [entity.id, entity]));
    for (let index = definitions.length - 1; index >= 0; index -= 1) {
      definitions[index].sourceIds = definitions[index].sourceIds.filter((id) => accepts(entities.get(id), definitions[index].type));
      if (definitions[index].sourceIds.length) continue;
      if (selectedCopyId === definitions[index].id) selectedCopyId = null;
      windowSelectedCopyIds.delete(definitions[index].id);
      definitions.splice(index, 1);
    }
    const activeDefinitions = new Map(definitions.map((definition) => [definition.id, definition]));
    const invalidDimensionIds = linkedPositionAnnotations().filter((annotation) => {
      const target = annotation.externalDrivingTarget;
      const definition = activeDefinitions.get(target.copyId);
      return !definition || !definition.sourceIds.includes(target.sourceId);
    }).map(({ id }) => id);
    if (invalidDimensionIds.length) {
      canvas.deleteRecords?.(invalidDimensionIds, { checkpoint: false, notify: false });
    }
    applyLinkedPositionDimensions();
    applyLinkedPositionConstraints();
  }

  if (canvas.registerDrawingUpdateStage) {
    canvas.registerDrawingUpdateStage('linked-copies', (change) => {
      if (change.objectsChanged) updateLinkedSources();
      else { applyLinkedPositionDimensions(); applyLinkedPositionConstraints(); }
      renderNow().forEach((id) => change.changedRecordIds?.add(id));
    }, 30);
  } else {
    canvas.onObjectsChange(() => { updateLinkedSources(); render(); canvas.refreshLinkedDimensions?.(); });
    canvas.onPresentationChange?.(() => { applyLinkedPositionDimensions(); applyLinkedPositionConstraints(); render(); });
  }
  canvas.onStackChange?.(render);
  canvasElement.addEventListener('pointerleave', () => objectLayer.querySelectorAll('.linked-copy-group.hovered').forEach((group) => group.classList.remove('hovered')));

  canvas.registerDrawingExtension?.('linkedCopyTools', {
    serialize: () => definitions.length ? {
      version: 4,
      copies: definitions.map(normalizeLinkedCopyDefinition),
      positionConstraints: positionConstraints.map(normalizeLinkedPositionConstraint).filter(Boolean),
    } : null,
    restore(value) {
      definitions.splice(0, definitions.length, ...(value?.copies || []).map(normalizeLinkedCopyDefinition));
      positionConstraints.splice(
        0,
        positionConstraints.length,
        ...(value?.positionConstraints || []).map(normalizeLinkedPositionConstraint).filter(Boolean),
      );
      const entities = entityMap();
      const legacy = [...entities.values()].filter(isSymmetricCenterline);
      legacy.forEach((line) => {
        const sourceIds = uniqueIds(line.composite?.sourceIds).filter((id) => isMirrorableEntity(entities.get(id)));
        const center = boundsCenter(sourceBounds(sourceIds));
        const matrix = reflectionMatrix(line.start, line.end);
        if (sourceIds.length && center && matrix) definitions.push(linkedCopyDefinitionFromMatrix({ id: line.id, type: 'symmetric', sourceIds, sourceAnchor: center, matrix, stackId: line.stackId }));
      });
      if (legacy.length) canvas.deleteRecords?.(legacy.map(({ id }) => id), { checkpoint: false, notify: false });
      selectedCopyId = null; windowSelectedCopyIds.clear(); suppressNextOutsideClick = false; stop(); applyLinkedPositionConstraints(); render();
    },
    removeStackReferences,
    removeRecordReferences,
    clear() { definitions.splice(0); positionConstraints.splice(0); selectedCopyId = null; windowSelectedCopyIds.clear(); suppressNextOutsideClick = false; stop(); objectLayer.querySelectorAll(':scope > .linked-copy-group').forEach((node) => node.remove()); },
  });
  window.addEventListener('paramagic:tool-activated', (event) => { if (event.detail?.source !== activeType && mode !== 'idle') cancel(); });

  render();
  return {
    activate: () => activate('symmetric'), activateSymmetric: () => activate('symmetric'), activateDuplicate: () => activate('duplicate'), cancel, render,
    definitions: () => definitions.map(clone),
    selectedDefinition: () => clone(definitions.find(({ id }) => id === selectedCopyId) || null),
    selectedCenterlineId: () => null,
    removeDefinition, setDefinitionStack, reassignStack, removeStackReferences, removeRecordReferences, derivedDimensionProvider, constraintOperation, selectionProvider, selectionPropertyProvider, derivativeSourceProvider,
  };
}

export const createSymmetricTool = createLinkedCopyTools;
