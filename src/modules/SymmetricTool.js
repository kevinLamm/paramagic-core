import { resolveVectorDrawingPoint } from './DrawingTools.js';
import { dimensionFeatureDistance, nearestDimensionFeature, resolveDimensionFeatureSet, transformDimensionFeatureSet } from './DimensionSystem.js';

export const DUPLICATE_ICON = '<rect x="4" y="4" width="11" height="11" rx="1"/><rect x="9" y="9" width="11" height="11" rx="1"/>';
export const SYMMETRIC_ICON = '<path d="M3.5 6.5l5.5 2.4v6.2l-5.5 2.4zM20.5 6.5L15 8.9v6.2l5.5 2.4z"/><path d="M12 3v3m0 2v4m0 2v3m0 2v2" stroke-width="2"/>';

const SVG_NS = 'http://www.w3.org/2000/svg';
const clone = (value) => JSON.parse(JSON.stringify(value));
const uniqueIds = (values = []) => [...new Set(values.filter(Boolean).map(String))];

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
  return {
    id: String(value.id || `linked-copy-${crypto.randomUUID()}`),
    type: value.type === 'symmetric' ? 'symmetric' : 'duplicate',
    sourceIds: uniqueIds(value.sourceIds),
    anchor: finitePoint(value.anchor),
    linear: finiteLinear(value.linear),
    stackId: String(value.stackId || 'stack-default'),
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

export function linkedCopyMatrix(definition, sourceAnchor) {
  const copy = normalizeLinkedCopyDefinition(definition);
  const [x, y] = finitePoint(sourceAnchor);
  const [targetX, targetY] = copy.anchor;
  const { a, b, c, d } = copy.linear;
  return { a, b, c, d, e: targetX - a * x - c * y, f: targetY - b * x - d * y };
}

export function linkedCopyDefinitionFromMatrix({ id, type = 'symmetric', sourceIds, sourceAnchor, matrix, stackId = 'stack-default' }) {
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
  return {
    type: 'linked-position',
    recordId: derived.recordId,
    copyId: derived.linkedCopyId,
    sourceId: derived.linkedSourceId,
    pointIndex: derived.index,
    otherAnchor: {
      type: 'point',
      recordId: reference.recordId,
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
  isRecordInActiveStack = () => undefined,
} = {}) {
  if (!definition) return false;
  const stackId = definition.stackId || 'stack-default';
  const visible = isStackVisible(stackId) !== false
    && definition.sourceIds.some((id) => isObjectVisible(id) !== false);
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

function derivedId(prefix, copyId, sourceId) {
  return `${prefix}:${encodeURIComponent(String(copyId))}:${encodeURIComponent(String(sourceId))}`;
}

function parseDerivedId(value, prefix) {
  const match = new RegExp(`^${prefix}:([^:]+):(.+)$`).exec(String(value || ''));
  if (!match) return null;
  try { return { copyId: decodeURIComponent(match[1]), sourceId: decodeURIComponent(match[2]) }; } catch { return null; }
}

export const symmetricDerivedRecordId = (copyId, sourceId) => derivedId('symmetric-derived', copyId, sourceId);
export const duplicateDerivedRecordId = (copyId, sourceId) => derivedId('duplicate-derived', copyId, sourceId);
export function parseSymmetricDerivedRecordId(value) {
  const parsed = parseDerivedId(value, 'symmetric-derived');
  return parsed ? { centerlineId: parsed.copyId, sourceId: parsed.sourceId } : null;
}
export const parseDuplicateDerivedRecordId = (value) => parseDerivedId(value, 'duplicate-derived');

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
  return Boolean(entity?.id && !isSymmetricCenterline(entity) && entity.construction !== true && !String(entity.type || '').includes('dimension'));
}
export function isDuplicableEntity(entity) {
  return Boolean(entity?.id && !isSymmetricCenterline(entity) && !isDerivedSeamEntity(entity) && !String(entity.type || '').includes('dimension'));
}

export function selectionIdsFromTarget(target) {
  if (!target?.closest) return [];
  const region = target.closest('.closed-constrained-region[data-parent-ids]');
  if (region) return String(region.dataset.parentIds || '').split(',').map((id) => id.trim()).filter(Boolean);
  const record = target.closest('.canvas-record[data-record-id]');
  return record?.dataset.recordId ? [record.dataset.recordId] : [];
}

function createSvg(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value));
  return node;
}

function sanitizeClone(node, type) {
  [node, ...node.querySelectorAll('*')].forEach((child) => {
    child.classList.remove('canvas-record', 'selected', 'hovered', 'smart-selected', 'overlap-cycle-selected', 'linked-copy-source-selected', 'symmetric-source-selected', 'stack-hidden', 'stack-inactive');
    ['id', 'data-record-id', 'aria-label', 'role', 'contenteditable'].forEach((name) => child.removeAttribute(name));
    child.style.pointerEvents = 'none';
    if ('tabIndex' in child) child.tabIndex = -1;
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
  let drag = null;
  let renderFrame = null;

  if (!objectLayer) return { activate: () => false, cancel: () => false, render: () => {}, definitions: () => [], selectedDefinition: () => null, derivedDimensionProvider: {}, constraintOperation: {} };

  const snapshot = () => canvas.getDrawingData();
  const entityMap = () => new Map((snapshot().entities || []).map((entity) => [entity.id, entity]));
  const escaped = (value) => globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/["\\]/g, '\\$&');
  const recordNode = (id) => svg.querySelector(`.canvas-record[data-record-id="${escaped(id)}"]`);
  const accepts = (entity, type) => type === 'symmetric' ? isMirrorableEntity(entity) : isDuplicableEntity(entity);

  function sourceBounds(sourceIds) {
    const holder = createSvg('g');
    sourceIds.forEach((id) => {
      const node = recordNode(id);
      if (node) holder.appendChild(sanitizeClone(node.cloneNode(true), 'duplicate'));
    });
    if (!holder.childNodes.length) return null;
    objectLayer.appendChild(holder);
    let bounds = null;
    try { bounds = holder.getBBox(); } catch { /* Source is not renderable yet. */ }
    holder.remove();
    return bounds && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key])) ? bounds : null;
  }

  function definitionMatrix(definition) {
    const center = boundsCenter(sourceBounds(definition.sourceIds));
    return center ? linkedCopyMatrix(definition, center) : null;
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
    const selected = new Set(sourceIds);
    return [...svg.querySelectorAll('.closed-constrained-region[data-parent-ids]')].filter((region) => {
      const ids = String(region.dataset.parentIds || '').split(',').map((id) => id.trim()).filter(Boolean);
      return ids.length && ids.every((id) => selected.has(id));
    });
  }

  function templateFor(definition, entities) {
    const template = createSvg('g', { class: 'linked-copy-template' });
    [...definition.sourceIds, ...dependentIds(entities, definition.sourceIds)].forEach((id) => {
      const source = recordNode(id);
      if (!source) return;
      let copy = sanitizeClone(source.cloneNode(true), definition.type);
      if (definition.type === 'symmetric' && entities.get(id)?.type === 'text') copy = keepTextReadable(copy);
      copy.setAttribute('data-linked-copy-source-id', id);
      template.appendChild(copy);
    });
    (canvas.getSeamLinePresentationNodes?.(definition.sourceIds) || []).forEach((node) => template.appendChild(sanitizeClone(node.cloneNode(true), definition.type)));
    regionNodes(definition.sourceIds).forEach((node) => template.insertBefore(sanitizeClone(node.cloneNode(true), definition.type), template.firstChild));
    return template;
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
    const matrix = definitionMatrix(definition);
    const template = matrix && templateFor(definition, entities);
    if (!template?.childNodes.length) return;
    objectLayer.appendChild(template);
    let bounds = null;
    try { bounds = template.getBBox(); } catch { /* Source is not renderable yet. */ }
    template.remove();
    if (!bounds) return;
    const stackId = definition.stackId || 'stack-default';
    const visible = definition.sourceIds.some((id) => canvas.isObjectVisible?.(id) !== false);
    const drivingDimensionActive = canvas.getSmartDimensionMode?.() === 'driving';
    const stackActive = canvas.isStackActive?.(stackId) !== false;
    const group = createSvg('g', {
      class: `canvas-record linked-copy-group ${definition.type === 'symmetric' ? 'symmetric-mirror-group' : 'duplicate-group'}${selectedCopyId === definition.id && !drivingDimensionActive ? ' selected' : ''}${drivingDimensionActive ? ' linked-copy-driving-dimension' : ''}${canvas.isStackVisible?.(stackId) === false ? ' stack-hidden' : ''}${stackActive ? '' : ' stack-inactive'}${visible ? '' : ' object-visibility-hidden'}`,
      'data-record-id': `linked-copy:${definition.id}`,
      'data-linked-copy-id': definition.id,
      'data-linked-copy-type': definition.type,
      'data-stack-id': stackId,
      'data-object-visible': String(visible),
      'data-paint-derived': 'true',
      'aria-label': definition.type === 'symmetric' ? 'Symmetric group' : 'Duplicate group',
      transform: `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`,
    });
    const hitPadding = 8 / Math.max(.000001, Number(canvas.getScale?.()) || 1);
    group.appendChild(createSvg('rect', { class: 'linked-copy-hit', x: bounds.x - hitPadding, y: bounds.y - hitPadding, width: Math.max(.001, bounds.width) + 2 * hitPadding, height: Math.max(.001, bounds.height) + 2 * hitPadding }));
    group.appendChild(template);
    group.appendChild(drivingHandlesFor(definition, entities));
    objectLayer.appendChild(group);
  }

  function renderNow() {
    renderFrame = null;
    objectLayer.querySelectorAll('.linked-copy-group').forEach((node) => node.remove());
    const entities = entityMap();
    definitions.forEach((definition) => renderDefinition(definition, entities));
    syncSourceHighlights();
    canvas.syncGeometryStacking?.();
  }
  function render() {
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
      definition = linkedCopyDefinitionFromMatrix({ id: `linked-copy-${crypto.randomUUID()}`, type: 'symmetric', sourceIds: [...pendingSourceIds], sourceAnchor: center, matrix: symmetryMatrix, stackId: canvas.getActiveStackId?.() });
    } else {
      const scale = Math.max(.000001, Number(canvas.getScale?.()) || 1);
      definition = normalizeLinkedCopyDefinition({ id: `linked-copy-${crypto.randomUUID()}`, type: 'duplicate', sourceIds: [...pendingSourceIds], anchor: [center[0] + 30 / scale, center[1] + 30 / scale], linear: { a: 1, b: 0, c: 0, d: 1 }, stackId: canvas.getActiveStackId?.() });
    }
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

  function derivedRecordId(definition, sourceId) {
    return definition.type === 'symmetric' ? symmetricDerivedRecordId(definition.id, sourceId) : duplicateDerivedRecordId(definition.id, sourceId);
  }
  function parseLinkedId(value) {
    const duplicate = parseDuplicateDerivedRecordId(value);
    if (duplicate) return duplicate;
    const symmetric = parseSymmetricDerivedRecordId(value);
    return symmetric ? { copyId: symmetric.centerlineId, sourceId: symmetric.sourceId } : null;
  }
  function dimensionIds(definition, entities) { return uniqueIds([...definition.sourceIds, ...dependentIds(entities, definition.sourceIds)]); }
  function featureSet(definition, sourceId, entities, matrix, node) {
    if (!dimensionIds(definition, entities).includes(sourceId)) return null;
    const source = canvas.getDimensionFeatureSet?.(sourceId, { rendered: true });
    if (!source) return null;
    const transformed = transformDimensionFeatureSet(source, (point) => applyMatrix(matrix, point), derivedRecordId(definition, sourceId), node);
    transformed.features = (transformed.features || []).map((feature) => ({
      ...feature,
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
      const parsed = parseLinkedId(request?.recordId);
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
      return canvas.isStackVisible?.(definition.stackId || 'stack-default') !== false
        && definition.sourceIds.some((id) => canvas.isObjectVisible?.(id) !== false);
    },
    isRecordShown(recordId) {
      const parsed = parseLinkedId(recordId);
      if (!parsed) return undefined;
      const definition = definitions.find(({ id }) => id === parsed.copyId);
      if (!definition) return false;
      return canvas.isStackVisible?.(definition.stackId || 'stack-default') !== false
        && (canvas.getShowHiddenObjects?.() === true
          || definition.sourceIds.some((id) => canvas.isObjectVisible?.(id) !== false));
    },
  };

  function constraintPointReference(feature) {
    return {
      kind: 'point',
      recordId: String(feature.recordId),
      index: Number(feature.index),
      ...(feature.pointRole ? { pointRole: feature.pointRole } : {}),
    };
  }

  function normalizePositionConstraint(value = {}) {
    const target = value.externalDrivingTarget || {};
    if (!target.copyId || !target.sourceId || !target.recordId || !target.otherAnchor?.recordId) return null;
    return {
      id: String(value.id || `linked-constraint-${crypto.randomUUID()}`),
      type: 'Coincident',
      source: 'geometric',
      featureRefs: (value.featureRefs || []).map(constraintPointReference),
      externalDrivingTarget: {
        type: 'linked-position',
        recordId: String(target.recordId),
        copyId: String(target.copyId),
        sourceId: String(target.sourceId),
        pointIndex: Number(target.pointIndex),
        otherAnchor: {
          type: 'point',
          recordId: String(target.otherAnchor.recordId),
          index: Number(target.otherAnchor.index),
          ...(target.otherAnchor.pointRole ? { pointRole: target.otherAnchor.pointRole } : {}),
        },
        axis: 'horizontal',
        axisSign: 1,
        perpendicularOffset: 0,
      },
    };
  }

  function applyLinkedPositionTarget(target, value) {
    const definition = definitions.find(({ id }) => id === target?.copyId);
    const reference = canvas.getPointFeature?.(
      target?.otherAnchor?.recordId,
      target?.otherAnchor?.index,
      { pointRole: target?.otherAnchor?.pointRole, rendered: true },
    )?.point;
    const derived = definition && derivedDimensionProvider.resolveFeature({
      kind: 'point',
      recordId: target.recordId,
      index: target.pointIndex,
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
      const applied = applyLinkedPositionTarget(positionConstraints[index].externalDrivingTarget, 0);
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
      const constraint = normalizePositionConstraint({ ...request, externalDrivingTarget: target });
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
    constraints: () => positionConstraints.map(clone),
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
  window.addEventListener('pointerdown', (event) => {
    if (
      mode !== 'idle'
      || event.button !== 0
      || canvas.getSmartDimensionMode?.()
      || canvasElement.classList.contains('constraint-selection-active')
    ) return;
    const group = event.target.closest?.('.linked-copy-group[data-linked-copy-id]');
    const definition = group && definitions.find(({ id }) => id === group.dataset.linkedCopyId);
    if (!definition) return;
    event.preventDefault(); event.stopImmediatePropagation(); canvas.clearSelection(); selectedCopyId = definition.id; render();
    drag = { pointerId: event.pointerId, copyId: definition.id, start: canvas.screenToWorld(event.clientX, event.clientY), anchor: [...definition.anchor], moved: false };
  }, true);
  window.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) {
      const drivingDimensionActive = canvas.getSmartDimensionMode?.() === 'driving';
      const groups = [...objectLayer.querySelectorAll('.linked-copy-group')];
      groups.forEach((group) => {
        group.classList.toggle('linked-copy-driving-dimension', drivingDimensionActive);
        group.classList.toggle('selected', !drivingDimensionActive && selectedCopyId === group.dataset.linkedCopyId);
        group.classList.remove('hovered');
        group.querySelectorAll('.linked-copy-driving-handles.hovered').forEach((handles) => handles.classList.remove('hovered'));
      });
      const hovered = event.target.closest?.('.linked-copy-group[data-linked-copy-id]');
      if (!drivingDimensionActive) {
        groups.forEach((group) => group.classList.toggle('hovered', group === hovered));
        return;
      }
      const definition = hovered && definitions.find(({ id }) => id === hovered.dataset.linkedCopyId);
      const matrix = definition && definitionMatrix(definition);
      if (!definition || !matrix) return;
      const entities = entityMap();
      const sets = dimensionIds(definition, entities).map((id) => featureSet(definition, id, entities, matrix, hovered)).filter(Boolean);
      const sourceId = nearestLinkedHoverSource(sets, canvas.screenToWorld(event.clientX, event.clientY), canvas.getWorldTolerance?.(10) || 10);
      if (!sourceId) return;
      hovered.querySelector?.(`.linked-copy-driving-handles[data-linked-copy-source-id="${escaped(sourceId)}"]`)?.classList.add('hovered');
      return;
    }
    const definition = definitions.find(({ id }) => id === drag.copyId);
    if (!definition) return;
    const point = canvas.screenToWorld(event.clientX, event.clientY);
    const delta = [point[0] - drag.start[0], point[1] - drag.start[1]];
    if (!drag.moved && Math.hypot(...delta) >= (canvas.getWorldTolerance?.(2) || 2)) { drag.moved = true; canvas.requestHistoryCheckpoint?.('move-linked-copy'); }
    if (drag.moved) { definition.anchor = [drag.anchor[0] + delta[0], drag.anchor[1] + delta[1]]; renderNow(); }
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  function finishDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const moved = drag.moved; drag = null;
    if (moved) canvas.notifyObjectChange({ history: 'commit' });
    event.preventDefault(); event.stopImmediatePropagation();
  }
  window.addEventListener('pointerup', finishDrag, true);
  window.addEventListener('pointercancel', finishDrag, true);
  window.addEventListener('keydown', (event) => {
    if (!selectedCopyId || !['Delete', 'Backspace'].includes(event.key) || event.target.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    event.preventDefault(); event.stopImmediatePropagation(); removeDefinition(selectedCopyId);
  }, true);
  window.addEventListener('click', (event) => {
    if (mode !== 'idle' || !selectedCopyId || event.target.closest?.('.linked-copy-group,[data-preserve-feature-selection],.stack-panel,.constraint-tool,[data-dimension-tool]')) return;
    selectedCopyId = null; render();
  }, true);

  canvas.onSelectionChange((properties = {}) => {
    if (mode !== 'selecting-sources') return;
    const entities = entityMap();
    (properties.recordIds || properties.ids || []).filter((id) => accepts(entities.get(id), activeType)).forEach((id) => pendingSourceIds.add(id));
    syncSourceHighlights();
  });
  canvas.onObjectsChange(() => {
    const entities = entityMap();
    for (let index = definitions.length - 1; index >= 0; index -= 1) {
      definitions[index].sourceIds = definitions[index].sourceIds.filter((id) => accepts(entities.get(id), definitions[index].type));
      if (definitions[index].sourceIds.length) continue;
      if (selectedCopyId === definitions[index].id) selectedCopyId = null;
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
    render(); canvas.refreshLinkedDimensions?.();
  });
  canvas.onPresentationChange?.(() => {
    applyLinkedPositionDimensions();
    applyLinkedPositionConstraints();
    render();
  });
  canvas.onStackChange?.(render);
  canvasElement.addEventListener('pointerleave', () => objectLayer.querySelectorAll('.linked-copy-group.hovered').forEach((group) => group.classList.remove('hovered')));

  canvas.registerDrawingExtension?.('linkedCopyTools', {
    serialize: () => definitions.length ? {
      version: 2,
      copies: definitions.map(normalizeLinkedCopyDefinition),
      positionConstraints: positionConstraints.map(clone),
    } : null,
    restore(value) {
      definitions.splice(0, definitions.length, ...(value?.copies || []).map(normalizeLinkedCopyDefinition));
      positionConstraints.splice(
        0,
        positionConstraints.length,
        ...(value?.positionConstraints || []).map(normalizePositionConstraint).filter(Boolean),
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
      selectedCopyId = null; stop(); applyLinkedPositionConstraints(); render();
    },
    clear() { definitions.splice(0); positionConstraints.splice(0); selectedCopyId = null; stop(); objectLayer.querySelectorAll('.linked-copy-group').forEach((node) => node.remove()); },
  });
  window.addEventListener('paramagic:tool-activated', (event) => { if (event.detail?.source !== activeType && mode !== 'idle') cancel(); });

  render();
  return {
    activate: () => activate('symmetric'), activateSymmetric: () => activate('symmetric'), activateDuplicate: () => activate('duplicate'), cancel, render,
    definitions: () => definitions.map(clone),
    selectedDefinition: () => clone(definitions.find(({ id }) => id === selectedCopyId) || null),
    selectedCenterlineId: () => null,
    removeDefinition, setDefinitionStack, reassignStack, derivedDimensionProvider, constraintOperation,
  };
}

export const createSymmetricTool = createLinkedCopyTools;
