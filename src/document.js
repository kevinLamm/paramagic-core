export const PARAMAGIC_DOCUMENT_EXTENSION = '.paramagic';
export const PARAMAGIC_DOCUMENT_MIME_TYPE = 'application/vnd.paramagic+json';

export {
  IDENTITY_ARCHITECTURE_VERSION,
  cloneDrawingIdentityGraph,
  createDrawingIdentityIndex,
  identityAudit,
  migrateDrawingIdentities,
  registeredIdentitySchemaKeys,
  remapDrawingIdentityGraph,
  validateDrawingIdentityGraph,
} from './modules/DrawingIdentitySystem.js';
export {
  assertUuid,
  createUuid,
  createUuidAllocator,
  deriveUuid,
  deriveUuidForKey,
  isUuid,
  normalizeUuid,
} from './modules/IdentitySystem.js';

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
  createIndependentDrawingSave,
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
  createDrawingContainerPackage,
  createDrawingClipboard,
  createStackSubtreePackage,
  parseClipboardPackage,
  retargetClipboardDrawing,
} from './modules/DrawingClipboard.js';
export {
  dimensionCollectionNameError,
  dimensionDisplayName,
  dimensionParameterIndex,
  dimensionParameterNameError,
  nextAvailableParameterName,
  nextDimensionNameForStack,
  nextIndexedParameterName,
  normalizedNameWhitespace,
  normalizedStackName,
  parameterNameError,
  parameterNameKey,
  qualifiedDimensionName,
  replaceExpressionSymbolReference,
  rewriteExpressionSymbolReferences,
  rewriteQualifiedDimensionReferences,
  stackNameById,
  stackNameError,
  uniqueStackName,
  userParameterNameError,
} from './modules/NamingSystem.js';
