export const CANVAS_DRAG_THRESHOLD_PX = 4;

export function canvasPointerDragDistance(drag, event) {
  const startX = Number(drag?.startClientX);
  const startY = Number(drag?.startClientY);
  const clientX = Number(event?.clientX);
  const clientY = Number(event?.clientY);
  if (![startX, startY, clientX, clientY].every(Number.isFinite)) return 0;
  return Math.hypot(clientX - startX, clientY - startY);
}

export function canvasPointerDragReady(drag, event, threshold = CANVAS_DRAG_THRESHOLD_PX) {
  return canvasPointerDragDistance(drag, event) >= Math.max(0, Number(threshold) || 0);
}
