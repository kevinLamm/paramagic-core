import { GLOBAL_LAYER_ID } from './StackCoordinates.js';
import {
  isCanvasPresentationSourceNode,
  mountCanvasPresentationSvg,
} from './CanvasPresentation.js';
import {
  DEFAULT_STACK_ROLE,
  STACK_NODE_KIND,
  createStackId,
  createStackTreeIndex,
  defaultStackId,
  isDrawableStack,
  normalizeStackArchitectureState,
  reparentStack as reparentStackState,
  reorderStack as reorderStackState,
  subtreeStackIds,
  validateStackReparent,
} from './StackArchitecture.js';
import {
  normalizedStackName,
  stackNameError,
  uniqueStackName,
} from './NamingSystem.js';

export { valueOnlyDimensionText } from './CanvasPresentation.js';

export const STACK_EXTENSION_VERSION = 4;
export const STACK_HIDDEN_CLASS = 'stack-hidden';
export const STACK_INACTIVE_CLASS = 'stack-inactive';
export const STACK_HOVERED_CLASS = 'stack-hovered';
export const STACK_HOVER_OVERLAY_CLASS = 'stack-hover-overlay-record';
export const STACK_HOVER_OVERLAY_GRAPHIC_CLASS = 'stack-hover-overlay-graphic';
export const STACK_DISABLED_CLASS = 'stack-disabled';
export const STACK_INACTIVE_HIT_TEST_BLOCKED_CLASS = 'inactive-stack-hit-test-blocked';
export const INITIAL_USER_STACK_NAME = 'Stack 1';

const STACK_HOVER_GRAPHIC_SELECTOR = [
  '.selectable-entity:not(.hit-target):not(.segment-select-line):not(.dimension-text-hit)',
  '.resolved-boundary-visual',
  '.seam-line-path',
  '.closed-constrained-region',
].join(', ');

const STACK_INTERACTION_OVERRIDE_CLASSES = [
  'dimension-selection-active',
  'constraint-selection-active',
];

const clone = (value) => JSON.parse(JSON.stringify(value));

export function createDefaultStack() {
  const state = normalizeStackArchitectureState();
  return clone(state.stacks.find(({ systemRole }) => systemRole === DEFAULT_STACK_ROLE));
}

export function normalizeStackState(value = null) {
  return normalizeStackArchitectureState(value);
}

function userStacks(stackState) {
  return stackState.stacks.filter((stack) => stack.removable && isDrawableStack(stack));
}

function nextAutomaticStackName(stackState) {
  const names = new Set(stackState.stacks.map(({ name }) => String(name || '').toLocaleLowerCase()));
  let number = 1;
  while (names.has(`stack ${number}`)) number += 1;
  return `Stack ${number}`;
}

function newUserStackRecord(stackState, requestedName = INITIAL_USER_STACK_NAME) {
  const id = createStackId();
  return {
    id,
    kind: STACK_NODE_KIND,
    sourceStackId: null,
    parentStackId: null,
    order: stackState.stacks.filter(({ parentStackId }) => !parentStackId).length,
    name: uniqueStackName(requestedName, stackState.stacks, { fallback: INITIAL_USER_STACK_NAME }),
    visible: true,
    enabled: true,
    enabledExpression: '',
    removable: true,
  };
}

export function createNewDrawingStackState() {
  return normalizeStackState();
}

export function entityStackId(entity, knownStackIds = null, fallbackStackId = null) {
  const requested = String(entity?.stackId || '').trim();
  if (!requested) return fallbackStackId;
  if (knownStackIds && !knownStackIds.has(requested)) return fallbackStackId;
  return requested;
}

export function inactiveStackInteractionAllowed(canvasElement) {
  return STACK_INTERACTION_OVERRIDE_CLASSES.some((className) => (
    canvasElement?.classList?.contains?.(className)
  ));
}

export function shouldBlockInactiveStackHitTesting({
  drawingMode = false,
  featureCommandDelegate = null,
  smartDimensionDelegate = null,
  explicitBlockerCount = 0,
} = {}) {
  if (drawingMode || explicitBlockerCount > 0) return true;
  const delegate = featureCommandDelegate || smartDimensionDelegate;
  return Boolean(delegate && delegate.allowInactiveStackInteraction !== true);
}

export function syncInactiveStackHitTesting(canvasElement, state = {}) {
  const blocked = shouldBlockInactiveStackHitTesting(state);
  canvasElement?.classList?.toggle?.(STACK_INACTIVE_HIT_TEST_BLOCKED_CLASS, blocked);
  return blocked;
}

export function stackIdForCanvasInteractionTarget(target, canvasElement = null) {
  const owner = target?.closest?.('[data-stack-id]');
  if (!owner || (canvasElement?.contains && !canvasElement.contains(owner))) return null;
  return String(owner.dataset?.stackId || '').trim() || null;
}

export function bindCanvasStackInteractions({
  canvasElement,
  getActiveStackId = () => null,
  hasStack = () => false,
  selectStack = () => false,
  isToolInteractionActive = () => false,
  resolveInteractionStackId = (event) => stackIdForCanvasInteractionTarget(event?.target, canvasElement),
} = {}) {
  if (!canvasElement?.addEventListener) return () => {};

  const handleClick = (event) => {
    if (isToolInteractionActive()) return;
    if (!getActiveStackId()) return;
    const stackId = String(resolveInteractionStackId(event) || '').trim() || null;
    if (!stackId || !hasStack(stackId) || stackId === GLOBAL_LAYER_ID || stackId === getActiveStackId()) return;
    if (selectStack(stackId) === false) return;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
  };

  canvasElement.addEventListener('click', handleClick, true);
  return () => {
    canvasElement.removeEventListener?.('click', handleClick, true);
  };
}

function cloneStackHoverSource(source) {
  const clone = source?.cloneNode?.(true);
  if (!clone) return null;
  const graphics = [
    ...(clone.matches?.(STACK_HOVER_GRAPHIC_SELECTOR) ? [clone] : []),
    ...(clone.querySelectorAll?.(STACK_HOVER_GRAPHIC_SELECTOR) || []),
  ];
  if (!graphics.length) return null;

  const retained = new Set([clone]);
  graphics.forEach((graphic) => {
    graphic.classList?.remove?.(
      'selected', 'hovered', 'smart-selected', 'overlap-cycle-selected', 'object-snap-target',
    );
    graphic.classList?.add?.(STACK_HOVER_OVERLAY_GRAPHIC_CLASS);
    let cursor = graphic;
    while (cursor && cursor !== clone) {
      retained.add(cursor);
      cursor = cursor.parentElement;
    }
  });
  [...(clone.querySelectorAll?.('*') || [])].reverse().forEach((node) => {
    if (!retained.has(node)) node.remove?.();
  });
  clone.classList?.remove?.(
    STACK_HOVERED_CLASS, STACK_INACTIVE_CLASS, STACK_HIDDEN_CLASS, STACK_DISABLED_CLASS,
    'selected', 'hovered',
  );
  clone.classList?.add?.(STACK_HOVER_OVERLAY_CLASS);
  clone.removeAttribute?.('data-record-id');
  clone.removeAttribute?.('role');
  clone.removeAttribute?.('aria-label');
  clone.setAttribute?.('aria-hidden', 'true');
  [...(clone.querySelectorAll?.('[id]') || [])].forEach((node) => node.removeAttribute?.('id'));
  return clone;
}

export function renderStackHoverOverlay(layer, sources = []) {
  if (!layer?.replaceChildren) return [];
  const clones = [...new Set(sources)].map(cloneStackHoverSource).filter(Boolean);
  layer.replaceChildren(...clones);
  return clones;
}

export function isStackThumbnailSourceNode(node, stackId) {
  return isCanvasPresentationSourceNode(node, stackId);
}

export function mountCanvasStackThumbnail(host, {
  objectLayer,
  stackId,
  width = 176,
  height = 110,
  background = '#fafbfd',
  resolveValueOnlyDimensionText = null,
} = {}) {
  if (!stackId) return null;
  return mountCanvasPresentationSvg(host, {
    objectLayer,
    stackId,
    width,
    height,
    background,
    resolveValueOnlyDimensionText,
  });
}

export function stackDrawing(snapshot, stackId) {
  const storedStackState = snapshot.extensions?.stacks;
  const stackState = normalizeStackArchitectureState(storedStackState);
  const fallbackStackId = storedStackState ? defaultStackId(stackState) : null;
  const includedStackIds = new Set(
    storedStackState ? subtreeStackIds(stackState, stackId) : [stackId],
  );
  const entities = (snapshot.entities || []).filter((entity) => includedStackIds.has(entity.stackId || fallbackStackId));
  const dimensionAnnotations = (snapshot.dimensionAnnotations || [])
    .filter((entity) => includedStackIds.has(entity.stackId || fallbackStackId));
  return { ...snapshot, entities, dimensionAnnotations };
}

// --- Stack System Manager ---
export function createStackSystem({
  records,
  selectedIds,
  canvasElement = null,
  hoverOverlayLayer = null,
  resolveCanvasInteractionStackId = null,
  resolveRelationshipStackIds = null,
  isCanvasToolActive = null,
  onRecordDisabled = () => {},
  onChange = () => {},
  onPresentationChange = () => {},
} = {}) {
  let state = createNewDrawingStackState();
  let treeIndex = createStackTreeIndex(state);
  state = treeIndex.state;
  let selectedStackId = state.activeStackId;
  let hoveredStackId = null;
  let activationStateById = new Map();
  const listeners = new Set();
  const nodePresentation = new WeakMap();
  const recordEnabledState = new WeakMap();

  function replaceState(nextState) {
    state = normalizeStackState(nextState);
    treeIndex = createStackTreeIndex(state);
    state = treeIndex.state;
    if (!treeIndex.byId.has(selectedStackId)) selectedStackId = state.activeStackId;
    if (!treeIndex.byId.has(hoveredStackId)) hoveredStackId = null;
    activationStateById = new Map([...activationStateById]
      .filter(([stackId]) => treeIndex.byId.has(stackId)));
  }

  function stackIds() {
    return new Set(treeIndex.byId.keys());
  }

  function emit(reason, { history = 'coalesce', affectedStackIds = [] } = {}) {
    const snapshot = getRuntimeState();
    const change = { reason, affectedStackIds: [...new Set(affectedStackIds)] };
    listeners.forEach((listener) => listener(snapshot, change));
    return onChange({ ...change, history });
  }

  function getState() {
    return clone(state);
  }

  function activationState(stackId) {
    const runtime = activationStateById.get(stackId);
    return {
      localEnabled: runtime?.localEnabled !== false && !runtime?.error,
      error: runtime?.error || null,
      awaiting: Boolean(runtime?.awaiting),
    };
  }

  function isStackLocallyEnabled(stackId) {
    return Boolean(stack(stackId) && activationState(stackId).localEnabled);
  }

  function isStackEffectivelyEnabled(stackId) {
    if (!treeIndex.byId.has(stackId)) return false;
    let cursor = treeIndex.byId.get(stackId);
    while (cursor) {
      if (!isStackLocallyEnabled(cursor.id)) return false;
      cursor = cursor.parentStackId ? treeIndex.byId.get(cursor.parentStackId) : null;
    }
    return true;
  }

  function getRuntimeState() {
    return {
      ...getState(),
      selectedStackId,
      hoveredStackId,
      stacks: state.stacks.map((item) => ({
        ...clone(item),
        localEnabled: isStackLocallyEnabled(item.id),
        effectiveEnabled: isStackEffectivelyEnabled(item.id),
        activationError: activationState(item.id).error,
        activationAwaiting: activationState(item.id).awaiting,
      })),
    };
  }

  function restore(value, { notify = false, preserveSelection = false } = {}) {
    const previousSelection = selectedStackId;
    replaceState(value);
    selectedStackId = preserveSelection && treeIndex.byId.has(previousSelection)
      ? previousSelection
      : state.activeStackId;
    activationStateById.clear();
    if (notify) emit('restore', { history: 'none' });
    return getState();
  }

  function syncCoordinateFrames(nextState) {
    for (const next of nextState?.stacks || []) {
      const current = stack(next.id);
      if (current && next.frame) current.frame = clone(next.frame);
    }
  }

  function clear() {
    replaceState(createNewDrawingStackState());
    selectedStackId = state.activeStackId;
    activationStateById.clear();
    emit('clear', { history: 'none', affectedStackIds: [state.activeStackId] });
    return getState();
  }

  function stack(stackId) {
    return treeIndex.byId.get(stackId) || null;
  }

  function activeStackId() {
    return state.activeStackId;
  }

  function selectedStack() {
    return selectedStackId;
  }

  function hoveredStack() {
    return hoveredStackId;
  }

  function assignEntity(entity, requestedStackId = entity?.stackId || state.activeStackId) {
    const result = clone(entity || {});
    const requested = String(requestedStackId || '');
    const requestedStack = treeIndex.byId.get(requested);
    result.stackId = requestedStack && (isDrawableStack(requestedStack) || (requested === GLOBAL_LAYER_ID && entity?.coordinateSpace === 'global'))
      ? requested
      : defaultStackId(state);
    return result;
  }

  function isStackVisible(stackId) {
    return stack(stackId)?.visible !== false;
  }

  function isStackEffectivelyVisible(stackId) {
    if (!isStackEffectivelyEnabled(stackId)) return false;
    let cursor = treeIndex.byId.get(stackId);
    while (cursor) {
      if (cursor.visible === false) return false;
      cursor = cursor.parentStackId ? treeIndex.byId.get(cursor.parentStackId) : null;
    }
    return true;
  }

  function isStackActive(stackId) {
    return stackId === GLOBAL_LAYER_ID || stackId === state.activeStackId;
  }

  function setHoveredStack(stackId = null) {
    const requested = String(stackId || '').trim();
    const nextStackId = requested && treeIndex.byId.has(requested) ? requested : null;
    if (nextStackId === hoveredStackId) return true;
    const previousStackId = hoveredStackId;
    hoveredStackId = nextStackId;
    onPresentationChange({
      reason: 'hover',
      affectedStackIds: [previousStackId, hoveredStackId].filter(Boolean),
    });
    return true;
  }

  function isEntityVisible(entity) {
    return isStackEffectivelyVisible(entityStackId(entity, stackIds(), defaultStackId(state)));
  }

  function isEntityActive(entity) {
    return isStackActive(entityStackId(entity, stackIds(), defaultStackId(state)));
  }

  function isEntityRelationshipEnabled(entity) {
    const ownerStackId = entityStackId(entity, stackIds(), defaultStackId(state));
    const resolvedStackIds = typeof resolveRelationshipStackIds === 'function'
      ? resolveRelationshipStackIds(entity)
      : [];
    const relationshipStackIds = [...new Set([
      ownerStackId,
      ...(entity?.participantStackIds || []),
      ...(resolvedStackIds || []),
    ].filter(Boolean))];
    return relationshipStackIds.every(isStackEffectivelyEnabled);
  }

  function isEntityEnabled(entity) {
    const id = entityStackId(entity, stackIds(), defaultStackId(state));
    return isEntityRelationshipEnabled(entity)
      && isEntityVisible(entity)
      && (
        isEntityActive(entity)
        || inactiveStackInteractionAllowed(canvasElement)
      );
  }

  function isRecordVisible(record) {
    return Boolean(record && isEntityVisible(record.entity));
  }

  function isRecordEnabled(record) {
    return Boolean(record && isEntityEnabled(record.entity));
  }

  function orderForEntity(entity) {
    const id = entityStackId(entity, stackIds(), defaultStackId(state));
    const order = state.stacks.findIndex((candidate) => candidate.id === id);
    return order < 0 ? 0 : order;
  }

  function syncPresentation(regionNodes = [], derivedNodes = []) {
    const known = stackIds();
    const interactionOverride = inactiveStackInteractionAllowed(canvasElement);
    const hasActiveStack = Boolean(state.activeStackId);
    const syncNode = (node, id, {
      visible,
      active,
      hovered = id === hoveredStackId,
      effectiveEnabled = id === null || isStackEffectivelyEnabled(id),
    }) => {
      if (!node) return;
      const inactive = hasActiveStack && !active;
      const presentationKey = `${id ?? ''}:${visible ? 1 : 0}:${active ? 1 : 0}:${inactive ? 1 : 0}:${hovered ? 1 : 0}:${effectiveEnabled ? 1 : 0}`;
      if (nodePresentation.get(node) === presentationKey) return;
      if (id !== null) node?.setAttribute?.('data-stack-id', id);
      node?.setAttribute?.('data-stack-active', String(active));
      node?.classList?.toggle?.('stack-hidden', !visible);
      node?.classList?.toggle?.(STACK_DISABLED_CLASS, !effectiveEnabled);
      node?.classList?.toggle?.(STACK_INACTIVE_CLASS, inactive);
      node?.classList?.toggle?.(STACK_HOVERED_CLASS, hovered);
      nodePresentation.set(node, presentationKey);
    };
    (records || []).forEach((record) => {
      const id = entityStackId(record.entity, known, defaultStackId(state));
      const visible = isStackEffectivelyVisible(id);
      const active = isStackActive(id);
      const relationshipEnabled = isEntityRelationshipEnabled(record.entity);
      const enabled = relationshipEnabled
        && visible
        && (active || interactionOverride);
      syncNode(record.group, id, { visible, active, effectiveEnabled: relationshipEnabled });
      syncNode(record.handleGroup, id, { visible, active, effectiveEnabled: relationshipEnabled });
      if (!enabled && recordEnabledState.get(record) !== false) {
        selectedIds?.delete(record.id);
        onRecordDisabled(record);
      }
      recordEnabledState.set(record, enabled);
    });
    [...regionNodes].forEach((region) => {
      const parentIds = String(region.dataset?.parentIds || '').split(',').filter(Boolean);
      const parentStackIds = [...new Set(parentIds.map((recordId) => {
        const record = records?.find((candidate) => candidate.id === recordId);
        return record ? entityStackId(record.entity, known, defaultStackId(state)) : null;
      }).filter(Boolean))];
      const regionStackId = parentStackIds.length === 1 ? parentStackIds[0] : null;
      const visible = parentIds.length > 0 && parentIds.every((id) => {
        const record = records?.find((candidate) => candidate.id === id);
        return record && isRecordVisible(record);
      });
      const active = parentIds.length > 0 && parentIds.every((id) => {
        const record = records?.find((candidate) => candidate.id === id);
        return record && isEntityActive(record.entity);
      });
      syncNode(region, regionStackId, {
        visible,
        active,
        hovered: Boolean(hoveredStackId && parentStackIds.includes(hoveredStackId)),
      });
    });
    [...derivedNodes].forEach((node) => {
      const id = entityStackId({ stackId: node?.dataset?.stackId }, known, null);
      if (!id) return;
      syncNode(node, id, {
        visible: isStackEffectivelyVisible(id),
        active: isStackActive(id),
      });
    });
    const recordGroups = new Set((records || []).map(({ group }) => group).filter(Boolean));
    const hoverSources = hoveredStackId ? [
      ...(records || [])
        .filter((record) => (
          entityStackId(record.entity, known, defaultStackId(state)) === hoveredStackId
          && isRecordVisible(record)
        ))
        .map(({ group }) => group)
        .filter(Boolean),
      ...[...regionNodes].filter((node) => node?.classList?.contains?.(STACK_HOVERED_CLASS)),
      ...[...derivedNodes].filter((node) => (
        !recordGroups.has(node)
        && node?.dataset?.stackId === hoveredStackId
        && !node?.classList?.contains?.(STACK_HIDDEN_CLASS)
        && !node?.classList?.contains?.(STACK_DISABLED_CLASS)
      )),
    ] : [];
    renderStackHoverOverlay(hoverOverlayLayer, hoverSources);
  }

  function addStack(options = '') {
    const request = typeof options === 'string' ? { name: options } : (options || {});
    const parentStackId = request.parentStackId || null;
    if (parentStackId && (!stack(parentStackId) || parentStackId === GLOBAL_LAYER_ID)) return null;
    const id = createStackId();
    const automaticName = nextAutomaticStackName(state);
    const requestedName = normalizedStackName(request.name, automaticName);
    const siblingCount = treeIndex.children(parentStackId).length;
    const created = {
      id,
      kind: STACK_NODE_KIND,
      sourceStackId: null,
      parentStackId,
      order: siblingCount,
      name: uniqueStackName(requestedName, state.stacks, { fallback: automaticName }),
      visible: true,
      enabled: true,
      enabledExpression: '',
      removable: true,
    };
    replaceState({ ...state, stacks: [...state.stacks, created] });
    if (Number.isFinite(Number(request.siblingIndex))) {
      replaceState(reparentStackState(state, id, parentStackId, request.siblingIndex));
    }
    selectedStackId = id;
    emit('add', { history: 'commit', affectedStackIds: [id] });
    return clone(stack(id));
  }

  function addChildStack(parentStackId, name = '') {
    return addStack({ name, parentStackId });
  }

  function addSiblingStack(stackId, name = '') {
    const sibling = stack(stackId);
    if (!sibling) return null;
    return addStack({ name, parentStackId: sibling.parentStackId, siblingIndex: sibling.order + 1 });
  }

  function renameStack(stackId, name, { notify = true } = {}) {
    const target = stack(stackId);
    if (!target || stackId === GLOBAL_LAYER_ID) return false;
    const requested = normalizedStackName(name, target.name);
    if (stackNameError(requested)) return false;
    const next = uniqueStackName(requested, state.stacks, { excludeId: stackId, fallback: target.name });
    if (next === target.name) return true;
    target.name = next;
    if (notify) emit('rename', { affectedStackIds: [stackId] });
    return true;
  }

  function setSelectedStack(stackId) {
    if (!stack(stackId)) return false;
    if (selectedStackId === stackId) return true;
    selectedStackId = stackId;
    emit('select', { history: 'none', affectedStackIds: [stackId] });
    return true;
  }

  function setActiveStack(stackId) {
    const requestedId = stackId == null ? null : String(stackId);
    const target = requestedId ? stack(requestedId) : null;
    if (requestedId && (!target || !isDrawableStack(target))) return false;
    if (state.activeStackId === requestedId) return true;
    const previousActiveStackId = state.activeStackId;
    state.activeStackId = requestedId;
    if (requestedId) selectedStackId = requestedId;
    emit('activate', {
      history: 'none',
      affectedStackIds: [previousActiveStackId, requestedId].filter(Boolean),
    });
    return true;
  }

  function setStackVisible(stackId, visible) {
    const target = stack(stackId);
    if (!target) return false;
    const next = Boolean(visible);
    if (target.visible === next) return true;
    target.visible = next;
    emit('visibility', { affectedStackIds: subtreeStackIds(state, stackId) });
    return true;
  }

  function setStackEnabled(stackId, enabled) {
    const target = stack(stackId);
    if (!target || stackId === GLOBAL_LAYER_ID) return false;
    const next = Boolean(enabled);
    if (target.enabled === next) return true;
    target.enabled = next;
    const outcome = emit('enabled', { history: 'commit', affectedStackIds: subtreeStackIds(state, stackId) });
    return outcome?.status === 'failed'
      ? { success: false, ...outcome }
      : { success: true, status: outcome?.status || 'unchanged' };
  }

  function setStackEnabledExpression(stackId, expression) {
    const target = stack(stackId);
    if (!target || stackId === GLOBAL_LAYER_ID) return false;
    const next = String(expression ?? '').trim();
    if (target.enabledExpression === next) return true;
    target.enabledExpression = next;
    const outcome = emit('enabled-expression', { history: 'commit', affectedStackIds: subtreeStackIds(state, stackId) });
    return outcome?.status === 'failed'
      ? { success: false, ...outcome }
      : { success: true, status: outcome?.status || 'unchanged' };
  }

  function setActivationStates(nextStates, { notify = true } = {}) {
    const entries = nextStates instanceof Map ? [...nextStates] : Object.entries(nextStates || {});
    activationStateById = new Map(entries
      .filter(([stackId]) => treeIndex.byId.has(stackId))
      .map(([stackId, runtime]) => [stackId, {
        localEnabled: runtime?.localEnabled !== false,
        error: runtime?.error || null,
        awaiting: Boolean(runtime?.awaiting),
      }]));
    if (notify) emit('activation', { history: 'none', affectedStackIds: state.stacks.map(({ id }) => id) });
    return getRuntimeState();
  }

  function moveStack(stackId, direction) {
    const targetStack = stack(stackId);
    if (!targetStack || stackId === GLOBAL_LAYER_ID) return false;
    const delta = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
    return delta ? reorderStack(stackId, targetStack.order + delta) : false;
  }

  function moveStackToIndex(stackId, requestedIndex) {
    const targetStack = stack(stackId);
    if (!targetStack) return false;
    return reorderStack(stackId, requestedIndex);
  }

  function reparentStack(stackId, parentStackId = null, siblingIndex = Number.POSITIVE_INFINITY) {
    const validation = validateStackReparent(state, stackId, parentStackId);
    if (!validation.valid) return false;
    const next = reparentStackState(state, stackId, parentStackId, siblingIndex);
    if (JSON.stringify(next) === JSON.stringify(state)) return true;
    replaceState(next);
    emit('reparent', { history: 'commit', affectedStackIds: subtreeStackIds(state, stackId) });
    return true;
  }

  function reorderStack(stackId, siblingIndex) {
    const target = stack(stackId);
    if (!target || stackId === GLOBAL_LAYER_ID) return false;
    const next = reorderStackState(state, stackId, siblingIndex);
    if (JSON.stringify(next) === JSON.stringify(state)) return true;
    replaceState(next);
    emit('reorder', { history: 'commit', affectedStackIds: subtreeStackIds(state, stackId) });
    return true;
  }

  function removeStackSubtree(stackId) {
    const target = stack(stackId);
    if (!target?.removable) return false;
    const removedStackIds = subtreeStackIds(state, stackId);
    const recordIds = recordIdsForSubtree(stackId);
    const unavailable = new Set(removedStackIds);
    const remainingStacks = state.stacks.filter(({ id }) => !unavailable.has(id));
    const replacementStack = userStacks({ stacks: remainingStacks }).length
      ? null
      : newUserStackRecord({ stacks: remainingStacks });
    if (replacementStack) replacementStack.systemRole = DEFAULT_STACK_ROLE;
    replaceState({
      ...state,
      activeStackId: replacementStack?.id
        || (unavailable.has(state.activeStackId) ? null : state.activeStackId),
      stacks: replacementStack ? [...remainingStacks, replacementStack] : remainingStacks,
    });
    if (replacementStack || unavailable.has(selectedStackId)) selectedStackId = state.activeStackId;
    emit('remove-subtree', {
      history: 'commit',
      affectedStackIds: [...removedStackIds, replacementStack?.id].filter(Boolean),
    });
    return { removedStackIds, recordIds, createdStackId: replacementStack?.id || null };
  }

  function removeStack(stackId) {
    return Boolean(removeStackSubtree(stackId));
  }

  function recordIdsForStack(stackId) {
    const known = stackIds();
    return (records || [])
      .filter((record) => entityStackId(record.entity, known, defaultStackId(state)) === stackId)
      .map((record) => record.id);
  }

  function recordIdsForSubtree(stackId) {
    const owners = new Set(subtreeStackIds(state, stackId));
    const known = stackIds();
    return (records || [])
      .filter((record) => owners.has(entityStackId(record.entity, known, defaultStackId(state))))
      .map((record) => record.id);
  }

  function onStateChange(listener) {
    listeners.add(listener);
    listener(getRuntimeState(), { reason: 'subscribe', affectedStackIds: state.stacks.map(({ id }) => id) });
    return () => listeners.delete(listener);
  }

  const stopCanvasStackInteractions = bindCanvasStackInteractions({
    canvasElement,
    getActiveStackId: activeStackId,
    hasStack: (stackId) => Boolean(stack(stackId)),
    selectStack: setSelectedStack,
    isToolInteractionActive: isCanvasToolActive
      || (() => inactiveStackInteractionAllowed(canvasElement)),
    resolveInteractionStackId: resolveCanvasInteractionStackId
      || ((event) => stackIdForCanvasInteractionTarget(event?.target, canvasElement)),
  });

  return {
    getState,
    syncCoordinateFrames,
    getRuntimeState,
    restore,
    clear,
    stack,
    stackIds,
    activeStackId,
    selectedStackId: selectedStack,
    hoveredStackId: hoveredStack,
    assignEntity,
    isStackVisible,
    isStackLocallyEnabled,
    isStackEffectivelyEnabled,
    isStackEffectivelyVisible,
    isStackActive,
    setHoveredStack,
    isEntityVisible,
    isEntityActive,
    isEntityEnabled,
    isRecordVisible,
    isRecordEnabled,
    orderForEntity,
    syncPresentation,
    addStack,
    addChildStack,
    addSiblingStack,
    renameStack,
    setSelectedStack,
    setActiveStack,
    setStackVisible,
    setStackEnabled,
    setStackEnabledExpression,
    setActivationStates,
    moveStack,
    moveStackToIndex,
    reparentStack,
    reorderStack,
    removeStack,
    removeStackSubtree,
    recordIdsForStack,
    recordIdsForSubtree,
    onStateChange,
    destroy: stopCanvasStackInteractions,
    extensionProvider: {
      serialize: getState,
      restore(value) {
        return restore(value, { notify: true });
      },
      clear,
    },
  };
}
