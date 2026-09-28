import { createSwellTools } from './SwellTools.js';
import { createLinkedCopyTools } from './SymmetricTool.js';
import { createArrayTools } from './ArrayTools.js';

// Install document features before loading a drawing in either an editor or a
// viewer. Toolbars are optional; derivative evaluation and rendering are not.
export function createDrawingFeatures({ canvas, toolbar, arrayToolbar } = {}) {
  const swellTools = createSwellTools({ canvas, toolbar });
  const linkedCopyTools = createLinkedCopyTools({ canvas, toolbar });
  const arrayTools = createArrayTools({
    canvas,
    toolbar: arrayToolbar,
    derivativeSourceProviders: [
      linkedCopyTools.derivativeSourceProvider,
      ...(canvas.getDerivativeSourceProviders?.() || []),
      swellTools.derivativeSourceProvider,
    ],
  });
  canvas.registerDerivedDimensionFeatureProvider?.(linkedCopyTools.derivedDimensionProvider);
  canvas.registerDerivedDimensionFeatureProvider?.(arrayTools.derivedDimensionProvider);
  canvas.registerDerivedSelectionProvider?.(linkedCopyTools.selectionProvider);
  canvas.registerDerivedSelectionProvider?.(arrayTools.selectionProvider);
  canvas.registerSelectionPropertyProvider?.(linkedCopyTools.selectionPropertyProvider);
  canvas.registerSelectionPropertyProvider?.(arrayTools.selectionPropertyProvider);
  canvas.registerSubtractOperandProvider?.(arrayTools.subtractOperandProvider);
  return { swellTools, linkedCopyTools, arrayTools };
}
