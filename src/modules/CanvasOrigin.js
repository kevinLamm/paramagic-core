export const CANVAS_ORIGIN_RECORD_ID = '__paramagic_canvas_origin__';

export function isCanvasOriginReference(reference) {
  return reference?.recordId === CANVAS_ORIGIN_RECORD_ID
    || reference?.entityId === CANVAS_ORIGIN_RECORD_ID;
}

export function canvasOriginPointFeature(node = null) {
  return {
    kind: 'point',
    recordId: CANVAS_ORIGIN_RECORD_ID,
    entityType: 'canvas-origin',
    index: 0,
    point: [0, 0],
    ...(node ? { node } : {}),
  };
}
