import { resolveColorExpression } from './AppearanceExpressions.js';
import {
  imageFillContentUrl,
  isImageFillReference,
  normalizeImageFillAspectRatio,
  normalizeImageFillPixelDimension,
  prepareImageFillContentUrl,
  runtimeCatalogImageInfo,
} from './ImageSystem.js';

export const DEFAULT_IMAGE_STROKE_SIZE_EXPRESSION = '';

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

function unquoteStringLiteral(value) {
  const source = String(value ?? '').trim();
  if (source.length < 2) return source;
  const quote = source[0];
  if (!['"', "'"].includes(quote) || source.at(-1) !== quote) return source;
  return source.slice(1, -1).replace(/\\(['"\\])/g, '$1');
}

function resolveImageReference(expression, evaluateNumeric) {
  const direct = unquoteStringLiteral(expression);
  if (isImageFillReference(direct)) return direct;
  try {
    const resolved = unquoteStringLiteral(evaluateNumeric(expression));
    return isImageFillReference(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function resolvePositiveLength(expression, fallback, evaluateLength, label) {
  const source = String(expression ?? DEFAULT_IMAGE_STROKE_SIZE_EXPRESSION).trim();
  if (!source) return { expression: '', value: fallback, error: null };
  try {
    const value = Number(evaluateLength(source));
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be greater than 0.`);
    return { expression: source, value, error: null };
  } catch (error) {
    return {
      expression: source,
      value: fallback,
      error: error.message || `${label} must resolve to a valid length.`,
    };
  }
}

export function resolveGeometryStrokeAppearance(
  appearance = {},
  evaluateNumeric = Number,
  evaluateLength = evaluateNumeric,
) {
  const strokeExpression = String(
    appearance.strokeExpression
      ?? appearance.strokeImageReference
      ?? appearance.strokeColor
      ?? '#202020',
  ).trim();
  const fallbackColor = HEX_COLOR.test(appearance.strokeColor || '')
    ? appearance.strokeColor.toLowerCase()
    : '#202020';
  const thickness = Number(appearance.strokeThickness);
  const fallbackHeight = Number.isFinite(thickness) && thickness > 0 ? thickness : 1.5;
  const pixelWidth = normalizeImageFillPixelDimension(appearance.strokeImagePixelWidth);
  const pixelHeight = normalizeImageFillPixelDimension(appearance.strokeImagePixelHeight);
  const aspectRatio = pixelWidth && pixelHeight
    ? normalizeImageFillAspectRatio(pixelWidth / pixelHeight)
    : normalizeImageFillAspectRatio(appearance.strokeImageAspectRatio || 4);
  const height = resolvePositiveLength(
    appearance.strokeImageHeightExpression,
    fallbackHeight,
    evaluateLength,
    'Image stroke height',
  );
  const width = resolvePositiveLength(
    appearance.strokeImageWidthExpression,
    height.value * aspectRatio,
    evaluateLength,
    'Image stroke width',
  );
  const strokeImageReference = resolveImageReference(strokeExpression, evaluateNumeric);
  if (strokeImageReference) {
    return {
      strokeExpression,
      strokeType: 'image',
      strokeImageReference,
      strokeImageAspectRatio: aspectRatio,
      strokeImagePixelWidth: pixelWidth,
      strokeImagePixelHeight: pixelHeight,
      strokeImageWidthExpression: width.expression,
      strokeImageHeightExpression: height.expression,
      strokeImageWidth: width.value,
      strokeImageHeight: height.value,
      strokeColor: fallbackColor,
      error: null,
      imageStrokeWidthError: width.error,
      imageStrokeHeightError: height.error,
    };
  }
  try {
    return {
      strokeExpression,
      strokeType: 'color',
      strokeImageReference: null,
      strokeImageAspectRatio: aspectRatio,
      strokeImagePixelWidth: pixelWidth,
      strokeImagePixelHeight: pixelHeight,
      strokeImageWidthExpression: width.expression,
      strokeImageHeightExpression: height.expression,
      strokeImageWidth: width.value,
      strokeImageHeight: height.value,
      strokeColor: resolveColorExpression(strokeExpression, evaluateNumeric),
      error: null,
      imageStrokeWidthError: width.error,
      imageStrokeHeightError: height.error,
    };
  } catch (error) {
    return {
      strokeExpression,
      strokeType: 'color',
      strokeImageReference: null,
      strokeImageAspectRatio: aspectRatio,
      strokeImagePixelWidth: pixelWidth,
      strokeImagePixelHeight: pixelHeight,
      strokeImageWidthExpression: width.expression,
      strokeImageHeightExpression: height.expression,
      strokeImageWidth: width.value,
      strokeImageHeight: height.value,
      strokeColor: fallbackColor,
      error: error.message,
      imageStrokeWidthError: width.error,
      imageStrokeHeightError: height.error,
    };
  }
}

export function updateStrokeAppearance(
  appearance = {},
  patch = {},
  evaluateNumeric = Number,
  evaluateLength = evaluateNumeric,
) {
  const candidate = { ...appearance };
  if (patch.strokeExpression !== undefined) {
    const previousReference = isImageFillReference(
      appearance.strokeExpression ?? appearance.strokeImageReference,
    ) ? String(appearance.strokeExpression ?? appearance.strokeImageReference).trim() : null;
    const nextExpression = String(patch.strokeExpression ?? '');
    candidate.strokeExpression = nextExpression;
    if (isImageFillReference(nextExpression) && nextExpression.trim() !== previousReference) {
      delete candidate.strokeImageAspectRatio;
      delete candidate.strokeImagePixelWidth;
      delete candidate.strokeImagePixelHeight;
      delete candidate.strokeImageWidthExpression;
      delete candidate.strokeImageHeightExpression;
    }
  }
  if (patch.strokeImageWidthExpression !== undefined) {
    candidate.strokeImageWidthExpression = String(patch.strokeImageWidthExpression ?? '').trim();
  }
  if (patch.strokeImageHeightExpression !== undefined) {
    candidate.strokeImageHeightExpression = String(patch.strokeImageHeightExpression ?? '').trim();
  }
  const resolved = resolveGeometryStrokeAppearance(candidate, evaluateNumeric, evaluateLength);
  return {
    appearance: {
      ...candidate,
      strokeExpression: resolved.strokeExpression,
      strokeColor: resolved.strokeColor,
      strokeImageWidthExpression: resolved.strokeImageWidthExpression,
      strokeImageHeightExpression: resolved.strokeImageHeightExpression,
      ...(resolved.strokeType === 'image'
        ? { strokeType: 'image', strokeImageReference: resolved.strokeImageReference }
        : { strokeType: 'color', strokeImageReference: null }),
    },
    error: resolved.error || resolved.imageStrokeWidthError || resolved.imageStrokeHeightError,
  };
}

export function imageStrokeMetricsAppearancePatch(appearance = {}, metrics = {}) {
  return {
    strokeImageAspectRatio: normalizeImageFillAspectRatio(metrics.aspectRatio),
    strokeImagePixelWidth: normalizeImageFillPixelDimension(metrics.pixelWidth),
    strokeImagePixelHeight: normalizeImageFillPixelDimension(metrics.pixelHeight),
    strokeImageWidthExpression: String(appearance.strokeImageWidthExpression ?? '').trim(),
    strokeImageHeightExpression: String(appearance.strokeImageHeightExpression ?? '').trim(),
  };
}

export function catalogImageStrokeSizePatch(sizePatch = {}) {
  return {
    ...(sizePatch.fillImageWidthExpression !== undefined
      ? { strokeImageWidthExpression: sizePatch.fillImageWidthExpression }
      : {}),
    ...(sizePatch.fillImageHeightExpression !== undefined
      ? { strokeImageHeightExpression: sizePatch.fillImageHeightExpression }
      : {}),
  };
}

export function imageStrokeSelectionProperties(appearances = [], canEditImageStroke = false) {
  const images = appearances.filter(({ strokeType }) => strokeType === 'image');
  const active = canEditImageStroke && appearances.length > 0 && images.length === appearances.length;
  const widths = new Set(images.map(({ strokeImageWidthExpression }) => strokeImageWidthExpression));
  const heights = new Set(images.map(({ strokeImageHeightExpression }) => strokeImageHeightExpression));
  return {
    canEditImageStroke,
    canEditImageStrokeSettings: active,
    imageStrokeWidthExpression: active && widths.size === 1 ? images[0].strokeImageWidthExpression : null,
    imageStrokeHeightExpression: active && heights.size === 1 ? images[0].strokeImageHeightExpression : null,
    mixedImageStrokeWidth: active && widths.size > 1,
    mixedImageStrokeHeight: active && heights.size > 1,
    imageStrokeWidthError: active
      ? images.find(({ imageStrokeWidthError }) => imageStrokeWidthError)?.imageStrokeWidthError || null
      : null,
    imageStrokeHeightError: active
      ? images.find(({ imageStrokeHeightError }) => imageStrokeHeightError)?.imageStrokeHeightError || null
      : null,
  };
}

export function imageStrokePropertiesMarkup() {
  return `<label class="property-row image-stroke-property-row" for="imageStrokeWidthProperty" hidden><span>Image Stroke Width</span><input id="imageStrokeWidthProperty" aria-label="Image stroke repeat width expression" list="imageStrokeParameterNames" type="text" autocomplete="off" spellcheck="false" disabled /></label>
  <label class="property-row image-stroke-property-row" for="imageStrokeHeightProperty" hidden><span>Image Stroke Height</span><input id="imageStrokeHeightProperty" aria-label="Image stroke height expression" list="imageStrokeParameterNames" type="text" autocomplete="off" spellcheck="false" disabled /><datalist id="imageStrokeParameterNames"></datalist></label>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export function createImageStrokePropertyController({
  root,
  onChange = () => {},
  parameterNames = () => [],
} = {}) {
  const rows = [...root.querySelectorAll('.image-stroke-property-row')];
  const width = root.querySelector('#imageStrokeWidthProperty');
  const height = root.querySelector('#imageStrokeHeightProperty');
  const names = root.querySelector('#imageStrokeParameterNames');
  const refreshNames = () => {
    names.innerHTML = [...new Set(parameterNames().filter(Boolean).map(String))]
      .map((name) => `<option value="${escapeHtml(name)}"></option>`).join('');
  };
  width.addEventListener('input', () => onChange({ strokeImageWidthExpression: width.value }));
  height.addEventListener('input', () => onChange({ strokeImageHeightExpression: height.value }));
  [width, height].forEach((input) => {
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') input.blur(); });
    input.addEventListener('focus', refreshNames);
  });
  function update(properties = {}) {
    const visible = properties.canEditImageStrokeSettings === true;
    rows.forEach((row) => { row.hidden = !visible; });
    width.disabled = !visible;
    height.disabled = !visible;
    if (document.activeElement !== width) width.value = properties.imageStrokeWidthExpression ?? '';
    if (document.activeElement !== height) height.value = properties.imageStrokeHeightExpression ?? '';
    width.placeholder = properties.mixedImageStrokeWidth ? 'Mixed' : 'Repeat length';
    height.placeholder = properties.mixedImageStrokeHeight ? 'Mixed' : 'Brush width';
    width.setAttribute('aria-invalid', String(Boolean(properties.errors?.imageStrokeWidth)));
    height.setAttribute('aria-invalid', String(Boolean(properties.errors?.imageStrokeHeight)));
    width.title = properties.errors?.imageStrokeWidth || 'Physical repeat length along the path';
    height.title = properties.errors?.imageStrokeHeight || 'Physical brush width across the path';
  }
  return { update };
}

export function imageStrokeSlicePlan(lengthInput, tileWidthInput, brushHeightInput, maxSlices = 2048) {
  const length = Number(lengthInput);
  const tileWidth = Number(tileWidthInput);
  const brushHeight = Number(brushHeightInput);
  if (![length, tileWidth, brushHeight].every((value) => Number.isFinite(value) && value > 0)) return [];
  const sliceLimit = Math.max(1, Math.floor(Number(maxSlices) || 1));
  const desiredStep = Math.max(1e-4, brushHeight / 3);
  const sliceCount = Math.max(1, Math.min(sliceLimit, Math.ceil(length / desiredStep)));
  return Array.from({ length: sliceCount }, (_, index) => {
    const start = length * index / sliceCount;
    const end = length * (index + 1) / sliceCount;
    return {
      start,
      end,
      center: (start + end) / 2,
      width: end - start,
      phase: start % tileWidth,
    };
  });
}

function setHref(node, href) {
  node.setAttribute('href', href);
  node.setAttributeNS(XLINK_NS, 'href', href);
}

export function createImageStrokeSystem({ onImageMetrics = () => {} } = {}) {
  const metricsByReference = new Map();
  const loadingReferences = new Set();

  function clear(record) {
    record?.imageStrokeGroup?.remove();
    if (record) record.imageStrokeGroup = null;
  }

  async function requestMetrics(reference, rerender) {
    if (metricsByReference.has(reference) || loadingReferences.has(reference) || typeof globalThis.Image !== 'function') return;
    loadingReferences.add(reference);
    let url;
    try {
      url = await prepareImageFillContentUrl(reference);
      if (!url) {
        loadingReferences.delete(reference);
        return;
      }
      rerender?.();
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
      onImageMetrics(reference, metrics);
      rerender?.();
    };
    loader.onerror = () => loadingReferences.delete(reference);
    loader.src = url;
  }

  function render(record, appearance, rerender = null) {
    clear(record);
    if (!record?.node || record.entity?.construction || appearance?.strokeType !== 'image') return false;
    const href = imageFillContentUrl(appearance.strokeImageReference);
    const runtimeInfo = runtimeCatalogImageInfo(appearance.strokeImageReference);
    const totalLength = Number(record.node.getTotalLength?.());
    if (!href || !Number.isFinite(totalLength) || totalLength <= 0) return false;
    const metrics = metricsByReference.get(appearance.strokeImageReference);
    const aspectRatio = metrics?.aspectRatio || appearance.strokeImageAspectRatio || 4;
    const height = Number(appearance.strokeImageHeight) || Number(appearance.strokeThickness) || 1.5;
    const width = Number(appearance.strokeImageWidth) || height * aspectRatio;
    const slices = imageStrokeSlicePlan(totalLength, width, height, 256);
    if (!slices.length) return false;
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'image-stroke-brush');
    group.setAttribute('data-image-stroke-reference', appearance.strokeImageReference);
    group.setAttribute('opacity', appearance.strokeOpacity ?? 1);
    record.group.insertBefore(group, record.hitNode || record.segmentGroup || record.handleGroup || null);
    record.imageStrokeGroup = group;
    const tangentProbe = Math.max(1e-5, Math.min(totalLength / 10000, height / 20));
    const safeRecordId = String(record.id || 'stroke').replace(/[^A-Za-z0-9_-]/g, '-');
    slices.forEach((slice, index) => {
      const center = record.node.getPointAtLength(slice.center);
      const before = record.node.getPointAtLength(Math.max(0, slice.center - tangentProbe));
      const after = record.node.getPointAtLength(Math.min(totalLength, slice.center + tangentProbe));
      const angle = Math.atan2(after.y - before.y, after.x - before.x) * 180 / Math.PI;
      const strip = document.createElementNS(SVG_NS, 'g');
      strip.setAttribute('transform', `translate(${center.x} ${center.y}) rotate(${angle})`);
      const patternId = `image-stroke-${safeRecordId}-${index}`;
      const pattern = document.createElementNS(SVG_NS, 'pattern');
      pattern.setAttribute('id', patternId);
      pattern.setAttribute('patternUnits', 'userSpaceOnUse');
      pattern.setAttribute('patternContentUnits', 'userSpaceOnUse');
      pattern.setAttribute('x', -slice.width / 2 - slice.phase);
      pattern.setAttribute('y', -height / 2);
      pattern.setAttribute('width', width);
      pattern.setAttribute('height', height);
      const image = document.createElementNS(SVG_NS, 'image');
      image.setAttribute('x', 0);
      image.setAttribute('y', 0);
      image.setAttribute('width', width);
      image.setAttribute('height', height);
      image.setAttribute('preserveAspectRatio', 'none');
      if (runtimeInfo) image.setAttribute('data-runtime-catalog-byte-size', runtimeInfo.byteSize);
      setHref(image, href);
      pattern.appendChild(image);
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', -slice.width / 2);
      rect.setAttribute('y', -height / 2);
      rect.setAttribute('width', slice.width);
      rect.setAttribute('height', height);
      rect.setAttribute('fill', `url(#${patternId})`);
      strip.append(pattern, rect);
      group.appendChild(strip);
    });
    requestMetrics(appearance.strokeImageReference, rerender);
    return true;
  }

  return { clear, render };
}
