export const PANEL_DOCK_STORAGE_KEY = 'paramagic.panel-dock.v1';
export const PANEL_DOCK_IDS = ['stacks', 'controls', 'properties'];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function normalizePanelDockLayout(saved = {}) {
  if (!saved || typeof saved !== 'object') saved = {};
  const order = [...new Set([...(Array.isArray(saved.order) ? saved.order : []), ...PANEL_DOCK_IDS])]
    .filter(id => PANEL_DOCK_IDS.includes(id));
  return {
    version: 1,
    width: clamp(finite(saved.width, 300), 240, 520),
    order,
    panels: Object.fromEntries(PANEL_DOCK_IDS.map(id => {
      const panel = saved.panels?.[id] || {};
      return [id, {
        visible: panel.visible !== false,
        collapsed: panel.collapsed === true,
        floating: panel.floating === true,
        weight: clamp(finite(panel.weight, id === 'stacks' ? 1.4 : 1), 0.05, 10000),
        x: finite(panel.x, 340), y: finite(panel.y, 90),
        width: clamp(finite(panel.width, 340), 240, 800),
        height: clamp(finite(panel.height, 420), 120, 1200),
      }];
    })),
  };
}

export function reorderDockPanel(order, id, beforeId = null) {
  if (!order.includes(id) || id === beforeId) return [...order];
  const next = order.filter(item => item !== id);
  const index = next.indexOf(beforeId);
  next.splice(index < 0 ? next.length : index, 0, id);
  return next;
}

export function resizeDockPair(first, second, delta, minimum = 108) {
  const total = first + second;
  const lower = Math.min(minimum, total / 2);
  const next = clamp(first + delta, lower, total - lower);
  return [next, total - next];
}

export function createPanelDock({ host, panels, storage = globalThis.localStorage }) {
  const documentRef = host.ownerDocument;
  const view = documentRef.defaultView;
  let saved;
  try { saved = JSON.parse(storage?.getItem(PANEL_DOCK_STORAGE_KEY) || 'null'); } catch { /* Use defaults when storage is unavailable. */ }
  let layout = normalizePanelDockLayout(saved);
  const entries = new Map();
  const cleanups = [];
  let gesture = null;
  let resizeFrame = null;
  const listen = (target, name, callback, options) => {
    target.addEventListener(name, callback, options);
    cleanups.push(() => target.removeEventListener(name, callback, options));
  };
  const save = () => {
    try { storage?.setItem(PANEL_DOCK_STORAGE_KEY, JSON.stringify(layout)); } catch { /* Layout remains usable without persistence. */ }
  };
  const notifyResize = () => {
    if (resizeFrame !== null) return;
    resizeFrame = view.requestAnimationFrame(() => { resizeFrame = null; view.dispatchEvent(new Event('resize')); });
  };
  const button = (label, text, className) => {
    const element = documentRef.createElement('button');
    element.type = 'button'; element.title = label; element.setAttribute('aria-label', label);
    element.className = className; element.textContent = text;
    return element;
  };
  host.className = 'panel-dock';
  host.setAttribute('aria-label', 'Side panels');
  host.dataset.preserveFeatureSelection = '';
  const toolbar = documentRef.createElement('div');
  toolbar.className = 'panel-dock-toggles'; toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', 'Show panels');
  const body = documentRef.createElement('div'); body.className = 'panel-dock-body';
  const widthHandle = documentRef.createElement('div'); widthHandle.className = 'panel-dock-width-handle';
  widthHandle.tabIndex = 0; widthHandle.setAttribute('role', 'separator'); widthHandle.setAttribute('aria-orientation', 'vertical');
  widthHandle.setAttribute('aria-label', 'Resize side panel width');
  const marker = documentRef.createElement('div'); marker.className = 'panel-dock-drop-marker'; marker.hidden = true;
  const ghost = documentRef.createElement('div'); ghost.className = 'panel-dock-drag-label'; ghost.hidden = true;
  documentRef.body.append(marker, ghost);
  // Keep the existing content elements and their listeners when moving panels.
  host.append(toolbar, body, widthHandle);

  const dockedIds = () => layout.order.filter(id => layout.panels[id].visible && !layout.panels[id].floating);
  const fitFloating = id => {
    const state = layout.panels[id];
    const top = parseFloat(view.getComputedStyle(documentRef.documentElement).getPropertyValue('--workspace-top')) || 52;
    const width = Math.min(state.width, Math.max(200, view.innerWidth - 16));
    const height = state.collapsed ? 32 : Math.min(state.height, Math.max(108, view.innerHeight - top - 16));
    const x = clamp(state.x, 8, Math.max(8, view.innerWidth - width - 8));
    const y = clamp(state.y, top + 4, Math.max(top + 4, view.innerHeight - height - 8));
    Object.assign(entries.get(id).section.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
  };
  const applySizes = () => {
    for (const id of dockedIds()) {
      const { section } = entries.get(id);
      section.style.flex = layout.panels[id].collapsed ? '0 0 32px' : `${layout.panels[id].weight} 1 0px`;
    }
    body.querySelectorAll('.panel-dock-divider').forEach(divider => {
      const first = layout.panels[divider.dataset.before].weight;
      const second = layout.panels[divider.dataset.after].weight;
      divider.setAttribute('aria-valuenow', String(Math.round(100 * first / (first + second))));
    });
  };
  const render = () => {
    const visibleIds = dockedIds();
    host.classList.toggle('empty', visibleIds.length === 0);
    const width = visibleIds.length ? Math.min(layout.width, Math.max(240, view.innerWidth - 180)) : 40;
    documentRef.documentElement.style.setProperty('--stack-sidebar-width', `${width}px`);
    host.style.width = `${width}px`;
    widthHandle.hidden = !visibleIds.length;
    widthHandle.setAttribute('aria-valuenow', String(Math.round(width)));
    widthHandle.setAttribute('aria-valuemin', '240'); widthHandle.setAttribute('aria-valuemax', '520');
    body.querySelectorAll('.panel-dock-divider').forEach(node => node.remove());
    for (const id of layout.order) {
      const entry = entries.get(id), state = layout.panels[id];
      entry.section.hidden = !state.visible;
      entry.section.classList.toggle('floating', state.floating);
      entry.section.classList.toggle('collapsed', state.collapsed);
      entry.collapse.setAttribute('aria-expanded', String(!state.collapsed));
      entry.collapse.textContent = `${state.collapsed ? '▸' : '▾'} ${entry.label}`;
      entry.toggle.classList.toggle('active', state.visible);
      entry.toggle.setAttribute('aria-pressed', String(state.visible));
      const parent = state.floating ? documentRef.body : body;
      if (entry.section.parentElement !== parent) parent.append(entry.section);
      if (state.floating) fitFloating(id);
      else {
        for (const property of ['left', 'top', 'width', 'height']) entry.section.style.removeProperty(property);
        body.append(entry.section);
      }
    }
    visibleIds.slice(0, -1).forEach((id, index) => {
      const nextId = visibleIds[index + 1];
      const divider = documentRef.createElement('div'); divider.className = 'panel-dock-divider'; divider.tabIndex = 0;
      divider.dataset.before = id; divider.dataset.after = nextId;
      divider.setAttribute('role', 'separator'); divider.setAttribute('aria-orientation', 'horizontal');
      divider.setAttribute('aria-label', `Resize ${entries.get(id).label} and ${entries.get(nextId).label}`);
      divider.setAttribute('aria-valuemin', '0'); divider.setAttribute('aria-valuemax', '100');
      const sum = layout.panels[id].weight + layout.panels[nextId].weight;
      divider.setAttribute('aria-valuenow', String(Math.round(100 * layout.panels[id].weight / sum)));
      divider.classList.toggle('disabled', layout.panels[id].collapsed || layout.panels[nextId].collapsed);
      divider.setAttribute('aria-disabled', String(divider.classList.contains('disabled')));
      entries.get(id).section.after(divider);
    });
    applySizes(); notifyResize();
  };
  const reflectVisibility = (id, visible) => {
    if (!entries.has(id) || layout.panels[id].visible === Boolean(visible)) return;
    layout.panels[id].visible = Boolean(visible); render(); save();
  };
  const setVisible = (id, visible) => {
    const entry = entries.get(id); if (!entry) return;
    layout.panels[id].visible = Boolean(visible);
    if (entry.setVisible) entry.setVisible(Boolean(visible)); else entry.content.hidden = !visible;
    render(); save();
  };
  const setFloating = (id, floating, point = null) => {
    const state = layout.panels[id]; state.floating = Boolean(floating);
    if (point) { state.x = point.x; state.y = point.y; }
    render(); save();
  };
  const reorder = (id, beforeId) => { layout.order = reorderDockPanel(layout.order, id, beforeId); render(); save(); };

  for (const spec of panels) {
    const { id, label, content } = spec;
    const toggle = spec.toggle || button(label, '', 'icon-button');
    toggle.classList.add('panel-dock-toggle'); toggle.dataset.dockToggle = id;
    toggle.title = label; toggle.setAttribute('aria-label', label); toggle.setAttribute('aria-controls', `dock-panel-${id}`);
    if (!spec.toggle) toggle.innerHTML = spec.iconMarkup || '';
    const labelNode = documentRef.createElement('span'); labelNode.className = 'panel-dock-toggle-label'; labelNode.textContent = label;
    toggle.append(labelNode); toolbar.append(toggle);
    const section = documentRef.createElement('section'); section.className = 'dock-panel'; section.dataset.dockPanel = id;
    section.id = `dock-panel-${id}`; section.setAttribute('aria-label', `${label} panel`); section.dataset.preserveFeatureSelection = '';
    const header = documentRef.createElement('div'); header.className = 'dock-panel-header';
    const grip = button(`Move ${label} panel (Alt+Up or Alt+Down to reorder, Alt+F to float or dock)`, '⠿', 'dock-panel-grip'); grip.dataset.dockGrip = id;
    const collapse = button(`Collapse or expand ${label}`, label, 'dock-panel-title');
    const close = button(`Hide ${label}`, '×', 'dock-panel-action');
    header.append(grip, collapse);
    if (spec.actions) header.append(spec.actions);
    header.append(close);
    const container = documentRef.createElement('div'); container.className = 'dock-panel-content'; container.append(content);
    const floatResize = documentRef.createElement('div'); floatResize.className = 'dock-panel-float-resize'; floatResize.dataset.floatResize = id;
    floatResize.setAttribute('role', 'separator'); floatResize.setAttribute('aria-label', `Resize floating ${label}`); floatResize.tabIndex = 0;
    section.append(header, container, floatResize); body.append(section);
    entries.set(id, { ...spec, section, toggle, collapse });
    listen(section, 'pointerdown', () => {
      if (!layout.panels[id].floating) return;
      entries.forEach(entry => entry.section.classList.toggle('front', entry.section === section));
    }, true);
    if (!spec.toggle) listen(toggle, 'click', () => setVisible(id, !layout.panels[id].visible));
    listen(close, 'click', () => setVisible(id, false));
    listen(collapse, 'click', () => { layout.panels[id].collapsed = !layout.panels[id].collapsed; render(); save(); });
    listen(grip, 'keydown', event => {
      if (event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault(); event.stopPropagation();
        setFloating(id, !layout.panels[id].floating); grip.focus(); return;
      }
      if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const index = layout.order.indexOf(id);
      if (event.key === 'ArrowUp' && index > 0) reorder(id, layout.order[index - 1]);
      if (event.key === 'ArrowDown' && index < layout.order.length - 1) reorder(id, layout.order[index + 2]);
      grip.focus();
    });
    listen(grip, 'pointerdown', event => startGesture(event, { type: 'move', id, rect: section.getBoundingClientRect() }));
    listen(floatResize, 'pointerdown', event => startGesture(event, { type: 'float-size', id, rect: section.getBoundingClientRect() }));
    listen(floatResize, 'keydown', event => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const state = layout.panels[id];
      state.width = clamp(state.width + (event.key === 'ArrowRight' ? 16 : event.key === 'ArrowLeft' ? -16 : 0), 240, 800);
      state.height = clamp(state.height + (event.key === 'ArrowDown' ? 16 : event.key === 'ArrowUp' ? -16 : 0), 120, 1200);
      fitFloating(id); save();
    });
  }
  function startGesture(event, details) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    gesture = { ...details, startX: event.clientX, startY: event.clientY, pointerId: event.pointerId, capture: event.currentTarget, original: structuredClone(layout) };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    documentRef.documentElement.classList.add('panel-dock-dragging');
  }
  const captureHeights = () => {
    for (const id of dockedIds()) if (!layout.panels[id].collapsed) layout.panels[id].weight = entries.get(id).section.getBoundingClientRect().height;
  };
  listen(widthHandle, 'pointerdown', event => startGesture(event, { type: 'width', width: layout.width }));
  listen(widthHandle, 'keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); layout.width = clamp(layout.width + (event.key === 'ArrowRight' ? 12 : -12), 240, 520); render(); save();
  });
  listen(body, 'pointerdown', event => {
    const divider = event.target.closest('.panel-dock-divider');
    if (!divider || divider.classList.contains('disabled')) return;
    captureHeights();
    startGesture(event, { type: 'height', first: divider.dataset.before, second: divider.dataset.after });
  });
  listen(body, 'keydown', event => {
    const divider = event.target.closest('.panel-dock-divider');
    if (!divider || divider.classList.contains('disabled') || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); captureHeights();
    const first = layout.panels[divider.dataset.before], second = layout.panels[divider.dataset.after];
    [first.weight, second.weight] = resizeDockPair(first.weight, second.weight, event.key === 'ArrowDown' ? 16 : -16);
    applySizes(); save(); notifyResize();
  });
  const dropTarget = (x, y, id) => {
    const bounds = host.getBoundingClientRect();
    if (x < bounds.left || x > bounds.right + 24 || y < bounds.top || y > bounds.bottom) return null;
    const candidates = dockedIds().filter(other => other !== id);
    const before = candidates.find(other => { const rect = entries.get(other).section.getBoundingClientRect(); return y < rect.top + rect.height / 2; });
    const markerY = before ? entries.get(before).section.getBoundingClientRect().top : candidates.length ? entries.get(candidates.at(-1)).section.getBoundingClientRect().bottom : bounds.top + 38;
    return { before, bounds, markerY };
  };
  listen(view, 'pointermove', event => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.startX, dy = event.clientY - gesture.startY;
    if (gesture.type === 'width') { layout.width = clamp(gesture.width + dx, 240, 520); render(); }
    if (gesture.type === 'height') {
      const original = gesture.original.panels;
      [layout.panels[gesture.first].weight, layout.panels[gesture.second].weight] = resizeDockPair(original[gesture.first].weight, original[gesture.second].weight, dy);
      applySizes(); notifyResize();
    }
    if (gesture.type === 'float-size') {
      Object.assign(layout.panels[gesture.id], { width: clamp(gesture.rect.width + dx, 240, 800), height: clamp(gesture.rect.height + dy, 120, 1200) });
      fitFloating(gesture.id);
    }
    if (gesture.type === 'move' && Math.hypot(dx, dy) > 5) {
      gesture.moved = true;
      const target = dropTarget(event.clientX, event.clientY, gesture.id);
      ghost.hidden = false; ghost.textContent = `${entries.get(gesture.id).label} · ${target ? 'Dock here' : 'Float panel'}`;
      ghost.style.left = `${event.clientX + 12}px`; ghost.style.top = `${event.clientY + 12}px`;
      marker.hidden = !target;
      if (target) Object.assign(marker.style, { left: `${target.bounds.left}px`, top: `${target.markerY}px`, width: `${Math.max(target.bounds.width, 100)}px` });
    }
  });
  const finishGesture = (event, cancel = false) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const current = gesture; gesture = null;
    current.capture.releasePointerCapture?.(event.pointerId);
    if (cancel) layout = current.original;
    else if (current.type === 'move' && current.moved) {
      const target = dropTarget(event.clientX, event.clientY, current.id);
      const state = layout.panels[current.id];
      state.floating = !target;
      if (target) layout.order = reorderDockPanel(layout.order, current.id, target.before);
      else { state.x = event.clientX - Math.min(80, event.clientX - current.rect.left); state.y = event.clientY - 16; }
    }
    marker.hidden = true; ghost.hidden = true;
    documentRef.documentElement.classList.remove('panel-dock-dragging');
    render(); save();
  };
  listen(view, 'pointerup', event => finishGesture(event));
  listen(view, 'pointercancel', event => finishGesture(event, true));
  listen(view, 'keydown', event => {
    if (!gesture || event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation(); finishGesture({ pointerId: gesture.pointerId }, true);
  }, true);
  listen(view, 'resize', () => {
    for (const id of layout.order) if (layout.panels[id].floating) fitFloating(id);
  });
  for (const { id } of panels) {
    const entry = entries.get(id);
    if (entry.setVisible) entry.setVisible(layout.panels[id].visible); else entry.content.hidden = !layout.panels[id].visible;
  }
  render();
  return {
    setVisible, reflectVisibility, setFloating, reorder,
    getLayout: () => structuredClone(layout),
    destroy() {
      cleanups.forEach(cleanup => cleanup());
      if (resizeFrame !== null) view.cancelAnimationFrame(resizeFrame);
      marker.remove(); ghost.remove();
    },
  };
}
