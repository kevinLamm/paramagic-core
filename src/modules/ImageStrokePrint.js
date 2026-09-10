import { rasterizePresentationSvg } from './PngExport.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PRINT_DPI = 300;
const MAX_RASTER_SIDE = 8192;
const MAX_RASTER_PIXELS = 16 * 1024 * 1024;

export function imageStrokePrintRasterSize(bounds, pixelsPerUnit) {
  const density = Math.max(0.001, Number(pixelsPerUnit) || 1);
  const width = Math.max(1, Math.ceil(bounds.width * density));
  const height = Math.max(1, Math.ceil(bounds.height * density));
  const reduction = Math.min(1, MAX_RASTER_SIDE / width, MAX_RASTER_SIDE / height,
    Math.sqrt(MAX_RASTER_PIXELS / (width * height)));
  return { width: Math.max(1, Math.floor(width * reduction)), height: Math.max(1, Math.floor(height * reduction)) };
}

function blobDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not prepare the image stroke for printing.'));
    reader.readAsDataURL(blob);
  });
}

// Snapshot just the brush in its local coordinates. The output group keeps its
// original transform, opacity, clipping and stacking order; other artwork stays SVG.
export async function prepareImageStrokePrintSvg(sourceSvg, outputSvg, { widthMm, heightMm }, {
  rasterize = rasterizePresentationSvg,
  encode = blobDataUrl,
} = {}) {
  const sources = [...sourceSvg.querySelectorAll('.image-stroke-brush')];
  if (!sources.length) return;
  const outputs = [...outputSvg.querySelectorAll('.image-stroke-brush')];
  const viewport = sourceSvg.viewBox.baseVal;
  const density = Math.min(widthMm / viewport.width, heightMm / viewport.height) * PRINT_DPI / 25.4;
  const rootInverse = sourceSvg.getCTM().inverse();
  // Measure all attached sources before any asynchronous work (the preview may change).
  const jobs = sources.map((source, index) => {
    const box = source.getBBox();
    const matrix = rootInverse.multiply(source.getCTM());
    // Largest singular value includes rotation, nonuniform scaling and skew.
    const sum = matrix.a ** 2 + matrix.b ** 2 + matrix.c ** 2 + matrix.d ** 2;
    const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
    const scale = Math.sqrt((sum + Math.sqrt(Math.max(0, sum ** 2 - 4 * determinant ** 2))) / 2);
    const pixelsPerUnit = Math.max(0.001, density * scale);
    const padding = 1 / pixelsPerUnit;
    const bounds = { x: box.x - padding, y: box.y - padding, width: box.width + padding * 2, height: box.height + padding * 2 };
    return { output: outputs[index], bounds, size: imageStrokePrintRasterSize(bounds, pixelsPerUnit) };
  });
  for (const { output, bounds, size } of jobs) {
    const documentRef = output.ownerDocument;
    const rasterSvg = documentRef.createElementNS(SVG_NS, 'svg');
    rasterSvg.setAttribute('xmlns', SVG_NS);
    rasterSvg.setAttribute('width', size.width);
    rasterSvg.setAttribute('height', size.height);
    rasterSvg.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`);
    rasterSvg.setAttribute('preserveAspectRatio', 'none');
    const brush = output.cloneNode(true);
    brush.removeAttribute('transform');
    brush.removeAttribute('opacity');
    brush.style.removeProperty('opacity');
    rasterSvg.appendChild(brush);
    const blob = await rasterize(rasterSvg, size.width, size.height, {
      background: null,
      createCanvas: () => documentRef.createElement('canvas'),
      inlinePresentationStyles: () => {},
    });
    const image = documentRef.createElementNS(SVG_NS, 'image');
    Object.entries(bounds).forEach(([name, value]) => image.setAttribute(name, value));
    image.setAttribute('preserveAspectRatio', 'none');
    image.setAttribute('data-print-image-stroke', 'true');
    const href = await encode(blob);
    image.setAttribute('href', href);
    // Decode before window.print() takes its snapshot, including cold-cache prints.
    const loader = new documentRef.defaultView.Image();
    loader.src = href;
    await loader.decode();
    output.replaceChildren(image);
  }
}
