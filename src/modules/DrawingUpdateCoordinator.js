// One drawing revision owns dependent evaluation, presentation and notification.
// A dependent may change source geometry. Restart evaluation in the same turn,
// before publishing that revision, rather than recursively notifying observers.
export function createDrawingUpdateCoordinator({ schedule = queueMicrotask, publish = () => {}, maximumRounds = 16, beforeFlush = () => {}, afterFlush = () => {} } = {}) {
  const stages = new Map();
  const invalidators = new Set();
  let pending = null;
  let scheduled = false;
  let running = false;
  let revision = 0;
  const historyRank = { none: 0, coalesce: 1, commit: 2 };
  function invalidate({ changedRecordIds = null, history = 'none', objectsChanged = false } = {}) {
    const change = { changedRecordIds, history, objectsChanged, revision: ++revision };
    invalidators.forEach((listener) => listener(change));
    if (!pending) pending = { changedRecordIds: new Set(), full: false, history: 'none', objectsChanged: false };
    if (changedRecordIds === null) pending.full = true;
    else changedRecordIds.forEach((id) => pending.changedRecordIds.add(id));
    if (historyRank[history] > historyRank[pending.history]) pending.history = history;
    pending.objectsChanged ||= objectsChanged;
    if (!scheduled && !running) {
      scheduled = true;
      schedule(flush);
    }
  }
  function flush() {
    scheduled = false;
    if (running || !pending) return;
    running = true;
    const change = pending;
    try {
      beforeFlush();
      for (let round = 0; round < maximumRounds; round += 1) {
        const currentRevision = revision;
        const context = { ...change, changedRecordIds: change.full ? null : new Set(change.changedRecordIds), revision };
        for (const stage of [...stages.values()].sort((a, b) => a.order - b.order)) {
          stage.update(context);
          if (revision !== currentRevision) break;
        }
        if (revision !== currentRevision) continue;
        pending = null;
        publish(context);
        return;
      }
      throw new Error('Dependent geometry did not stabilize within one drawing update.');
    } catch (error) {
      pending = null;
      throw error;
    } finally {
      afterFlush();
      running = false;
      if (pending && pending !== change && !scheduled) {
        scheduled = true;
        schedule(flush);
      }
    }
  }
  return {
    invalidate, flush,
    get pending() { return Boolean(pending); },
    get running() { return running; },
    get revision() { return revision; },
    register(name, update, order = 50) {
      stages.set(name, { update, order });
      return () => stages.delete(name);
    },
    onInvalidate(listener) { invalidators.add(listener); return () => invalidators.delete(listener); },
  };
}

// Dependency invalidation is transitive. IDs may name source records or other
// derived objects; deleting a source invalidates its consumers as well.
export class DrawingDependencyIndex {
  constructor() { this.sources = new Map(); this.consumers = new Map(); }
  set(id, sources) {
    this.delete(id);
    const unique = new Set(sources);
    this.sources.set(id, unique);
    unique.forEach((source) => {
      if (!this.consumers.has(source)) this.consumers.set(source, new Set());
      this.consumers.get(source).add(id);
    });
  }
  delete(id) {
    this.sources.get(id)?.forEach((source) => {
      const consumers = this.consumers.get(source);
      consumers?.delete(id);
      if (!consumers?.size) this.consumers.delete(source);
    });
    this.sources.delete(id);
  }
  affected(ids) {
    const result = new Set(ids);
    const queue = [...result];
    for (let i = 0; i < queue.length; i += 1) {
      this.consumers.get(queue[i])?.forEach((id) => {
        if (!result.has(id)) { result.add(id); queue.push(id); }
      });
    }
    return result;
  }
}
