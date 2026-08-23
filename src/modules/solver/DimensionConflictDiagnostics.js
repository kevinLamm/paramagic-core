import { isCanvasOriginReference } from '../CanvasOrigin.js';

function pointVariableIds(model, reference) {
  if (!reference) return [];
  if (isCanvasOriginReference(reference)) return ['canvas-origin:x', 'canvas-origin:y'];
  const binding = model.binding(reference.recordId || reference.entityId);
  if (!binding) return [];

  if (reference.kind === 'point' || reference.type === 'point') {
    return binding.variableIdsForPoint(reference.index || 0, reference.pointRole);
  }
  if (reference.type === 'center') return binding.variableIdsForPoint(0, reference.pointRole);

  if (!['segment-start', 'segment-end', 'segment-point'].includes(reference.type)) return [];
  const segmentIndex = Number(reference.index) || 0;
  let endpoint = reference.type === 'segment-start' ? 'start' : 'end';
  if (reference.type === 'segment-point') {
    const ratio = Math.max(0, Math.min(1, Number(reference.ratio) || 0));
    if (ratio > 1e-9 && ratio < 1 - 1e-9) return [];
    endpoint = ratio < 0.5 ? 'start' : 'end';
  }

  if (binding.type === 'line') return binding.variableIdsForPoint(endpoint === 'start' ? 0 : 2);
  if (binding.type === 'polygon' || binding.type === 'polyline') {
    const pointCount = Number(binding.metadata?.pointCount) || 0;
    if (!pointCount) return [];
    const pointIndex = endpoint === 'start' ? segmentIndex : (segmentIndex + 1) % pointCount;
    return binding.variableIdsForPoint(pointIndex);
  }
  return [];
}

function segmentEndpointVariableIds(model, reference) {
  if (!reference) return null;
  const base = {
    recordId: reference.recordId,
    entityId: reference.entityId,
    index: reference.index || 0,
  };
  const start = pointVariableIds(model, { ...base, type: 'segment-start' });
  const end = pointVariableIds(model, { ...base, type: 'segment-end' });
  return start.length === 2 && end.length === 2 ? { start, end } : null;
}

function addEdge(graph, first, second, dimensionId = null) {
  if (!first || !second || first === second) return;
  if (!graph.has(first)) graph.set(first, []);
  if (!graph.has(second)) graph.set(second, []);
  graph.get(first).push({ node: second, dimensionId });
  graph.get(second).push({ node: first, dimensionId });
}

function addConstraintEdges(graph, model, constraint, excludedConstraintId) {
  if (constraint.enabled === false || constraint.id === excludedConstraintId) return;
  if (constraint.type === 'Coincident') {
    const [first, second] = constraint.featureRefs || [];
    const firstIds = pointVariableIds(model, first);
    const secondIds = pointVariableIds(model, second);
    if (firstIds.length === 2 && secondIds.length === 2) {
      addEdge(graph, firstIds[0], secondIds[0]);
      addEdge(graph, firstIds[1], secondIds[1]);
    }
    return;
  }
  if (constraint.type === 'Horizontal' || constraint.type === 'Vertical') {
    const endpoints = segmentEndpointVariableIds(model, constraint.featureRefs?.[0]);
    if (!endpoints) return;
    const axis = constraint.type === 'Horizontal' ? 1 : 0;
    addEdge(graph, endpoints.start[axis], endpoints.end[axis]);
    return;
  }
  if (constraint.type !== 'Horizontal Distance' && constraint.type !== 'Vertical Distance') return;
  const start = pointVariableIds(model, constraint.anchors?.start || constraint.featureRefs?.[0]);
  const end = pointVariableIds(model, constraint.anchors?.end || constraint.featureRefs?.[1]);
  if (start.length !== 2 || end.length !== 2) return;
  const axis = constraint.type === 'Horizontal Distance' ? 0 : 1;
  addEdge(graph, start[axis], end[axis], constraint.dimensionRef || null);
}

function alternatePathDimensionIds(graph, start, end) {
  const queue = [{ node: start, dimensions: [] }];
  const visited = new Set([start]);
  while (queue.length) {
    const current = queue.shift();
    if (current.node === end) return [...new Set(current.dimensions)];
    for (const edge of graph.get(current.node) || []) {
      if (visited.has(edge.node)) continue;
      visited.add(edge.node);
      queue.push({
        node: edge.node,
        dimensions: edge.dimensionId
          ? [...current.dimensions, edge.dimensionId]
          : current.dimensions,
      });
    }
  }
  return [];
}

/**
 * Finds an alternate axis-constraint path around a driving horizontal or
 * vertical distance. Such a path means the edited dimension closes a loop
 * whose value is already determined by the other driving dimensions.
 */
export function findDrivingDimensionLoop(model, dimensions, dimensionId) {
  const constraintId = [...model.constraints.values()]
    .find((constraint) => constraint.dimensionRef === dimensionId)?.id;
  const constraint = constraintId ? model.constraints.get(constraintId) : null;
  if (!constraint || !['Horizontal Distance', 'Vertical Distance'].includes(constraint.type)) return null;

  const start = pointVariableIds(model, constraint.anchors?.start || constraint.featureRefs?.[0]);
  const end = pointVariableIds(model, constraint.anchors?.end || constraint.featureRefs?.[1]);
  if (start.length !== 2 || end.length !== 2) return null;
  const axis = constraint.type === 'Horizontal Distance' ? 0 : 1;
  const graph = new Map();
  for (const candidate of model.constraints.values()) {
    addConstraintEdges(graph, model, candidate, constraint.id);
  }
  const relatedDimensionIds = alternatePathDimensionIds(graph, start[axis], end[axis])
    .filter((id) => {
      const entry = dimensions.get(id);
      return id !== dimensionId
        && entry?.kind === 'dimension'
        && entry.driving
        && entry.enabled !== false;
    });
  if (!relatedDimensionIds.length) return null;
  return {
    dimensionId,
    dimensionName: dimensions.get(dimensionId)?.name || dimensionId,
    relatedDimensionIds,
    relatedDimensionNames: relatedDimensionIds
      .map((id) => dimensions.get(id)?.name || id)
      .sort((first, second) => first.localeCompare(second, undefined, { numeric: true })),
  };
}

export function formatDrivingDimensionLoopMessage({
  diagnostic,
  sourceName,
  requestedExpression,
  requiredValue,
}) {
  const related = diagnostic.relatedDimensionNames;
  const relatedText = related.length === 1
    ? related[0]
    : `${related.slice(0, -1).join(', ')}, and ${related.at(-1)}`;
  const directEdit = sourceName === diagnostic.dimensionName;
  const action = directEdit
    ? `${diagnostic.dimensionName} cannot use "${requestedExpression}"`
    : `Changing ${sourceName} would create a conflict for ${diagnostic.dimensionName}`;
  const requirement = requiredValue
    ? ` The loop currently requires ${diagnostic.dimensionName} = ${requiredValue}.`
    : '';
  return `${action} because it closes a driving-dimension loop with ${relatedText}.${requirement} Make one dimension in this loop driven, or change a related value or expression. Geometry was restored.`;
}
