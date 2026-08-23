export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

const TRANSIENT_CLASSES = [
  'selected',
  'hovered',
  'smart-selected',
  'overlap-cycle-selected',
  'array-source-selected',
  'linked-copy-source-selected',
  'symmetric-source-selected',
  'object-snap-target',
  'handle-active',
  'stack-hidden',
  'stack-inactive',
];

const EDITING_UI_SELECTOR = [
  '.handle-group',
  '.segment-selection-layer',
  '.hit-target',
  '.closed-region-hit',
  '.array-item-hit',
  '.notch-hit',
  '.image-hit-target',
  '.image-selection-frame',
  '.image-rotation-stem',
  '.image-handle-group',
  '.image-warp-guide',
  '.image-trace-preview',
  '.image-trace-seed',
  '.image-context-toolbar',
  '.text-selection-frame',
  '.driven-dimension-export-toggle',
].join(',');

const createSvg = (documentRef, tag, attributes = {}) => {
  const node = documentRef.createElementNS(SVG_NAMESPACE, tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value));
  return node;
};

const hasClass = (node, name) => Boolean(node?.classList?.contains?.(name));

export function valueOnlyDimensionText(value) {
  return String(value ?? '').replace(/^.*?=\s*/, '');
}

export function isCanvasPresentationSourceNode(node, stackId = null) {
  if (!node) return false;
  if (stackId && (node.getAttribute?.('data-stack-id') || 'stack-default') !== stackId) return false;
  const supported = hasClass(node, 'canvas-record')
    || hasClass(node, 'array-group')
    || hasClass(node, 'linked-copy-group')
    || hasClass(node, 'symmetric-mirror-group');
  if (!supported || hasClass(node, 'closed-constrained-region')) return false;
  if (hasClass(node, 'object-visibility-hidden')) return false;
  if (hasClass(node, 'dimension-driving')) return false;
  if (hasClass(node, 'dimension-export-excluded')) return false;
  const derivedGroup = hasClass(node, 'array-group')
    || hasClass(node, 'linked-copy-group')
    || hasClass(node, 'symmetric-mirror-group');
  if (!derivedGroup && node.querySelector?.('.construction')) return false;
  return true;
}

export function sanitizeCanvasPresentationClone(source) {
  const cloneNode = source.cloneNode(true);
  cloneNode.querySelectorAll?.(EDITING_UI_SELECTOR).forEach((node) => node.remove());
  cloneNode.querySelectorAll?.('.array-item-content, .linked-copy-content, .symmetric-mirror-copy').forEach((node) => {
    if (node.querySelector?.('.construction')) node.remove();
  });
  const nodes = [cloneNode, ...(cloneNode.querySelectorAll?.('*') || [])];
  nodes.forEach((node) => {
    TRANSIENT_CLASSES.forEach((name) => node.classList?.remove?.(name));
    node.removeAttribute?.('id');
    node.removeAttribute?.('aria-label');
    node.removeAttribute?.('aria-hidden');
    node.removeAttribute?.('role');
    node.removeAttribute?.('tabindex');
    node.removeAttribute?.('contenteditable');
    if (node.style) node.style.pointerEvents = 'none';
  });
  cloneNode.style?.removeProperty?.('display');
  cloneNode.style?.removeProperty?.('visibility');
  cloneNode.querySelectorAll?.('.dimension-text').forEach((text) => {
    text.textContent = valueOnlyDimensionText(text.textContent);
  });
  return cloneNode;
}

export function fittedPresentationViewport(bounds, width, height) {
  const safeWidth = Math.max(0.001, Number(bounds?.width) || 0.001);
  const safeHeight = Math.max(0.001, Number(bounds?.height) || 0.001);
  const padding = Math.max(safeWidth, safeHeight) * 0.06;
  let x = (Number(bounds?.x) || 0) - padding;
  let y = (Number(bounds?.y) || 0) - padding;
  let viewWidth = safeWidth + padding * 2;
  let viewHeight = safeHeight + padding * 2;
  const targetRatio = width / height;
  const viewRatio = viewWidth / viewHeight;
  if (viewRatio > targetRatio) {
    const adjustedHeight = viewWidth / targetRatio;
    y -= (adjustedHeight - viewHeight) / 2;
    viewHeight = adjustedHeight;
  } else {
    const adjustedWidth = viewHeight * targetRatio;
    x -= (adjustedWidth - viewWidth) / 2;
    viewWidth = adjustedWidth;
  }
  return { x, y, width: viewWidth, height: viewHeight };
}

export function fitCanvasPresentationSvg(svg, { width, height } = {}) {
  const content = svg?.querySelector?.('[data-canvas-presentation-content]');
  if (!svg || !content) return null;
  const resolvedWidth = Number(width) || Number(svg.getAttribute?.('width')) || 240;
  const resolvedHeight = Number(height) || Number(svg.getAttribute?.('height')) || 150;
  let bounds;
  try {
    bounds = content.getBBox();
  } catch {
    bounds = null;
  }
  if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)
    || bounds.width <= 0 || bounds.height <= 0) {
    bounds = { x: 0, y: 0, width: resolvedWidth, height: resolvedHeight };
  }
  const viewport = fittedPresentationViewport(bounds, resolvedWidth, resolvedHeight);
  svg.setAttribute('viewBox', `${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`);
  const background = svg.querySelector?.('[data-canvas-presentation-background]');
  if (background) {
    background.setAttribute('x', viewport.x);
    background.setAttribute('y', viewport.y);
    background.setAttribute('width', viewport.width);
    background.setAttribute('height', viewport.height);
  }
  const scale = Math.max(0.0001, Math.min(
    resolvedWidth / viewport.width,
    resolvedHeight / viewport.height,
  ));
  content.querySelectorAll?.('.dimension-text').forEach((text) => {
    const size = 10 / scale;
    text.setAttribute('font-size', size);
    text.setAttribute('stroke-width', 0);
    text.style.fontSize = `${size}px`;
    text.style.strokeWidth = '0px';
  });
  return viewport;
}

function clonePresentationDefinitions(objectLayer, svg) {
  const ownerSvg = objectLayer?.ownerSVGElement;
  [...(ownerSvg?.children || [])]
    .filter((node) => String(node.tagName || '').toLowerCase() === 'defs')
    .forEach((node) => svg.appendChild(node.cloneNode(true)));
}

export function createCanvasPresentationSvg({
  objectLayer,
  stackId = null,
  width = 240,
  height = 150,
  background = null,
  documentRef = globalThis.document,
} = {}) {
  if (!objectLayer || !documentRef?.createElementNS) return null;
  const svg = createSvg(documentRef, 'svg', {
    xmlns: SVG_NAMESPACE,
    width,
    height,
    preserveAspectRatio: 'xMidYMid meet',
    'data-canvas-presentation': 'true',
  });
  clonePresentationDefinitions(objectLayer, svg);
  if (background !== null && background !== 'none' && background !== 'transparent') {
    svg.appendChild(createSvg(documentRef, 'rect', {
      fill: background,
      'data-canvas-presentation-background': 'true',
    }));
  }
  const content = createSvg(documentRef, 'g', {
    'data-canvas-presentation-content': 'true',
    'aria-hidden': 'true',
  });
  [...objectLayer.children]
    .filter((node) => isCanvasPresentationSourceNode(node, stackId))
    .forEach((node) => content.appendChild(sanitizeCanvasPresentationClone(node)));
  svg.appendChild(content);
  return svg;
}

export function mountCanvasPresentationSvg(host, options = {}) {
  const svg = createCanvasPresentationSvg(options);
  if (!svg || !host) return null;
  host.replaceChildren(svg);
  fitCanvasPresentationSvg(svg, options);
  if (svg.querySelector?.('.dimension-text')) fitCanvasPresentationSvg(svg, options);
  return svg;
}

export function createMeasuredCanvasPresentationSvg(options = {}) {
  const documentRef = options.documentRef || globalThis.document;
  if (!documentRef?.body) return null;
  const host = documentRef.createElement('div');
  host.style.position = 'fixed';
  host.style.left = '-100000px';
  host.style.top = '0';
  host.style.visibility = 'hidden';
  host.style.pointerEvents = 'none';
  documentRef.body.appendChild(host);
  const svg = mountCanvasPresentationSvg(host, { ...options, documentRef });
  svg?.remove();
  host.remove();
  return svg;
}

export function serializeCanvasPresentationElement(svg, {
  serializer = globalThis.XMLSerializer ? new globalThis.XMLSerializer() : null,
} = {}) {
  if (!svg) return '';
  if (serializer?.serializeToString) return serializer.serializeToString(svg);
  return String(svg.outerHTML || '');
}
