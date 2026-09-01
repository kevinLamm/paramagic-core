import {
  deriveSwellGeometry,
  isSwellEntity,
  normalizeSwellDefinition,
  SWELL_DEFAULT_EXPRESSIONS,
  swellBoundaryPath,
  swellBoundariesFromDerived,
  swellDefinitionForEntity,
  withSwellDefinition,
} from './SwellGeometry.js';
import { nearestDimensionFeature, resolveDimensionFeatureSet } from './DimensionSystem.js';
import { inwardTargetFromBoundary, projectPointToNotchFeature } from './NotchSystem.js';
import { bindFloatingPanelDrag } from './CanvasUIControls.js';
import { createUuid } from './IdentitySystem.js';

export const SWELL_ICON = '<path d="M4 16h4c2.5 0 2.5-8 5-8h7"/><path d="M4 20h5c3.5 0 3.5-8 7-8h4"/>';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const SUPPORTED_DRAWING_TYPES = new Set(['line', 'arc', 'polyline', 'polygon', 'circle', 'rect', 'curve']);
const SWELL_OPTION_TYPES = new Set(['line', 'polyline', 'polygon', 'rect']);
const LINE_SWELL_DEFINITION_KEYS = new Set([
  'swellEnabled',
  'swellOffsetExpression',
  'startTransitionExpression',
  'endTransitionExpression',
]);
const SWELL_EXPRESSION_KEYS = Object.freeze([
  'offsetExpression',
  'swellOffsetExpression',
  'startTransitionExpression',
  'endTransitionExpression',
]);
const SWELL_PROPERTIES_SUPPRESSING_TOOL_SELECTORS = Object.freeze([
  '[data-duplicate-tool]',
  '[data-symmetric-tool]',
  '[data-array-toggle]',
]);
const clone = (value) => JSON.parse(JSON.stringify(value));
const escapeSelector = (value) => globalThis.CSS?.escape
  ? CSS.escape(String(value))
  : String(value).replace(/["\\]/g, '\\$&');
const finitePoint = (point) => Array.isArray(point) && point.length >= 2 && point.slice(0, 2).every(Number.isFinite);
const pointDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function createSvg(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NAMESPACE, tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
  return node;
}

function arcPath(entity) {
  const radius = Math.max(1e-8, Math.abs(Number(entity.radius) || 0));
  const largeArc = entity.major ? 1 : 0;
  const sweep = entity.ccw === false ? 0 : 1;
  return `M ${entity.start[0]} ${entity.start[1]} A ${radius} ${radius} 0 ${largeArc} ${sweep} ${entity.end[0]} ${entity.end[1]}`;
}

function polylinePath(points = [], closed = false) {
  if (!points.length) return '';
  return `M ${points.map((point) => `${point[0]} ${point[1]}`).join(' L ')}${closed ? ' Z' : ''}`;
}

function pieceStart(entity) {
  if (entity.type === 'line' || entity.type === 'arc') return entity.start;
  if (entity.type === 'polyline' || entity.type === 'polygon') return entity.points?.[0] || null;
  return null;
}

function pieceEnd(entity) {
  if (entity.type === 'line' || entity.type === 'arc') return entity.end;
  if (entity.type === 'polyline' || entity.type === 'polygon') return entity.points?.at(-1) || null;
  return null;
}

function styleGeometry(node, appearance = {}, { fill = false, stroke = true } = {}) {
  const strokeColor = appearance.strokeColor || '#202020';
  const strokeThickness = Math.max(0.1, Number(appearance.strokeThickness) || 1.5);
  const strokeOpacity = Number.isFinite(Number(appearance.strokeOpacity)) ? Number(appearance.strokeOpacity) : 1;
  const fillColor = appearance.fillColor || '#ffffff';
  const fillOpacity = Number.isFinite(Number(appearance.fillOpacity)) ? Number(appearance.fillOpacity) : 1;
  node.style.setProperty('--original-stroke-width', `${strokeThickness}px`);
  node.setAttribute('stroke', stroke ? strokeColor : 'none');
  node.setAttribute('stroke-width', stroke ? strokeThickness : 0);
  node.setAttribute('stroke-opacity', stroke ? strokeOpacity : 0);
  node.setAttribute('fill', fill ? fillColor : 'none');
  node.setAttribute('fill-opacity', fill ? fillOpacity : 0);
  node.style.stroke = stroke ? strokeColor : 'none';
  node.style.strokeWidth = `${stroke ? strokeThickness : 0}px`;
  node.style.strokeOpacity = String(stroke ? strokeOpacity : 0);
  node.style.strokeLinecap = 'round';
  node.style.strokeLinejoin = 'round';
  node.style.fill = fill ? fillColor : 'none';
  node.style.fillOpacity = String(fill ? fillOpacity : 0);
}

function geometryNode(entity) {
  if (entity.type === 'line') return createSvg('line', {
    x1: entity.start[0], y1: entity.start[1], x2: entity.end[0], y2: entity.end[1],
  });
  if (entity.type === 'circle') return createSvg('circle', {
    cx: entity.center[0], cy: entity.center[1], r: entity.radius,
  });
  if (entity.type === 'arc') return createSvg('path', { d: arcPath(entity) });
  if (entity.type === 'polyline' || entity.type === 'polygon') {
    return createSvg('path', { d: polylinePath(entity.points, entity.type === 'polygon') });
  }
  return null;
}

export function swellDimensionFeatureSetForPiece(piece, node = null) {
  const { entity, id: recordId } = piece;
  const common = {
    recordId,
    entityType: entity.type,
    swellDerived: true,
    swellSourceId: piece.ownerId,
    swellSegmentIndex: piece.segmentIndex,
    swellRole: piece.role,
    node,
  };
  if (entity.type === 'line') {
    const controlPoints = [entity.start, [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2], entity.end];
    return {
      ...common,
      controlPoints,
      features: [
        { ...common, kind: 'point', index: 0, point: [...entity.start] },
        { ...common, kind: 'point', index: 2, point: [...entity.end] },
        { ...common, kind: 'segment', index: 0, start: [...entity.start], end: [...entity.end] },
      ],
    };
  }
  if (entity.type === 'circle') {
    return {
      ...common,
      controlPoints: [[...entity.center]],
      features: [{ ...common, kind: 'circle', index: 0, center: [...entity.center], radius: entity.radius }],
    };
  }
  if (entity.type === 'arc') {
    return {
      ...common,
      controlPoints: [entity.start, entity.arcPoint, entity.end].map((point) => [...point]),
      features: [
        { ...common, kind: 'point', index: 0, point: [...entity.start] },
        { ...common, kind: 'point', index: 2, point: [...entity.end] },
        {
          ...common,
          kind: 'arc',
          index: 0,
          center: [...entity.center],
          radius: entity.radius,
          start: [...entity.start],
          arcPoint: [...entity.arcPoint],
          end: [...entity.end],
          ccw: entity.ccw,
          major: entity.major,
        },
      ],
    };
  }
  if (entity.type === 'polyline' || entity.type === 'polygon') {
    const points = entity.points || [];
    const closed = entity.type === 'polygon';
    const count = closed ? points.length : points.length - 1;
    return {
      ...common,
      controlPoints: points.map((point) => [...point]),
      features: [
        ...points.map((point, index) => ({ ...common, kind: 'point', index, point: [...point] })),
        ...Array.from({ length: Math.max(0, count) }, (_, index) => ({
          ...common,
          kind: 'segment',
          index,
          start: [...points[index]],
          end: [...points[(index + 1) % points.length]],
        })),
      ],
    };
  }
  return null;
}

export function swellPieceHandlePoints(piece) {
  const entity = piece?.entity;
  if (!entity) return [];
  if (entity.type === 'line') {
    return [entity.start, [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2], entity.end]
      .map((point) => [...point]);
  }
  if (entity.type === 'arc') return [entity.start, entity.arcPoint, entity.end].map((point) => [...point]);
  if (entity.type === 'circle') {
    const [cx, cy] = entity.center;
    const radius = entity.radius;
    return [[cx, cy], [cx - radius, cy], [cx, cy - radius], [cx + radius, cy], [cx, cy + radius]];
  }
  if (entity.type === 'polyline' || entity.type === 'polygon') {
    const points = entity.points || [];
    if (points.length <= 5) return points.map((point) => [...point]);
    return [points[0], points[Math.floor(points.length / 2)], points.at(-1)].map((point) => [...point]);
  }
  return [];
}

export function swellSelectionCanFill(recordIds = [], boundaries = []) {
  const selectedIds = new Set(recordIds.filter(Boolean));
  if (!selectedIds.size) return false;
  return [...selectedIds].every((recordId) => boundaries.some((boundary) => (
    boundary.recordIds?.includes(recordId)
      && boundary.recordIds.every((boundaryRecordId) => selectedIds.has(boundaryRecordId))
  )));
}

export function isSwellPropertiesPanelSuppressed(root = globalThis.document) {
  return SWELL_PROPERTIES_SUPPRESSING_TOOL_SELECTORS.some((selector) => (
    root?.querySelector?.(selector)?.getAttribute?.('aria-pressed') === 'true'
  ));
}

function projectToSegment(point, start, end) {
  const delta = [end[0] - start[0], end[1] - start[1]];
  const lengthSquared = delta[0] ** 2 + delta[1] ** 2;
  if (lengthSquared <= 1e-12) return [...start];
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * delta[0] + (point[1] - start[1]) * delta[1]) / lengthSquared));
  return [start[0] + delta[0] * t, start[1] + delta[1] * t];
}

function projectToRound(point, feature) {
  const delta = [point[0] - feature.center[0], point[1] - feature.center[1]];
  const magnitude = Math.hypot(...delta);
  if (magnitude <= 1e-12) return [feature.center[0] + feature.radius, feature.center[1]];
  return [feature.center[0] + delta[0] * feature.radius / magnitude, feature.center[1] + delta[1] * feature.radius / magnitude];
}

function mixedValue(values, fallback = null) {
  if (!values.length) return fallback;
  return new Set(values.map((value) => JSON.stringify(value))).size === 1 ? values[0] : fallback;
}

function appearanceSelectionPatch(appearances, { canFill = false } = {}) {
  const values = (key) => appearances.map((appearance) => appearance?.[key]);
  return {
    fillColor: mixedValue(values('fillColor'), '#ffffff'),
    fillExpression: mixedValue(values('fillExpression')),
    fillOpacityExpression: mixedValue(values('fillOpacityExpression')),
    fillOpacity: mixedValue(values('fillOpacity')),
    strokeColor: mixedValue(values('strokeColor'), '#202020'),
    strokeExpression: mixedValue(values('strokeExpression')),
    strokeOpacityExpression: mixedValue(values('strokeOpacityExpression')),
    strokeOpacity: mixedValue(values('strokeOpacity')),
    strokeThickness: mixedValue(values('strokeThickness')),
    canEditFill: canFill,
    canEditStroke: appearances.length > 0,
    canEditOpacity: appearances.length > 0,
    canEditImageFill: false,
    canEditImageStroke: false,
    mixedFill: new Set(values('fillExpression')).size > 1,
    mixedFillOpacity: new Set(values('fillOpacityExpression')).size > 1,
    mixedStrokeColor: new Set(values('strokeColor')).size > 1,
    mixedStrokeExpression: new Set(values('strokeExpression')).size > 1,
    mixedStrokeOpacity: new Set(values('strokeOpacityExpression')).size > 1,
    mixedStroke: new Set(values('strokeThickness')).size > 1,
  };
}

function selectedSwellTargets(canvas, entitiesById) {
  const segmentsById = new Map((canvas.getSelectedSegments?.() || []).map((selection) => [selection.recordId, selection.index]));
  return (canvas.getSelectedRecordIds?.() || []).map((recordId) => {
    const entity = entitiesById.get(recordId);
    if (!isSwellEntity(entity)) return null;
    const segmentIndex = segmentsById.has(recordId) ? segmentsById.get(recordId) : null;
    return { recordId, entity, segmentIndex, definition: swellDefinitionForEntity(entity, segmentIndex) };
  }).filter(Boolean);
}

export function swellPropertiesPanelMarkup() {
  return `<header class="swell-panel-header"><h2>Swell</h2></header>
  <div class="swell-properties" data-swell-properties>
    <label class="property-row" for="swellOffsetBaseProperty"><span>Offset</span><input class="swell-expression-input" id="swellOffsetBaseProperty" aria-label="Offset expression" list="swellExpressionNames" type="text" autocomplete="off" spellcheck="false" /></label>
    <label class="property-row text-checkbox-row swell-toggle-property" for="swellEnabledProperty" hidden style="display:none"><span>Swell</span><input id="swellEnabledProperty" type="checkbox" /></label>
    <label class="property-row swell-line-property" for="swellOffsetProperty" hidden style="display:none"><span>Swell Offset</span><input class="swell-expression-input" id="swellOffsetProperty" aria-label="Swell offset expression" list="swellExpressionNames" type="text" autocomplete="off" spellcheck="false" /></label>
    <label class="property-row swell-line-property" for="swellStartTransitionProperty" hidden style="display:none"><span>Start Arc Length</span><input class="swell-expression-input" id="swellStartTransitionProperty" aria-label="Start arc length expression" list="swellExpressionNames" type="text" autocomplete="off" spellcheck="false" /></label>
    <label class="property-row swell-line-property" for="swellEndTransitionProperty" hidden style="display:none"><span>End Arc Length</span><input class="swell-expression-input" id="swellEndTransitionProperty" aria-label="End arc length expression" list="swellExpressionNames" type="text" autocomplete="off" spellcheck="false" /></label>
    <datalist id="swellExpressionNames"></datalist>
  </div>`;
}

export function entitySupportsSwellOption(entity) {
  return SWELL_OPTION_TYPES.has(entity?.type);
}

export function swellLineSelectionProperties(targets = []) {
  const definitions = targets
    .filter(({ entity }) => entitySupportsSwellOption(entity))
    .map(({ definition }) => definition);
  return {
    swellLineSelection: definitions.length > 0,
    swellEnabled: mixedValue(definitions.map(({ swellEnabled }) => swellEnabled)),
    swellSwellOffsetExpression: mixedValue(definitions.map(({ swellOffsetExpression }) => swellOffsetExpression)),
    swellStartTransitionExpression: mixedValue(definitions.map(({ startTransitionExpression }) => startTransitionExpression)),
    swellEndTransitionExpression: mixedValue(definitions.map(({ endTransitionExpression }) => endTransitionExpression)),
  };
}

export function swellAdvancedControlsVisible(properties) {
  return Boolean(properties?.swellLineSelection && properties.swellEnabled !== false);
}

export function setSwellPropertyRowVisible(row, visible) {
  if (!row) return;
  row.hidden = !visible;
  row.style.display = visible ? '' : 'none';
}

export function rememberSwellCreationExpressions(current = {}, patch = {}) {
  const next = {};
  SWELL_EXPRESSION_KEYS.forEach((key) => {
    next[key] = String(patch[key] ?? current[key] ?? SWELL_DEFAULT_EXPRESSIONS[key]);
  });
  return next;
}

function swellDefinitionTargetsForPatch(targets, patch) {
  const keys = Object.keys(patch);
  const lineOnly = keys.length > 0 && keys.every((key) => LINE_SWELL_DEFINITION_KEYS.has(key));
  return lineOnly ? targets.filter(({ entity }) => entitySupportsSwellOption(entity)) : targets;
}

export function swellExternalConstraintRequest(type, features = [], request = {}) {
  const derived = features.find((feature) => feature?.swellDerived);
  const other = features.find((feature) => feature !== derived);
  if (!derived || !other || other.swellDerived) return null;
  let movableRef = null;
  if (type === 'Coincident' && derived.kind === 'point' && other.kind === 'point') {
    movableRef = { kind: 'point', recordId: other.recordId, index: other.index, ...(other.pointRole ? { pointRole: other.pointRole } : {}) };
  } else if (['Point-on Line', 'Point-on Circle', 'Point-on Arc'].includes(type) && other.kind === 'point') {
    movableRef = { kind: 'point', recordId: other.recordId, index: other.index, ...(other.pointRole ? { pointRole: other.pointRole } : {}) };
  } else if (type === 'Concentric' && ['circle', 'arc'].includes(other.kind)) {
    movableRef = {
      kind: 'point',
      recordId: other.recordId,
      index: 0,
      ...(other.kind === 'arc' ? { pointRole: 'center' } : {}),
    };
  }
  if (!movableRef) return null;
  return {
    ...clone(request),
    id: String(request.id || createUuid()),
    externalTarget: {
      type: 'swell-derived',
      derivedRef: { kind: derived.kind, recordId: derived.recordId, index: derived.index },
      movableRef,
      sourceId: derived.swellSourceId,
    },
  };
}

export function swellInteractionGroup(objectLayer, ownerRecordId) {
  return [...(objectLayer?.children || [])].find((node) => (
    node.classList?.contains?.('swell-derived-group')
    && node.dataset?.swellOwnerId === ownerRecordId
  )) || null;
}

export function swellPresentationHost(objectLayer, ownerRecordId) {
  const group = swellInteractionGroup(objectLayer, ownerRecordId);
  if (!group) return null;
  const before = [...(group.children || [])].find((node) => (
    node.classList?.contains?.('swell-derived-hit')
    || node.classList?.contains?.('swell-derived-handle-group')
  )) || null;
  return { container: group, before };
}

export function swellBoundaryFeatureFromTarget(boundaries = [], target = null, world = null) {
  if (!finitePoint(world)) return null;
  const pieceId = target?.closest?.('[data-swell-piece-id]')?.dataset?.swellPieceId;
  const boundaryId = target
    ?.closest?.('.swell-derived-fill-group[data-boundary-id]')
    ?.dataset?.boundaryId;
  const boundary = boundaries.find((candidate) => (
    (boundaryId && candidate.id === boundaryId)
    || (pieceId && candidate.features.some((feature) => feature.recordId === pieceId))
  ));
  if (!boundary) return null;
  const candidates = pieceId
    ? boundary.features.filter((feature) => feature.recordId === pieceId)
    : boundary.features;
  return candidates.reduce((nearest, feature) => {
    const projection = projectPointToNotchFeature(world, feature);
    if (!projection || (nearest && nearest.distance <= projection.distance)) return nearest;
    return { ...clone(feature), pickedPoint: [...projection.point], distance: projection.distance };
  }, null);
}

export function createSwellTools({
  toolbar,
  canvas,
} = {}) {
  const button = toolbar?.querySelector?.('[data-swell-tool]') || null;
  const objectLayer = canvas?.getObjectLayer?.() || null;
  const handleLayer = canvas?.getHandleLayer?.() || null;
  const propertiesPanel = document.createElement('section');
  let active = false;
  let renderFrame = null;
  let applyingExternalConstraints = false;
  let derivedByPieceId = new Map();
  let derivedByOwnerId = new Map();
  let derivedBoundaries = [];
  let externalConstraints = [];
  let creationExpressions = rememberSwellCreationExpressions();

  propertiesPanel.className = 'floating-panel swell-panel';
  propertiesPanel.hidden = true;
  propertiesPanel.setAttribute('data-canvas-ui', 'true');
  propertiesPanel.setAttribute('data-preserve-feature-selection', 'true');
  propertiesPanel.setAttribute('aria-label', 'Swell');
  propertiesPanel.innerHTML = swellPropertiesPanelMarkup();
  document.body.appendChild(propertiesPanel);
  const panelDragController = bindFloatingPanelDrag(propertiesPanel, {
    ignoreSelector: 'button, input, select, textarea, label, .swell-properties',
  });

  function isActive() {
    return active;
  }

  function setActive(value) {
    active = Boolean(value);
    button?.classList.toggle('active', active);
    button?.setAttribute('aria-pressed', String(active));
    return active;
  }

  function toggle() {
    return setActive(!active);
  }

  button?.addEventListener('click', toggle);

  function decorateEntity(entity) {
    if (!active || !SUPPORTED_DRAWING_TYPES.has(entity?.type)) return entity;
    return withSwellDefinition(entity, {
      ...SWELL_DEFAULT_EXPRESSIONS,
      ...creationExpressions,
      swellEnabled: false,
    });
  }

  function snapshot() {
    return canvas.getProcessingDrawingData?.()
      || canvas.getDrawingData?.()
      || { entities: [], constraints: [] };
  }

  function sourceAppearance(recordId) {
    return canvas.getResolvedGeometryAppearance?.(recordId) || {
      fillColor: '#ffffff', fillOpacity: 1, strokeColor: '#202020', strokeOpacity: 1, strokeThickness: 1.5,
    };
  }

  function removeRenderedGroups() {
    objectLayer?.querySelectorAll?.(':scope > .swell-derived-group, :scope > .swell-derived-fill-group')
      .forEach((node) => node.remove());
    handleLayer?.querySelectorAll?.(':scope > .swell-derived-handle-group')
      .forEach((node) => node.remove());
  }

  function syncGroupPresentation(group, ownerId) {
    group.classList.toggle(
      'stack-inactive',
      Boolean(canvas.getActiveStackId?.()) && canvas.isRecordInActiveStack?.(ownerId) === false,
    );
    group.classList.toggle('object-visibility-hidden', canvas.isObjectVisible?.(ownerId) === false);
    group.hidden = canvas.isRecordVisible?.(ownerId) === false;
  }

  function syncDerivedSelection() {
    const selectedIds = new Set(canvas.getSelectedRecordIds?.() || []);
    const selectedSegments = new Map((canvas.getSelectedSegments?.() || []).map(({ recordId, index }) => [recordId, index]));
    objectLayer?.querySelectorAll?.(':scope > .swell-derived-group').forEach((group) => {
      const ownerId = group.dataset.swellOwnerId;
      const selected = selectedIds.has(ownerId);
      const selectedSegment = selectedSegments.get(ownerId);
      group.classList.toggle('selected', selected);
      group.querySelectorAll('[data-swell-segment-index]').forEach((node) => {
        const segmentSelected = selected && Number(node.dataset.swellSegmentIndex) === selectedSegment;
        node.classList.toggle('selected', selected && selectedSegment === undefined);
        node.classList.toggle('segment-selected', segmentSelected);
      });
    });
    objectLayer?.querySelectorAll?.(':scope > .swell-derived-fill-group').forEach((group) => {
      const ownerIds = String(group.dataset.swellOwnerIds || '').split(',').filter(Boolean);
      group.classList.toggle('selected', ownerIds.length > 0 && ownerIds.every((id) => selectedIds.has(id)));
    });
  }

  function renderOwner(result) {
    const group = createSvg('g', {
      class: 'canvas-record swell-derived-group',
      'data-record-id': result.ownerId,
      'data-swell-owner-id': result.ownerId,
      'data-stack-id': canvas.getRecordStackId?.(result.ownerId) || '',
      'data-paint-derived': 'true',
      'data-paint-after-record-id': result.ownerId,
    });
    syncGroupPresentation(group, result.ownerId);
    const appearance = sourceAppearance(result.ownerId);
    const handlePoints = [];
    const applyPieceData = (node, piece) => {
      node.dataset.swellPieceId = piece.id;
      node.dataset.swellSourceId = piece.ownerId;
      if (Number.isInteger(piece.segmentIndex)) node.dataset.swellSegmentIndex = String(piece.segmentIndex);
    };
    result.pieces.forEach((piece) => {
      const node = geometryNode(piece.entity);
      if (!node) return;
      node.classList.add('entity', 'selectable-entity', 'swell-derived-piece');
      if (piece.entity.type === 'circle' || piece.entity.type === 'polygon') node.classList.add('closed-entity');
      applyPieceData(node, piece);
      styleGeometry(node, appearance, { fill: false });
      group.appendChild(node);
      const hitNode = geometryNode(piece.entity);
      if (hitNode) {
        hitNode.classList.add('selectable-entity', 'hit-target', 'swell-derived-hit');
        applyPieceData(hitNode, piece);
        group.appendChild(hitNode);
      }
      swellPieceHandlePoints(piece).forEach((point, index) => handlePoints.push({ point, index, piece }));
      derivedByPieceId.set(piece.id, { piece, node, hitNode });
    });
    const handleGroup = createSvg('g', {
      class: 'handle-group canvas-handle-group swell-derived-handle-group',
      'data-record-id': result.ownerId,
      'data-swell-owner-id': result.ownerId,
      'data-stack-id': canvas.getRecordStackId?.(result.ownerId) || '',
    });
    syncGroupPresentation(handleGroup, result.ownerId);
    const seenHandles = new Set();
    handlePoints.forEach(({ point, index, piece }) => {
      const key = `${Math.round(point[0] * 1e7)}:${Math.round(point[1] * 1e7)}`;
      if (seenHandles.has(key)) return;
      seenHandles.add(key);
      const handle = createSvg('circle', {
        cx: point[0],
        cy: point[1],
        r: canvas.getWorldTolerance?.(6) || 6,
        class: 'point-handle swell-derived-point-handle',
        'data-swell-handle-index': index,
      });
      applyPieceData(handle, piece);
      handleGroup.appendChild(handle);
    });
    const handlePointerDown = (event) => {
      if (canvas.getSmartDimensionMode?.() || event.button !== 0) return;
      const target = event.target.closest?.('[data-swell-source-id]');
      if (!target || canvas.isRecordInActiveStack?.(target.dataset.swellSourceId) !== true) return;
      canvas.setBoundaryPropertyFeatureFromEvent?.(event);
      if (event.ctrlKey || event.metaKey) {
        event.stopPropagation();
        return;
      }
      const segmentIndex = Number(target.dataset.swellSegmentIndex);
      if (
        Number.isInteger(segmentIndex)
        && canvas.startRecordSegmentDrag?.(event, target.dataset.swellSourceId, segmentIndex)
      ) return;
      canvas.startRecordSetDrag?.(event, [target.dataset.swellSourceId], {
        preservePropertyFeature: true,
      });
    };
    const handleClick = (event) => {
      if (canvas.getSmartDimensionMode?.()) return;
      const target = event.target.closest?.('[data-swell-source-id]');
      if (!target) return;
      if (canvas.isRecordInActiveStack?.(target.dataset.swellSourceId) !== true) return;
      event.preventDefault();
      event.stopPropagation();
      if (!(event.ctrlKey || event.metaKey)) return;
      const segmentIndex = Number(target.dataset.swellSegmentIndex);
      canvas.selectRecord?.(target.dataset.swellSourceId, {
        segmentIndex: Number.isInteger(segmentIndex) ? segmentIndex : null,
        additive: true,
      });
    };
    [group, handleGroup].forEach((target) => {
      target.addEventListener('pointerdown', handlePointerDown);
      target.addEventListener('click', handleClick);
    });
    objectLayer.appendChild(group);
    (handleLayer || group).appendChild(handleGroup);
  }

  function renderClosedBoundaryFills(boundaries) {
    boundaries.forEach((boundary) => {
      const path = swellBoundaryPath(boundary.features);
      if (!path) return;
      const ownerId = boundary.appearanceSourceId || boundary.recordIds[0];
      const group = createSvg('g', {
        class: 'canvas-record swell-derived-fill-group',
        'data-paint-derived': 'true',
        'data-paint-before-record-id': ownerId,
        'data-boundary-id': boundary.id,
        'data-swell-owner-ids': boundary.recordIds.join(','),
        'data-selection-record-ids': boundary.recordIds.join(','),
        'data-stack-id': canvas.getRecordStackId?.(ownerId) || '',
      });
      syncGroupPresentation(group, ownerId);
      const node = createSvg('path', { d: path, class: 'entity closed-entity selectable-entity swell-derived-fill' });
      styleGeometry(node, sourceAppearance(ownerId), { fill: true, stroke: false });
      group.appendChild(node);
      const ownerIds = [...boundary.recordIds];
      group.addEventListener('pointerdown', (event) => {
        if (canvas.getSmartDimensionMode?.() || event.button !== 0) return;
        if (!ownerIds.every((id) => canvas.isRecordInActiveStack?.(id) === true)) return;
        canvas.setBoundaryPropertyFeatureFromEvent?.(event);
        if (canvas.startRecordSetDrag?.(event, ownerIds, { preservePropertyFeature: true })) return;
        event.preventDefault();
        event.stopPropagation();
      });
      group.addEventListener('click', (event) => {
        if (canvas.getSmartDimensionMode?.()) return;
        if (!ownerIds.every((id) => canvas.isRecordInActiveStack?.(id) === true)) return;
        event.preventDefault();
        event.stopPropagation();
        canvas.selectRecords?.(ownerIds);
      });
      objectLayer.appendChild(group);
    });
  }

  function applyExternalConstraint(constraint, { history = 'none' } = {}) {
    const derived = derivedDimensionProvider.resolveFeature(constraint.externalTarget?.derivedRef);
    const movable = constraint.externalTarget?.movableRef;
    if (!derived || !movable) return false;
    const current = constraint.type === 'Concentric'
      ? canvas.getEntityFeature?.(movable.recordId, { rendered: true })
      : canvas.getPointFeature?.(movable.recordId, movable.index, { pointRole: movable.pointRole, rendered: true });
    let target = null;
    if (constraint.type === 'Coincident' && derived.kind === 'point') target = derived.point;
    if (constraint.type === 'Point-on Line' && derived.kind === 'segment' && current?.point) {
      target = projectToSegment(current.point, derived.start, derived.end);
    }
    if (['Point-on Circle', 'Point-on Arc'].includes(constraint.type) && ['circle', 'arc'].includes(derived.kind) && current?.point) {
      target = projectToRound(current.point, derived);
    }
    if (constraint.type === 'Concentric' && ['circle', 'arc'].includes(derived.kind)) target = derived.center;
    if (!finitePoint(target)) return false;
    const currentPoint = constraint.type === 'Concentric' ? current?.center : current?.point;
    if (finitePoint(currentPoint) && pointDistance(currentPoint, target) <= 1e-7) return true;
    return canvas.setPointFeaturePosition?.(movable, target, { history })?.success === true;
  }

  function applyExternalConstraints() {
    if (applyingExternalConstraints || !externalConstraints.length) return false;
    applyingExternalConstraints = true;
    let changed = false;
    try {
      externalConstraints = externalConstraints.filter((constraint) => {
        if (canvas.isStackRelationshipAvailable?.(constraint) === false) return true;
        const valid = Boolean(derivedDimensionProvider.resolveFeature(constraint.externalTarget?.derivedRef));
        if (valid) changed = applyExternalConstraint(constraint) || changed;
        return valid;
      });
    } finally {
      applyingExternalConstraints = false;
    }
    return changed;
  }

  function renderNow() {
    renderFrame = null;
    if (!objectLayer) return;
    removeRenderedGroups();
    derivedByPieceId = new Map();
    const drawing = snapshot();
    derivedByOwnerId = deriveSwellGeometry({
      entities: drawing.entities || [],
      constraints: drawing.constraints || [],
      evaluateLength: (expression) => canvas.evaluateLengthExpression?.(expression) ?? Number(expression),
    });
    derivedBoundaries = swellBoundariesFromDerived(derivedByOwnerId);
    renderClosedBoundaryFills(derivedBoundaries);
    derivedByOwnerId.forEach(renderOwner);
    canvas.syncGeometryStacking?.();
    syncDerivedSelection();
    applyExternalConstraints();
    canvas.notifyDerivedFeatureChange?.();
  }

  function render() {
    if (renderFrame !== null) cancelAnimationFrame(renderFrame);
    renderFrame = requestAnimationFrame(renderNow);
  }

  const derivedDimensionProvider = {
    featureFromEvent({ target, world, mode = 'driven' }) {
      if (mode === 'driving') return null;
      const pieceNode = target?.closest?.('[data-swell-piece-id]');
      const entry = pieceNode && derivedByPieceId.get(pieceNode.dataset.swellPieceId);
      const featureSet = entry && swellDimensionFeatureSetForPiece(entry.piece, entry.node);
      if (!featureSet) return null;
      return nearestDimensionFeature([featureSet], world, {
        pointTolerance: canvas.getWorldTolerance?.(10) || 10,
      });
    },
    resolveFeature(request) {
      const entry = derivedByPieceId.get(request?.recordId);
      return entry ? resolveDimensionFeatureSet(swellDimensionFeatureSetForPiece(entry.piece, entry.node), request) : null;
    },
    dependsOn(recordId, changedRecordIds) {
      const entry = derivedByPieceId.get(recordId);
      return Boolean(entry && changedRecordIds?.has(entry.piece.ownerId));
    },
    isRecordVisible(recordId) {
      const entry = derivedByPieceId.get(recordId);
      return entry ? canvas.isRecordVisible?.(entry.piece.ownerId) !== false : undefined;
    },
    isRecordShown(recordId) {
      const entry = derivedByPieceId.get(recordId);
      if (!entry) return undefined;
      return canvas.isRecordVisible?.(entry.piece.ownerId) !== false
        && (canvas.getShowHiddenObjects?.() === true || canvas.isObjectVisible?.(entry.piece.ownerId) !== false);
    },
  };

  function derivedBoundaryForHost(host = {}) {
    return derivedBoundaries.find((boundary) => (
      boundary.id === host.targetId
      || boundary.recordIds.includes(host.sourceId || host.recordId)
      || boundary.features.some((feature) => (
        feature.recordId === host.recordId
        || (host.stableKey && feature.stableKey === host.stableKey)
      ))
    )) || null;
  }

  function boundaryFeatureForHost(host = {}) {
    const boundary = derivedBoundaryForHost(host);
    if (!boundary) return null;
    if (host.stableKey) {
      const exact = boundary.features.find((feature) => feature.stableKey === host.stableKey);
      if (exact) return exact;
    }
    return boundary.features.find((feature) => feature.recordId === host.recordId)
      || boundary.features.find((feature) => (
        feature.sourceId === (host.sourceId || host.recordId)
        && (!host.kind || feature.kind === host.kind)
        && (host.sourceFeatureIndex === undefined
          || Number(feature.sourceFeatureIndex) === Number(host.sourceFeatureIndex))
        && (!host.boundaryRole || feature.boundaryRole === host.boundaryRole)
      ))
      || null;
  }

  const derivedBoundaryProvider = {
    featureFromEvent({ target, world }) {
      return swellBoundaryFeatureFromTarget(derivedBoundaries, target, world);
    },
    featureForHost(host) {
      const feature = boundaryFeatureForHost(host);
      return feature ? clone(feature) : null;
    },
    boundaryForHost(host) {
      const boundary = derivedBoundaryForHost(host);
      return boundary ? clone(boundary) : null;
    },
    boundaryFeatures(host) {
      return (derivedBoundaryForHost(host)?.features || []).map(clone);
    },
    inwardTarget(host, boundaryPoint, tangent) {
      const boundary = derivedBoundaryForHost(host);
      if (!boundary) return null;
      const local = inwardTargetFromBoundary(boundaryPoint, tangent, boundary.polygon);
      if (local) return local;
      const count = boundary.polygon.length || 1;
      return boundary.polygon.reduce((sum, point) => (
        [sum[0] + point[0] / count, sum[1] + point[1] / count]
      ), [0, 0]);
    },
    isClosedHost(host) {
      return Boolean(derivedBoundaryForHost(host));
    },
    boundaries() {
      return derivedBoundaries.map(clone);
    },
  };

  const constraintOperation = {
    applyConstraint({ type, features, request }) {
      if (!features.some((feature) => feature?.swellDerived)) return undefined;
      const stackId = request.stackId || canvas.getActiveStackId?.() || null;
      const participantStackIds = [...new Set([
        ...(request.participantStackIds || []),
        ...features.map((feature) => canvas.getRecordStackId?.(
          feature?.swellDerived ? feature.swellSourceId : feature?.recordId,
        )),
      ].filter(Boolean))].filter((id) => id !== stackId);
      const constraint = swellExternalConstraintRequest(type, features, {
        ...request,
        stackId,
        participantStackIds,
      });
      if (!constraint) return { constraint: null };
      canvas.requestHistoryCheckpoint?.('add-swell-constraint');
      externalConstraints.push(constraint);
      if (!applyExternalConstraint(constraint)) {
        externalConstraints.pop();
        return { constraint: null };
      }
      return { constraint: clone(constraint) };
    },
    constraints: () => externalConstraints
      .filter((constraint) => canvas.isStackRelationshipAvailable?.(constraint) !== false)
      .map(clone),
    resolveFeature: (request) => derivedDimensionProvider.resolveFeature(request),
    dependsOn(constraint, changedRecordIds) {
      return Boolean(changedRecordIds?.has(constraint.externalTarget?.sourceId)
        || changedRecordIds?.has(constraint.externalTarget?.movableRef?.recordId));
    },
    isConstraintVisible(constraint) {
      if (canvas.isStackRelationshipAvailable?.(constraint) === false) return false;
      const sourceId = constraint.externalTarget?.sourceId;
      return canvas.isRecordVisible?.(sourceId) !== false
        && canvas.isRecordInActiveStack?.(sourceId) !== false
        && canvas.isObjectVisible?.(sourceId) !== false;
    },
    removeConstraint(id) {
      const index = externalConstraints.findIndex((constraint) => constraint.id === id);
      if (index < 0) return false;
      canvas.requestHistoryCheckpoint?.('delete-swell-constraint');
      externalConstraints.splice(index, 1);
      return true;
    },
    removeStackReferences(stackId, recordIds = []) {
      const removedRecordIds = new Set(recordIds.map(String));
      const referencesRemovedRecord = (value, visited = new Set()) => {
        if (typeof value === 'string') return removedRecordIds.has(value);
        if (!value || typeof value !== 'object' || visited.has(value)) return false;
        visited.add(value);
        return Object.values(value).some((item) => referencesRemovedRecord(item, visited));
      };
      const before = externalConstraints.length;
      externalConstraints = externalConstraints.filter((constraint) => (
        constraint.stackId !== stackId
        && !constraint.participantStackIds?.includes(stackId)
        && !referencesRemovedRecord(constraint)
      ));
      return externalConstraints.length !== before;
    },
  };

  function selectionTargets() {
    const entities = new Map((snapshot().entities || []).map((entity) => [entity.id, entity]));
    return selectedSwellTargets(canvas, entities);
  }

  function selectionProperties() {
    const targets = selectionTargets();
    if (!targets.length) return null;
    const definitions = targets.map(({ definition }) => definition);
    const appearances = targets.map(({ recordId }) => sourceAppearance(recordId));
    const lineProperties = swellLineSelectionProperties(targets);
    const targetIds = targets.map(({ recordId }) => recordId);
    const closedSelection = swellSelectionCanFill(targetIds, derivedBoundaries)
      || targets.every(({ entity }) => entity.type === 'circle' || entity.type === 'polygon' || entity.composite?.closed === true);
    return {
      ...appearanceSelectionPatch(appearances, { canFill: closedSelection }),
      supportedCount: targets.length,
      ids: targetIds,
      canEditConstruction: false,
      canEditSwell: true,
      ...lineProperties,
      swellOffsetExpression: mixedValue(definitions.map(({ offsetExpression }) => offsetExpression)),
    };
  }

  function setSelectedAppearance(patch = {}) {
    const targets = selectionTargets();
    if (!targets.length) return undefined;
    return canvas.setRecordGeometryAppearance?.(targets.map(({ recordId }) => recordId), patch)
      || { success: false, error: 'Swell appearance could not be updated.' };
  }

  function updateSelectedDefinitions(patch = {}) {
    const targets = selectionTargets();
    if (!targets.length) return { success: false, error: 'No Swell geometry selected.' };
    const applicableTargets = swellDefinitionTargetsForPatch(targets, patch);
    if (!applicableTargets.length) return { success: false, error: 'The selected Swell geometry does not support this property.' };
    const updates = applicableTargets.map(({ entity, recordId, segmentIndex, definition }) => ({
      recordId,
      composite: withSwellDefinition(entity, normalizeSwellDefinition({ ...definition, ...patch }), segmentIndex).composite,
    }));
    const result = canvas.updateObjectComposites?.(updates);
    creationExpressions = rememberSwellCreationExpressions(creationExpressions, patch);
    render();
    return result || { success: false, error: 'Swell properties could not be updated.' };
  }

  const selectionPropertyProvider = {
    selectionProperties,
    setSelectedAppearance,
  };

  const extensionProvider = {
    serialize() {
      return externalConstraints.length ? { version: 1, constraints: externalConstraints.map(clone) } : null;
    },
    restore(value) {
      externalConstraints = Array.isArray(value?.constraints) ? value.constraints.map(clone) : [];
      render();
    },
    removeStackReferences: constraintOperation.removeStackReferences,
    clear() {
      externalConstraints = [];
      removeRenderedGroups();
      derivedByPieceId.clear();
      derivedByOwnerId.clear();
      propertiesPanel.hidden = true;
    },
  };

  function mountProperties() {
    const section = propertiesPanel.querySelector('[data-swell-properties]');
    if (!section) return;
    const offsetInput = section.querySelector('#swellOffsetBaseProperty');
    const swellEnabledInput = section.querySelector('#swellEnabledProperty');
    const swellInput = section.querySelector('#swellOffsetProperty');
    const startInput = section.querySelector('#swellStartTransitionProperty');
    const endInput = section.querySelector('#swellEndTransitionProperty');
    const toggleRow = section.querySelector('.swell-toggle-property');
    const rows = [...section.querySelectorAll('.swell-line-property')];
    const expressionNames = section.querySelector('#swellExpressionNames');
    const binding = [
      [offsetInput, 'offsetExpression'],
      [swellInput, 'swellOffsetExpression'],
      [startInput, 'startTransitionExpression'],
      [endInput, 'endTransitionExpression'],
    ];
    binding.forEach(([input, key]) => {
      const commit = () => updateSelectedDefinitions({ [key]: input.value });
      input.addEventListener('change', commit);
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') input.blur(); });
      input.addEventListener('focus', () => {
        const entries = [
          ...(canvas.getDocumentVariables?.() || []),
          ...(canvas.getParameterExpressionSymbols?.(selectionTargets()[0]?.entity) || canvas.getParameters?.() || []),
        ];
        const names = [...new Set(entries.map(({ name }) => name).filter(Boolean))];
        expressionNames.replaceChildren(...names.map((name) => {
          const option = document.createElement('option');
          option.value = name;
          return option;
        }));
      });
    });
    const syncPropertiesPanel = () => {
      if (isSwellPropertiesPanelSuppressed(toolbar || document)) {
        propertiesPanel.hidden = true;
        return;
      }
      const properties = selectionProperties();
      propertiesPanel.hidden = !properties;
      if (!properties) return;
      const swellFieldsVisible = swellAdvancedControlsVisible(properties);
      setSwellPropertyRowVisible(toggleRow, properties.swellLineSelection);
      rows.forEach((row) => setSwellPropertyRowVisible(row, swellFieldsVisible));
      swellEnabledInput.checked = properties.swellEnabled === true;
      swellEnabledInput.indeterminate = properties.swellLineSelection && properties.swellEnabled === null;
      const assignments = [
        [offsetInput, properties.swellOffsetExpression],
        [swellInput, properties.swellSwellOffsetExpression],
        [startInput, properties.swellStartTransitionExpression],
        [endInput, properties.swellEndTransitionExpression],
      ];
      assignments.forEach(([input, value]) => {
        if (document.activeElement !== input) input.value = value ?? '';
        input.placeholder = value === null ? 'Mixed' : '';
      });
      requestAnimationFrame(() => panelDragController.clamp());
    };
    swellEnabledInput.addEventListener('change', () => {
      updateSelectedDefinitions({ swellEnabled: swellEnabledInput.checked });
      syncPropertiesPanel();
    });
    canvas.onSelectionChange?.(syncPropertiesPanel);
    window.addEventListener('paramagic:tool-activated', () => requestAnimationFrame(syncPropertiesPanel));
    ['pointerdown', 'click', 'dblclick', 'keydown'].forEach((name) => (
      propertiesPanel.addEventListener(name, (event) => event.stopPropagation())
    ));
  }

  canvas.registerDrawingExtension?.('swell', extensionProvider);
  canvas.registerDerivedPresentationProvider?.({
    resolveHost: (ownerRecordId) => swellPresentationHost(objectLayer, ownerRecordId),
    isInteractive(record) {
      const group = swellInteractionGroup(objectLayer, record?.id);
      return Boolean(group && !group.hidden && group.style?.display !== 'none');
    },
    targetsForRecord(record) {
      return swellInteractionGroup(objectLayer, record?.id)?.querySelectorAll?.('.selectable-entity') || [];
    },
    handlesForRecord(record) {
      return [...(handleLayer?.children || [])]
        .find((node) => (
          node.classList?.contains?.('swell-derived-handle-group')
          && node.dataset?.recordId === record?.id
        ))
        ?.querySelectorAll?.('.point-handle') || [];
    },
    nodesForSourceIds(sourceIds = []) {
      const selected = new Set(sourceIds);
      return [...(objectLayer?.children || [])].filter((node) => {
        if (node.classList?.contains?.('swell-derived-group')) {
          return selected.has(node.dataset?.swellOwnerId);
        }
        if (!node.classList?.contains?.('swell-derived-fill-group')) return false;
        const ownerIds = String(node.dataset?.swellOwnerIds || '').split(',').filter(Boolean);
        return ownerIds.length > 0 && ownerIds.every((id) => selected.has(id));
      });
    },
  });
  canvas.registerDerivedDimensionFeatureProvider?.(derivedDimensionProvider);
  canvas.registerDerivedBoundaryFeatureProvider?.(derivedBoundaryProvider);
  canvas.registerSelectionPropertyProvider?.(selectionPropertyProvider);
  canvas.onObjectsChange?.(render);
  canvas.onPresentationChange?.(render);
  canvas.onSelectionChange?.(syncDerivedSelection);
  mountProperties();
  render();

  return {
    isActive,
    setActive,
    toggle,
    decorateEntity,
    render,
    renderNow,
    derivedDimensionProvider,
    derivedBoundaryProvider,
    constraintOperation,
    selectionPropertyProvider,
    updateSelectedDefinitions,
    removeStackReferences: constraintOperation.removeStackReferences,
  };
}
