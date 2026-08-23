// --- Canvas Zoom Constraints ---
export const MIN_CANVAS_ZOOM = 0.005;
export const MAX_CANVAS_ZOOM = 32;

export function clampCanvasZoom(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested)) return 1;
  return Math.min(MAX_CANVAS_ZOOM, Math.max(MIN_CANVAS_ZOOM, requested));
}

// --- Overlap Selection Cycler ---
const candidateKey = (candidate) => candidate.kind === 'handle'
  ? `handle:${candidate.recordId}:${candidate.handleIndex}`
  : `stroke:${candidate.recordId}:${candidate.segmentIndex ?? 'entity'}`;

export function advanceOverlapCycle(previous, candidates, point, tolerance = 4) {
  const keys = candidates.map(candidateKey);
  const samePoint = previous
    && Math.hypot(previous.x - point.x, previous.y - point.y) <= tolerance;
  const sameCandidates = samePoint
    && previous.keys.length === keys.length
    && previous.keys.every((key, index) => key === keys[index]);
  return {
    x: point.x,
    y: point.y,
    keys,
    index: sameCandidates ? (previous.index + 1) % candidates.length : 0,
  };
}

export function createOverlapSelectionCycler({
  objectLayer,
  handleLayer = objectLayer,
  indicatorLayer = null,
  records,
  isRecordCandidate = () => true,
  selectRecord,
}) {
  let cycleState = null;
  const candidateLayers = [...new Set([objectLayer, handleLayer].filter(Boolean))];

  function clearIndicators() {
    candidateLayers.forEach((layer) => layer.querySelectorAll('.overlap-cycle-selected')
      .forEach((node) => node.classList.remove('overlap-cycle-selected')));
    indicatorLayer?.replaceChildren();
  }

  function clear() {
    cycleState = null;
    clearIndicators();
  }

  function candidatesAt(clientX, clientY) {
    const result = [];
    const seen = new Set();
    const addCandidate = (candidate) => {
      const key = candidateKey(candidate);
      if (seen.has(key)) return;
      seen.add(key);
      result.push(candidate);
    };

    candidateLayers.flatMap((layer) => [...layer.querySelectorAll('.point-handle')]).reverse().forEach((handle) => {
      if (typeof getComputedStyle === 'function' && getComputedStyle(handle).pointerEvents === 'none') return;
      const rect = handle.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      if (Math.hypot(clientX - centerX, clientY - centerY) > 9) return;
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
          node: selectable?.classList?.contains('hit-target') ? record.node : selectable,
        });
      }
    });
    records.forEach((record) => {
      if (record.recordType === 'image' || !isRecordCandidate(record)) return;
      record.segmentNodes?.forEach((node) => {
        const rect = node.getBoundingClientRect();
        if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return;
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
    return result;
  }

  function cycle(event) {
    const candidates = candidatesAt(event.clientX, event.clientY);
    if (!candidates.length) {
      clear();
      return null;
    }
    const nextState = advanceOverlapCycle(
      cycleState,
      candidates,
      { x: event.clientX, y: event.clientY },
    );
    const selected = candidates[nextState.index];
    cycleState = { ...nextState, candidate: selected };
    clearIndicators();
    selected.node?.classList.add('overlap-cycle-selected');
    if (indicatorLayer && selected.node) {
      const indicator = selected.node.cloneNode(true);
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
    return selected;
  }

  function commit({ additive = false } = {}) {
    const selected = cycleState?.candidate || null;
    if (!selected) return null;
    selectRecord(selected.recordId, {
      additive,
      segmentIndex: Number.isInteger(selected.segmentIndex) ? selected.segmentIndex : null,
    });
    return selected;
  }

  return { clear, cycle, commit };
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
