import {
  createMeasuredCanvasPresentationSvg,
  serializeCanvasPresentationElement,
} from './CanvasPresentation.js';
import { applyValueOnlyExportDimensionAppearance } from './DimensionSystem.js';
import { embedSvgImageAssets } from './ImageSystem.js';

export async function serializeCanvasPresentationSvg(objectLayer, options = {}, {
  createPresentationSvg = createMeasuredCanvasPresentationSvg,
  serializePresentationElement = serializeCanvasPresentationElement,
  embedImageAssets = embedSvgImageAssets,
} = {}) {
  const presentation = createPresentationSvg({
    objectLayer,
    background: null,
    ...options,
  });
  if (!presentation) throw new Error('The canvas presentation is unavailable for SVG export.');
  applyValueOnlyExportDimensionAppearance(presentation);
  return embedImageAssets(serializePresentationElement(presentation));
}
