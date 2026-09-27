import { createUuid } from './IdentitySystem.js';
import { registerIdentitySchema } from './DrawingIdentitySystem.js';
import { createExpressionBoxLookup, expressionBoxLookupMarkup } from './ExpressionBox.js';
import { bindFloatingPanelDrag } from './CanvasUIControls.js';

registerIdentitySchema('controls', {
  declarations: (value) => (value?.items || []).map((object, index) => ({
    object, key: 'id', value: object.id, path: ['extensions', 'controls', 'items', String(index), 'id'], kind: 'control-item',
  })),
  liveReferenceKeys: ['parameterId', 'parentContainerId'],
  targetKindsByKey: { parameterId: ['parameter'], parentContainerId: ['control-item'] },
});

// --- Parameter Control Widgets & UI Panel ---
const clone = (value) => JSON.parse(JSON.stringify(value));
export const CONTROL_EXTENSION_VERSION = 4;
export const CONTROL_VISIBILITY_EXPRESSION_PLACEHOLDER = 'FALSE';

export const controlToolTypes = Object.freeze([
  'Slider Control',
  'Checkbox',
  'Numeric Textbox',
  'Options',
  'Dropdown',
  'Container',
]);

const controlTypeKeys = Object.freeze({
  'Slider Control': 'horizontal-scrollbar',
  Checkbox: 'checkbox',
  'Numeric Textbox': 'numeric-textbox',
  Options: 'options',
  Dropdown: 'dropdown',
  Container: 'container',
});

// Keep the pre-Controls-panel name readable for saved drawings and callers
// that still use the original internal label. The user-facing dropdown uses
// the shorter Slider Control name above.
const legacyControlTypeKeys = Object.freeze({
  'Horizontal Scrollbar': 'horizontal-scrollbar',
});

const controlTypeLabels = Object.freeze(Object.fromEntries(
  Object.entries(controlTypeKeys).map(([label, key]) => [key, label]),
));

const defaultExpressions = Object.freeze({
  'horizontal-scrollbar': 'MinMax(0, 100, 50, 1)',
  checkbox: 'FALSE',
  'numeric-textbox': '0',
  options: '{Option 1|Option 2|Option 3}',
  dropdown: '{Option 1|Option 2|Option 3}',
  container: 'TRUE',
});

const icons = Object.freeze({
  add: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  edit: '<path d="M5 19l3.5-.7L18 8.8 15.2 6 5.7 15.5zM13.8 7.4l2.8 2.8"/>',
  remove: '<path d="M5 7h14M9 7V4h6v3m-8 0l1 13h8l1-13M10 10v7m4-7v7"/>',
  drag: '<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"/>',
  expand: '<path d="m9 5 7 7-7 7"/>',
  collapse: '<path d="m5 9 7 7 7-7"/>',
  visible: '<path d="M2.5 12c2.5-4 6-6 9.5-6s7 2 9.5 6c-2.5 4-6 6-9.5 6s-7-2-9.5-6z"/><circle cx="12" cy="12" r="2.5"/>',
  hidden: '<path d="M4 4l16 16M9.2 6.5A10.7 10.7 0 0112 6c6 0 9.5 6 9.5 6a15 15 0 01-2.4 3.1M6.4 8.1C3.9 9.8 2.5 12 2.5 12s3.5 6 9.5 6a10 10 0 003-.5"/>',
});

function svgIcon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || ''}</svg>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function controlTypeKey(value) {
  if (controlTypeLabels[value]) return value;
  return controlTypeKeys[value] || legacyControlTypeKeys[value] || 'horizontal-scrollbar';
}

function splitExpressionArguments(source) {
  const args = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index - 1] !== '\\') quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  args.push(source.slice(start).trim());
  return args;
}

export function parseMinMaxExpression(expression) {
  const match = /^MinMax\s*\(([\s\S]*)\)$/i.exec(String(expression ?? '').trim());
  if (!match) return null;
  const args = splitExpressionArguments(match[1]);
  if (args.length !== 4 || args.some((argument) => !argument)) return null;
  return {
    minimumExpression: args[0],
    maximumExpression: args[1],
    initialExpression: args[2],
    stepExpression: args[3],
  };
}

export function formatMinMaxExpression({
  minimumExpression = '0',
  maximumExpression = '100',
  initialExpression = '0',
  stepExpression = '1',
} = {}) {
  return `MinMax(${minimumExpression}, ${maximumExpression}, ${initialExpression}, ${stepExpression})`;
}

export function parseControlArrayExpression(expression) {
  const source = String(expression ?? '').trim();
  if (!source.startsWith('{') || !source.endsWith('}')) return null;
  const values = source.slice(1, -1).split('|').map((value) => value.trim());
  return values.length && values.every(Boolean) ? values : null;
}

export function normalizeControlItem(input = {}) {
  const controlType = controlTypeKey(input.controlType);
  return {
    id: String(input.id || createUuid()),
    controlType,
    label: String(input.label ?? ''),
    parentContainerId: input.parentContainerId ? String(input.parentContainerId) : null,
    configurationExpression: String(
      input.configurationExpression
      ?? input.expression
      ?? defaultExpressions[controlType],
    ),
    selectedIndex: Math.max(0, Math.round(Number(input.selectedIndex) || 0)),
    visible: input.visible !== false,
    visibleExpression: String(input.visibleExpression ?? ''),
    parameterId: String(input.parameterId || ''),
    parameterName: String(input.parameterName || ''),
  };
}

export function createControlItem(controlType, input = {}) {
  return normalizeControlItem({ ...input, controlType });
}

function evaluateExpression(solver, expression) {
  try {
    const value = solver.evaluateScalarExpression(expression);
    return { value, error: null };
  } catch (error) {
    return { value: null, error: error.message };
  }
}

function displayValue(value) {
  if (typeof value === 'boolean') return String(value).toUpperCase();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return String(Math.round((value + Number.EPSILON) * 1000) / 1000);
  }
  return String(value ?? '');
}

function literalExpression(value) {
  return JSON.stringify(String(value ?? ''));
}

export function resolveControlChoices(item, solver) {
  const values = parseControlArrayExpression(item?.configurationExpression);
  if (!values) return { choices: [], error: 'Use an array expression such as {dog|cat|house}.' };
  return {
    choices: values.map((source, index) => {
      const evaluated = evaluateExpression(solver, source);
      const literal = Boolean(evaluated.error);
      const value = literal ? source : evaluated.value;
      return {
        index,
        source,
        value,
        label: displayValue(value),
        parameterExpression: literal ? literalExpression(source) : source,
      };
    }),
    error: null,
  };
}

function currentParameter(item, solver) {
  return item?.parameterId ? solver.dimensions.get(item.parameterId) : null;
}

function choiceExpression(item, solver) {
  const { choices } = resolveControlChoices(item, solver);
  if (!choices.length) return literalExpression('');
  const index = Math.min(item.selectedIndex, choices.length - 1);
  return choices[index].parameterExpression;
}

function initialParameterExpression(item, solver) {
  if (item.controlType === 'options' || item.controlType === 'dropdown') {
    return choiceExpression(item, solver);
  }
  return item.configurationExpression;
}

function finiteScalarEvaluation(solver, expression, fallback) {
  const evaluated = evaluateExpression(solver, expression);
  const value = Number(evaluated.value);
  return Number.isFinite(value) ? value : fallback;
}

export function controlVisibilityState(item, solver) {
  if (item?.visible !== false) return { visible: true, error: null };
  const expression = String(item?.visibleExpression ?? '').trim();
  if (!expression) return { visible: false, error: null };
  try {
    const evaluate = solver?.evaluateParameterExpression || solver?.evaluateScalarExpression;
    if (typeof evaluate !== 'function') throw new Error('Expression evaluation is unavailable.');
    return { visible: Boolean(evaluate.call(solver, expression)), error: null };
  } catch (error) {
    const name = item.label || item.parameterName || 'Control';
    return {
      visible: false,
      error: `${name} visibility expression failed: ${error.message}`,
    };
  }
}

export function controlPanelState(item, solver) {
  const entry = currentParameter(item, solver);
  const visibility = controlVisibilityState(item, solver);
  const withVisibility = (state) => ({
    ...state,
    effectiveVisible: visibility.visible,
    visibilityError: visibility.error,
  });
  if (item.controlType === 'horizontal-scrollbar') {
    const parsed = parseMinMaxExpression(item.configurationExpression);
    if (!parsed) {
      return withVisibility({
        entry,
        value: Number(entry?.value) || 0,
        valueText: displayValue(Number(entry?.value) || 0),
        minimum: 0,
        maximum: 100,
        step: 1,
        error: 'Use MinMax(minimum, maximum, initial, step).',
      });
    }
    const first = finiteScalarEvaluation(solver, parsed.minimumExpression, 0);
    const second = finiteScalarEvaluation(solver, parsed.maximumExpression, 100);
    const minimum = Math.min(first, second);
    const maximum = Math.max(first, second);
    const step = Math.abs(finiteScalarEvaluation(solver, parsed.stepExpression, 1)) || 1;
    const raw = Number(entry?.value);
    const value = Math.max(minimum, Math.min(maximum, Number.isFinite(raw) ? raw : minimum));
    return withVisibility({
      entry,
      value,
      valueText: displayValue(value),
      minimum,
      maximum,
      step,
      error: entry?.error || null,
    });
  }
  if (item.controlType === 'checkbox' || item.controlType === 'container') {
    return withVisibility({ entry, value: Boolean(entry?.value), error: entry?.error || null });
  }
  if (item.controlType === 'numeric-textbox') {
    const value = Number(entry?.value);
    return withVisibility({
      entry,
      value: Number.isFinite(value) ? value : 0,
      error: entry?.error || null,
    });
  }
  const resolved = resolveControlChoices(item, solver);
  const maximumIndex = Math.max(0, resolved.choices.length - 1);
  return withVisibility({
    entry,
    choices: resolved.choices,
    selectedIndex: Math.min(item.selectedIndex, maximumIndex),
    value: entry?.value,
    error: resolved.error || entry?.error || null,
  });
}

export function snapMinMaxValue(value, minimum, maximum, step) {
  const low = Math.min(Number(minimum), Number(maximum));
  const high = Math.max(Number(minimum), Number(maximum));
  const raw = Number(value);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return raw;
  if (!Number.isFinite(raw)) return low;
  const increment = Math.abs(Number(step));
  if (!Number.isFinite(increment) || increment <= 0) {
    return Math.max(low, Math.min(high, raw));
  }
  const snapped = low + Math.round((raw - low) / increment) * increment;
  const clamped = Math.max(low, Math.min(high, snapped));
  return Number(clamped.toFixed(12));
}

export function controlExpressionForValue(item, value, bounds = null) {
  if (item.controlType === 'checkbox' || item.controlType === 'container') return value ? 'TRUE' : 'FALSE';
  if (item.controlType === 'numeric-textbox') return String(value);
  if (item.controlType !== 'horizontal-scrollbar') return item.configurationExpression;
  const parsed = parseMinMaxExpression(item.configurationExpression);
  if (!parsed) return item.configurationExpression;
  const committedValue = bounds
    ? snapMinMaxValue(value, bounds.minimum, bounds.maximum, bounds.step)
    : value;
  return formatMinMaxExpression({
    ...parsed,
    initialExpression: String(committedValue),
  });
}

export function createControlPanelModel({
  solver,
  updateParameter = (parameterId, patch) => solver.updateParameter(parameterId, patch),
} = {}) {
  let items = [];
  let knownParameterNames = new Map(
    solver.parameters().map((parameter) => [parameter.id, parameter.name]),
  );
  const listeners = new Set();

  function emit(reason = 'change') {
    const snapshot = list();
    listeners.forEach((listener) => listener(snapshot, reason));
  }

  function ensureParameter(item) {
    const existing = solver.dimensions.get(item.parameterId || item.parameterName);
    if (existing?.kind === 'control') {
      item.parameterId = existing.id;
      item.parameterName = existing.name;
      if (existing.usesDrawingUnit === false) return existing;
      return solver.updateParameter(existing.id, { usesDrawingUnit: false }).entry;
    }
    const created = solver.createControlParameter({
      id: item.parameterId || undefined,
      name: item.parameterName || '',
      expression: initialParameterExpression(item, solver),
      usesDrawingUnit: false,
    });
    item.parameterId = created.id;
    item.parameterName = created.name;
    return created;
  }

  function list() {
    return items.map(clone);
  }

  function get(id) {
    return items.find((item) => item.id === id) || null;
  }

  function contains(containerId, id) {
    for (let item = get(id); item; item = get(item.parentContainerId)) {
      if (item.id === containerId) return true;
    }
    return false;
  }

  // Keep a flat, serializable preorder while retaining explicit parent links.
  function normalizeHierarchy() {
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const item of items) {
      const seen = new Set([item.id]);
      for (let parentId = item.parentContainerId; parentId;) {
        const parent = byId.get(parentId);
        if (seen.has(parentId) || parent?.controlType !== 'container') {
          item.parentContainerId = null;
          break;
        }
        seen.add(parentId);
        parentId = parent.parentContainerId;
      }
    }
    const children = new Map();
    items.forEach((item) => {
      if (!children.has(item.parentContainerId)) children.set(item.parentContainerId, []);
      children.get(item.parentContainerId).push(item);
    });
    const ordered = [];
    const append = (parentId) => (children.get(parentId) || []).forEach((item) => {
      ordered.push(item);
      append(item.id);
    });
    append(null);
    items = ordered;
  }

  function add(controlType, input = {}) {
    const item = createControlItem(controlType, input);
    ensureParameter(item);
    items.push(item);
    normalizeHierarchy();
    emit('add');
    return clone(item);
  }

  function remove(id) {
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const [removed] = items.splice(index, 1);
    items.forEach((item) => {
      if (item.parentContainerId === removed.id) item.parentContainerId = removed.parentContainerId;
    });
    if (removed.parameterId) solver.removeParameter(removed.parameterId);
    emit('remove');
    return true;
  }

  function reorder(id, targetIndex) {
    const item = get(id);
    if (!item) return false;
    const siblings = items.filter((other) => other.parentContainerId === item.parentContainerId && other.id !== id);
    const bounded = Math.max(0, Math.min(siblings.length, Number(targetIndex) || 0));
    return move(id, item.parentContainerId, siblings[bounded]?.id || null);
  }

  function move(id, parentContainerId = null, beforeId = null) {
    const item = get(id);
    if (!item || (parentContainerId && (
      get(parentContainerId)?.controlType !== 'container' || contains(id, parentContainerId)
    ))) return false;
    const before = get(beforeId);
    if (beforeId && (!before || before.parentContainerId !== parentContainerId || contains(id, beforeId))) return false;
    const beforeOrder = items.map((entry) => entry.id).join(',');
    const previousParent = item.parentContainerId;
    const subtree = items.filter((entry) => contains(id, entry.id));
    const subtreeIds = new Set(subtree.map((entry) => entry.id));
    const remaining = items.filter((entry) => !subtreeIds.has(entry.id));
    let index = beforeId ? remaining.indexOf(before) : remaining.length;
    if (!beforeId && parentContainerId) {
      index = remaining.findIndex((entry) => entry.id === parentContainerId) + 1;
      while (index < remaining.length && contains(parentContainerId, remaining[index].id)) index += 1;
    }
    item.parentContainerId = parentContainerId;
    remaining.splice(index, 0, ...subtree);
    items = remaining;
    if (previousParent === parentContainerId && beforeOrder === items.map((entry) => entry.id).join(',')) return false;
    emit('reorder');
    return true;
  }

  function setLabel(id, label) {
    const item = get(id);
    if (!item) return false;
    item.label = String(label ?? '');
    emit('label');
    return true;
  }

  function setItemVisible(id, visible) {
    const item = get(id);
    if (!item) return false;
    item.visible = Boolean(visible);
    emit('visibility');
    return true;
  }

  function setItemVisibilityExpression(id, expression) {
    const item = get(id);
    if (!item) return null;
    item.visibleExpression = String(expression ?? '');
    const state = controlVisibilityState(item, solver);
    emit('visibility-expression');
    return state;
  }

  function setConfigurationExpression(id, expression) {
    const item = get(id);
    if (!item) return null;
    item.configurationExpression = String(expression ?? '');
    ensureParameter(item);
    const parameterExpression = initialParameterExpression(item, solver);
    const outcome = updateParameter(item.parameterId, { expression: parameterExpression });
    emit('expression');
    return outcome;
  }

  function setValue(id, value) {
    const item = get(id);
    if (!item) return null;
    ensureParameter(item);
    if (item.controlType === 'options' || item.controlType === 'dropdown') {
      const resolved = resolveControlChoices(item, solver);
      if (!resolved.choices.length) return null;
      item.selectedIndex = Math.max(0, Math.min(
        resolved.choices.length - 1,
        Math.round(Number(value) || 0),
      ));
      const outcome = updateParameter(item.parameterId, {
        expression: resolved.choices[item.selectedIndex].parameterExpression,
        usesDrawingUnit: false,
      });
      emit('value');
      return outcome;
    }
    const bounds = item.controlType === 'horizontal-scrollbar'
      ? controlPanelState(item, solver)
      : null;
    item.configurationExpression = controlExpressionForValue(item, value, bounds);
    const outcome = updateParameter(item.parameterId, {
      expression: item.configurationExpression,
      usesDrawingUnit: false,
    });
    emit('value');
    return outcome;
  }

  function previewValue(id, value) {
    const item = get(id);
    if (item?.controlType !== 'horizontal-scrollbar') return null;
    const state = controlPanelState(item, solver);
    return snapMinMaxValue(value, state.minimum, state.maximum, state.step);
  }

  function serialize() {
    return {
      version: CONTROL_EXTENSION_VERSION,
      items: list(),
    };
  }

  function restore(value) {
    items = Array.isArray(value?.items)
      ? value.items.map(normalizeControlItem)
      : [];
    normalizeHierarchy();
    items.forEach(ensureParameter);
    emit('restore');
    return list();
  }

  function clear() {
    items = [];
    emit('clear');
  }

  function synchronizeParameters(parameters = solver.parameters()) {
    const currentNames = new Map(parameters.map((parameter) => [parameter.id, parameter.name]));
    const renames = [...currentNames.entries()]
      .map(([id, name]) => ({ before: knownParameterNames.get(id), after: name }))
      .filter(({ before, after }) => before && before !== after);
    if (renames.length) {
      items.forEach((item) => {
        renames.forEach(({ before, after }) => {
          const escaped = before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          ['configurationExpression', 'visibleExpression'].forEach((field) => {
            item[field] = item[field].replace(new RegExp(`\\b${escaped}\\b`, 'g'), after);
          });
        });
      });
    }
    items.forEach((item) => {
      const name = currentNames.get(item.parameterId);
      if (name) item.parameterName = name;
    });
    knownParameterNames = currentNames;
    return renames.length > 0;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    add,
    remove,
    reorder,
    move,
    contains,
    setLabel,
    setItemVisible,
    setItemVisibilityExpression,
    setConfigurationExpression,
    setValue,
    previewValue,
    serialize,
    restore,
    clear,
    list,
    get: (id) => clone(get(id)),
    state: (id) => {
      const item = get(id);
      return item ? controlPanelState(item, solver) : null;
    },
    synchronizeParameters,
    subscribe,
  };
}

function controlRuntimeMarkup(item, state) {
  if (item.controlType === 'horizontal-scrollbar') {
    return `<div class="panel-control-scrollbar-layout">
      <input class="panel-control-scrollbar" data-control-value type="range"
        min="${escapeHtml(state.minimum)}" max="${escapeHtml(state.maximum)}"
        step="${escapeHtml(state.step)}" value="${escapeHtml(state.value)}"
        aria-label="${escapeHtml(item.label || item.parameterName)}" />
      <input class="panel-control-number panel-control-slider-value" data-control-value type="number"
        min="${escapeHtml(state.minimum)}" max="${escapeHtml(state.maximum)}" step="${escapeHtml(state.step)}"
        inputmode="decimal" value="${escapeHtml(state.value)}"
        aria-label="${escapeHtml(item.label || item.parameterName)} value" />
    </div>`;
  }
  if (item.controlType === 'checkbox') {
    return `<input class="panel-control-checkbox" data-control-value type="checkbox"
      ${state.value ? 'checked' : ''} aria-label="${escapeHtml(item.label || item.parameterName)}" />`;
  }
  if (item.controlType === 'numeric-textbox') {
    return `<input class="panel-control-number" data-control-value type="number"
      value="${escapeHtml(state.value)}" aria-label="${escapeHtml(item.label || item.parameterName)}" />`;
  }
  if (item.controlType === 'dropdown') {
    return `<select class="panel-control-dropdown" data-control-value aria-label="${escapeHtml(item.label || item.parameterName)}">
      ${state.choices.map((choice) => `<option value="${choice.index}" ${choice.index === state.selectedIndex ? 'selected' : ''}>${escapeHtml(choice.label)}</option>`).join('')}
    </select>`;
  }
  return `<div class="panel-control-options" role="radiogroup" aria-label="${escapeHtml(item.label || item.parameterName)}">
    ${state.choices.map((choice) => `<label><input data-control-value type="radio" name="control-${escapeHtml(item.id)}"
      value="${choice.index}" ${choice.index === state.selectedIndex ? 'checked' : ''} /><span>${escapeHtml(choice.label)}</span></label>`).join('')}
  </div>`;
}

export function controlRowMarkup(item, state, editing, childrenMarkup = '') {
  const configurationError = state.error || '';
  const visibilityError = state.visibilityError || '';
  const error = configurationError || visibilityError;
  const container = item.controlType === 'container';
  return `<article class="panel-control-row${container ? ' panel-control-container' : ''}${error ? ' invalid' : ''}" data-control-id="${escapeHtml(item.id)}">
    <div class="panel-control-body">
    <div class="panel-control-row-heading">
      ${editing ? `<button type="button" class="control-row-drag-handle" title="Drag to reorder or move into a Container" aria-label="Drag ${escapeHtml(item.parameterName)} to reorder">${svgIcon('drag')}</button>` : ''}
      ${container && !editing ? `<button type="button" class="panel-control-collapse" data-control-collapse aria-expanded="${state.value}" aria-controls="controlChildren-${escapeHtml(item.id)}" aria-label="${state.value ? 'Collapse' : 'Expand'} ${escapeHtml(item.label || item.parameterName)}">${svgIcon(state.value ? 'collapse' : 'expand')}</button>` : ''}
      ${editing
        ? `<input class="panel-control-label-input" data-control-label value="${escapeHtml(item.label)}" placeholder="Control label" aria-label="${escapeHtml(item.parameterName)} label" />`
        : `<span class="panel-control-label">${escapeHtml(item.label || (container ? 'Container' : ''))}</span>`}
      <span class="panel-control-parameter">${escapeHtml(item.parameterName)}</span>
      ${editing ? `<button type="button" class="panel-control-visibility" data-control-visibility aria-pressed="${item.visible}" title="${item.visible ? 'Hide control in regular view' : 'Show control in regular view'}" aria-label="${item.visible ? 'Hide' : 'Show'} ${escapeHtml(item.parameterName)} in regular view">${svgIcon(item.visible ? 'visible' : 'hidden')}</button>` : ''}
      ${editing ? `<button type="button" class="panel-control-remove" data-control-remove title="Remove control" aria-label="Remove ${escapeHtml(item.parameterName)}">${svgIcon('remove')}</button>` : ''}
    </div>
    ${editing && item.visible === false ? `<label class="panel-control-visibility-expression">
      <span class="sr-only">Visibility expression</span>
      <input type="text" data-control-visibility-expression value="${escapeHtml(item.visibleExpression)}"
        aria-label="${escapeHtml(item.parameterName)} visibility expression" autocomplete="off" spellcheck="false"
        placeholder="${CONTROL_VISIBILITY_EXPRESSION_PLACEHOLDER}" aria-invalid="${visibilityError ? 'true' : 'false'}"
        title="${escapeHtml(visibilityError || 'Blank evaluates to false')}" />
    </label>` : ''}
    ${container ? '' : `<div class="panel-control-runtime">${controlRuntimeMarkup(item, state)}</div>`}
    ${editing && !container ? `<label class="panel-control-expression">
      <span>Expression</span>
      <span class="expression-box">
        <textarea data-control-expression aria-label="${escapeHtml(item.parameterName)} expression" rows="2" wrap="soft" autocomplete="off" spellcheck="false"
          placeholder="${item.controlType === 'horizontal-scrollbar' ? 'MinMax(0, 100, 50, 1)' : item.controlType === 'options' || item.controlType === 'dropdown' ? '{dog|cat|house}' : 'Expression'}"
          aria-invalid="${configurationError ? 'true' : 'false'}">${escapeHtml(item.configurationExpression)}</textarea>
        ${expressionBoxLookupMarkup({ id: `controlExpressionLookup-${item.id}` })}
      </span>
    </label>` : ''}
    <p class="panel-control-error" role="alert" ${error ? '' : 'hidden'}>${escapeHtml(error)}</p>
    </div>
    ${container ? `<div class="control-container-children" id="controlChildren-${escapeHtml(item.id)}" ${editing || state.value ? '' : 'hidden'}>
      ${childrenMarkup}
      ${editing ? `<div class="control-drop-zone" data-control-drop="${escapeHtml(item.id)}">Drop controls here</div>` : ''}
    </div>` : ''}
  </article>`;
}

export function controlPanelRows(items, solver, editing) {
  const displayed = new Map();
  return items.map((item) => ({ item, state: controlPanelState(item, solver) }))
    .filter(({ item, state }) => {
      const parent = displayed.get(item.parentContainerId);
      const visible = editing || (state.effectiveVisible && (!item.parentContainerId || parent?.state.value));
      if (visible) displayed.set(item.id, { item, state });
      return visible;
    });
}

// A Container must never read or update the widgets owned by its children.
function ownElements(row, selector) {
  return [...row.querySelectorAll(selector)].filter((element) => element.closest('[data-control-id]') === row);
}

function ownElement(row, selector) {
  return ownElements(row, selector)[0] || null;
}

export function createControlTools({
  toolbar,
  canvas,
  solver,
  host = document.querySelector('.app-shell') || document.body,
  onVisibilityChange = () => {},
} = {}) {
  const button = toolbar?.matches?.('[data-controls-toggle]')
    ? toolbar
    : toolbar?.querySelector?.('[data-controls-toggle]');
  const panel = document.createElement('section');
  const model = createControlPanelModel({
    solver,
    updateParameter: (parameterId, patch) => (
      solver.updateParameterAuthoritative
        ? solver.updateParameterAuthoritative(parameterId, patch, {
          coalesceKey: `control-parameter:${parameterId}`,
        })
        : solver.updateParameter(parameterId, patch)
    ),
  });
  let editing = false;
  let rowDrag = null;
  let suppressClick = false;
  let activeEdit = null;
  let controlUpdateRevision = 0;
  let renderedStructure = '';
  const pendingControlUpdates = new Map();
  const latestControlUpdateRevisions = new Map();
  const controlExpressionLookups = new Map();

  panel.className = 'floating-panel controls-panel';
  panel.id = 'controlsPanel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Controls');
  panel.innerHTML = `
    <div class="controls-panel-header">
      <h2>Controls</h2>
      <div class="controls-panel-header-actions">
        <button type="button" class="controls-edit-toggle" data-controls-edit aria-pressed="false" title="Edit controls" aria-label="Edit controls">${svgIcon('edit')}</button>
        <button type="button" class="panel-close-button controls-panel-close" title="Close Controls" aria-label="Close Controls">&times;</button>
      </div>
    </div>
    <div class="controls-panel-actions" hidden>
      <label>
        <span class="sr-only">Add a control</span>
        <select data-control-add aria-label="Add a control">
          <option value="">Add control...</option>
          ${controlToolTypes.map((label) => `<option value="${escapeHtml(label)}">${escapeHtml(label)}</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="controls-list" data-controls-list aria-label="Drawing controls"></div>
    <datalist id="controlVisibilityExpressionSymbols"></datalist>
  `;
  host.append(panel);

  const list = panel.querySelector('[data-controls-list]');
  const actions = panel.querySelector('.controls-panel-actions');
  const editButton = panel.querySelector('[data-controls-edit]');
  const addSelect = panel.querySelector('[data-control-add]');
  const visibilityExpressionSymbols = panel.querySelector('#controlVisibilityExpressionSymbols');
  const panelDragController = bindFloatingPanelDrag(panel, {
    ignoreSelector: 'button, input, select, textarea, label, .controls-list',
  });

  function setVisible(visible) {
    panel.hidden = !visible;
    if (visible) {
      render();
      panelDragController.clamp();
    } else {
      controlExpressionLookups.forEach((lookup) => lookup.close());
    }
    button?.classList.toggle('active', visible);
    button?.setAttribute('aria-pressed', String(visible));
    onVisibilityChange(Boolean(visible));
  }

  function setEditing(value) {
    editing = Boolean(value);
    panel.classList.toggle('editing', editing);
    editButton.classList.toggle('active', editing);
    editButton.setAttribute('aria-pressed', String(editing));
    actions.hidden = !editing;
    render();
  }

  function notifyMutation(reason, history = 'commit', outcome = null) {
    const changedRecordIds = canvas.applySolverSnapshot?.(outcome?.snapshot);
    canvas.notifyObjectChange?.({ history, changedRecordIds });
    if (history === 'commit') activeEdit = null;
  }

  function beginMutation(reason) {
    canvas.requestHistoryCheckpoint?.(`controls-${reason}`);
  }

  function setControlPending(id, pending) {
    const row = list.querySelector(`[data-control-id="${CSS.escape(id)}"]`);
    row?.toggleAttribute('aria-busy', pending);
  }

  function showControlUpdateError(id, error) {
    const row = list.querySelector(`[data-control-id="${CSS.escape(id)}"]`);
    if (!row) return;
    row.classList.add('invalid');
    const message = error instanceof Error ? error.message : String(error || 'Control update failed.');
    const errorElement = ownElement(row, '.panel-control-error');
    if (errorElement) {
      errorElement.hidden = false;
      errorElement.textContent = message;
    }
  }

  function applyControlMutation(id, outcome, { reason, history = 'none' } = {}) {
    const revision = ++controlUpdateRevision;
    latestControlUpdateRevisions.set(id, revision);
    const finish = (resolved) => {
      if (latestControlUpdateRevisions.get(id) !== revision) return resolved;
      pendingControlUpdates.delete(id);
      setControlPending(id, false);
      notifyMutation(reason, history, resolved);
      syncRuntimeControls();
      return resolved;
    };
    if (!outcome?.then) return finish(outcome);
    setControlPending(id, true);
    const pending = Promise.resolve(outcome)
      .then(finish)
      .catch((error) => {
        if (latestControlUpdateRevisions.get(id) === revision) {
          pendingControlUpdates.delete(id);
          setControlPending(id, false);
          showControlUpdateError(id, error);
        }
        return null;
      });
    pendingControlUpdates.set(id, { revision, promise: pending });
    return pending;
  }

  function commitPendingControlMutation(id, reason) {
    const pending = pendingControlUpdates.get(id);
    if (!pending) {
      notifyMutation(reason);
      syncRuntimeControls();
      return;
    }
    pending.promise.then((outcome) => {
      if (latestControlUpdateRevisions.get(id) !== pending.revision) return;
      notifyMutation(reason, 'commit', outcome);
      syncRuntimeControls();
    });
  }

  function commitSliderValue(row, id, value) {
    const outcome = model.setValue(id, value);
    const applied = applyControlMutation(id, outcome, { reason: 'value', history: 'commit' });
    const syncCommittedValue = () => {
      const current = model.get(id);
      if (!current) return;
      const committedValue = String(controlPanelState(current, solver).value);
      const slider = ownElement(row, '.panel-control-scrollbar');
      const input = ownElement(row, '.panel-control-slider-value');
      if (slider) slider.value = committedValue;
      if (input) input.value = committedValue;
    };
    if (applied?.then) applied.then(syncCommittedValue);
    else syncCommittedValue();
    return applied;
  }

  function resizeControlExpression(field) {
    if (!field) return;
    field.style.height = 'auto';
    const height = Math.min(180, Math.max(54, field.scrollHeight));
    field.style.height = `${height}px`;
    field.style.overflowY = field.scrollHeight > 180 ? 'auto' : 'hidden';
  }

  function resizeControlExpressions() {
    list.querySelectorAll('[data-control-expression]').forEach(resizeControlExpression);
  }

  function destroyControlExpressionLookups() {
    controlExpressionLookups.forEach((lookup) => lookup.destroy());
    controlExpressionLookups.clear();
  }

  function controlExpressionLookupOptions(item) {
    const entries = new Map((solver.parameters?.() || []).map((entry) => [entry.id, entry]));
    return (solver.parameterExpressionSymbols?.({ includeLocalAliases: true }) || [])
      .filter((symbol) => (
        symbol.name
        && symbol.parameterId !== item.parameterId
        && !entries.get(symbol.parameterId)?.error
      ))
      .map((symbol) => ({
        name: symbol.name,
        label: symbol.kind === 'dimension' ? `${symbol.name} (dimension)` : symbol.name,
      }));
  }

  function bindControlExpressionLookups() {
    list.querySelectorAll('[data-control-id]').forEach((row) => {
      const item = model.get(row.dataset.controlId);
      const field = ownElement(row, '[data-control-expression]');
      const listbox = ownElement(row, '[data-expression-lookup-list]');
      if (!item || !field || !listbox) return;
      const lookup = createExpressionBoxLookup({ field, listbox });
      lookup.setOptions(controlExpressionLookupOptions(item));
      controlExpressionLookups.set(item.id, lookup);
    });
  }

  function render() {
    destroyControlExpressionLookups();
    const items = model.list();
    const displayedRows = controlPanelRows(items, solver, editing);
    renderedStructure = structureSignature(displayedRows);
    const children = new Map();
    displayedRows.forEach((row) => {
      const parentId = row.item.parentContainerId;
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(row);
    });
    const markup = (parentId) => (children.get(parentId) || []).map(({ item, state }) => (
      controlRowMarkup(item, state, editing, markup(item.id))
    )).join('');
    list.innerHTML = displayedRows.length
      ? markup(null)
      : `<p class="controls-empty-state">${editing ? 'Use Add control to build this userform.' : items.length ? 'No controls are visible.' : 'No controls have been added.'}</p>`;
    if (editing && items.some((item) => item.controlType === 'container')) {
      list.insertAdjacentHTML('beforeend', '<div class="control-drop-zone control-root-drop" data-control-drop="">Move outside all Containers</div>');
    }
    resizeControlExpressions();
    bindControlExpressionLookups();
    updateVisibilityExpressionSymbols();
  }

  function structureSignature(rows) {
    return JSON.stringify(rows.map(({ item, state }) => [item.id, item.parentContainerId, item.controlType === 'container' && state.value]));
  }

  function updateVisibilityExpressionSymbols() {
    visibilityExpressionSymbols.innerHTML = (solver.parameterExpressionSymbols?.({ includeLocalAliases: true }) || [])
      .map(({ name }) => `<option value="${escapeHtml(name)}"></option>`).join('');
    list.querySelectorAll('[data-control-visibility-expression]').forEach((input) => {
      input.setAttribute('data-expression-source', visibilityExpressionSymbols.id);
    });
  }

  function syncRuntimeControls() {
    if (structureSignature(controlPanelRows(model.list(), solver, editing)) !== renderedStructure) {
      render();
      return;
    }
    model.list().forEach((item) => {
      const row = list.querySelector(`[data-control-id="${CSS.escape(item.id)}"]`);
      if (!row) return;
      const state = controlPanelState(item, solver);
      const parameter = ownElement(row, '.panel-control-parameter');
      if (parameter) parameter.textContent = state.entry?.name || item.parameterName;
      row.classList.toggle('invalid', Boolean(state.error || state.visibilityError));
      const error = ownElement(row, '.panel-control-error');
      if (error) {
        const message = state.error || state.visibilityError || '';
        error.hidden = !message;
        error.textContent = message;
      }
      const visibilityExpression = ownElement(row, '[data-control-visibility-expression]');
      if (visibilityExpression && document.activeElement !== visibilityExpression) {
        visibilityExpression.value = item.visibleExpression;
        visibilityExpression.setAttribute('aria-invalid', String(Boolean(state.visibilityError)));
        visibilityExpression.title = state.visibilityError || 'Blank evaluates to false';
      }
      const expression = ownElement(row, '[data-control-expression]');
      if (expression && document.activeElement !== expression) {
        expression.value = item.configurationExpression;
        expression.setAttribute('aria-invalid', String(Boolean(state.error)));
        resizeControlExpression(expression);
      }
      if (item.controlType === 'horizontal-scrollbar') {
        const slider = ownElement(row, '.panel-control-scrollbar');
        const valueInput = ownElement(row, '.panel-control-slider-value');
        if (slider && document.activeElement !== slider) {
          slider.min = String(state.minimum);
          slider.max = String(state.maximum);
          slider.step = String(state.step);
          slider.value = String(state.value);
        }
        if (valueInput && document.activeElement !== valueInput) {
          valueInput.min = String(state.minimum);
          valueInput.max = String(state.maximum);
          valueInput.step = String(state.step);
          valueInput.value = String(state.value);
        }
      } else if (item.controlType === 'container') {
        // Container state is represented by the disclosure arrow and children.
      } else if (item.controlType === 'checkbox') {
        const input = ownElement(row, '[data-control-value]');
        if (input) input.checked = state.value;
      } else if (item.controlType === 'numeric-textbox') {
        const input = ownElement(row, '[data-control-value]');
        if (input && document.activeElement !== input) input.value = String(state.value);
      } else {
        const controls = [...ownElements(row, '[data-control-value]')];
        if (controls.length !== state.choices.length) {
          ownElement(row, '.panel-control-runtime').innerHTML = controlRuntimeMarkup(item, state);
        } else {
          controls.forEach((input, index) => {
            if (input.tagName === 'SELECT') {
              input.value = String(state.selectedIndex);
              [...input.options].forEach((option, optionIndex) => {
                option.textContent = state.choices[optionIndex]?.label || '';
              });
            } else {
              input.checked = index === state.selectedIndex;
              const label = input.closest('label')?.querySelector('span');
              if (label) label.textContent = state.choices[index]?.label || '';
            }
          });
        }
      }
    });
  }

  button?.addEventListener('click', () => setVisible(panel.hidden));
  panel.querySelector('.controls-panel-close').addEventListener('click', () => setVisible(false));
  editButton.addEventListener('click', () => setEditing(!editing));
  addSelect.addEventListener('change', () => {
    const type = addSelect.value;
    addSelect.value = '';
    if (!controlToolTypes.includes(type)) return;
    beginMutation('add');
    model.add(type);
    render();
    notifyMutation('add');
  });

  list.addEventListener('click', (event) => {
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      return;
    }
    const row = event.target.closest?.('[data-control-id]');
    if (!row) return;
    if (!editing && event.target.closest('[data-control-collapse]')) {
      const item = model.get(row.dataset.controlId);
      beginMutation('collapse');
      applyControlMutation(item.id, model.setValue(item.id, !model.state(item.id).value), { reason: 'collapse', history: 'commit' });
    } else if (editing && event.target.closest('[data-control-visibility]')) {
      const item = model.get(row.dataset.controlId);
      if (!item) return;
      beginMutation('visibility');
      model.setItemVisible(item.id, !item.visible);
      render();
      notifyMutation('visibility');
      if (item.visible) queueMicrotask(() => {
        updateVisibilityExpressionSymbols();
        const input = list.querySelector(`[data-control-id="${CSS.escape(item.id)}"] [data-control-visibility-expression]`);
        input?.focus();
        input?.select();
      });
    } else if (editing && event.target.closest('[data-control-remove]')) {
      beginMutation('remove');
      model.remove(row.dataset.controlId);
      render();
      notifyMutation('remove');
    }
  });

  list.addEventListener('focusin', (event) => {
    const field = event.target.closest?.('[data-control-label], [data-control-expression], [data-control-visibility-expression]');
    const row = field?.closest('[data-control-id]');
    if (!field || !row) return;
    const fieldType = field.hasAttribute('data-control-label')
      ? 'label'
      : field.hasAttribute('data-control-visibility-expression')
        ? 'visibility-expression'
        : 'expression';
    const key = `${row.dataset.controlId}:${fieldType}`;
    if (activeEdit !== key) {
      beginMutation(fieldType);
      activeEdit = key;
    }
  });

  list.addEventListener('input', (event) => {
    const row = event.target.closest?.('[data-control-id]');
    if (!row) return;
    const id = row.dataset.controlId;
    if (event.target.matches('[data-control-label]')) {
      model.setLabel(id, event.target.value);
      canvas.notifyObjectChange?.({ history: 'none' });
      return;
    }
    if (event.target.matches('[data-control-visibility-expression]')) {
      model.setItemVisibilityExpression(id, event.target.value);
      syncRuntimeControls();
      canvas.notifyObjectChange?.({ history: 'none' });
      return;
    }
    if (event.target.matches('[data-control-expression]')) {
      resizeControlExpression(event.target);
      const outcome = model.setConfigurationExpression(id, event.target.value);
      applyControlMutation(id, outcome, { reason: 'expression', history: 'none' });
      return;
    }
    if (!event.target.matches('[data-control-value]')) return;
    const item = model.get(id);
    if (!item) return;
    // Let the numeric slider field accept an arbitrary decimal while it is
    // being edited. Its change event commits the value and snaps it to the
    // nearest MinMax step.
    if (item.controlType === 'horizontal-scrollbar') {
      if (event.target.matches('.panel-control-scrollbar')) {
        const preview = model.previewValue(id, event.target.value);
        const input = ownElement(row, '.panel-control-slider-value');
        if (input && preview !== null) input.value = String(preview);
      }
      return;
    }
    const value = item.controlType === 'checkbox'
      ? event.target.checked
      : item.controlType === 'options'
        ? event.target.value
        : event.target.value;
    const outcome = model.setValue(id, value);
    const discrete = ['checkbox', 'options', 'dropdown'].includes(item.controlType);
    applyControlMutation(id, outcome, {
      reason: 'value',
      history: discrete ? 'commit' : 'none',
    });
  });

  list.addEventListener('change', (event) => {
    const row = event.target.closest?.('[data-control-id]');
    if (!row) return;
    if (event.target.matches('[data-control-visibility-expression]')) {
      notifyMutation('visibility-expression');
      syncRuntimeControls();
      return;
    }
    if (event.target.matches('[data-control-label], [data-control-expression]')) {
      commitPendingControlMutation(row.dataset.controlId, 'edit');
      return;
    }
    if (!event.target.matches('[data-control-value]')) return;
    const item = model.get(row.dataset.controlId);
    if (item?.controlType === 'horizontal-scrollbar'
      && event.target.matches('.panel-control-scrollbar, .panel-control-slider-value')) {
      commitSliderValue(row, row.dataset.controlId, event.target.value);
      return;
    }
    if (item && !['checkbox', 'options', 'dropdown'].includes(item.controlType)) {
      commitPendingControlMutation(row.dataset.controlId, 'value');
    }
  });

  list.addEventListener('pointerdown', (event) => {
    const row = event.target.closest?.('[data-control-id]');
    if (!row || event.button !== 0) return;
    if (event.target.matches('.panel-control-scrollbar, .panel-control-slider-value')) beginMutation('value');
    const handle = event.target.closest('.control-row-drag-handle');
    if (!editing || !handle) return;
    beginMutation('reorder');
    rowDrag = {
      pointerId: event.pointerId,
      id: row.dataset.controlId,
      row,
      startY: event.clientY,
      startX: event.clientX,
      moved: false,
      targetId: row.dataset.controlId,
      after: false,
    };
    handle.setPointerCapture?.(event.pointerId);
  });

  function clearDropFeedback() {
    list.querySelectorAll('.drop-before, .drop-after, .drop-inside').forEach((element) => {
      element.classList.remove('drop-before', 'drop-after', 'drop-inside');
    });
  }

  list.addEventListener('pointermove', (event) => {
    if (!rowDrag || rowDrag.pointerId !== event.pointerId) return;
    if (!rowDrag.moved && Math.hypot(event.clientX - rowDrag.startX, event.clientY - rowDrag.startY) < 5) return;
    rowDrag.moved = true;
    event.preventDefault();
    clearDropFeedback();
    rowDrag.destination = null;
    rowDrag.row.classList.add('dragging');
    const bounds = list.getBoundingClientRect();
    if (event.clientY < bounds.top + 28) list.scrollTop -= 18;
    else if (event.clientY > bounds.bottom - 28) list.scrollTop += 18;
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    if (!hit || !list.contains(hit)) return;
    const zone = hit.closest('[data-control-drop]');
    if (zone) {
      const parentId = zone.dataset.controlDrop || null;
      if (parentId && model.contains(rowDrag.id, parentId)) return;
      rowDrag.destination = { parentId, beforeId: null };
      zone.classList.add('drop-inside');
      return;
    }
    const target = hit.closest('[data-control-id]');
    if (!target || model.contains(rowDrag.id, target.dataset.controlId)) return;
    const item = model.get(target.dataset.controlId);
    const bodyBounds = ownElement(target, '.panel-control-body').getBoundingClientRect();
    if (item.controlType === 'container' && event.clientY > bodyBounds.top + 6 && event.clientY < bodyBounds.bottom - 6) {
      rowDrag.destination = { parentId: item.id, beforeId: null };
      target.classList.add('drop-inside');
      return;
    }
    const after = event.clientY >= bodyBounds.top + bodyBounds.height / 2;
    const siblings = model.list().filter((entry) => entry.parentContainerId === item.parentContainerId && entry.id !== rowDrag.id);
    const nextSibling = siblings[siblings.findIndex((entry) => entry.id === item.id) + 1];
    rowDrag.destination = { parentId: item.parentContainerId, beforeId: after ? nextSibling?.id || null : item.id };
    target.classList.add(after ? 'drop-after' : 'drop-before');
  });

  function finishRowDrag(event, cancelled = false) {
    if (!rowDrag || rowDrag.pointerId !== event.pointerId) return;
    const completed = rowDrag;
    rowDrag = null;
    clearDropFeedback();
    completed.row.classList.remove('dragging');
    if (cancelled || !completed.moved || !completed.destination) return;
    const changed = model.move(completed.id, completed.destination.parentId, completed.destination.beforeId);
    suppressClick = true;
    if (changed) {
      render();
      notifyMutation('reorder');
    }
    setTimeout(() => { suppressClick = false; }, 0);
  }

  list.addEventListener('pointerup', (event) => finishRowDrag(event));
  list.addEventListener('pointercancel', (event) => finishRowDrag(event, true));

  const stopSolverSubscription = solver.subscribe((parameters) => {
    model.synchronizeParameters(parameters);
    updateVisibilityExpressionSymbols();
    if (panel.hidden) return;
    syncRuntimeControls();
  });
  const unregisterExtension = canvas.registerDrawingExtension?.('controls', {
    serialize: model.serialize,
    restore(value) {
      model.restore(value);
      render();
    },
    clear() {
      model.clear();
      render();
    },
  });

  render();

  return {
    panel,
    model,
    setVisible,
    setEditing,
    destroy() {
      destroyControlExpressionLookups();
      stopSolverSubscription?.();
      unregisterExtension?.();
      panelDragController.destroy();
      panel.remove();
    },
  };
}
