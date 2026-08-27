import {
  createCanvasPresentationSvg,
  serializeCanvasPresentationElement,
} from './CanvasPresentation.js';
import { embedSvgImageAssets } from './ImageSystem.js';

export const PNG_EXPORT_PADDING_PIXELS = 20;
export const PNG_EXPORT_FORMATS = Object.freeze([
  Object.freeze({ ratio: '1:1', width: 2048, height: 2048, unitWidth: 1, unitHeight: 1 }),
  Object.freeze({ ratio: '16:9', width: 2720, height: 1530, unitWidth: 16, unitHeight: 9 }),
  Object.freeze({ ratio: '9:16', width: 1530, height: 2720, unitWidth: 9, unitHeight: 16 }),
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

const PNG_RASTER_SOURCE_ELEMENT_PATTERN = /<(?:image|feImage)\b[^<>]*(?:\/>|>\s*<\/(?:image|feImage)>)/gi;
const PNG_HREF_ATTRIBUTE_PATTERN = /\s+(?:[A-Za-z_][\w.-]*:)?href="([^"]*)"/g;

export function assertPngRasterSourcesEmbedded(markup) {
  const serialized = String(markup ?? '');
  if (/<foreignObject\b/i.test(serialized)) {
    throw new Error('PNG export cannot rasterize HTML controls; drawing text must use native SVG text.');
  }
  for (const element of serialized.matchAll(PNG_RASTER_SOURCE_ELEMENT_PATTERN)) {
    for (const href of element[0].matchAll(PNG_HREF_ATTRIBUTE_PATTERN)) {
      const source = String(href[1] || '').trim();
      if (!source || source.startsWith('#') || /^data:image\//i.test(source)) continue;
      throw new Error(`PNG export could not embed an image source: ${source}`);
    }
  }
  return serialized;
}

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

export async function preparePngRasterMarkup(svg, {
  embedImageAssets = embedSvgImageAssets,
  inlinePresentationStyles = inlinePngPresentationStyles,
  serializePresentationElement = serializeCanvasPresentationElement,
} = {}) {
  inlinePresentationStyles(svg);
  const markup = await embedImageAssets(serializePresentationElement(svg));
  return assertPngRasterSourcesEmbedded(markup);
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

function waitForPngPresentationLayout(documentRef) {
  const requestFrame = documentRef?.defaultView?.requestAnimationFrame?.bind(documentRef.defaultView)
    || globalThis.requestAnimationFrame?.bind(globalThis);
  if (typeof requestFrame !== 'function') return Promise.resolve();
  return new Promise((resolve) => requestFrame(() => resolve()));
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

export async function rasterizePresentationSvg(svg, width, height, {
  createCanvas = () => globalThis.document?.createElement('canvas'),
  embedImageAssets = embedSvgImageAssets,
  inlinePresentationStyles = inlinePngPresentationStyles,
  prepareRasterMarkup = preparePngRasterMarkup,
  serializePresentationElement = serializeCanvasPresentationElement,
  loadSvgImage = svgMarkupImage,
} = {}) {
  const markup = await prepareRasterMarkup(svg, {
    embedImageAssets,
    inlinePresentationStyles,
    serializePresentationElement,
  });
  const loaded = await loadSvgImage(markup);
  const canvas = createCanvas();
  if (!canvas) {
    loaded.release?.();
    throw new Error('This browser cannot rasterize PNG exports.');
  }
  try {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext?.('2d');
    if (!context) {
      throw new Error('This browser cannot rasterize PNG exports.');
    }
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(loaded.image, 0, 0, width, height);
    return canvasPngBlob(canvas);
  } finally {
    loaded.release?.();
  }
}

export async function encodePngAtCaptureSize(format, render) {
  if (!format || typeof render !== 'function') throw new Error('PNG export format and renderer are required.');
  const width = Math.max(1, Math.floor(Number(format.width) || 0));
  const height = Math.max(1, Math.floor(Number(format.height) || 0));
  const blob = await render(width, height);
  if (!(blob instanceof Blob)) throw new Error('PNG export did not produce image data.');
  return { blob, width, height, ratio: format.ratio };
}

export async function createCanvasPresentationPng(objectLayer, options = {}, {
  createPresentationSvg = createCanvasPresentationSvg,
  rasterizePresentation = rasterizePresentationSvg,
  waitForPresentationLayout = waitForPngPresentationLayout,
} = {}) {
  const documentRef = options.documentRef || globalThis.document;
  if (!objectLayer || !documentRef?.body) throw new Error('The canvas presentation is unavailable for PNG export.');
  const host = documentRef.createElement('div');
  host.style.position = 'fixed';
  host.style.left = '-100000px';
  host.style.top = '0';
  host.style.opacity = '0';
  host.style.pointerEvents = 'none';
  documentRef.body.appendChild(host);
  try {
    const mountedPresentation = () => {
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
      return { svg, content };
    };
    const initialPresentation = mountedPresentation();
    await waitForPresentationLayout(documentRef);
    const initialBounds = measuredContentBounds(initialPresentation.content);
    const format = pngExportFormatForBounds(initialBounds);
    return await encodePngAtCaptureSize(format, async (width, height) => {
      const { svg, content } = mountedPresentation();
      await waitForPresentationLayout(documentRef);
      let bounds = measuredContentBounds(content);
      applyPngViewport(svg, bounds, width, height, options.paddingPixels ?? PNG_EXPORT_PADDING_PIXELS);
      if (content.querySelector('.dimension-text')) {
        bounds = measuredContentBounds(content);
        applyPngViewport(svg, bounds, width, height, options.paddingPixels ?? PNG_EXPORT_PADDING_PIXELS);
      }
      return rasterizePresentation(svg, width, height);
    });
  } finally {
    host.remove();
  }
}

export async function serializeCanvasPresentationPng(objectLayer, options = {}, dependencies = {}) {
  return (await createCanvasPresentationPng(objectLayer, options, dependencies)).blob;
}
