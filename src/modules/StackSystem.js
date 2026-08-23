import { createStableId } from './solver/SolverModel.js';
import { DRAWING_CANVAS_BACKGROUND } from './DrawingIO.js';
import { bindFloatingPanelDrag } from './CanvasUIControls.js';
import {
  isCanvasPresentationSourceNode,
  mountCanvasPresentationSvg,
} from './CanvasPresentation.js';

export { valueOnlyDimensionText } from './CanvasPresentation.js';

export const DEFAULT_STACK_ID = 'stack-default';
export const STACK_EXTENSION_VERSION = 1;
export const STACK_INACTIVE_CLASS = 'stack-inactive';

const STACK_INTERACTION_OVERRIDE_CLASSES = [
  'dimension-selection-active',
  'constraint-selection-active',
];

const clone = (value) => JSON.parse(JSON.stringify(value));

function normalizedName(value, fallback) {
  const name = String(value ?? '').trim();
  return name || fallback;
}

export function createDefaultStack() {
  return {
    id: DEFAULT_STACK_ID,
    name: 'Default',
    visible: true,
    removable: false,
  };
}

export function normalizeStackState(value = null) {
  const input = value && typeof value === 'object' ? value : {};
  const sourceStacks = Array.isArray(input.stacks) ? input.stacks : [];
  const seen = new Set();
  const stacks = [];
  sourceStacks.forEach((item, index) => {
    const requestedId = String(item?.id || '').trim();
    if (!requestedId || seen.has(requestedId)) return;
    seen.add(requestedId);
    if (requestedId === DEFAULT_STACK_ID) {
      stacks.push({
        ...createDefaultStack(),
        name: normalizedName(item?.name, 'Default'),
        visible: item?.visible !== false,
      });
      return;
    }
    stacks.push({
      id: requestedId,
      name: normalizedName(item?.name, `Stack ${index + 1}`),
      visible: item?.visible !== false,
      removable: true,
    });
  });
  if (!seen.has(DEFAULT_STACK_ID)) {
    stacks.unshift(createDefaultStack());
    seen.add(DEFAULT_STACK_ID);
  }
  const activeStackId = seen.has(String(input.activeStackId || ''))
    ? String(input.activeStackId)
    : DEFAULT_STACK_ID;
  return { version: STACK_EXTENSION_VERSION, activeStackId, stacks };
}

export function entityStackId(entity, knownStackIds = null) {
  const requested = String(entity?.stackId || '').trim();
  if (!requested) return DEFAULT_STACK_ID;
  if (knownStackIds && !knownStackIds.has(requested)) return DEFAULT_STACK_ID;
  return requested;
}

export function inactiveStackInteractionAllowed(canvasElement) {
  return STACK_INTERACTION_OVERRIDE_CLASSES.some((className) => (
    canvasElement?.classList?.contains?.(className)
  ));
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
} = {}) {
  if (!stackId) return null;
  return mountCanvasPresentationSvg(host, {
    objectLayer,
    stackId,
    width,
    height,
    background,
  });
}

// --- Stack Panel ---
const icon = (path) => `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const icons = {
  add: icon('<path d="M12 5v14M5 12h14"/>'),
  insert: icon('<path d="M12 3v12m0 0l-4-4m4 4l4-4M5 19h14"/>'),
  visible: icon('<path d="M2.5 12c2.5-4 6-6 9.5-6s7 2 9.5 6c-2.5 4-6 6-9.5 6s-7-2-9.5-6z"/><circle cx="12" cy="12" r="2.5"/>'),
  hidden: icon('<path d="M4 4l16 16M9.2 6.5A10.7 10.7 0 0112 6c6 0 9.5 6 9.5 6a15 15 0 01-2.4 3.1M6.4 8.1C3.9 9.8 2.5 12 2.5 12s3.5 6 9.5 6a10 10 0 003-.5"/>'),
  menu: icon('<circle cx="5" cy="12" r="1.25" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.25" fill="currentColor" stroke="none"/>'),
  select: icon('<path d="M5 3l12 10-6 1 3 6-2.5 1-3-6-3.5 4z"/>'),
  move: icon('<path d="M12 3v18M3 12h18M12 3l-3 3m3-3l3 3M12 21l-3-3m3 3l3-3M3 12l3-3m-3 3l3 3M21 12l-3-3m3 3l-3 3"/>'),
  export: icon('<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14"/>'),
  json: icon('<path d="M8 3H5v18h3M16 3h3v18h-3M10 8l-2 4 2 4M14 8l2 4-2 4"/>'),
  dxf: icon('<path d="M4 5h6l3 3h7v11H4zM7 11v5m0-5h2.5a2.5 2.5 0 010 5H7"/>'),
  png: icon('<path d="M5 4h10l4 4v12H5zM15 4v5h5"/><circle cx="10" cy="12" r="1.5"/><path d="M7 17l3-3 2 2 2-3 3 4"/>'),
  svg: icon('<path d="M5 4h10l4 4v12H5zM15 4v5h5M8 13l2-2m-2 2 2 2M16 13l-2-2m2 2-2 2M13 10l-2 6"/>'),
  remove: icon('<path d="M5 7h14M9 7V4h6v3m-8 0l1 13h8l1-13M10 10v7m4-7v7"/>'),
};

function button(className, title, content, attributes = '') {
  return `<button type="button" class="${className}" title="${title}" aria-label="${title}" ${attributes}>${content}</button>`;
}

export function stackExportMenuMarkup() {
  return `<button type="button" class="stack-card-export-toggle" data-stack-export-toggle aria-expanded="false">${icons.export}<span>Export</span><span class="stack-card-submenu-indicator" aria-hidden="true">›</span></button>
    <div class="stack-card-export-options" data-stack-export-options hidden>
      <button type="button" data-stack-export="dxf">${icons.dxf}<span>DXF</span></button>
      <button type="button" data-stack-export="svg">${icons.svg}<span>SVG</span></button>
      <button type="button" data-stack-export="png">${icons.png}<span>PNG</span></button>
      <button type="button" data-stack-export="json">${icons.json}<span>JSON</span></button>
    </div>`;
}

export function stackDrawing(snapshot, stackId) {
  const entities = (snapshot.entities || []).filter((entity) => (entity.stackId || 'stack-default') === stackId);
  const dimensionAnnotations = (snapshot.dimensionAnnotations || [])
    .filter((entity) => (entity.stackId || 'stack-default') === stackId);
  return { ...snapshot, entities, dimensionAnnotations };
}

export function createStackPanel({
  toggle,
  canvas,
  host = document.querySelector('.app-shell') || document.body,
  onExport = () => {},
  onImport = () => {},
  onRemove = (stackId) => canvas.removeStack(stackId),
  onMoveSelection = (stackId) => canvas.moveSelectionToStack(stackId),
} = {}) {
  const panel = document.createElement('section');
  const fileInput = document.createElement('input');
  const confirmBackdrop = document.createElement('div');
  let state = canvas.getStackState();
  let cardDrag = null;
  let suppressCardClick = false;
  let renameCancelled = false;
  let thumbnailFrame = null;

  panel.className = 'floating-panel stack-panel';
  panel.id = 'stackPanel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Stacks');
  panel.innerHTML = `
    <div class="stack-panel-header">
      <h2>Stacks</h2>
      ${button('panel-close-button stack-panel-close', 'Close Stacks', '&times;')}
    </div>
    <div class="stack-panel-actions">
      ${button('stack-action-button', 'Add Stack', icons.add, 'data-stack-add')}
      ${button('stack-action-button', 'Insert Stack JSON', icons.insert, 'data-stack-insert')}
    </div>
    <div class="stack-list" data-stack-list aria-label="Stack items"></div>
  `;
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.hidden = true;
  fileInput.dataset.stackImportInput = 'true';
  confirmBackdrop.className = 'stack-confirm-backdrop';
  confirmBackdrop.hidden = true;
  confirmBackdrop.innerHTML = `
    <section class="stack-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="stackDeleteTitle" aria-describedby="stackDeleteMessage">
      <h2 id="stackDeleteTitle">Delete Stack?</h2>
      <p id="stackDeleteMessage" data-stack-delete-message></p>
      <div class="stack-confirm-actions">
        <button type="button" data-stack-delete-cancel>Cancel</button>
        <button type="button" class="destructive" data-stack-delete-confirm>Delete Stack</button>
      </div>
    </section>
  `;
  host.append(panel, fileInput, confirmBackdrop);

  const list = panel.querySelector('[data-stack-list]');
  const deleteMessage = confirmBackdrop.querySelector('[data-stack-delete-message]');
  const deleteConfirm = confirmBackdrop.querySelector('[data-stack-delete-confirm]');

  function setVisible(visible) {
    panel.hidden = !visible;
    if (visible) {
      render(canvas.getStackState());
      panelDragController.clamp();
    }
    toggle?.classList.toggle('active', visible);
    toggle?.setAttribute('aria-pressed', String(visible));
  }

  function cardMarkup(stack) {
    const active = state.activeStackId === stack.id;
    const safeName = escapeHtml(stack.name);
    return `<article class="stack-card${active ? ' active' : ''}${stack.visible ? '' : ' hidden-stack'}"
      data-stack-id="${escapeHtml(stack.id)}" tabindex="0" role="group"
      aria-label="${safeName} stack${active ? ', active' : ''}">
      <div class="stack-card-thumbnail" aria-hidden="true"></div>
      ${button('stack-card-control stack-card-visibility', stack.visible ? 'Hide Stack' : 'Show Stack', stack.visible ? icons.visible : icons.hidden, 'data-stack-visibility')}
      ${button('stack-card-control stack-card-menu-toggle', `Open ${safeName} tools`, icons.menu, 'data-stack-menu-toggle aria-expanded="false"')}
      <div class="stack-card-menu" data-stack-menu hidden>
        <button type="button" data-stack-select>${icons.select}<span>Select Objects</span></button>
        <button type="button" data-stack-move-selection>${icons.move}<span>Move Selection Here</span></button>
        ${stackExportMenuMarkup()}
        <button type="button" class="destructive" data-stack-remove${stack.removable ? '' : ' disabled title="Default Stack Cannot Be Removed"'}>${icons.remove}<span>Delete Stack</span></button>
      </div>
      <button type="button" class="stack-card-label" data-stack-label title="Double-click to rename">${safeName}</button>
      <input class="stack-card-name-editor" data-stack-name value="${safeName}" aria-label="Stack name" hidden />
    </article>`;
  }

  function closeMenus(except = null) {
    list.querySelectorAll('[data-stack-menu]').forEach((menu) => {
      if (menu === except) return;
      menu.hidden = true;
      const exportOptions = menu.querySelector('[data-stack-export-options]');
      const exportToggle = menu.querySelector('[data-stack-export-toggle]');
      if (exportOptions) exportOptions.hidden = true;
      exportToggle?.setAttribute('aria-expanded', 'false');
      const card = menu.closest('.stack-card');
      card?.classList.remove('menu-open');
      const control = card?.querySelector('[data-stack-menu-toggle]');
      control?.setAttribute('aria-expanded', 'false');
    });
  }

  function clearDropMarkers() {
    list.querySelectorAll('.stack-card').forEach((card) => card.classList.remove('dragging', 'drop-before', 'drop-after'));
  }

  function render(nextState = canvas.getStackState()) {
    state = nextState;
    const canvasBackground = getComputedStyle(document.documentElement)
      .getPropertyValue('--canvas-background').trim() || DRAWING_CANVAS_BACKGROUND;
    list.innerHTML = state.stacks.map(cardMarkup).join('');
    list.querySelectorAll('.stack-card[data-stack-id]').forEach((card) => {
      mountCanvasStackThumbnail(card.querySelector('.stack-card-thumbnail'), {
        objectLayer: canvas.getObjectLayer?.(),
        width: 176,
        height: 110,
        stackId: card.dataset.stackId,
        background: canvasBackground,
      });
    });
  }

  function scheduleRender() {
    if (panel.hidden) return;
    if (thumbnailFrame !== null) cancelAnimationFrame(thumbnailFrame);
    thumbnailFrame = requestAnimationFrame(() => {
      thumbnailFrame = requestAnimationFrame(() => {
        thumbnailFrame = null;
        render();
      });
    });
  }

  function beginRename(card) {
    const label = card.querySelector('[data-stack-label]');
    const input = card.querySelector('[data-stack-name]');
    renameCancelled = false;
    label.hidden = true;
    input.hidden = false;
    input.focus();
    input.select();
  }

  function finishRename(input, { cancel = false } = {}) {
    const card = input.closest('.stack-card[data-stack-id]');
    if (!card) return;
    const stack = state.stacks.find(({ id }) => id === card.dataset.stackId);
    if (!cancel) canvas.renameStack(card.dataset.stackId, input.value);
    else {
      input.value = stack?.name || input.value;
      input.hidden = true;
      card.querySelector('[data-stack-label]').hidden = false;
    }
  }

  function openDeleteConfirmation(stackId) {
    const stack = state.stacks.find(({ id }) => id === stackId);
    if (!stack?.removable) return;
    deleteMessage.textContent = `Delete “${stack.name}”? Its objects will be moved to the Default stack.`;
    deleteConfirm.dataset.stackId = stackId;
    confirmBackdrop.hidden = false;
    deleteConfirm.focus();
  }

  function closeDeleteConfirmation() {
    confirmBackdrop.hidden = true;
    deleteConfirm.removeAttribute('data-stack-id');
  }

  toggle?.addEventListener('click', () => setVisible(panel.hidden));
  panel.querySelector('.stack-panel-close').addEventListener('click', () => setVisible(false));
  panel.querySelector('[data-stack-add]').addEventListener('click', () => canvas.addStack());
  panel.querySelector('[data-stack-insert]').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const [file] = fileInput.files || [];
    fileInput.value = '';
    if (file) await onImport(file);
  });

  list.addEventListener('click', (event) => {
    if (suppressCardClick) {
      suppressCardClick = false;
      event.preventDefault();
      return;
    }
    const card = event.target.closest?.('.stack-card[data-stack-id]');
    if (!card) return;
    const stackId = card.dataset.stackId;
    const menuToggle = event.target.closest('[data-stack-menu-toggle]');
    if (menuToggle) {
      const menu = card.querySelector('[data-stack-menu]');
      const open = menu.hidden;
      closeMenus(open ? menu : null);
      menu.hidden = !open;
      const exportOptions = menu.querySelector('[data-stack-export-options]');
      const exportToggle = menu.querySelector('[data-stack-export-toggle]');
      if (exportOptions) exportOptions.hidden = true;
      exportToggle?.setAttribute('aria-expanded', 'false');
      card.classList.toggle('menu-open', open);
      menuToggle.setAttribute('aria-expanded', String(open));
      return;
    }
    const exportToggle = event.target.closest('[data-stack-export-toggle]');
    if (exportToggle) {
      const exportOptions = card.querySelector('[data-stack-export-options]');
      const open = exportOptions.hidden;
      exportOptions.hidden = !open;
      exportToggle.setAttribute('aria-expanded', String(open));
      return;
    }
    if (event.target.closest('[data-stack-visibility]')) {
      const stack = state.stacks.find(({ id }) => id === stackId);
      canvas.setStackVisible(stackId, !stack.visible);
    } else if (event.target.closest('[data-stack-select]')) {
      canvas.selectStack(stackId);
      closeMenus();
    } else if (event.target.closest('[data-stack-move-selection]')) {
      onMoveSelection(stackId);
      closeMenus();
    } else if (event.target.closest('[data-stack-export]')) {
      onExport(stackId, event.target.closest('[data-stack-export]').dataset.stackExport);
      closeMenus();
    } else if (event.target.closest('[data-stack-remove]')) {
      closeMenus();
      openDeleteConfirmation(stackId);
    } else if (event.target.closest('[data-stack-label]')) {
      canvas.setActiveStack(stackId);
    } else if (!event.target.closest('button, input')) {
      canvas.setActiveStack(stackId);
    }
  });
  list.addEventListener('dblclick', (event) => {
    const label = event.target.closest?.('[data-stack-label]');
    const card = label?.closest('.stack-card[data-stack-id]');
    if (!card) return;
    event.preventDefault();
    beginRename(card);
  });
  list.addEventListener('focusout', (event) => {
    const input = event.target.closest?.('[data-stack-name]');
    if (!input) return;
    const cancel = renameCancelled;
    renameCancelled = false;
    finishRename(input, { cancel });
  });
  list.addEventListener('keydown', (event) => {
    const input = event.target.closest?.('[data-stack-name]');
    if (input) {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        renameCancelled = true;
        input.blur();
      }
      return;
    }
    const card = event.target.closest?.('.stack-card[data-stack-id]');
    if (card && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      canvas.setActiveStack(card.dataset.stackId);
    }
  });

  list.addEventListener('pointerdown', (event) => {
    const card = event.target.closest?.('.stack-card[data-stack-id]');
    if (!card || event.button !== 0 || event.target.closest('button, input, [data-stack-menu]')) return;
    closeMenus();
    cardDrag = {
      pointerId: event.pointerId,
      stackId: card.dataset.stackId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      targetId: card.dataset.stackId,
      after: false,
      card,
    };
    card.setPointerCapture(event.pointerId);
  });
  list.addEventListener('pointermove', (event) => {
    if (!cardDrag || cardDrag.pointerId !== event.pointerId) return;
    if (!cardDrag.moved && Math.hypot(event.clientX - cardDrag.startX, event.clientY - cardDrag.startY) < 5) return;
    cardDrag.moved = true;
    event.preventDefault();
    const listBounds = list.getBoundingClientRect();
    if (event.clientY < listBounds.top + 32) list.scrollTop -= 20;
    else if (event.clientY > listBounds.bottom - 32) list.scrollTop += 20;
    clearDropMarkers();
    cardDrag.card.classList.add('dragging');
    const candidates = [...list.querySelectorAll('.stack-card[data-stack-id]')]
      .filter((card) => card.dataset.stackId !== cardDrag.stackId);
    let target = candidates.find((card) => {
      const bounds = card.getBoundingClientRect();
      return event.clientY >= bounds.top && event.clientY <= bounds.bottom;
    });
    if (!target && candidates.length) {
      target = event.clientY < candidates[0].getBoundingClientRect().top
        ? candidates[0]
        : candidates[candidates.length - 1];
    }
    if (!target) return;
    const bounds = target.getBoundingClientRect();
    cardDrag.targetId = target.dataset.stackId;
    cardDrag.after = event.clientY >= bounds.top + bounds.height / 2;
    target.classList.add(cardDrag.after ? 'drop-after' : 'drop-before');
  });
  function finishCardDrag(event, cancelled = false) {
    if (!cardDrag || cardDrag.pointerId !== event.pointerId) return;
    const completed = cardDrag;
    cardDrag = null;
    completed.card.releasePointerCapture?.(event.pointerId);
    clearDropMarkers();
    if (cancelled || !completed.moved) return;
    event.preventDefault();
    suppressCardClick = true;
    const remainingIds = state.stacks.map(({ id }) => id).filter((id) => id !== completed.stackId);
    let targetIndex = remainingIds.indexOf(completed.targetId);
    if (targetIndex < 0) targetIndex = remainingIds.length;
    else if (completed.after) targetIndex += 1;
    canvas.moveStackToIndex(completed.stackId, targetIndex);
    setTimeout(() => { suppressCardClick = false; }, 0);
  }
  list.addEventListener('pointerup', (event) => finishCardDrag(event));
  list.addEventListener('pointercancel', (event) => finishCardDrag(event, true));

  const panelDragController = bindFloatingPanelDrag(panel, {
    ignoreSelector: 'button, input, select, textarea, label, .stack-list',
  });

  confirmBackdrop.querySelector('[data-stack-delete-cancel]').addEventListener('click', closeDeleteConfirmation);
  deleteConfirm.addEventListener('click', () => {
    const stackId = deleteConfirm.dataset.stackId;
    closeDeleteConfirmation();
    if (stackId) onRemove(stackId);
  });
  confirmBackdrop.addEventListener('pointerdown', (event) => {
    if (event.target === confirmBackdrop) closeDeleteConfirmation();
  });
  const onDocumentPointerDown = (event) => {
    if (!event.target.closest?.('.stack-card-menu, [data-stack-menu-toggle]')) closeMenus();
  };
  const onDocumentKeyDown = (event) => {
    if (event.key !== 'Escape') return;
    if (!confirmBackdrop.hidden) closeDeleteConfirmation();
    else closeMenus();
  };
  document.addEventListener('pointerdown', onDocumentPointerDown);
  document.addEventListener('keydown', onDocumentKeyDown);

  const stopStackSubscription = canvas.onStackChange(scheduleRender);
  const stopObjectSubscription = canvas.onObjectsChange(() => {
    scheduleRender();
  });
  const stopPresentationSubscription = canvas.onPresentationChange?.(scheduleRender);
  render();

  return {
    panel,
    render,
    setVisible,
    destroy() {
      stopStackSubscription?.();
      stopObjectSubscription?.();
      stopPresentationSubscription?.();
      if (thumbnailFrame !== null) cancelAnimationFrame(thumbnailFrame);
      document.removeEventListener('pointerdown', onDocumentPointerDown);
      document.removeEventListener('keydown', onDocumentKeyDown);
      panelDragController.destroy();
      panel.remove();
      fileInput.remove();
      confirmBackdrop.remove();
    },
  };
}

// --- Stack System Manager ---
export function createStackSystem({
  records,
  selectedIds,
  canvasElement = null,
  onRecordDisabled = () => {},
  onChange = () => {},
} = {}) {
  let state = normalizeStackState();
  const listeners = new Set();
  const nodePresentation = new WeakMap();
  const recordEnabledState = new WeakMap();

  function stackIds() {
    return new Set(state.stacks.map(({ id }) => id));
  }

  function emit(reason, { history = 'coalesce' } = {}) {
    const snapshot = getState();
    listeners.forEach((listener) => listener(snapshot, { reason }));
    onChange({ reason, history });
  }

  function getState() {
    return clone(state);
  }

  function restore(value, { notify = false } = {}) {
    state = normalizeStackState(value);
    if (notify) emit('restore', { history: 'none' });
    return getState();
  }

  function clear() {
    state = normalizeStackState();
    return getState();
  }

  function stack(stackId) {
    return state.stacks.find(({ id }) => id === stackId) || null;
  }

  function activeStackId() {
    return state.activeStackId;
  }

  function assignEntity(entity, requestedStackId = entity?.stackId || state.activeStackId) {
    const result = clone(entity || {});
    result.stackId = stackIds().has(String(requestedStackId || ''))
      ? String(requestedStackId)
      : DEFAULT_STACK_ID;
    return result;
  }

  function isStackVisible(stackId) {
    return stack(stackId)?.visible !== false;
  }

  function isStackActive(stackId) {
    return stackId === state.activeStackId;
  }

  function isEntityVisible(entity) {
    return isStackVisible(entityStackId(entity, stackIds()));
  }

  function isEntityActive(entity) {
    return isStackActive(entityStackId(entity, stackIds()));
  }

  function isEntityEnabled(entity) {
    return isEntityVisible(entity)
      && (isEntityActive(entity) || inactiveStackInteractionAllowed(canvasElement));
  }

  function isRecordVisible(record) {
    return Boolean(record && isEntityVisible(record.entity));
  }

  function isRecordEnabled(record) {
    return Boolean(record && isEntityEnabled(record.entity));
  }

  function orderForEntity(entity) {
    const id = entityStackId(entity, stackIds());
    const order = state.stacks.findIndex((candidate) => candidate.id === id);
    return order < 0 ? 0 : order;
  }

  function syncPresentation(regionNodes = []) {
    const known = stackIds();
    const interactionOverride = inactiveStackInteractionAllowed(canvasElement);
    const syncNode = (node, id, { visible, active }) => {
      if (!node) return;
      const presentationKey = `${id ?? ''}:${visible ? 1 : 0}:${active ? 1 : 0}`;
      if (nodePresentation.get(node) === presentationKey) return;
      if (id !== null) node?.setAttribute?.('data-stack-id', id);
      node?.setAttribute?.('data-stack-active', String(active));
      node?.classList?.toggle?.('stack-hidden', !visible);
      node?.classList?.toggle?.(STACK_INACTIVE_CLASS, !active);
      nodePresentation.set(node, presentationKey);
    };
    (records || []).forEach((record) => {
      const id = entityStackId(record.entity, known);
      const visible = isStackVisible(id);
      const active = isStackActive(id);
      const enabled = visible && (active || interactionOverride);
      syncNode(record.group, id, { visible, active });
      syncNode(record.handleGroup, id, { visible, active });
      if (!enabled && recordEnabledState.get(record) !== false) {
        selectedIds?.delete(record.id);
        onRecordDisabled(record);
      }
      recordEnabledState.set(record, enabled);
    });
    [...regionNodes].forEach((region) => {
      const parentIds = String(region.dataset?.parentIds || '').split(',').filter(Boolean);
      const visible = parentIds.length > 0 && parentIds.every((id) => {
        const record = records?.find((candidate) => candidate.id === id);
        return record && isRecordVisible(record);
      });
      const active = parentIds.length > 0 && parentIds.every((id) => {
        const record = records?.find((candidate) => candidate.id === id);
        return record && isEntityActive(record.entity);
      });
      syncNode(region, null, { visible, active });
    });
  }

  function addStack(name = '') {
    const id = createStableId('stack');
    const nextNumber = state.stacks.length + 1;
    state.stacks.push({
      id,
      name: normalizedName(name, `Stack ${nextNumber}`),
      visible: true,
      removable: true,
    });
    state.activeStackId = id;
    emit('add', { history: 'commit' });
    return clone(stack(id));
  }

  function renameStack(stackId, name) {
    const target = stack(stackId);
    if (!target) return false;
    const next = normalizedName(name, target.id === DEFAULT_STACK_ID ? 'Default' : target.name);
    if (next === target.name) return true;
    target.name = next;
    emit('rename');
    return true;
  }

  function setActiveStack(stackId) {
    if (!stack(stackId)) return false;
    if (state.activeStackId === stackId) return true;
    state.activeStackId = stackId;
    emit('activate', { history: 'none' });
    return true;
  }

  function setStackVisible(stackId, visible) {
    const target = stack(stackId);
    if (!target) return false;
    const next = Boolean(visible);
    if (target.visible === next) return true;
    target.visible = next;
    emit('visibility');
    return true;
  }

  function moveStack(stackId, direction) {
    const index = state.stacks.findIndex(({ id }) => id === stackId);
    if (index < 0) return false;
    const delta = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
    const target = index + delta;
    if (!delta || target < 0 || target >= state.stacks.length) return false;
    [state.stacks[index], state.stacks[target]] = [state.stacks[target], state.stacks[index]];
    emit('reorder', { history: 'commit' });
    return true;
  }

  function moveStackToIndex(stackId, requestedIndex) {
    const index = state.stacks.findIndex(({ id }) => id === stackId);
    if (index < 0) return false;
    const target = Math.max(0, Math.min(state.stacks.length - 1, Math.trunc(Number(requestedIndex))));
    if (!Number.isFinite(target) || target === index) return target === index;
    const [moved] = state.stacks.splice(index, 1);
    state.stacks.splice(target, 0, moved);
    emit('reorder', { history: 'commit' });
    return true;
  }

  function removeStack(stackId) {
    const target = stack(stackId);
    if (!target?.removable) return false;
    state.stacks = state.stacks.filter(({ id }) => id !== stackId);
    if (state.activeStackId === stackId) state.activeStackId = DEFAULT_STACK_ID;
    emit('remove', { history: 'commit' });
    return true;
  }

  function recordIdsForStack(stackId) {
    const known = stackIds();
    return (records || [])
      .filter((record) => entityStackId(record.entity, known) === stackId)
      .map((record) => record.id);
  }

  function onStateChange(listener) {
    listeners.add(listener);
    listener(getState(), { reason: 'subscribe' });
    return () => listeners.delete(listener);
  }

  return {
    getState,
    restore,
    clear,
    stack,
    stackIds,
    activeStackId,
    assignEntity,
    isStackVisible,
    isStackActive,
    isEntityVisible,
    isEntityActive,
    isEntityEnabled,
    isRecordVisible,
    isRecordEnabled,
    orderForEntity,
    syncPresentation,
    addStack,
    renameStack,
    setActiveStack,
    setStackVisible,
    moveStack,
    moveStackToIndex,
    removeStack,
    recordIdsForStack,
    onStateChange,
    extensionProvider: {
      serialize: getState,
      restore(value) {
        return restore(value, { notify: true });
      },
      clear,
    },
  };
}
