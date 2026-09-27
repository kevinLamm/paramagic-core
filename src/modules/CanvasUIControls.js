import { constraintAvailableInStackContext } from './StackTransformPolicy.js';
export * from './ControlTools.js';

// --- Floating Panel Positioning & Drag Utilities ---
const FLOATING_PANEL_MIN_TOP_PROPERTY = '--floating-panel-min-top';
const FLOATING_PANEL_MIN_LEFT_PROPERTY = '--floating-panel-min-left';
const FLOATING_PANEL_MAX_RIGHT_PROPERTY = '--floating-panel-max-right';
const FLOATING_PANEL_BOUNDARY_EVENT = 'paramagic:floating-panel-boundary-change';
const TOOLBAR_CONTENT_RESIZE_EVENT = 'paramagic:toolbar-content-resize';
const TOOL_HEADER_DENSITIES = Object.freeze([
  { size: 40, iconBox: 38, iconSize: 30, toolGap: 3, sectionGap: 7 },
  { size: 36, iconBox: 34, iconSize: 27, toolGap: 2, sectionGap: 5 },
  { size: 32, iconBox: 30, iconSize: 24, toolGap: 2, sectionGap: 4 },
]);

export function setActiveStackToolAvailability(root, activeStackId) {
  const available = Boolean(activeStackId);
  const controls = [...(root?.querySelectorAll?.(
    '[data-drawing-tool], [data-requires-active-stack]',
  ) || [])];
  controls.forEach((control) => {
    control.disabled = !available;
    if (!available && control.hasAttribute?.('aria-expanded')) {
      control.setAttribute('aria-expanded', 'false');
    }
  });
  for (const control of root?.querySelectorAll?.('[data-constraint]') || []) {
    control.disabled = !constraintAvailableInStackContext(control.dataset?.constraint, activeStackId);
  }
  if (!available) {
    [...(root?.querySelectorAll?.('.menu-tool.open, .constraint-menu.open') || [])]
      .forEach((menu) => menu.classList.remove('open'));
  }
  return { available, controls };
}

export function floatingPanelMinimumTop(rect = {}, { gap = 8 } = {}) {
  return Math.max(0, Number(rect.bottom) || 0) + Math.max(0, Number(gap) || 0);
}

export function floatingPanelMinimumLeft(rect = {}, { gap = 8 } = {}) {
  return Math.max(0, Number(rect.right) || 0) + Math.max(0, Number(gap) || 0);
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

function configuredPanelMinLeft(fallback = 8) {
  if (!globalThis.document || !globalThis.getComputedStyle) return fallback;
  const value = Number.parseFloat(getComputedStyle(document.documentElement)
    .getPropertyValue(FLOATING_PANEL_MIN_LEFT_PROPERTY));
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

function resolvedPanelMinLeft(minLeft, fallback) {
  if (typeof minLeft === 'function') return Number(minLeft()) || fallback;
  if (minLeft !== null && minLeft !== undefined) return Number(minLeft) || fallback;
  return configuredPanelMinLeft(fallback);
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
  leftSidebar = null,
  rightRail = null,
} = {}) {
  if (!element || !root || !globalThis.window) return { update() {}, destroy() {} };
  const update = () => {
    const minTop = floatingPanelMinimumTop(element.getBoundingClientRect(), { gap });
    const sidebarRect = leftSidebar && !leftSidebar.hidden
      ? leftSidebar.getBoundingClientRect()
      : {};
    const minLeft = floatingPanelMinimumLeft(sidebarRect, { gap });
    const railRect = rightRail && !rightRail.hidden
      ? rightRail.getBoundingClientRect()
      : {};
    const maxRight = floatingPanelMaximumRight(railRect, {
      gap,
      viewportWidth: window.innerWidth,
    });
    root.style.setProperty(FLOATING_PANEL_MIN_TOP_PROPERTY, `${Math.ceil(minTop)}px`);
    root.style.setProperty(FLOATING_PANEL_MIN_LEFT_PROPERTY, `${Math.ceil(minLeft)}px`);
    root.style.setProperty(FLOATING_PANEL_MAX_RIGHT_PROPERTY, `${Math.floor(maxRight)}px`);
    window.dispatchEvent(new Event(FLOATING_PANEL_BOUNDARY_EVENT));
    return { minTop, minLeft, maxRight };
  };
  const observer = globalThis.ResizeObserver ? new ResizeObserver(update) : null;
  observer?.observe(element);
  if (leftSidebar) observer?.observe(leftSidebar);
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
  minLeft = margin,
  minTop = margin,
  maxRight = viewportWidth - margin,
} = {}) {
  const safeViewportWidth = Math.max(0, Number(viewportWidth) || 0);
  const safeViewportHeight = Math.max(0, Number(viewportHeight) || 0);
  const safeWidth = Math.max(0, Number(width) || 0);
  const safeHeight = Math.max(0, Number(height) || 0);
  const safeMargin = Math.max(0, Number(margin) || 0);
  const safeMinLeft = Math.max(safeMargin, Math.min(
    safeViewportWidth - safeMargin,
    Number(minLeft) || safeMargin,
  ));
  const safeMinTop = Math.max(0, Number(minTop) || 0);
  const safeMaxRight = Math.max(safeMinLeft, Math.min(
    safeViewportWidth - safeMargin,
    Number(maxRight) || safeViewportWidth - safeMargin,
  ));
  const maxLeft = Math.max(safeMinLeft, safeMaxRight - safeWidth);
  const maxTop = Math.max(safeMinTop, safeViewportHeight - safeHeight - safeMargin);
  return {
    left: Math.max(safeMinLeft, Math.min(maxLeft, Number(left) || 0)),
    top: Math.max(safeMinTop, Math.min(maxTop, Number(top) || 0)),
  };
}

export function clampPanelToViewport(panel, {
  margin = 8,
  minLeft = null,
  minTop = null,
  maxRight = null,
} = {}) {
  if (!panel || panel.hidden || panel.closest?.('[data-dock-panel]')) return null;
  const rect = panel.getBoundingClientRect();
  const position = clampPanelPosition(rect, {
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    margin,
    minLeft: resolvedPanelMinLeft(minLeft, margin),
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
  minLeft = null,
  minTop = null,
  maxRight = null,
} = {}) {
  let drag = null;

  const clamp = () => clampPanelToViewport(panel, {
    margin,
    minLeft,
    minTop,
    maxRight,
  });
  const pointerDown = (event) => {
    if (panel.closest?.('[data-dock-panel]')) return;
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
      minLeft: resolvedPanelMinLeft(minLeft, margin),
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
  const {
    minLeft = null,
    minTop = null,
    maxRight = null,
    ...clampOptions
  } = options;
  const margin = clampOptions.margin ?? 8;
  const position = clampPanelPosition(rect, {
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    ...clampOptions,
    minLeft: resolvedPanelMinLeft(minLeft, margin),
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
