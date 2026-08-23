import { rememberRepeatableTool } from './CanvasUIControls.js';
import { arcDirectionFromPoints } from './ArcGeometry.js';

export function drawingArcFromPoints(start, arcPoint, end) {
  const ccw = arcDirectionFromPoints(start, arcPoint, end);
  return {
    type: 'arc',
    start,
    arcPoint,
    end,
    ...(typeof ccw === 'boolean' ? { ccw } : {}),
  };
}

// --- Curve Control Points Utilities ---
const distanceSquared = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

function controlPoint(current, previous, next, tension = 0.18) {
  return [
    current[0] + (next[0] - previous[0]) * tension,
    current[1] + (next[1] - previous[1]) * tension,
  ];
}

export function drawingCurveCubicSegment(points, index) {
  if (!Array.isArray(points) || index < 0 || index >= points.length - 1) return null;
  const start = points[index];
  const end = points[index + 1];
  const previous = points[Math.max(0, index - 1)];
  const after = points[Math.min(points.length - 1, index + 2)];
  return [
    [...start],
    controlPoint(start, previous, end),
    controlPoint(end, after, start),
    [...end],
  ];
}

export function drawingCurveCubicPoint(segment, t) {
  const [a, b, c, d] = segment;
  const inverse = 1 - t;
  return [
    inverse ** 3 * a[0] + 3 * inverse ** 2 * t * b[0] + 3 * inverse * t ** 2 * c[0] + t ** 3 * d[0],
    inverse ** 3 * a[1] + 3 * inverse ** 2 * t * b[1] + 3 * inverse * t ** 2 * c[1] + t ** 3 * d[1],
  ];
}

export function nearestCurveInsertion(points, target, samplesPerSegment = 32) {
  if (!Array.isArray(points) || points.length < 2) return null;
  let nearest = null;
  for (let segment = 0; segment < points.length - 1; segment += 1) {
    const cubic = drawingCurveCubicSegment(points, segment);
    for (let sample = 0; sample <= samplesPerSegment; sample += 1) {
      const t = sample / samplesPerSegment;
      const point = drawingCurveCubicPoint(cubic, t);
      const score = distanceSquared(point, target);
      if (!nearest || score < nearest.score) nearest = { point, score, segment, t };
    }
  }
  return nearest ? { point: nearest.point, index: nearest.segment + 1 } : null;
}

export function insertCurveControlPoint(points, target) {
  const insertion = nearestCurveInsertion(points, target);
  if (!insertion) return null;
  const next = points.map((point) => [...point]);
  next.splice(insertion.index, 0, [...insertion.point]);
  return { points: next, index: insertion.index };
}

export function deleteCurveControlPoint(points, index) {
  if (!Array.isArray(points) || points.length <= 2 || index < 0 || index >= points.length) return null;
  const next = points.map((point) => [...point]);
  next.splice(index, 1);
  return { points: next, index };
}

export function remapCurvePointIndex(index, edit) {
  if (!Number.isInteger(index)) return index;
  if (edit.type === 'insert') return index >= edit.index ? index + 1 : index;
  if (edit.type === 'delete') {
    if (index === edit.index) return null;
    return index > edit.index ? index - 1 : index;
  }
  return index;
}

export function drawingGeometryHitTargetClass(entity) {
  return entity?.type === 'circle' ? 'circle-region-hit' : '';
}

// --- Drawing Tools ---
const pointDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const angleSnapStep = Math.PI / 6;
const angleSnapTolerance = Math.PI / 24;
let compositeSerial = 0;

function rectanglePoints(a, b) {
  return [
    [a[0], a[1]],
    [b[0], a[1]],
    [b[0], b[1]],
    [a[0], b[1]],
  ];
}

function createCompositeId(kind) {
  if (globalThis.crypto?.randomUUID) return `${kind}-${globalThis.crypto.randomUUID()}`;
  compositeSerial += 1;
  return `${kind}-${compositeSerial}`;
}

export function addEditableLineChain({
  chainPoints,
  addObject,
  addObjects = null,
  closed = false,
  kind = 'polyline',
  snaps = [],
  decorateEntity = (entity) => entity,
}) {
  if (!Array.isArray(chainPoints) || chainPoints.length < 2 || typeof addObject !== 'function') return [];
  const compositeId = createCompositeId(kind);
  const segmentCount = closed ? chainPoints.length : chainPoints.length - 1;
  if (typeof addObjects === 'function') {
    const ids = Array.from({ length: segmentCount }, (_, index) => `${compositeId}-segment-${index}`);
    const entries = ids.map((id, index) => {
      const nextIndex = (index + 1) % chainPoints.length;
      const start = chainPoints[index];
      const end = chainPoints[nextIndex];
      const startSnap = index > 0
        ? { kind: 'point', recordId: ids[index - 1], entityType: 'line', index: 2, point: [...start] }
        : snaps[index] || null;
      const endSnap = closed && index === segmentCount - 1
        ? { kind: 'point', recordId: ids[0], entityType: 'line', index: 0, point: [...end] }
        : snaps[nextIndex] || null;
      return {
        entity: decorateEntity({
          id,
          type: 'line',
          start: [...start],
          end: [...end],
          composite: { id: compositeId, kind, closed, index, count: segmentCount },
        }),
        snapRefs: [startSnap, endSnap],
      };
    });
    return addObjects(entries);
  }
  const records = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const nextIndex = (index + 1) % chainPoints.length;
    const start = chainPoints[index];
    const end = chainPoints[nextIndex];
    const previousRecord = records[index - 1];
    const firstRecord = records[0];
    const startSnap = previousRecord
      ? { kind: 'point', recordId: previousRecord.id, entityType: 'line', index: 2, point: [...start] }
      : snaps[index] || null;
    const endSnap = closed && index === segmentCount - 1 && firstRecord
      ? { kind: 'point', recordId: firstRecord.id, entityType: 'line', index: 0, point: [...end] }
      : snaps[nextIndex] || null;
    const record = addObject(decorateEntity({
      type: 'line',
      start: [...start],
      end: [...end],
      composite: { id: compositeId, kind, closed, index, count: segmentCount },
    }), { snapRefs: [startSnap, endSnap] });
    if (record) records.push(record);
  }
  return records;
}

function curveFromPoints(points) {
  if (points.length < 3) return { type: 'polyline', points };
  return { type: 'curve', points };
}

function normalizeAngleDelta(delta) {
  return Math.atan2(Math.sin(delta), Math.cos(delta));
}

function snapToAngle(anchor, point) {
  const dx = point[0] - anchor[0];
  const dy = point[1] - anchor[1];
  const length = Math.hypot(dx, dy);
  if (length < 0.0001) return point;
  const angle = Math.atan2(dy, dx);
  const snappedAngle = Math.round(angle / angleSnapStep) * angleSnapStep;
  if (Math.abs(normalizeAngleDelta(angle - snappedAngle)) > angleSnapTolerance) return point;
  return [anchor[0] + Math.cos(snappedAngle) * length, anchor[1] + Math.sin(snappedAngle) * length];
}

export function resolveVectorDrawingPoint({
  rawPoint,
  anchor = null,
  event = null,
  getNearestObjectPoint = null,
}) {
  const snap = getNearestObjectPoint?.(rawPoint, 14) || null;
  if (snap) return { point: [...snap.point], snap };
  if (anchor && !event?.altKey) return { point: snapToAngle(anchor, rawPoint), snap: null };
  return { point: rawPoint, snap: null };
}

export function createDrawingTools({ toolbar, canvas, drawingHint = null }) {
  let activeTool = null;
  let points = [];
  let pointSnaps = [];
  const constructionButton = toolbar.querySelector('[title="Construction"]');
  const textTableToggle = toolbar.querySelector('[data-text-table-toggle]');

  function drawingToolButtons() {
    return [...new Set([
      ...toolbar.querySelectorAll('[data-drawing-tool]'),
      ...document.querySelectorAll('[data-text-table-menu] [data-drawing-tool]'),
    ])];
  }

  function resetSequence() {
    points = [];
    pointSnaps = [];
    canvas.clearPreview();
    canvas.clearObjectSnapCandidate?.();
    drawingHint?.hide();
  }

  function setActiveTool(tool) {
    activeTool = activeTool === tool ? null : tool;
    resetSequence();
    drawingToolButtons().forEach((button) => {
      const isActive = button.dataset.drawingTool === activeTool;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
    textTableToggle?.classList.toggle('active', activeTool === 'Text' || activeTool === 'Table');
    textTableToggle?.setAttribute('aria-pressed', String(activeTool === 'Text' || activeTool === 'Table'));
    canvas.setDrawingMode(Boolean(activeTool));
    if (activeTool) window.dispatchEvent(new CustomEvent('paramagic:tool-activated', { detail: { source: 'drawing' } }));
  }

  function deactivate() {
    activeTool = null;
    resetSequence();
    drawingToolButtons().forEach((button) => {
      button.classList.remove('active');
      button.setAttribute('aria-pressed', 'false');
    });
    textTableToggle?.classList.remove('active');
    textTableToggle?.setAttribute('aria-pressed', 'false');
    canvas.setDrawingMode(false);
  }

  function completeActiveTool(tool = activeTool) {
    deactivate();
    if (!tool) return;
    rememberRepeatableTool(() => {
      if (activeTool) return false;
      setActiveTool(tool);
      return true;
    });
  }

  function addPoint(point, snap = null) {
    points.push(point);
    pointSnaps.push(snap);
  }

  function isConstructionMode() {
    return constructionButton?.getAttribute('aria-pressed') === 'true';
  }

  function withConstruction(entity) {
    return isConstructionMode() ? { ...entity, construction: true } : entity;
  }

  function addDrawingObject(entity) {
    canvas.addObject(withConstruction(entity), { snapRefs: [...pointSnaps] });
  }

  function addLineChain(chainPoints, { closed = false, kind = 'polyline', snaps = pointSnaps } = {}) {
    return addEditableLineChain({
      chainPoints,
      closed,
      kind,
      snaps,
      decorateEntity: withConstruction,
      addObject: (entity, options) => canvas.addObject(entity, options),
      addObjects: canvas.addObjects,
    });
  }

  function setDrawingPreview(entity) {
    canvas.setPreview(withConstruction(entity));
  }

  function finishOpenPointTool(minPoints, factory) {
    if (points.length < minPoints) return false;
    const completedTool = activeTool;
    addDrawingObject(factory([...points]));
    completeActiveTool(completedTool);
    return true;
  }

  function usesAngleSnap(tool) {
    return tool === 'Line' || tool === 'Polyline';
  }

  function resolvePointResult(rawPoint, anchor = null, event = null) {
    return resolveVectorDrawingPoint({
      rawPoint,
      anchor: usesAngleSnap(activeTool) ? anchor : null,
      event,
      getNearestObjectPoint: canvas.getNearestObjectPoint,
    });
  }

  function pointerPoint(event, anchor = null) {
    return resolvePointResult(canvas.screenToWorld(event.clientX, event.clientY), anchor, event);
  }

  function closesPolyline(point) {
    return points.length >= 3 && pointDistance(point, points[0]) <= canvas.getWorldTolerance(14);
  }

  function handlePointerDown(event) {
    if (!activeTool || event.button !== 0) return false;
    const rawPoint = canvas.screenToWorld(event.clientX, event.clientY);

    if (activeTool === 'Text') {
      const completedTool = activeTool;
      const record = canvas.addText({ x: rawPoint[0], y: rawPoint[1] });
      completeActiveTool(completedTool);
      canvas.beginTextEdit(record, { selectAll: true });
      return true;
    }

    if (activeTool === 'Table') {
      const completedTool = activeTool;
      const record = canvas.addTable({ x: rawPoint[0], y: rawPoint[1] });
      completeActiveTool(completedTool);
      if (record) canvas.beginTableEdit?.(record);
      return true;
    }

    if (activeTool === 'Line') {
      const result = resolvePointResult(rawPoint, points[points.length - 1], event);
      addPoint(result.point, result.snap);
      if (points.length === 2) finishOpenPointTool(2, ([start, end]) => ({ type: 'line', start, end }));
      return true;
    }

    if (activeTool === 'Circle') {
      const result = resolvePointResult(rawPoint);
      addPoint(result.point, result.snap);
      if (points.length === 2) {
        const completedTool = activeTool;
        const [center, radiusPoint] = points;
        addDrawingObject({ type: 'circle', center, radius: Math.max(8, pointDistance(center, radiusPoint)) });
        completeActiveTool(completedTool);
      }
      return true;
    }

    if (activeTool === 'Rectangle') {
      const result = resolvePointResult(rawPoint);
      addPoint(result.point, result.snap);
      if (points.length === 2) {
        const completedTool = activeTool;
        addLineChain(rectanglePoints(points[0], points[1]), {
          closed: true,
          kind: 'rectangle',
          snaps: [pointSnaps[0], null, pointSnaps[1], null],
        });
        completeActiveTool(completedTool);
      }
      return true;
    }

    if (activeTool === 'Arc') {
      const result = resolvePointResult(rawPoint);
      addPoint(result.point, result.snap);
      if (points.length === 3) finishOpenPointTool(3, ([start, arcPoint, end]) => drawingArcFromPoints(start, arcPoint, end));
      return true;
    }

    if (activeTool === 'Polyline') {
      const result = resolvePointResult(rawPoint, points[points.length - 1], event);
      const point = closesPolyline(rawPoint) ? points[0] : result.point;
      if (closesPolyline(point)) {
        const completedTool = activeTool;
        addLineChain([...points], { closed: true, kind: 'polyline' });
        completeActiveTool(completedTool);
        return true;
      }
      addPoint(point, result.snap);
      return true;
    }

    if (activeTool === 'Curve / Spline') {
      const result = resolvePointResult(rawPoint);
      addPoint(result.point, result.snap);
      return true;
    }

    return false;
  }

  function handlePointerMove(event) {
    if (!activeTool) {
      canvas.clearPreview();
      canvas.clearObjectSnapCandidate?.();
      drawingHint?.hide();
      return false;
    }
    const rawPoint = canvas.screenToWorld(event.clientX, event.clientY);
    const result = pointerPoint(event, points[points.length - 1]);
    canvas.setObjectSnapCandidate?.(result.snap);
    if (activeTool === 'Table') {
      canvas.setTablePreview?.({ x: rawPoint[0], y: rawPoint[1] });
      drawingHint?.hide();
      return true;
    }
    if (points.length === 0) {
      canvas.clearPreview();
      drawingHint?.hide();
      return true;
    }
    const point = result.point;
    const formatLength = (value) => drawingHint?.formatLength(value)
      || canvas.formatDrawingLength?.(value)
      || value.toFixed(3);
    const previousPoint = points[points.length - 1];
    if (activeTool === 'Circle') {
      drawingHint?.show(event, `R ${formatLength(pointDistance(points[0], point))}`);
    } else if (activeTool === 'Rectangle') {
      drawingHint?.show(event, [
        `W ${formatLength(Math.abs(point[0] - points[0][0]))}`,
        `H ${formatLength(Math.abs(point[1] - points[0][1]))}`,
      ]);
    } else {
      drawingHint?.show(event, `L ${formatLength(pointDistance(previousPoint, point))}`);
    }
    if (activeTool === 'Line') setDrawingPreview({ type: 'line', start: points[0], end: point });
    if (activeTool === 'Circle') setDrawingPreview({ type: 'circle', center: points[0], radius: Math.max(8, pointDistance(points[0], point)) });
    if (activeTool === 'Rectangle') setDrawingPreview({ type: 'polygon', points: rectanglePoints(points[0], point) });
    if (activeTool === 'Arc' && points.length === 1) setDrawingPreview({ type: 'polyline', points: [points[0], point] });
    if (activeTool === 'Arc' && points.length === 2) setDrawingPreview(drawingArcFromPoints(points[0], points[1], point));
    if (activeTool === 'Polyline') {
      const previewPoint = closesPolyline(rawPoint) ? points[0] : point;
      setDrawingPreview({ type: closesPolyline(previewPoint) ? 'polygon' : 'polyline', points: closesPolyline(previewPoint) ? [...points] : [...points, previewPoint] });
    }
    if (activeTool === 'Curve / Spline') setDrawingPreview(curveFromPoints([...points, point]));
    return true;
  }

  function finishActiveSequence() {
    if (activeTool === 'Polyline' && points.length >= 2) {
      const completedTool = activeTool;
      addLineChain([...points], { kind: 'polyline' });
      completeActiveTool(completedTool);
      return true;
    }
    if (activeTool === 'Curve / Spline') return finishOpenPointTool(2, curveFromPoints);
    return false;
  }

  drawingToolButtons().forEach((button) => {
    button.addEventListener('click', () => setActiveTool(button.dataset.drawingTool));
  });

  document.addEventListener('keydown', (event) => {
    if (!activeTool) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      deactivate();
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      finishActiveSequence();
    }
  });

  window.addEventListener('paramagic:tool-activated', (event) => {
    if (event.detail?.source !== 'drawing') deactivate();
  });

  canvas.setDrawingToolDelegate({
    pointerDown: handlePointerDown,
    pointerMove: handlePointerMove,
    doubleClick: finishActiveSequence,
  });

  return { setActiveTool, deactivate };
}
