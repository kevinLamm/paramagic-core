function recordStackId(record, fallbackStackId = null) {
  return String(record?.stackId || fallbackStackId || '');
}

function relationshipStackIds(record, fallbackStackId = null) {
  return [...new Set([
    recordStackId(record, fallbackStackId),
    ...(record?.participantStackIds || []).map(String),
  ].filter(Boolean))];
}

export function buildStackParticipationGraph({
  stackIds = [],
  enabledStackIds = null,
  entities = [],
  constraints = [],
  dimensions = [],
  relationships = [],
  defaultStackId = null,
} = {}) {
  const adjacency = new Map();
  const enabled = enabledStackIds ? new Set([...enabledStackIds].map(String)) : null;
  const addStack = (stackId) => {
    const id = String(stackId || defaultStackId || '');
    if (!id || (enabled && !enabled.has(id))) return null;
    if (!adjacency.has(id)) adjacency.set(id, new Set());
    return id;
  };
  stackIds.forEach(addStack);
  entities.forEach((entity) => addStack(recordStackId(entity, defaultStackId)));
  [...constraints, ...dimensions, ...relationships].forEach((relationship) => {
    const relationshipStacks = relationshipStackIds(relationship, defaultStackId);
    if (enabled && relationshipStacks.some((stackId) => !enabled.has(stackId))) return;
    const participants = relationshipStacks.map(addStack).filter(Boolean);
    participants.forEach((stackId) => participants.forEach((otherId) => {
      if (otherId !== stackId) adjacency.get(stackId).add(otherId);
    }));
  });
  return adjacency;
}

export function transitiveParticipantStackIds(graph, seedStackIds = []) {
  const visited = new Set();
  const pending = [...new Set(seedStackIds.filter(Boolean).map(String))];
  while (pending.length) {
    const stackId = pending.pop();
    if (visited.has(stackId)) continue;
    visited.add(stackId);
    graph.get(stackId)?.forEach((participantId) => pending.push(participantId));
  }
  return visited;
}

export function stackParticipationGroups(graph) {
  const remaining = new Set(graph.keys());
  const groups = [];
  while (remaining.size) {
    const seed = remaining.values().next().value;
    const group = transitiveParticipantStackIds(graph, [seed]);
    group.forEach((stackId) => remaining.delete(stackId));
    groups.push(group);
  }
  return groups;
}

export function stackIdsForEntities(entities = [], entityIds = []) {
  const requested = new Set(entityIds);
  return new Set(entities
    .filter((entity) => requested.has(entity.id))
    .map(recordStackId));
}

export function aggregateStackSolveResults(results = []) {
  if (!results.length) {
    return {
      status: 'unchanged',
      message: 'No Stack solver contexts required solving.',
      changedEntityIds: [],
      problematicConstraintIds: [],
      stackResults: [],
    };
  }
  const failure = results.find(({ result }) => !['converged', 'unchanged', 'preview'].includes(result?.status));
  const changedEntityIds = [...new Set(results.flatMap(({ result }) => result?.changedEntityIds || []))];
  const problematicConstraintIds = [...new Set(results.flatMap(({ result }) => result?.problematicConstraintIds || []))];
  const iterations = results.reduce((sum, { result }) => sum + (Number(result?.iterations) || 0), 0);
  const finalError = Math.max(...results.map(({ result }) => Number(result?.finalError) || 0));
  const componentStats = {
    componentCount: results.reduce((sum, { result }) => sum + (result?.componentStats?.componentCount || 0), 0),
    solvedComponentCount: results.reduce((sum, { result }) => sum + (result?.componentStats?.solvedComponentCount || 0), 0),
    constrainedComponentCount: results.reduce((sum, { result }) => sum + (result?.componentStats?.constrainedComponentCount || 0), 0),
    largestVariableCount: Math.max(...results.map(({ result }) => result?.componentStats?.largestVariableCount || 0)),
    largestConstraintCount: Math.max(...results.map(({ result }) => result?.componentStats?.largestConstraintCount || 0)),
  };
  return {
    ...(failure?.result || results.at(-1)?.result || {}),
    status: failure?.result?.status
      || (results.some(({ result }) => result?.status === 'preview') ? 'preview' : changedEntityIds.length ? 'converged' : 'unchanged'),
    changedEntityIds,
    problematicConstraintIds,
    iterations,
    finalError,
    componentStats,
    stackResults: results.map(({ stackIds, result }) => ({
      stackIds: [...stackIds],
      status: result?.status,
      iterations: result?.iterations || 0,
      finalError: result?.finalError || 0,
    })),
  };
}
