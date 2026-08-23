import { resolveColorExpression, resolveOpacityExpression } from './AppearanceExpressions.js';
import { clampTranslatedPanelOffset } from './CanvasUIControls.js';
import { normalizeDrawingData, parseDrawingText, serializeDrawingJson } from './DrawingIO.js';
import { unitFactors, valueInUnit } from './solver/Units.js';
import { loadOpenCv, imageWorldToLocalPoint, normalizeImageTraceSettings, prepareImageTrace, tracePreparedImageRegion } from './ImageTrace.js';

// --- Image Fill System & References ---
const IMAGE_REFERENCE = /^(?:basic|user|imported)\/[A-Za-z0-9%._~!$&'()+,;=:@/-]+$/;
const CLOSED_ENTITY_TYPES = new Set(['circle', 'rect', 'polygon']);
export const IMAGE_FILL_MODES = Object.freeze(['scale', 'stretch', 'tile']);
export const DEFAULT_IMAGE_FILL_MODE = 'tile';
export const DEFAULT_IMAGE_FILL_SCALE_EXPRESSION = '100';
export const DEFAULT_IMAGE_FILL_SIZE_EXPRESSION = '';
export const DEFAULT_IMAGE_FILL_ROTATION_ANGLE = 0;
export const MAXIMUM_RUNTIME_CATALOG_IMAGE_BYTES = 128 * 1024;

const DEFAULT_IMAGE_CATALOG_RESOURCES = Object.freeze({
  manifestUrl: '',
  assetBaseUrl: '',
  readOnly: true,
});
let imageCatalogResources = DEFAULT_IMAGE_CATALOG_RESOURCES;
const runtimeCatalogImageUrls = new Map();
const runtimeCatalogReferencesByUrl = new Map();
const pendingRuntimeCatalogImages = new Map();

function clearRuntimeCatalogImages() {
  runtimeCatalogImageUrls.forEach(({ contentUrl, isObjectUrl }) => {
    if (isObjectUrl) globalThis.URL?.revokeObjectURL?.(contentUrl);
  });
  runtimeCatalogImageUrls.clear();
  runtimeCatalogReferencesByUrl.clear();
  pendingRuntimeCatalogImages.clear();
}

function absoluteResourceUrl(value) {
  const baseUrl = globalThis.location?.href || 'http://localhost/';
  return new URL(String(value), baseUrl).href;
}

function normalizedAssetBaseUrl(value) {
  const url = absoluteResourceUrl(value);
  return url.endsWith('/') ? url : `${url}/`;
}

export function configureImageCatalogResources(configuration = null) {
  clearRuntimeCatalogImages();
  if (configuration == null) {
    imageCatalogResources = DEFAULT_IMAGE_CATALOG_RESOURCES;
    return { ...imageCatalogResources };
  }
  const manifestUrl = String(configuration.manifestUrl || '').trim();
  const assetBaseUrl = String(configuration.assetBaseUrl || '').trim();
  if (!manifestUrl || !assetBaseUrl) {
    throw new Error('Static image catalog resources require both manifestUrl and assetBaseUrl.');
  }
  imageCatalogResources = Object.freeze({
    manifestUrl: absoluteResourceUrl(manifestUrl),
    assetBaseUrl: normalizedAssetBaseUrl(assetBaseUrl),
    readOnly: true,
  });
  return { ...imageCatalogResources };
}

export function getImageCatalogResourceConfiguration() {
  return { ...imageCatalogResources };
}

export function isImageFillReference(value) {
  return IMAGE_REFERENCE.test(String(value ?? '').trim());
}

function staticImageFillContentUrl(reference) {
  if (!isImageFillReference(reference)) return '';
  const normalizedReference = String(reference).trim();
  if (imageCatalogResources.assetBaseUrl && normalizedReference.startsWith('basic/')) {
    const relativePath = normalizedReference.slice('basic/'.length)
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
    return new URL(relativePath, imageCatalogResources.assetBaseUrl).href;
  }
  return '';
}

export function imageFillContentUrl(reference) {
  const normalizedReference = String(reference ?? '').trim();
  return runtimeCatalogImageUrls.get(normalizedReference)?.contentUrl
    || staticImageFillContentUrl(normalizedReference);
}

export function runtimeCatalogImageInfo(reference) {
  const info = runtimeCatalogImageUrls.get(String(reference ?? '').trim());
  return info ? { contentUrl: info.contentUrl, byteSize: info.byteSize } : null;
}

export function imageFillReferenceFromContentUrl(value) {
  const contentUrl = String(value || '').trim();
  if (!contentUrl) return null;
  const runtimeReference = runtimeCatalogReferencesByUrl.get(contentUrl);
  if (runtimeReference) return runtimeReference;
  try {
    const parsed = new URL(contentUrl, globalThis.location?.href || 'http://localhost/');
    const baseUrl = imageCatalogResources.assetBaseUrl;
    if (!baseUrl || !parsed.href.startsWith(baseUrl)) return null;
    const relativePath = parsed.href.slice(baseUrl.length).split(/[?#]/, 1)[0];
    const reference = `basic/${relativePath.split('/').map((part) => decodeURIComponent(part)).join('/')}`;
    return isImageFillReference(reference) ? reference : null;
  } catch {
    return null;
  }
}

function canvasBlob(canvas, mimeType, quality) {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: mimeType, quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('The browser could not encode the catalog image.'));
    }, mimeType, quality);
  });
}

function runtimeImageMimeType(blob) {
  const mimeType = String(blob?.type || '').split(';', 1)[0].trim().toLowerCase();
  if (mimeType === 'image/jpg') return 'image/jpeg';
  return ['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)
    ? mimeType
    : 'image/png';
}

async function decodedImageBlob(blob, createImageBitmapImpl = globalThis.createImageBitmap) {
  if (typeof createImageBitmapImpl === 'function') return createImageBitmapImpl(blob);
  if (typeof globalThis.Image !== 'function' || typeof globalThis.URL?.createObjectURL !== 'function') {
    throw new Error('This browser cannot resize catalog images.');
  }
  const source = globalThis.URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('The catalog image could not be decoded.'));
      image.src = source;
    });
  } finally {
    globalThis.URL.revokeObjectURL(source);
  }
}

export async function reduceCatalogImageBlob(blob, {
  maximumBytes = MAXIMUM_RUNTIME_CATALOG_IMAGE_BYTES,
  createImageBitmapImpl = globalThis.createImageBitmap,
  createCanvas = () => globalThis.document?.createElement('canvas'),
} = {}) {
  const byteLimit = Math.max(1, Math.floor(Number(maximumBytes) || 0));
  if (!(blob instanceof Blob)) throw new Error('Catalog image data is unavailable.');
  if (blob.size <= byteLimit) return blob;

  const decoded = await decodedImageBlob(blob, createImageBitmapImpl);
  const sourceWidth = Number(decoded.width || decoded.naturalWidth);
  const sourceHeight = Number(decoded.height || decoded.naturalHeight);
  if (!Number.isFinite(sourceWidth) || sourceWidth <= 0 || !Number.isFinite(sourceHeight) || sourceHeight <= 0) {
    decoded.close?.();
    throw new Error('The catalog image has invalid dimensions.');
  }

  const canvas = createCanvas();
  const context = canvas?.getContext?.('2d');
  if (!canvas || !context) {
    decoded.close?.();
    throw new Error('This browser cannot resize catalog images.');
  }

  const mimeType = runtimeImageMimeType(blob);
  const qualities = mimeType === 'image/png'
    ? [undefined]
    : [0.92, 0.84, 0.76, 0.68, 0.60, 0.52, 0.44, 0.36];
  let width = Math.max(1, Math.round(sourceWidth));
  let height = Math.max(1, Math.round(sourceHeight));
  let smallest = null;
  try {
    for (let pass = 0; pass < 20; pass += 1) {
      canvas.width = width;
      canvas.height = height;
      context.clearRect?.(0, 0, width, height);
      context.drawImage(decoded, 0, 0, width, height);
      for (const quality of qualities) {
        const candidate = await canvasBlob(canvas, mimeType, quality);
        if (!smallest || candidate.size < smallest.size) smallest = candidate;
        if (candidate.size <= byteLimit) return candidate;
      }
      if (width === 1 && height === 1) break;
      const ratio = Math.sqrt(byteLimit / Math.max(1, smallest.size));
      const scale = Math.max(0.1, Math.min(0.9, ratio * 0.92));
      const nextWidth = Math.max(1, Math.floor(width * scale));
      const nextHeight = Math.max(1, Math.floor(height * scale));
      width = nextWidth === width && width > 1 ? width - 1 : nextWidth;
      height = nextHeight === height && height > 1 ? height - 1 : nextHeight;
    }
  } finally {
    decoded.close?.();
  }
  throw new Error(`The catalog image could not be reduced to ${byteLimit} bytes.`);
}

export async function prepareImageFillContentUrl(reference) {
  const normalizedReference = String(reference ?? '').trim();
  const cached = runtimeCatalogImageUrls.get(normalizedReference);
  if (cached) return cached.contentUrl;
  const pending = pendingRuntimeCatalogImages.get(normalizedReference);
  if (pending) return pending;
  const sourceUrl = staticImageFillContentUrl(normalizedReference);
  if (!sourceUrl) return '';

  const preparation = (async () => {
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error(`Catalog image could not be loaded: ${normalizedReference}`);
    const sourceBlob = await response.blob();
    const runtimeBlob = await reduceCatalogImageBlob(sourceBlob);
    const isObjectUrl = runtimeBlob !== sourceBlob;
    const contentUrl = isObjectUrl ? globalThis.URL.createObjectURL(runtimeBlob) : sourceUrl;
    runtimeCatalogImageUrls.set(normalizedReference, {
      contentUrl,
      byteSize: runtimeBlob.size,
      isObjectUrl,
    });
    if (isObjectUrl) runtimeCatalogReferencesByUrl.set(contentUrl, normalizedReference);
    return contentUrl;
  })();
  pendingRuntimeCatalogImages.set(normalizedReference, preparation);
  try {
    return await preparation;
  } finally {
    pendingRuntimeCatalogImages.delete(normalizedReference);
  }
}

export function normalizeImageFillMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return IMAGE_FILL_MODES.includes(normalized) ? normalized : DEFAULT_IMAGE_FILL_MODE;
}

export function resolveImageFillRotationAngle(value = DEFAULT_IMAGE_FILL_ROTATION_ANGLE) {
  const angle = Number(value);
  if (!Number.isFinite(angle)) {
    return {
      value: DEFAULT_IMAGE_FILL_ROTATION_ANGLE,
      error: 'Image fill rotation angle must resolve to a finite number.',
    };
  }
  return { value: angle, error: null };
}

export function resolveImageFillScale(expression, evaluateNumeric = Number) {
  const scaleExpression = String(expression ?? DEFAULT_IMAGE_FILL_SCALE_EXPRESSION).trim()
    || DEFAULT_IMAGE_FILL_SCALE_EXPRESSION;
  try {
    const scale = Number(evaluateNumeric(scaleExpression));
    if (!Number.isFinite(scale) || scale <= 0 || scale > 10000) {
      throw new Error('Image scale must resolve to a number greater than 0 and no more than 10000.');
    }
    return { expression: scaleExpression, value: scale, error: null };
  } catch (error) {
    return {
      expression: scaleExpression,
      value: 100,
      error: error.message || 'Image scale must resolve to a valid percentage.',
    };
  }
}

export function resolveImageFillLength(expression, fallback, evaluateLength = Number) {
  const sizeExpression = String(expression ?? DEFAULT_IMAGE_FILL_SIZE_EXPRESSION).trim();
  if (!sizeExpression) {
    const fallbackValue = Number(fallback);
    return {
      expression: '',
      value: Number.isFinite(fallbackValue) && fallbackValue > 0 ? fallbackValue : 1,
      error: null,
    };
  }
  try {
    const value = Number(evaluateLength(sizeExpression));
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error('Tile size must resolve to a number greater than 0.');
    }
    return { expression: sizeExpression, value, error: null };
  } catch (error) {
    return {
      expression: sizeExpression,
      value: Number.isFinite(Number(fallback)) && Number(fallback) > 0 ? Number(fallback) : 1,
      error: error.message || 'Tile size must resolve to a valid length.',
    };
  }
}

export function resolveImageFillOffset(expression, evaluateLength = Number) {
  const offsetExpression = String(expression ?? '0').trim() || '0';
  try {
    const value = Number(evaluateLength(offsetExpression));
    if (!Number.isFinite(value)) throw new Error('Tile shift must resolve to a finite length.');
    return { expression: offsetExpression, value, error: null };
  } catch (error) {
    return {
      expression: offsetExpression,
      value: 0,
      error: error.message || 'Tile shift must resolve to a valid length.',
    };
  }
}

function unquoteStringLiteral(value) {
  const source = String(value ?? '').trim();
  if (source.length < 2) return source;
  const quote = source[0];
  if (!['"', "'"].includes(quote) || source[source.length - 1] !== quote) return source;
  return source.slice(1, -1).replace(/\\(['"\\])/g, '$1');
}

function resolveImageFillReference(expression, evaluateNumeric) {
  const direct = unquoteStringLiteral(expression);
  if (isImageFillReference(direct)) return direct;
  try {
    const evaluated = evaluateNumeric(expression);
    const resolved = unquoteStringLiteral(evaluated);
    return isImageFillReference(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

export function resolveGeometryFillAppearance(
  appearance = {},
  evaluateNumeric = Number,
  evaluateLength = evaluateNumeric,
) {
  const fillExpression = String(
    appearance.fillExpression
      ?? appearance.fillImageReference
      ?? appearance.fillColor
      ?? '#ffffff',
  ).trim();
  const fallbackColor = /^#[0-9a-f]{6}$/i.test(appearance.fillColor || '')
    ? appearance.fillColor.toLowerCase()
    : '#ffffff';
  const fillImageMode = normalizeImageFillMode(appearance.fillImageMode);
  const imageRotation = resolveImageFillRotationAngle(appearance.fillImageRotationAngle);
  const imageScale = resolveImageFillScale(
    appearance.fillImageScaleExpression,
    evaluateNumeric,
  );
  const pixelWidth = normalizeImageFillPixelDimension(appearance.fillImagePixelWidth);
  const pixelHeight = normalizeImageFillPixelDimension(appearance.fillImagePixelHeight);
  const legacyScale = imageScale.value / 100;
  const imageWidth = fillImageMode === 'tile'
    ? resolveImageFillLength(
      appearance.fillImageWidthExpression,
      (pixelWidth || 1) * legacyScale,
      evaluateLength,
    )
    : {
      expression: String(appearance.fillImageWidthExpression ?? '').trim(),
      value: pixelWidth || 1,
      error: null,
    };
  const imageHeight = fillImageMode === 'tile'
    ? resolveImageFillLength(
      appearance.fillImageHeightExpression,
      (pixelHeight || 1) * legacyScale,
      evaluateLength,
    )
    : {
      expression: String(appearance.fillImageHeightExpression ?? '').trim(),
      value: pixelHeight || 1,
      error: null,
    };
  const imageLeft = fillImageMode === 'tile'
    ? resolveImageFillOffset(appearance.fillImageLeftExpression, evaluateLength)
    : {
      expression: String(appearance.fillImageLeftExpression ?? '0').trim() || '0',
      value: 0,
      error: null,
    };
  const imageTop = fillImageMode === 'tile'
    ? resolveImageFillOffset(appearance.fillImageTopExpression, evaluateLength)
    : {
      expression: String(appearance.fillImageTopExpression ?? '0').trim() || '0',
      value: 0,
      error: null,
    };
  const imageFields = {
    fillImageMode,
    fillImageRotationAngle: imageRotation.value,
    fillImageScaleExpression: imageScale.expression,
    fillImageScale: imageScale.value,
    fillImageAspectRatio: normalizeImageFillAspectRatio(appearance.fillImageAspectRatio),
    fillImagePixelWidth: pixelWidth,
    fillImagePixelHeight: pixelHeight,
    fillImageWidthExpression: imageWidth.expression,
    fillImageHeightExpression: imageHeight.expression,
    fillImageWidth: imageWidth.value,
    fillImageHeight: imageHeight.value,
    fillImageLeftExpression: imageLeft.expression,
    fillImageTopExpression: imageTop.expression,
    fillImageLeft: imageLeft.value,
    fillImageTop: imageTop.value,
    imageWidthError: imageWidth.error,
    imageHeightError: imageHeight.error,
    imageLeftError: imageLeft.error,
    imageTopError: imageTop.error,
    imageRotationError: imageRotation.error,
  };
  const fillImageReference = resolveImageFillReference(fillExpression, evaluateNumeric);
  if (fillImageReference) {
    return {
      fillExpression,
      fillType: 'image',
      fillImageReference,
      ...imageFields,
      fillColor: fallbackColor,
      error: null,
      imageScaleError: null,
    };
  }
  try {
    return {
      fillExpression,
      fillType: 'color',
      fillImageReference: null,
      ...imageFields,
      fillColor: resolveColorExpression(fillExpression, evaluateNumeric),
      error: null,
      imageScaleError: null,
    };
  } catch (error) {
    return {
      fillExpression,
      fillType: 'color',
      fillImageReference: null,
      ...imageFields,
      fillColor: fallbackColor,
      error: error.message,
      imageScaleError: null,
    };
  }
}

export function updateFillAppearance(
  appearance = {},
  patchInput,
  evaluateNumeric = Number,
  evaluateLength = evaluateNumeric,
) {
  const patch = patchInput && typeof patchInput === 'object'
    ? patchInput
    : { fillExpression: patchInput };
  const candidate = { ...appearance };
  if (patch.fillExpression !== undefined) {
    const previousReference = isImageFillReference(
      appearance.fillExpression ?? appearance.fillImageReference,
    )
      ? String(appearance.fillExpression ?? appearance.fillImageReference).trim()
      : null;
    const nextExpression = String(patch.fillExpression ?? '');
    candidate.fillExpression = nextExpression;
    if (isImageFillReference(nextExpression) && nextExpression.trim() !== previousReference) {
      delete candidate.fillImageAspectRatio;
      delete candidate.fillImagePixelWidth;
      delete candidate.fillImagePixelHeight;
      delete candidate.fillImageWidthExpression;
      delete candidate.fillImageHeightExpression;
      delete candidate.fillImageLeftExpression;
      delete candidate.fillImageTopExpression;
    }
  }
  if (patch.fillImageMode !== undefined) candidate.fillImageMode = normalizeImageFillMode(patch.fillImageMode);
  if (patch.fillImageRotationAngle !== undefined) {
    candidate.fillImageRotationAngle = patch.fillImageRotationAngle;
  }
  if (patch.fillImageScaleExpression !== undefined) {
    candidate.fillImageScaleExpression = String(patch.fillImageScaleExpression ?? '');
  }
  if (patch.fillImageWidthExpression !== undefined) {
    candidate.fillImageWidthExpression = String(patch.fillImageWidthExpression ?? '').trim();
  }
  if (patch.fillImageHeightExpression !== undefined) {
    candidate.fillImageHeightExpression = String(patch.fillImageHeightExpression ?? '').trim();
  }
  if (patch.fillImageLeftExpression !== undefined) {
    candidate.fillImageLeftExpression = String(patch.fillImageLeftExpression ?? '').trim();
  }
  if (patch.fillImageTopExpression !== undefined) {
    candidate.fillImageTopExpression = String(patch.fillImageTopExpression ?? '').trim();
  }
  const resolved = resolveGeometryFillAppearance(candidate, evaluateNumeric, evaluateLength);
  return {
    appearance: {
      ...candidate,
      fillExpression: resolved.fillExpression,
      fillColor: resolved.fillColor,
      fillImageMode: resolved.fillImageMode,
      fillImageRotationAngle: resolved.fillImageRotationAngle,
      fillImageScaleExpression: resolved.fillImageScaleExpression,
      fillImageWidthExpression: resolved.fillImageWidthExpression,
      fillImageHeightExpression: resolved.fillImageHeightExpression,
      fillImageLeftExpression: resolved.fillImageLeftExpression,
      fillImageTopExpression: resolved.fillImageTopExpression,
      ...(resolved.fillType === 'image'
        ? { fillType: 'image', fillImageReference: resolved.fillImageReference }
        : { fillType: 'color', fillImageReference: null }),
    },
    error: resolved.error
      || resolved.imageWidthError
      || resolved.imageHeightError
      || resolved.imageLeftError
      || resolved.imageTopError
      || resolved.imageRotationError,
  };
}

export function imageFillSelectionProperties(appearances = [], canEditImageFill = false) {
  const imageAppearances = appearances.filter(({ fillType }) => fillType === 'image');
  const active = canEditImageFill
    && appearances.length > 0
    && imageAppearances.length === appearances.length;
  const modes = new Set(imageAppearances.map(({ fillImageMode }) => fillImageMode));
  const rotations = new Set(imageAppearances.map(({ fillImageRotationAngle }) => (
    resolveImageFillRotationAngle(fillImageRotationAngle).value
  )));
  const lefts = new Set(imageAppearances.map(({ fillImageLeftExpression }) => fillImageLeftExpression));
  const tops = new Set(imageAppearances.map(({ fillImageTopExpression }) => fillImageTopExpression));
  return {
    canEditImageFillSettings: active,
    imageFillMode: active && modes.size === 1 ? imageAppearances[0].fillImageMode : null,
    mixedImageFillMode: active && modes.size > 1,
    imageFillRotationAngle: active && rotations.size === 1
      ? [...rotations][0]
      : null,
    mixedImageFillRotationAngle: active && rotations.size > 1,
    imageFillLeftExpression: active && lefts.size === 1
      ? imageAppearances[0].fillImageLeftExpression
      : null,
    mixedImageFillLeft: active && lefts.size > 1,
    imageFillTopExpression: active && tops.size === 1
      ? imageAppearances[0].fillImageTopExpression
      : null,
    mixedImageFillTop: active && tops.size > 1,
    imageLeftError: active
      ? imageAppearances.find(({ imageLeftError }) => imageLeftError)?.imageLeftError || null
      : null,
    imageTopError: active
      ? imageAppearances.find(({ imageTopError }) => imageTopError)?.imageTopError || null
      : null,
    imageRotationError: active
      ? imageAppearances.find(({ imageRotationError }) => imageRotationError)?.imageRotationError || null
      : null,
  };
}

export function imageFillPropertiesMarkup() {
  return `<label class="property-row image-fill-property-row" for="imageFillModeProperty" hidden><span>Image Fill Mode</span><select id="imageFillModeProperty" disabled>
    <option value="tile" selected>Tiled</option>
    <option value="scale">Scale</option>
    <option value="stretch">Stretch</option>
  </select></label>
  <label class="property-row image-fill-property-row" for="imageFillRotationProperty" hidden><span>Image Fill Rotation Angle</span><input id="imageFillRotationProperty" aria-label="Image fill rotation angle" type="number" step="1" value="0" inputmode="decimal" disabled /></label>
  <label class="property-row image-fill-property-row image-fill-shift-property-row" for="imageFillLeftProperty" hidden><span>Tile Shift Left</span><input id="imageFillLeftProperty" aria-label="Tile shift left expression" list="imageFillParameterNames" type="text" value="0" autocomplete="off" spellcheck="false" disabled /></label>
  <label class="property-row image-fill-property-row image-fill-shift-property-row" for="imageFillTopProperty" hidden><span>Tile Shift Top</span><input id="imageFillTopProperty" aria-label="Tile shift top expression" list="imageFillParameterNames" type="text" value="0" autocomplete="off" spellcheck="false" disabled /><datalist id="imageFillParameterNames"></datalist></label>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export function createImageFillPropertyController({
  root,
  onChange = () => {},
  parameterNames = () => [],
} = {}) {
  const rows = [...root.querySelectorAll('.image-fill-property-row')];
  const shiftRows = [...root.querySelectorAll('.image-fill-shift-property-row')];
  const mode = root.querySelector('#imageFillModeProperty');
  const rotation = root.querySelector('#imageFillRotationProperty');
  const left = root.querySelector('#imageFillLeftProperty');
  const top = root.querySelector('#imageFillTopProperty');
  const names = root.querySelector('#imageFillParameterNames');

  const refreshNames = () => {
    names.innerHTML = [...new Set(parameterNames().filter(Boolean).map(String))]
      .map((name) => `<option value="${escapeHtml(name)}"></option>`).join('');
  };
  mode.addEventListener('change', () => onChange({ fillImageMode: mode.value }));
  rotation.addEventListener('input', () => onChange({ fillImageRotationAngle: rotation.value }));
  left.addEventListener('input', () => onChange({ fillImageLeftExpression: left.value }));
  top.addEventListener('input', () => onChange({ fillImageTopExpression: top.value }));
  [rotation, left, top].forEach((input) => {
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') input.blur(); });
    input.addEventListener('focus', refreshNames);
  });

  function update(properties = {}) {
    const visible = properties.canEditImageFillSettings === true;
    rows.forEach((row) => { row.hidden = !visible; });
    mode.disabled = !visible;
    rotation.disabled = !visible;
    left.disabled = !visible;
    top.disabled = !visible;
    mode.value = properties.imageFillMode || DEFAULT_IMAGE_FILL_MODE;
    shiftRows.forEach((row) => { row.hidden = !visible || mode.value !== 'tile'; });
    if (document.activeElement !== rotation) {
      rotation.value = properties.mixedImageFillRotationAngle
        ? ''
        : String(properties.imageFillRotationAngle ?? DEFAULT_IMAGE_FILL_ROTATION_ANGLE);
    }
    if (document.activeElement !== left) left.value = properties.imageFillLeftExpression ?? '0';
    if (document.activeElement !== top) top.value = properties.imageFillTopExpression ?? '0';
    left.placeholder = properties.mixedImageFillLeft ? 'Mixed' : '0';
    top.placeholder = properties.mixedImageFillTop ? 'Mixed' : '0';
    rotation.placeholder = properties.mixedImageFillRotationAngle ? 'Mixed' : '0';
    rotation.setAttribute('aria-invalid', String(Boolean(properties.errors?.imageRotation)));
    left.setAttribute('aria-invalid', String(Boolean(properties.errors?.imageLeft)));
    top.setAttribute('aria-invalid', String(Boolean(properties.errors?.imageTop)));
    left.title = properties.errors?.imageLeft || 'Horizontal tile-grid shift from canvas center';
    top.title = properties.errors?.imageTop || 'Vertical tile-grid shift from canvas center';
    rotation.title = properties.errors?.imageRotation || 'Rotation angle in degrees';
  }

  return { update };
}

export function closedImageFillSelection(records, selectedIds, closedCycles = []) {
  const selected = records.filter((record) => selectedIds.has(record.id));
  if (!selected.length || selected.some((record) => !['geometry', 'fillet'].includes(record.recordType) || record.entity.construction)) {
    return { canEditImageFill: false, targetIds: [] };
  }
  const closedIds = new Set(
    selected.filter((record) => CLOSED_ENTITY_TYPES.has(record.entity.type)).map((record) => record.id),
  );
  closedCycles.forEach((cycle) => {
    const ids = [...new Set(cycle.map(({ entityId }) => entityId))];
    if (ids.length && ids.every((id) => selectedIds.has(id))) ids.forEach((id) => closedIds.add(id));
  });
  const canEditImageFill = selected.length === selectedIds.size
    && selected.every((record) => closedIds.has(record.id));
  return { canEditImageFill, targetIds: canEditImageFill ? selected.map((record) => record.id) : [] };
}

function hashId(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function finiteImageFillBounds(bounds = {}) {
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  const width = Math.abs(Number(bounds.width));
  const height = Math.abs(Number(bounds.height));
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    width: Number.isFinite(width) && width > 1e-9 ? width : 1,
    height: Number.isFinite(height) && height > 1e-9 ? height : 1,
  };
}

export function imageFillBounds(value = {}) {
  if (
    Number.isFinite(Number(value.x))
    && Number.isFinite(Number(value.y))
    && Number.isFinite(Number(value.width))
    && Number.isFinite(Number(value.height))
  ) {
    return finiteImageFillBounds(value);
  }
  if (value.type === 'circle' && Array.isArray(value.center)) {
    const radius = Math.abs(Number(value.radius));
    if (Number.isFinite(radius)) {
      return finiteImageFillBounds({
        x: value.center[0] - radius,
        y: value.center[1] - radius,
        width: radius * 2,
        height: radius * 2,
      });
    }
  }
  if (value.type === 'rect') {
    return finiteImageFillBounds(value);
  }
  const points = value.points || value.polygon;
  if (Array.isArray(points) && points.length) {
    const finite = points.filter((point) => (
      Array.isArray(point)
      && Number.isFinite(Number(point[0]))
      && Number.isFinite(Number(point[1]))
    ));
    if (finite.length) {
      const xs = finite.map((point) => Number(point[0]));
      const ys = finite.map((point) => Number(point[1]));
      return finiteImageFillBounds({
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      });
    }
  }
  return finiteImageFillBounds();
}

export function normalizeImageFillAspectRatio(value) {
  const ratio = Number(value);
  return Number.isFinite(ratio) && ratio > 1e-6 && ratio < 1e6 ? ratio : 1;
}

export function normalizeImageFillPixelDimension(value) {
  const dimension = Number(value);
  return Number.isFinite(dimension) && dimension > 0 ? dimension : null;
}

export function imageFillMetricsAppearancePatch(
  appearance = {},
  metrics = {},
  formatLength = String,
) {
  const aspectRatio = normalizeImageFillAspectRatio(metrics.aspectRatio);
  const pixelWidth = normalizeImageFillPixelDimension(metrics.pixelWidth);
  const pixelHeight = normalizeImageFillPixelDimension(metrics.pixelHeight);
  let widthExpression = String(appearance.fillImageWidthExpression ?? '').trim();
  let heightExpression = String(appearance.fillImageHeightExpression ?? '').trim();
  const legacyScale = resolveImageFillScale(appearance.fillImageScaleExpression).value / 100;
  if (!widthExpression && pixelWidth) {
    widthExpression = String(formatLength(pixelWidth * legacyScale));
  }
  if (!heightExpression && pixelHeight) {
    heightExpression = String(formatLength(pixelHeight * legacyScale));
  }
  return {
    fillImageAspectRatio: aspectRatio,
    fillImagePixelWidth: pixelWidth,
    fillImagePixelHeight: pixelHeight,
    fillImageWidthExpression: widthExpression,
    fillImageHeightExpression: heightExpression,
  };
}

export function imageFillPatternDefinition(appearance = {}, boundsInput = null) {
  const reference = appearance.fillImageReference;
  const mode = normalizeImageFillMode(appearance.fillImageMode);
  const rotation = resolveImageFillRotationAngle(appearance.fillImageRotationAngle);
  const bounds = imageFillBounds(boundsInput || appearance.fillImageBounds || {});
  const pixelWidth = normalizeImageFillPixelDimension(appearance.fillImagePixelWidth);
  const pixelHeight = normalizeImageFillPixelDimension(appearance.fillImagePixelHeight);
  const aspectRatio = pixelWidth && pixelHeight
    ? normalizeImageFillAspectRatio(pixelWidth / pixelHeight)
    : normalizeImageFillAspectRatio(appearance.fillImageAspectRatio);
  const fillLargestSide = Math.max(bounds.width, bounds.height);
  const scaleImageNarrowSide = fillLargestSide;
  const requestedTileWidth = Number(appearance.fillImageWidth);
  const requestedTileHeight = Number(appearance.fillImageHeight);
  const tileWidth = Number.isFinite(requestedTileWidth) && requestedTileWidth > 0
    ? requestedTileWidth
    : pixelWidth || 1;
  const tileHeight = Number.isFinite(requestedTileHeight) && requestedTileHeight > 0
    ? requestedTileHeight
    : pixelHeight || 1;
  const tileLeft = Number.isFinite(Number(appearance.fillImageLeft))
    ? Number(appearance.fillImageLeft)
    : 0;
  const tileTop = Number.isFinite(Number(appearance.fillImageTop))
    ? Number(appearance.fillImageTop)
    : 0;
  const imageWidth = mode === 'tile'
    ? tileWidth
    : aspectRatio >= 1 ? scaleImageNarrowSide * aspectRatio : scaleImageNarrowSide;
  const imageHeight = mode === 'tile'
    ? tileHeight
    : aspectRatio >= 1 ? scaleImageNarrowSide : scaleImageNarrowSide / aspectRatio;
  const patternBounds = mode === 'tile'
    ? {
      x: tileLeft - imageWidth / 2,
      y: tileTop - imageHeight / 2,
      width: imageWidth,
      height: imageHeight,
    }
    : bounds;
  const imageBounds = mode === 'stretch'
    ? { x: 0, y: 0, width: bounds.width, height: bounds.height }
    : mode === 'tile'
      ? { x: 0, y: 0, width: patternBounds.width, height: patternBounds.height }
      : {
        x: (bounds.width - imageWidth) / 2,
        y: (bounds.height - imageHeight) / 2,
        width: imageWidth,
        height: imageHeight,
      };
  const fallback = /^#[0-9a-f]{6}$/i.test(appearance.fillColor || '')
    ? appearance.fillColor.toLowerCase()
    : '#ffffff';
  const patternCenterX = bounds.x + (bounds.width / 2);
  const patternCenterY = bounds.y + (bounds.height / 2);
  const commonPattern = {
    x: patternBounds.x,
    y: patternBounds.y,
    width: patternBounds.width,
    height: patternBounds.height,
    patternUnits: 'userSpaceOnUse',
    patternContentUnits: 'userSpaceOnUse',
    viewBox: `0 0 ${patternBounds.width} ${patternBounds.height}`,
    preserveAspectRatio: 'none',
    overflow: 'hidden',
    patternTransform: `rotate(${rotation.value} ${patternCenterX} ${patternCenterY})`,
    'data-image-fill-reference': reference,
    'data-image-fill-mode': mode,
    'data-image-fill-rotation-angle': rotation.value,
    ...(mode === 'tile' ? {
      'data-image-fill-width': imageWidth,
      'data-image-fill-height': imageHeight,
      'data-image-fill-left': tileLeft,
      'data-image-fill-top': tileTop,
    } : {}),
  };
  return {
    key: [
      reference,
      mode,
      rotation.value,
      mode === 'tile' ? appearance.fillImageWidthExpression || imageWidth : '',
      mode === 'tile' ? appearance.fillImageHeightExpression || imageHeight : '',
      mode === 'tile' ? appearance.fillImageLeftExpression || tileLeft : '',
      mode === 'tile' ? appearance.fillImageTopExpression || tileTop : '',
      fallback,
      aspectRatio,
      pixelWidth || '',
      pixelHeight || '',
      mode === 'tile' ? '' : bounds.x,
      mode === 'tile' ? '' : bounds.y,
      mode === 'tile' ? '' : bounds.width,
      mode === 'tile' ? '' : bounds.height,
    ].join('|'),
    pattern: commonPattern,
    rect: {
      x: 0,
      y: 0,
      width: patternBounds.width,
      height: patternBounds.height,
      fill: fallback,
    },
    image: {
      ...imageBounds,
      preserveAspectRatio: mode === 'scale' ? 'xMidYMid meet' : 'none',
      href: imageFillContentUrl(reference),
    },
  };
}

export function imageFillPatternId(appearance = {}, prefix = 'image-fill', bounds = null) {
  return `${prefix}-${hashId(imageFillPatternDefinition(appearance, bounds).key)}`;
}

export function createImageFillSystem({
  defs,
  addSvg,
  onImageAspectRatio = () => {},
  onImageMetrics = () => {},
} = {}) {
  const patterns = new Map();
  const metricsByReference = new Map();
  const loadingReferences = new Set();

  function setAttributes(node, attributes) {
    Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value));
  }

  function setPatternAttributes(node, attributes) {
    [
      'data-image-fill-width',
      'data-image-fill-height',
      'data-image-fill-left',
      'data-image-fill-top',
      'data-image-fill-scale',
      'data-image-fill-rotation-angle',
      'patternTransform',
    ]
      .filter((name) => !Object.hasOwn(attributes, name))
      .forEach((name) => node.removeAttribute(name));
    setAttributes(node, attributes);
  }

  async function requestAspectRatio(reference) {
    if (
      metricsByReference.has(reference)
      || loadingReferences.has(reference)
      || typeof globalThis.Image !== 'function'
    ) return;
    loadingReferences.add(reference);
    let contentUrl;
    try {
      contentUrl = await prepareImageFillContentUrl(reference);
      patterns.forEach((entry) => {
        if (entry.reference !== reference) return;
        entry.image.setAttribute('href', contentUrl);
        entry.image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', contentUrl);
        const info = runtimeCatalogImageInfo(reference);
        if (info) entry.image.setAttribute('data-runtime-catalog-byte-size', info.byteSize);
      });
    } catch {
      loadingReferences.delete(reference);
      return;
    }
    const loader = new Image();
    loader.onload = () => {
      loadingReferences.delete(reference);
      const metrics = {
        aspectRatio: normalizeImageFillAspectRatio(loader.naturalWidth / loader.naturalHeight),
        pixelWidth: normalizeImageFillPixelDimension(loader.naturalWidth),
        pixelHeight: normalizeImageFillPixelDimension(loader.naturalHeight),
      };
      metricsByReference.set(reference, metrics);
      patterns.forEach((entry) => {
        if (entry.reference !== reference) return;
        entry.appearance.fillImageAspectRatio = metrics.aspectRatio;
        entry.appearance.fillImagePixelWidth = metrics.pixelWidth;
        entry.appearance.fillImagePixelHeight = metrics.pixelHeight;
        const legacyScale = resolveImageFillScale(
          entry.appearance.fillImageScaleExpression,
        ).value / 100;
        if (!String(entry.appearance.fillImageWidthExpression ?? '').trim()) {
          entry.appearance.fillImageWidth = (metrics.pixelWidth || 1) * legacyScale;
        }
        if (!String(entry.appearance.fillImageHeightExpression ?? '').trim()) {
          entry.appearance.fillImageHeight = (metrics.pixelHeight || 1) * legacyScale;
        }
        const definition = imageFillPatternDefinition(entry.appearance, entry.bounds);
        setPatternAttributes(entry.pattern, definition.pattern);
        setAttributes(entry.rect, definition.rect);
        setAttributes(entry.image, definition.image);
      });
      onImageAspectRatio(reference, metrics.aspectRatio);
      onImageMetrics(reference, metrics);
    };
    loader.onerror = () => loadingReferences.delete(reference);
    loader.src = contentUrl;
  }

  function ensurePattern(entity, appearance, boundsInput = null, instanceKey = null) {
    const reference = appearance.fillImageReference;
    const bounds = imageFillBounds(boundsInput || entity);
    const metrics = metricsByReference.get(reference);
    const resolvedAppearance = {
      ...appearance,
      fillImageAspectRatio: metrics?.aspectRatio || appearance.fillImageAspectRatio,
      fillImagePixelWidth: metrics?.pixelWidth || appearance.fillImagePixelWidth,
      fillImagePixelHeight: metrics?.pixelHeight || appearance.fillImagePixelHeight,
    };
    const definition = imageFillPatternDefinition(resolvedAppearance, bounds);
    const stableKey = String(instanceKey || entity?.id || definition.key);
    const existing = patterns.get(stableKey);
    if (existing) {
      existing.reference = reference;
      existing.appearance = resolvedAppearance;
      existing.bounds = bounds;
      setPatternAttributes(existing.pattern, definition.pattern);
      setAttributes(existing.rect, definition.rect);
      setAttributes(existing.image, definition.image);
      existing.image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', definition.image.href);
      requestAspectRatio(reference);
      return existing.paint;
    }
    const id = `image-fill-${hashId(stableKey)}`;
    const pattern = addSvg(defs, 'pattern', {
      id,
      ...definition.pattern,
    });
    const rect = addSvg(pattern, 'rect', definition.rect);
    const image = addSvg(pattern, 'image', definition.image);
    image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', definition.image.href);
    const paint = `url(#${id})`;
    patterns.set(stableKey, {
      reference,
      appearance: resolvedAppearance,
      bounds,
      pattern,
      rect,
      image,
      paint,
    });
    requestAspectRatio(reference);
    return paint;
  }

  function paintFor(entity, appearance = {}, bounds = null, instanceKey = null) {
    return appearance.fillType === 'image' && isImageFillReference(appearance.fillImageReference)
      ? ensurePattern(entity, appearance, bounds, instanceKey)
      : appearance.fillColor;
  }

  function clear() {
    patterns.clear();
    defs.querySelectorAll?.('[data-image-fill-reference]').forEach((pattern) => pattern.remove());
  }

  return { clear, paintFor };
}

// --- Image Catalog Management ---
async function requestJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Image catalog request failed');
  return body;
}

function basicImageMimeType(fileName) {
  const extension = String(fileName).split('.').at(-1)?.toLowerCase();
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  return 'image/jpeg';
}

function normalizeManifestAsset(value, index) {
  const asset = typeof value === 'string' ? { reference: value } : value;
  if (!asset || typeof asset !== 'object') {
    throw new Error(`Image catalog manifest asset ${index + 1} is invalid.`);
  }
  const reference = String(asset.reference || '').trim();
  if (!reference.startsWith('basic/') || !isImageFillReference(reference)) {
    throw new Error(`Image catalog manifest asset ${index + 1} has an invalid basic reference.`);
  }
  const relativePath = reference.slice('basic/'.length);
  const parts = relativePath.split('/');
  const fileName = parts.at(-1);
  const derivedName = fileName.replace(/\.[^.]+$/, '');
  const width = Number(asset.standardTileWidth);
  const height = Number(asset.standardTileHeight);
  return {
    id: reference,
    scope: 'basic',
    reference,
    name: String(asset.name || derivedName),
    category: String(asset.category || (parts.length > 1 ? parts.slice(0, -1).join(' / ') : 'Basic')),
    fileName,
    mimeType: String(asset.mimeType || basicImageMimeType(fileName)),
    sha256: null,
    byteSize: null,
    removable: false,
    contentUrl: imageFillContentUrl(reference),
    standardTileWidth: Number.isFinite(width) && width > 0 ? width : null,
    standardTileHeight: Number.isFinite(height) && height > 0 ? height : null,
  };
}

async function loadManifestImageCatalog() {
  const manifest = await requestJson(imageCatalogResources.manifestUrl);
  const values = Array.isArray(manifest) ? manifest : manifest.assets;
  if (!Array.isArray(values)) throw new Error('Image catalog manifest must contain an assets array.');
  const basic = values.map(normalizeManifestAsset);
  const references = new Set();
  basic.forEach((asset) => {
    if (references.has(asset.reference)) {
      throw new Error(`Image catalog manifest contains duplicate reference: ${asset.reference}`);
    }
    references.add(asset.reference);
  });
  basic.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return { basic, user: [], imported: [] };
}

export async function loadImageCatalog() {
  if (!imageCatalogResources.manifestUrl) {
    throw new Error('Static image catalog resources are not configured.');
  }
  return loadManifestImageCatalog();
}

export function catalogImageFillSizePatch(asset = {}, formatLength = String) {
  const width = Number(asset.standardTileWidth);
  const height = Number(asset.standardTileHeight);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return {};
  }
  return {
    fillImageWidthExpression: String(formatLength(width)),
    fillImageHeightExpression: String(formatLength(height)),
  };
}

async function digestHex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function importPortableCatalogImage(asset) {
  if (isImageFillReference(asset.reference)) {
    try {
      const contentUrl = staticImageFillContentUrl(asset.reference);
      if (!contentUrl) throw new Error('Image reference is not available.');
      const existing = await fetch(contentUrl);
      if (existing.ok) {
        const bytes = new Uint8Array(await existing.arrayBuffer());
        if (await digestHex(bytes) === String(asset.sha256).toLowerCase()) return asset.reference;
      }
    } catch {
      // The original reference is not available in this installation.
    }
  }
  throw new Error('Importing document images is not configured for this application.');
}

export function createImageCatalog({
  button,
  onSelect,
  onError = () => {},
  getDrawingUnit = () => 'in',
  formatLength = String,
  evaluateLength = Number,
  title = 'Image Fill',
  sizeUsage = 'fills',
}) {
  let backdrop = null;
  let selectedAsset = null;

  function close() {
    backdrop?.remove();
    backdrop = null;
    selectedAsset = null;
  }

  function assetMarkup(asset) {
    return `<article class="image-catalog-item" data-image-reference="${escapeHtml(asset.reference)}">
      <button type="button" class="image-catalog-thumb" title="Set size and use ${escapeHtml(asset.name)}">
        <img src="${escapeHtml(asset.contentUrl)}" alt="" />
        <span>${escapeHtml(asset.name)}</span>
      </button>
    </article>`;
  }

  function sectionMarkup(title, assets, scope) {
    const groups = new Map();
    assets.forEach((asset) => {
      const category = asset.category || title;
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(asset);
    });
    return `<section class="image-catalog-section" data-image-scope="${scope}"><h3>${escapeHtml(title)}</h3>${
      [...groups].map(([category, items]) => `<div class="image-catalog-category"><h4>${escapeHtml(category)}</h4><div class="image-catalog-grid">${items.map(assetMarkup).join('')}</div></div>`).join('')
    }${assets.length ? '' : '<p class="image-catalog-empty">No images yet.</p>'}</section>`;
  }

  function editorElements() {
    return {
      editor: backdrop.querySelector('.image-catalog-editor'),
      image: backdrop.querySelector('.image-catalog-editor-image'),
      name: backdrop.querySelector('.image-catalog-editor-name'),
      unit: backdrop.querySelector('.image-catalog-editor-unit'),
      width: backdrop.querySelector('.image-catalog-standard-width'),
      height: backdrop.querySelector('.image-catalog-standard-height'),
      status: backdrop.querySelector('.image-catalog-editor-status'),
    };
  }

  function selectAsset(asset) {
    selectedAsset = asset;
    backdrop.querySelectorAll('.image-catalog-item').forEach((item) => {
      item.classList.toggle('selected', item.dataset.imageReference === asset.reference);
    });
    const elements = editorElements();
    elements.editor.hidden = false;
    elements.image.src = asset.contentUrl;
    elements.image.alt = '';
    elements.name.textContent = asset.name;
    elements.unit.textContent = getDrawingUnit() || '';
    elements.width.value = Number.isFinite(Number(asset.standardTileWidth))
      && Number(asset.standardTileWidth) > 0
      ? String(formatLength(Number(asset.standardTileWidth)))
      : '';
    elements.height.value = Number.isFinite(Number(asset.standardTileHeight))
      && Number(asset.standardTileHeight) > 0
      ? String(formatLength(Number(asset.standardTileHeight)))
      : '';
    elements.status.textContent = asset.standardTileWidth && asset.standardTileHeight
      ? `This standard size is used for new ${sizeUsage}.`
      : 'No standard size has been saved for this image.';
    elements.status.classList.remove('error');
  }

  function editorSize({ allowEmpty = false } = {}) {
    const elements = editorElements();
    const widthExpression = elements.width.value.trim();
    const heightExpression = elements.height.value.trim();
    if (allowEmpty && !widthExpression && !heightExpression) return null;
    if (!widthExpression || !heightExpression) {
      throw new Error('Enter both a standard tile width and height.');
    }
    const standardTileWidth = Number(evaluateLength(widthExpression));
    const standardTileHeight = Number(evaluateLength(heightExpression));
    if (!Number.isFinite(standardTileWidth) || standardTileWidth <= 0) {
      throw new Error('Standard tile width must be greater than 0.');
    }
    if (!Number.isFinite(standardTileHeight) || standardTileHeight <= 0) {
      throw new Error('Standard tile height must be greater than 0.');
    }
    return { standardTileWidth, standardTileHeight };
  }

  async function saveSelectedSize({ allowEmpty = false } = {}) {
    if (!selectedAsset) throw new Error('Select an image first.');
    const size = editorSize({ allowEmpty });
    if (!size) return selectedAsset;
    selectedAsset = { ...selectedAsset, ...size };
    const elements = editorElements();
    elements.status.textContent = `This size will be used for the selected ${sizeUsage.replace(/s$/, '')}.`;
    elements.status.classList.remove('error');
    return selectedAsset;
  }

  function showEditorError(error) {
    const status = backdrop?.querySelector('.image-catalog-editor-status');
    if (status) {
      status.textContent = error.message || String(error);
      status.classList.add('error');
    }
  }

  async function render(preferredReference = selectedAsset?.reference) {
    const catalog = await loadImageCatalog();
    const assets = [...catalog.basic, ...catalog.user, ...catalog.imported];
    const content = backdrop.querySelector('.image-catalog-content');
    content.innerHTML = `${sectionMarkup('Basic Images', catalog.basic, 'basic')}${sectionMarkup('My Images', catalog.user, 'user')}${sectionMarkup('Imported Images', catalog.imported, 'imported')}`;
    content.querySelectorAll('[data-image-reference]').forEach((item) => {
      item.querySelector('.image-catalog-thumb').addEventListener('click', () => {
        const asset = assets.find(({ reference }) => reference === item.dataset.imageReference);
        if (asset) selectAsset(asset);
      });
    });
    const preferred = assets.find(({ reference }) => reference === preferredReference);
    if (preferred) selectAsset(preferred);
  }

  async function open() {
    if (backdrop) return;
    backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop image-catalog-backdrop';
    backdrop.innerHTML = `<div class="modal image-catalog-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)} Catalog">
      <button type="button" class="close image-catalog-close" aria-label="Close" title="Close">&times;</button>
      <div class="image-catalog-heading"><h2>${escapeHtml(title)}</h2></div>
      <section class="image-catalog-editor" aria-label="Selected image standard tile size" hidden>
        <img class="image-catalog-editor-image" alt="" />
        <div class="image-catalog-editor-fields">
          <strong class="image-catalog-editor-name"></strong>
          <span class="image-catalog-editor-size-label">Standard tile size (<span class="image-catalog-editor-unit"></span>)</span>
          <label>Width<input class="image-catalog-standard-width" aria-label="Standard tile width" type="text" autocomplete="off" spellcheck="false" /></label>
          <label>Height<input class="image-catalog-standard-height" aria-label="Standard tile height" type="text" autocomplete="off" spellcheck="false" /></label>
          <p class="image-catalog-editor-status" aria-live="polite"></p>
        </div>
        <div class="image-catalog-editor-actions">
          <button type="button" class="image-catalog-use-image">Use Image</button>
        </div>
      </section>
      <div class="image-catalog-content"><p>Loading images...</p></div>
    </div>`;
    document.body.appendChild(backdrop);
    backdrop.querySelector('.image-catalog-close').addEventListener('click', close);
    backdrop.addEventListener('pointerdown', (event) => { if (event.target === backdrop) close(); });
    backdrop.querySelector('.image-catalog-use-image').addEventListener('click', async () => {
      try {
        const asset = await saveSelectedSize({ allowEmpty: true });
        const elements = editorElements();
        elements.status.textContent = 'Preparing image for the drawing...';
        elements.status.classList.remove('error');
        await prepareImageFillContentUrl(asset.reference);
        onSelect(asset.reference, catalogImageFillSizePatch(asset, formatLength));
        close();
      } catch (error) { showEditorError(error); }
    });
    try { await render(); } catch (error) { onError(error); close(); }
  }

  button.addEventListener('click', open);
  return { open, close };
}

// --- Image Warp Geometry ---
const cloneWarp = (value) => JSON.parse(JSON.stringify(value));
const minimumWarpDimension = 24;
const minimumWarpTargetDimension = 0.001;
const maximumWarpPixels = 12_000_000;
const minimumDirectionLength = 0.000001;
const defaultVectorHandleFraction = 0.25;
const selectedVectorHandleFraction = 0.45;

const finiteWarp = (value, fallback) => {
  if (typeof value === 'string' && !value.trim()) return fallback;
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
};
const clampDimension = (value, fallback) => Math.max(minimumWarpDimension, Math.abs(finiteWarp(value, fallback)));
const clampTargetDimension = (value, fallback) => Math.max(minimumWarpTargetDimension, Math.abs(finiteWarp(value, fallback)));

function defaultGuide(width, height) {
  const insetX = width * 0.15;
  const insetY = height * 0.15;
  return [
    [-width / 2 + insetX, -height / 2 + insetY],
    [width / 2 - insetX, -height / 2 + insetY],
    [width / 2 - insetX, height / 2 - insetY],
    [-width / 2 + insetX, height / 2 - insetY],
  ];
}

const subtractWarpPoints = (a, b) => [a[0] - b[0], a[1] - b[1]];
const addWarpPoints = (a, b) => [a[0] + b[0], a[1] + b[1]];
const scaleVector = (vector, amount) => [vector[0] * amount, vector[1] * amount];
const crossProduct = (a, b) => a[0] * b[1] - a[1] * b[0];
const vectorLength = (vector) => Math.hypot(vector[0], vector[1]);
const edgeEndIndex = (edgeIndex) => (edgeIndex + 1) % 4;

function edgeVectorsFromPoints(points) {
  return points.map((point, index) => (
    scaleVector(subtractWarpPoints(points[edgeEndIndex(index)], point), defaultVectorHandleFraction)
  ));
}

function signedPolygonArea(points) {
  return points.reduce((sum, point, index) => {
    const next = points[edgeEndIndex(index)];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;
}

function isConvexPolygon(points) {
  let sign = 0;
  for (let index = 0; index < 4; index += 1) {
    const first = points[index];
    const second = points[(index + 1) % 4];
    const third = points[(index + 2) % 4];
    const turn = crossProduct(subtractWarpPoints(second, first), subtractWarpPoints(third, second));
    if (Math.abs(turn) <= minimumDirectionLength) return false;
    const nextSign = Math.sign(turn);
    if (sign && nextSign !== sign) return false;
    sign = nextSign;
  }
  return true;
}

export function validateWarpGuideVectors(points) {
  if (!Array.isArray(points) || points.length !== 4) {
    return { valid: false, reason: 'missing', message: 'Warp polygon data is incomplete.', edgeIndex: null };
  }
  if (Math.abs(signedPolygonArea(points)) <= minimumDirectionLength || !isConvexPolygon(points)) {
    return { valid: false, reason: 'polygon', message: 'The warp polygon must remain a convex four-corner shape.', edgeIndex: null };
  }
  for (let index = 0; index < 4; index += 1) {
    const edge = subtractWarpPoints(points[edgeEndIndex(index)], points[index]);
    if (vectorLength(edge) < minimumDirectionLength) {
      return { valid: false, reason: 'short', message: `Edge ${index + 1} is too short to define a warp vector.`, edgeIndex: index };
    }
  }
  return { valid: true, reason: null, message: '', edgeIndex: null };
}

export function warpVectorHandlePoints(input = {}, selectedCornerIndex = null) {
  const warp = normalizeWarpSettings(input);
  const handles = [null, null, null, null];
  if (!Number.isInteger(selectedCornerIndex) || selectedCornerIndex < 0 || selectedCornerIndex > 3) return handles;
  const previousCornerIndex = (selectedCornerIndex + 3) % 4;
  const connectedEdges = [previousCornerIndex, selectedCornerIndex];
  connectedEdges.forEach((edgeIndex) => {
    const otherCornerIndex = edgeIndex === selectedCornerIndex ? edgeEndIndex(edgeIndex) : edgeIndex;
    handles[edgeIndex] = addWarpPoints(
      warp.points[selectedCornerIndex],
      scaleVector(
        subtractWarpPoints(warp.points[otherCornerIndex], warp.points[selectedCornerIndex]),
        selectedVectorHandleFraction,
      ),
    );
  });
  return handles;
}

export function normalizeWarpSettings(input = {}, entity = {}) {
  const width = clampDimension(entity.width, 240);
  const height = clampDimension(entity.height, 160);
  const points = Array.isArray(input.points) && input.points.length === 4
    ? input.points.map((point, index) => [
      finiteWarp(point?.[0], defaultGuide(width, height)[index][0]),
      finiteWarp(point?.[1], defaultGuide(width, height)[index][1]),
    ])
    : defaultGuide(width, height);
  return {
    enabled: Boolean(input.enabled),
    source: String(input.source || entity.source || ''),
    sourceDisplayWidth: clampDimension(input.sourceDisplayWidth, width),
    sourceDisplayHeight: clampDimension(input.sourceDisplayHeight, height),
    targetWidth: clampTargetDimension(input.targetWidth, vectorLength(subtractWarpPoints(points[1], points[0])) || width * 0.7),
    targetHeight: clampTargetDimension(input.targetHeight, vectorLength(subtractWarpPoints(points[2], points[1])) || height * 0.7),
    points,
    edgeVectors: edgeVectorsFromPoints(points),
  };
}

export function rebaseWarpSettings(input = {}, entity = {}) {
  const warp = normalizeWarpSettings(input, entity);
  const width = clampDimension(entity.width, warp.sourceDisplayWidth);
  const height = clampDimension(entity.height, warp.sourceDisplayHeight);
  const scaleX = width / warp.sourceDisplayWidth;
  const scaleY = height / warp.sourceDisplayHeight;
  return {
    ...warp,
    sourceDisplayWidth: width,
    sourceDisplayHeight: height,
    points: warp.points.map(([x, y]) => [x * scaleX, y * scaleY]),
    edgeVectors: warp.edgeVectors.map(([x, y]) => [x * scaleX, y * scaleY]),
  };
}

export function enableWarpSettings(entity) {
  return {
    ...rebaseWarpSettings(entity.warp || {}, entity),
    enabled: true,
    source: entity.warp?.source || entity.source,
  };
}

export function toggleWarpSettings(entity) {
  const warp = normalizeWarpSettings(entity.warp || {}, entity);
  return { ...warp, enabled: !warp.enabled, source: warp.source || entity.source };
}

export function moveWarpGuideCorner(input, cornerIndex, point) {
  const warp = normalizeWarpSettings(input);
  const points = warp.points.map((item) => [...item]);
  if (Number.isInteger(cornerIndex) && cornerIndex >= 0 && cornerIndex < 4) {
    points[cornerIndex] = [finiteWarp(point?.[0], points[cornerIndex][0]), finiteWarp(point?.[1], points[cornerIndex][1])];
  }
  return normalizeWarpSettings({ ...warp, points, edgeVectors: edgeVectorsFromPoints(points) });
}

export function moveWarpGuideVector(input, selectedCornerIndex, edgeIndex, point) {
  const warp = normalizeWarpSettings(input);
  if (!Number.isInteger(selectedCornerIndex) || selectedCornerIndex < 0 || selectedCornerIndex > 3) return warp;
  const previousEdgeIndex = (selectedCornerIndex + 3) % 4;
  if (edgeIndex !== previousEdgeIndex && edgeIndex !== selectedCornerIndex) return warp;
  const points = warp.points.map((item) => [...item]);
  const otherCornerIndex = edgeIndex === selectedCornerIndex ? edgeEndIndex(edgeIndex) : edgeIndex;
  const anchor = points[selectedCornerIndex];
  const currentVector = subtractWarpPoints(points[otherCornerIndex], anchor);
  const currentLength = vectorLength(currentVector);
  const attemptedVector = [
    finiteWarp(point?.[0], anchor[0] + currentVector[0]) - anchor[0],
    finiteWarp(point?.[1], anchor[1] + currentVector[1]) - anchor[1],
  ];
  const attemptedLength = vectorLength(attemptedVector);
  if (currentLength < minimumDirectionLength || attemptedLength < minimumDirectionLength) return warp;
  points[otherCornerIndex] = addWarpPoints(anchor, scaleVector(attemptedVector, currentLength / attemptedLength));
  return normalizeWarpSettings({ ...warp, points });
}

export function setWarpDimension(input, axis, value) {
  const warp = normalizeWarpSettings(input);
  return axis === 'height'
    ? { ...warp, targetHeight: clampTargetDimension(value, warp.targetHeight) }
    : { ...warp, targetWidth: clampTargetDimension(value, warp.targetWidth) };
}

function normalizeLengthUnit(unit = '') {
  const normalized = String(unit || '').trim().toLowerCase();
  if (normalized === '"' || normalized === 'inch' || normalized === 'inches') return 'in';
  if (normalized === 'foot' || normalized === 'feet') return 'ft';
  if (normalized === 'millimeter' || normalized === 'millimeters') return 'mm';
  return unitFactors[normalized] && normalized !== 'deg' ? normalized : '';
}

function lengthValueToDrawingUnits(value, unit = '') {
  const normalized = normalizeLengthUnit(unit);
  const number = finiteWarp(value, 0);
  return normalized ? number * unitFactors[normalized] : number;
}

export function formatWarpDimension(value, unit = '') {
  const normalized = normalizeLengthUnit(unit);
  const number = normalized ? valueInUnit(value, normalized) : finiteWarp(value, 0);
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/\.?0+$/, '');
}

export function formatWarpDimensionWithUnit(value, unit = '') {
  const suffix = normalizeLengthUnit(unit);
  return suffix ? `${formatWarpDimension(value, suffix)} ${suffix}` : formatWarpDimension(value);
}

export function parseWarpDimensionInput(value, fallback, defaultUnit = '') {
  const source = String(value ?? '').trim();
  if (!source) return fallback;
  const match = source.match(/^(-?(?:\d+(?:\.\d*)?|\.\d+))(?:\s*("|in|inch|inches|mm|millimeter|millimeters|cm|m|ft|foot|feet))?$/i);
  if (!match) return fallback;
  return lengthValueToDrawingUnits(Number(match[1]), match[2] || defaultUnit);
}

function loadWarpImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load the image for perspective warp.'));
    image.src = source;
  });
}

function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const a = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    }
    if (Math.abs(a[pivot][column]) < 1e-10) throw new Error('Warp guide points are too close to a singular perspective transform.');
    [a[column], a[pivot]] = [a[pivot], a[column]];
    const divisor = a[column][column];
    for (let item = column; item <= size; item += 1) a[column][item] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = a[row][column];
      for (let item = column; item <= size; item += 1) a[row][item] -= factor * a[column][item];
    }
  }
  return a.map((row) => row[size]);
}

export function perspectiveTransformFromPoints(sourcePoints, destinationPoints) {
  const matrix = [];
  const vector = [];
  sourcePoints.forEach(([x, y], index) => {
    const [u, v] = destinationPoints[index];
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    vector.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    vector.push(v);
  });
  const [a, b, c, d, e, f, g, h] = solveLinearSystem(matrix, vector);
  return [a, b, c, d, e, f, g, h, 1];
}

export function transformPerspectivePoint(matrix, [x, y]) {
  const denominator = matrix[6] * x + matrix[7] * y + matrix[8];
  return [
    (matrix[0] * x + matrix[1] * y + matrix[2]) / denominator,
    (matrix[3] * x + matrix[4] * y + matrix[5]) / denominator,
  ];
}

function invert3x3(matrix) {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const A = e * i - f * h;
  const B = c * h - b * i;
  const C = b * f - c * e;
  const D = f * g - d * i;
  const E = a * i - c * g;
  const F = c * d - a * f;
  const G = d * h - e * g;
  const H = b * g - a * h;
  const I = a * e - b * d;
  const determinant = a * A + b * D + c * G;
  if (Math.abs(determinant) < 1e-10) throw new Error('Warp transform could not be inverted.');
  return [A, B, C, D, E, F, G, H, I].map((value) => value / determinant);
}

export function localPointToSourcePixel(point, warp, sourceWidth, sourceHeight) {
  return [
    (point[0] + warp.sourceDisplayWidth / 2) / warp.sourceDisplayWidth * sourceWidth,
    (point[1] + warp.sourceDisplayHeight / 2) / warp.sourceDisplayHeight * sourceHeight,
  ];
}

function scaledPerspectiveTransform(matrix, scale) {
  return [
    matrix[0] * scale,
    matrix[1] * scale,
    matrix[2] * scale,
    matrix[3] * scale,
    matrix[4] * scale,
    matrix[5] * scale,
    matrix[6],
    matrix[7],
    matrix[8],
  ];
}

export function calculateWarpPlan(entity, image) {
  const warp = normalizeWarpSettings(entity.warp || {}, entity);
  const guideValidation = validateWarpGuideVectors(warp.points);
  if (!guideValidation.valid) throw new Error(guideValidation.message);
  const scaleX = image.naturalWidth / warp.sourceDisplayWidth;
  const scaleY = image.naturalHeight / warp.sourceDisplayHeight;
  const targetPixelWidth = Math.max(1, warp.targetWidth * scaleX);
  const targetPixelHeight = Math.max(1, warp.targetHeight * scaleY);
  const sourceQuad = warp.points.map((point) => localPointToSourcePixel(point, warp, image.naturalWidth, image.naturalHeight));
  const destinationQuad = [[0, 0], [targetPixelWidth, 0], [targetPixelWidth, targetPixelHeight], [0, targetPixelHeight]];
  const sourceToDestination = perspectiveTransformFromPoints(sourceQuad, destinationQuad);
  const projectedCorners = [[0, 0], [image.naturalWidth, 0], [image.naturalWidth, image.naturalHeight], [0, image.naturalHeight]]
    .map((point) => transformPerspectivePoint(sourceToDestination, point));
  const minX = Math.min(...projectedCorners.map((point) => point[0]));
  const minY = Math.min(...projectedCorners.map((point) => point[1]));
  const maxX = Math.max(...projectedCorners.map((point) => point[0]));
  const maxY = Math.max(...projectedCorners.map((point) => point[1]));
  const baseOutputWidth = Math.max(1, Math.ceil(maxX - minX));
  const baseOutputHeight = Math.max(1, Math.ceil(maxY - minY));
  if (![baseOutputWidth, baseOutputHeight, minX, minY, maxX, maxY].every(Number.isFinite)) {
    throw new Error('The warp guide projects the image beyond a stable perspective range. Move the guide points away from a vanishing line.');
  }
  const translatedSourceToDestination = [
    sourceToDestination[0] - minX * sourceToDestination[6],
    sourceToDestination[1] - minX * sourceToDestination[7],
    sourceToDestination[2] - minX * sourceToDestination[8],
    sourceToDestination[3] - minY * sourceToDestination[6],
    sourceToDestination[4] - minY * sourceToDestination[7],
    sourceToDestination[5] - minY * sourceToDestination[8],
    sourceToDestination[6],
    sourceToDestination[7],
    sourceToDestination[8],
  ];
  const rasterScale = Math.min(1, Math.sqrt(maximumWarpPixels / (baseOutputWidth * baseOutputHeight)));
  const rasterSourceToDestination = scaledPerspectiveTransform(translatedSourceToDestination, rasterScale);
  const outputWidth = Math.max(1, Math.ceil(baseOutputWidth * rasterScale));
  const outputHeight = Math.max(1, Math.ceil(baseOutputHeight * rasterScale));
  return {
    warp,
    sourceQuad,
    destinationQuad,
    sourceToDestination: translatedSourceToDestination,
    rasterSourceToDestination,
    destinationToSource: invert3x3(rasterSourceToDestination),
    rasterScale,
    baseOutputWidth,
    baseOutputHeight,
    outputWidth,
    outputHeight,
    displayWidth: baseOutputWidth / scaleX,
    displayHeight: baseOutputHeight / scaleY,
  };
}

export async function projectFullImageWarpBounds(entity) {
  const image = await loadWarpImage(normalizeWarpSettings(entity.warp || {}, entity).source || entity.source);
  return calculateWarpPlan(entity, image);
}

async function warpWithOpenCv(entity) {
  const cv = await loadOpenCv();
  const source = normalizeWarpSettings(entity.warp || {}, entity).source || entity.source;
  const image = await loadWarpImage(source);
  const plan = calculateWarpPlan(entity, image);
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = image.naturalWidth;
  sourceCanvas.height = image.naturalHeight;
  sourceCanvas.getContext('2d').drawImage(image, 0, 0);
  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = plan.outputWidth;
  outputCanvas.height = plan.outputHeight;
  const src = cv.imread(sourceCanvas);
  const dst = new cv.Mat();
  const matrix = cv.matFromArray(3, 3, cv.CV_64F, plan.rasterSourceToDestination);
  try {
    cv.warpPerspective(src, dst, matrix, new cv.Size(plan.outputWidth, plan.outputHeight), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
    cv.imshow(outputCanvas, dst);
  } finally {
    src.delete();
    dst.delete();
    matrix.delete();
  }
  return { source: outputCanvas.toDataURL('image/png'), width: plan.displayWidth, height: plan.displayHeight };
}

export async function warpImageEntity(input) {
  const entity = cloneWarp(input);
  const warp = normalizeWarpSettings(entity.warp || {}, entity);
  const originalSource = String(entity.originalSource || warp.originalSource || warp.source || entity.source || '');
  const originalWidth = clampDimension(entity.originalWidth ?? warp.originalWidth, entity.baseWidth || entity.width);
  const originalHeight = clampDimension(entity.originalHeight ?? warp.originalHeight, entity.baseHeight || entity.height);
  entity.warp = warp;
  const result = await warpWithOpenCv(entity);
  return {
    ...entity,
    source: result.source,
    originalSource,
    originalWidth,
    originalHeight,
    width: result.width,
    height: result.height,
    baseWidth: result.width,
    baseHeight: result.height,
    rotation: 0,
    flipX: false,
    flipY: false,
    warp: {
      ...normalizeWarpSettings({ enabled: false, source: result.source }, { ...entity, source: result.source, width: result.width, height: result.height }),
      originalSource,
      originalWidth,
      originalHeight,
    },
  };
}

// --- Image Manipulation ---
const minimumImageSize = 24;
let fallbackId = 0;

function createId() {
  if (globalThis.crypto?.randomUUID) return `image-${globalThis.crypto.randomUUID()}`;
  fallbackId += 1;
  return `image-${Date.now().toString(36)}-${fallbackId}`;
}

function finite(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function rotatePoint([x, y], degrees) {
  const angle = degrees * Math.PI / 180;
  return [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)];
}

function subtract([ax, ay], [bx, by]) {
  return [ax - bx, ay - by];
}

function addPoints([ax, ay], [bx, by]) {
  return [ax + bx, ay + by];
}

function worldToImageLocal(entity, world) {
  const translated = subtract(world, [entity.x, entity.y]);
  const rotated = rotatePoint(translated, -entity.rotation);
  return [rotated[0] * (entity.flipX ? -1 : 1), rotated[1] * (entity.flipY ? -1 : 1)];
}

export function isImageEntity(entity) {
  return entity?.type === 'image' && typeof entity.source === 'string';
}

export function normalizeImageEntity(input = {}) {
  const width = Math.max(minimumImageSize, Math.abs(finite(input.width, 240)));
  const height = Math.max(minimumImageSize, Math.abs(finite(input.height, 160)));
  const source = String(input.source || '');
  const baseWidth = Math.max(minimumImageSize, Math.abs(finite(input.baseWidth, width)));
  const baseHeight = Math.max(minimumImageSize, Math.abs(finite(input.baseHeight, height)));
  const originalSource = String(input.originalSource || input.warp?.originalSource || source);
  const originalWidth = Math.max(minimumImageSize, Math.abs(finite(input.originalWidth, input.warp?.originalWidth ?? baseWidth)));
  const originalHeight = Math.max(minimumImageSize, Math.abs(finite(input.originalHeight, input.warp?.originalHeight ?? baseHeight)));
  return {
    id: input.id || createId(),
    type: 'image',
    stackId: String(input.stackId || 'stack-default'),
    name: String(input.name || 'Image'),
    source,
    originalSource,
    originalWidth,
    originalHeight,
    x: finite(input.x, 0),
    y: finite(input.y, 0),
    width,
    height,
    baseWidth,
    baseHeight,
    rotation: finite(input.rotation, 0),
    flipX: Boolean(input.flipX),
    flipY: Boolean(input.flipY),
    locked: Boolean(input.locked),
    construction: Boolean(input.construction),
    appearance: cloneWarp(input.appearance || { fillOpacityExpression: '100', fillOpacity: 1 }),
    warp: normalizeWarpSettings(input.warp || {}, { ...input, width, height, source: input.source }),
  };
}

export function imageAppearance(entity, evaluateNumeric = Number) {
  const expression = String(entity.appearance?.fillOpacityExpression ?? ((entity.appearance?.fillOpacity ?? 1) * 100));
  let opacity = finite(entity.appearance?.fillOpacity, 1);
  let error = null;
  try {
    opacity = resolveOpacityExpression(expression, evaluateNumeric);
  } catch (caught) {
    error = caught.message;
  }
  const zIndex = Number(entity.appearance?.zIndex);
  return {
    fillOpacityExpression: expression,
    fillOpacity: Math.min(1, Math.max(0, opacity)),
    zIndex: Number.isFinite(zIndex) ? zIndex : null,
    error,
  };
}

export function scaleImageFromCorner(input, cornerIndex, pointer) {
  const entity = normalizeImageEntity(input);
  const signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]][cornerIndex] || [1, 1];
  const oppositeLocal = [-signs[0] * entity.width / 2, -signs[1] * entity.height / 2];
  const oppositeWorld = addPoints([entity.x, entity.y], rotatePoint(oppositeLocal, entity.rotation));
  const pointerFromOpposite = rotatePoint(subtract(pointer, oppositeWorld), -entity.rotation);
  const widthRatio = Math.abs(pointerFromOpposite[0]) / entity.width;
  const heightRatio = Math.abs(pointerFromOpposite[1]) / entity.height;
  const ratio = Math.max(minimumImageSize / entity.width, minimumImageSize / entity.height, widthRatio, heightRatio);
  const width = entity.width * ratio;
  const height = entity.height * ratio;
  const centerOffset = rotatePoint([signs[0] * width / 2, signs[1] * height / 2], entity.rotation);
  return {
    ...entity,
    x: oppositeWorld[0] + centerOffset[0],
    y: oppositeWorld[1] + centerOffset[1],
    width,
    height,
    warp: rebaseWarpSettings(entity.warp, { ...entity, width, height }),
  };
}

export function rotateImageFromPointer(input, startPointer, pointer) {
  const entity = normalizeImageEntity(input);
  const angle = ([x, y]) => Math.atan2(y - entity.y, x - entity.x) * 180 / Math.PI;
  return { ...entity, rotation: entity.rotation + angle(pointer) - angle(startPointer) };
}

export function flipImageEntity(input, axis) {
  const entity = normalizeImageEntity(input);
  if (axis === 'horizontal') entity.flipX = !entity.flipX;
  if (axis === 'vertical') entity.flipY = !entity.flipY;
  return entity;
}

export function resetImageEntity(input) {
  const entity = normalizeImageEntity(input);
  return normalizeImageEntity({
    ...entity,
    source: entity.originalSource,
    width: entity.originalWidth,
    height: entity.originalHeight,
    baseWidth: entity.originalWidth,
    baseHeight: entity.originalHeight,
    rotation: 0,
    flipX: false,
    flipY: false,
    warp: normalizeWarpSettings({ enabled: false, source: entity.originalSource }, {
      ...entity,
      source: entity.originalSource,
      width: entity.originalWidth,
      height: entity.originalHeight,
    }),
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name || 'the selected image'}.`));
    reader.readAsDataURL(file);
  });
}

function imageDimensions(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error('The selected file is not a supported image.'));
    image.src = source;
  });
}

export async function createImageEntityFromFile(file, { center = [0, 0], maximumSize = 320 } = {}) {
  if (!file || !String(file.type).startsWith('image/')) throw new Error('Choose a PNG, JPEG, GIF, WebP, or SVG image.');
  const source = await fileToDataUrl(file);
  const dimensions = await imageDimensions(source);
  const scale = Math.min(1, maximumSize / Math.max(dimensions.width, dimensions.height));
  return normalizeImageEntity({
    name: file.name,
    source,
    x: center[0],
    y: center[1],
    width: dimensions.width * scale,
    height: dimensions.height * scale,
  });
}

const toolbarIcons = {
  lock: '<rect x="7" y="10" width="10" height="9"/><path d="M9 10V7a3 3 0 0 1 6 0v3"/>',
  unlock: '<rect x="7" y="10" width="10" height="9"/><path d="M9 10V7a3 3 0 0 1 5-2"/>',
  horizontal: '<path d="M12 4v16"/><path d="M10 7L5 12l5 5zM14 7l5 5-5 5z"/>',
  vertical: '<path d="M4 12h16"/><path d="M7 10l5-5 5 5zM7 14l5 5 5-5z"/>',
  reset: '<path d="M6 7h8a5 5 0 1 1-4.5 7.2"/><path d="M6 7h5M6 7v5"/>',
  warp: '<path d="M5 7l14-2-2 14-12-2z"/><path d="M8 9l7-1-1 7-6-1z"/>',
  trace: '<path d="M5 8c2-3 5-4 8-3 4 1 6 4 5 8-1 4-5 6-9 5-4-1-6-6-4-10z"/><path d="M12 8v8M8 12h8"/>',
};

function toolbarButton(label, iconName) {
  const button = document.createElementNS('http://www.w3.org/1999/xhtml', 'button');
  button.className = 'image-toolbar-button canvas-overlay-button';
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${toolbarIcons[iconName]}</svg>`;
  return button;
}

function createWarpGuide(addSvg, parent) {
  const warpGuide = addSvg(parent, 'g', { class: 'image-warp-guide' });
  const warpPolygon = addSvg(warpGuide, 'polygon', { class: 'image-warp-polygon' });
  const warpSides = [0, 1, 2, 3].map((index) => addSvg(warpGuide, 'line', { class: 'image-warp-side', 'data-warp-side': index }));
  const warpVectorLines = [0, 1, 2, 3].map((index) => addSvg(warpGuide, 'line', { class: 'image-warp-vector-line', 'data-warp-vector-line': index }));
  const warpCornerHandles = [0, 1, 2, 3].map((index) => addSvg(warpGuide, 'circle', { class: 'image-warp-handle image-warp-corner-handle point-handle', 'data-warp-corner': index }));
  const warpVectorHandles = [0, 1, 2, 3].map((index) => addSvg(warpGuide, 'rect', { class: 'image-warp-handle image-warp-vector-handle', 'data-warp-vector': index }));
  const warpHandles = [...warpCornerHandles, ...warpVectorHandles];
  const warpLabels = [0, 1, 2, 3].map((index) => {
    const group = addSvg(warpGuide, 'g', { class: 'image-warp-dimension-label' });
    const background = addSvg(group, 'rect', { class: 'image-warp-dimension-background' });
    const text = addSvg(group, 'text', { class: 'image-warp-dimension-text', 'data-warp-dimension': index });
    return { group, background, text };
  });
  const warpTexts = warpLabels.map(({ text }) => text);
  const warpApply = addSvg(warpGuide, 'foreignObject', { class: 'image-warp-apply' });
  const warpApplyContent = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
  warpApplyContent.className = 'image-warp-apply-content canvas-overlay-button';
  warpApplyContent.innerHTML = `
    <button type="button" class="image-warp-apply-button" aria-label="Apply Warp" title="Apply Warp">
      <svg viewBox="0 0 24 24" aria-hidden="true">${toolbarIcons.warp}</svg>
    </button>
    <span class="image-warp-status" role="status"></span>`;
  warpApply.appendChild(warpApplyContent);

  const warpEditor = addSvg(warpGuide, 'foreignObject', { class: 'image-warp-dimension-editor' });
  const warpEditorContent = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
  warpEditorContent.className = 'image-warp-dimension-editor-content canvas-overlay-button';
  warpEditorContent.innerHTML = `
    <input class="image-warp-dimension-input" type="text" inputmode="decimal" aria-label="Warp dimension" title="Press Enter to apply or Escape to cancel; unit suffixes are optional" />`;
  warpEditor.appendChild(warpEditorContent);
  warpEditor.style.display = 'none';

  return {
    warpGuide,
    warpPolygon,
    warpSides,
    warpVectorLines,
    warpCornerHandles,
    warpVectorHandles,
    warpHandles,
    warpLabels,
    warpTexts,
    warpApply,
    warpApplyContent,
    warpApplyButton: warpApplyContent.querySelector('.image-warp-apply-button'),
    warpStatus: warpApplyContent.querySelector('.image-warp-status'),
    warpEditor,
    warpEditorContent,
    warpEditorInput: warpEditorContent.querySelector('.image-warp-dimension-input'),
    handles: warpHandles,
  };
}

function updateWarpGuide(record) {
  const warp = normalizeWarpSettings(record.entity.warp || {}, record.entity);
  const visible = Boolean(warp.enabled) && !record.traceActive && !record.entity.locked && record.group.classList.contains('selected');
  record.warpGuide.style.display = visible ? '' : 'none';
  if (!visible) return;
  const scale = record.currentScale || 1;
  const points = warp.points;
  const selectedCorner = Number.isInteger(record.selectedWarpCorner) ? record.selectedWarpCorner : null;
  record.group.classList.toggle('warp-corner-selected', selectedCorner !== null);
  const vectorHandles = warpVectorHandlePoints(warp, selectedCorner);
  const validation = validateWarpGuideVectors(points);
  record.warpGuide.classList.toggle('invalid', !validation.valid);
  record.warpPolygon.setAttribute('points', points.map(([x, y]) => `${x},${y}`).join(' '));
  const sidePairs = [[0, 1], [1, 2], [2, 3], [3, 0]];
  record.warpSides.forEach((side, index) => {
    const [startIndex, endIndex] = sidePairs[index];
    side.setAttribute('x1', points[startIndex][0]);
    side.setAttribute('y1', points[startIndex][1]);
    side.setAttribute('x2', points[endIndex][0]);
    side.setAttribute('y2', points[endIndex][1]);
  });
  record.warpCornerHandles.forEach((handle, index) => {
    handle.setAttribute('cx', points[index][0]);
    handle.setAttribute('cy', points[index][1]);
    handle.setAttribute('r', 6 / scale);
    handle.classList.toggle('selected-warp-corner', index === selectedCorner);
  });
  record.warpVectorHandles.forEach((handle, index) => {
    const point = vectorHandles[index];
    const visibleHandle = Array.isArray(point);
    handle.style.display = visibleHandle ? '' : 'none';
    if (!visibleHandle) return;
    const size = 11 / scale;
    handle.setAttribute('x', point[0] - size / 2);
    handle.setAttribute('y', point[1] - size / 2);
    handle.setAttribute('width', size);
    handle.setAttribute('height', size);
    handle.setAttribute('rx', 1.5 / scale);
    handle.classList.toggle('invalid', validation.edgeIndex === index);
  });
  record.warpVectorLines.forEach((line, index) => {
    const point = vectorHandles[index];
    const visibleLine = Array.isArray(point) && selectedCorner !== null;
    line.style.display = visibleLine ? '' : 'none';
    if (!visibleLine) return;
    line.setAttribute('x1', points[selectedCorner][0]);
    line.setAttribute('y1', points[selectedCorner][1]);
    line.setAttribute('x2', point[0]);
    line.setAttribute('y2', point[1]);
    line.classList.toggle('invalid', validation.edgeIndex === index);
  });
  const textData = [
    { side: [points[0], points[1]], value: warp.targetWidth, offset: [0, -16 / scale], anchor: 'middle' },
    { side: [points[1], points[2]], value: warp.targetHeight, offset: [16 / scale, 0], anchor: 'start' },
    { side: [points[2], points[3]], value: warp.targetWidth, offset: [0, 22 / scale], anchor: 'middle' },
    { side: [points[3], points[0]], value: warp.targetHeight, offset: [-16 / scale, 0], anchor: 'end' },
  ];
  record.warpTexts.forEach((text, index) => {
    const { side, value, offset, anchor } = textData[index];
    text.textContent = formatWarpDimension(value, record.getDrawingUnit());
    text.setAttribute('x', (side[0][0] + side[1][0]) / 2 + offset[0]);
    text.setAttribute('y', (side[0][1] + side[1][1]) / 2 + offset[1]);
    text.setAttribute('font-size', 13 / scale);
    text.setAttribute('text-anchor', anchor);
    const bounds = text.getBBox();
    const paddingX = 5 / scale;
    const paddingY = 3 / scale;
    const background = record.warpLabels[index].background;
    background.setAttribute('x', bounds.x - paddingX);
    background.setAttribute('y', bounds.y - paddingY);
    background.setAttribute('width', bounds.width + paddingX * 2);
    background.setAttribute('height', bounds.height + paddingY * 2);
  });
  record.warpApply.setAttribute('x', Math.min(...points.map(([x]) => x)));
  record.warpApply.setAttribute('y', Math.max(...points.map(([, y]) => y)) + 30 / scale);
  record.warpApply.setAttribute('width', 220 / scale);
  record.warpApply.setAttribute('height', 56 / scale);
  record.warpApplyContent.style.transform = `scale(${1 / scale})`;
  record.warpApplyContent.style.transformOrigin = '0 0';
  record.warpStatus.textContent = validation.message;
  record.warpApplyButton.disabled = !validation.valid;
  record.warpApplyButton.setAttribute('aria-label', 'Apply Warp');
  record.warpApplyButton.title = 'Apply Warp';
}

function openWarpDimensionEditor(record, textIndex) {
  const warp = normalizeWarpSettings(record.entity.warp || {}, record.entity);
  const isHeight = textIndex === 1 || textIndex === 3;
  const text = record.warpTexts[textIndex];
  record.warpEditingAxis = isHeight ? 'height' : 'width';
  record.warpEditorInput.value = formatWarpDimension(isHeight ? warp.targetHeight : warp.targetWidth, record.getDrawingUnit());
  record.warpEditor.setAttribute('x', Number(text.getAttribute('x')) - 36 / (record.currentScale || 1));
  record.warpEditor.setAttribute('y', Number(text.getAttribute('y')) + 8 / (record.currentScale || 1));
  record.warpEditor.setAttribute('width', 120 / (record.currentScale || 1));
  record.warpEditor.setAttribute('height', 38 / (record.currentScale || 1));
  record.warpEditorContent.style.transform = `scale(${1 / (record.currentScale || 1)})`;
  record.warpEditorContent.style.transformOrigin = '0 0';
  record.warpEditor.style.display = '';
  record.warpEditorInput.focus();
  record.warpEditorInput.select();
}

function closeWarpDimensionEditor(record) {
  record.warpEditor.style.display = 'none';
  record.warpEditingAxis = null;
}

function submitWarpDimensionEditor(record) {
  if (!record.warpEditingAxis) return;
  const warp = normalizeWarpSettings(record.entity.warp || {}, record.entity);
  const fallback = record.warpEditingAxis === 'height' ? warp.targetHeight : warp.targetWidth;
  record.entity.warp = setWarpDimension(record.entity.warp, record.warpEditingAxis, parseWarpDimensionInput(record.warpEditorInput.value, fallback, record.getDrawingUnit()));
  closeWarpDimensionEditor(record);
  finishRecordChange(record);
}

function finishRecordChange(record) {
  record.updateRecord(record);
  record.finishChange(record);
}

export function createImageManipulation({ addSvg, parent, screenToWorld, getScale, getDrawingUnit = () => '', evaluateNumeric, onSelect, onMoveStart, onChange, onDelete, onCreateClosedLineChain, canStartDrag = () => true }) {
  let drag = null;
  const toolbarVisualWidth = 194;
  const toolbarObjectWidth = 300;

  function closeTrace(record) {
    record.traceRequest += 1;
    if (record.traceTimer) clearTimeout(record.traceTimer);
    record.traceTimer = null;
    record.traceActive = false;
    record.tracePrepared = null;
    record.traceWorldPoint = null;
    record.traceResult = null;
    record.traceError = '';
    record.tracePanel.hidden = true;
  }

  function updateTracePresentation(record) {
    const selected = record.group.classList.contains('selected');
    const active = Boolean(record.traceActive) && selected;
    record.traceButton.setAttribute('aria-pressed', String(active));
    record.traceButton.classList.toggle('active', active);
    record.group.classList.toggle('image-trace-active', active);
    record.tracePanel.hidden = !active;
    record.tracePreview.style.display = active && record.traceResult ? '' : 'none';
    record.traceSeed.style.display = active && record.traceWorldPoint ? '' : 'none';
    if (record.traceResult) {
      record.tracePreview.setAttribute('points', record.traceResult.localPoints.map(([x, y]) => `${x},${y}`).join(' '));
    }
    if (record.traceWorldPoint) {
      const local = imageWorldToLocalPoint(record.entity, record.traceWorldPoint);
      record.traceSeed.setAttribute('cx', local[0]);
      record.traceSeed.setAttribute('cy', local[1]);
      record.traceSeed.setAttribute('r', 5 / (record.currentScale || 1));
    }
    record.traceStatus.textContent = record.traceError
      || (record.traceResult ? `Ready: ${record.traceResult.worldPoints.length} vertices` : (record.traceWorldPoint ? 'Detecting closed edge…' : 'Click inside the object to trace.'));
    record.traceStatus.classList.toggle('error', Boolean(record.traceError));
    record.traceCreateButton.disabled = !record.traceResult;
    record.handleGroup.style.display = selected && !record.entity.locked && !active ? '' : 'none';
    record.rotationStem.style.display = selected && !record.entity.locked && !active ? '' : 'none';
  }

  async function runTrace(record) {
    if (!record.traceActive || !record.traceWorldPoint) return;
    const request = ++record.traceRequest;
    record.traceResult = null;
    record.traceError = '';
    updateRecord(record);
    try {
      if (!record.tracePrepared || record.tracePrepared.source !== record.entity.source) {
        record.tracePrepared = await prepareImageTrace(record.entity);
      }
      const result = await tracePreparedImageRegion(
        record.tracePrepared,
        record.entity,
        record.traceWorldPoint,
        record.traceSettings,
      );
      if (!record.traceActive || request !== record.traceRequest) return;
      record.traceResult = result;
    } catch (error) {
      if (!record.traceActive || request !== record.traceRequest) return;
      record.traceError = error.message || 'The selected region could not be traced.';
    }
    updateRecord(record);
  }

  function scheduleTrace(record) {
    if (!record.traceWorldPoint) return;
    if (record.traceTimer) clearTimeout(record.traceTimer);
    record.traceTimer = setTimeout(() => {
      record.traceTimer = null;
      runTrace(record);
    }, 80);
  }

  function toggleTrace(record) {
    if (record.traceActive) closeTrace(record);
    else {
      record.traceActive = true;
      record.tracePanel.hidden = false;
      record.resetPanel.hidden = true;
      window.dispatchEvent(new CustomEvent('paramagic:tool-activated', { detail: { source: 'image-trace' } }));
    }
    updateRecord(record);
    if (record.traceActive) {
      requestAnimationFrame(() => {
        record.tracePanelOffset = clampTranslatedPanelOffset(record.tracePanel, record.tracePanelOffset, { margin: 8 });
        record.tracePanel.style.transform = `translate(${record.tracePanelOffset[0]}px, ${record.tracePanelOffset[1]}px)`;
      });
    }
  }

  function pickTracePoint(event, record) {
    if (!record.traceActive || event.button !== 0) return false;
    event.preventDefault();
    event.stopPropagation();
    onSelect(record.id);
    record.traceWorldPoint = screenToWorld(event.clientX, event.clientY);
    record.traceResult = null;
    record.traceError = '';
    runTrace(record);
    return true;
  }

  function updateRecord(record) {
    const entity = record.entity;
    const scale = getScale();
    const appearance = imageAppearance(entity, evaluateNumeric);
    record.group.setAttribute('transform', `translate(${entity.x} ${entity.y})`);
    record.transform.setAttribute('transform', `rotate(${entity.rotation}) scale(${entity.flipX ? -1 : 1} ${entity.flipY ? -1 : 1})`);
    record.image.setAttribute('x', -entity.width / 2);
    record.image.setAttribute('y', -entity.height / 2);
    record.image.setAttribute('width', entity.width);
    record.image.setAttribute('height', entity.height);
    record.image.setAttribute('href', entity.source);
    record.image.setAttribute('opacity', appearance.fillOpacity);
    [record.hitTarget, record.selectionFrame].forEach((node) => {
      node.setAttribute('x', -entity.width / 2);
      node.setAttribute('y', -entity.height / 2);
      node.setAttribute('width', entity.width);
      node.setAttribute('height', entity.height);
    });
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    record.cornerHandles.forEach((handle, index) => {
      handle.setAttribute('cx', corners[index][0] * entity.width / 2);
      handle.setAttribute('cy', corners[index][1] * entity.height / 2);
      handle.setAttribute('r', 6 / scale);
    });
    const rotationOffset = 28 / scale;
    record.rotationStem.setAttribute('y1', -entity.height / 2);
    record.rotationStem.setAttribute('y2', -entity.height / 2 - rotationOffset);
    record.rotationHandle.setAttribute('cy', -entity.height / 2 - rotationOffset);
    record.rotationHandle.setAttribute('r', 6 / scale);
    const angle = entity.rotation * Math.PI / 180;
    const visualTop = (Math.abs(entity.width * Math.sin(angle)) + Math.abs(entity.height * Math.cos(angle))) / 2;
    record.toolbar.setAttribute('x', -toolbarVisualWidth / 2 / scale);
    record.toolbar.setAttribute('y', -visualTop - 68 / scale);
    record.toolbar.setAttribute('width', toolbarObjectWidth / scale);
    record.toolbar.setAttribute('height', 270 / scale);
    record.toolbarContent.style.transform = `scale(${1 / scale})`;
    record.toolbarContent.style.transformOrigin = '0 0';
    record.toolbarContent.style.width = `${toolbarVisualWidth}px`;
    record.toolbarContent.style.height = '34px';
    record.lockButton.title = entity.locked ? 'Unlock image' : 'Lock image';
    record.lockButton.setAttribute('aria-label', record.lockButton.title);
    record.lockButton.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${toolbarIcons[entity.locked ? 'lock' : 'unlock']}</svg>`;
    record.horizontalButton.disabled = entity.locked;
    record.verticalButton.disabled = entity.locked;
    record.resetButton.disabled = entity.locked;
    record.warpButton.disabled = entity.locked;
    record.warpButton.setAttribute('aria-pressed', String(Boolean(entity.warp?.enabled)));
    record.warpButton.classList.toggle('active', Boolean(entity.warp?.enabled));
    if (entity.locked) {
      record.resetPanel.hidden = true;
      record.selectedWarpCorner = null;
    }
    record.group.classList.toggle('locked', entity.locked);
    record.group.classList.toggle('construction', entity.construction);
    record.group.classList.toggle('expression-error', Boolean(appearance.error));
    record.currentScale = scale;
    updateWarpGuide(record);
    updateTracePresentation(record);
  }

  function finishChange(record) {
    updateRecord(record);
    onChange(record);
  }

  function beginDrag(event, record, mode, cornerIndex = null) {
    if (!canStartDrag()) return;
    if (event.button === 0 && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (mode === 'move' && onMoveStart?.(event, record)) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(record.id, event);
    if (record.entity.locked || event.button !== 0) return;
    const pointer = screenToWorld(event.clientX, event.clientY);
    drag = {
      mode,
      cornerIndex,
      selectedWarpCorner: record.selectedWarpCorner,
      record,
      startPointer: pointer,
      startEntity: cloneWarp(record.entity),
      moved: false,
    };
    record.group.classList.toggle('handle-active', mode !== 'move');
    record.group.setPointerCapture(event.pointerId);
  }

  function pointerMove(event) {
    if (!drag) return false;
    const pointer = screenToWorld(event.clientX, event.clientY);
    const delta = subtract(pointer, drag.startPointer);
    if (Math.hypot(delta[0], delta[1]) > 0.001) drag.moved = true;
    if (drag.mode === 'move') {
      drag.record.entity = { ...drag.startEntity, x: drag.startEntity.x + delta[0], y: drag.startEntity.y + delta[1] };
    }
    if (drag.mode === 'scale') drag.record.entity = scaleImageFromCorner(drag.startEntity, drag.cornerIndex, pointer);
    if (drag.mode === 'rotate') drag.record.entity = rotateImageFromPointer(drag.startEntity, drag.startPointer, pointer);
    if (drag.mode === 'warp-corner') {
      drag.record.entity.warp = moveWarpGuideCorner(drag.startEntity.warp, drag.cornerIndex, worldToImageLocal(drag.startEntity, pointer));
    }
    if (drag.mode === 'warp-vector') {
      drag.record.entity.warp = moveWarpGuideVector(
        drag.startEntity.warp,
        drag.selectedWarpCorner,
        drag.cornerIndex,
        worldToImageLocal(drag.startEntity, pointer),
      );
    }
    updateRecord(drag.record);
    return true;
  }

  function pointerUp() {
    if (!drag) return false;
    const changed = drag.moved;
    const record = drag.record;
    record.group.classList.remove('handle-active');
    drag = null;
    if (changed) onChange(record);
    return true;
  }

  function createRecord(input) {
    const entity = normalizeImageEntity(input);
    const group = addSvg(parent, 'g', { class: 'canvas-record image-record', 'data-record-id': entity.id, 'data-entity-type': 'image' });
    const transform = addSvg(group, 'g', { class: 'image-transform' });
    const image = addSvg(transform, 'image', { class: 'canvas-image', preserveAspectRatio: 'none' });
    const hitTarget = addSvg(transform, 'rect', { class: 'selectable-entity image-hit-target' });
    const selectionFrame = addSvg(transform, 'rect', { class: 'image-selection-frame' });
    const rotationStem = addSvg(transform, 'line', { x1: 0, x2: 0, class: 'image-rotation-stem' });
    const handleGroup = addSvg(transform, 'g', { class: 'image-handle-group' });
    const cornerHandles = [0, 1, 2, 3].map((index) => addSvg(handleGroup, 'circle', { class: 'image-scale-handle point-handle', 'data-corner-index': index }));
    const rotationHandle = addSvg(handleGroup, 'circle', { cx: 0, class: 'image-rotation-handle point-handle' });
    const warpGuide = createWarpGuide(addSvg, transform);
    const tracePreview = addSvg(transform, 'polygon', { class: 'image-trace-preview' });
    const traceSeed = addSvg(transform, 'circle', { class: 'image-trace-seed' });
    const toolbar = addSvg(group, 'foreignObject', { class: 'image-context-toolbar' });
    const toolbarContent = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    toolbarContent.className = 'image-context-toolbar-content canvas-overlay-button';
    const lockButton = toolbarButton('Lock image', 'unlock');
    const horizontalButton = toolbarButton('Flip horizontal', 'horizontal');
    const verticalButton = toolbarButton('Flip vertical', 'vertical');
    const resetButton = toolbarButton('Reset image transform', 'reset');
    const warpButton = toolbarButton('Warp Perspective', 'warp');
    warpButton.setAttribute('aria-pressed', 'false');
    const traceButton = toolbarButton('Trace Region', 'trace');
    traceButton.setAttribute('aria-pressed', 'false');
    const resetPanel = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    resetPanel.className = 'image-reset-warning';
    resetPanel.hidden = true;
    resetPanel.innerHTML = `
      <p>Reset this image's size, rotation, and flips?</p>
      <div class="image-reset-actions">
        <button type="button" class="image-reset-confirm" aria-label="Reset image" title="Reset image">
          <svg viewBox="0 0 24 24" aria-hidden="true">${toolbarIcons.reset}</svg>
        </button>
        <button type="button" class="image-reset-cancel" aria-label="Cancel image reset" title="Cancel">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </div>`;
    const resetConfirmButton = resetPanel.querySelector('.image-reset-confirm');
    const resetCancelButton = resetPanel.querySelector('.image-reset-cancel');
    const tracePanel = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    tracePanel.className = 'image-trace-panel';
    tracePanel.hidden = true;
    tracePanel.innerHTML = `
      <strong>Trace Region</strong>
      <label><span>Color Tolerance</span><input class="image-trace-tolerance" type="range" min="0" max="100" step="1" value="24" /></label>
      <label><span>Edge Detail</span><input class="image-trace-detail" type="range" min="1" max="10" step="1" value="8" /></label>
      <label><span>Smoothing</span><input class="image-trace-smoothing" type="range" min="0" max="10" step="1" value="1" /></label>
      <p class="image-trace-status" role="status" aria-live="polite">Click inside the object to trace.</p>
      <div class="image-trace-actions">
        <button type="button" class="image-trace-create" disabled>Create Polygon</button>
        <button type="button" class="image-trace-cancel">Cancel</button>
      </div>`;
    const traceToleranceInput = tracePanel.querySelector('.image-trace-tolerance');
    const traceDetailInput = tracePanel.querySelector('.image-trace-detail');
    const traceSmoothingInput = tracePanel.querySelector('.image-trace-smoothing');
    const traceStatus = tracePanel.querySelector('.image-trace-status');
    const traceCreateButton = tracePanel.querySelector('.image-trace-create');
    const traceCancelButton = tracePanel.querySelector('.image-trace-cancel');
    toolbarContent.append(lockButton, horizontalButton, verticalButton, resetButton, warpButton, traceButton, resetPanel, tracePanel);
    toolbar.appendChild(toolbarContent);
    const record = {
      id: entity.id,
      recordType: 'image',
      entity,
      group,
      transform,
      image,
      hitTarget,
      selectionFrame,
      handleGroup,
      handles: [...cornerHandles, rotationHandle, ...warpGuide.handles],
      cornerHandles,
      rotationHandle,
      rotationStem,
      toolbar,
      toolbarContent,
      lockButton,
      horizontalButton,
      verticalButton,
      resetButton,
      warpButton,
      traceButton,
      selectedWarpCorner: null,
      resetPanel,
      tracePanel,
      traceToleranceInput,
      traceDetailInput,
      traceSmoothingInput,
      traceStatus,
      traceCreateButton,
      traceCancelButton,
      tracePreview,
      traceSeed,
      traceActive: false,
      tracePrepared: null,
      traceWorldPoint: null,
      traceResult: null,
      traceError: '',
      traceRequest: 0,
      traceTimer: null,
      tracePanelOffset: [0, 0],
      tracePanelDrag: null,
      traceSettings: normalizeImageTraceSettings(),
      updateRecord,
      finishChange,
      getDrawingUnit,
      ...warpGuide,
    };

    hitTarget.addEventListener('pointerdown', (event) => {
      if (!pickTracePoint(event, record)) beginDrag(event, record, 'move');
    });
    cornerHandles.forEach((handle, index) => handle.addEventListener('pointerdown', (event) => beginDrag(event, record, 'scale', index)));
    rotationHandle.addEventListener('pointerdown', (event) => beginDrag(event, record, 'rotate'));
    record.warpCornerHandles.forEach((handle, index) => handle.addEventListener('pointerdown', (event) => {
      record.selectedWarpCorner = index;
      updateRecord(record);
      beginDrag(event, record, 'warp-corner', index);
    }));
    record.warpVectorHandles.forEach((handle, index) => handle.addEventListener('pointerdown', (event) => beginDrag(event, record, 'warp-vector', index)));
    group.addEventListener('click', (event) => { event.stopPropagation(); onSelect(record.id, event); });
    toolbarContent.addEventListener('pointerdown', (event) => event.stopPropagation());
    lockButton.addEventListener('click', (event) => {
      event.stopPropagation();
      closeTrace(record);
      record.entity.locked = !record.entity.locked;
      finishChange(record);
    });
    horizontalButton.addEventListener('click', (event) => {
      event.stopPropagation();
      if (record.entity.locked) return;
      closeTrace(record);
      record.entity = flipImageEntity(record.entity, 'horizontal');
      finishChange(record);
    });
    verticalButton.addEventListener('click', (event) => {
      event.stopPropagation();
      if (record.entity.locked) return;
      closeTrace(record);
      record.entity = flipImageEntity(record.entity, 'vertical');
      finishChange(record);
    });
    resetButton.addEventListener('click', (event) => {
      event.stopPropagation();
      if (record.entity.locked) return;
      closeTrace(record);
      resetPanel.hidden = !resetPanel.hidden;
    });
    resetCancelButton.addEventListener('click', (event) => {
      event.stopPropagation();
      resetPanel.hidden = true;
    });
    resetConfirmButton.addEventListener('click', (event) => {
      event.stopPropagation();
      if (record.entity.locked) return;
      record.entity = resetImageEntity(record.entity);
      resetPanel.hidden = true;
      finishChange(record);
    });
    warpButton.addEventListener('click', (event) => {
      event.stopPropagation();
      if (record.entity.locked) return;
      closeTrace(record);
      record.entity.warp = toggleWarpSettings(record.entity);
      if (record.entity.warp.enabled) record.entity.warp = enableWarpSettings(record.entity);
      else record.selectedWarpCorner = null;
      finishChange(record);
    });
    traceButton.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleTrace(record);
    });
    tracePanel.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('input, button')) return;
      event.preventDefault();
      event.stopPropagation();
      record.tracePanelDrag = {
        pointerId: event.pointerId,
        start: [event.clientX, event.clientY],
        offset: [...record.tracePanelOffset],
      };
      tracePanel.setPointerCapture(event.pointerId);
    });
    tracePanel.addEventListener('pointermove', (event) => {
      if (!record.tracePanelDrag || record.tracePanelDrag.pointerId !== event.pointerId) return;
      record.tracePanelOffset = [
        record.tracePanelDrag.offset[0] + event.clientX - record.tracePanelDrag.start[0],
        record.tracePanelDrag.offset[1] + event.clientY - record.tracePanelDrag.start[1],
      ];
      tracePanel.style.transform = `translate(${record.tracePanelOffset[0]}px, ${record.tracePanelOffset[1]}px)`;
      record.tracePanelOffset = clampTranslatedPanelOffset(tracePanel, record.tracePanelOffset, { margin: 8 });
      tracePanel.style.transform = `translate(${record.tracePanelOffset[0]}px, ${record.tracePanelOffset[1]}px)`;
    });
    tracePanel.addEventListener('pointerup', (event) => {
      if (record.tracePanelDrag?.pointerId === event.pointerId) record.tracePanelDrag = null;
    });
    [traceToleranceInput, traceDetailInput, traceSmoothingInput].forEach((input) => {
      input.addEventListener('input', (event) => {
        event.stopPropagation();
        record.traceSettings = normalizeImageTraceSettings({
          tolerance: traceToleranceInput.value,
          detail: traceDetailInput.value,
          smoothing: traceSmoothingInput.value,
        });
        scheduleTrace(record);
      });
    });
    traceCreateButton.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!record.traceResult?.worldPoints?.length) return;
      const points = record.traceResult.worldPoints.map((point) => [...point]);
      closeTrace(record);
      updateRecord(record);
      onCreateClosedLineChain?.(points);
    });
    traceCancelButton.addEventListener('click', (event) => {
      event.stopPropagation();
      closeTrace(record);
      updateRecord(record);
    });
    record.warpTexts.forEach((text, index) => {
      text.addEventListener('dblclick', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openWarpDimensionEditor(record, index);
      });
      text.addEventListener('click', (event) => event.stopPropagation());
    });
    record.warpApplyButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (record.entity.locked) return;
      record.warpApplyButton.disabled = true;
      record.warpApplyButton.setAttribute('aria-label', 'Warping image');
      record.warpApplyButton.title = 'Warping image';
      record.warpStatus.textContent = 'Warping…';
      try {
        record.entity = normalizeImageEntity(await warpImageEntity(record.entity));
        updateRecord(record);
        onChange(record);
      } catch (error) {
        record.warpStatus.textContent = error.message;
        record.warpApplyButton.disabled = false;
        record.warpApplyButton.setAttribute('aria-label', 'Apply Warp');
        record.warpApplyButton.title = 'Apply Warp';
      }
    });
    record.warpEditorInput.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        submitWarpDimensionEditor(record);
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeWarpDimensionEditor(record);
      }
    });
    updateRecord(record);
    return record;
  }

  function syncRecord(record, selected) {
    if (!selected) {
      record.selectedWarpCorner = null;
      closeTrace(record);
    }
    record.group.classList.toggle('selected', selected);
    record.toolbar.style.display = selected ? '' : 'none';
    if (!selected) record.resetPanel.hidden = true;
    record.handleGroup.style.display = selected && !record.entity.locked && !record.traceActive ? '' : 'none';
    record.rotationStem.style.display = selected && !record.entity.locked && !record.traceActive ? '' : 'none';
    record.warpGuide.style.display = selected && record.entity.warp?.enabled ? '' : 'none';
    updateRecord(record);
  }

  function setAppearance(record, patch) {
    const current = imageAppearance(record.entity, evaluateNumeric);
    const expression = patch.fillOpacityExpression ?? current.fillOpacityExpression;
    const appearance = { ...(record.entity.appearance || {}), fillOpacityExpression: String(expression), fillOpacity: current.fillOpacity };
    try { appearance.fillOpacity = resolveOpacityExpression(expression, evaluateNumeric); } catch { /* retain last valid opacity */ }
    record.entity.appearance = appearance;
    finishChange(record);
    return true;
  }

  return { createRecord, updateRecord, syncRecord, setAppearance, pointerMove, pointerUp, isDragging: () => Boolean(drag), deleteRecord: onDelete };
}

// --- Portable Image Assets ---
export function collectDrawingImageReferences(drawing = {}) {
  const entities = Array.isArray(drawing.entities) ? drawing.entities : drawing.drawing?.entities || [];
  return [...new Set(entities.flatMap((entity) => [
    entity.appearance?.fillImageReference || entity.appearance?.fillExpression,
    entity.appearance?.strokeImageReference || entity.appearance?.strokeExpression,
  ]).filter(isImageFillReference))];
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function defaultFetchAsset(reference) {
  const contentUrl = staticImageFillContentUrl(reference);
  if (!contentUrl) throw new Error(`Image fill could not be exported: ${reference}`);
  const response = await fetch(contentUrl);
  if (!response.ok) throw new Error(`Image fill could not be exported: ${reference}`);
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mimeType: response.headers.get('content-type') || 'application/octet-stream',
  };
}

const SVG_IMAGE_ELEMENT_PATTERN = /<image\b[^<>]*\/>/g;
const SVG_XLINK_NAMESPACE_PATTERN = /\s+xmlns:[A-Za-z_][\w.-]*="http:\/\/www\.w3\.org\/1999\/xlink"/g;
const SVG_PREFIXED_HREF_PATTERN = /\s+[A-Za-z_][\w.-]*:href="[^"]*"/g;

function svgAttributeValue(markup, name) {
  const match = String(markup || '').match(new RegExp(`\\s${name}="([^"]*)"`));
  return match?.[1] ?? null;
}

function removeSvgAttribute(markup, name) {
  return markup.replace(new RegExp(`\\s+${name}="[^"]*"`, 'g'), '');
}

function normalizeSvgImageElement(markup) {
  return String(markup || '')
    .replace(SVG_XLINK_NAMESPACE_PATTERN, '')
    .replace(SVG_PREFIXED_HREF_PATTERN, '');
}

function shareableSvgImage(markup) {
  const normalized = normalizeSvgImageElement(markup);
  const href = svgAttributeValue(normalized, 'href');
  const width = svgAttributeValue(normalized, 'width');
  const height = svgAttributeValue(normalized, 'height');
  const preserveAspectRatio = svgAttributeValue(normalized, 'preserveAspectRatio');
  if (!href || !width || !height || preserveAspectRatio !== 'none') return null;
  return {
    normalized,
    href,
    x: svgAttributeValue(normalized, 'x') || '0',
    y: svgAttributeValue(normalized, 'y') || '0',
    width,
    height,
  };
}

function sharedSvgImageUse(image, id) {
  let remainingAttributes = image.normalized
    .replace(/^<image\b/, '')
    .replace(/\/>$/, '');
  ['x', 'y', 'width', 'height', 'preserveAspectRatio', 'href'].forEach((name) => {
    remainingAttributes = removeSvgAttribute(remainingAttributes, name);
  });
  return `<use href="#${id}" x="${image.x}" y="${image.y}" width="${image.width}" height="${image.height}"${remainingAttributes}/>`;
}

function nextSharedSvgImageId(svg, sequence) {
  let nextSequence = sequence;
  let id = `paramagic-shared-image-${nextSequence}`;
  while (svg.includes(`id="${id}"`)) {
    nextSequence += 1;
    id = `paramagic-shared-image-${nextSequence}`;
  }
  return { id, sequence: nextSequence + 1 };
}

export function compactSvgImageAssets(svgInput) {
  const svg = String(svgInput ?? '');
  const images = [...svg.matchAll(SVG_IMAGE_ELEMENT_PATTERN)]
    .map((match) => shareableSvgImage(match[0]))
    .filter(Boolean);
  const countsByHref = new Map();
  images.forEach(({ href }) => countsByHref.set(href, (countsByHref.get(href) || 0) + 1));

  const sharedByHref = new Map();
  let sequence = 1;
  for (const [href, count] of countsByHref) {
    if (count < 2) continue;
    const sharedId = nextSharedSvgImageId(svg, sequence);
    sharedByHref.set(href, sharedId.id);
    sequence = sharedId.sequence;
  }

  let compacted = svg.replace(SVG_IMAGE_ELEMENT_PATTERN, (markup) => {
    const image = shareableSvgImage(markup);
    if (!image) return normalizeSvgImageElement(markup);
    const id = sharedByHref.get(image.href);
    return id ? sharedSvgImageUse(image, id) : image.normalized;
  });
  if (!sharedByHref.size) return compacted;

  const definitions = [...sharedByHref].map(([href, id]) => (
    `<symbol id="${id}" viewBox="0 0 1 1" preserveAspectRatio="none"><image x="0" y="0" width="1" height="1" preserveAspectRatio="none" href="${href}"/></symbol>`
  )).join('');
  if (/<defs\b[^>]*>/.test(compacted)) {
    return compacted.replace(/<defs\b[^>]*>/, (openingTag) => `${openingTag}${definitions}`);
  }
  return compacted.replace(/<svg\b[^>]*>/, (openingTag) => `${openingTag}<defs>${definitions}</defs>`);
}

export async function embedSvgImageAssets(svgInput, {
  fetchAsset = defaultFetchAsset,
} = {}) {
  const svg = compactSvgImageAssets(svgInput);
  const hrefPattern = /(\s)href="([^"]+)"/g;
  const referencesByUrl = new Map();
  for (const match of svg.matchAll(hrefPattern)) {
    const reference = imageFillReferenceFromContentUrl(match[2]);
    if (!reference) continue;
    referencesByUrl.set(match[2], reference);
  }
  if (!referencesByUrl.size) return svg;

  const dataUrls = new Map(await Promise.all(
    [...referencesByUrl].map(async ([url, reference]) => {
      const asset = await fetchAsset(reference);
      const bytes = asset.bytes instanceof Uint8Array ? asset.bytes : new Uint8Array(asset.bytes);
      const requestedMimeType = String(asset.mimeType || '').split(';', 1)[0].trim();
      const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(requestedMimeType)
        ? requestedMimeType
        : 'application/octet-stream';
      return [url, `data:${mimeType};base64,${bytesToBase64(bytes)}`];
    }),
  ));

  return svg.replace(hrefPattern, (markup, whitespace, url) => (
    dataUrls.has(url) ? `${whitespace}href="${dataUrls.get(url)}"` : markup
  ));
}

export async function embedPortableImageAssets(documentInput, {
  fetchAsset = defaultFetchAsset,
} = {}) {
  const document = cloneWarp(documentInput);
  const images = [];
  for (const reference of collectDrawingImageReferences(document)) {
    const asset = await fetchAsset(reference);
    const bytes = asset.bytes instanceof Uint8Array ? asset.bytes : new Uint8Array(asset.bytes);
    images.push({
      reference,
      fileName: asset.fileName || reference.split('/').at(-1) || 'image',
      mimeType: asset.mimeType,
      sha256: asset.sha256 || await sha256(bytes),
      dataBase64: bytesToBase64(bytes),
    });
  }
  if (images.length) document.embeddedAssets = { images };
  else delete document.embeddedAssets;
  return document;
}

export async function serializePortableDrawingJson(snapshot, name = 'Untitled Drawing', options = {}) {
  return JSON.stringify(await embedPortableImageAssets(
    JSON.parse(serializeDrawingJson(snapshot, name)), options,
  ), null, 2);
}

export async function serializePortablePackageJson(packageValue, options = {}) {
  return JSON.stringify(await embedPortableImageAssets(packageValue, options), null, 2);
}

function drawingEntities(document) {
  return Array.isArray(document.entities) ? document.entities : document.drawing?.entities || [];
}

function rewriteImageReferences(drawing, referenceMap) {
  const copy = cloneWarp(drawing);
  drawingEntities(copy).forEach((entity) => {
    const appearance = entity.appearance;
    if (!appearance) return;
    const fillOriginal = appearance.fillImageReference || appearance.fillExpression;
    const fillReplacement = referenceMap.get(fillOriginal);
    if (fillReplacement) {
      appearance.fillType = 'image';
      appearance.fillImageReference = fillReplacement;
      appearance.fillExpression = fillReplacement;
    }
    const strokeOriginal = appearance.strokeImageReference || appearance.strokeExpression;
    const strokeReplacement = referenceMap.get(strokeOriginal);
    if (strokeReplacement) {
      appearance.strokeType = 'image';
      appearance.strokeImageReference = strokeReplacement;
      appearance.strokeExpression = strokeReplacement;
    }
  });
  return copy;
}

export async function hydratePortableImageAssets(documentInput, { importAsset } = {}) {
  const document = cloneWarp(documentInput);
  const embeddedImages = Array.isArray(document.embeddedAssets?.images) ? document.embeddedAssets.images : [];
  if (!embeddedImages.length || typeof importAsset !== 'function') return document;
  const referenceMap = new Map();
  for (const asset of embeddedImages) {
    if (!isImageFillReference(asset.reference)) throw new Error('Portable drawing contains an invalid image reference');
    if (!/^[0-9a-f]{64}$/i.test(String(asset.sha256 || ''))) throw new Error('Portable drawing contains an invalid image checksum');
    const reference = await importAsset({
      ...asset,
      bytes: base64ToBytes(asset.dataBase64),
    });
    if (!isImageFillReference(reference)) throw new Error('Imported image did not return a valid catalog reference');
    referenceMap.set(asset.reference, reference);
  }
  delete document.embeddedAssets;
  return rewriteImageReferences(document, referenceMap);
}

export async function parsePortableDrawingText(fileName, text, { importAsset } = {}) {
  if (/\.dxf$/i.test(fileName)) return parseDrawingText(fileName, text);
  return normalizeDrawingData(await hydratePortableImageAssets(JSON.parse(text), { importAsset }));
}
