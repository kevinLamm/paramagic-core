import { createStableId } from './solver/SolverModel.js';

// --- Floating Panel Positioning & Drag Utilities ---
const FLOATING_PANEL_MIN_TOP_PROPERTY = '--floating-panel-min-top';
const FLOATING_PANEL_MAX_RIGHT_PROPERTY = '--floating-panel-max-right';
const FLOATING_PANEL_BOUNDARY_EVENT = 'paramagic:floating-panel-boundary-change';
const TOOLBAR_CONTENT_RESIZE_EVENT = 'paramagic:toolbar-content-resize';
const TOOL_HEADER_DENSITIES = Object.freeze([
  { size: 40, iconBox: 38, iconSize: 30, toolGap: 3, sectionGap: 7 },
  { size: 36, iconBox: 34, iconSize: 27, toolGap: 2, sectionGap: 5 },
  { size: 32, iconBox: 30, iconSize: 24, toolGap: 2, sectionGap: 4 },
]);

export function floatingPanelMinimumTop(rect = {}, { gap = 8 } = {}) {
  return Math.max(0, Number(rect.bottom) || 0) + Math.max(0, Number(gap) || 0);
}

export function floatingPanelMaximumRight(rect = {}, { gap = 8, viewportWidth = 0 } = {}) {
  const safeGap = Math.max(0, Number(gap) || 0);
  const safeViewportWidth = Math.max(0, Number(viewportWidth) || 0);
  const railLeft = Number(rect.left);
  const railWidth = Math.max(0, Number(rect.width) || 0);
  if (!Number.isFinite(railLeft) || railWidth <= 0) return Math.max(0, safeViewportWidth - safeGap);
  return Math.max(0, Math.min(safeViewportWidth - safeGap, railLeft - safeGap));
}

function configuredPanelMinTop(fallback = 8) {
  if (!globalThis.document || !globalThis.getComputedStyle) return fallback;
  const value = Number.parseFloat(getComputedStyle(document.documentElement)
    .getPropertyValue(FLOATING_PANEL_MIN_TOP_PROPERTY));
  return Number.isFinite(value) ? value : fallback;
}

function configuredPanelMaxRight(fallback = globalThis.window?.innerWidth || 0) {
  if (!globalThis.document || !globalThis.getComputedStyle) return fallback;
  const value = Number.parseFloat(getComputedStyle(document.documentElement)
    .getPropertyValue(FLOATING_PANEL_MAX_RIGHT_PROPERTY));
  return Number.isFinite(value) ? value : fallback;
}

function resolvedPanelMinTop(minTop, fallback) {
  if (typeof minTop === 'function') return Number(minTop()) || fallback;
  if (minTop !== null && minTop !== undefined) return Number(minTop) || fallback;
  return configuredPanelMinTop(fallback);
}

function resolvedPanelMaxRight(maxRight, fallback) {
  if (typeof maxRight === 'function') return Number(maxRight()) || fallback;
  if (maxRight !== null && maxRight !== undefined) return Number(maxRight) || fallback;
  return configuredPanelMaxRight(fallback);
}

export function horizontalToolSectionCount({
  availableWidth,
  menuWidth = 0,
  sectionWidths = [],
  gap = 7,
} = {}) {
  return horizontalToolSectionIndexes({
    availableWidth,
    menuWidth,
    sectionWidths,
    gap,
  }).length;
}

export function horizontalToolSectionIndexes({
  availableWidth,
  menuWidth = 0,
  sectionWidths = [],
  gap = 7,
} = {}) {
  const width = Math.max(0, Number(availableWidth) || 0);
  const safeGap = Math.max(0, Number(gap) || 0);
  let used = Math.max(0, Number(menuWidth) || 0);
  const indexes = [];
  sectionWidths.forEach((rawSectionWidth, index) => {
    const sectionWidth = Math.max(0, Number(rawSectionWidth) || 0);
    const nextWidth = used + (used > 0 ? safeGap : 0) + sectionWidth;
    if (nextWidth > width) return;
    used = nextWidth;
    indexes.push(index);
  });
  return indexes;
}

export function bindResponsiveToolHeader(header, {
  toolbar = header?.querySelector?.('.unified-toolbar'),
  rail = header?.querySelector?.('.app-header-vertical-rail'),
  menu = header?.querySelector?.('.app-menu-shell'),
  gap = 7,
  railGap = 4,
} = {}) {
  if (!header || !toolbar || !rail || !menu || !globalThis.window) {
    return { update() {}, destroy() {} };
  }
  const sections = [...toolbar.children].filter((element) => element.classList.contains('toolbar-section'));
  let scheduled = 0;

  const applyDensity = (density) => {
    header.style.setProperty('--header-tool-size', `${density.size}px`);
    header.style.setProperty('--header-tool-icon-box', `${density.iconBox}px`);
    header.style.setProperty('--header-tool-icon-size', `${density.iconSize}px`);
    header.style.setProperty('--header-tool-gap', `${density.toolGap}px`);
    header.style.setProperty('--header-section-gap', `${density.sectionGap}px`);
    header.dataset.toolDensity = String(density.size);
  };

  const layoutAtDensity = (density) => {
    applyDensity(density);
    sections.forEach((section) => {
      section.classList.remove('header-section-vertical');
      toolbar.appendChild(section);
    });
    rail.hidden = true;
    header.classList.remove('has-vertical-rail');

    const headerRect = header.getBoundingClientRect();
    const menuWidth = menu.getBoundingClientRect().width;
    const sectionWidths = sections.map((section) => section.getBoundingClientRect().width);
    const horizontalIndexes = horizontalToolSectionIndexes({
      availableWidth: headerRect.width,
      menuWidth,
      sectionWidths,
      gap: density.sectionGap ?? gap,
    });
    const horizontalIndexSet = new Set(horizontalIndexes);
    const overflow = sections.filter((_section, index) => !horizontalIndexSet.has(index));
    horizontalIndexes.forEach((index) => toolbar.appendChild(sections[index]));
    overflow.forEach((section) => {
      section.classList.add('header-section-vertical');
      rail.appendChild(section);
    });
    rail.hidden = overflow.length === 0;
    header.classList.toggle('has-vertical-rail', overflow.length > 0);
    const horizontalBottom = header.getBoundingClientRect().bottom;
    rail.style.top = `${Math.ceil(horizontalBottom + railGap)}px`;
    const railHeight = Math.max(density.size, Math.floor(window.innerHeight - horizontalBottom - railGap - 6));
    rail.style.setProperty('--header-vertical-rail-height', `${railHeight}px`);
    const usedRailHeight = overflow.reduce(
      (total, section) => total + section.getBoundingClientRect().height,
      0,
    );
    return {
      density: density.size,
      fits: usedRailHeight <= railHeight,
      horizontalCount: horizontalIndexes.length,
      overflowCount: overflow.length,
      usedRailHeight,
      railHeight,
    };
  };

  const update = () => {
    if (scheduled) {
      cancelAnimationFrame(scheduled);
      scheduled = 0;
    }
    let result = null;
    for (const density of TOOL_HEADER_DENSITIES) {
      result = layoutAtDensity(density);
      if (result.fits) break;
    }
    rail.dataset.fits = String(result?.fits !== false);
    window.dispatchEvent(new Event(FLOATING_PANEL_BOUNDARY_EVENT));
    return result;
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = requestAnimationFrame(update);
  };
  window.addEventListener('resize', schedule);
  window.addEventListener(TOOLBAR_CONTENT_RESIZE_EVENT, schedule);
  update();
  return {
    update,
    destroy() {
      if (scheduled) cancelAnimationFrame(scheduled);
      window.removeEventListener('resize', schedule);
      window.removeEventListener(TOOLBAR_CONTENT_RESIZE_EVENT, schedule);
    },
  };
}

export function anchoredToolMenuPosition(triggerRect = {}, menuRect = {}, {
  viewportWidth,
  viewportHeight,
  margin = 8,
  gap = 4,
  vertical = false,
} = {}) {
  const safeViewportWidth = Math.max(0, Number(viewportWidth) || 0);
  const safeViewportHeight = Math.max(0, Number(viewportHeight) || 0);
  const safeMargin = Math.max(0, Number(margin) || 0);
  const safeGap = Math.max(0, Number(gap) || 0);
  const width = Math.max(0, Number(menuRect.width) || 0);
  const height = Math.max(0, Number(menuRect.height) || 0);
  const triggerLeft = Number(triggerRect.left) || 0;
  const triggerTop = Number(triggerRect.top) || 0;
  const triggerWidth = Math.max(0, Number(triggerRect.width) || 0);
  const triggerHeight = Math.max(0, Number(triggerRect.height) || 0);
  const maxLeft = Math.max(safeMargin, safeViewportWidth - width - safeMargin);
  const maxTop = Math.max(safeMargin, safeViewportHeight - height - safeMargin);
  if (vertical) {
    return {
      left: Math.max(safeMargin, Math.min(maxLeft, triggerLeft - width - safeGap)),
      top: Math.max(safeMargin, Math.min(maxTop, triggerTop + triggerHeight / 2 - height / 2)),
      placement: 'left',
    };
  }
  return {
    left: Math.max(safeMargin, Math.min(maxLeft, triggerLeft + triggerWidth / 2 - width / 2)),
    top: Math.max(safeMargin, Math.min(maxTop, triggerTop + triggerHeight + safeGap)),
    placement: 'below',
  };
}

export function positionHeaderToolMenu(trigger, menu, options = {}) {
  if (!trigger || !menu || !globalThis.window) return null;
  const vertical = trigger.closest?.('.header-section-vertical') !== null;
  const position = anchoredToolMenuPosition(
    trigger.getBoundingClientRect(),
    menu.getBoundingClientRect(),
    {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      vertical,
      ...options,
    },
  );
  menu.style.left = `${position.left}px`;
  menu.style.top = `${position.top}px`;
  menu.dataset.placement = position.placement;
  return position;
}

export function bindFloatingPanelBoundary(element, {
  gap = 8,
  root = globalThis.document?.documentElement,
  rightRail = null,
} = {}) {
  if (!element || !root || !globalThis.window) return { update() {}, destroy() {} };
  const update = () => {
    const minTop = floatingPanelMinimumTop(element.getBoundingClientRect(), { gap });
    const railRect = rightRail && !rightRail.hidden
      ? rightRail.getBoundingClientRect()
      : {};
    const maxRight = floatingPanelMaximumRight(railRect, {
      gap,
      viewportWidth: window.innerWidth,
    });
    root.style.setProperty(FLOATING_PANEL_MIN_TOP_PROPERTY, `${Math.ceil(minTop)}px`);
    root.style.setProperty(FLOATING_PANEL_MAX_RIGHT_PROPERTY, `${Math.floor(maxRight)}px`);
    window.dispatchEvent(new Event(FLOATING_PANEL_BOUNDARY_EVENT));
    return { minTop, maxRight };
  };
  const observer = globalThis.ResizeObserver ? new ResizeObserver(update) : null;
  observer?.observe(element);
  if (rightRail) observer?.observe(rightRail);
  window.addEventListener('resize', update);
  update();
  return {
    update,
    destroy() {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    },
  };
}

export function clampPanelPosition({ left, top, width, height }, {
  viewportWidth,
  viewportHeight,
  margin = 8,
  minTop = margin,
  maxRight = viewportWidth - margin,
} = {}) {
  const safeViewportWidth = Math.max(0, Number(viewportWidth) || 0);
  const safeViewportHeight = Math.max(0, Number(viewportHeight) || 0);
  const safeWidth = Math.max(0, Number(width) || 0);
  const safeHeight = Math.max(0, Number(height) || 0);
  const safeMargin = Math.max(0, Number(margin) || 0);
  const safeMinTop = Math.max(0, Number(minTop) || 0);
  const safeMaxRight = Math.max(safeMargin, Math.min(
    safeViewportWidth - safeMargin,
    Number(maxRight) || safeViewportWidth - safeMargin,
  ));
  const maxLeft = Math.max(safeMargin, safeMaxRight - safeWidth);
  const maxTop = Math.max(safeMinTop, safeViewportHeight - safeHeight - safeMargin);
  return {
    left: Math.max(safeMargin, Math.min(maxLeft, Number(left) || 0)),
    top: Math.max(safeMinTop, Math.min(maxTop, Number(top) || 0)),
  };
}

export function clampPanelToViewport(panel, { margin = 8, minTop = null, maxRight = null } = {}) {
  if (!panel || panel.hidden) return null;
  const rect = panel.getBoundingClientRect();
  const position = clampPanelPosition(rect, {
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    margin,
    minTop: resolvedPanelMinTop(minTop, margin),
    maxRight: resolvedPanelMaxRight(maxRight, window.innerWidth - margin),
  });
  const transform = new DOMMatrix(getComputedStyle(panel).transform);
  panel.style.transform = `translate(${transform.e + position.left - rect.left}px, ${transform.f + position.top - rect.top}px)`;
  return position;
}

export function bindFloatingPanelDrag(panel, {
  ignoreSelector = 'button, input, select, textarea, label, [contenteditable="true"]',
  margin = 8,
  minTop = null,
  maxRight = null,
} = {}) {
  let drag = null;

  const clamp = () => clampPanelToViewport(panel, { margin, minTop, maxRight });
  const pointerDown = (event) => {
    if (event.button !== 0 || event.target.closest?.(ignoreSelector)) return;
    const rect = panel.getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      rect,
      transform: new DOMMatrix(getComputedStyle(panel).transform),
    };
    panel.setPointerCapture?.(event.pointerId);
  };
  const pointerMove = (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const desired = {
      left: drag.rect.left + event.clientX - drag.startX,
      top: drag.rect.top + event.clientY - drag.startY,
      width: drag.rect.width,
      height: drag.rect.height,
    };
    const position = clampPanelPosition(desired, {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      margin,
      minTop: resolvedPanelMinTop(minTop, margin),
      maxRight: resolvedPanelMaxRight(maxRight, window.innerWidth - margin),
    });
    panel.style.transform = `translate(${drag.transform.e + position.left - drag.rect.left}px, ${drag.transform.f + position.top - drag.rect.top}px)`;
  };
  const finish = (event) => {
    if (!drag || (event?.pointerId !== undefined && drag.pointerId !== event.pointerId)) return;
    drag = null;
  };

  panel.addEventListener('pointerdown', pointerDown);
  panel.addEventListener('pointermove', pointerMove);
  panel.addEventListener('pointerup', finish);
  panel.addEventListener('pointercancel', finish);
  panel.addEventListener('lostpointercapture', finish);
  window.addEventListener('resize', clamp);
  window.addEventListener(FLOATING_PANEL_BOUNDARY_EVENT, clamp);

  return {
    clamp,
    destroy() {
      panel.removeEventListener('pointerdown', pointerDown);
      panel.removeEventListener('pointermove', pointerMove);
      panel.removeEventListener('pointerup', finish);
      panel.removeEventListener('pointercancel', finish);
      panel.removeEventListener('lostpointercapture', finish);
      window.removeEventListener('resize', clamp);
      window.removeEventListener(FLOATING_PANEL_BOUNDARY_EVENT, clamp);
    },
  };
}

export function clampTranslatedPanelOffset(panel, offset, options = {}) {
  const rect = panel.getBoundingClientRect();
  const { minTop = null, maxRight = null, ...clampOptions } = options;
  const margin = clampOptions.margin ?? 8;
  const position = clampPanelPosition(rect, {
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    ...clampOptions,
    minTop: resolvedPanelMinTop(minTop, margin),
    maxRight: resolvedPanelMaxRight(maxRight, window.innerWidth - margin),
  });
  const scaleX = panel.offsetWidth ? rect.width / panel.offsetWidth : 1;
  const scaleY = panel.offsetHeight ? rect.height / panel.offsetHeight : 1;
  return [
    Number(offset?.[0] || 0) + (position.left - rect.left) / (scaleX || 1),
    Number(offset?.[1] || 0) + (position.top - rect.top) / (scaleY || 1),
  ];
}

// --- Tool Repeat Shortcut Management ---
let repeatAction = null;

export function rememberRepeatableTool(action) {
  repeatAction = typeof action === 'function' ? action : null;
}

export function repeatLastTool() {
  return repeatAction?.() === true;
}

export function installToolRepeatShortcut(target = document) {
  const handleKeyDown = (event) => {
    if (event.code !== 'Space' || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target?.closest?.('input, textarea, select, [contenteditable="true"], .modal-backdrop')) return;
    if (!repeatLastTool()) return;
    event.preventDefault();
  };
  target.addEventListener('keydown', handleKeyDown);
  return () => target.removeEventListener('keydown', handleKeyDown);
}

export function clearRepeatableTool() {
  repeatAction = null;
}

// --- Parameter Control Widgets & UI Panel ---
const clone = (value) => JSON.parse(JSON.stringify(value));
export const CONTROL_EXTENSION_VERSION = 1;

export const controlToolTypes = Object.freeze([
  'Slider Control',
  'Checkbox',
  'Numeric Textbox',
  'Options',
  'Dropdown',
]);

const controlTypeKeys = Object.freeze({
  'Slider Control': 'horizontal-scrollbar',
  Checkbox: 'checkbox',
  'Numeric Textbox': 'numeric-textbox',
  Options: 'options',
  Dropdown: 'dropdown',
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
});

const icons = Object.freeze({
  add: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  edit: '<path d="M5 19l3.5-.7L18 8.8 15.2 6 5.7 15.5zM13.8 7.4l2.8 2.8"/>',
  remove: '<path d="M5 7h14M9 7V4h6v3m-8 0l1 13h8l1-13M10 10v7m4-7v7"/>',
  drag: '<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"/>',
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
    id: String(input.id || createStableId('panel-control')),
    controlType,
    label: String(input.label ?? ''),
    configurationExpression: String(
      input.configurationExpression
      ?? input.expression
      ?? defaultExpressions[controlType],
    ),
    selectedIndex: Math.max(0, Math.round(Number(input.selectedIndex) || 0)),
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

export function controlPanelState(item, solver) {
  const entry = currentParameter(item, solver);
  if (item.controlType === 'horizontal-scrollbar') {
    const parsed = parseMinMaxExpression(item.configurationExpression);
    if (!parsed) {
      return {
        entry,
        value: Number(entry?.value) || 0,
        valueText: displayValue(Number(entry?.value) || 0),
        minimum: 0,
        maximum: 100,
        step: 1,
        error: 'Use MinMax(minimum, maximum, initial, step).',
      };
    }
    const first = finiteScalarEvaluation(solver, parsed.minimumExpression, 0);
    const second = finiteScalarEvaluation(solver, parsed.maximumExpression, 100);
    const minimum = Math.min(first, second);
    const maximum = Math.max(first, second);
    const step = Math.abs(finiteScalarEvaluation(solver, parsed.stepExpression, 1)) || 1;
    const raw = Number(entry?.value);
    const value = Math.max(minimum, Math.min(maximum, Number.isFinite(raw) ? raw : minimum));
    return {
      entry,
      value,
      valueText: displayValue(value),
      minimum,
      maximum,
      step,
      error: entry?.error || null,
    };
  }
  if (item.controlType === 'checkbox') {
    return { entry, value: Boolean(entry?.value), error: entry?.error || null };
  }
  if (item.controlType === 'numeric-textbox') {
    const value = Number(entry?.value);
    return {
      entry,
      value: Number.isFinite(value) ? value : 0,
      error: entry?.error || null,
    };
  }
  const resolved = resolveControlChoices(item, solver);
  const maximumIndex = Math.max(0, resolved.choices.length - 1);
  return {
    entry,
    choices: resolved.choices,
    selectedIndex: Math.min(item.selectedIndex, maximumIndex),
    value: entry?.value,
    error: resolved.error || entry?.error || null,
  };
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
  if (item.controlType === 'checkbox') return value ? 'TRUE' : 'FALSE';
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

  function add(controlType, input = {}) {
    const item = createControlItem(controlType, input);
    ensureParameter(item);
    items.push(item);
    emit('add');
    return clone(item);
  }

  function remove(id) {
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const [removed] = items.splice(index, 1);
    if (removed.parameterId) solver.removeParameter(removed.parameterId);
    emit('remove');
    return true;
  }

  function reorder(id, targetIndex) {
    const currentIndex = items.findIndex((item) => item.id === id);
    if (currentIndex < 0) return false;
    const bounded = Math.max(0, Math.min(items.length - 1, Number(targetIndex) || 0));
    if (bounded === currentIndex) return false;
    const [item] = items.splice(currentIndex, 1);
    items.splice(bounded, 0, item);
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
          item.configurationExpression = item.configurationExpression.replace(
            new RegExp(`\\b${escaped}\\b`, 'g'),
            after,
          );
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
    setLabel,
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
        min="${escapeHtml(state.minimum)}" max="${escapeHtml(state.maximum)}" step="any"
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

export function controlRowMarkup(item, state, editing) {
  const error = state.error || '';
  return `<article class="panel-control-row${error ? ' invalid' : ''}" data-control-id="${escapeHtml(item.id)}">
    <div class="panel-control-row-heading">
      ${editing ? `<button type="button" class="control-row-drag-handle" title="Drag to reorder" aria-label="Drag ${escapeHtml(item.parameterName)} to reorder">${svgIcon('drag')}</button>` : ''}
      ${editing
        ? `<input class="panel-control-label-input" data-control-label value="${escapeHtml(item.label)}" placeholder="Control label" aria-label="${escapeHtml(item.parameterName)} label" />`
        : `<span class="panel-control-label">${escapeHtml(item.label)}</span>`}
      <span class="panel-control-parameter">${escapeHtml(item.parameterName)}</span>
      ${editing ? `<button type="button" class="panel-control-remove" data-control-remove title="Remove control" aria-label="Remove ${escapeHtml(item.parameterName)}">${svgIcon('remove')}</button>` : ''}
    </div>
    <div class="panel-control-runtime">${controlRuntimeMarkup(item, state)}</div>
    ${editing ? `<label class="panel-control-expression">
      <span>Expression</span>
      <input data-control-expression list="controlPanelParameterNames" autocomplete="off" spellcheck="false"
        value="${escapeHtml(item.configurationExpression)}"
        placeholder="${item.controlType === 'horizontal-scrollbar' ? 'MinMax(0, 100, 50, 1)' : item.controlType === 'options' || item.controlType === 'dropdown' ? '{dog|cat|house}' : 'Expression'}"
        aria-invalid="${error ? 'true' : 'false'}" />
    </label>
    <p class="panel-control-error" role="alert" ${error ? '' : 'hidden'}>${escapeHtml(error)}</p>` : ''}
  </article>`;
}

export function createControlTools({
  toolbar,
  canvas,
  solver,
  host = document.querySelector('.app-shell') || document.body,
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
  const pendingControlUpdates = new Map();
  const latestControlUpdateRevisions = new Map();

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
    <datalist id="controlPanelParameterNames"></datalist>
  `;
  host.append(panel);

  const list = panel.querySelector('[data-controls-list]');
  const actions = panel.querySelector('.controls-panel-actions');
  const editButton = panel.querySelector('[data-controls-edit]');
  const addSelect = panel.querySelector('[data-control-add]');
  const parameterNames = panel.querySelector('#controlPanelParameterNames');
  const panelDragController = bindFloatingPanelDrag(panel, {
    ignoreSelector: 'button, input, select, textarea, label, .controls-list',
  });

  function setVisible(visible) {
    panel.hidden = !visible;
    if (visible) {
      render();
      panelDragController.clamp();
    }
    button?.classList.toggle('active', visible);
    button?.setAttribute('aria-pressed', String(visible));
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
    canvas.applySolverSnapshot?.(outcome?.snapshot);
    canvas.notifyObjectChange?.({ history });
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
    const errorElement = row.querySelector('.panel-control-error');
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
      const slider = row.querySelector('.panel-control-scrollbar');
      const input = row.querySelector('.panel-control-slider-value');
      if (slider) slider.value = committedValue;
      if (input) input.value = committedValue;
    };
    if (applied?.then) applied.then(syncCommittedValue);
    else syncCommittedValue();
    return applied;
  }

  function refreshParameterNames() {
    parameterNames.innerHTML = solver.parameters()
      .map(({ name }) => `<option value="${escapeHtml(name)}"></option>`)
      .join('');
  }

  function render() {
    refreshParameterNames();
    const items = model.list();
    list.innerHTML = items.length
      ? items.map((item) => controlRowMarkup(item, controlPanelState(item, solver), editing)).join('')
      : `<p class="controls-empty-state">${editing ? 'Use Add control to build this userform.' : 'No controls have been added.'}</p>`;
  }

  function syncRuntimeControls() {
    refreshParameterNames();
    model.list().forEach((item) => {
      const row = list.querySelector(`[data-control-id="${CSS.escape(item.id)}"]`);
      if (!row) return;
      const state = controlPanelState(item, solver);
      const parameter = row.querySelector('.panel-control-parameter');
      if (parameter) parameter.textContent = state.entry?.name || item.parameterName;
      row.classList.toggle('invalid', Boolean(state.error));
      const error = row.querySelector('.panel-control-error');
      if (error) {
        error.hidden = !state.error;
        error.textContent = state.error || '';
      }
      const expression = row.querySelector('[data-control-expression]');
      if (expression && document.activeElement !== expression) {
        expression.value = item.configurationExpression;
        expression.setAttribute('aria-invalid', String(Boolean(state.error)));
      }
      if (item.controlType === 'horizontal-scrollbar') {
        const slider = row.querySelector('.panel-control-scrollbar');
        const valueInput = row.querySelector('.panel-control-slider-value');
        if (slider && document.activeElement !== slider) {
          slider.min = String(state.minimum);
          slider.max = String(state.maximum);
          slider.step = String(state.step);
          slider.value = String(state.value);
        }
        if (valueInput && document.activeElement !== valueInput) {
          valueInput.min = String(state.minimum);
          valueInput.max = String(state.maximum);
          valueInput.step = 'any';
          valueInput.value = String(state.value);
        }
      } else if (item.controlType === 'checkbox') {
        const input = row.querySelector('[data-control-value]');
        if (input) input.checked = state.value;
      } else if (item.controlType === 'numeric-textbox') {
        const input = row.querySelector('[data-control-value]');
        if (input && document.activeElement !== input) input.value = String(state.value);
      } else {
        const controls = [...row.querySelectorAll('[data-control-value]')];
        if (controls.length !== state.choices.length) {
          row.querySelector('.panel-control-runtime').innerHTML = controlRuntimeMarkup(item, state);
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
    if (!row || !event.target.closest('[data-control-remove]')) return;
    beginMutation('remove');
    model.remove(row.dataset.controlId);
    render();
    notifyMutation('remove');
  });

  list.addEventListener('focusin', (event) => {
    const field = event.target.closest?.('[data-control-label], [data-control-expression]');
    const row = field?.closest('[data-control-id]');
    if (!field || !row) return;
    const key = `${row.dataset.controlId}:${field.hasAttribute('data-control-label') ? 'label' : 'expression'}`;
    if (activeEdit !== key) {
      beginMutation(field.hasAttribute('data-control-label') ? 'label' : 'expression');
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
    if (event.target.matches('[data-control-expression]')) {
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
        const input = row.querySelector('.panel-control-slider-value');
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
      moved: false,
      targetId: row.dataset.controlId,
      after: false,
    };
    handle.setPointerCapture?.(event.pointerId);
  });

  list.addEventListener('pointermove', (event) => {
    if (!rowDrag || rowDrag.pointerId !== event.pointerId) return;
    if (!rowDrag.moved && Math.abs(event.clientY - rowDrag.startY) < 5) return;
    rowDrag.moved = true;
    event.preventDefault();
    list.querySelectorAll('.drop-before, .drop-after').forEach((row) => row.classList.remove('drop-before', 'drop-after'));
    rowDrag.row.classList.add('dragging');
    const candidates = [...list.querySelectorAll('[data-control-id]')]
      .filter((row) => row.dataset.controlId !== rowDrag.id);
    const target = candidates.find((row) => {
      const bounds = row.getBoundingClientRect();
      return event.clientY >= bounds.top && event.clientY <= bounds.bottom;
    }) || (event.clientY < rowDrag.row.getBoundingClientRect().top ? candidates[0] : candidates[candidates.length - 1]);
    if (!target) return;
    const bounds = target.getBoundingClientRect();
    rowDrag.targetId = target.dataset.controlId;
    rowDrag.after = event.clientY >= bounds.top + bounds.height / 2;
    target.classList.add(rowDrag.after ? 'drop-after' : 'drop-before');
  });

  function finishRowDrag(event, cancelled = false) {
    if (!rowDrag || rowDrag.pointerId !== event.pointerId) return;
    const completed = rowDrag;
    rowDrag = null;
    list.querySelectorAll('.dragging, .drop-before, .drop-after').forEach((row) => row.classList.remove('dragging', 'drop-before', 'drop-after'));
    if (cancelled || !completed.moved) return;
    const ids = model.list().map(({ id }) => id).filter((id) => id !== completed.id);
    let index = ids.indexOf(completed.targetId);
    if (index < 0) index = ids.length;
    else if (completed.after) index += 1;
    model.reorder(completed.id, index);
    suppressClick = true;
    render();
    notifyMutation('reorder');
    setTimeout(() => { suppressClick = false; }, 0);
  }

  list.addEventListener('pointerup', (event) => finishRowDrag(event));
  list.addEventListener('pointercancel', (event) => finishRowDrag(event, true));

  const stopSolverSubscription = solver.subscribe((parameters) => {
    model.synchronizeParameters(parameters);
    if (!panel.hidden) syncRuntimeControls();
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
      stopSolverSubscription?.();
      unregisterExtension?.();
      panelDragController.destroy();
      panel.remove();
    },
  };
}
