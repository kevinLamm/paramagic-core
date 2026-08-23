import {
  createCanvasPresentationSvg,
  serializeCanvasPresentationElement,
} from './CanvasPresentation.js';
import { embedSvgImageAssets } from './ImageSystem.js';

export const MAXIMUM_PNG_EXPORT_BYTES = 1024 * 1024;
export const PNG_EXPORT_PADDING_PIXELS = 20;
export const PNG_EXPORT_FORMATS = Object.freeze([
  Object.freeze({ ratio: '1:1', width: 1024, height: 1024, unitWidth: 1, unitHeight: 1 }),
  Object.freeze({ ratio: '16:9', width: 1360, height: 765, unitWidth: 16, unitHeight: 9 }),
  Object.freeze({ ratio: '9:16', width: 765, height: 1360, unitWidth: 9, unitHeight: 16 }),
]);

const PNG_PRESENTATION_STYLE_PROPERTIES = Object.freeze([
  'clip-path',
  'color',
  'filter',
  'fill',
  'fill-opacity',
  'fill-rule',
  'image-rendering',
  'mask',
  'mix-blend-mode',
  'opacity',
  'paint-order',
  'shape-rendering',
  'stroke',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'stroke-width',
  'vector-effect',
]);

const PNG_TEXT_STYLE_PROPERTIES = Object.freeze([
  'dominant-baseline',
  'font-family',
  'font-size',
  'font-stretch',
  'font-style',
  'font-variant',
  'font-weight',
  'letter-spacing',
  'text-anchor',
  'word-spacing',
]);

const PNG_DERIVED_DRAWABLE_SELECTOR = [
  '.linked-copy-group',
  '.array-group',
  '.symmetric-mirror-group',
].flatMap((group) => [
  'path',
  'line',
  'rect',
  'circle',
  'ellipse',
  'polyline',
  'polygon',
  'text',
  'image',
  'use',
].map((tag) => `${group} ${tag}`));

const PNG_COMPUTED_STYLE_SELECTOR = [
  '.entity:not(.hit-target):not(.segment-select-line)',
  '.resolved-boundary-visual',
  '.dimension-path',
  '.dimension-extension',
  '.dimension-arrow',
  '.dimension-text',
  ...PNG_DERIVED_DRAWABLE_SELECTOR,
].join(',');

function positiveBounds(bounds) {
  const x = Number(bounds?.x);
  const y = Number(bounds?.y);
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new Error('PNG export requires at least one visible object with measurable bounds.');
  }
  return { x, y, width, height };
}

export function pngBoundsIncludingStroke(bounds, strokeWidth = 0) {
  const measured = positiveBounds(bounds);
  const outset = Math.max(0, Number(strokeWidth) || 0) / 2;
  return {
    x: measured.x - outset,
    y: measured.y - outset,
    width: measured.width + outset * 2,
    height: measured.height + outset * 2,
  };
}

export function inlinePngPresentationStyles(svg, getStyle = (node) => (
  node.ownerDocument?.defaultView?.getComputedStyle?.(node)
)) {
  if (!svg?.querySelectorAll || typeof getStyle !== 'function') return svg;
  [...svg.querySelectorAll(PNG_COMPUTED_STYLE_SELECTOR)].forEach((node) => {
    if (!node?.style?.setProperty) return;
    const computed = getStyle(node);
    if (!computed) return;
    const tagName = String(node.tagName || '').toLowerCase();
    const properties = tagName === 'text'
      ? [...PNG_PRESENTATION_STYLE_PROPERTIES, ...PNG_TEXT_STYLE_PROPERTIES]
      : PNG_PRESENTATION_STYLE_PROPERTIES;
    properties.forEach((property) => {
      const value = computed.getPropertyValue?.(property) || computed[property];
      if (value !== undefined && value !== null && String(value).trim()) {
        node.style.setProperty(property, String(value).trim());
      }
    });
  });
  return svg;
}

export function pngExportFormatForBounds(bounds) {
  const measured = positiveBounds(bounds);
  const contentRatio = measured.width / measured.height;
  return PNG_EXPORT_FORMATS.reduce((best, candidate) => {
    const candidateRatio = candidate.width / candidate.height;
    const expansion = Math.max(contentRatio / candidateRatio, candidateRatio / contentRatio);
    return !best || expansion < best.expansion ? { format: candidate, expansion } : best;
  }, null).format;
}

export function fittedPngExportViewport(bounds, width, height, paddingPixels = PNG_EXPORT_PADDING_PIXELS) {
  const measured = positiveBounds(bounds);
  const outputWidth = Math.max(1, Math.floor(Number(width) || 0));
  const outputHeight = Math.max(1, Math.floor(Number(height) || 0));
  const padding = Math.max(0, Number(paddingPixels) || 0);
  if (padding * 2 >= outputWidth || padding * 2 >= outputHeight) {
    throw new Error('PNG export dimensions are too small for the requested padding.');
  }
  const scale = Math.min(
    (outputWidth - padding * 2) / measured.width,
    (outputHeight - padding * 2) / measured.height,
  );
  const viewWidth = outputWidth / scale;
  const viewHeight = outputHeight / scale;
  return {
    x: measured.x + measured.width / 2 - viewWidth / 2,
    y: measured.y + measured.height / 2 - viewHeight / 2,
    width: viewWidth,
    height: viewHeight,
    scale,
    paddingLeft: (outputWidth - measured.width * scale) / 2,
    paddingTop: (outputHeight - measured.height * scale) / 2,
  };
}

function canvasPngBlob(canvas) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('The browser could not encode the PNG export.'));
    }, 'image/png');
  });
}

function maximumVisibleStrokeWidth(content) {
  return [content, ...content.querySelectorAll('*')].reduce((maximum, element) => {
    const computed = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
    const stroke = computed?.stroke || element.style?.stroke || element.getAttribute?.('stroke');
    const opacity = Number(computed?.strokeOpacity ?? element.style?.strokeOpacity ?? element.getAttribute?.('stroke-opacity') ?? 1);
    if (!stroke || stroke === 'none' || stroke === 'transparent' || opacity <= 0) return maximum;
    const width = Number.parseFloat(
      computed?.strokeWidth || element.style?.strokeWidth || element.getAttribute?.('stroke-width') || '0',
    );
    return Number.isFinite(width) ? Math.max(maximum, width) : maximum;
  }, 0);
}

function measuredContentBounds(content) {
  let bounds;
  try {
    bounds = positiveBounds(content.getBBox({ fill: true, stroke: true, markers: true }));
  } catch {
    try {
      bounds = positiveBounds(content.getBBox());
    } catch {
      throw new Error('PNG export requires at least one visible object with measurable bounds.');
    }
  }
  return pngBoundsIncludingStroke(bounds, maximumVisibleStrokeWidth(content));
}

function applyPngViewport(svg, bounds, width, height, paddingPixels) {
  const viewport = fittedPngExportViewport(bounds, width, height, paddingPixels);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`);
  const background = svg.querySelector('[data-canvas-presentation-background]');
  if (background) {
    background.setAttribute('x', viewport.x);
    background.setAttribute('y', viewport.y);
    background.setAttribute('width', viewport.width);
    background.setAttribute('height', viewport.height);
    background.setAttribute('fill', '#ffffff');
  }
  const content = svg.querySelector('[data-canvas-presentation-content]');
  content?.querySelectorAll('.dimension-text').forEach((text) => {
    const fontSize = 14 / viewport.scale;
    text.setAttribute('font-size', fontSize);
    text.setAttribute('stroke-width', 0);
    text.style.fontSize = `${fontSize}px`;
    text.style.strokeWidth = '0px';
  });
  return viewport;
}

async function svgMarkupImage(markup, {
  ImageImpl = globalThis.Image,
  URLImpl = globalThis.URL,
  BlobImpl = globalThis.Blob,
} = {}) {
  if (typeof ImageImpl !== 'function' || typeof URLImpl?.createObjectURL !== 'function') {
    throw new Error('This browser cannot rasterize PNG exports.');
  }
  const url = URLImpl.createObjectURL(new BlobImpl([markup], { type: 'image/svg+xml' }));
  const image = new ImageImpl();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('The SVG presentation could not be rasterized as PNG.'));
      image.src = url;
    });
    return { image, release: () => URLImpl.revokeObjectURL(url) };
  } catch (error) {
    URLImpl.revokeObjectURL(url);
    throw error;
  }
}

async function rasterizePresentationSvg(svg, width, height, {
  createCanvas = () => globalThis.document?.createElement('canvas'),
  embedImageAssets = embedSvgImageAssets,
  inlinePresentationStyles = inlinePngPresentationStyles,
  serializePresentationElement = serializeCanvasPresentationElement,
  loadSvgImage = svgMarkupImage,
} = {}) {
  inlinePresentationStyles(svg);
  const markup = await embedImageAssets(serializePresentationElement(svg));
  const loaded = await loadSvgImage(markup);
  const canvas = createCanvas();
  const context = canvas?.getContext?.('2d');
  if (!canvas || !context) {
    loaded.release?.();
    throw new Error('This browser cannot rasterize PNG exports.');
  }
  try {
    canvas.width = width;
    canvas.height = height;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(loaded.image, 0, 0, width, height);
    return canvasPngBlob(canvas);
  } finally {
    loaded.release?.();
  }
}

export async function encodePngWithinLimit(format, render, maximumBytes = MAXIMUM_PNG_EXPORT_BYTES) {
  if (!format || typeof render !== 'function') throw new Error('PNG export format and renderer are required.');
  const byteLimit = Math.max(1, Math.floor(Number(maximumBytes) || 0));
  let multiplier = Math.floor(Math.min(format.width / format.unitWidth, format.height / format.unitHeight));
  while (multiplier >= 1) {
    const width = format.unitWidth * multiplier;
    const height = format.unitHeight * multiplier;
    const blob = await render(width, height);
    if (!(blob instanceof Blob)) throw new Error('PNG export did not produce image data.');
    if (blob.size <= byteLimit) return { blob, width, height, ratio: format.ratio };
    const scale = Math.min(0.9, Math.sqrt(byteLimit / Math.max(1, blob.size)) * 0.95);
    multiplier = Math.min(multiplier - 1, Math.floor(multiplier * scale));
  }
  throw new Error(`The PNG export could not be reduced to ${byteLimit} bytes.`);
}

export async function createCanvasPresentationPng(objectLayer, options = {}, {
  createPresentationSvg = createCanvasPresentationSvg,
  rasterizePresentation = rasterizePresentationSvg,
} = {}) {
  const documentRef = options.documentRef || globalThis.document;
  if (!objectLayer || !documentRef?.body) throw new Error('The canvas presentation is unavailable for PNG export.');
  const host = documentRef.createElement('div');
  host.style.position = 'fixed';
  host.style.left = '-100000px';
  host.style.top = '0';
  host.style.visibility = 'hidden';
  host.style.pointerEvents = 'none';
  documentRef.body.appendChild(host);
  try {
    const svg = createPresentationSvg({
      objectLayer,
      stackId: options.stackId || null,
      width: 1024,
      height: 1024,
      background: '#ffffff',
      documentRef,
    });
    if (!svg) throw new Error('The canvas presentation is unavailable for PNG export.');
    host.replaceChildren(svg);
    const content = svg.querySelector('[data-canvas-presentation-content]');
    if (!content) throw new Error('The canvas presentation is unavailable for PNG export.');
    const initialBounds = measuredContentBounds(content);
    const format = pngExportFormatForBounds(initialBounds);
    return encodePngWithinLimit(format, async (width, height) => {
      let bounds = measuredContentBounds(content);
      applyPngViewport(svg, bounds, width, height, options.paddingPixels ?? PNG_EXPORT_PADDING_PIXELS);
      if (content.querySelector('.dimension-text')) {
        bounds = measuredContentBounds(content);
        applyPngViewport(svg, bounds, width, height, options.paddingPixels ?? PNG_EXPORT_PADDING_PIXELS);
      }
      return rasterizePresentation(svg, width, height);
    }, options.maximumBytes ?? MAXIMUM_PNG_EXPORT_BYTES);
  } finally {
    host.remove();
  }
}

export async function serializeCanvasPresentationPng(objectLayer, options = {}, dependencies = {}) {
  return (await createCanvasPresentationPng(objectLayer, options, dependencies)).blob;
}
