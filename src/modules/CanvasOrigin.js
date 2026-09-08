import { GLOBAL_LAYER_ID, stackFrameFor } from './StackCoordinates.js';
const LEGACY_CANVAS_ORIGIN_RECORD_ID = '__paramagic_canvas_origin__';
export const CANVAS_ORIGIN_REFERENCE_ROLE = 'canvas-origin';

export function isCanvasOriginReference(reference) {
  return reference?.referenceRole === CANVAS_ORIGIN_REFERENCE_ROLE;
}

export function canvasOriginPointFeature(node = null, stackState = null) {
  return {
    kind: 'point',
    referenceRole: CANVAS_ORIGIN_REFERENCE_ROLE,
    entityType: 'canvas-origin',
    index: 0,
    point: [stackFrameFor(stackState).x, stackFrameFor(stackState).y],
    ...(stackState ? { stackId: stackState.activeStackId || GLOBAL_LAYER_ID } : {}),
    ...(node ? { node } : {}),
  };
}

export function migrateCanvasOriginReferences(value) {
  if (Array.isArray(value)) return value.map(migrateCanvasOriginReferences);
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    migrateCanvasOriginReferences(item),
  ]));
  if (result.recordId === LEGACY_CANVAS_ORIGIN_RECORD_ID || result.entityId === LEGACY_CANVAS_ORIGIN_RECORD_ID) {
    delete result.recordId;
    delete result.entityId;
    result.kind ||= 'point';
    result.pointRole ||= 'origin';
    result.referenceRole = CANVAS_ORIGIN_REFERENCE_ROLE;
    result.entityType ||= 'canvas-origin';
  }
  return result;
}
