import {
  createSolverWorkerRequest,
  interactiveSolverWorkerCommandTypes,
  validateSolverWorkerResult,
} from './SolverWorkerProtocol.js';

const now = () => globalThis.performance?.now?.() ?? Date.now();

export class SolverWorkerClient {
  constructor(worker, { backend = 'javascript' } = {}) {
    if (!worker?.postMessage) throw new TypeError('SolverWorkerClient requires a Worker-compatible transport.');
    this.worker = worker;
    this.backend = backend;
    this.nextRequestToken = 1;
    this.nextGeneration = 1;
    this.latestInteractiveGeneration = 0;
    this.inFlight = null;
    this.queue = [];
    this.withheldDeltas = new Map();
    this.handleMessage = this.handleMessage.bind(this);
    this.handleError = this.handleError.bind(this);
    this.worker.addEventListener?.('message', this.handleMessage);
    this.worker.addEventListener?.('error', this.handleError);
  }

  request(type, payload = {}, { coalesceKey = null } = {}) {
    const interactive = interactiveSolverWorkerCommandTypes.has(type);
    const generation = interactive ? this.nextGeneration++ : this.nextGeneration;
    if (interactive) this.latestInteractiveGeneration = generation;
    return new Promise((resolve, reject) => {
      const entry = {
        request: createSolverWorkerRequest({
          requestToken: this.nextRequestToken++,
          generation,
          type,
          payload,
        }),
        interactive,
        coalesceKey,
        queuedAt: now(),
        dispatchedAt: null,
        resolve,
        reject,
      };
      const previous = this.queue[this.queue.length - 1];
      const replaceQueued = (interactive && previous?.interactive)
        || (type === 'load-sketch' && previous?.request.type === 'load-sketch')
        || (coalesceKey && previous?.coalesceKey === coalesceKey);
      if (replaceQueued) {
        this.queue[this.queue.length - 1] = entry;
        previous.resolve({
          version: previous.request.version,
          requestToken: previous.request.requestToken,
          revision: previous.request.requestToken,
          generation: previous.request.generation,
          type: 'result',
          commandType: previous.request.type,
          status: interactive ? 'stale' : 'superseded',
          changedEntities: [],
          changedDimensions: [],
          changedParameters: [],
          changedConstraints: [],
          removedConstraintIds: [],
          diagnostics: { coalesced: true },
        });
      } else {
        this.queue.push(entry);
      }
      // Only consecutive edits to the same target supersede an active transaction.
      // Structural commands and other parameter edits remain ordered barriers.
      if (this.backend === 'wasm' && coalesceKey && this.inFlight?.coalesceKey === coalesceKey
          && this.queue.every(queued => queued.coalesceKey === coalesceKey)) {
        this.inFlight.supersededByRevision = entry.request.requestToken;
        this.worker.postMessage({ type: 'supersede', requestToken: this.inFlight.request.requestToken });
      }
      this.pump();
    });
  }

  pump() {
    if (this.inFlight || !this.queue.length) return;
    this.inFlight = this.queue.shift();
    this.inFlight.dispatchedAt = now();
    this.worker.postMessage(this.inFlight.request);
  }

  handleMessage(event) {
    let result;
    try {
      result = validateSolverWorkerResult(event?.data);
    } catch (error) {
      this.inFlight?.reject(error);
      this.inFlight = null;
      this.pump();
      return;
    }
    if (!this.inFlight || result.requestToken !== this.inFlight.request.requestToken) return;
    const entry = this.inFlight;
    this.inFlight = null;
    const timedResult = {
      ...result,
      diagnostics: {
        ...result.diagnostics,
        queueMs: Math.max(0, entry.dispatchedAt - entry.queuedAt),
        roundTripMs: Math.max(0, now() - entry.dispatchedAt),
      },
    };
    if (entry.supersededByRevision) {
      // Cancellation can race a completed native transaction. Hide that old
      // revision, but retain its committed delta for the next accepted result.
      const delta = this.withheldDeltas.get(entry.coalesceKey) || { entities: new Map(), parameters: new Map() };
      result.changedEntities.forEach(entity => delta.entities.set(entity.id, entity));
      (result.changedParameters || []).forEach(parameter => delta.parameters.set(parameter.id, parameter));
      this.withheldDeltas.set(entry.coalesceKey, delta);
      entry.resolve({ ...timedResult, status: 'superseded', changedEntities: [], changedParameters: [],
        diagnostics: { ...timedResult.diagnostics, supersededByRevision: entry.supersededByRevision } });
      this.pump();
      return;
    }
    const withheld = this.withheldDeltas.get(entry.coalesceKey);
    if (withheld) {
      result.changedEntities.forEach(entity => withheld.entities.set(entity.id, entity));
      (result.changedParameters || []).forEach(parameter => withheld.parameters.set(parameter.id, parameter));
      timedResult.changedEntities = [...withheld.entities.values()];
      timedResult.changedParameters = [...withheld.parameters.values()];
      this.withheldDeltas.delete(entry.coalesceKey);
    }
    if (entry.interactive && result.generation < this.latestInteractiveGeneration) {
      // The Worker had already started this solve before a newer pointer
      // position arrived. Its internal model may use the result as the base
      // for the queued solve, but the main thread must never render it: doing
      // so makes the canvas replay old positions and perform a full drawing
      // refresh for work the pointer has already superseded.
      entry.resolve({
        ...timedResult,
        status: 'stale',
        changedEntities: [],
        changedDimensions: [],
        changedParameters: [],
        changedConstraints: [],
        removedConstraintIds: [],
        diagnostics: {
          ...timedResult.diagnostics,
          supersededByGeneration: this.latestInteractiveGeneration,
        },
      });
    } else entry.resolve(timedResult);
    this.pump();
  }

  handleError(event) {
    this.withheldDeltas.clear();
    const error = event?.error || new Error(event?.message || 'Solver worker failed.');
    this.inFlight?.reject(error);
    this.inFlight = null;
    this.queue.splice(0).forEach((entry) => entry.reject(error));
  }

  loadSketch(snapshot) {
    return this.request('load-sketch', { snapshot });
  }

  applyGeometry(entities, result) {
    return this.request('apply-geometry', { entities, result });
  }

  updateModel(updates) {
    return this.request('update-model', { updates });
  }

  getSnapshot() {
    return this.request('get-snapshot');
  }

  solve(options = {}) {
    return this.request('solve', { options });
  }

  addEntity(entity) {
    return this.request('add-entity', { entity });
  }

  removeEntity(entityId) {
    return this.request('remove-entity', { entityId });
  }

  updateEntities(entities, options = {}) {
    return this.request('update-entities', { entities, lockedVariableIds: options.lockedVariableIds || [] });
  }

  supersedeInteractivePreview() {
    // Pointer input is newer even before the next animation frame dispatches it.
    this.latestInteractiveGeneration = this.nextGeneration;
  }

  dragUpdate(entities, options = {}) {
    return this.request('drag-update', {
      entities,
      lockedVariableIds: options.lockedVariableIds || [],
      ...(options.previewConstraintTolerance === undefined
        ? {}
        : { previewConstraintTolerance: options.previewConstraintTolerance }),
    });
  }

  addConstraint(constraint) {
    return this.request('add-constraint', { constraint });
  }

  removeConstraint(constraintId) {
    return this.request('remove-constraint', { constraintId });
  }

  setDimension(dimensionId, expression) {
    return this.request('set-dimension', { dimensionId, expression }, {
      coalesceKey: this.backend === 'wasm' ? `dimension:${dimensionId}` : null,
    });
  }

  updateParameter(parameterId, patch, options = {}) {
    return this.request('update-parameter', { parameterId, patch }, options);
  }

  setDimensionEnabledStates(states) {
    return this.request('set-dimension-enabled-states', { states: [...states] });
  }

  setEnabledStackIds(stackIds = null) {
    return this.request('set-enabled-stack-ids', { stackIds: stackIds === null ? null : [...stackIds] });
  }

  terminate() {
    this.withheldDeltas.clear();
    this.worker.removeEventListener?.('message', this.handleMessage);
    this.worker.removeEventListener?.('error', this.handleError);
    this.worker.terminate?.();
  }
}

export function createSolverWorkerClient(worker) {
  return new SolverWorkerClient(worker);
}

export function createBrowserSolverWorkerClient({ jacobianMode = 'dense', backend = 'javascript' } = {}) {
  // Keep the URL literal inside the constructor so Vite bundles the Worker
  // dependency graph and the native asset for both deployment targets.
  const worker = new Worker(new URL('./SolverWorker.js', import.meta.url), { type: 'module' });
  worker.postMessage({ type: 'initialize', jacobianMode, backend });
  return new SolverWorkerClient(worker, { backend });
}
