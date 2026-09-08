// Stack geometry is expressed in local coordinates. Public canvas geometry is
// its projection into the drawing frame; placement never edits local geometry.
export const GLOBAL_LAYER_ID = '00000000-0000-4000-8000-000000000001';
export const GLOBAL_LAYER_KIND = 'global';
export const IDENTITY_FRAME = Object.freeze({ x: 0, y: 0, rotation: 0 });

export function normalizeStackFrame(frame = {}) {
  return Object.fromEntries(['x', 'y', 'rotation'].map((key) => [
    key, Number.isFinite(Number(frame?.[key])) ? Number(frame[key]) : 0,
  ]));
}

export function transformStackPoint(point, frame = IDENTITY_FRAME, inverse = false) {
  if (!Array.isArray(point)) return point;
  const normalizedFrame = normalizeStackFrame(frame);
  const c = Math.cos(normalizedFrame.rotation), s = Math.sin(normalizedFrame.rotation);
  const x = point[0] - (inverse ? normalizedFrame.x : 0);
  const y = point[1] - (inverse ? normalizedFrame.y : 0);
  return inverse
    ? [c * x + s * y, -s * x + c * y]
    : [c * x - s * y + normalizedFrame.x, s * x + c * y + normalizedFrame.y];
}

export function transformStackEntity(entity, frame = IDENTITY_FRAME, inverse = false) {
  if (!entity) return entity;
  const next = structuredClone(entity);
  const point = (p) => transformStackPoint(p, frame, inverse);
  for (const key of ['start', 'end', 'point', 'center', 'arcPoint', 'measureStart', 'measureEnd', 'textPoint', 'labelPoint', 'vertex', 'label', 'elbow', 'target', 'radius']) {
    if (Array.isArray(next[key])) next[key] = point(next[key]);
  }
  if (Array.isArray(next.points)) next.points = next.points.map(point);
  if (Number.isFinite(next.x) && Number.isFinite(next.y)) [next.x, next.y] = point([next.x, next.y]);
  if (next.type === 'image' && Number.isFinite(entity.width) && Number.isFinite(entity.height)) {
    const center = point([entity.x + entity.width / 2, entity.y + entity.height / 2]);
    next.x = center[0] - entity.width / 2;
    next.y = center[1] - entity.height / 2;
  }
  for (const key of ['firstSegment', 'secondSegment']) {
    if (next[key]) next[key] = transformStackEntity(next[key], frame, inverse);
  }
  if (['text', 'image', 'table', 'control'].includes(next.type) && (frame.rotation || next.rotation)) {
    next.rotation = (Number(next.rotation) || 0) + (inverse ? -1 : 1) * frame.rotation * 180 / Math.PI;
  }
  return next;
}

export function stackFrameMatrix(frame) {
  const normalizedFrame = normalizeStackFrame(frame);
  const c = Math.cos(normalizedFrame.rotation), s = Math.sin(normalizedFrame.rotation);
  return `matrix(${c} ${s} ${-s} ${c} ${normalizedFrame.x} ${normalizedFrame.y})`;
}

export function inverseStackFrame(frame) {
  const normalizedFrame = normalizeStackFrame(frame);
  const [x, y] = transformStackPoint([0, 0], normalizedFrame, true);
  return { x, y, rotation: -normalizedFrame.rotation };
}

export function stackFrameFor(state, stackId = state?.activeStackId) {
  const frame = state?.stacks?.find(({ id }) => id === stackId)?.frame;
  return frame ? normalizeStackFrame(frame) : IDENTITY_FRAME;
}

export function updateStackAxes({ axisX, axisY, originPoint, state, bounds }) {
  const frame = stackFrameFor(state);
  const reach = Math.max(...[
    [bounds.left, bounds.top], [bounds.right, bounds.top],
    [bounds.left, bounds.bottom], [bounds.right, bounds.bottom],
  ].map(([x, y]) => Math.hypot(x - frame.x, y - frame.y))) + 1;
  for (const [node, a, b] of [
    [axisX, [-reach, 0], [reach, 0]], [axisY, [0, -reach], [0, reach]],
  ]) {
    const start = transformStackPoint(a, frame), end = transformStackPoint(b, frame);
    for (const [key, value] of Object.entries({ x1: start[0], y1: start[1], x2: end[0], y2: end[1] })) node.setAttribute(key, value);
  }
  originPoint.setAttribute('transform', `translate(${frame.x} ${frame.y})`);
}
