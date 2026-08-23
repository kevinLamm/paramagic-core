import {
  createDimensionLinkManager,
  createDimensionRecord,
  createDrivenDimensionExportPersistence,
  dimensionAnchorRecordIds,
  dimensionHandles,
  dimensionHiddenInTextMode,
  dimensionMode,
  dimensionParentStates,
  isDimensionEntity,
  moveDimensionHandle,
  moveDimensionLine,
  updateDimensionNode,
} from './DimensionSystem.js';
import { formatUnitlessValue, formatUnitValue } from './solver/Units.js';
import { mergeDrawingData, mergeDrawingDataWithMap, normalizeDrawingData } from './DrawingIO.js';
import {
  closedGeometryTopologyEntities,
  findClosedGeometryCycles,
  resolveClosedBoundaries,
  resolveClosedBoundariesForRecordIds,
} from './BoundaryTopology.js';
import { applyAutoConstraints, detectAutoConstraintsForEntities } from './ConstraintSystem.js';
import {
  createImageFillSystem,
  imageFillMetricsAppearancePatch,
  isImageFillReference,
  createImageManipulation,
  imageAppearance,
  isImageEntity,
  normalizeImageEntity,
} from './ImageSystem.js';
import { createGeometryAppearanceSystem } from './GeometryAppearanceSystem.js';
import { createImageStrokeSystem, imageStrokeMetricsAppearancePatch } from './ImageStrokeSystem.js';
import { addEditableLineChain, drawingGeometryHitTargetClass } from './DrawingTools.js';
import { createFilletSystem } from './FilletSystem.js';
import { createNotchSystem } from './NotchSystem.js';
import { isNotchEntity, projectPointToNotchFeature, createNotchBoundaryResolver } from './NotchSystem.js';
import { createOverlapSelectionCycler, clampCanvasZoom } from './CanvasViewport.js';
import {
  CANVAS_ORIGIN_RECORD_ID,
  canvasOriginPointFeature,
} from './CanvasOrigin.js';
import { createTextEntity, createTextSystem, isTextEntity, rememberTextDefaults } from './TextTools.js';
import { createTableSystem, normalizeTableEntity, tableCornerPoints, tableCornerIndexFromSolverIndex, tableSolverCornerIndex } from './TableTools.js';
import { deleteCurveControlPoint, insertCurveControlPoint } from './DrawingTools.js';
import { createSeamLineSystem } from './SeamLineSystem.js';
import { isSubtractableEntity, createSubtractSystem } from './SubtractSystem.js';
import { createStackSystem } from './StackSystem.js';
import { createObjectVisibilitySystem } from './ObjectVisibility.js';
import { createClassSystem, isClassGeometryEntity } from './ClassSystem.js';
import { ARC_MIDPOINT_ROLE, arcSweepFromAngles } from './ArcGeometry.js';
import {
  evaluateFilletedGeometry,
  filletTopologyConstraints,
  isFilletEntity,
} from './FilletSystem.js';

export function createInfiniteCanvas({ canvas, grid, svg, status, reset, entities, solver }) {
  const defaultCamera = () => ({ x: canvas.clientWidth / 2, y: canvas.clientHeight / 2, scale: 1 });
  let camera = defaultCamera();
  let panStart = null;
  let windowSelect = null;
  let suppressNextCanvasClick = false;
  let hoveredId = null;
  let hoveredRegion = null;
  let selectedSegment = null;
  const selectedSegments = new Map();
  let handleDrag = null;
  let dimensionLineDrag = null;
  let dimensionEdit = null;
  let shapeDrag = null;
  let suppressRecordClick = false;
  let overlapSelectionCycler = null;
  let drawingMode = false;
  let drawingHint = null;
  let drawingDelegate = null;
  let featureCommandDelegate = null;
  let constraintOverlaySystem = null;
  let previewNode = null;
  let dimensionPreviewRecord = null;
  let smartDimensionDelegate = null;
  let solveFrame = null;
  let dimensionTextMode = 'named-value';
  let objectSnapEnabled = true;
  let autoConstrainEnabled = true;
  let objectSnapCandidate = null;
  const pendingSolveRecords = new Map();
  const selectedIds = new Set();
  const records = [];
  const objectChangeListeners = new Set();
  const presentationChangeListeners = new Set();
  const selectionChangeListeners = new Set();
  const drawingExtensionProviders = new Map();
  const derivedDimensionFeatureProviders = new Set();
  const subtractOperandProviders = new Set();
  const selectionPropertyProviders = new Set();
  let loadedDrawingExtensions = {};
  let lastSelectionFingerprint = '';
  const ns = 'http://www.w3.org/2000/svg';
  const g = document.createElementNS(ns, 'g');
  const axisLayer = document.createElementNS(ns, 'g');
  const objectLayer = document.createElementNS(ns, 'g');
  const hoverLayer = document.createElementNS(ns, 'g');
  const overlapCycleLayer = document.createElementNS(ns, 'g');
  const handleLayer = document.createElementNS(ns, 'g');
  const interactionLayer = document.createElementNS(ns, 'g');
  const previewLayer = document.createElementNS(ns, 'g');
  const imageFillDefs = document.createElementNS(ns, 'defs');
  const closedRegionNodes = new Set();
  const resolvedBoundaryVisualNodes = new Set();
  let subtractSystem = null;
  let seamLineSystem = null;
  let objectVisibilitySystem = null;
  const selectionBox = document.createElement('div');
  const dimensionEditPanel = document.createElement('div');
  const stackSystem = createStackSystem({
    records,
    selectedIds,
    canvasElement: canvas,
    onRecordDisabled(record) {
      selectedSegments.delete(record.id);
      if (selectedSegment?.recordId === record.id) selectedSegment = null;
      if (hoveredId === record.id) hoveredId = null;
    },
    onChange: ({ history = 'coalesce' } = {}) => {
      syncStackPresentation();
      syncGeometryStacking();
      seamLineSystem?.refresh();
      constraintOverlaySystem?.render?.();
      syncState();
      objectChangeListeners.forEach((listener) => listener({ count: records.length, history }));
    },
  });
  const classSystem = createClassSystem({
    records,
    selectedIds,
    persistRecord(record, entity) {
      if (record.recordType === 'geometry' || record.recordType === 'text') return solver.updateEntity(entity);
      if (record.recordType === 'fillet') solver.setDerivedEntity(entity);
      return entity;
    },
    onChange: ({ history = 'coalesce', recordIds = [] } = {}) => {
      recordIds.forEach((recordId) => {
        const record = records.find((candidate) => candidate.id === recordId);
        if (!record) return;
        if (record.recordType === 'text') textTools.updateRecord(record);
        if (record.recordType === 'geometry') {
          syncGeometryClasses(record);
          geometryAppearanceSystem.apply(record);
          syncGeometryPresentation(record);
        }
        if (record.recordType === 'fillet') {
          filletSystem.updateRecord(record);
          syncGeometryPresentation(record);
        }
      });
      notifyObjectChange({ history });
    },
  });

  selectionBox.className = 'selection-window';
  dimensionEditPanel.className = 'dimension-edit-panel';
  dimensionEditPanel.hidden = true;
  dimensionEditPanel.innerHTML = `
    <label class="dimension-edit-label">
      <span>Dimension</span>
      <input class="dimension-edit-input" list="dimensionEditParameterNames" autocomplete="off" spellcheck="false" />
    </label>
    <datalist id="dimensionEditParameterNames"></datalist>
    <p class="dimension-edit-error" role="alert" aria-live="polite"></p>
  `;
  canvas.append(selectionBox, dimensionEditPanel);
  hoverLayer.setAttribute('class', 'canvas-hover-layer');
  overlapCycleLayer.setAttribute('class', 'canvas-overlap-cycle-layer');
  handleLayer.setAttribute('class', 'canvas-handle-layer');
  svg.insertBefore(imageFillDefs, svg.firstChild);
  svg.appendChild(g);
  g.append(axisLayer, objectLayer, hoverLayer, overlapCycleLayer, handleLayer, interactionLayer, previewLayer);
  const imageFillSystem = createImageFillSystem({
    defs: imageFillDefs,
    addSvg: add,
    onImageMetrics(reference, metrics) {
      const updates = records
        .filter((record) => (
          record.recordType === 'geometry'
          && (
            record.entity.appearance?.fillImageReference === reference
            || record.entity.appearance?.fillExpression === reference
          )
        ))
        .map((record) => {
          const currentAppearance = record.entity.appearance || {};
          const metricsPatch = imageFillMetricsAppearancePatch(
            currentAppearance,
            metrics,
            formatDrawingLength,
          );
          return {
            id: record.id,
            appearance: { ...currentAppearance, ...metricsPatch },
            changed: Object.entries(metricsPatch).some(
              ([key, value]) => currentAppearance[key] !== value,
            ),
          };
        })
        .filter(({ changed }) => changed)
        .map(({ id, appearance }) => ({ id, appearance }));
      if (!updates.length) return;
      solver.updateEntityAppearances(updates).forEach((entity) => {
        const record = records.find((candidate) => candidate.id === entity.id);
        if (record) record.entity = cloneEntity(entity);
      });
      notifyObjectChange({ history: 'none' });
    },
  });
  const imageStrokeSystem = createImageStrokeSystem({
    onImageMetrics(reference, metrics) {
      const updates = records
        .filter((record) => (
          record.recordType === 'geometry'
          && (
            record.entity.appearance?.strokeImageReference === reference
            || record.entity.appearance?.strokeExpression === reference
          )
        ))
        .map((record) => {
          const currentAppearance = record.entity.appearance || {};
          const metricsPatch = imageStrokeMetricsAppearancePatch(currentAppearance, metrics);
          return {
            id: record.id,
            appearance: { ...currentAppearance, ...metricsPatch },
            changed: Object.entries(metricsPatch).some(([key, value]) => currentAppearance[key] !== value),
          };
        })
        .filter(({ changed }) => changed)
        .map(({ id, appearance }) => ({ id, appearance }));
      if (!updates.length) return;
      solver.updateEntityAppearances(updates).forEach((entity) => {
        const record = records.find((candidate) => candidate.id === entity.id);
        if (record) record.entity = cloneEntity(entity);
      });
      notifyObjectChange({ history: 'none' });
    },
  });
  const geometryAppearanceSystem = createGeometryAppearanceSystem({
    records,
    selectedIds,
    solver,
    imageFillSystem,
    imageStrokeSystem,
    isClosedGeometry,
    isSubtractableEntity,
    getSubtractSystem: () => subtractSystem,
    getSelectedSegment: () => {
      const count = [...selectedSegments.values()].reduce((total, indices) => total + indices.size, 0);
      return count === 1 ? selectedSegment : null;
    },
    getPropertyFeature: () => seamLineSystem?.getPropertyFeature?.() || null,
    getClosedCycles: () => currentClosedCycles(),
    getFilletSystem: () => filletSystem,
    getTextTools: () => textTools,
    getImageTools: () => imageTools,
    rememberTextDefaults,
    resolveEntityAppearance: (entity) => (
      isClassGeometryEntity(entity) ? classSystem.resolveAppearance(entity) : entity?.appearance || {}
    ),
    applyEntityAppearanceOverrides: (entity, appearance, patch) => (
      isClassGeometryEntity(entity)
        ? classSystem.applyAppearanceOverrides(entity, appearance, patch)
        : { ...entity, appearance }
    ),
    renderClosedRegions,
    syncGeometryStacking,
    notifyObjectChange,
  });

  const dimensionEditInput = dimensionEditPanel.querySelector('.dimension-edit-input');
  const dimensionEditLabelText = dimensionEditPanel.querySelector('.dimension-edit-label > span');
  const dimensionEditOptions = dimensionEditPanel.querySelector('#dimensionEditParameterNames');
  const dimensionEditError = dimensionEditPanel.querySelector('.dimension-edit-error');
  const persistDrivenDimensionExport = createDrivenDimensionExportPersistence({
    solver,
    onChange: () => notifyObjectChange({ history: 'commit' }),
  });

  const imageTools = createImageManipulation({
    addSvg: add,
    parent: objectLayer,
    screenToWorld,
    getScale: () => camera.scale,
    getDrawingUnit: () => solver.drawingUnit || 'in',
    evaluateNumeric: (expression) => solver.evaluateParameterExpression(expression),
    onSelect: (recordId, event = null) => {
      if (event?.ctrlKey || event?.metaKey) toggleSelection(recordId);
      else selectOnly(recordId);
    },
    onMoveStart: (event, record) => {
      if (event.button !== 0 || selectedIds.size < 2 || !selectedIds.has(record.id)) return false;
      event.preventDefault();
      event.stopPropagation();
      if (!record.entity.locked) beginRecordsDrag(event);
      record.group.setPointerCapture(event.pointerId);
      return true;
    },
    canStartDrag: () => !isToolDragBlocked(),
    onChange: () => {
      syncGeometryStacking();
      syncState();
      notifyObjectChange();
    },
    onDelete: (id) => {
      selectOnly(id);
      deleteSelection();
    },
    onCreateClosedLineChain: (points) => addEditableLineChain({
      chainPoints: points,
      closed: true,
      kind: 'polyline',
      addObject,
    }),
  });

  const evaluateFieldExpression = (expression) => {
    try {
      return solver.evaluateDrawingLengthExpression(expression);
    } catch {
      return solver.evaluateParameterExpression(expression);
    }
  };

  const textTools = createTextSystem({
    objectLayer,
    getScale: () => camera.scale,
    getAppearance: geometryAppearanceSystem.appearance,
    getParameters: () => [...solver.documentVariables?.() || [], ...solver.parameters()],
    formatParameter: (entry) => formatUnitlessValue(entry.value, solver.drawingUnit || 'in'),
    evaluateExpression: evaluateFieldExpression,
    bindRecordEvents,
    updateRecordHandles,
    syncEntity: (entity) => solver.updateEntity(cloneEntity(entity)),
    resolveTextProperties: classSystem.resolveEntityProperties,
    applyTextPropertyOverrides: classSystem.applyEntityPropertyOverrides,
    requestHistoryCheckpoint,
    onChange: notifyObjectChange,
  });

  const tableTools = createTableSystem({
    objectLayer,
    handleLayer,
    previewLayer,
    screenToWorld,
    getScale: () => camera.scale,
    getParameters: () => [...solver.documentVariables?.() || [], ...solver.parameters()],
    formatParameter: (entry) => formatUnitlessValue(entry.value, solver.drawingUnit || 'in'),
    evaluateExpression: evaluateFieldExpression,
    onSelect: selectOnly,
    onHandlePointerDown: (event, record, index) => startHandleDrag(event, record, index),
    onChange: (record, { history = 'coalesce' } = {}) => {
      if (record?.recordType === 'table' && solver.getEntity?.(record.id)) {
        solver.updateEntity(tableTools.constraintEntity(record.entity));
      }
      syncGeometryStacking();
      syncState();
      notifyObjectChange({ history });
    },
    notifySelectionChange: () => syncState(),
  });
  selectionPropertyProviders.add({
    selectionProperties: () => tableTools.selectionProperties(selectedIds),
  });

  dimensionEditPanel.addEventListener('pointerdown', (event) => event.stopPropagation());
  dimensionEditPanel.addEventListener('click', (event) => event.stopPropagation());
  dimensionEditPanel.addEventListener('dblclick', (event) => event.stopPropagation());
  dimensionEditPanel.addEventListener('keydown', (event) => event.stopPropagation());
  dimensionEditInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitDimensionEditPanel();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDimensionEditPanel();
    }
  });

  function add(parent, tag, attrs) {
    const node = document.createElementNS(ns, tag);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
    parent.appendChild(node);
    return node;
  }

  function promoteHandleGroup(record) {
    if (!record?.handleGroup || ['image', 'text'].includes(record.recordType)) return;
    record.handleGroup.classList.add('canvas-handle-group');
    record.handleGroup.dataset.recordId = record.id;
    handleLayer.appendChild(record.handleGroup);
  }

  function removeRecordNodes(record) {
    record?.handleGroup?.remove();
    record?.group?.remove();
  }

  function refreshHoverHighlight() {
    hoverLayer.replaceChildren();
    const record = records.find((candidate) => candidate.id === hoveredId);
    const hoveredSegmentIndex = record ? [...(selectedSegments.get(record.id) || [])][0] : null;
    if (record && Number.isInteger(hoveredSegmentIndex)) {
      const segment = record.segmentNodes?.find((node) => Number(node.dataset.segmentIndex) === hoveredSegmentIndex);
      if (segment) {
        const clone = segment.cloneNode(true);
        clone.classList.remove('selected', 'hovered', 'smart-selected', 'overlap-cycle-selected', 'object-snap-target');
        clone.classList.add('hover-highlight-graphic');
        clone.style.pointerEvents = 'none';
        hoverLayer.appendChild(clone);
        return;
      }
    }
    if (hoveredRegion) {
      const clone = hoveredRegion.cloneNode(true);
      clone.classList.remove('selected');
      clone.classList.add('hover-highlight-graphic');
      clone.removeAttribute('role');
      clone.removeAttribute('aria-label');
      hoverLayer.appendChild(clone);
      return;
    }
    if (!record || ['image', 'text'].includes(record.recordType)) return;
    record.group.querySelectorAll('.selectable-entity:not(.hit-target)').forEach((node) => {
      const clone = node.cloneNode(true);
      clone.classList.remove('selected', 'hovered', 'smart-selected', 'overlap-cycle-selected', 'object-snap-target');
      clone.classList.add('hover-highlight-graphic');
      clone.style.pointerEvents = 'none';
      hoverLayer.appendChild(clone);
    });
  }

  function midpoint(a, b) {
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }

  function pointList(points) {
    return points.map(([x, y]) => `${x},${y}`).join(' ');
  }

  function pathNumbers(d) {
    return d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
  }

  function cloneEntity(entity) {
    return JSON.parse(JSON.stringify(entity));
  }

  function recordAppearance(record) {
    return record.recordType === 'image'
      ? imageAppearance(record.entity, (expression) => solver.evaluateParameterExpression(expression))
      : geometryAppearanceSystem.appearance(record.entity);
  }

  function editableStackOrder() {
    return records
      .map((record, originalIndex) => ({ record, originalIndex }))
      .filter(({ record }) => (
        ['geometry', 'image', 'fillet', 'text', 'table', 'control'].includes(record.recordType)
        && !record.entity.construction
      ))
      .sort((a, b) => {
        const stackDelta = stackSystem.orderForEntity(a.record.entity) - stackSystem.orderForEntity(b.record.entity);
        if (stackDelta) return stackDelta;
        const aIndex = recordAppearance(a.record).zIndex;
        const bIndex = recordAppearance(b.record).zIndex;
        return (aIndex ?? a.originalIndex) - (bIndex ?? b.originalIndex) || a.originalIndex - b.originalIndex;
      })
      .map(({ record }) => record);
  }

  function syncGeometryStacking() {
    const editable = editableStackOrder();
    const construction = records.filter((record) => ['geometry', 'image', 'fillet', 'table'].includes(record.recordType) && record.entity.construction);
    const notches = records.filter((record) => record.recordType === 'notch');
    const dimensions = records.filter((record) => record.recordType === 'dimension');
    const derivedNodes = [...objectLayer.querySelectorAll(':scope > [data-paint-derived="true"]')];
    const derivedByAnchorId = new Map();
    const unanchoredDerived = [];
    derivedNodes.forEach((node) => {
      const anchorId = node.dataset.paintAfterRecordId;
      if (!anchorId) {
        unanchoredDerived.push(node);
        return;
      }
      if (!derivedByAnchorId.has(anchorId)) derivedByAnchorId.set(anchorId, []);
      derivedByAnchorId.get(anchorId).push(node);
    });
    const appendRecord = (record) => {
      objectLayer.appendChild(record.group);
      (derivedByAnchorId.get(record.id) || []).forEach((node) => objectLayer.appendChild(node));
      derivedByAnchorId.delete(record.id);
    };
    const stackPositions = new Map(editable.map((record, index) => [record.id, index]));
    const regionsByPosition = new Map();
    closedRegionNodes.forEach((region) => {
      const positions = (region.dataset.parentIds || '').split(',').map((id) => stackPositions.get(id)).filter(Number.isFinite);
      const position = positions.length ? Math.min(...positions) : 0;
      if (!regionsByPosition.has(position)) regionsByPosition.set(position, []);
      regionsByPosition.get(position).push(region);
    });
    editable.forEach((record, index) => {
      (regionsByPosition.get(index) || []).forEach((region) => objectLayer.appendChild(region));
      appendRecord(record);
    });
    unanchoredDerived.forEach((node) => objectLayer.appendChild(node));
    [...construction, ...notches, ...dimensions].forEach(appendRecord);
    derivedByAnchorId.forEach((nodes) => {
      nodes.forEach((node) => objectLayer.appendChild(node));
    });
  }

  function isClosedGeometry(entity) {
    return ['circle', 'rect', 'polygon'].includes(entity.type);
  }

  function screenToWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return [(clientX - rect.left - camera.x) / camera.scale, (clientY - rect.top - camera.y) / camera.scale];
  }

  function worldToScreen(point) {
    return [point[0] * camera.scale + camera.x, point[1] * camera.scale + camera.y];
  }

  function circleFromThreePoints(a, b, c) {
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (Math.abs(d) < 0.0001) return null;
    const aa = a[0] ** 2 + a[1] ** 2;
    const bb = b[0] ** 2 + b[1] ** 2;
    const cc = c[0] ** 2 + c[1] ** 2;
    const center = [
      (aa * (b[1] - c[1]) + bb * (c[1] - a[1]) + cc * (a[1] - b[1])) / d,
      (aa * (c[0] - b[0]) + bb * (a[0] - c[0]) + cc * (b[0] - a[0])) / d,
    ];
    return { center, radius: Math.hypot(a[0] - center[0], a[1] - center[1]) };
  }

  function hasStoredArcCircle(entity) {
    return Array.isArray(entity.center)
      && entity.center.every(Number.isFinite)
      && Number.isFinite(entity.radius)
      && Math.abs(entity.radius) > 1e-8;
  }

  function arcCircle(entity) {
    if (hasStoredArcCircle(entity)) return { center: [...entity.center], radius: Math.abs(entity.radius) };
    return circleFromThreePoints(entity.start, entity.arcPoint, entity.end);
  }

  function refreshArcCircleMetadata(entity) {
    if (entity.type !== 'arc') return null;
    const circle = circleFromThreePoints(entity.start, entity.arcPoint, entity.end);
    if (!circle) return null;
    entity.center = circle.center;
    entity.radius = circle.radius;
    return circle;
  }

  function pointDistance(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  }

  function addPoints(a, b) {
    return [a[0] + b[0], a[1] + b[1]];
  }

  function subtractPoints(a, b) {
    return [a[0] - b[0], a[1] - b[1]];
  }

  function scalePoint(point, value) {
    return [point[0] * value, point[1] * value];
  }

  function pointLength(point) {
    return Math.hypot(point[0], point[1]);
  }

  function unitVector(point, fallback = [1, 0]) {
    const length = pointLength(point);
    return length > 0.0001 ? [point[0] / length, point[1] / length] : fallback;
  }

  const formatDrawingLength = (value) => formatUnitValue(value, solver.drawingUnit || 'in');
  const formatDrawingNumber = (value) => formatUnitlessValue(value, solver.drawingUnit || 'in');
  const expressionWithoutUnits = (expression) => String(expression ?? '')
    .replace(/\s+(?:mm|cm|m|in|ft|deg)\b/gi, '')
    .trim();

  function applyManagedDimensionText(entity) {
    if (!entity.dimensionId) return;
    const text = solver.getDimensionText(entity.dimensionId, dimensionTextMode);
    if (!text) return;
    entity.managedDimensionText = true;
    entity.text = text;
  }

  function syncDimensionPresentation(record) {
    const hideDimension = dimensionHiddenInTextMode(record.entity, dimensionTextMode);
    const hideForParent = record.dimensionParentsVisible === false;
    record.group.style.display = hideDimension ? 'none' : '';
    record.group.classList.toggle('object-visibility-hidden', hideForParent);
    record.group.setAttribute('data-object-visible', String(!hideForParent));
    record.group.setAttribute('aria-hidden', String(hideDimension || hideForParent));
  }

  function syncDimensionDependencyStates() {
    const enabledByDimensionId = new Map();
    const parentState = (recordId, shown) => {
      const parent = recordById(recordId);
      if (!parent) {
        for (const provider of derivedDimensionFeatureProviders) {
          const derivedState = provider[shown ? 'isRecordShown' : 'isRecordVisible']?.(recordId);
          if (derivedState !== undefined) return derivedState;
        }
        return false;
      }
      return stackSystem.isRecordVisible(parent)
        && (shown
          ? objectVisibilitySystem.isRecordShown(recordId)
          : objectVisibilitySystem.isRecordVisible(recordId));
    };
    records.forEach((record) => {
      if (record.recordType !== 'dimension') return;
      const state = dimensionParentStates(record.entity, {
        isVisible: (recordId) => parentState(recordId, false),
        isEnabled: (recordId) => parentState(recordId, true),
      });
      record.dimensionParentsVisible = state.visible;
      syncDimensionPresentation(record);
      if (record.entity.dimensionId) {
        enabledByDimensionId.set(record.entity.dimensionId, state.enabled);
      }
    });
    const outcome = solver.setDimensionEnabledStates(enabledByDimensionId);
    if (outcome.changed) applySolverSnapshot(outcome.snapshot);
    return outcome.changed;
  }

  function syncStackPresentation() {
    canvas.dataset.activeStackId = stackSystem.activeStackId();
    stackSystem.syncPresentation(closedRegionNodes);
  }

  function isRecordInteractive(record) {
    return stackSystem.isRecordEnabled(record)
      && objectVisibilitySystem?.isRecordShown(record) !== false
      && record?.group?.style?.display !== 'none'
      && record?.group?.hidden !== true;
  }

  function syncGeometryPresentation(record) {
    const hideConstruction = dimensionTextMode === 'value' && record.entity.construction === true;
    record.group.style.display = hideConstruction ? 'none' : '';
    record.group.setAttribute('aria-hidden', String(hideConstruction));
  }

  function arcPath(entity) {
    const circle = arcCircle(entity);
    if (!circle) return `M ${entity.start[0]} ${entity.start[1]} L ${entity.end[0]} ${entity.end[1]}`;
    const startAngle = Math.atan2(entity.start[1] - circle.center[1], entity.start[0] - circle.center[0]);
    const midAngle = Math.atan2(entity.arcPoint[1] - circle.center[1], entity.arcPoint[0] - circle.center[0]);
    const endAngle = Math.atan2(entity.end[1] - circle.center[1], entity.end[0] - circle.center[0]);
    const sweepDetails = arcSweepFromAngles(startAngle, endAngle, midAngle, {
      major: typeof entity.major === 'boolean' ? entity.major : null,
      ccw: typeof entity.ccw === 'boolean' ? entity.ccw : null,
    });
    const largeArc = Math.abs(sweepDetails.span) > Math.PI ? 1 : 0;
    const sweep = sweepDetails.ccw ? 1 : 0;
    return `M ${entity.start[0]} ${entity.start[1]} A ${circle.radius} ${circle.radius} 0 ${largeArc} ${sweep} ${entity.end[0]} ${entity.end[1]}`;
  }

  function arcMidpoint(entity) {
    const circle = arcCircle(entity);
    if (!circle) return midpoint(entity.start, entity.end);
    const startAngle = Math.atan2(entity.start[1] - circle.center[1], entity.start[0] - circle.center[0]);
    const midAngle = Math.atan2(entity.arcPoint[1] - circle.center[1], entity.arcPoint[0] - circle.center[0]);
    const endAngle = Math.atan2(entity.end[1] - circle.center[1], entity.end[0] - circle.center[0]);
    const sweep = arcSweepFromAngles(startAngle, endAngle, midAngle, {
      major: typeof entity.major === 'boolean' ? entity.major : null,
      ccw: typeof entity.ccw === 'boolean' ? entity.ccw : null,
    });
    const angle = startAngle + sweep.span / 2;
    return [circle.center[0] + Math.cos(angle) * circle.radius, circle.center[1] + Math.sin(angle) * circle.radius];
  }

  function arcAngleDetails(entity) {
    const circle = arcCircle(entity);
    if (!circle) return null;
    const startAngle = Math.atan2(entity.start[1] - circle.center[1], entity.start[0] - circle.center[0]);
    const midAngle = Math.atan2(entity.arcPoint[1] - circle.center[1], entity.arcPoint[0] - circle.center[0]);
    const endAngle = Math.atan2(entity.end[1] - circle.center[1], entity.end[0] - circle.center[0]);
    const sweep = arcSweepFromAngles(startAngle, endAngle, midAngle, {
      major: typeof entity.major === 'boolean' ? entity.major : null,
      ccw: typeof entity.ccw === 'boolean' ? entity.ccw : null,
    });
    const normalize = (angle) => (angle + Math.PI * 2) % (Math.PI * 2);
    return {
      circle,
      startAngle,
      ccwSpan: normalize(endAngle - startAngle),
      midOnCcw: sweep.ccw,
      normalize,
    };
  }

  function arcContainsAngle(details, angle) {
    const relative = details.normalize(angle - details.startAngle);
    const epsilon = 0.000001;
    return details.midOnCcw ? relative <= details.ccwSpan + epsilon : relative >= details.ccwSpan - epsilon;
  }

  function arcQuadrants(entity) {
    const details = arcAngleDetails(entity);
    if (!details) return [];
    return [0, Math.PI / 2, Math.PI, Math.PI * 1.5]
      .filter((angle) => arcContainsAngle(details, angle))
      .map((angle) => [
        details.circle.center[0] + Math.cos(angle) * details.circle.radius,
        details.circle.center[1] + Math.sin(angle) * details.circle.radius,
      ]);
  }

  function curvePath(points) {
    if (points.length < 2) return '';
    if (points.length === 2) return `M ${points[0][0]} ${points[0][1]} L ${points[1][0]} ${points[1][1]}`;
    const controlPoint = (current, previous, next, tension = 0.18) => [
      current[0] + (next[0] - previous[0]) * tension,
      current[1] + (next[1] - previous[1]) * tension,
    ];
    return points.slice(1).reduce((path, point, index) => {
      const currentIndex = index + 1;
      const previous = points[Math.max(0, currentIndex - 2)];
      const current = points[currentIndex - 1];
      const next = point;
      const after = points[Math.min(points.length - 1, currentIndex + 1)];
      const c1 = controlPoint(current, previous, next);
      const c2 = controlPoint(next, after, current);
      return `${path} C ${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${point[0]} ${point[1]}`;
    }, `M ${points[0][0]} ${points[0][1]}`);
  }

  function updateClosedRegionGeometryInPlace(changedRecordIds = null) {
    const affectedNodes = [...closedRegionNodes, ...resolvedBoundaryVisualNodes].filter((node) => {
      if (!changedRecordIds) return true;
      const parentIds = String(node.dataset?.parentIds || '').split(',').filter(Boolean);
      return parentIds.some((recordId) => changedRecordIds.has(recordId));
    });
    if (!affectedNodes.length) return;
    const affectedRecordIds = new Set(affectedNodes.flatMap((node) => (
      String(node.dataset?.parentIds || '').split(',').filter(Boolean)
    )));
    const boundaries = changedRecordIds
      ? resolveClosedBoundariesForRecordIds(
        [...affectedRecordIds]
          .map((recordId) => recordById(recordId, { includeFillets: true }))
          .filter(Boolean)
          .map((record) => record.entity),
        solver.constraintsForRecordIds?.(affectedRecordIds) || solver.constraints(),
        affectedRecordIds,
      )
      : currentResolvedBoundaries();
    const boundariesById = new Map(boundaries.map((boundary) => [boundary.id, boundary]));
    affectedNodes.forEach((region) => {
      const boundary = boundariesById.get(region.dataset.boundaryId);
      if (boundary?.d) region.setAttribute('d', boundary.d);
    });
  }

  function renderClosedRegions() {
    closedRegionNodes.forEach((region) => region.remove());
    closedRegionNodes.clear();
    hoveredRegion = null;
    resolvedBoundaryVisualNodes.forEach((node) => node.remove());
    resolvedBoundaryVisualNodes.clear();
    records.filter((record) => ['geometry', 'fillet'].includes(record.recordType))
      .forEach((record) => {
        record.group.classList.remove('closed-region-source-record');
        if (record.recordType === 'geometry') geometryAppearanceSystem.apply(record);
      });
    const stackPositions = new Map(editableStackOrder().map((record, index) => [record.id, index]));
    const boundaries = currentResolvedBoundaries()
      .sort((a, b) => (
        Math.max(...a.recordIds.map((id) => stackPositions.get(id) ?? -1))
        - Math.max(...b.recordIds.map((id) => stackPositions.get(id) ?? -1))
      ));
    boundaries.forEach((boundary, index) => {
      const source = records.find((record) => record.id === boundary.appearanceSourceId)
        || boundary.recordIds.map((id) => records.find((record) => record.id === id)).find(Boolean);
      if (!source?.group || !boundary.d) return;
      const regionAppearance = geometryAppearanceSystem.resolvedBoundaryAppearance(source.entity || {}, {
        polygon: boundary.polygon,
        boundaryId: boundary.id,
      });
      const visual = add(source.group, 'path', {
        d: boundary.d,
        class: 'resolved-boundary-visual',
        'data-resolved-boundary': boundary.id,
        'data-boundary-id': boundary.id,
        'data-parent-ids': boundary.recordIds.join(','),
        fill: regionAppearance.fillPaint,
        'fill-opacity': regionAppearance.fillOpacity,
        stroke: regionAppearance.boundaryStroke,
        'stroke-width': regionAppearance.boundaryStrokeWidth,
        'stroke-opacity': regionAppearance.boundaryStrokeOpacity,
        'vector-effect': 'non-scaling-stroke',
        'pointer-events': 'none',
      });
      source.group.insertBefore(visual, source.group.firstChild);
      resolvedBoundaryVisualNodes.add(visual);
      boundary.recordIds.forEach((recordId) => {
        const record = records.find((candidate) => candidate.id === recordId);
        record?.group?.classList.add('closed-region-source-record');
        if (record?.node && isClosedGeometry(record.entity)) {
          record.node.setAttribute('fill', 'transparent');
          record.node.setAttribute('fill-opacity', 0);
          record.node.style.setProperty('fill', 'transparent', 'important');
          record.node.style.fillOpacity = '0';
        }
      });
      if (boundary.kind !== 'cycle') return;
      const region = add(objectLayer, 'path', {
        d: boundary.d,
        class: 'closed-constrained-region closed-region-hit',
        'data-region-index': index,
        'data-boundary-id': boundary.id,
        'data-parent-ids': boundary.recordIds.join(','),
        fill: 'transparent',
        'fill-opacity': 0,
        role: 'button',
        'aria-label': `Select filled shape with ${boundary.recordIds.length} object${boundary.recordIds.length === 1 ? '' : 's'}`,
      });
      closedRegionNodes.add(region);
      region.style.setProperty('--original-stroke-width', `${regionAppearance.strokeThickness}px`);
       region.style.setProperty('--region-fill', regionAppearance.fillPaint);
      region.classList.toggle('selected', boundary.recordIds.every((id) => selectedIds.has(id)));
      region.addEventListener('pointerdown', (event) => {
        if (featureCommandDelegate) return;
        const boundaryRecordIds = new Set(boundary.recordIds);
        const segmentNode = document.elementsFromPoint(event.clientX, event.clientY)
          .map((element) => element.closest?.('.segment-select-line'))
          .find((node) => {
            const recordId = node?.closest?.('.canvas-record')?.dataset.recordId;
            return node && boundaryRecordIds.has(recordId);
          });
        if (segmentNode) {
          event.paramagicSelectionTarget = segmentNode;
          seamLineSystem.setPropertyFeatureFromEvent(event);
          delete event.paramagicSelectionTarget;
          const record = records.find((candidate) => candidate.id === segmentNode.closest('.canvas-record')?.dataset.recordId);
          const segmentIndex = Number(segmentNode.dataset.segmentIndex);
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            event.stopPropagation();
            if (record) toggleSelection(record.id, { segmentIndex });
            suppressRecordClick = true;
            return;
          }
          if (record && startSegmentDrag(event, record, segmentIndex)) return;
        } else {
          seamLineSystem.setPropertyFeatureFromEvent(event);
        }
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        startRegionDrag(event, boundary.recordIds);
      });
      region.addEventListener('pointerenter', () => {
        hoveredRegion = region;
        refreshHoverHighlight();
      });
      region.addEventListener('pointerleave', () => {
        if (hoveredRegion !== region) return;
        hoveredRegion = null;
        refreshHoverHighlight();
      });
      region.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (suppressRecordClick) {
          suppressRecordClick = false;
          return;
        }
        if (event.ctrlKey || event.metaKey) toggleRecords(boundary.recordIds);
        else selectRecords(boundary.recordIds);
        emitSelectionChange();
      });
    });
    syncGeometryStacking();
    subtractSystem.applyRegionPresentation();
    objectVisibilitySystem?.syncPresentation(closedRegionNodes);
  }

  function legacyPathToCurve(entity) {
    const values = pathNumbers(entity.d);
    if (values.length >= 8) return { type: 'curve', points: [[values[0], values[1]], [values[2], values[3]], [values[4], values[5]], [values[6], values[7]]] };
    if (values.length >= 4) return { type: 'polyline', points: [[values[0], values[1]], [values[values.length - 2], values[values.length - 1]]] };
    return { type: 'polyline', points: [] };
  }

  function normalizeEntity(entity) {
    if (entity.type === 'path') return legacyPathToCurve(entity);
    return cloneEntity(entity);
  }

  function recordHandles(entity) {
    if (entity.type === 'notch') return [entity.point];
    if (entity.type === 'point') return [entity.point];
    if (entity.type === 'text') return [[entity.x, entity.y]];
    if (entity.type === 'line') return [entity.start, midpoint(entity.start, entity.end), entity.end];
    if (entity.type === 'circle') {
      const [cx, cy] = entity.center;
      const r = entity.radius;
      return [[cx, cy], [cx - r, cy], [cx, cy - r], [cx + r, cy], [cx, cy + r]];
    }
    if (entity.type === 'rect') {
      const x1 = entity.x;
      const y1 = entity.y;
      const x2 = entity.x + entity.width;
      const y2 = entity.y + entity.height;
      return [[x1, y1], midpoint([x1, y1], [x2, y1]), [x2, y1], midpoint([x2, y1], [x2, y2]), [x2, y2], midpoint([x2, y2], [x1, y2]), [x1, y2], midpoint([x1, y2], [x1, y1])];
    }
    if (entity.type === 'polygon' || entity.type === 'polyline' || entity.type === 'curve') return entity.points;
    if (entity.type === 'arc') {
      return [entity.start, arcMidpoint(entity), entity.end];
    }
    if (entity.type === 'table') return tableCornerPoints(entity);
    if (isDimensionEntity(entity)) return dimensionHandles(entity, camera.scale);
    return [];
  }

  function recordSegments(entity) {
    if (entity.type === 'line') return [{ start: entity.start, end: entity.end, index: 0 }];
    if (entity.type === 'rect') {
      const x1 = entity.x;
      const y1 = entity.y;
      const x2 = entity.x + entity.width;
      const y2 = entity.y + entity.height;
      const points = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
      return points.map((point, index) => ({ start: point, end: points[(index + 1) % points.length], index }));
    }
    if (entity.type === 'polyline' || entity.type === 'polygon') {
      const limit = entity.type === 'polygon' ? entity.points.length : entity.points.length - 1;
      return Array.from({ length: Math.max(0, limit) }, (_, index) => ({
        start: entity.points[index],
        end: entity.points[(index + 1) % entity.points.length],
        index,
      }));
    }
    return [];
  }

  function renderedEntityForRecord(record) {
    if (!record) return null;
    if (record.recordType === 'fillet') {
      const evaluated = filletSystem.evaluateRecord(record);
      return evaluated.valid ? evaluated.arc : null;
    }
    if (record.recordType !== 'geometry') return record.entity || null;
    return record.renderEntity || evaluatedGeometryMap().get(record.id) || record.entity;
  }

  function recordSnapPoints(record) {
    if (!['geometry', 'text', 'table', 'control'].includes(record.recordType)) return [];
    const snapPoints = recordHandles(record.entity).map((point, index) => ({
      point: [...point],
      kind: 'handle',
      index: record.entity.type === 'table' ? tableSolverCornerIndex(index) : index,
      ...(record.entity.type === 'arc' && index === 1 ? { pointRole: ARC_MIDPOINT_ROLE } : {}),
    }));
    recordSegments(record.entity).forEach((segment) => {
      snapPoints.push({ point: midpoint(segment.start, segment.end), kind: 'midpoint', index: segment.index });
    });
    if (record.entity.type === 'arc') {
      arcQuadrants(record.entity).forEach((point, index) => snapPoints.push({ point, kind: 'quadrant', index }));
    }
    return snapPoints.reduce((unique, candidate) => {
      const key = `${candidate.point[0].toFixed(4)},${candidate.point[1].toFixed(4)}`;
      if (!unique.keys.has(key)) {
        unique.keys.add(key);
        unique.points.push(candidate);
      }
      return unique;
    }, { keys: new Set(), points: [] }).points;
  }

  function nearestSnapPoint(world, screenTolerance = 12) {
    const tolerance = screenTolerance / camera.scale;
    return records.reduce((best, record) => {
      if (!['geometry', 'text', 'table', 'control'].includes(record.recordType) || !isRecordInteractive(record)) return best;
      return recordSnapPoints(record).reduce((innerBest, candidate) => {
        const distance = pointDistance(world, candidate.point);
        if (distance > tolerance || (innerBest && distance >= innerBest.distance)) return innerBest;
        return {
          ...candidate,
          point: [...candidate.point],
          distance,
          recordId: record.id,
          entityType: record.entity.type,
        };
      }, best);
    }, null);
  }

  function nearestObjectPoint(world, screenTolerance = 14) {
    if (!objectSnapEnabled) return null;
    const tolerance = screenTolerance / camera.scale;
    return records.reduce((best, record) => {
      if (!['geometry', 'text', 'table', 'control'].includes(record.recordType) || !isRecordInteractive(record)) return best;
      return recordHandles(record.entity).reduce((innerBest, point, index) => {
        const distance = pointDistance(world, point);
        if (distance > tolerance || (innerBest && distance >= innerBest.distance)) return innerBest;
        return {
          kind: 'point',
          recordId: record.id,
          entityType: record.entity.type,
          index: record.entity.type === 'table' ? tableSolverCornerIndex(index) : index,
          ...(record.entity.type === 'arc' && index === 1 ? { pointRole: ARC_MIDPOINT_ROLE } : {}),
          point: [...point],
          distance,
        };
      }, best);
    }, null);
  }

  function setObjectSnapCandidate(candidate) {
    [objectLayer, handleLayer].forEach((layer) => {
      layer.querySelectorAll('.object-snap-target').forEach((handle) => handle.classList.remove('object-snap-target'));
    });
    objectSnapCandidate = candidate || null;
    if (!objectSnapCandidate) return;
    const record = records.find((item) => ['geometry', 'text', 'table', 'control'].includes(item.recordType) && item.id === objectSnapCandidate.recordId);
    const handleIndex = record?.entity?.type === 'table'
      ? tableCornerIndexFromSolverIndex(objectSnapCandidate.index)
      : objectSnapCandidate.index;
    record?.handles?.[handleIndex >= 0 ? handleIndex : objectSnapCandidate.index]?.classList.add('object-snap-target');
  }

  function createGeometryNode(parent, entity, className = 'selectable-entity') {
    const hitFill = className.includes('hit-target') ? { fill: 'transparent', 'fill-opacity': 0 } : {};
    const hitTargetClass = className.includes('hit-target') ? drawingGeometryHitTargetClass(entity) : '';
    const geometryClass = (closed = false, accent = false) => [
      entity.construction ? 'construction' : 'entity',
      closed && !entity.construction ? 'closed-entity' : '',
      accent && !entity.construction ? 'accent' : '',
      className,
      hitTargetClass,
    ].filter(Boolean).join(' ');
    if (entity.type === 'point') return add(parent, 'circle', {
      cx: entity.point[0],
      cy: entity.point[1],
      r: 0,
      class: `reference-point-entity ${geometryClass()}`,
      'pointer-events': 'none',
    });
    if (entity.type === 'line') return add(parent, 'line', { x1: entity.start[0], y1: entity.start[1], x2: entity.end[0], y2: entity.end[1], class: geometryClass() });
    if (entity.type === 'circle') return add(parent, 'circle', {
      cx: entity.center[0],
      cy: entity.center[1],
      r: entity.radius,
      class: geometryClass(true),
      ...hitFill,
    });
    if (entity.type === 'rect') return add(parent, 'rect', { x: entity.x, y: entity.y, width: entity.width, height: entity.height, rx: 18, class: geometryClass(true), ...hitFill });
    if (entity.type === 'polygon') return add(parent, 'polygon', { points: pointList(entity.points), class: geometryClass(true), ...hitFill });
    if (entity.type === 'polyline') return add(parent, 'polyline', { points: pointList(entity.points), class: geometryClass(), fill: 'none' });
    if (entity.type === 'curve') return add(parent, 'path', { d: curvePath(entity.points), class: geometryClass(false, true), fill: 'none' });
    if (entity.type === 'arc') return add(parent, 'path', { d: arcPath(entity), class: geometryClass(false, true), fill: 'none' });
    return null;
  }

  function evaluatedGeometryMap() {
    const entities = records
      .filter((record) => (
        record.recordType === 'geometry' || record.recordType === 'fillet'
      ))
      .map((record) => record.entity);
    return new Map(evaluateFilletedGeometry(entities).map((entity) => [entity.id, entity]));
  }

  function updateGeometryNode(record) {
    const entity = evaluatedGeometryMap().get(record.id) || record.entity;
    record.renderEntity = cloneEntity(entity);
    const nodes = [record.node, record.hitNode].filter(Boolean);
    if (entity.type === 'point') {
      nodes.forEach((node) => {
        node.setAttribute('cx', entity.point[0]);
        node.setAttribute('cy', entity.point[1]);
      });
    }
    if (entity.type === 'line') {
      nodes.forEach((node) => {
        node.setAttribute('x1', entity.start[0]);
        node.setAttribute('y1', entity.start[1]);
        node.setAttribute('x2', entity.end[0]);
        node.setAttribute('y2', entity.end[1]);
      });
    }
    if (entity.type === 'circle') {
      nodes.forEach((node) => {
        node.setAttribute('cx', entity.center[0]);
        node.setAttribute('cy', entity.center[1]);
        node.setAttribute('r', entity.radius);
      });
    }
    if (entity.type === 'rect') {
      nodes.forEach((node) => {
        node.setAttribute('x', entity.x);
        node.setAttribute('y', entity.y);
        node.setAttribute('width', entity.width);
        node.setAttribute('height', entity.height);
      });
    }
    if (entity.type === 'polygon' || entity.type === 'polyline') nodes.forEach((node) => node.setAttribute('points', pointList(entity.points)));
    if (entity.type === 'curve') nodes.forEach((node) => node.setAttribute('d', curvePath(entity.points)));
    if (entity.type === 'arc') nodes.forEach((node) => node.setAttribute('d', arcPath(entity)));
    syncGeometryClasses(record);
    geometryAppearanceSystem.apply(record);
    updateSegmentNodes(record, entity);
  }

  function syncGeometryClasses(record) {
    if (record.recordType !== 'geometry') return;
    const isConstruction = record.entity.construction === true;
    [record.node, record.hitNode].filter(Boolean).forEach((node) => {
      node.classList.toggle('construction', isConstruction);
      node.classList.toggle('entity', !isConstruction);
      node.classList.toggle('closed-entity', isClosedGeometry(record.entity) && !isConstruction);
      node.classList.toggle('accent', ['arc', 'curve'].includes(record.entity.type) && !isConstruction);
    });
  }

  function updateSegmentNodes(record, renderedEntity = record.entity) {
    if (!record.segmentGroup) return;
    const appearance = geometryAppearanceSystem.appearance(record.entity || renderedEntity);
    record.segmentGroup.style.setProperty(
      '--original-stroke-width',
      `${record.entity?.construction ? 1 : appearance.strokeThickness}px`,
    );
    record.segmentGroup.replaceChildren();
    record.segmentNodes = recordSegments(renderedEntity).map((segment) => {
      const node = add(record.segmentGroup, 'line', {
        x1: segment.start[0],
        y1: segment.start[1],
        x2: segment.end[0],
        y2: segment.end[1],
        class: 'segment-select-line selectable-entity',
        'data-segment-index': segment.index,
      });
      return node;
    });
  }

  function updateRecordNode(record) {
    if (record.recordType === 'dimension') updateDimensionNode(record, camera.scale);
    else if (record.updateNode) record.updateNode();
    else if (record.recordType === 'fillet') filletSystem.updateRecord(record);
    else if (record.recordType === 'notch') notchSystem.updateRecord?.(record);
    else updateGeometryNode(record);
  }

  function updateRecordHandles(record) {
    if (record.updateHandles) {
      record.updateHandles();
      syncScreenInvariantSizing();
      return;
    }
    record.handles.forEach((handle) => handle.remove());
    record.handles = recordHandles(record.entity).map(([cx, cy], index) => {
      const handle = add(record.handleGroup, 'circle', { cx, cy, r: 6, class: 'point-handle', 'data-handle-index': index });
      handle.addEventListener('pointerdown', (event) => startHandleDrag(event, record, index));
      return handle;
    });
    syncScreenInvariantSizing();
  }

  function createGeometryRecord(inputEntity, index = records.length) {
    const entity = normalizeEntity(inputEntity);
    const group = add(objectLayer, 'g', {
      class: 'canvas-record entity-record geometry-record',
      'data-record-id': entity.id,
      'data-entity-type': entity.type,
      'data-class-id': entity.classId,
    });
    const node = createGeometryNode(group, entity, 'selectable-entity');
    if (!node) {
      group.remove();
      return null;
    }
    const hitNode = createGeometryNode(group, entity, 'selectable-entity hit-target');
    const segmentGroup = add(group, 'g', { class: 'segment-selection-layer' });
    const handleGroup = add(group, 'g', { class: 'handle-group' });
    const record = {
      id: group.dataset.recordId,
      recordType: 'geometry',
      entity,
      renderEntity: cloneEntity(entity),
      group,
      node,
      hitNode,
      segmentGroup,
      segmentNodes: [],
      handleGroup,
      handles: [],
    };
    updateSegmentNodes(record);
    updateRecordHandles(record);
    promoteHandleGroup(record);
    bindRecordEvents(record);
    syncGeometryClasses(record);
    geometryAppearanceSystem.apply(record);
    syncGeometryPresentation(record);
    return record;
  }

  function registerGeometryRecord(entity) {
    const record = createGeometryRecord(entity);
    if (!record) return null;
    records.push(record);
    return record;
  }

  function bindRecordEvents(record) {
    const isDimensionTextTarget = (event) => event.target.closest?.('.dimension-text, .dimension-text-hit');
    const handlePointerDown = (event) => {
      if (drawingMode || smartDimensionDelegate || featureCommandDelegate) return;
      if (record.recordType === 'geometry') seamLineSystem.setPropertyFeatureFromEvent(event);
      else if (!(event.ctrlKey || event.metaKey)) seamLineSystem.clearPropertyFeature();
      event.stopPropagation();
      if (event.button === 0 && (event.ctrlKey || event.metaKey)) return;
      if (
        event.button === 0
        && record.recordType === 'dimension'
        && ['dimension-line', 'angle-dimension', 'radius-dimension', 'multi-curve-length-dimension'].includes(record.entity.type)
        && isDimensionTextTarget(event)
      ) {
        const pointerTime = Number(event.timeStamp) || Date.now();
        const previousPointer = record.lastDimensionTextPointerDown;
        const isSecondPress = previousPointer
          && pointerTime - previousPointer.time <= 500
          && Math.hypot(event.clientX - previousPointer.x, event.clientY - previousPointer.y) <= 8;
        record.lastDimensionTextPointerDown = { time: pointerTime, x: event.clientX, y: event.clientY };
        if (
          dimensionMode(record.entity) === 'driving'
          && record.entity.dimensionId
          && (isSecondPress || event.detail > 1)
        ) {
          event.stopPropagation();
          selectOnly(record.id);
          return;
        }
        startDimensionLineDrag(event, record);
        return;
      }
      if (
        event.button === 0
        && record.recordType === 'dimension'
        && ['dimension-line', 'angle-dimension', 'radius-dimension', 'multi-curve-length-dimension'].includes(record.entity.type)
        && event.target.closest?.('.dimension-path')
      ) {
        startDimensionLineDrag(event, record);
        return;
      }
      if (event.target.dataset?.segmentIndex !== undefined && startSegmentDrag(event, record)) return;
      if (record.recordType === 'text') {
        if (textTools.isEditing(record)) return;
        const pointerTime = Number(event.timeStamp) || Date.now();
        const previousPointer = record.lastTextPointerDown;
        const isSecondPress = previousPointer
          && pointerTime - previousPointer.time <= 500
          && Math.hypot(event.clientX - previousPointer.x, event.clientY - previousPointer.y) <= 8;
        record.lastTextPointerDown = { time: pointerTime, x: event.clientX, y: event.clientY };
        if (isSecondPress || event.detail > 1) {
          event.preventDefault();
          selectOnly(record.id);
          textTools.beginEdit(record, { caretPoint: { clientX: event.clientX, clientY: event.clientY } });
          return;
        }
        startObjectDrag(event, record);
        return;
      }
      if (record.recordType === 'table') {
        startObjectDrag(event, record);
        return;
      }
      if (record.recordType === 'geometry') startObjectDrag(event, record);
    };
    const handleClick = (event) => {
      event.stopPropagation();
      if (
        record.recordType === 'dimension'
        && dimensionMode(record.entity) === 'driving'
        && record.entity.dimensionId
        && event.detail >= 2
        && isDimensionTextTarget(event)
      ) {
        suppressRecordClick = false;
        selectOnly(record.id);
        openDimensionEditPanel(record);
        return;
      }
      if (record.recordType === 'text' && event.detail >= 2) {
        suppressRecordClick = false;
        selectOnly(record.id);
        textTools.beginEdit(record, { caretPoint: { clientX: event.clientX, clientY: event.clientY } });
        return;
      }
      if (record.recordType === 'table') {
        if (event.ctrlKey || event.metaKey) toggleSelection(record.id);
        else selectOnly(record.id);
        return;
      }
      if (suppressRecordClick) {
        suppressRecordClick = false;
        return;
      }
      if (smartDimensionDelegate || featureCommandDelegate) return;
      const segmentIndex = Number(event.target.dataset.segmentIndex);
      const selectionOptions = {
        segmentIndex: Number.isInteger(segmentIndex) ? segmentIndex : null,
      };
      if (event.ctrlKey || event.metaKey) toggleSelection(record.id, selectionOptions);
      else selectOnly(record.id, selectionOptions);
    };
    record.group.addEventListener('pointerdown', handlePointerDown);
    record.group.addEventListener('click', handleClick);
    if (record.recordType !== 'table') {
      record.group.querySelectorAll('.selectable-entity').forEach((node) => {
        node.addEventListener('pointerdown', handlePointerDown);
        node.addEventListener('click', handleClick);
      });
    }
    if (record.recordType === 'dimension' && dimensionMode(record.entity) === 'driving' && record.entity.dimensionId) {
      const handleDimensionDoubleClick = (event) => {
        if (!isDimensionTextTarget(event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        selectOnly(record.id);
        openDimensionEditPanel(record);
      };
      // Give the dimension text priority over drag and canvas-level handlers.
      record.group.addEventListener('dblclick', handleDimensionDoubleClick, { capture: true });
    }
  }

  function addObject(entity, {
    snapRefs = [],
    autoConstrain = true,
    select = true,
    notify = true,
    solverAlreadyUpdated = false,
  } = {}) {
    const shouldAutoConstrain = autoConstrainEnabled && autoConstrain;
    const existingEntities = shouldAutoConstrain
      ? records
        .filter((record) => record.recordType === 'geometry' && isRecordInteractive(record))
        .map((record) => cloneEntity(record.entity))
      : [];
    const assignedEntity = stackSystem.assignEntity(classSystem.assignEntity(entity));
    const modelEntity = solverAlreadyUpdated
      ? solver.getEntity(entity.id) || assignedEntity
      : solver.addEntity(assignedEntity);
    const record = registerGeometryRecord(modelEntity);
    if (!record) return null;
    const pendingConstraintOutcomes = [];
    if (shouldAutoConstrain) {
      let solvedOutcome = null;
      const outcome = applyAutoConstraints({
        solver,
        entity: modelEntity,
        recordId: modelEntity.id,
        snapRefs,
        existingEntities,
        worldTolerance: 14 / camera.scale,
      });
      if (outcome?.then) {
        pendingConstraintOutcomes.push(Promise.resolve(outcome).then((resolved) => ({
          constraint: resolved?.committed ? resolved.constraints?.at(-1) : null,
          result: resolved?.result,
          snapshot: resolved?.snapshot,
        })));
      } else if (outcome?.committed) solvedOutcome = outcome;
      const changedEntityIds = solvedOutcome?.result?.changedEntityIds || [];
      if (changedEntityIds.length && solvedOutcome.snapshot) applySolverSnapshot(solvedOutcome.snapshot);
      else if (solvedOutcome?.committed && !notify) constraintOverlaySystem?.render?.();
    }
    syncGeometryStacking();
    if (select) selectOnly(record.id);
    setObjectSnapCandidate(null);
    if (pendingConstraintOutcomes.length) {
      Promise.all(pendingConstraintOutcomes).then((outcomes) => {
        const solved = outcomes.filter((outcome) => outcome?.constraint).at(-1);
        if (solved?.snapshot && solved.result?.changedEntityIds?.length) applySolverSnapshot(solved.snapshot);
        else if (solved && !notify) constraintOverlaySystem?.render?.();
        if (notify) notifyObjectChange();
      }).catch(() => {
        if (notify) notifyObjectChange();
      });
    } else if (notify) {
      notifyObjectChange();
    }
    return record;
  }

  function addObjects(entries, {
    autoConstrain = true,
    select = true,
    notify = true,
  } = {}) {
    const requestedEntries = (entries || []).filter(({ entity }) => entity);
    if (!requestedEntries.length) return [];
    const shouldAutoConstrain = autoConstrainEnabled && autoConstrain;
    const existingEntities = shouldAutoConstrain
      ? records
        .filter((record) => record.recordType === 'geometry' && isRecordInteractive(record))
        .map((record) => cloneEntity(record.entity))
      : [];
    const stagedEntries = requestedEntries.map(({ entity, snapRefs = [] }) => ({
      entity: stackSystem.assignEntity(classSystem.assignEntity(entity)),
      snapRefs,
    }));
    const constraints = shouldAutoConstrain
      ? detectAutoConstraintsForEntities({
        entries: stagedEntries,
        existingEntities,
        worldTolerance: 14 / camera.scale,
      })
      : [];
    if (constraints.length) {
      const outcome = solver.applyConstraintBatch({
        entities: stagedEntries.map(({ entity }) => entity),
        constraints,
      });
      if (outcome?.then) throw new Error('Batched drawing creation requires an immediate solver transaction.');
      if (!outcome?.committed) return [];
      const stagedIds = new Set(stagedEntries.map(({ entity }) => entity.id));
      const changedExistingGeometry = (outcome.result?.changedEntityIds || [])
        .some((entityId) => !stagedIds.has(entityId));
      if (changedExistingGeometry && outcome.snapshot) applySolverSnapshot(outcome.snapshot);
    } else {
      stagedEntries.forEach(({ entity }) => solver.addEntity(entity));
    }
    const created = stagedEntries.map(({ entity }) => registerGeometryRecord(
      solver.getEntity(entity.id) || entity,
    )).filter(Boolean);
    if (!notify) syncGeometryStacking();
    setObjectSnapCandidate(null);
    if (constraints.length && !notify) constraintOverlaySystem?.render?.();
    if (select && created.length) selectOnly(created.at(-1).id);
    if (notify && created.length) notifyObjectChange();
    return created;
  }

  function upsertAuxiliaryGeometry(entity) {
    const existing = records.find((record) => record.id === entity?.id && record.recordType === 'geometry');
    if (existing) {
      existing.entity = cloneEntity(solver.updateEntity(stackSystem.assignEntity(entity)));
      updateGeometryNode(existing);
      updateRecordHandles(existing);
      syncGeometryPresentation(existing);
      syncGeometryStacking();
      return cloneEntity(existing.entity);
    }
    return cloneEntity(addObject(entity, {
      autoConstrain: false,
      select: false,
      notify: false,
    })?.entity || null);
  }

  function updateObjectComposite(recordId, composite) {
    const record = records.find((candidate) => candidate.id === recordId && candidate.recordType === 'geometry');
    if (!record) return null;
    requestHistoryCheckpoint('object-composite-update');
    record.entity = cloneEntity(solver.updateEntity({
      ...record.entity,
      composite: cloneEntity(composite),
    }));
    updateGeometryNode(record);
    updateRecordHandles(record);
    syncGeometryPresentation(record);
    notifyObjectChange({ history: 'commit' });
    return cloneEntity(record.entity);
  }

  function addImage(inputEntity) {
    const record = imageTools.createRecord(normalizeImageEntity(stackSystem.assignEntity(inputEntity)));
    records.push(record);
    syncGeometryStacking();
    selectOnly(record.id);
    notifyObjectChange();
    return record;
  }

  function addText(inputEntity = {}) {
    const textEntity = createTextEntity(stackSystem.assignEntity(inputEntity));
    const assignedEntity = classSystem.assignEntity(textEntity, inputEntity.classId, {
      fresh: !inputEntity.classId,
    });
    const record = textTools.createRecord(solver.addEntity(assignedEntity));
    records.push(record);
    syncGeometryStacking();
    selectOnly(record.id);
    notifyObjectChange();
    return record;
  }

  function addTable(inputEntity = {}) {
    const tableEntity = stackSystem.assignEntity(normalizeTableEntity(inputEntity));
    solver.addEntity(tableTools.constraintEntity(tableEntity));
    const record = tableTools.createRecord(tableEntity);
    if (!record) return null;
    records.push(record);
    bindRecordEvents(record);
    syncGeometryStacking();
    selectOnly(record.id);
    notifyObjectChange();
    return record;
  }

  function beginTextEdit(recordOrId, options = {}) {
    const record = typeof recordOrId === 'string'
      ? records.find((candidate) => candidate.id === recordOrId)
      : recordOrId;
    if (record?.recordType !== 'text') return false;
    textTools.beginEdit(record, options);
    return true;
  }

  function addDimension(entity) {
    const target = entity.externalDrivingTarget;
    if (target?.type === 'fillet-radius') {
      const existing = records.find((record) => (
        record.recordType === 'dimension'
        && record.entity.dimensionMode === 'driving'
        && record.entity.externalDrivingTarget?.type === target.type
        && record.entity.externalDrivingTarget?.recordId === target.recordId
      ));
      if (existing) {
        selectOnly(existing.id);
        return existing;
      }
    }
    const dimensionResult = solver.addDimension(stackSystem.assignEntity(entity));
    applyManagedDimensionText(dimensionResult.entity);
    const record = createDimensionRecord({
      add,
      objectLayer,
      entity: cloneEntity(dimensionResult.entity),
      index: records.length,
      scale: camera.scale,
      updateRecordHandles,
      bindRecordEvents,
      onToggleExport: persistDrivenDimensionExport,
    });
    syncDimensionPresentation(record);
    promoteHandleGroup(record);
    records.push(record);
    applySolverSnapshot();
    selectOnly(record.id);
    notifyObjectChange();
    return record;
  }

  function notifyObjectChange({ history = 'coalesce' } = {}) {
    records.filter((record) => record.recordType === 'geometry').forEach(geometryAppearanceSystem.apply);
    records.filter((record) => record.recordType === 'text').forEach(textTools.updateRecord);
    subtractSystem.refreshPresentation();
    renderClosedRegions();
    notchSystem.refresh();
    seamLineSystem.refresh();
    syncState();
    objectChangeListeners.forEach((listener) => listener({ count: records.length, history }));
  }

  function requestHistoryCheckpoint(reason = 'generic') {
    window.dispatchEvent(new CustomEvent('paramagic:history-checkpoint', { detail: { reason } }));
  }

  function serializedDrawingExtensions() {
    const result = cloneEntity(loadedDrawingExtensions || {});
    drawingExtensionProviders.forEach((provider, key) => {
      const value = provider.serialize?.();
      if (value === null || value === undefined) delete result[key];
      else result[key] = cloneEntity(value);
    });
    return result;
  }

  function clearDrawingExtensions() {
    drawingExtensionProviders.forEach((provider) => provider.clear?.());
  }

  function restoreDrawingExtensions() {
    drawingExtensionProviders.forEach((provider, key) => {
      provider.restore?.(cloneEntity(loadedDrawingExtensions?.[key] ?? null));
    });
  }

  function registerDrawingExtension(key, provider = {}) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) throw new Error('Drawing extensions require a stable key.');
    drawingExtensionProviders.set(normalizedKey, provider);
    if (Object.prototype.hasOwnProperty.call(loadedDrawingExtensions, normalizedKey)) {
      provider.restore?.(cloneEntity(loadedDrawingExtensions[normalizedKey]));
    }
    return () => {
      provider.clear?.();
      drawingExtensionProviders.delete(normalizedKey);
    };
  }

  registerDrawingExtension('stacks', stackSystem.extensionProvider);

  const filletSystem = createFilletSystem({
    records,
    addSvg: add,
    objectLayer,
    arcPath,
    bindRecordEvents,
    cloneEntity,
    applyGeometryAppearance: geometryAppearanceSystem.apply,
    updateGeometryNode,
    selectOnly,
    formatDrawingNumber,
    requestHistoryCheckpoint,
    notifyObjectChange,
    syncGeometryStacking,
    renderClosedRegions,
    refreshLinkedDimensions,
    status,
    solver,
    addObject,
    applySolverSnapshot,
    removeObject(record) {
      const index = records.indexOf(record);
      if (index < 0) return;
      solver.removeEntity(record.id);
      removeRecordNodes(record);
      records.splice(index, 1);
    },
    assignClass: classSystem.assignEntity,
    assignStack: stackSystem.assignEntity,
  });

  function currentClosedCycles() {
    const topologyEntities = closedGeometryTopologyEntities(records
      .filter((record) => record.recordType === 'geometry' || record.recordType === 'fillet')
      .map((record) => record.entity));
    const fillets = topologyEntities.filter((entity) => entity.type === 'fillet' && entity.construction !== true);
    return findClosedGeometryCycles(
      evaluateFilletedGeometry(topologyEntities),
      filletTopologyConstraints(solver.constraints(), fillets),
    );
  }

  function currentResolvedBoundaries() {
    const topologyEntities = closedGeometryTopologyEntities(records
      .filter((record) => record.recordType === 'geometry' || record.recordType === 'fillet')
      .map((record) => record.entity));
    return resolveClosedBoundaries(topologyEntities, solver.constraints());
  }

  subtractSystem = createSubtractSystem({
    records,
    selectedIds,
    solver,
    addSvg: add,
    closedRegionNodes,
    geometryAppearance: geometryAppearanceSystem.appearance,
    applyGeometryAppearance: geometryAppearanceSystem.apply,
    fillPaint: imageFillSystem.paintFor,
    pointList,
    getScale: () => camera.scale,
    evaluateFilletedGeometry,
    getClosedCycles: currentClosedCycles,
    getResolvedBoundaries: currentResolvedBoundaries,
    getDerivedSubtractorOwners: (baseOwners) => [...subtractOperandProviders]
      .flatMap((provider) => provider.owners?.(baseOwners) || []),
    requestHistoryCheckpoint,
    notifyObjectChange,
    syncState,
    showStatusMessage: (message) => {
      if (!status) return;
      status.hidden = false;
      status.textContent = message;
    },
  });
  objectVisibilitySystem = createObjectVisibilitySystem({
    records,
    selectedIds,
    canvasElement: canvas,
    owners: subtractSystem.owners,
    ownerForRecord: subtractSystem.ownerForRecord,
    evaluateExpression: (expression) => solver.evaluateParameterExpression(expression),
    resolveEntityAppearance: (entity) => (
      isClassGeometryEntity(entity) ? classSystem.resolveAppearance(entity) : entity?.appearance || {}
    ),
    applyEntityAppearanceOverrides: (entity, appearance, patch) => (
      isClassGeometryEntity(entity)
        ? classSystem.applyAppearanceOverrides(entity, appearance, patch)
        : { ...entity, appearance }
    ),
    updateEntity: (entity) => solver.updateEntity(entity),
    updateEntityAppearances: (updates) => solver.updateEntityAppearances(updates),
    applyChangedEntity: (entity) => {
      const record = records.find((candidate) => candidate.id === entity.id);
      if (!record) return;
      record.entity = cloneEntity(entity);
      geometryAppearanceSystem.apply(record);
    },
    requestHistoryCheckpoint,
    notifyObjectChange,
    notifySelectionChange: emitSelectionChange,
  });

  const notchBoundaryResolver = createNotchBoundaryResolver({
    records,
    recordSegments,
    renderedEntityForRecord,
    evaluateFilletedGeometry,
    getClosedCycles: currentClosedCycles,
    getEntityFeature: (recordId, options) => getEntityFeature(recordId, options),
    getSegmentFeature: (recordId, index, options) => getSegmentFeature(recordId, index, options),
    arcCircle,
    screenToWorld,
    getSubtractBoundaryFeatures: subtractSystem.featuresForRecord,
    getSubtractBoundaryFeaturesForHost: subtractSystem.featuresForHost,
    getSubtractBoundaryFeature: subtractSystem.featureForHost,
    getSubtractBoundaryFeatureFromWorld: subtractSystem.featureFromWorld,
    getSubtractBoundaryInwardTarget: subtractSystem.inwardTargetForFeature,
    getResolvedBoundaries: currentResolvedBoundaries,
  });

  const notchSystem = createNotchSystem({
    records,
    addSvg: add,
    objectLayer,
    bindRecordEvents,
    updateRecordHandles,
    featureForHost: notchBoundaryResolver.featureForHost,
    inwardTargetForHost: notchBoundaryResolver.inwardTarget,
    boundaryFeaturesForHost: notchBoundaryResolver.boundaryFeatures,
    isClosedHostFeature: notchBoundaryResolver.isClosedHost,
    requestHistoryCheckpoint,
    notifyObjectChange,
    syncState,
    showStatusMessage: (message) => { if (status) status.textContent = message; },
    solver,
    getPointFeature,
    getSegmentFeature,
    refreshLinkedDimensions,
    reapplySolverSnapshot: applySolverSnapshot,
    getScale: () => camera.scale,
    assignStack: stackSystem.assignEntity,
  });

  seamLineSystem = createSeamLineSystem({
    records,
    selectedIds,
    notchBoundaryResolver,
    subtractOwnerForRecord: subtractSystem.ownerForRecord,
    subtractFeaturesForRecord: subtractSystem.featuresForRecord,
    screenToWorld,
    requestHistoryCheckpoint,
    notifyObjectChange,
    syncGeometryStacking,
    getScale: () => camera.scale,
    getDrawingSnapshot: () => drawingSnapshot(),
    resolvePresentationHost: (ownerRecordId) => {
      const record = records.find((candidate) => candidate.id === ownerRecordId);
      return record?.group ? {
        container: record.group,
        before: record.hitNode || record.segmentGroup || record.handleGroup || null,
      } : null;
    },
    isStackVisible: stackSystem.isStackVisible,
    isStackActive: stackSystem.isStackActive,
  });
  registerDrawingExtension('seamLines', seamLineSystem.extensionProvider);

  function setPreview(entity) {
    clearPreview();
    previewNode = createGeometryNode(previewLayer, entity, 'preview-entity');
  }

  function setPreviewEntities(entities = [], className = '') {
    clearPreview();
    if (!entities.length) return;
    previewNode = add(previewLayer, 'g', {
      class: ['multi-entity-preview', className].filter(Boolean).join(' '),
    });
    entities.forEach((entity) => {
      createGeometryNode(previewNode, entity, 'preview-entity');
    });
  }

  function clearPreview() {
    tableTools.clearPreview?.();
    if (previewNode) {
      previewNode.remove();
      previewNode = null;
    }
    if (dimensionPreviewRecord) {
      dimensionPreviewRecord.group.remove();
      dimensionPreviewRecord = null;
    }
  }

  function setDimensionPreview(entity) {
    if (dimensionPreviewRecord) dimensionPreviewRecord.group.remove();
    dimensionPreviewRecord = createDimensionRecord({
      add,
      objectLayer: previewLayer,
      entity: cloneEntity(entity),
      index: 'preview',
      scale: camera.scale,
      updateRecordHandles: () => {},
      bindRecordEvents: () => {},
    });
    dimensionPreviewRecord.group.classList.add('smart-dimension-preview');
  }

  function setSmartDimensionFeatureSelection(features) {
    [objectLayer, handleLayer, interactionLayer].forEach((layer) => {
      layer.querySelectorAll('.smart-selected').forEach((node) => {
        node.classList.remove('smart-selected');
        if (node.classList.contains('point-handle')) {
          node.style.pointerEvents = '';
          if (!node.classList.contains('selected')) setHandleHighlight(node, false);
        }
        if (node.classList.contains('segment-select-line')) setSegmentHighlight(node, false);
      });
    });
    features.forEach((feature) => {
      feature.node?.classList?.add('smart-selected');
      if (feature.node?.classList?.contains('point-handle')) {
        feature.node.style.pointerEvents = 'none';
        setHandleHighlight(feature.node, true);
      }
      if (feature.node?.classList?.contains('segment-select-line')) setSegmentHighlight(feature.node, true);
    });
  }

  function featureFromEvent(event, options = {}) {
    const target = event.paramagicSelectionTarget || event.target;
    if (target.closest?.('[data-canvas-origin-point]')) {
      // The origin hit circle is rendered above the handle layer. When a
      // constrained table corner is coincident with 0,0, inspect the rendered
      // stack so the table corner remains selectable by the feature tools.
      const renderedTargets = typeof document.elementsFromPoint === 'function'
        ? document.elementsFromPoint(event.clientX, event.clientY)
        : [];
      for (const renderedTarget of renderedTargets) {
        const tableHandleGroup = renderedTarget.closest?.('.table-handle-group');
        const tableRecord = records.find((record) => (
          record.recordType === 'table'
          && record.id === tableHandleGroup?.dataset.recordId
        ));
        if (!tableRecord) continue;
        const feature = tableTools.featureFromEvent({ target: renderedTarget }, tableRecord);
        if (feature) return feature;
      }
      return canvasOriginPointFeature(originHandle);
    }
    const tableRecord = records.find((record) => record.recordType === 'table' && record.id === target.closest?.('.table-record, .table-handle-group')?.dataset.recordId);
    if (tableRecord) {
      const feature = tableTools.featureFromEvent(event, tableRecord);
      if (feature) return feature;
    }
    if (options.rendered) {
      for (const provider of derivedDimensionFeatureProviders) {
        const feature = provider.featureFromEvent?.({
          target,
          clientX: event.clientX,
          clientY: event.clientY,
          world: screenToWorld(event.clientX, event.clientY),
          mode: options.dimensionMode,
        });
        if (feature) return feature;
      }
    }
    return dimensionLinkManager.getFeatureFromEvent({
      target,
      clientX: event.clientX,
      clientY: event.clientY,
    }, options);
  }

  function syncState({ changedRecordIds = null, refreshPresentation = true } = {}) {
    if (refreshPresentation) {
      syncStackPresentation();
      objectVisibilitySystem.syncPresentation(closedRegionNodes);
      syncDimensionDependencyStates();
    }
    const stateRecords = changedRecordIds
      ? [...changedRecordIds].map((recordId) => (
        records.find((record) => record.id === recordId)
      )).filter(Boolean)
      : records;
    stateRecords.forEach((record) => {
      const isSelected = selectedIds.has(record.id);
      const recordSelectedSegments = selectedSegments.get(record.id);
      const hasSelectedSegment = Boolean(recordSelectedSegments?.size);
      record.group.classList.toggle('selected', isSelected);
      record.group.classList.toggle('segment-selected', hasSelectedSegment);
      record.group.classList.toggle('hovered', hoveredId === record.id);
      record.handleGroup?.classList.toggle('hovered', hoveredId === record.id);
      record.group.classList.toggle('handles-hovered', record.handles.some((handle) => handle.classList.contains('hovered')));
      record.syncState?.(
        isSelected,
        hoveredId === record.id,
        Boolean(featureCommandDelegate || smartDimensionDelegate),
      );
      if (record.recordType === 'image') {
        imageTools.syncRecord(record, isSelected);
        return;
      }
      if (record.recordType === 'table') {
        record.handles.forEach((handle, index) => {
          const isActiveHandle = handleDrag?.record === record && handleDrag.handleIndex === index;
          handle.classList.toggle('selected', isActiveHandle);
          setHandleHighlight(handle, isActiveHandle || handle.classList.contains('smart-selected'));
        });
        return;
      }
      record.group.querySelectorAll('.selectable-entity').forEach((node) => {
        const isSegment = node.classList.contains('segment-select-line');
        const isSelectedSegment = isSegment
          && Boolean(recordSelectedSegments?.has(Number(node.dataset.segmentIndex)));
        node.classList.toggle('selected', isSelectedSegment || (isSelected && !hasSelectedSegment));
        node.classList.toggle('segment-selected', isSelectedSegment);
        node.classList.toggle('hovered', hoveredId === record.id);
      });
      record.handles.forEach((handle, index) => {
        const isActiveHandle = handleDrag?.record === record && handleDrag.handleIndex === index;
        handle.classList.toggle('selected', isActiveHandle);
        setHandleHighlight(handle, isActiveHandle || handle.classList.contains('smart-selected'));
      });
    });
    if (!changedRecordIds) {
      objectLayer.querySelectorAll('.closed-constrained-region').forEach((region) => {
        const parentIds = (region.dataset.parentIds || '').split(',').filter(Boolean);
        region.classList.toggle('selected', parentIds.length > 0 && parentIds.every((id) => selectedIds.has(id)));
      });
    }
    if (!changedRecordIds || (hoveredId && changedRecordIds.has(hoveredId))) refreshHoverHighlight();
    if (!changedRecordIds) emitSelectionChange();
    if (!changedRecordIds || (dimensionEdit?.record?.id && changedRecordIds.has(dimensionEdit.record.id))) {
      positionDimensionEditPanel();
    }
  }

  function dimensionParameterOptions(excludeId = null) {
    return solver.parameters()
      .filter((entry) => entry.name && entry.id !== excludeId && !entry.error)
      .map((entry) => ({
        name: entry.name,
        label: entry.kind === 'dimension' ? `${entry.name} (dimension)` : entry.name,
      }));
  }

  function populateExpressionOptions(target, excludeId = null) {
    target.replaceChildren(...dimensionParameterOptions(excludeId).map((entry) => {
      const option = document.createElement('option');
      option.value = entry.name;
      option.label = entry.label;
      return option;
    }));
  }

  function positionDimensionEditPanel() {
    if (!dimensionEdit || dimensionEditPanel.hidden) return;
    const record = dimensionEdit.record;
    const anchor = record?.expressionAnchor?.() || record?.entity?.label;
    if (!Array.isArray(anchor) || anchor.length < 2) return;
    const [screenX, screenY] = worldToScreen(anchor);
    const padding = 8;
    const panelWidth = dimensionEditPanel.offsetWidth || 260;
    const panelHeight = dimensionEditPanel.offsetHeight || 92;
    const fitsRight = screenX + 14 + panelWidth <= canvas.clientWidth - padding;
    const rawLeft = fitsRight ? screenX + 14 : screenX - panelWidth - 14;
    const left = Math.max(padding, Math.min(canvas.clientWidth - panelWidth - padding, rawLeft));
    const top = Math.max(padding, Math.min(canvas.clientHeight - panelHeight - padding, screenY - panelHeight / 2));
    dimensionEditPanel.style.left = `${left}px`;
    dimensionEditPanel.style.top = `${top}px`;
  }

  function closeDimensionEditPanel() {
    dimensionEdit = null;
    dimensionEditPanel.hidden = true;
    dimensionEditPanel.classList.remove('invalid');
    dimensionEditInput.value = '';
    dimensionEditLabelText.textContent = 'Dimension';
    dimensionEditError.textContent = '';
  }

  function openDimensionEditPanel(record) {
    const isControl = Boolean(record?.updateExpression);
    if (!record || (!isControl && (record.recordType !== 'dimension' || dimensionMode(record.entity) !== 'driving' || !record.entity.dimensionId)) || (isControl && dimensionTextMode === 'value')) return;
    const parameterId = record.expressionParameterId?.() || record.entity.dimensionId;
    const current = solver.dimensions.get(parameterId);
    if (!current) return;
    selectOnly(record.id);
    dimensionEdit = { record, dimensionId: parameterId };
    dimensionEditLabelText.textContent = record.expressionLabel?.() || 'Dimension';
    populateExpressionOptions(dimensionEditOptions, parameterId);
    dimensionEditInput.value = expressionWithoutUnits(current.expression || '');
    dimensionEditError.textContent = '';
    dimensionEditPanel.classList.remove('invalid');
    dimensionEditPanel.hidden = false;
    positionDimensionEditPanel();
    requestAnimationFrame(() => {
      positionDimensionEditPanel();
      dimensionEditInput.focus();
      dimensionEditInput.select();
    });
  }

  function submitDimensionEditPanel() {
    if (!dimensionEdit) return;
    const current = solver.dimensions.get(dimensionEdit.dimensionId);
    const expression = dimensionEditInput.value.trim();
    if (!expression) {
      dimensionEditPanel.classList.add('invalid');
      dimensionEditError.textContent = 'Enter a value, expression, or parameter name.';
      return;
    }
    if (expression === current?.expression) {
      closeDimensionEditPanel();
      return;
    }
    const externalTarget = dimensionEdit.record.entity.externalDrivingTarget;
    if (externalTarget?.type === 'fillet-radius') {
      const validation = filletSystem.validateRadiusExpression(externalTarget.recordId, expression);
      if (!validation.valid) {
        dimensionEditPanel.classList.add('invalid');
        dimensionEditError.textContent = validation.error;
        return;
      }
    }
    if (externalTarget?.type === 'notch-distance') {
      let value;
      try {
        value = solver.evaluateDrawingLengthExpression(expression);
      } catch (error) {
        dimensionEditPanel.classList.add('invalid');
        dimensionEditError.textContent = error.message;
        return;
      }
      const validation = notchSystem.applyDistanceTarget(
        externalTarget,
        dimensionEdit.record.entity.subtype,
        value,
      );
      if (!validation.valid) {
        dimensionEditPanel.classList.add('invalid');
        dimensionEditError.textContent = validation.error;
        return;
      }
    }
    const result = dimensionEdit.record.updateExpression?.(expression)
      || (solver.setDimensionAuthoritative
        ? solver.setDimensionAuthoritative(dimensionEdit.dimensionId, expression)
        : solver.setDimension(dimensionEdit.dimensionId, expression));
    if (result && typeof result.then === 'function') {
      const pendingEdit = dimensionEdit;
      dimensionEditInput.disabled = true;
      dimensionEditPanel.classList.add('pending');
      result.then((resolved) => {
        dimensionEditInput.disabled = false;
        dimensionEditPanel.classList.remove('pending');
        if (dimensionEdit !== pendingEdit) return;
        finishDimensionEdit(resolved);
      }).catch((error) => {
        dimensionEditInput.disabled = false;
        dimensionEditPanel.classList.remove('pending');
        if (dimensionEdit !== pendingEdit) return;
        dimensionEditPanel.classList.add('invalid');
        dimensionEditError.textContent = error.message || 'Dimension could not be applied.';
      });
      return;
    }
    finishDimensionEdit(result);
  }

  function finishDimensionEdit(result) {
    if (result.status === 'converged' || result.status === 'unchanged') {
      applySolverSnapshot();
      const record = dimensionEdit.record;
      if (record.updateNode) {
        record.updateNode();
        record.updateHandles?.();
      } else {
        applyManagedDimensionText(record.entity);
        record.text.textContent = record.entity.text;
        updateDimensionNode(record, camera.scale);
      }
      closeDimensionEditPanel();
      notifyObjectChange();
      return;
    }
    dimensionEditPanel.classList.add('invalid');
    dimensionEditError.textContent = result.message || 'Dimension could not be applied.';
  }

  function selectionProperties() {
    const allSelectedGeometry = records.filter((record) => (
      selectedIds.has(record.id)
      && ['geometry', 'fillet'].includes(record.recordType)
    ));
    const allSelectedImages = records.filter((record) => selectedIds.has(record.id) && record.recordType === 'image');
    const allSelectedTexts = records.filter((record) => selectedIds.has(record.id) && record.recordType === 'text');
    const selectedGeometry = allSelectedGeometry.filter((record) => !record.entity.construction);
    const selectedImages = allSelectedImages.filter((record) => !record.entity.construction);
    const selectedTexts = allSelectedTexts;
    const appearanceProperties = geometryAppearanceSystem.selectionProperties();
    const seamLineProperties = seamLineSystem.properties();
    const allSelectedObjects = [...allSelectedGeometry, ...allSelectedImages];
    const constructionCount = allSelectedObjects.filter((record) => record.entity.construction).length;
    const resolvedTexts = selectedTexts.map((record) => ({
      record,
      entity: { ...record.entity, ...classSystem.resolveEntityProperties(record.entity) },
    }));
    const fontNames = new Set(resolvedTexts.map(({ entity }) => entity.fontName));
    const fontSizes = new Set(resolvedTexts.map(({ entity }) => entity.fontSize));
    const fontColors = new Set(resolvedTexts.map(({ entity }) => entity.fontColor));
    const scaleWithZoomValues = new Set(resolvedTexts.map(({ entity }) => entity.scaleWithZoom !== false));
    const multilineValues = new Set(resolvedTexts.map(({ entity }) => entity.multiline !== false));
    const textAlignValues = new Set(resolvedTexts.map(({ entity }) => entity.textAlign || 'left'));
    const textVerticalAlignValues = new Set(resolvedTexts.map(({ entity }) => entity.textVerticalAlign || 'top'));
    const visibilityProperties = objectVisibilitySystem?.selectedProperties() || {
      canEditVisible: false,
      visible: null,
      mixedVisible: false,
      visibleExpression: null,
      errors: { visible: null },
    };
    const properties = {
      selectionCount: selectedIds.size,
      recordIds: [...selectedIds],
      geometryCount: allSelectedGeometry.length,
      imageCount: allSelectedImages.length,
      textCount: allSelectedTexts.length,
      supportedCount: selectedGeometry.length + selectedImages.length + selectedTexts.length,
      ids: [...selectedGeometry, ...selectedImages, ...selectedTexts].map((record) => record.id),
      ...appearanceProperties,
      construction: allSelectedObjects.length > 0 && constructionCount === allSelectedObjects.length,
      mixedConstruction: constructionCount > 0 && constructionCount < allSelectedObjects.length,
      canEditSeamLine: seamLineProperties.canEditSeamLine,
      seamLine: seamLineProperties.seamLine,
      mixedSeamLine: seamLineProperties.mixedSeamLine,
      canEditConstruction: allSelectedGeometry.length > 0 && allSelectedImages.length === 0,
      canEditText: selectedTexts.length > 0 && selectedIds.size === selectedTexts.length,
      ...visibilityProperties,
      fontName: fontNames.size === 1 ? resolvedTexts[0].entity.fontName : null,
      fontSize: fontSizes.size === 1 ? resolvedTexts[0].entity.fontSize : null,
      fontColor: fontColors.size === 1 ? resolvedTexts[0].entity.fontColor : null,
      scaleWithZoom: scaleWithZoomValues.size === 1 ? resolvedTexts[0].entity.scaleWithZoom !== false : null,
      multiline: multilineValues.size === 1 ? resolvedTexts[0].entity.multiline !== false : null,
      textAlign: textAlignValues.size === 1 ? resolvedTexts[0].entity.textAlign || 'left' : null,
      textVerticalAlign: textVerticalAlignValues.size === 1 ? resolvedTexts[0].entity.textVerticalAlign || 'top' : null,
      locked: allSelectedImages.length > 0 && allSelectedImages.every((record) => record.entity.locked),
      ...classSystem.selectionClassProperties(),
      errors: {
        ...appearanceProperties.errors,
        visible: visibilityProperties.errors?.visible || null,
      },
    };
    selectionPropertyProviders.forEach((provider) => {
      const patch = provider.selectionProperties?.();
      if (!patch) return;
      const errors = { ...properties.errors, ...(patch.errors || {}) };
      Object.assign(properties, patch, { errors });
    });
    return properties;
  }

  function emitSelectionChange() {
    const properties = selectionProperties();
    const fingerprint = JSON.stringify(properties);
    if (fingerprint === lastSelectionFingerprint) return;
    lastSelectionFingerprint = fingerprint;
    selectionChangeListeners.forEach((listener) => listener(cloneEntity(properties)));
  }

  function setHandleHighlight(handle, value) {
    const featureSelected = value && handle.classList.contains('smart-selected');
    handle.style.stroke = value ? '#0000FF' : '';
    handle.style.filter = '';
    handle.style.fill = featureSelected ? '#7F00FF' : value ? 'transparent' : '';
    if (value) {
      handle.setAttribute('stroke', '#0000FF');
      handle.setAttribute('fill', featureSelected ? '#7F00FF' : 'transparent');
    } else {
      handle.removeAttribute('stroke');
      handle.removeAttribute('fill');
    }
  }

  function setSegmentHighlight(segment, value) {
    if (value) {
      segment.setAttribute('stroke', 'rgba(0,0,255,.58)');
      segment.setAttribute('stroke-width', '1.5');
      segment.style.stroke = 'rgba(0,0,255,.58)';
      segment.style.strokeWidth = '1.5px';
      segment.style.filter = '';
    } else {
      segment.removeAttribute('stroke');
      segment.removeAttribute('stroke-width');
      segment.style.stroke = '';
      segment.style.strokeWidth = '';
      segment.style.filter = '';
    }
  }

  function selectOnly(id, { segmentIndex = null } = {}) {
    overlapSelectionCycler?.clear();
    if (dimensionEdit && dimensionEdit.record.id !== id) closeDimensionEditPanel();
    selectedIds.clear();
    selectedSegments.clear();
    const record = records.find((candidate) => candidate.id === id);
    if (isRecordInteractive(record)) {
      selectedIds.add(id);
      selectedSegment = Number.isInteger(segmentIndex)
        ? { recordId: id, index: segmentIndex }
        : null;
      if (selectedSegment) selectedSegments.set(id, new Set([segmentIndex]));
    } else {
      selectedSegment = null;
    }
    syncState();
  }

  function toggleSelection(id, { segmentIndex = null } = {}) {
    overlapSelectionCycler?.clear();
    if (dimensionEdit && dimensionEdit.record.id !== id) closeDimensionEditPanel();
    const record = records.find((candidate) => candidate.id === id);
    if (!isRecordInteractive(record)) return false;
    if (Number.isInteger(segmentIndex)) {
      const indices = new Set(selectedSegments.get(id) || []);
      if (indices.has(segmentIndex)) indices.delete(segmentIndex);
      else indices.add(segmentIndex);
      if (indices.size) {
        selectedIds.add(id);
        selectedSegments.set(id, indices);
        selectedSegment = { recordId: id, index: segmentIndex };
      } else {
        selectedIds.delete(id);
        selectedSegments.delete(id);
        selectedSegment = [...selectedSegments.entries()].flatMap(([recordId, values]) => (
          [...values].map((index) => ({ recordId, index }))
        )).at(-1) || null;
      }
    } else if (selectedIds.has(id)) {
      selectedIds.delete(id);
      selectedSegments.delete(id);
      if (selectedSegment?.recordId === id) selectedSegment = null;
    } else {
      selectedIds.add(id);
      selectedSegments.delete(id);
      selectedSegment = null;
    }
    syncState();
    return true;
  }

  function selectRecords(ids = []) {
    overlapSelectionCycler?.clear();
    selectedIds.clear();
    selectedSegment = null;
    selectedSegments.clear();
    seamLineSystem.clearPropertyFeature();
    ids.forEach((id) => {
      const record = records.find((candidate) => candidate.id === id);
      if (isRecordInteractive(record)) selectedIds.add(id);
    });
    syncState();
  }

  function toggleRecords(ids = []) {
    overlapSelectionCycler?.clear();
    const interactiveIds = ids.filter((id) => (
      isRecordInteractive(records.find((record) => record.id === id))
    ));
    const remove = interactiveIds.length > 0 && interactiveIds.every((id) => selectedIds.has(id));
    interactiveIds.forEach((id) => {
      if (remove) selectedIds.delete(id);
      else selectedIds.add(id);
      selectedSegments.delete(id);
    });
    selectedSegment = null;
    syncState();
  }

  function clearSelection() {
    overlapSelectionCycler?.clear();
    closeDimensionEditPanel();
    selectedIds.clear();
    selectedSegment = null;
    selectedSegments.clear();
    seamLineSystem.clearPropertyFeature();
    syncState();
  }

  overlapSelectionCycler = createOverlapSelectionCycler({
    objectLayer,
    handleLayer,
    indicatorLayer: overlapCycleLayer,
    records,
    isRecordCandidate: isRecordInteractive,
    selectRecord: (recordId, options = {}) => {
      if (options.additive) toggleSelection(recordId, options);
      else selectOnly(recordId, options);
    },
  });

  function setSelectedGeometryAppearance(patch = {}) {
    const tableUpdate = tableTools.setSelectedAppearance(selectedIds, patch);
    if (tableUpdate.handled) return { success: tableUpdate.success, error: tableUpdate.error || null };
    return geometryAppearanceSystem.setSelectedAppearance(patch);
  }

  function setSelectedTextProperties(patch = {}) {
    if (tableTools.setSelectedTextProperties(selectedIds, patch)) return true;
    const selectedTexts = records.filter((record) => selectedIds.has(record.id) && record.recordType === 'text');
    if (!selectedTexts.length) return false;
    selectedTexts.forEach((record) => textTools.updateProperties(record, patch));
    notifyObjectChange();
    return true;
  }

  function setSelectedConstruction(construction) {
    const selectedGeometry = records.filter((record) => selectedIds.has(record.id) && ['geometry', 'fillet'].includes(record.recordType));
    if (!selectedGeometry.length) return false;
    selectedGeometry.filter((record) => record.recordType === 'geometry').forEach((record) => {
      const next = classSystem.applyEntityPropertyOverrides(record.entity, { construction: Boolean(construction) });
      record.entity = cloneEntity(solver.updateEntity(next));
      syncGeometryClasses(record);
      geometryAppearanceSystem.apply(record);
      syncGeometryPresentation(record);
    });
    selectedGeometry.filter((record) => record.recordType === 'fillet').forEach((record) => {
      record.entity = classSystem.applyEntityPropertyOverrides(record.entity, { construction: Boolean(construction) });
      solver.setDerivedEntity(record.entity);
      filletSystem.updateRecord(record);
      syncGeometryPresentation(record);
    });
    syncGeometryStacking();
    renderClosedRegions();
    notifyObjectChange();
    return true;
  }

  function arrangeRecordIds(recordIds, action) {
    const order = editableStackOrder();
    const requested = new Set(recordIds);
    const selected = new Set(order.filter((record) => requested.has(record.id)).map((record) => record.id));
    if (!selected.size) return false;
    let arranged = [...order];
    if (action === 'front') arranged = [...arranged.filter((record) => !selected.has(record.id)), ...arranged.filter((record) => selected.has(record.id))];
    if (action === 'back') arranged = [...arranged.filter((record) => selected.has(record.id)), ...arranged.filter((record) => !selected.has(record.id))];
    if (action === 'forward') {
      for (let index = arranged.length - 2; index >= 0; index -= 1) {
        if (!selected.has(arranged[index].id) || selected.has(arranged[index + 1].id)) continue;
        [arranged[index], arranged[index + 1]] = [arranged[index + 1], arranged[index]];
      }
    }
    if (action === 'backward') {
      for (let index = 1; index < arranged.length; index += 1) {
        if (!selected.has(arranged[index].id) || selected.has(arranged[index - 1].id)) continue;
        [arranged[index - 1], arranged[index]] = [arranged[index], arranged[index - 1]];
      }
    }
    if (!['front', 'back', 'forward', 'backward'].includes(action)) return false;
    if (arranged.every((record, index) => record.id === order[index].id)) return false;
    const updates = arranged.map((record, zIndex) => ({ record, zIndex, appearance: { ...(record.entity.appearance || {}), zIndex } }));
    const changed = solver.updateEntityAppearances(updates
      .filter(({ record }) => record.recordType === 'geometry')
      .map(({ record, appearance }) => ({ id: record.id, appearance })));
    changed.forEach((entity) => {
      const record = records.find((candidate) => candidate.id === entity.id);
      if (record) record.entity = cloneEntity(entity);
    });
    updates.filter(({ record }) => record.recordType === 'image').forEach(({ record, appearance }) => {
      record.entity.appearance = appearance;
      imageTools.updateRecord(record);
    });
    updates.filter(({ record }) => record.recordType === 'text').forEach(({ record, appearance }) => {
      record.entity.appearance = appearance;
      textTools.updateRecord(record);
    });
    updates.filter(({ record }) => record.recordType === 'table').forEach(({ record, appearance }) => {
      record.entity.appearance = appearance;
      tableTools.updateRecord(record);
    });
    updates.filter(({ record }) => record.updateNode).forEach(({ record, appearance }) => {
      const next = { ...record.entity, appearance };
      if (record.recordType === 'table') return;
      if (record.updateEntity) record.updateEntity(next);
      else {
        record.entity = cloneEntity(solver.updateEntity(next));
        record.updateNode();
      }
    });
    syncGeometryStacking();
    notifyObjectChange();
    syncState();
    return true;
  }

  function arrangeSelectedGeometry(action) {
    return arrangeRecordIds([...selectedIds], action);
  }

  function deleteSelection({ checkpoint = true, notify = true } = {}) {
    if (!selectedIds.size) return;
    const selectedTableRows = records.find((record) => (
      selectedIds.size === 1
      && selectedIds.has(record.id)
      && record.recordType === 'table'
      && record.tableSelection?.rows?.size
    ));
    if (selectedTableRows && tableTools.deleteSelectedRows(selectedTableRows, { checkpoint, notify })) return;
    if (checkpoint) requestHistoryCheckpoint('delete-selection');
    const selectedGeometryIds = new Set(records
      .filter((record) => selectedIds.has(record.id) && ['geometry', 'fillet'].includes(record.recordType))
      .map((record) => record.id));
    const deletionIds = new Set([...selectedIds].filter((id) => {
      const record = records.find((candidate) => candidate.id === id);
      return !(record?.recordType === 'image' && record.entity.locked);
    }));
    if (!deletionIds.size) return;
    records.forEach((record) => {
      if (dimensionReferencesAny(record, deletionIds)) deletionIds.add(record.id);
      if (
        record.recordType === 'fillet'
        && [record.entity.sourceA.recordId, record.entity.sourceB.recordId].some((id) => selectedGeometryIds.has(id))
      ) deletionIds.add(record.id);
    });
    notchSystem.includeDependentDeletionIds(deletionIds, selectedGeometryIds);
    notchSystem.includeDependentDeletionIds(deletionIds, deletionIds);
    seamLineSystem.removeReferences([...deletionIds]);
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (!deletionIds.has(records[index].id)) continue;
      if (['geometry', 'text', 'control', 'table'].includes(records[index].recordType)) solver.removeEntity(records[index].id);
      records[index].dispose?.();
      if (records[index].recordType === 'fillet') solver.removeDerivedEntity(records[index].id);
      if (records[index].recordType === 'dimension' && records[index].entity.dimensionId) solver.removeDimension(records[index].entity.dimensionId);
      removeRecordNodes(records[index]);
      records.splice(index, 1);
    }
    constraintOverlaySystem?.prune?.();
    deletionIds.forEach((id) => selectedIds.delete(id));
    hoveredId = null;
    filletSystem.refreshPresentation();
    subtractSystem.refreshPresentation();
    syncState();
    if (notify) notifyObjectChange({ history: 'commit' });
  }

  function deleteRecords(recordIds = [], { checkpoint = true, notify = true } = {}) {
    selectRecords(recordIds);
    deleteSelection({ checkpoint, notify });
  }

  function setRecordStackIds(recordIds = [], stackId, { checkpoint = true, notify = true } = {}) {
    if (!stackSystem.stack(stackId)) return false;
    const targetIds = new Set(recordIds);
    const targets = records.filter((record) => targetIds.has(record.id));
    if (!targets.length) return false;
    if (checkpoint) requestHistoryCheckpoint('move-to-stack');
    targets.forEach((record) => {
      const next = stackSystem.assignEntity({ ...record.entity, stackId }, stackId);
      if (['geometry', 'text', 'control'].includes(record.recordType)) {
        record.entity = cloneEntity(solver.updateEntity(next));
      } else {
        record.entity = next;
        if (record.recordType === 'fillet') solver.setDerivedEntity(next);
        if (record.recordType === 'dimension' && record.entity.dimensionId) {
          solver.updateDimensionAnnotation(record.entity.dimensionId, next);
        }
      }
      updateRecordNode(record);
      updateRecordHandles(record);
    });
    syncStackPresentation();
    syncGeometryStacking();
    constraintOverlaySystem?.render?.();
    if (notify) notifyObjectChange({ history: 'commit' });
    return true;
  }

  function moveSelectionToStack(stackId) {
    return setRecordStackIds([...selectedIds], stackId);
  }

  function removeStack(stackId) {
    const target = stackSystem.stack(stackId);
    if (!target?.removable) return false;
    requestHistoryCheckpoint('stack-remove');
    setRecordStackIds(stackSystem.recordIdsForStack(stackId), 'stack-default', { checkpoint: false, notify: false });
    return stackSystem.removeStack(stackId);
  }

  function clearDrawing() {
    if (solveFrame !== null) cancelAnimationFrame(solveFrame);
    solveFrame = null;
    textTools.finishEditing();
    closeDimensionEditPanel();
    pendingSolveRecords.clear();
    clearDrawingExtensions();
    classSystem.restore(null, { notify: true, propagate: false });
    loadedDrawingExtensions = {};
    records.splice(0).forEach(removeRecordNodes);
    imageFillSystem.clear();
    solver.clear();
    constraintOverlaySystem?.clear?.();
    selectedIds.clear();
    seamLineSystem.clearPropertyFeature();
    hoveredId = null;
    clearPreview();
    setObjectSnapCandidate(null);
    constraintOverlaySystem?.render?.();
    syncState();
    notifyObjectChange();
  }

  function loadDrawingData(snapshot, { zoomToFit = true, history = 'coalesce' } = {}) {
    const preparedSnapshot = seamLineSystem.prepareDrawingLoad(snapshot || {});
    if (solveFrame !== null) cancelAnimationFrame(solveFrame);
    solveFrame = null;
    closeDimensionEditPanel();
    pendingSolveRecords.clear();
    clearDrawingExtensions();
    loadedDrawingExtensions = cloneEntity(preparedSnapshot.extensions || {});
    stackSystem.restore(loadedDrawingExtensions.stacks);
    classSystem.restore(preparedSnapshot, { notify: true, propagate: false });
    records.splice(0).forEach(removeRecordNodes);
    imageFillSystem.clear();
    selectedIds.clear();
    seamLineSystem.clearPropertyFeature();
    hoveredId = null;
    clearPreview();
    objectSnapCandidate = null;
    constraintOverlaySystem?.clear?.();
    const loadedEntities = preparedSnapshot.entities || [];
    const legacyBooleanIds = new Set(loadedEntities
      .filter((entity) => entity?.type === 'smart-boolean')
      .map((entity) => entity.id));
    const sourceEntities = loadedEntities.filter((entity) => (
      entity?.type !== 'smart-boolean'
      && !(isNotchEntity(entity) && legacyBooleanIds.has(entity.host?.recordId))
    )).map((entity) => stackSystem.assignEntity(
      classSystem.assignEntity(entity, entity.classId, { legacy: !entity.classId }),
      entity.stackId,
    ));
    const dimensionAnnotations = (preparedSnapshot.dimensionAnnotations || preparedSnapshot.annotations || [])
      .map((entity) => stackSystem.assignEntity(entity, entity.stackId));
    const solverEntities = [
      ...sourceEntities.filter((entity) => entity.type !== 'table'),
      ...sourceEntities.filter((entity) => entity.type === 'table').map((entity) => tableTools.constraintEntity(entity)),
    ];
    solver.loadSketch({
      ...preparedSnapshot,
      dimensionAnnotations,
      entities: solverEntities.filter((entity) => (
        entity.type !== 'image'
        && !isFilletEntity(entity)
        && !isNotchEntity(entity)
      )),
      derivedEntities: sourceEntities.filter((entity) => isFilletEntity(entity)),
    });
    const geometryEntities = solver.getGeometrySnapshot();
    const modelEntities = new Map(geometryEntities.map((entity) => [entity.id, entity]));
    sourceEntities.forEach((entity, index) => {
      const record = isImageEntity(entity)
        ? imageTools.createRecord(entity)
        : isTextEntity(entity)
          ? textTools.createRecord(modelEntities.get(entity.id) || entity)
        : entity.type === 'table'
          ? tableTools.createRecord(entity)
        : isFilletEntity(entity)
          ? filletSystem.createRecord(entity)
        : isNotchEntity(entity)
          ? notchSystem.createRecord(entity)
        : createGeometryRecord(modelEntities.get(entity.id), index);
      if (record) {
        if (record.recordType === 'table') bindRecordEvents(record);
        promoteHandleGroup(record);
        records.push(record);
      }
    });
    solver.getSketchSnapshot().dimensionAnnotations.forEach((entity) => {
      applyManagedDimensionText(entity);
      const record = createDimensionRecord({
        add,
        objectLayer,
        entity: cloneEntity(entity),
        index: records.length,
        scale: camera.scale,
        updateRecordHandles,
        bindRecordEvents,
        onToggleExport: persistDrivenDimensionExport,
      });
      syncDimensionPresentation(record);
      promoteHandleGroup(record);
      records.push(record);
    });
    filletSystem.syncRadiusDimensions();
    filletSystem.refreshPresentation({ renderRegions: false });
    subtractSystem.refreshPresentation();
    renderClosedRegions();
    notchSystem.refresh();
    syncGeometryStacking();
    restoreDrawingExtensions();
    seamLineSystem.refresh();
    refreshLinkedDimensions();
    constraintOverlaySystem?.render?.();
    syncStackPresentation();
    if (zoomToFit) zoomAll();
    else render();
    syncState();
    notifyObjectChange({ history });
    return records.length;
  }

  function insertDrawingData(snapshot) {
    return loadDrawingData(mergeDrawingData(drawingSnapshot(), snapshot));
  }

  function pasteDrawingData(snapshot) {
    const inserted = normalizeDrawingData(snapshot);
    const { drawing, idMap } = mergeDrawingDataWithMap(drawingSnapshot(), inserted, { inheritControlParameters: false });
    const insertedIds = [
      ...inserted.entities.map(({ id }) => id),
      ...inserted.dimensionAnnotations.map(({ id }) => id),
    ].map((id) => idMap.get(id)).filter(Boolean);
    loadDrawingData(drawing, { zoomToFit: false, history: 'commit' });
    selectRecords(insertedIds);
    return { count: insertedIds.length, recordIds: insertedIds, idMap };
  }

  function drawingSnapshot() {
    const snapshot = solver.getSketchSnapshot();
    const drawing = {
      ...snapshot,
      ...classSystem.getState(),
      entities: records
        .filter((record) => ['geometry', 'image', 'fillet', 'notch', 'text', 'table'].includes(record.recordType))
        .map((record) => cloneEntity(record.entity)),
    };
    const extensions = serializedDrawingExtensions();
    if (Object.keys(extensions).length) drawing.extensions = extensions;
    return drawing;
  }

  function isWholeObjectHandle(record, handleIndex) {
    if (record.isWholeObjectHandle) return record.isWholeObjectHandle(handleIndex);
    if (record.recordType !== 'geometry') return false;
    if (record.entity.type === 'point') return handleIndex === 0;
    if (record.entity.type === 'line') return handleIndex === 1;
    if (record.entity.type === 'circle') return handleIndex === 0;
    return false;
  }

  function applyCurveControlPointEdit(record, result, type) {
    if (!record || record.entity.type !== 'curve' || !result) return false;
    requestHistoryCheckpoint(`curve-control-point-${type}`);
    record.entity = solver.updateCurveControlPoints(record.id, result.points, { type, index: result.index });
    updateGeometryNode(record);
    updateRecordHandles(record);
    filletSystem.refreshPresentation();
    renderClosedRegions();
    notchSystem.refresh();
    seamLineSystem.refresh();
    refreshLinkedDimensions(new Set([record.id]));
    constraintOverlaySystem?.render?.();
    syncState();
    notifyObjectChange({ history: 'commit' });
    return true;
  }

  function insertCurvePointFromEvent(event, record) {
    const result = insertCurveControlPoint(record?.entity?.points, screenToWorld(event.clientX, event.clientY));
    return applyCurveControlPointEdit(record, result, 'insert');
  }

  function deleteCurvePointFromEvent(event) {
    const handle = event.target.closest?.('.point-handle[data-handle-index]');
    const recordId = handle?.closest?.('.canvas-record, .canvas-handle-group')?.dataset.recordId;
    const record = records.find((item) => item.id === recordId && item.recordType === 'geometry');
    if (record?.entity?.type !== 'curve') return false;
    const result = deleteCurveControlPoint(record.entity.points, Number(handle.dataset.handleIndex));
    return applyCurveControlPointEdit(record, result, 'delete');
  }

  function startSelectionDragFromHandle(event, record) {
    if (isToolDragBlocked()) return;
    event.preventDefault();
    event.stopPropagation();
    if (!selectedIds.has(record.id)) selectOnly(record.id);
    shapeDrag = {
      mode: 'records',
      moved: false,
      startWorld: screenToWorld(event.clientX, event.clientY),
      items: dragRecordsForSelection().map((item) => ({ record: item, startEntity: cloneEntity(item.entity) })),
    };
    solver.beginDrag(shapeDrag.items.flatMap(({ record: item }) => ['geometry', 'text', 'control', 'table'].includes(item.recordType) ? solver.variableIdsForEntity(item.id) : []));
    record.group.setPointerCapture(event.pointerId);
  }

  function startHandleDrag(event, record, handleIndex) {
    if (isToolDragBlocked()) return;
    if (featureCommandDelegate?.pointerDown?.(event)) return;
    if (smartDimensionDelegate?.pointerDown?.(event)) return;
    seamLineSystem.clearPropertyFeature();
    if (selectedIds.size > 1 && selectedIds.has(record.id) && isWholeObjectHandle(record, handleIndex)) {
      startSelectionDragFromHandle(event, record);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    selectOnly(record.id);
    if (record.recordType === 'notch') notchSystem.beginMove();
    handleDrag = {
      record,
      handleIndex,
      startWorld: screenToWorld(event.clientX, event.clientY),
      startEntity: cloneEntity(record.entity),
    };
    if (['geometry', 'text', 'control'].includes(record.recordType)) {
      const feature = { kind: 'point', recordId: record.id, index: handleIndex };
      solver.beginDrag(solver.dragVariableIdsForFeature?.(feature) || solver.variableIdsForFeature(feature));
    }
    record.group.setPointerCapture(event.pointerId);
    syncState();
  }

  function startDimensionLineDrag(event, record) {
    if (isToolDragBlocked()) return;
    event.preventDefault();
    event.stopPropagation();
    selectOnly(record.id);
    dimensionLineDrag = {
      record,
      startWorld: screenToWorld(event.clientX, event.clientY),
      startEntity: cloneEntity(record.entity),
    };
    record.group.setPointerCapture(event.pointerId);
  }

  function moveGeometryHandle(record, handleIndex, world, startWorld, startEntity = handleDrag?.startEntity || cloneEntity(record.entity), entity = cloneEntity(record.entity)) {
    const dx = world[0] - startWorld[0];
    const dy = world[1] - startWorld[1];
    const start = startEntity;
    if (entity.type === 'point') entity.point = world;
    if (entity.type === 'line') {
      if (handleIndex === 0) entity.start = world;
      if (handleIndex === 2) entity.end = world;
      if (handleIndex === 1) {
        entity.start = [start.start[0] + dx, start.start[1] + dy];
        entity.end = [start.end[0] + dx, start.end[1] + dy];
      }
    }
    if (entity.type === 'circle') {
      if (handleIndex === 0) entity.center = world;
      if (handleIndex > 0) entity.radius = Math.max(6, Math.hypot(world[0] - entity.center[0], world[1] - entity.center[1]));
    }
    if (entity.type === 'rect') {
      const left = start.x;
      const right = start.x + start.width;
      const top = start.y;
      const bottom = start.y + start.height;
      if (handleIndex === 0) Object.assign(entity, { x: world[0], y: world[1], width: right - world[0], height: bottom - world[1] });
      if (handleIndex === 1) Object.assign(entity, { x: left, y: world[1], width: start.width, height: bottom - world[1] });
      if (handleIndex === 2) Object.assign(entity, { x: left, y: world[1], width: world[0] - left, height: bottom - world[1] });
      if (handleIndex === 3) Object.assign(entity, { x: left, y: top, width: world[0] - left, height: start.height });
      if (handleIndex === 4) Object.assign(entity, { x: left, y: top, width: world[0] - left, height: world[1] - top });
      if (handleIndex === 5) Object.assign(entity, { x: left, y: top, width: start.width, height: world[1] - top });
      if (handleIndex === 6) Object.assign(entity, { x: world[0], y: top, width: right - world[0], height: world[1] - top });
      if (handleIndex === 7) Object.assign(entity, { x: world[0], y: top, width: right - world[0], height: start.height });
      if (entity.width < 0) Object.assign(entity, { x: entity.x + entity.width, width: Math.abs(entity.width) });
      if (entity.height < 0) Object.assign(entity, { y: entity.y + entity.height, height: Math.abs(entity.height) });
    }
    if (entity.type === 'polygon' || entity.type === 'polyline' || entity.type === 'curve') entity.points[handleIndex] = world;
    if (entity.type === 'arc') {
      if (handleIndex === 0) entity.start = world;
      if (handleIndex === 1) entity.arcPoint = world;
      if (handleIndex === 2) entity.end = world;
      refreshArcCircleMetadata(entity);
    }
    return entity;
  }

  function recordById(recordId, { includeFillets = false } = {}) {
    return records.find((record) => (
      record.id === recordId
      && (['geometry', 'text', 'control', 'table'].includes(record.recordType) || (includeFillets && ['fillet', 'notch'].includes(record.recordType)))
    )) || null;
  }

  function resolveDerivedDimensionFeature(request) {
    for (const provider of derivedDimensionFeatureProviders) {
      const feature = provider.resolveFeature?.(request);
      if (feature) return feature;
    }
    return null;
  }

  function derivedDimensionFeatureDependsOn(recordId, changedRecordIds) {
    for (const provider of derivedDimensionFeatureProviders) {
      if (provider.dependsOn?.(recordId, changedRecordIds)) return true;
    }
    return false;
  }

  const dimensionLinkManager = createDimensionLinkManager({
    records,
    recordById,
    recordHandles,
    recordSegments,
    renderedEntityForRecord,
    filletEvaluation: filletSystem.evaluateRecord,
    arcCircle,
    screenToWorld,
    formatDrawingLength,
    solver,
    applyManagedDimensionText,
    updateRecordHandles,
    syncScreenInvariantSizing,
    getScale: () => camera.scale,
    resolveDerivedFeature: resolveDerivedDimensionFeature,
    derivedFeatureDependsOn: derivedDimensionFeatureDependsOn,
  });

  function applySolverSnapshot(snapshot = solver.getGeometrySnapshot(), { incremental = false } = {}) {
    const byId = new Map(snapshot.map((entity) => [entity.id, entity]));
    const changedIds = new Set();
    const geometryDragPreview = Boolean(
      shapeDrag
      || (handleDrag && handleDrag.record?.recordType === 'geometry'),
    );
    const snapshotRecords = incremental
      ? snapshot.map((entity) => recordById(entity.id)).filter(Boolean)
      : records;
    snapshotRecords.forEach((record) => {
      const next = byId.get(record.id);
      if (!next) return;
      if (record.updateFromConstraint?.(next)) {
        changedIds.add(record.id);
        return;
      }
      if (!['geometry', 'text'].includes(record.recordType)) return;
      record.entity = cloneEntity(next);
      if (record.recordType === 'text') textTools.updateRecord(record);
      else updateRecordNode(record);
      updateRecordHandles(record);
      changedIds.add(record.id);
    });
    if (incremental) {
      filletSystem.syncRadiusDimensions(changedIds);
      filletSystem.refreshPresentation({ renderRegions: false, changedRecordIds: changedIds })
        .forEach((recordId) => changedIds.add(recordId));
      subtractSystem.refreshPresentation({ changedRecordIds: changedIds });
      updateClosedRegionGeometryInPlace(changedIds);
      notchSystem.applyDrivingDimensions(changedIds);
      notchSystem.refresh(changedIds);
      seamLineSystem.refresh(changedIds);
      refreshLinkedDimensions(changedIds);
      snapshotRecords.filter((record) => record.recordType === 'text').forEach(textTools.updateRecord);
      constraintOverlaySystem?.render?.({ changedRecordIds: changedIds });
      syncState({ changedRecordIds: changedIds, refreshPresentation: false });
    } else {
      filletSystem.syncRadiusDimensions();
      filletSystem.refreshPresentation({ renderRegions: !geometryDragPreview });
      subtractSystem.refreshPresentation();
      if (geometryDragPreview) updateClosedRegionGeometryInPlace();
      else renderClosedRegions();
      notchSystem.applyDrivingDimensions();
      notchSystem.refresh();
      seamLineSystem.refresh();
      refreshLinkedDimensions();
      records.filter((record) => record.recordType === 'text').forEach(textTools.updateRecord);
      constraintOverlaySystem?.render?.();
      syncState();
    }
    presentationChangeListeners.forEach((listener) => listener({ changedRecordIds: new Set(changedIds) }));
    return changedIds;
  }

  function updateDimensionParameterName(dimensionId, name) {
    records.forEach((record) => {
      if (record.recordType !== 'dimension' || record.entity.dimensionId !== dimensionId) return;
      record.entity.dimensionName = name;
      applyManagedDimensionText(record.entity);
      updateDimensionNode(record, camera.scale);
      syncDimensionPresentation(record);
    });
  }

  function setDimensionTextMode(mode) {
    if (!['expression', 'named-value', 'value'].includes(mode)) return;
    dimensionTextMode = mode;
    records.forEach((record) => {
      if (record.recordType === 'geometry' || record.recordType === 'fillet' || record.recordType === 'notch') {
        syncGeometryPresentation(record);
        return;
      }
      if (record.recordType === 'dimension') {
        applyManagedDimensionText(record.entity);
        updateDimensionNode(record, camera.scale);
        syncDimensionPresentation(record);
      }
    });
    notchSystem.setValueOnly(mode === 'value');
    syncScreenInvariantSizing();
  }

  function solveEditedRecords(editedEntries, lockedVariableIds = []) {
    // Keep requested drag geometry separate from record.entity. The latter is
    // the last solved presentation and must not move ahead of derived views.
    const entitiesToUpdate = editedEntries
      .filter((entry) => ['geometry', 'text', 'control', 'table'].includes(entry.record.recordType))
      .map((entry) => entry.record.recordType === 'table'
        ? tableTools.constraintEntity(entry.entity)
        : cloneEntity(entry.entity));
    if (!entitiesToUpdate.length) return new Set();
    const outcome = solver.updateEntitiesInteractive
      ? solver.updateEntitiesInteractive(entitiesToUpdate, {
        lockedVariableIds,
        previewHysteresis: 0.2 / camera.scale,
        previewConstraintTolerance: 0.2 / camera.scale,
      })
      : solver.updateEntities(entitiesToUpdate, { lockedVariableIds });
    if (outcome && typeof outcome.then === 'function') {
      outcome.then((resolved) => {
        if (resolved?.snapshot) applySolverSnapshot(resolved.snapshot, {
          incremental: resolved.snapshotMode === 'delta',
        });
      });
      return new Set();
    }
    return applySolverSnapshot(outcome.snapshot, {
      incremental: outcome.snapshotMode === 'delta',
    });
  }

  function flushScheduledSolve() {
    if (solveFrame !== null) {
      cancelAnimationFrame(solveFrame);
      solveFrame = null;
    }
    const editedRecords = [...pendingSolveRecords.values()];
    pendingSolveRecords.clear();
    if (editedRecords.length) solveEditedRecords(editedRecords);
  }

  function scheduleGeometrySolve(editedEntries) {
    editedEntries.forEach((entry) => {
      const record = entry.record || entry;
      pendingSolveRecords.set(record.id, {
        record,
        entity: cloneEntity(entry.entity || record.entity),
      });
    });
    if (solveFrame !== null) return;
    solveFrame = requestAnimationFrame(() => {
      solveFrame = null;
      const pending = [...pendingSolveRecords.values()];
      pendingSolveRecords.clear();
      if (pending.length) solveEditedRecords(pending);
    });
  }

  function getEntityFeature(recordId, options = {}) {
    return dimensionLinkManager.getEntityFeature(recordId, options);
  }

  function getSegmentFeature(recordId, index = 0, options = {}) {
    return dimensionLinkManager.getSegmentFeature(recordId, index, options);
  }

  function getPointFeature(recordId, index = 0, options = {}) {
    if (recordId === CANVAS_ORIGIN_RECORD_ID) return canvasOriginPointFeature(originHandle);
    const table = records.find((record) => record.recordType === 'table' && record.id === recordId);
    if (table) {
      const cornerIndex = tableCornerIndexFromSolverIndex(index);
      const point = tableTools.cornerPoints(table.entity)[cornerIndex >= 0 ? cornerIndex : index];
      return point ? { kind: 'point', recordId, entityType: 'table', index, point: [...point] } : null;
    }
    return dimensionLinkManager.getPointFeature(recordId, index, options);
  }

  function getDimensionFeatureSet(recordId, options = {}) {
    const table = records.find((record) => record.recordType === 'table' && record.id === recordId);
    if (table) {
      const controlPoints = tableTools.cornerPoints(table.entity).map((point) => [...point]);
      return {
        recordId,
        entityType: 'table',
        controlPoints,
        features: controlPoints.map((point, index) => ({
          kind: 'point', recordId, entityType: 'table', index: tableSolverCornerIndex(index), point, node: table.handles?.[index] || table.node,
        })),
      };
    }
    return dimensionLinkManager.getDimensionFeatureSet(recordId, options);
  }

  function refreshLinkedDimensions(changedRecordIds = null) {
    dimensionLinkManager.refreshLinkedDimensions(changedRecordIds);
  }

  function translateGeometryEntity(entity, startEntity, delta) {
    if (entity.type === 'point') entity.point = addPoints(startEntity.point, delta);
    if (entity.type === 'line') {
      entity.start = addPoints(startEntity.start, delta);
      entity.end = addPoints(startEntity.end, delta);
    }
    if (entity.type === 'circle') entity.center = addPoints(startEntity.center, delta);
    if (entity.type === 'rect') {
      entity.x = startEntity.x + delta[0];
      entity.y = startEntity.y + delta[1];
    }
    if (entity.type === 'polygon' || entity.type === 'polyline' || entity.type === 'curve') {
      entity.points = startEntity.points.map((point) => addPoints(point, delta));
    }
    if (entity.type === 'arc') {
      entity.start = addPoints(startEntity.start, delta);
      entity.arcPoint = addPoints(startEntity.arcPoint, delta);
      entity.end = addPoints(startEntity.end, delta);
      if (hasStoredArcCircle(startEntity)) {
        entity.center = addPoints(startEntity.center, delta);
        entity.radius = startEntity.radius;
      } else {
        refreshArcCircleMetadata(entity);
      }
    }
  }

  function translateDimensionEntity(entity, startEntity, delta) {
    if (entity.type === 'dimension-line') {
      entity.start = addPoints(startEntity.start, delta);
      entity.end = addPoints(startEntity.end, delta);
      entity.measureStart = addPoints(startEntity.measureStart || startEntity.start, delta);
      entity.measureEnd = addPoints(startEntity.measureEnd || startEntity.end, delta);
      entity.label = addPoints(startEntity.label, delta);
    }
    if (entity.type === 'radius-dimension') {
      entity.center = addPoints(startEntity.center, delta);
      if (startEntity.target) entity.target = addPoints(startEntity.target, delta);
      entity.elbow = addPoints(startEntity.elbow || startEntity.label, delta);
      entity.label = addPoints(startEntity.label, delta);
    }
    if (entity.type === 'angle-dimension') {
      entity.vertex = addPoints(startEntity.vertex, delta);
      entity.start = addPoints(startEntity.start, delta);
      entity.end = addPoints(startEntity.end, delta);
      entity.label = addPoints(startEntity.label, delta);
    }
    if (entity.type === 'multi-curve-length-dimension') {
      entity.target = addPoints(startEntity.target, delta);
      entity.elbow = addPoints(startEntity.elbow || startEntity.label, delta);
      entity.label = addPoints(startEntity.label, delta);
    }
    if (entity.type === 'dimension-text') entity.label = addPoints(startEntity.label, delta);
  }

  function moveSegmentFromStart(entity, segmentIndex, startEntity, delta) {
    if (entity.type === 'line') {
      entity.start = addPoints(startEntity.start, delta);
      entity.end = addPoints(startEntity.end, delta);
      return;
    }
    if (entity.type === 'rect') {
      if (segmentIndex === 0) {
        entity.y = startEntity.y + delta[1];
        entity.height = startEntity.height - delta[1];
      }
      if (segmentIndex === 1) entity.width = startEntity.width + delta[0];
      if (segmentIndex === 2) entity.height = startEntity.height + delta[1];
      if (segmentIndex === 3) {
        entity.x = startEntity.x + delta[0];
        entity.width = startEntity.width - delta[0];
      }
      return;
    }
    if (entity.type !== 'polyline' && entity.type !== 'polygon') return;
    const nextIndex = (segmentIndex + 1) % startEntity.points.length;
    entity.points = startEntity.points.map((point) => [...point]);
    entity.points[segmentIndex] = addPoints(startEntity.points[segmentIndex], delta);
    entity.points[nextIndex] = addPoints(startEntity.points[nextIndex], delta);
  }

  function dimensionReferencesAny(record, geometryIds) {
    if (record.recordType !== 'dimension') return false;
    const anchorIds = dimensionAnchorRecordIds(record.entity);
    return [...geometryIds].some((id) => anchorIds.has(id));
  }

  function isToolDragBlocked() {
    return Boolean(featureCommandDelegate || smartDimensionDelegate);
  }

  function dragRecordsForSelection() {
    const selectedRecords = records.filter((record) => selectedIds.has(record.id));
    const selectedGeometryIds = new Set(selectedRecords.filter((record) => record.recordType === 'geometry').map((record) => record.id));
    return selectedRecords.filter((record) => {
      if (record.recordType === 'geometry') return true;
      if (record.recordType === 'image') return !record.entity.locked;
      if (record.recordType === 'text') return true;
      return !dimensionReferencesAny(record, selectedGeometryIds);
    });
  }

  function beginRecordsDrag(event) {
    if (isToolDragBlocked()) return false;
    shapeDrag = {
      mode: 'records',
      moved: false,
      startWorld: screenToWorld(event.clientX, event.clientY),
      items: dragRecordsForSelection().map((item) => ({ record: item, startEntity: cloneEntity(item.entity) })),
    };
    solver.beginDrag(shapeDrag.items.flatMap(({ record: item }) => ['geometry', 'text', 'table'].includes(item.recordType) ? solver.variableIdsForEntity(item.id) : []));
    return true;
  }

  function startRegionDrag(event, parentIds) {
    if (isToolDragBlocked() || event.button !== 0) return false;
    event.preventDefault();
    event.stopPropagation();
    seamLineSystem.clearPropertyFeature();
    if (!parentIds.every((id) => selectedIds.has(id))) selectRecords(parentIds);
    if (!beginRecordsDrag(event)) return false;
    event.currentTarget.setPointerCapture(event.pointerId);
    return true;
  }

  function startObjectDrag(event, record, { preserveClickSequence = false } = {}) {
    if (isToolDragBlocked() || event.button !== 0 || event.target.closest?.('.point-handle')) return false;
    if (!preserveClickSequence) event.preventDefault();
    event.stopPropagation();
    if (!selectedIds.has(record.id)) selectOnly(record.id);
    else if (selectedSegments.has(record.id)) {
      selectedSegments.delete(record.id);
      selectedSegment = null;
      syncState();
    }
    if (!beginRecordsDrag(event)) return false;
    record.group.setPointerCapture(event.pointerId);
    return true;
  }

  function startSegmentDrag(event, record, requestedSegmentIndex = null) {
    if (
      isToolDragBlocked()
      || event.button !== 0
      || !['line', 'rect', 'polyline', 'polygon'].includes(record.entity.type)
    ) return false;
    const segmentIndex = Number.isInteger(requestedSegmentIndex)
      ? requestedSegmentIndex
      : Number(event.target.dataset.segmentIndex);
    if (!Number.isInteger(segmentIndex)) return false;
    event.preventDefault();
    event.stopPropagation();
    selectOnly(record.id, { segmentIndex });
    shapeDrag = {
      mode: 'segment',
      moved: false,
      record,
      segmentIndex,
      startWorld: screenToWorld(event.clientX, event.clientY),
      startEntity: cloneEntity(record.entity),
    };
    solver.beginDrag(solver.variableIdsForFeature({ kind: 'segment', recordId: record.id, index: segmentIndex }));
    record.group.setPointerCapture(event.pointerId);
    return true;
  }

  function moveShapeDrag(event) {
    const world = screenToWorld(event.clientX, event.clientY);
    const delta = subtractPoints(world, shapeDrag.startWorld);
    if (pointLength(delta) > 0.001) shapeDrag.moved = true;
    const solveEntries = [];
    if (shapeDrag.mode === 'segment') {
      const entity = cloneEntity(shapeDrag.startEntity);
      moveSegmentFromStart(entity, shapeDrag.segmentIndex, shapeDrag.startEntity, delta);
      solveEntries.push({ record: shapeDrag.record, entity });
    }
    if (shapeDrag.mode === 'records') {
      shapeDrag.items.forEach(({ record, startEntity }) => {
        if (record.recordType === 'geometry') {
          const entity = cloneEntity(startEntity);
          translateGeometryEntity(entity, startEntity, delta);
          solveEntries.push({ record, entity });
        } else if (record.translateEntity) {
          record.translateEntity(startEntity, delta);
          updateRecordNode(record);
          updateRecordHandles(record);
          solveEntries.push({ record, entity: record.entity });
        } else if (record.recordType === 'image') {
          record.entity.x = startEntity.x + delta[0];
          record.entity.y = startEntity.y + delta[1];
          imageTools.updateRecord(record);
        } else if (record.recordType === 'text') {
          record.entity.x = startEntity.x + delta[0];
          record.entity.y = startEntity.y + delta[1];
          textTools.updateRecord(record);
          updateRecordHandles(record);
          solveEntries.push({ record, entity: record.entity });
        } else {
          translateDimensionEntity(record.entity, startEntity, delta);
          updateDimensionNode(record, camera.scale);
          updateRecordHandles(record);
        }
      });
    }
    const geometrySolveEntries = solveEntries.filter(({ record }) => (
      ['geometry', 'text', 'control', 'table'].includes(record.recordType)
    ));
    if (geometrySolveEntries.length) {
      scheduleGeometrySolve(geometrySolveEntries);
    } else {
      const changedRecordIds = new Set(shapeDrag.mode === 'segment'
        ? [shapeDrag.record.id]
        : shapeDrag.items.map(({ record }) => record.id));
      constraintOverlaySystem?.render?.({ changedRecordIds });
      syncState({ changedRecordIds, refreshPresentation: false });
    }
  }

  function moveHandle(event) {
    const world = screenToWorld(event.clientX, event.clientY);
    const { record, handleIndex, startWorld } = handleDrag;
    let solveEntity = null;
    if (record.recordType === 'dimension') moveDimensionHandle(record, handleIndex, world, startWorld, handleDrag.startEntity, camera.scale);
    else if (record.recordType === 'notch') notchSystem.moveRecord(record, world);
    else if (record.moveHandle) {
      record.moveHandle(handleIndex, world, handleDrag.startEntity);
      updateRecordNode(record);
    } else if (record.recordType === 'text') {
      record.entity.x = world[0];
      record.entity.y = world[1];
      textTools.updateRecord(record);
      updateRecordHandles(record);
    } else {
      solveEntity = moveGeometryHandle(record, handleIndex, world, startWorld, handleDrag.startEntity);
    }
    if (record.recordType !== 'geometry') updateRecordHandles(record);
    if (record.recordType === 'geometry' || record.needsSolve) {
      scheduleGeometrySolve([{ record, entity: solveEntity || record.entity }]);
    } else {
      const changedRecordIds = new Set([record.id]);
      constraintOverlaySystem?.render?.({ changedRecordIds });
      syncState({ changedRecordIds, refreshPresentation: false });
    }
    drawingHint?.showHandle(event, record.entity, handleIndex);
  }

  const axisX = add(axisLayer, 'line', { x1: 0, y1: 0, x2: 0, y2: 0, class: 'axis x' });
  const axisY = add(axisLayer, 'line', { x1: 0, y1: 0, x2: 0, y2: 0, class: 'axis y' });
  const originPoint = add(interactionLayer, 'g', {
    class: 'canvas-origin-point',
    'data-canvas-origin-point': 'true',
  });
  add(originPoint, 'circle', {
    cx: 0,
    cy: 0,
    r: 11,
    class: 'canvas-origin-hit',
    'data-canvas-origin-point': 'true',
  });
  const originHandle = add(originPoint, 'circle', {
    cx: 0,
    cy: 0,
    r: 6,
    class: 'point-handle canvas-origin-handle',
    'data-canvas-origin-point': 'true',
  });

  entities.forEach((entity, index) => {
    const stackedEntity = stackSystem.assignEntity(classSystem.assignEntity(entity));
    const record = createGeometryRecord(solver.addEntity(stackedEntity), index);
    if (record) records.push(record);
  });

  function render() {
    g.setAttribute('transform', `translate(${camera.x} ${camera.y}) scale(${camera.scale})`);
    const worldLeft = -camera.x / camera.scale;
    const worldRight = (canvas.clientWidth - camera.x) / camera.scale;
    const worldTop = -camera.y / camera.scale;
    const worldBottom = (canvas.clientHeight - camera.y) / camera.scale;
    axisX.setAttribute('x1', worldLeft);
    axisX.setAttribute('x2', worldRight);
    axisY.setAttribute('y1', worldTop);
    axisY.setAttribute('y2', worldBottom);
    records.forEach((record) => {
      if (record.recordType === 'dimension') {
        applyManagedDimensionText(record.entity);
        updateDimensionNode(record, camera.scale);
      }
      if (record.recordType === 'image') imageTools.updateRecord(record);
      if (record.recordType === 'text') textTools.updateRecord(record);
      if (record.updateNode) updateRecordNode(record);
      if (record.updateHandles) updateRecordHandles(record);
    });
    constraintOverlaySystem?.render?.();
    syncScreenInvariantSizing();
    positionDimensionEditPanel();
    if (status) status.textContent = `Zoom ${(camera.scale * 100).toFixed(0)}% - Alt/Middle drag to pan - Wheel to zoom`;
  }

  function syncScreenInvariantSizing() {
    const handleRadius = 6 / camera.scale;
    const handleStrokeWidth = 2 / camera.scale;
    const textSize = 14 / camera.scale;
    const textStrokeWidth = 0;
    [objectLayer, handleLayer, interactionLayer].forEach((layer) => {
      layer.querySelectorAll('.point-handle').forEach((handle) => {
        handle.setAttribute('r', handleRadius);
        handle.setAttribute('stroke-width', handleStrokeWidth);
      });
    });
    originPoint.querySelector('.canvas-origin-hit')?.setAttribute('r', 11 / camera.scale);
    notchSystem.syncScreenScale(camera.scale);
    objectLayer.querySelectorAll('.dimension-text').forEach((text) => {
      text.setAttribute('font-size', textSize);
      text.setAttribute('stroke-width', textStrokeWidth);
      text.style.fontSize = `${textSize}px`;
      text.style.strokeWidth = '0px';
    });
  }

  function updateSelectionBox(event) {
    windowSelect.endX = event.clientX;
    windowSelect.endY = event.clientY;
    windowSelect.bottomUp = event.clientY < windowSelect.startY;
    const left = Math.min(windowSelect.startX, event.clientX);
    const top = Math.min(windowSelect.startY, event.clientY);
    const width = Math.abs(event.clientX - windowSelect.startX);
    const height = Math.abs(event.clientY - windowSelect.startY);
    const canvasRect = canvas.getBoundingClientRect();
    Object.assign(selectionBox.style, {
      display: 'block',
      left: `${left - canvasRect.left}px`,
      top: `${top - canvasRect.top}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
    windowSelect.rect = { left, top, right: left + width, bottom: top + height, width, height };
  }

  function intersects(a, b) {
    return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
  }

  function containedBy(a, b) {
    return a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom;
  }

  function finishWindowSelect() {
    selectionBox.style.display = 'none';
    if (!windowSelect?.rect || windowSelect.rect.width < 4 || windowSelect.rect.height < 4) {
      windowSelect = null;
      return;
    }
    selectedIds.clear();
    selectedSegment = null;
    selectedSegments.clear();
    seamLineSystem.clearPropertyFeature();
    records.forEach((record) => {
      if (!isRecordInteractive(record)) return;
      const targets = [...record.group.querySelectorAll('.selectable-entity')];
      if (windowSelect.bottomUp) {
        if (targets.some((target) => intersects(target.getBoundingClientRect(), windowSelect.rect))) selectedIds.add(record.id);
        return;
      }
      const visibleTargets = targets.filter((target) => (
        !target.classList.contains('hit-target')
        && !target.classList.contains('segment-select-line')
      ));
      const containmentTargets = visibleTargets.length ? visibleTargets : targets;
      if (containmentTargets.length > 0 && containmentTargets.every((target) => containedBy(target.getBoundingClientRect(), windowSelect.rect))) {
        selectedIds.add(record.id);
      }
    });
    windowSelect = null;
    suppressNextCanvasClick = true;
    syncState();
  }

  function updateHover(event) {
    if (panStart || windowSelect || handleDrag || dimensionLineDrag || shapeDrag || imageTools.isDragging()) return;
    const previousHoveredId = hoveredId;
    const previouslyHoveredHandle = records.some((record) => record.handles.some((handle) => handle.classList.contains('hovered')));
    hoveredId = document.elementsFromPoint(event.clientX, event.clientY)
      .map((element) => element.closest?.('.canvas-record') || element.closest?.('.canvas-handle-group'))
      .find(Boolean)?.dataset.recordId || null;
    records.forEach((record) => {
      const isVisible = hoveredId === record.id || selectedIds.has(record.id);
      record.handles.forEach((handle) => {
        handle.classList.remove('hovered');
        if (!isVisible) return;
        const rect = handle.getBoundingClientRect();
        const dx = event.clientX - (rect.left + rect.width / 2);
        const dy = event.clientY - (rect.top + rect.height / 2);
        if (Math.hypot(dx, dy) <= 8) handle.classList.add('hovered');
      });
    });
    const hasHoveredHandle = records.some((record) => record.handles.some((handle) => handle.classList.contains('hovered')));
    if (previousHoveredId !== hoveredId || previouslyHoveredHandle !== hasHoveredHandle || hasHoveredHandle) syncState();
  }

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const zoom = Math.exp(-event.deltaY * 0.0012);
    const nextScale = clampCanvasZoom(camera.scale * zoom);
    const worldX = (cursor.x - camera.x) / camera.scale;
    const worldY = (cursor.y - camera.y) / camera.scale;
    camera = { scale: nextScale, x: cursor.x - worldX * nextScale, y: cursor.y - worldY * nextScale };
    render();
  }, { passive: false });

  canvas.addEventListener('pointerdown', (event) => {
    if (!event.target.closest?.('.drawing-text-editor.editing')) textTools.finishEditing();
    if (event.target.closest?.('.dimension-edit-panel, [data-canvas-ui]')) return;
    if (event.target.closest?.('.canvas-overlay-button')) return;
    if (drawingMode && drawingDelegate?.pointerDown?.(event)) {
      if (event.target.closest?.('.canvas-record, .point-handle')) suppressRecordClick = true;
      event.stopPropagation();
      return;
    }
    if (event.button === 0 && event.altKey && deleteCurvePointFromEvent(event)) {
      event.preventDefault();
      event.stopPropagation();
      suppressRecordClick = true;
      suppressNextCanvasClick = true;
      return;
    }
    if (
      event.button === 0
      && event.ctrlKey
      && event.shiftKey
      && !event.altKey
      && smartDimensionDelegate?.mode !== 'driven'
    ) {
      const recordId = event.target.closest?.('.geometry-record')?.dataset.recordId;
      const record = records.find((item) => item.id === recordId && item.entity?.type === 'curve');
      if (record && insertCurvePointFromEvent(event, record)) {
        event.preventDefault();
        event.stopPropagation();
        suppressRecordClick = true;
        suppressNextCanvasClick = true;
        return;
      }
    }
    if (event.button === 0 && event.altKey) {
      const selected = overlapSelectionCycler.cycle(event);
      if (selected) {
        event.paramagicSelectionTarget = selected.node;
        if (featureCommandDelegate?.pointerDown?.(event)) return;
        if (smartDimensionDelegate?.pointerDown?.(event)) return;
        event.preventDefault();
        event.stopPropagation();
        suppressRecordClick = true;
        suppressNextCanvasClick = true;
      }
      return;
    }
    if (featureCommandDelegate?.pointerDown?.(event)) return;
    if (smartDimensionDelegate?.pointerDown?.(event)) return;
    if (event.button === 1 || event.button === 2) {
      panStart = { x: event.clientX, y: event.clientY, camera: { ...camera } };
      canvas.classList.add('panning');
      return;
    }
    if (event.button === 0 && !event.target.closest?.('.canvas-record, .point-handle, .closed-constrained-region, .dimension-edit-panel, [data-canvas-ui]')) {
      windowSelect = { startX: event.clientX, startY: event.clientY, rect: null };
      canvas.setPointerCapture(event.pointerId);
      updateSelectionBox(event);
    }
  }, { capture: true });

  canvas.addEventListener('pointermove', (event) => {
    if (imageTools.pointerMove(event)) {
      syncState();
      return;
    }
    if (shapeDrag) {
      moveShapeDrag(event);
      return;
    }
    if (handleDrag) {
      moveHandle(event);
      return;
    }
    if (dimensionLineDrag) {
      moveDimensionLine(
        dimensionLineDrag.record,
        screenToWorld(event.clientX, event.clientY),
        dimensionLineDrag.startWorld,
        dimensionLineDrag.startEntity,
        camera.scale,
      );
      syncState();
      return;
    }
    if (drawingMode && drawingDelegate?.pointerMove?.(event)) return;
    featureCommandDelegate?.pointerMove?.(event);
    smartDimensionDelegate?.pointerMove?.(event);
    if (panStart) {
      camera = { ...panStart.camera, x: panStart.camera.x + event.clientX - panStart.x, y: panStart.camera.y + event.clientY - panStart.y };
      render();
    }
    if (windowSelect) updateSelectionBox(event);
    updateHover(event);
  });

  canvas.addEventListener('pointerup', (event) => {
    if (imageTools.pointerUp()) {
      syncState();
      return;
    }
    flushScheduledSolve();
    let geometryDragEnded = false;
    let notifyAfterGeometryDrag = false;
    if (shapeDrag) {
      suppressRecordClick = shapeDrag.moved;
      if (shapeDrag.moved) suppressNextCanvasClick = true;
      notifyAfterGeometryDrag = shapeDrag.moved;
      shapeDrag = null;
      geometryDragEnded = true;
      syncState();
    }
    if (handleDrag) {
      geometryDragEnded = handleDrag.record.recordType === 'geometry' || geometryDragEnded;
      if (handleDrag.record.recordType === 'notch') {
        notchSystem.finishMove(handleDrag.record);
      }
      handleDrag = null;
      drawingHint?.hide();
      syncState();
    }
    if (dimensionLineDrag) {
      dimensionLineDrag = null;
      syncState();
    }
    panStart = null;
    canvas.classList.remove('panning');
    if (windowSelect) {
      updateSelectionBox(event);
      finishWindowSelect();
    }
    if (geometryDragEnded) {
      const outcome = solver.endDragInteractive ? solver.endDragInteractive() : solver.endDrag();
      if (outcome && typeof outcome.then === 'function') {
        outcome.then((resolved) => {
          if (resolved?.snapshot) applySolverSnapshot(resolved.snapshot, {
            incremental: resolved.snapshotMode === 'delta',
          });
          if (notifyAfterGeometryDrag) notifyObjectChange();
        });
      } else {
        applySolverSnapshot(outcome?.snapshot, {
          incremental: outcome?.snapshotMode === 'delta',
        });
        if (notifyAfterGeometryDrag) notifyObjectChange();
      }
    }
  });

  canvas.addEventListener('dblclick', (event) => {
    if (drawingMode) drawingDelegate?.doubleClick?.(event);
  });

  canvas.addEventListener('click', (event) => {
    if (suppressNextCanvasClick) {
      suppressNextCanvasClick = false;
      return;
    }
    if (!drawingMode && !event.target.closest?.('.canvas-record, .canvas-overlay-button, .dimension-edit-panel, [data-canvas-ui]')) clearSelection();
  });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  document.addEventListener('keydown', (event) => {
    // Editing a property or text field must never invoke canvas commands.
    // In particular, Backspace/Delete in the Fill Color expression used to
    // fall through here and delete the selected drawing object.
    if (event.target?.closest?.('input, textarea, select, [contenteditable]')) return;
    if (featureCommandDelegate?.keyDown?.(event)) return;
    if (smartDimensionDelegate?.keyDown?.(event)) return;
    if (drawingMode) return;
    if (event.key === 'Escape') clearSelection();
    if (event.key === 'Enter' && overlapSelectionCycler.commit({ additive: event.ctrlKey || event.metaKey })) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') deleteSelection();
  });

  function zoomAll() {
    if (!records.length) {
      camera = defaultCamera();
      render();
      return;
    }
    records.forEach((record) => {
      if (record.recordType === 'dimension') updateDimensionNode(record, camera.scale);
    });
    let bounds;
    try {
      bounds = objectLayer.getBBox();
    } catch {
      bounds = null;
    }
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      camera = defaultCamera();
      render();
      return;
    }
    const fitScale = Math.min(canvas.clientWidth / bounds.width, canvas.clientHeight / bounds.height) * 0.9;
    const nextScale = clampCanvasZoom(fitScale);
    camera = {
      scale: nextScale,
      x: canvas.clientWidth / 2 - (bounds.x + bounds.width / 2) * nextScale,
      y: canvas.clientHeight / 2 - (bounds.y + bounds.height / 2) * nextScale,
    };
    render();
  }

  reset.onclick = zoomAll;

  objectVisibilitySystem.syncPresentation(closedRegionNodes);
  render();

  return {
    addObject,
    addObjects,
    upsertAuxiliaryGeometry,
    updateObjectComposite,
    addImage,
    addText,
    addTable,
    beginTextEdit,
    beginTableEdit: tableTools.beginEdit,
    copySelectedTableCells() {
      return tableTools.copySelectedCells([...selectedIds]);
    },
    pasteSelectedTableCell(clipboardValue) {
      return tableTools.pasteSelectedCell([...selectedIds], clipboardValue);
    },
    cutSelectedTableCells() {
      return tableTools.cutSelectedCells([...selectedIds]);
    },
    finishTextEditing() {
      textTools.finishEditing();
    },
    addFillet: filletSystem.addFillet,
    addNotch: notchSystem.addNotch,
    addDimension,
    clearDrawing,
    getDrawingData: drawingSnapshot,
    loadDrawingData,
    insertDrawingData,
    pasteDrawingData,
    clearPreview,
    setTablePreview: tableTools.setPreview,
    screenToWorld,
    worldToScreen,
    getCanvasElement() {
      return canvas;
    },
    getObjectLayer() {
      return objectLayer;
    },
    getObjectPaintOrder() {
      const construction = records.filter((record) => (
        ['geometry', 'image', 'fillet'].includes(record.recordType)
        && record.entity.construction
      ));
      const notches = records.filter((record) => record.recordType === 'notch');
      const dimensions = records.filter((record) => record.recordType === 'dimension');
      return [...editableStackOrder(), ...construction, ...notches, ...dimensions]
        .map((record) => record.id);
    },
    syncGeometryStacking,
    getSeamLinePresentationNodes(sourceIds) {
      return seamLineSystem.presentationNodesForSourceIds(sourceIds);
    },
    getNearestSnapPoint: nearestSnapPoint,
    getNearestObjectPoint: nearestObjectPoint,
    setObjectSnapCandidate,
    clearObjectSnapCandidate: () => setObjectSnapCandidate(null),
    setObjectSnapEnabled(value) {
      objectSnapEnabled = Boolean(value);
      if (!objectSnapEnabled) setObjectSnapCandidate(null);
    },
    setAutoConstrainEnabled(value) {
      autoConstrainEnabled = Boolean(value);
    },
    getWorldTolerance(screenPixels) {
      return screenPixels / camera.scale;
    },
    getObjectCount() {
      return records.length;
    },
    getSelectedRecordIds() {
      return [...selectedIds];
    },
    getClassState: classSystem.getState,
    getActiveClassId: classSystem.activeClassId,
    onClassChange: classSystem.onStateChange,
    addClass: classSystem.addClass,
    duplicateClass: classSystem.duplicateClass,
    renameClass: classSystem.renameClass,
    updateClassProperties: classSystem.updateClassProperties,
    setActiveClass: classSystem.setActiveClass,
    setRecordClassIds: classSystem.setRecordClassIds,
    removeClass: classSystem.removeClass,
    selectClass(classId) {
      selectRecords(classSystem.recordIdsForClass(classId));
      return [...selectedIds];
    },
    getStackState: stackSystem.getState,
    getActiveStackId: stackSystem.activeStackId,
    isStackVisible: stackSystem.isStackVisible,
    isStackActive: stackSystem.isStackActive,
    isRecordVisible(recordId) {
      const record = records.find((candidate) => candidate.id === recordId);
      return stackSystem.isRecordVisible(record);
    },
    isRecordInActiveStack(recordId) {
      const record = records.find((candidate) => candidate.id === recordId);
      return record ? stackSystem.isEntityActive(record.entity) : undefined;
    },
    isObjectVisible: objectVisibilitySystem.isRecordVisible,
    getShowHiddenObjects: objectVisibilitySystem.getShowHiddenObjects,
    setShowHiddenObjects(value) {
      const result = objectVisibilitySystem.setShowHiddenObjects(value);
      syncState();
      presentationChangeListeners.forEach((listener) => listener());
      return result;
    },
    getRecordStackId(recordId) {
      const record = records.find((candidate) => candidate.id === recordId);
      return record?.entity?.stackId || 'stack-default';
    },
    onStackChange: stackSystem.onStateChange,
    addStack(name) {
      requestHistoryCheckpoint('stack-add');
      return stackSystem.addStack(name);
    },
    renameStack(stackId, name) {
      return stackSystem.renameStack(stackId, name);
    },
    setActiveStack: stackSystem.setActiveStack,
    setStackVisible(stackId, visible) {
      requestHistoryCheckpoint('stack-visibility');
      return stackSystem.setStackVisible(stackId, visible);
    },
    moveStack(stackId, direction) {
      requestHistoryCheckpoint('stack-reorder');
      return stackSystem.moveStack(stackId, direction);
    },
    moveStackToIndex(stackId, index) {
      requestHistoryCheckpoint('stack-reorder');
      return stackSystem.moveStackToIndex(stackId, index);
    },
    removeStack,
    selectStack(stackId) {
      selectRecords(stackSystem.recordIdsForStack(stackId));
      return [...selectedIds];
    },
    moveSelectionToStack,
    setRecordStackIds,
    getDrawingUnit() {
      return solver.drawingUnit || 'in';
    },
    formatDrawingLength,
    evaluateNumericExpression(expression) {
      return solver.evaluateParameterExpression(expression);
    },
    evaluateLengthExpression(expression) {
      return solver.evaluateDrawingLengthExpression(expression);
    },
    getParameters() {
      return solver.parameters();
    },
    getDocumentVariables() {
      return solver.documentVariables?.() || [];
    },
    getDocumentMetadata() {
      return solver.getDocumentMetadata?.() || {};
    },
    setDocumentMetadata(patch = {}) {
      const result = solver.setDocumentMetadata?.(patch) || {};
      // Re-apply the solver snapshot before resolving fields.  Parameters use
      // this same path, which restores the canonical source text and then
      // renders its current value.  Refreshing only the DOM can leave a text
      // record out of sync when the field was edited immediately beforehand.
      applySolverSnapshot();
      records.filter((record) => record.updateNode).forEach(updateRecordNode);
      syncState();
      notifyObjectChange({ history: 'commit' });
      return result;
    },
    setDocumentContext(patch = {}) {
      const result = solver.setDocumentContext?.(patch) || {};
      applySolverSnapshot();
      records.filter((record) => record.updateNode).forEach(updateRecordNode);
      syncState();
      return result;
    },
    getScale() {
      return camera.scale;
    },
    getDrawingProperties() {
      return {
        drawingUnit: solver.drawingUnit || 'in',
        dxfExportUnit: solver.dxfExportUnit || 'in',
        filletRadius: formatDrawingNumber(solver.filletRadius),
      };
    },
    setDrawingProperties(properties) {
      const next = solver.setDrawingProperties(properties);
      applySolverSnapshot();
      notifyObjectChange();
      return next;
    },
    onObjectsChange(listener) {
      objectChangeListeners.add(listener);
      return () => objectChangeListeners.delete(listener);
    },
    onPresentationChange(listener) {
      presentationChangeListeners.add(listener);
      return () => presentationChangeListeners.delete(listener);
    },
    onSelectionChange(listener) {
      selectionChangeListeners.add(listener);
      listener(cloneEntity(selectionProperties()));
      return () => selectionChangeListeners.delete(listener);
    },
    getSelectionProperties: selectionProperties,
    clearSelection,
    selectRecords,
    deleteRecords,
    requestHistoryCheckpoint,
    registerDrawingExtension,
    setSelectedGeometryAppearance,
    setSelectedSeamLine: seamLineSystem.setSelectedSeamLine,
    getSelectedSubtractParent: subtractSystem.selectedParentOwner,
    getSubtractOwnerFromEvent: subtractSystem.ownerFromEvent,
    addSubtractRelation: subtractSystem.addSubtractRelation,
    setSelectedVisibility(patch = {}) {
      const provider = [...selectionPropertyProviders].find((candidate) => (
        candidate.selectionProperties?.()?.canEditVisible
        && typeof candidate.setSelectedVisibility === 'function'
      ));
      if (provider) return provider.setSelectedVisibility(patch);
      return objectVisibilitySystem.setSelectedVisibility(patch);
    },
    getVisibilityProperties: objectVisibilitySystem.propertiesForRecordIds,
    setRecordVisibility: objectVisibilitySystem.setRecordVisibility,
    setSelectedTextProperties,
    setSelectedConstruction,
    arrangeSelectedGeometry,
    setDrawingMode(value) {
      drawingMode = value;
      if (!drawingMode) clearPreview();
    },
    setDrawingToolDelegate(delegate) {
      drawingDelegate = delegate;
    },
    setDrawingHint(helper) {
      drawingHint = helper;
    },
    setFeatureCommandDelegate(delegate) {
      featureCommandDelegate = delegate;
      objectLayer.classList.toggle('feature-command-active', Boolean(featureCommandDelegate));
      if (!featureCommandDelegate) {
        setSmartDimensionFeatureSelection([]);
      }
      syncState();
    },
    setOriginPointEnabled(enabled) {
      originPoint.classList.toggle('enabled', Boolean(enabled));
      if (!enabled) originHandle.classList.remove('smart-selected');
    },
    setPointHandlesEnabled(enabled) {
      canvas.classList.toggle('point-handles-disabled', !enabled);
    },
    setReferenceHighlight(recordIds = []) {
      const highlightedIds = new Set(
        recordIds.filter((recordId) => recordId && recordId !== CANVAS_ORIGIN_RECORD_ID),
      );
      records.forEach((record) => {
        record.group.classList.toggle('reference-highlighted', highlightedIds.has(record.id));
      });
    },
    setConstraintOverlaySystem(system) {
      constraintOverlaySystem = system;
      constraintOverlaySystem?.render?.();
    },
    setPreview,
    setPreviewEntities,
    setDimensionPreview,
    setSmartDimensionDelegate(delegate) {
      smartDimensionDelegate = delegate;
      if (!smartDimensionDelegate) {
        setSmartDimensionFeatureSelection([]);
        clearPreview();
      }
      syncState();
    },
    getSmartDimensionMode() {
      return smartDimensionDelegate?.mode || null;
    },
    registerDerivedDimensionFeatureProvider(provider) {
      if (!provider || typeof provider !== 'object') return () => {};
      derivedDimensionFeatureProviders.add(provider);
      refreshLinkedDimensions();
      return () => derivedDimensionFeatureProviders.delete(provider);
    },
    registerSubtractOperandProvider(provider) {
      if (!provider || typeof provider.owners !== 'function') return () => {};
      subtractOperandProviders.add(provider);
      subtractSystem.refreshPresentation();
      renderClosedRegions();
      notchSystem.refresh();
      seamLineSystem.refresh();
      syncState();
      return () => {
        subtractOperandProviders.delete(provider);
        subtractSystem.refreshPresentation();
        renderClosedRegions();
        notchSystem.refresh();
        seamLineSystem.refresh();
        syncState();
      };
    },
    registerSelectionPropertyProvider(provider) {
      if (!provider || typeof provider.selectionProperties !== 'function') return () => {};
      selectionPropertyProviders.add(provider);
      syncState();
      return () => {
        selectionPropertyProviders.delete(provider);
        syncState();
      };
    },
    setSmartDimensionFeatureSelection,
    setFeatureSelection: setSmartDimensionFeatureSelection,
    getFeatureFromEvent: featureFromEvent,
    getNotchHostFeatureFromEvent: notchBoundaryResolver.featureFromEvent,
    getEntityFeature,
    getSegmentFeature,
    getPointFeature,
    getDimensionFeatureSet,
    applySolverSnapshot,
    updateDimensionParameterName,
    setDimensionTextMode,
    refreshLinkedDimensions,
    syncState,
    notifyObjectChange,
  };
}
