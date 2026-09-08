import { GLOBAL_LAYER_ID } from './StackCoordinates.js';
import {
  DRAWING_NODE_KIND,
  createStackTreeIndex,
  subtreeStackIds,
} from './StackArchitecture.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const icon = (path) => `<span class="tool-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">${path}</svg></span>`;
const icons = {
  add: icon('<path d="M12 5v14M5 12h14"/>'),
  insert: icon('<path d="M12 5v14M5 12h14"/><path d="M4 4h5M4 4v5M20 20h-5M20 20v-5"/>'),
  disclosure: icon('<path d="M8 5l7 7-7 7"/>'),
  eye: icon('<path d="M2.5 12c2.5-4 6-6 9.5-6s7 2 9.5 6c-2.5 4-6 6-9.5 6s-7-2-9.5-6z"/><circle cx="12" cy="12" r="2.5"/>'),
  hidden: icon('<path d="M4 4l16 16M9.2 6.5A10.7 10.7 0 0112 6c6 0 9.5 6 9.5 6a15 15 0 01-2.4 3.1M6.4 8.1C3.9 9.8 2.5 12 2.5 12s3.5 6 9.5 6a10 10 0 003-.5"/>'),
  addChild: icon('<path d="M12 5v14M5 12h14"/>'),
  save: icon('<path d="M5 4h12l3 3v13H5z"/><path d="M8 4v6h8V4M8 20v-7h9v7"/><path d="M18 11h4M20 9v4"/>'),
  delete: icon('<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>'),
};

export const STACK_ENABLE_EXPRESSION_PLACEHOLDER = 'FALSE';
export const STACK_EXPRESSION_INPUT_MINIMUM_WIDTH = 220;

export function stackVisibilityAvailable(stack) {
  return stack?.effectiveEnabled !== false;
}

export function stackStatusText(activationError) {
  return activationError ? '!' : '';
}

export function stackDisclosureLabel(expanded, stackName) {
  return `${expanded ? 'Collapse' : 'Expand'} ${stackName}`;
}

export function stackToolbarAvailable({ active = false, drawingContainer = false } = {}) {
  return active || drawingContainer;
}

export function stackActivationTarget(stackId, activeStackId) {
  const requestedStackId = String(stackId || '').trim();
  if (!requestedStackId) return null;
  return requestedStackId === activeStackId ? null : requestedStackId;
}

export function stackToolbarLeft({ rowRight = 0, sidebarRight = rowRight, gap = 4 } = {}) {
  return Math.round(Math.min(rowRight, sidebarRight) + gap);
}

export function stackExpressionInputWidth(
  scrollWidth,
  minimumWidth = STACK_EXPRESSION_INPUT_MINIMUM_WIDTH,
) {
  const measuredWidth = Number(scrollWidth);
  return Math.max(
    minimumWidth,
    Number.isFinite(measuredWidth) ? Math.ceil(measuredWidth + 2) : minimumWidth,
  );
}

export function stackIdForCanvasHover(hover = {}, getRecordStackId = () => null, activeStackId = null) {
  const hoveredStackId = hover.stackId || (hover.recordId ? getRecordStackId(hover.recordId) : null) || null;
  return hoveredStackId && hoveredStackId !== activeStackId ? hoveredStackId : null;
}

export function stackIdForRowHover(stackId, activeStackId) {
  const hoveredStackId = String(stackId || '').trim();
  return hoveredStackId && hoveredStackId !== activeStackId ? hoveredStackId : null;
}

export function visibleStackIds(index, expandedIds) {
  const visible = [];
  const visit = (stack) => {
    visible.push(stack.id);
    if (!expandedIds.has(stack.id)) return;
    index.children(stack.id).forEach(visit);
  };
  index.children(null).forEach(visit);
  return visible;
}

export function createStackTreePanel({
  host,
  canvas,
  onSaveAs = () => {},
  onImport = () => {},
  onRemove = (stackId) => canvas.removeStack(stackId),
  getDrawingName = () => 'Untitled Drawing',
  minimumWidth = 190,
  maximumWidth = 520,
} = {}) {
  if (!host) throw new Error('Stack tree panel requires a host element.');
  const fileInput = document.createElement('input');
  const rowById = new Map();
  const expandedIds = new Set();
  const expressionDraftErrors = new Map();
  const expressionDraftValues = new Map();
  let runtimeState = canvas.getStackRuntimeState?.() || canvas.getStackState();
  let selectedStackId = runtimeState.selectedStackId || runtimeState.activeStackId;
  let renderedActiveStackId = runtimeState.activeStackId;
  let draggedStackId = null;
  let dropTarget = null;
  let autoExpandTimer = null;
  let autoExpandTargetId = null;
  let drawingName = String(getDrawingName() || 'Untitled Drawing');
  let drawingRootExpanded = true;
  let geometryHoveredStackId = null;
  let resize = null;

  host.classList.add('stack-tree-sidebar');
  host.setAttribute('aria-label', 'Stacks');
  host.innerHTML = `
    <div class="stack-tree-scroll">
      <div class="stack-tree" role="tree" aria-label="Drawing Stack hierarchy" data-stack-tree></div>
    </div>
    <datalist id="stackEnableExpressionSymbols"></datalist>
    <div class="stack-tree-resize-handle" role="separator" aria-orientation="vertical" aria-label="Resize Stack sidebar" tabindex="0"></div>
  `;
  fileInput.type = 'file';
  fileInput.accept = '.paramagic,.json,application/vnd.paramagic+json,application/json';
  fileInput.hidden = true;
  fileInput.dataset.stackTreeImportInput = 'true';
  host.append(fileInput);

  const tree = host.querySelector('[data-stack-tree]');
  const expressionSymbols = host.querySelector('#stackEnableExpressionSymbols');
  const resizeHandle = host.querySelector('.stack-tree-resize-handle');

  const drawingRootRow = document.createElement('div');
  drawingRootRow.className = 'stack-tree-row drawing-root';
  drawingRootRow.dataset.drawingRoot = 'true';
  drawingRootRow.setAttribute('role', 'treeitem');
  drawingRootRow.setAttribute('tabindex', '0');
  drawingRootRow.setAttribute('aria-level', '1');
  drawingRootRow.innerHTML = `
    <button type="button" class="stack-tree-expander" data-drawing-root-expand></button>
    <span class="stack-tree-name" data-drawing-root-name></span>
    <div class="stack-tree-root-actions" role="group" aria-label="Drawing actions" data-drawing-root-actions>
      <button type="button" data-drawing-root-add title="Add Child Stack" aria-label="Add Child Stack">${icons.add}</button>
      <button type="button" data-drawing-root-import title="Insert Stack or Drawing" aria-label="Insert Stack or Drawing">${icons.insert}</button>
    </div>
  `;

  function updateDrawingRoot() {
    const hasChildren = runtimeState.stacks.length > 0;
    const expander = drawingRootRow.querySelector('[data-drawing-root-expand]');
    drawingRootRow.querySelector('[data-drawing-root-name]').textContent = drawingName;
    drawingRootRow.setAttribute('aria-expanded', hasChildren ? String(drawingRootExpanded) : 'false');
    expander.hidden = !hasChildren;
    expander.innerHTML = icons.disclosure;
    expander.setAttribute('aria-label', stackDisclosureLabel(drawingRootExpanded, drawingName));
    expander.title = stackDisclosureLabel(drawingRootExpanded, drawingName);
  }

  function stateIndex() {
    return createStackTreeIndex(runtimeState);
  }

  function resizeExpressionInput(input) {
    if (!input) return;
    input.style.width = '';
    const minimumWidth = Math.max(
      STACK_EXPRESSION_INPUT_MINIMUM_WIDTH,
      input.getBoundingClientRect().width,
    );
    input.style.width = `${stackExpressionInputWidth(input.scrollWidth, minimumWidth)}px`;
  }

  function createRow(stackId) {
    const row = document.createElement('div');
    row.className = 'stack-tree-row';
    row.dataset.stackId = stackId;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('tabindex', '-1');
    row.draggable = true;
    row.innerHTML = `
      <button type="button" class="stack-tree-expander" data-stack-expand aria-label="Expand Stack"></button>
      <button type="button" class="stack-tree-name" data-stack-name></button>
      <input type="text" class="stack-tree-name-input" data-stack-name-input aria-label="Stack name" hidden />
      <span class="stack-tree-status" data-stack-status aria-hidden="true"></span>
      <button type="button" class="stack-tree-visibility" data-stack-visibility></button>
      <div class="stack-tree-item-toolbar" role="toolbar" aria-label="Stack tools" data-stack-toolbar>
        <button type="button" data-stack-add-child title="Add Child Stack" aria-label="Add Child Stack">${icons.addChild}</button>
        <button type="button" class="stack-tree-enabled-switch" role="switch" data-stack-enable aria-checked="false"><span class="stack-tree-switch-track" aria-hidden="true"><span class="stack-tree-switch-thumb"></span></span></button>
        <label class="stack-tree-toolbar-expression" data-stack-expression-container hidden><span class="sr-only">Enabled expression</span><input type="text" data-stack-expression aria-label="Stack enabled expression" data-expression-source="stackEnableExpressionSymbols" autocomplete="off" spellcheck="false" placeholder="${STACK_ENABLE_EXPRESSION_PLACEHOLDER}" /></label>
        <button type="button" data-stack-save-as title="Save Stack As" aria-label="Save Stack As">${icons.save}</button>
        <button type="button" class="destructive" data-stack-delete title="Delete Stack" aria-label="Delete Stack">${icons.delete}</button>
      </div>
    `;
    rowById.set(stackId, row);
    return row;
  }

  function updateRow(row, stack, index) {
    const children = index.children(stack.id);
    const selected = stack.id === selectedStackId;
    const active = stack.id === runtimeState.activeStackId;
    let depth = 0;
    let cursor = index.byId.get(stack.id);
    while (cursor?.parentStackId) {
      depth += 1;
      cursor = index.byId.get(cursor.parentStackId);
    }
    const drawingContainer = stack.kind === DRAWING_NODE_KIND;
    const globalLayer = stack.id === GLOBAL_LAYER_ID;
    row.draggable = !globalLayer;
    row.style.setProperty('--stack-depth', depth + 1);
    row.classList.toggle('selected', selected);
    row.classList.toggle('active', active);
    row.classList.toggle('geometry-hovered', !active && stack.id === geometryHoveredStackId);
    row.classList.toggle('drawing-container', drawingContainer);
    row.classList.toggle('hidden-stack', stack.visible === false);
    row.classList.toggle('locally-disabled', stack.localEnabled === false);
    row.classList.toggle('inherited-disabled', stack.localEnabled !== false && stack.effectiveEnabled === false);
    const activationError = expressionDraftErrors.get(stack.id) || stack.activationError;
    row.classList.toggle('activation-error', Boolean(activationError));
    row.setAttribute('aria-level', String(depth + 2));
    row.setAttribute('aria-selected', String(selected));
    row.setAttribute('aria-current', active ? 'true' : 'false');
    row.setAttribute('aria-expanded', children.length ? String(expandedIds.has(stack.id)) : 'false');
    row.title = activationError || '';
    const expander = row.querySelector('[data-stack-expand]');
    const expanded = expandedIds.has(stack.id);
    expander.hidden = children.length === 0;
    expander.innerHTML = icons.disclosure;
    expander.setAttribute('aria-label', stackDisclosureLabel(expanded, stack.name));
    expander.title = stackDisclosureLabel(expanded, stack.name);
    row.querySelector('[data-stack-status]').textContent = stackStatusText(activationError);
    const name = row.querySelector('[data-stack-name]');
    const nameEditor = row.querySelector('[data-stack-name-input]');
    name.textContent = stack.name;
    nameEditor.setAttribute('aria-label', `${stack.name} name`);
    if (document.activeElement !== nameEditor) nameEditor.value = stack.name;
    const toolbar = row.querySelector('[data-stack-toolbar]');
    toolbar.hidden = globalLayer;
    toolbar.setAttribute('aria-label', `${stack.name} tools`);
    row.querySelector('[data-stack-add-child]').hidden = drawingContainer;
    const saveAs = row.querySelector('[data-stack-save-as]');
    const remove = row.querySelector('[data-stack-delete]');
    const nodeType = drawingContainer ? 'Drawing' : 'Stack';
    saveAs.setAttribute('aria-label', `Save ${nodeType} As`);
    saveAs.title = `Save ${nodeType} As`;
    remove.setAttribute('aria-label', `Delete ${nodeType}`);
    remove.title = `Delete ${nodeType}`;
    const enable = row.querySelector('[data-stack-enable]');
    const manuallyEnabled = stack.enabled !== false;
    enable.setAttribute('aria-checked', String(manuallyEnabled));
    enable.setAttribute('aria-label', `${manuallyEnabled ? 'Disable' : 'Enable'} ${stack.name}`);
    enable.title = `${manuallyEnabled ? 'Disable' : 'Enable'} ${stack.name}`;
    const expressionContainer = row.querySelector('[data-stack-expression-container]');
    const expression = row.querySelector('[data-stack-expression]');
    expressionContainer.hidden = manuallyEnabled;
    expression.setAttribute('aria-label', `${stack.name} enabled expression`);
    if (document.activeElement !== expression) {
      expression.value = expressionDraftValues.has(stack.id)
        ? expressionDraftValues.get(stack.id)
        : stack.enabledExpression;
    }
    expression.setAttribute('aria-invalid', String(Boolean(activationError)));
    expression.title = activationError || 'Blank evaluates to false';
    resizeExpressionInput(expression);
    const visibility = row.querySelector('[data-stack-visibility]');
    visibility.hidden = !stackVisibilityAvailable(stack);
    visibility.innerHTML = stack.visible === false ? icons.hidden : icons.eye;
    visibility.setAttribute('aria-label', `${stack.visible === false ? 'Show' : 'Hide'} ${stack.name}`);
    visibility.title = `${stack.visible === false ? 'Show' : 'Hide'} ${stack.name}`;
    remove.disabled = !stack.removable;
  }

  function populateExpressionSymbols(stackId) {
    expressionSymbols.innerHTML = (canvas.getParameterExpressionSymbols?.(stackId, { includeLocalAliases: true }) || [])
      .map(({ name }) => `<option value="${escapeHtml(name)}"></option>`).join('');
  }

  function render(nextState = canvas.getStackRuntimeState?.() || canvas.getStackState(), change = {}) {
    const previousSelectedStackId = selectedStackId;
    const previousActiveStackId = renderedActiveStackId;
    runtimeState = nextState;
    const requestedSelection = runtimeState.selectedStackId || selectedStackId || runtimeState.activeStackId;
    selectedStackId = runtimeState.stacks.some(({ id }) => id === requestedSelection)
      ? requestedSelection
      : runtimeState.activeStackId;
    renderedActiveStackId = runtimeState.activeStackId;
    const index = stateIndex();
    updateDrawingRoot();
    const structural = !change.reason || [
      'subscribe', 'add', 'clear', 'remove-subtree', 'restore', 'reparent', 'reorder', 'expansion',
    ].includes(change.reason);
    const affectedIds = structural
      ? new Set(runtimeState.stacks.map(({ id }) => id))
      : new Set([
        ...(change.affectedStackIds || []),
        previousSelectedStackId,
        selectedStackId,
        previousActiveStackId,
        renderedActiveStackId,
      ].filter(Boolean));
    runtimeState.stacks.forEach((stack) => {
      if (!expandedIds.has(stack.id) && !rowById.has(stack.id)) expandedIds.add(stack.id);
      const row = rowById.get(stack.id) || createRow(stack.id);
      if (affectedIds.has(stack.id)) updateRow(row, stack, index);
    });
    [...rowById].forEach(([stackId, row]) => {
      if (index.byId.has(stackId)) return;
      row.remove();
      rowById.delete(stackId);
      expandedIds.delete(stackId);
      expressionDraftValues.delete(stackId);
      expressionDraftErrors.delete(stackId);
    });
    if (structural) {
      const visibleRows = visibleStackIds(index, expandedIds).map((stackId) => rowById.get(stackId));
      tree.replaceChildren(drawingRootRow, ...(drawingRootExpanded ? visibleRows : []));
    }
  }

  function select(stackId, { focus = false } = {}) {
    if (!canvas.setSelectedStack?.(stackId)) return false;
    if (focus) rowById.get(stackId)?.focus();
    return true;
  }

  function focusNameInput(stackId) {
    if (stackId === GLOBAL_LAYER_ID) return;
    if (!select(stackId)) return;
    const row = rowById.get(stackId);
    const name = row?.querySelector('[data-stack-name]');
    const input = row?.querySelector('[data-stack-name-input]');
    if (!row || !name || !input) return;
    input.value = runtimeState.stacks.find(({ id }) => id === stackId)?.name || '';
    name.hidden = true;
    input.hidden = false;
    row.classList.add('editing-name');
    input.focus();
    input.select();
  }

  function finishNameInput(stackId, { cancel = false } = {}) {
    const row = rowById.get(stackId);
    const name = row?.querySelector('[data-stack-name]');
    const input = row?.querySelector('[data-stack-name-input]');
    if (!row || !name || !input || input.hidden) return;
    if (!cancel && canvas.renameStack(stackId, input.value) === false) {
      input.value = runtimeState.stacks.find(({ id }) => id === stackId)?.name || '';
      input.focus();
      input.select();
      return;
    }
    input.hidden = true;
    name.hidden = false;
    row.classList.remove('editing-name');
  }

  function setManualEnabled(stackId, enabled) {
    const outcome = canvas.setStackEnabled(stackId, enabled);
    if (outcome?.success === false) {
      expressionDraftErrors.set(stackId, outcome.message);
      render(canvas.getStackRuntimeState?.() || canvas.getStackState(), {
        reason: 'enabled', affectedStackIds: [stackId],
      });
    }
    return outcome;
  }

  function positionItemToolbar(row) {
    const toolbar = row?.querySelector('[data-stack-toolbar]');
    if (!toolbar) return;
    const bounds = row.getBoundingClientRect();
    toolbar.style.left = `${stackToolbarLeft({
      rowRight: bounds.right,
      sidebarRight: host.getBoundingClientRect().right,
    })}px`;
    toolbar.style.top = `${Math.round(bounds.top + (bounds.height - (toolbar.offsetHeight || 40)) / 2)}px`;
  }

  function openItemToolbar(row) {
    const stack = row?.dataset?.stackId
      ? runtimeState.stacks.find(({ id }) => id === row.dataset.stackId)
      : null;
    if (!stackToolbarAvailable({
      active: row?.classList.contains('active'),
      drawingContainer: stack?.kind === DRAWING_NODE_KIND,
    })) return;
    positionItemToolbar(row);
  }

  function commitExpressionInput(stackId, input) {
    const draft = input.value;
    const outcome = canvas.setStackEnabledExpression(stackId, draft);
    if (outcome?.success === false) {
      expressionDraftValues.set(stackId, draft);
      expressionDraftErrors.set(stackId, outcome.message);
      render(canvas.getStackRuntimeState?.() || canvas.getStackState(), {
        reason: 'enabled-expression', affectedStackIds: [stackId],
      });
      input.value = draft;
      input.setAttribute('aria-invalid', 'true');
      input.title = outcome.message;
    } else {
      expressionDraftValues.delete(stackId);
      expressionDraftErrors.delete(stackId);
    }
    return outcome;
  }

  function removeStackImmediately(stackId) {
    const stack = runtimeState.stacks.find(({ id }) => id === stackId);
    if (!stack?.removable) return;
    onRemove(stackId);
  }

  drawingRootRow.querySelector('[data-drawing-root-add]').addEventListener('click', () => canvas.addStack({ name: '', parentStackId: null }));
  drawingRootRow.querySelector('[data-drawing-root-import]').addEventListener('click', () => fileInput.click());
  drawingRootRow.querySelector('[data-drawing-root-expand]').addEventListener('click', () => {
    drawingRootExpanded = !drawingRootExpanded;
    render(runtimeState, { reason: 'expansion' });
  });
  fileInput.addEventListener('change', async () => {
    const [file] = fileInput.files || [];
    fileInput.value = '';
    if (file) await onImport(file, { parentStackId: null });
  });

  tree.addEventListener('click', (event) => {
    const row = event.target.closest?.('[data-stack-id]');
    if (!row) return;
    const stackId = row.dataset.stackId;
    if (event.target.closest('[data-stack-expand]')) {
      if (expandedIds.has(stackId)) expandedIds.delete(stackId); else expandedIds.add(stackId);
      render(runtimeState, { reason: 'expansion' });
      return;
    }
    if (event.target.closest('[data-stack-visibility]')) {
      const stack = runtimeState.stacks.find(({ id }) => id === stackId);
      select(stackId);
      canvas.setStackVisible(stackId, stack?.visible === false);
      return;
    }
    if (event.target.closest('[data-stack-toolbar]')) {
      const stack = runtimeState.stacks.find(({ id }) => id === stackId);
      if (!stack) return;
      select(stackId);
      if (event.target.closest('[data-stack-enable]')) {
        const enable = stack.enabled === false;
        const outcome = setManualEnabled(stackId, enable);
        if (!enable && outcome?.success !== false) queueMicrotask(() => {
          const input = rowById.get(stackId)?.querySelector('[data-stack-expression]');
          populateExpressionSymbols(stackId);
          input?.focus();
          input?.select();
        });
      } else if (event.target.closest('[data-stack-add-child]') && stack.kind !== DRAWING_NODE_KIND) {
        canvas.addChildStack(stackId);
      } else if (event.target.closest('[data-stack-save-as]')) {
        onSaveAs(stackId);
      } else if (event.target.closest('[data-stack-delete]')) {
        removeStackImmediately(stackId);
      }
      return;
    }
    if (event.target.closest('[data-stack-name-input]') || !select(stackId)) return;
    const stack = runtimeState.stacks.find(({ id }) => id === stackId);
    if (stack?.kind !== DRAWING_NODE_KIND && stackId !== GLOBAL_LAYER_ID) {
      const activeStackId = stackActivationTarget(stackId, runtimeState.activeStackId);
      canvas.setActiveStack?.(activeStackId);
      if (activeStackId) positionItemToolbar(row);
    }
  });
  tree.addEventListener('dblclick', (event) => {
    const row = event.target.closest?.('[data-stack-id]');
    if (!row || event.target.closest('[data-stack-expand], [data-stack-name-input], [data-stack-visibility], [data-stack-toolbar]')) return;
    event.preventDefault();
    focusNameInput(row.dataset.stackId);
  });
  tree.addEventListener('keydown', (event) => {
    const row = event.target.closest?.('[data-stack-id]');
    if (!row) return;
    const stackId = row.dataset.stackId;
    const nameEditor = event.target.closest('[data-stack-name-input]');
    if (nameEditor) {
      if (event.key === 'Enter') {
        event.preventDefault();
        finishNameInput(stackId);
        row.focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finishNameInput(stackId, { cancel: true });
        row.focus();
      }
      return;
    }
    const expressionEditor = event.target.closest('[data-stack-expression]');
    if (expressionEditor) {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitExpressionInput(stackId, expressionEditor);
        expressionEditor.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        expressionDraftValues.delete(stackId);
        expressionDraftErrors.delete(stackId);
        render(runtimeState, { reason: 'enabled-expression', affectedStackIds: [stackId] });
        expressionEditor.blur();
      }
      return;
    }
    const index = stateIndex();
    const visibleIds = visibleStackIds(index, expandedIds);
    const position = visibleIds.indexOf(stackId);
    if (event.key === 'ArrowDown' && visibleIds[position + 1]) select(visibleIds[position + 1], { focus: true });
    else if (event.key === 'ArrowUp' && visibleIds[position - 1]) select(visibleIds[position - 1], { focus: true });
    else if (event.key === 'ArrowRight') {
      const children = index.children(stackId);
      if (children.length && !expandedIds.has(stackId)) { expandedIds.add(stackId); render(runtimeState, { reason: 'expansion' }); }
      else if (children[0]) select(children[0].id, { focus: true });
    } else if (event.key === 'ArrowLeft') {
      if (expandedIds.has(stackId) && index.children(stackId).length) { expandedIds.delete(stackId); render(runtimeState, { reason: 'expansion' }); }
      else if (index.parent(stackId)) select(index.parent(stackId).id, { focus: true });
    } else if (event.key === 'Enter') {
      const stack = index.byId.get(stackId);
      if (stack?.kind !== DRAWING_NODE_KIND) {
        canvas.setActiveStack(runtimeState.activeStackId === stackId ? null : stackId);
      }
    }
    else if (event.key === ' ') {
      const stack = index.byId.get(stackId);
      setManualEnabled(stackId, stack.enabled === false);
    } else if (event.key === 'F2') focusNameInput(stackId);
    else if ((event.key === 'Delete' || event.key === 'Backspace') && !event.target.closest('input')) removeStackImmediately(stackId);
    else if (event.key === 'Home' && visibleIds[0]) select(visibleIds[0], { focus: true });
    else if (event.key === 'End' && visibleIds.at(-1)) select(visibleIds.at(-1), { focus: true });
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  tree.addEventListener('pointerover', (event) => {
    const row = event.target.closest?.('[data-stack-id]');
    if (!row) return;
    canvas.setHoveredStackId?.(stackIdForRowHover(row.dataset.stackId, runtimeState.activeStackId));
    openItemToolbar(row);
  });
  tree.addEventListener('pointerout', (event) => {
    const row = event.target.closest?.('[data-stack-id]');
    if (!row || row.contains(event.relatedTarget)) return;
    canvas.setHoveredStackId?.(null);
  });
  tree.addEventListener('focusin', (event) => {
    const row = event.target.closest?.('[data-stack-id]');
    if (!row) return;
    openItemToolbar(row);
    if (event.target.closest('[data-stack-expression]')) populateExpressionSymbols(row.dataset.stackId);
  });
  tree.addEventListener('input', (event) => {
    const input = event.target.closest?.('[data-stack-expression]');
    const row = input?.closest('[data-stack-id]');
    if (!input || !row) return;
    expressionDraftValues.set(row.dataset.stackId, input.value);
    expressionDraftErrors.delete(row.dataset.stackId);
    input.setAttribute('aria-invalid', 'false');
    input.title = 'Press Enter or leave the field to apply this expression';
    row.querySelector('[data-stack-status]').textContent = '';
    resizeExpressionInput(input);
  });
  tree.addEventListener('change', (event) => {
    const row = event.target.closest?.('[data-stack-id]');
    if (!row) return;
    if (event.target.closest('[data-stack-name-input]')) finishNameInput(row.dataset.stackId);
    if (event.target.closest('[data-stack-expression]')) commitExpressionInput(row.dataset.stackId, event.target);
  });
  tree.addEventListener('focusout', (event) => {
    const input = event.target.closest?.('[data-stack-name-input]');
    const row = event.target.closest?.('[data-stack-id]');
    if (input && row) finishNameInput(row.dataset.stackId);
  });

  tree.addEventListener('dragstart', (event) => {
    if (event.target.closest?.('[data-stack-toolbar], [data-drawing-root-actions]')) {
      event.preventDefault();
      return;
    }
    draggedStackId = event.target.closest?.('[data-stack-id]')?.dataset.stackId || null;
    if (!draggedStackId) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggedStackId);
    rowById.get(draggedStackId)?.classList.add('dragging');
  });
  tree.addEventListener('dragover', (event) => {
    const target = event.target.closest?.('[data-stack-id], [data-drawing-root]');
    if (!draggedStackId || !target || target.dataset.stackId === draggedStackId) return;
    const index = stateIndex();
    if (target.dataset.stackId && subtreeStackIds(index.state, draggedStackId).includes(target.dataset.stackId)) {
      event.dataTransfer.dropEffect = 'none';
      dropTarget = null;
      rowById.forEach((row) => row.classList.remove('drop-before', 'drop-inside', 'drop-after'));
      return;
    }
    event.preventDefault();
    rowById.forEach((row) => row.classList.remove('drop-before', 'drop-inside', 'drop-after'));
    const bounds = target.getBoundingClientRect();
    const ratio = (event.clientY - bounds.top) / Math.max(1, bounds.height);
    const position = target === drawingRootRow ? 'inside' : ratio < .28 ? 'before' : ratio > .72 ? 'after' : 'inside';
    target.classList.add(`drop-${position}`);
    dropTarget = { stackId: target.dataset.stackId, position };
    if (target.dataset.stackId && position === 'inside' && index.children(target.dataset.stackId).length
      && !expandedIds.has(target.dataset.stackId)) {
      if (autoExpandTargetId !== target.dataset.stackId) {
        clearTimeout(autoExpandTimer);
        autoExpandTargetId = target.dataset.stackId;
        autoExpandTimer = setTimeout(() => {
          expandedIds.add(autoExpandTargetId);
          autoExpandTargetId = null;
          autoExpandTimer = null;
          render(runtimeState, { reason: 'expansion' });
        }, 600);
      }
    } else {
      clearTimeout(autoExpandTimer);
      autoExpandTimer = null;
      autoExpandTargetId = null;
    }
    event.dataTransfer.dropEffect = 'move';
  });
  tree.addEventListener('drop', (event) => {
    event.preventDefault();
    if (!draggedStackId || !dropTarget) return;
    const index = stateIndex();
    const source = index.byId.get(draggedStackId);
    const target = index.byId.get(dropTarget.stackId);
    if (!source) return;
    if (!target && dropTarget.stackId == null) canvas.reparentStack(source.id, null, index.children(null).length);
    else if (!target) return;
    else if (dropTarget.position === 'inside') canvas.reparentStack(source.id, target.id, index.children(target.id).length);
    else {
      const siblings = index.children(target.parentStackId).filter(({ id }) => id !== source.id);
      const targetIndex = siblings.findIndex(({ id }) => id === target.id);
      canvas.reparentStack(source.id, target.parentStackId, targetIndex + (dropTarget.position === 'after' ? 1 : 0));
    }
  });
  tree.addEventListener('dragend', () => {
    clearTimeout(autoExpandTimer);
    autoExpandTimer = null;
    autoExpandTargetId = null;
    rowById.forEach((row) => row.classList.remove('dragging', 'drop-before', 'drop-inside', 'drop-after'));
    drawingRootRow.classList.remove('drop-inside');
    draggedStackId = null;
    dropTarget = null;
  });

  resizeHandle.addEventListener('pointerdown', (event) => {
    resize = { pointerId: event.pointerId, startX: event.clientX, startWidth: host.getBoundingClientRect().width };
    resizeHandle.setPointerCapture(event.pointerId);
    document.documentElement.classList.add('resizing-stack-sidebar');
  });
  resizeHandle.addEventListener('pointermove', (event) => {
    if (!resize || resize.pointerId !== event.pointerId) return;
    const width = Math.max(minimumWidth, Math.min(maximumWidth, resize.startWidth + event.clientX - resize.startX));
    document.documentElement.style.setProperty('--stack-sidebar-width', `${Math.round(width)}px`);
    window.dispatchEvent(new Event('resize'));
  });
  const finishResize = (event) => {
    if (!resize || resize.pointerId !== event.pointerId) return;
    resizeHandle.releasePointerCapture?.(event.pointerId);
    resize = null;
    document.documentElement.classList.remove('resizing-stack-sidebar');
  };
  resizeHandle.addEventListener('pointerup', finishResize);
  resizeHandle.addEventListener('pointercancel', finishResize);
  resizeHandle.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const width = host.getBoundingClientRect().width + (event.key === 'ArrowRight' ? 12 : -12);
    document.documentElement.style.setProperty('--stack-sidebar-width', `${Math.max(minimumWidth, Math.min(maximumWidth, width))}px`);
    window.dispatchEvent(new Event('resize'));
    event.preventDefault();
  });

  const stopStackSubscription = canvas.onStackChange(render);
  const stopCanvasHoverSubscription = canvas.onCanvasHover?.((hover) => {
    const nextStackId = stackIdForCanvasHover(
      hover,
      (recordId) => canvas.getRecordStackId?.(recordId),
      runtimeState.activeStackId,
    );
    if (nextStackId === geometryHoveredStackId) return;
    rowById.get(geometryHoveredStackId)?.classList.remove('geometry-hovered');
    geometryHoveredStackId = nextStackId;
    rowById.get(geometryHoveredStackId)?.classList.add('geometry-hovered');
  });
  render();

  return {
    host,
    render,
    setDrawingName(value) {
      drawingName = String(value || 'Untitled Drawing');
      updateDrawingRoot();
    },
    destroy() {
      clearTimeout(autoExpandTimer);
      canvas.setHoveredStackId?.(null);
      stopStackSubscription?.();
      stopCanvasHoverSubscription?.();
      fileInput.remove();
      host.replaceChildren();
    },
  };
}
