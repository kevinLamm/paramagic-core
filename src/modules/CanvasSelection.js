export function resolveWindowSelectionIds(currentIds = [], matchedIds = [], additive = false) {
  const current = new Set(currentIds);
  const matched = [...new Set(matchedIds)];
  if (!additive) return matched;
  const remove = matched.length > 0 && matched.every((id) => current.has(id));
  matched.forEach((id) => {
    if (remove) current.delete(id);
    else current.add(id);
  });
  return [...current];
}

export const CANVAS_POINT_HIT_RADIUS_PX = 9;

export function canvasPointHandleHitDistance(handle, clientX, clientY) {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return Infinity;
  if (handle.closest?.('.stack-hidden, .stack-disabled, [hidden], .overlap-cycle-indicator, .canvas-hover-layer, .canvas-stack-hover-layer')) return Infinity;
  const rect = handle.getBoundingClientRect();
  if (!rect.width || !rect.height) return Infinity;
  const distance = Math.hypot(clientX - (rect.left + rect.width / 2), clientY - (rect.top + rect.height / 2));
  if (distance > CANVAS_POINT_HIT_RADIUS_PX) return Infinity;
  const style = handle.ownerDocument?.defaultView?.getComputedStyle(handle);
  if (style?.visibility === 'hidden' || style?.visibility === 'collapse' || style?.display === 'none') return Infinity;
  return distance;
}

export function canvasFeatureFromEvent(canvas, event, { preferPoints = false, ...featureOptions } = {}) {
  const direct = canvas.getFeatureFromEvent(event, featureOptions);
  // A cycle choice is explicit. Do not replace its point or edge with a
  // nearby point, even for tools that accept both kinds of feature.
  if (event.paramagicSelectionTarget || direct?.kind === 'point'
    || !preferPoints) return direct;
  const canvasElement = canvas.getCanvasElement?.();
  if (canvasElement?.classList?.contains('point-handles-disabled')) return direct;
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return direct;

  const layers = [canvas.getHandleLayer?.(), canvas.getObjectLayer?.()].filter(Boolean);
  if (!layers.length && canvasElement) layers.push(canvasElement);
  const candidates = [...new Set(layers.flatMap(layer => [...layer.querySelectorAll('.point-handle')]))]
    .reverse().flatMap(handle => {
      const distance = canvasPointHandleHitDistance(handle, event.clientX, event.clientY);
      return Number.isFinite(distance) ? [{ handle, distance }] : [];
    }).sort((a, b) => a.distance - b.distance);

  // Hover-hidden handles must remain eligible: a wide neighboring edge hit
  // area can prevent their owner from receiving hover in the first place.
  for (const { handle } of candidates) {
    const point = canvas.getFeatureFromEvent({
      target: handle, clientX: event.clientX, clientY: event.clientY,
    }, featureOptions);
    if (point?.kind === 'point') return point;
  }
  return direct;
}
