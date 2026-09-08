import { canvasPointerDragReady } from './CanvasPointerDrag.js';
import { GLOBAL_LAYER_ID, normalizeStackFrame } from './StackCoordinates.js';

const STACK_GEOMETRY_RECORD_TYPES = new Set(['geometry', 'fillet', 'notch']);

function geometryRecordForTarget(target, getRecordById) {
  const group = target?.closest?.('.canvas-record');
  const recordId = String(group?.dataset?.recordId || '').trim();
  if (recordId) {
    const record = getRecordById(recordId);
    if (STACK_GEOMETRY_RECORD_TYPES.has(record?.recordType)) return record;
  }
  const region = target?.closest?.('.closed-constrained-region');
  const parentRecords = String(region?.dataset?.parentIds || '')
    .split(',')
    .map((id) => getRecordById(id))
    .filter((record) => STACK_GEOMETRY_RECORD_TYPES.has(record?.recordType));
  if (!parentRecords.length || new Set(parentRecords.map(({ entity }) => entity?.stackId)).size !== 1) return null;
  return parentRecords[0];
}

function stackIdForTarget(target) {
  const owner = target?.closest?.('[data-stack-id]');
  const stackId = String(owner?.dataset?.stackId || '').trim();
  return stackId && stackId !== GLOBAL_LAYER_ID ? stackId : null;
}

export function createStackCanvasInteraction({
  canvasElement,
  getActiveStackId = () => null,
  getRecordById = () => null,
  getStackFrame = () => null,
  canMoveStack = () => false,
  isToolInteractionActive = () => false,
  screenToWorld = (x, y) => [x, y],
  moveStackFrame = () => ({ changed: false }),
  restoreDragSnapshot = () => {},
  captureDragSnapshot = () => null,
  onCommit = () => {},
  onHoveredStackChange = () => {},
} = {}) {
  if (!canvasElement?.addEventListener) {
    return { isDragging: () => false, destroy() {} };
  }

  let drag = null;
  let suppressClick = false;

  const stopEvent = (event) => {
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
  };

  const pointerDown = (event) => {
    if (
      event.button !== 0
      || getActiveStackId()
      || isToolInteractionActive()
      || event.altKey
      || event.ctrlKey
      || event.metaKey
      || event.shiftKey
      || event.target?.closest?.('.point-handle, [data-canvas-ui], .canvas-overlay-button')
    ) return;
    const record = geometryRecordForTarget(event.target, getRecordById);
    const stackId = String(record?.entity?.stackId || '').trim();
    if (!record || !stackId || stackId === GLOBAL_LAYER_ID || !canMoveStack(stackId, record)) return;
    const startFrame = normalizeStackFrame(getStackFrame(stackId));
    drag = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startWorld: screenToWorld(event.clientX, event.clientY),
      startFrame,
      stackId,
      moved: false,
      changed: false,
      snapshot: captureDragSnapshot(stackId),
    };
    canvasElement.setPointerCapture?.(event.pointerId);
    stopEvent(event);
  };

  const pointerMove = (event) => {
    if (!drag || drag.pointerId !== event.pointerId) {
      if (!getActiveStackId() && !isToolInteractionActive()) {
        const stackId = stackIdForTarget(event.target);
        onHoveredStackChange(stackId && canMoveStack(stackId) ? stackId : null);
      }
      return;
    }
    if (!drag.moved && !canvasPointerDragReady(drag, event)) {
      stopEvent(event);
      return;
    }
    drag.moved = true;
    const world = screenToWorld(event.clientX, event.clientY);
    const nextFrame = {
      ...drag.startFrame,
      x: drag.startFrame.x + world[0] - drag.startWorld[0],
      y: drag.startFrame.y + world[1] - drag.startWorld[1],
    };
    const outcome = moveStackFrame(drag.stackId, nextFrame) || {};
    drag.changed = drag.changed || outcome.changed === true;
    onHoveredStackChange(drag.stackId);
    canvasElement.classList?.add?.('stack-frame-dragging');
    stopEvent(event);
  };

  const finish = (event, cancelled = false) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const completed = drag;
    drag = null;
    canvasElement.releasePointerCapture?.(event.pointerId);
    canvasElement.classList?.remove?.('stack-frame-dragging');
    if (cancelled && completed.moved) {
      restoreDragSnapshot(completed.snapshot);
    } else if (completed.changed) {
      suppressClick = true;
      onCommit(completed.stackId);
    }
    stopEvent(event);
  };

  const pointerUp = (event) => finish(event, false);
  const pointerCancel = (event) => finish(event, true);
  const pointerLeave = () => {
    if (!drag && !getActiveStackId()) onHoveredStackChange(null);
  };
  const click = (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    stopEvent(event);
  };

  canvasElement.addEventListener('pointerdown', pointerDown, true);
  canvasElement.addEventListener('pointermove', pointerMove, true);
  canvasElement.addEventListener('pointerup', pointerUp, true);
  canvasElement.addEventListener('pointercancel', pointerCancel, true);
  canvasElement.addEventListener('pointerleave', pointerLeave, true);
  canvasElement.addEventListener('click', click, true);

  return {
    isDragging: () => Boolean(drag?.moved),
    destroy() {
      canvasElement.removeEventListener?.('pointerdown', pointerDown, true);
      canvasElement.removeEventListener?.('pointermove', pointerMove, true);
      canvasElement.removeEventListener?.('pointerup', pointerUp, true);
      canvasElement.removeEventListener?.('pointercancel', pointerCancel, true);
      canvasElement.removeEventListener?.('pointerleave', pointerLeave, true);
      canvasElement.removeEventListener?.('click', click, true);
      drag = null;
      suppressClick = false;
      canvasElement.classList?.remove?.('stack-frame-dragging');
    },
  };
}
