import { createStackTreeIndex, subtreeStackIds } from './StackArchitecture.js';
import { pruneDormantStackRelationships } from './StackRelationshipSystem.js';

export function planStackDeletion(state, stackId, { children = 'delete' } = {}) {
  if (!['delete', 'move'].includes(children)) throw new TypeError('Choose whether to delete or move child Stacks.');
  const index = createStackTreeIndex(state);
  const target = index.byId.get(stackId);
  if (!target?.removable) return null;
  const removedStackIds = children === 'delete' ? subtreeStackIds(index.state, stackId) : [stackId];
  const removed = new Set(removedStackIds);
  const promoted = children === 'move' ? index.children(stackId) : [];
  const promotedIds = new Set(promoted.map(s => s.id));
  const siblings = index.children(target.parentStackId).flatMap(s => s.id === stackId ? promoted : [s]);
  const orders = new Map(siblings.map((s, i) => [s.id, i]));
  const remainingStacks = index.state.stacks.filter(s => !removed.has(s.id)).map(s => ({
    ...s,
    ...(promotedIds.has(s.id) ? { parentStackId: target.parentStackId } : {}),
    ...(orders.has(s.id) ? { order: orders.get(s.id) } : {}),
  }));
  return { removedStackIds, promotedStackIds: [...promotedIds], remainingStacks };
}

export function createStackDeletionAction({ stacks, solver, checkpoint, deleteRecords,
  extensionProviders, getRelationships, setRelationships }) {
  return (stackId, options = {}) => {
    const state = stacks.getState();
    const plan = planStackDeletion(state, stackId, options);
    if (!plan) return false;
    checkpoint('stack-remove');
    const { removedStackIds } = plan;
    const removed = new Set(removedStackIds);
    const recordIds = removedStackIds.flatMap(stacks.recordIdsForStack);
    const sourceIds = items => items.map(s => s.sourceStackId || s.id);
    const relationships = getRelationships();
    if (relationships) setRelationships(pruneDormantStackRelationships(relationships, {
      removedSourceStackIds: sourceIds(state.stacks.filter(s => removed.has(s.id))),
      remainingSourceStackIds: sourceIds(state.stacks.filter(s => !removed.has(s.id))),
    }));
    extensionProviders.forEach(provider => removedStackIds.forEach(id => provider.removeStackReferences?.(id, recordIds)));
    const removedData = solver.removeStackDataMany?.(removedStackIds, recordIds)
      || removedStackIds.reduce((result, id) => {
        Object.entries(solver.removeStackData?.(id, recordIds) || {}).forEach(([key, values]) => {
          result[key] = [...new Set([...(result[key] || []), ...(values || [])])];
        });
        return result;
      }, {});
    // Delete by ownership, independent of which Stacks can currently be selected.
    deleteRecords([...new Set([...recordIds, ...(removedData.annotationIds || [])])], {
      checkpoint: false, notify: false, respectLocks: false,
    });
    return Boolean(stacks.removeStackSubtree(stackId, options));
  };
}
