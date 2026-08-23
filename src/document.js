export const PARAMAGIC_DOCUMENT_EXTENSION = '.paramagic';
export const PARAMAGIC_DOCUMENT_MIME_TYPE = 'application/vnd.paramagic+json';

import {
  parseDrawingText,
  serializeDrawingJson,
} from './modules/DrawingIO.js';

export function parseParamagicDocument(text) {
  return parseDrawingText(`drawing${PARAMAGIC_DOCUMENT_EXTENSION}`, text);
}

export function serializeParamagicDocument(snapshot, name = 'Untitled Drawing') {
  return serializeDrawingJson(snapshot, name);
}

export {
  DRAWING_CANVAS_BACKGROUND,
  createDrawingThumbnail,
  createDrawingThumbnailSvg,
  drawingThumbnailEvaluators,
  drawingThumbnailSvgFromDataUrl,
  drawingThumbnailVersion,
  materializeDrawingInstances,
  materializeThumbnailDrawing,
  mergeDrawingData,
  mergeDrawingDataWithMap,
  normalizeDrawingData,
  orderThumbnailEntities,
  parseDrawingText,
  parseDxf,
  resolveDrawingScene,
  serializeDrawingJson,
  serializeDxf,
} from './modules/DrawingIO.js';
export {
  PARAMAGIC_CLIPBOARD_FORMAT,
  PARAMAGIC_CLIPBOARD_VERSION,
  createClipboardPackage,
  createDrawingClipboard,
  parseClipboardPackage,
  retargetClipboardDrawing,
} from './modules/DrawingClipboard.js';
