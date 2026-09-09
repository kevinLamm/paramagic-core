import { canvasPointHandleHitDistance } from './CanvasSelection.js';

// --- Canvas Zoom Constraints ---
export const MIN_CANVAS_ZOOM = 0.005;
export const MAX_CANVAS_ZOOM = 32;

export function bindCanvasKeyboardFocus(canvas) {
  canvas.tabIndex = -1;
  const focusCanvas = (event) => {
    if (event.button !== 0 || event.target.closest?.('input, textarea, select, button, [contenteditable], [data-canvas-ui]')) return;
    canvas.focus({ preventScroll: true });
  };
  // Run before geometry drag handlers prevent the browser's default focus change.
  canvas.addEventListener('pointerdown', focusCanvas, true);
  return () => canvas.removeEventListener('pointerdown', focusCanvas, true);
}

export function rotateViewPoint([x, y], rotation = 0) {
  const c = Math.cos(rotation), s = Math.sin(rotation);
  return [c * x - s * y, s * x + c * y];
}

export function cameraWorldToScreen(camera, point) {
  const [x, y] = rotateViewPoint(point, camera.rotation || 0);
  return [x * camera.scale + camera.x, y * camera.scale + camera.y];
}

export function cameraScreenToWorld(camera, point) {
  return rotateViewPoint([(point[0] - camera.x) / camera.scale, (point[1] - camera.y) / camera.scale], -(camera.rotation || 0));
}

export function rotateCameraAt(camera, rotation, screenPoint) {
  const world = cameraScreenToWorld(camera, screenPoint);
  const next = { ...camera, rotation };
  const projected = cameraWorldToScreen(next, world);
  next.x += screenPoint[0] - projected[0];
  next.y += screenPoint[1] - projected[1];
  return next;
}

export function scaleCameraAt(camera, scale, screenPoint) {
  const world = cameraScreenToWorld(camera, screenPoint);
  const next = { ...camera, scale: clampCanvasZoom(scale) };
  const projected = cameraWorldToScreen(next, world);
  next.x += screenPoint[0] - projected[0];
  next.y += screenPoint[1] - projected[1];
  return next;
}

export function cameraViewportBounds(camera, width, height) {
  const corners = [[0, 0], [width, 0], [width, height], [0, height]]
    .map((point) => cameraScreenToWorld(camera, point));
  return { left: Math.min(...corners.map(p => p[0])), right: Math.max(...corners.map(p => p[0])),
    top: Math.min(...corners.map(p => p[1])), bottom: Math.max(...corners.map(p => p[1])) };
}

export function fitCameraBounds(camera, bounds, width, height) {
  const corners = [[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y],
    [bounds.x + bounds.width, bounds.y + bounds.height], [bounds.x, bounds.y + bounds.height]]
    .map(point => rotateViewPoint(point, camera.rotation || 0));
  const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  const scale = clampCanvasZoom(Math.min(width / (right - left), height / (bottom - top)) * 0.9);
  return { ...camera, scale, x: width / 2 - (left + right) * scale / 2, y: height / 2 - (top + bottom) * scale / 2 };
}

export function clampCanvasZoom(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested)) return 1;
  return Math.min(MAX_CANVAS_ZOOM, Math.max(MIN_CANVAS_ZOOM, requested));
}

// --- Overlap Selection Cycler ---
const candidateKey = (candidate) => candidate.kind === 'handle'
  ? `handle:${candidate.recordId}:${candidate.handleIndex}`
  : `stroke:${candidate.recordId}:${candidate.segmentIndex ?? 'entity'}`;

export function advanceOverlapCycle(previous, candidates, point, tolerance = 8, direction = 1) {
  const keys = candidates.map(candidateKey);
  const samePoint = previous
    && Math.hypot(previous.x - point.x, previous.y - point.y) <= tolerance;
  const sameCandidates = samePoint
    && previous.keys.length === keys.length
    && previous.keys.every((key, index) => key === keys[index]);
  return {
    x: sameCandidates ? previous.x : point.x,
    y: sameCandidates ? previous.y : point.y,
    keys,
    index: sameCandidates ? (previous.index + direction + candidates.length) % candidates.length : 0,
  };
}

export function createOverlapSelectionCycler({
  objectLayer,
  handleLayer = objectLayer,
  indicatorLayer = null,
  records,
  isRecordCandidate = () => true,
  canCycleHandles = () => true,
  isCandidateAllowed = () => true,
  selectCandidate = null,
  selectRecord,
}) {
  let cycleState = null;
  const canvas = objectLayer.closest?.('.canvas');
  const status = canvas?.ownerDocument.createElement('div');
  if (status) {
    status.className = 'overlap-cycle-status';
    status.setAttribute('role', 'status');
    status.hidden = true;
    canvas.appendChild(status);
  }
  const candidateLayers = [...new Set([objectLayer, handleLayer].filter(Boolean))];

  function clearIndicators() {
    candidateLayers.forEach((layer) => layer.querySelectorAll('.overlap-cycle-selected')
      .forEach((node) => node.classList.remove('overlap-cycle-selected')));
    indicatorLayer?.replaceChildren();
  }

  function clear() {
    cycleState = null;
    clearIndicators();
    if (status) status.hidden = true;
  }

  function candidatesAt(clientX, clientY) {
    const result = [];
    const seen = new Set();
    const addCandidate = (candidate) => {
      if (!isCandidateAllowed(candidate, { clientX, clientY })) return;
      const key = candidateKey(candidate);
      if (seen.has(key)) return;
      seen.add(key);
      result.push(candidate);
    };

    candidateLayers.flatMap((layer) => [...layer.querySelectorAll('.point-handle')]).reverse().forEach((handle) => {
      // Hover controls direct hit testing, not eligibility for overlap selection.
      if (!canCycleHandles() || !Number.isFinite(canvasPointHandleHitDistance(handle, clientX, clientY))) return;
      const group = handle.closest('.canvas-record, .canvas-handle-group');
      const record = records.find((candidate) => candidate.id === group?.dataset.recordId);
      const handleIndex = Number(handle.dataset.handleIndex);
      if (record && isRecordCandidate(record) && Number.isInteger(handleIndex)) {
        addCandidate({ kind: 'handle', recordId: record.id, handleIndex, node: handle });
      }
    });

    document.elementsFromPoint(clientX, clientY).forEach((element) => {
      const selectable = element.closest?.('.selectable-entity');
      const group = selectable?.closest?.('.canvas-record, .canvas-handle-group');
      const record = records.find((candidate) => candidate.id === group?.dataset.recordId);
      if (record && isRecordCandidate(record) && record.recordType !== 'image') {
        addCandidate({
          kind: 'stroke',
          recordId: record.id,
          ...(Number.isInteger(Number(selectable?.dataset?.segmentIndex))
            ? { segmentIndex: Number(selectable.dataset.segmentIndex) }
            : {}),
          node: selectable,
        });
      }
    });
    records.forEach((record) => {
      if (record.recordType === 'image' || !isRecordCandidate(record)) return;
      record.segmentNodes?.forEach((node) => {
        const rect = node.getBoundingClientRect();
        if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return;
        if (node.isPointInStroke && node.getScreenCTM?.()) {
          const local = new DOMPoint(clientX, clientY).matrixTransform(node.getScreenCTM().inverse());
          if (!node.isPointInStroke(local)) return;
        }
        addCandidate({
          kind: 'stroke',
          recordId: record.id,
          ...(Number.isInteger(Number(node.dataset?.segmentIndex))
            ? { segmentIndex: Number(node.dataset.segmentIndex) }
            : {}),
          node,
        });
      });
    });
    // A painted entity and its segment hit area represent the same edge.
    // Keep the precise segment target instead of offering duplicate choices.
    return result.filter(candidate => candidate.kind !== 'stroke'
      || Number.isInteger(candidate.segmentIndex)
      || !result.some(other => other.kind === 'stroke'
        && other.recordId === candidate.recordId && Number.isInteger(other.segmentIndex)));
  }

  function cycle(event) {
    const nearby = cycleState && Math.hypot(event.clientX - cycleState.x, event.clientY - cycleState.y) <= 8;
    const candidates = nearby ? cycleState.candidates : candidatesAt(event.clientX, event.clientY);
    if (!candidates.length) {
      clear();
      return null;
    }
    const nextState = advanceOverlapCycle(
      cycleState,
      candidates,
      { x: event.clientX, y: event.clientY },
      8,
      event.shiftKey ? -1 : 1,
    );
    const selected = candidates[nextState.index];
    cycleState = { ...nextState, candidates, candidate: selected };
    clearIndicators();
    selected.node?.classList.add('overlap-cycle-selected');
    if (indicatorLayer && selected.node) {
      const indicator = selected.node.cloneNode(true);
      const sourceMatrix = selected.node.getScreenCTM?.();
      const layerMatrix = indicatorLayer.getScreenCTM?.();
      if (sourceMatrix && layerMatrix) {
        const matrix = layerMatrix.inverse().multiply(sourceMatrix);
        indicator.setAttribute('transform', `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`);
      }
      indicator.classList.remove('hit-target');
      indicator.classList.add('overlap-cycle-indicator');
      indicator.style.pointerEvents = 'none';
      indicator.removeAttribute('role');
      indicator.removeAttribute('aria-label');
      if (typeof getComputedStyle === 'function') {
        const strokeWidth = getComputedStyle(selected.node).getPropertyValue('--original-stroke-width');
        if (strokeWidth) indicator.style.setProperty('--original-stroke-width', strokeWidth);
      }
      indicatorLayer.appendChild(indicator);
    }
    if (status) {
      const record = records.find((item) => item.id === selected.recordId);
      const feature = selected.kind === 'handle' ? `Point ${selected.handleIndex + 1}` : 'Edge';
      const label = record?.entity?.name || `${record?.entity?.type || 'Object'} ${records.indexOf(record) + 1}`;
      status.textContent = `${nextState.index + 1}/${candidates.length} · ${feature} · ${label} — Alt-click / Tab: next · Shift: previous · Click / Enter: select · Esc: cancel`;
      status.hidden = false;
    }
    return selected;
  }

  function commit({ additive = false, event = null } = {}) {
    const selected = cycleState?.candidate || null;
    if (!selected) return null;
    const point = { clientX: cycleState.x, clientY: cycleState.y };
    clear();
    if (selectCandidate) selectCandidate(selected, { additive, event, ...point });
    else selectRecord(selected.recordId, {
      additive,
      segmentIndex: Number.isInteger(selected.segmentIndex) ? selected.segmentIndex : null,
      handleIndex: selected.handleIndex ?? null,
    });
    return selected;
  }

  function acceptPointer(event) {
    if (!cycleState || event.button !== 0 || event.altKey) return false;
    if (Math.hypot(event.clientX - cycleState.x, event.clientY - cycleState.y) > 8) {
      clear();
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    commit({ additive: event.ctrlKey || event.metaKey, event });
    return true;
  }

  function keyDown(event) {
    if (!cycleState) return false;
    if (!['Escape', 'Enter', 'Tab'].includes(event.key)) return false;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') clear();
    else if (event.key === 'Enter') commit({ additive: event.ctrlKey || event.metaKey, event });
    else cycle({ clientX: cycleState.x, clientY: cycleState.y, shiftKey: event.shiftKey });
    return true;
  }

  return { clear, cycle, commit, acceptPointer, keyDown };
}

// --- Drawing Hint Display ---
export function createDrawingHint({ canvas }) {
  const canvasElement = canvas.getCanvasElement();
  const element = document.createElement('div');
  element.className = 'drawing-hint';
  element.hidden = true;
  canvasElement.appendChild(element);

  function hide() {
    element.hidden = true;
    element.replaceChildren();
  }

  function show(event, lines) {
    const values = (Array.isArray(lines) ? lines : [lines]).filter(Boolean);
    if (!values.length) {
      hide();
      return;
    }
    const bounds = canvasElement.getBoundingClientRect();
    const zoomRatio = Math.max(0.01, (canvas.getScale?.() || 0.04) / 0.04);
    const scale = Math.max(0.85, Math.min(1.25, 1 + Math.log2(zoomRatio) * 0.12));
    element.replaceChildren(...values.map((value) => {
      const line = document.createElement('span');
      line.textContent = value;
      return line;
    }));
    element.style.left = `${event.clientX - bounds.left + 16}px`;
    element.style.top = `${event.clientY - bounds.top + 16}px`;
    element.style.transform = `scale(${scale})`;
    element.hidden = false;
  }

  function formatLength(value) {
    return String(canvas.formatDrawingLength?.(value) || Number(value).toFixed(3))
      .replace(/\s*in\b/gi, '"')
      .replace(/\s*ft\b/gi, "'");
  }

  function showHandle(event, entity, handleIndex) {
    if (!entity) return hide();
    const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (entity.type === 'line') return show(event, `L ${formatLength(distance(entity.start, entity.end))}`);
    if (entity.type === 'circle') return show(event, `R ${formatLength(entity.radius)}`);
    if (entity.type === 'rect') {
      return show(event, [
        `W ${formatLength(Math.abs(entity.width))}`,
        `H ${formatLength(Math.abs(entity.height))}`,
      ]);
    }
    if (['polyline', 'polygon', 'curve'].includes(entity.type) && entity.points?.length > 1) {
      const otherIndex = handleIndex > 0 ? handleIndex - 1 : 1;
      return show(event, `L ${formatLength(distance(entity.points[handleIndex], entity.points[otherIndex]))}`);
    }
    if (entity.type === 'arc') {
      const arcPoints = [entity.start, entity.arcPoint, entity.end];
      const otherIndex = handleIndex > 0 ? handleIndex - 1 : 1;
      return show(event, `L ${formatLength(distance(arcPoints[handleIndex], arcPoints[otherIndex]))}`);
    }
    if (entity.type === 'notch' && entity.locationMemory) {
      return show(event, `L ${formatLength(Math.abs(entity.locationMemory.signedDistance || 0))}`);
    }
    return hide();
  }

  canvasElement.addEventListener('pointerleave', hide);
  return { formatLength, hide, show, showHandle };
}
