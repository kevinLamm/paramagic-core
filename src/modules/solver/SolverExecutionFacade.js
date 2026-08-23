import { createSolverController } from './SolverController.js';
import { SolverMutationJournal } from './SolverMutationJournal.js';
import { createBrowserSolverWorkerClient } from './SolverWorkerClient.js';
import { createStableId } from './SolverModel.js';

const resyncMethods = new Set([
  'addDimension',
  'clear',
  'createControlParameter',
  'createParameter',
  'removeDimension',
  'removeParameter',
  'restoreFilletRadiusDimension',
  'reorderParameter',
  'restoreDimensionSnapshot',
  'setDerivedEntity',
  'removeDerivedEntity',
  'setDocumentContext',
  'setDocumentMetadata',
  'setDrawingProperties',
  'updateCurveControlPoints',
  'updateDimensionAnnotation',
  'updateEntity',
  'updateEntityAppearances',
  'updateEntityConstruction',
  'updateEntitySubtraction',
]);

function normalized(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Number(value.toPrecision(12)) : value;
  if (Array.isArray(value)) return value.map(normalized);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalized(value[key])]));
}

function equivalent(first, second) {
  return JSON.stringify(normalized(first)) === JSON.stringify(normalized(second));
}

function maximumNumericDelta(first, second) {
  if (typeof first === 'number' || typeof second === 'number') {
    return typeof first === 'number' && typeof second === 'number'
      ? Math.abs(first - second)
      : Infinity;
  }
  if (Array.isArray(first) || Array.isArray(second)) {
    if (!Array.isArray(first) || !Array.isArray(second) || first.length !== second.length) return Infinity;
    return first.reduce((largest, item, index) => Math.max(largest, maximumNumericDelta(item, second[index])), 0);
  }
  if (!first || !second || typeof first !== 'object' || typeof second !== 'object') return 0;
  const keys = new Set([...Object.keys(first), ...Object.keys(second)]);
  return [...keys].reduce((largest, key) => Math.max(largest, maximumNumericDelta(first[key], second[key])), 0);
}

export function previewEntitiesForReplica(controller, entities, directlyEditedIds = [], tolerance = 0) {
  const threshold = Math.max(0, Number(tolerance) || 0);
  if (!threshold) return entities;
  const direct = new Set(directlyEditedIds);
  return entities.filter((entity) => (
    direct.has(entity.id)
    || maximumNumericDelta(controller.getEntity(entity.id), entity) >= threshold
  ));
}

function resultStatus(outcome, controller) {
  return outcome?.result?.status || outcome?.status || controller.lastResult?.status || null;
}

export class SolverExecutionFacade {
  constructor({
    controller = null,
    workerClient = null,
    workerFactory = null,
    maxRestartAttempts = 2,
    checkpointInterval = 50,
    mode = 'sync',
    jacobianMode = 'dense',
  } = {}) {
    this.jacobianMode = jacobianMode === 'blocks' ? 'blocks' : 'dense';
    this.controller = controller || createSolverController({ jacobianMode: this.jacobianMode });
    this.mode = ['shadow', 'worker-drag'].includes(mode) ? mode : 'sync';
    this.workerClient = this.mode !== 'sync' ? workerClient : null;
    this.workerFactory = this.mode !== 'sync' ? workerFactory : null;
    this.maxRestartAttempts = Math.max(0, Number(maxRestartAttempts) || 0);
    this.restartCount = 0;
    this.restartPromise = null;
    this.terminateRequested = false;
    this.mutationRevision = 0;
    this.lastAcceptedRevision = -1;
    this.mutationJournal = new SolverMutationJournal({
      revision: 0,
      snapshot: this.controller.getSketchSnapshot(),
      checkpointInterval,
    });
    this.workerState = this.workerClient ? 'initializing' : 'disabled';
    this.lastWorkerError = null;
    this.lastParityError = null;
    this.executionListeners = new Set();
    this.dragVariableIds = new Set();
    this.forwardedMethods = new Map();
    if (this.workerClient) {
      const checkpoint = this.mutationJournal.checkpointSnapshot();
      this.enqueueWorker(() => this.workerClient.loadSketch(checkpoint.snapshot), null, checkpoint.revision);
    }
  }

  executionStatus() {
    return {
      mode: this.mode,
      jacobianMode: this.jacobianMode,
      state: this.workerState,
      error: this.lastWorkerError,
      parityError: this.lastParityError,
      revision: this.mutationRevision,
      acceptedRevision: this.lastAcceptedRevision,
      restartCount: this.restartCount,
      journal: this.mutationJournal.diagnostics(),
    };
  }

  subscribeExecution(listener) {
    this.executionListeners.add(listener);
    listener(this.executionStatus());
    return () => this.executionListeners.delete(listener);
  }

  emitExecutionStatus() {
    const status = this.executionStatus();
    this.executionListeners.forEach((listener) => listener(status));
  }

  disableWorker(error) {
    this.lastWorkerError = error instanceof Error ? error.message : String(error || 'Solver worker failed.');
    this.workerState = 'fallback';
    this.workerClient?.terminate();
    this.workerClient = null;
    this.restartPromise = null;
    this.emitExecutionStatus();
  }

  recordMutation() {
    this.mutationRevision += 1;
    return this.mutationRevision;
  }

  recordWorkerCommand(type, payload, { coalesceKey = null } = {}) {
    const revision = this.recordMutation();
    this.mutationJournal.record({ revision, type, payload, coalesceKey });
    return revision;
  }

  async restartWorker(error) {
    if (this.terminateRequested || this.mode === 'sync' || !this.workerFactory) {
      this.disableWorker(error);
      return false;
    }
    if (this.restartPromise) return this.restartPromise;
    this.lastWorkerError = error instanceof Error ? error.message : String(error || 'Solver worker failed.');
    this.workerClient?.terminate();
    this.workerClient = null;
    this.workerState = 'restarting';
    this.emitExecutionStatus();
    this.restartPromise = (async () => {
      let failure = error;
      while (!this.terminateRequested && this.restartCount < this.maxRestartAttempts) {
        this.restartCount += 1;
        let client = null;
        try {
          client = this.workerFactory();
          this.workerClient = client;
          let checkpoint = this.mutationJournal.checkpointSnapshot();
          let recoveredRevision = checkpoint.revision;
          let result = await client.loadSketch(checkpoint.snapshot);
          if (result.status === 'invalid') throw new Error(result.message || 'Solver worker rejected its recovery checkpoint.');
          while (recoveredRevision !== this.mutationRevision) {
            checkpoint = this.mutationJournal.checkpointSnapshot();
            if (checkpoint.revision > recoveredRevision) {
              result = await client.loadSketch(checkpoint.snapshot);
              if (result.status === 'invalid') throw new Error(result.message || 'Solver worker rejected its recovery checkpoint.');
              recoveredRevision = checkpoint.revision;
              continue;
            }
            const targetRevision = this.mutationRevision;
            const commands = this.mutationJournal.recoveryPlan(recoveredRevision, targetRevision);
            if (!commands.length) throw new Error(`Solver recovery journal has a revision gap after ${recoveredRevision}.`);
            for (const command of commands) {
              result = await client.request(command.type, command.payload);
              if (!result) throw new Error(`Solver worker did not acknowledge recovery revision ${command.revision}.`);
              recoveredRevision = command.revision;
            }
          }
          this.mutationJournal.accept(recoveredRevision);
          this.lastAcceptedRevision = recoveredRevision;
          this.lastWorkerError = null;
          this.lastParityError = null;
          this.workerState = 'ready';
          this.emitExecutionStatus();
          return true;
        } catch (restartError) {
          failure = restartError;
          client?.terminate();
          if (this.workerClient === client) this.workerClient = null;
        }
      }
      this.disableWorker(failure);
      return false;
    })();
    const pendingRestart = this.restartPromise;
    pendingRestart.finally(() => {
      if (this.restartPromise === pendingRestart) this.restartPromise = null;
    });
    return pendingRestart;
  }

  async waitForWorkerReady() {
    if (this.restartPromise) await this.restartPromise;
    return this.executionStatus();
  }

  enqueueWorker(operation, parity = null, revision = this.mutationRevision) {
    if (!this.workerClient) return null;
    let pending;
    try {
      pending = operation();
    } catch (error) {
      this.restartWorker(error);
      return null;
    }
    return Promise.resolve(pending).then((result) => {
      if (result.status === 'stale' || result.status === 'superseded') return result;
      this.mutationJournal.accept(revision);
      this.lastAcceptedRevision = Math.max(this.lastAcceptedRevision, revision);
      if (this.mutationJournal.shouldCheckpoint(this.mutationRevision)) {
        this.mutationJournal.installCheckpoint(this.mutationRevision, this.controller.getSketchSnapshot());
      }
      this.workerState = 'ready';
      if (parity) {
        const mismatch = parity(result);
        if (mismatch) {
          this.lastParityError = mismatch;
          this.workerState = 'degraded';
        }
      }
      this.emitExecutionStatus();
      return result;
    }).catch((error) => {
      this.restartWorker(error);
      return null;
    });
  }

  acceptWorkerResult(result, revision, { checkpoint = true } = {}) {
    if (!result || result.status === 'stale' || result.status === 'superseded') return false;
    this.mutationJournal.accept(revision);
    this.lastAcceptedRevision = Math.max(this.lastAcceptedRevision, revision);
    if (checkpoint && this.mutationJournal.shouldCheckpoint(this.mutationRevision)) {
      this.mutationJournal.installCheckpoint(this.mutationRevision, this.controller.getSketchSnapshot());
    }
    this.lastWorkerError = null;
    this.workerState = 'ready';
    this.emitExecutionStatus();
    return true;
  }

  compareDelta(result, localOutcome) {
    const workerStatus = result.status;
    const localStatus = resultStatus(localOutcome, this.controller);
    if (localStatus && workerStatus !== localStatus) return `Worker status ${workerStatus} did not match local status ${localStatus}.`;
    for (const entity of result.changedEntities || []) {
      const localEntity = this.controller.getEntity(entity.id);
      if (!equivalent(entity, localEntity)) return `Worker geometry for ${entity.id} did not match the local fallback.`;
    }
    return null;
  }

  resyncWorker({ record = true } = {}) {
    const snapshot = this.controller.getSketchSnapshot();
    const revision = record
      ? this.recordWorkerCommand('load-sketch', { snapshot }, { coalesceKey: 'full-resync' })
      : this.mutationRevision;
    return this.enqueueWorker(() => this.workerClient.loadSketch(snapshot), null, revision);
  }

  async verifyWorkerParity() {
    if (this.restartPromise) await this.restartPromise;
    if (!this.workerClient) return { matched: false, reason: 'worker-disabled' };
    try {
      const result = await this.workerClient.getSnapshot();
      const matched = equivalent(result.snapshot, this.controller.getSketchSnapshot());
      this.lastParityError = matched ? null : 'Worker snapshot did not match the synchronous fallback.';
      this.workerState = matched ? 'ready' : 'degraded';
      this.emitExecutionStatus();
      return { matched, result };
    } catch (error) {
      await this.restartWorker(error);
      return { matched: false, reason: 'worker-failed', error };
    }
  }

  loadSketch(snapshot) {
    const result = this.controller.loadSketch(snapshot);
    this.resyncWorker();
    return result;
  }

  addEntity(entity) {
    const result = this.controller.addEntity(entity);
    const revision = this.recordWorkerCommand('add-entity', { entity: result });
    this.enqueueWorker(() => this.workerClient.addEntity(result), (workerResult) => this.compareDelta(workerResult, { status: 'completed' }), revision);
    return result;
  }

  removeEntity(entityId) {
    const result = this.controller.removeEntity(entityId);
    const revision = this.recordWorkerCommand('remove-entity', { entityId });
    this.enqueueWorker(() => this.workerClient.removeEntity(entityId), (workerResult) => this.compareDelta(workerResult, { status: result ? 'completed' : 'unchanged' }), revision);
    return result;
  }

  addConstraint(constraint) {
    const result = this.controller.addConstraint(constraint);
    const acceptedConstraint = result.constraint || constraint;
    const revision = this.recordWorkerCommand('add-constraint', { constraint: acceptedConstraint });
    this.enqueueWorker(
      () => this.workerClient.addConstraint(acceptedConstraint),
      (workerResult) => this.compareDelta(workerResult, result),
      revision,
    );
    return result;
  }

  addConstraintAuthoritative(constraint) {
    if (this.mode !== 'worker-drag' || !this.workerClient || this.restartPromise) {
      return this.addConstraint(constraint);
    }
    const requestedConstraint = constraint.id
      ? constraint
      : { ...constraint, id: createStableId('constraint') };
    return this.performAuthoritativeConstraintAdd(requestedConstraint);
  }

  applyConstraintBatch(batch = {}) {
    const outcome = this.controller.applyConstraintBatch(batch);
    if (!outcome?.committed || !this.workerClient) return outcome;
    const snapshot = this.controller.getSketchSnapshot();
    const revision = this.recordWorkerCommand('load-sketch', { snapshot });
    this.enqueueWorker(() => this.workerClient.loadSketch(snapshot), null, revision);
    return outcome;
  }

  async performAuthoritativeConstraintAdd(constraint) {
    const revision = this.recordWorkerCommand('add-constraint', { constraint });
    try {
      const result = await this.workerClient.addConstraint(constraint);
      if (!this.acceptWorkerResult(result, revision, { checkpoint: false })) {
        return { constraint: null, result, snapshot: null };
      }
      const acceptedConstraint = result.changedConstraints
        .find(({ id }) => id === constraint.id) || null;
      const outcome = this.controller.applyAuthoritativeState({
        entities: result.changedEntities,
        constraints: acceptedConstraint ? [acceptedConstraint] : [],
      }, result);
      if (this.mutationJournal.shouldCheckpoint(this.mutationRevision)) {
        this.mutationJournal.installCheckpoint(this.mutationRevision, this.controller.getSketchSnapshot());
      }
      return { constraint: acceptedConstraint, result: outcome.result, snapshot: outcome.snapshot };
    } catch (error) {
      await this.restartWorker(error);
      return this.controller.addConstraint(constraint);
    }
  }

  removeConstraint(constraintId) {
    const result = this.controller.removeConstraint(constraintId);
    const revision = this.recordWorkerCommand('remove-constraint', { constraintId });
    const localOutcome = result ? this.controller.lastResult : { status: 'unchanged' };
    this.enqueueWorker(() => this.workerClient.removeConstraint(constraintId), (workerResult) => this.compareDelta(workerResult, localOutcome), revision);
    return result;
  }

  removeConstraintAuthoritative(constraintId) {
    if (this.mode !== 'worker-drag' || !this.workerClient || this.restartPromise) {
      return this.removeConstraint(constraintId);
    }
    return this.performAuthoritativeConstraintRemoval(constraintId);
  }

  async performAuthoritativeConstraintRemoval(constraintId) {
    const revision = this.recordWorkerCommand('remove-constraint', { constraintId });
    try {
      const result = await this.workerClient.removeConstraint(constraintId);
      if (!this.acceptWorkerResult(result, revision, { checkpoint: false })) {
        return { removed: false, result, snapshot: null };
      }
      const removed = result.removedConstraintIds.includes(constraintId);
      const outcome = this.controller.applyAuthoritativeState({
        entities: result.changedEntities,
        removedConstraintIds: removed ? [constraintId] : [],
      }, result);
      if (this.mutationJournal.shouldCheckpoint(this.mutationRevision)) {
        this.mutationJournal.installCheckpoint(this.mutationRevision, this.controller.getSketchSnapshot());
      }
      return { removed, result: outcome.result, snapshot: outcome.snapshot };
    } catch (error) {
      await this.restartWorker(error);
      const removed = this.controller.removeConstraint(constraintId);
      return { removed, result: this.controller.lastResult, snapshot: this.controller.getGeometrySnapshot() };
    }
  }

  setDimension(dimensionId, expression) {
    const result = this.controller.setDimension(dimensionId, expression);
    const revision = this.recordWorkerCommand('set-dimension', { dimensionId, expression });
    this.enqueueWorker(() => this.workerClient.setDimension(dimensionId, expression), (workerResult) => this.compareDelta(workerResult, result), revision);
    return result;
  }

  setDimensionAuthoritative(dimensionId, expression) {
    if (this.mode !== 'worker-drag' || !this.workerClient || this.restartPromise) {
      return this.setDimension(dimensionId, expression);
    }
    return this.performAuthoritativeDimensionUpdate(dimensionId, expression);
  }

  async performAuthoritativeDimensionUpdate(dimensionId, expression) {
    const revision = this.recordWorkerCommand('set-dimension', { dimensionId, expression });
    try {
      const result = await this.workerClient.setDimension(dimensionId, expression);
      if (!this.acceptWorkerResult(result, revision, { checkpoint: false })) return result;
      const outcome = this.controller.applyAuthoritativeState({
        entities: result.changedEntities,
        parameters: result.changedParameters,
      }, result);
      if (this.mutationJournal.shouldCheckpoint(this.mutationRevision)) {
        this.mutationJournal.installCheckpoint(this.mutationRevision, this.controller.getSketchSnapshot());
      }
      return outcome.result;
    } catch (error) {
      await this.restartWorker(error);
      return this.controller.setDimension(dimensionId, expression);
    }
  }

  updateParameter(parameterId, patch) {
    const result = this.controller.updateParameter(parameterId, patch);
    const revision = this.recordWorkerCommand('update-parameter', { parameterId, patch });
    this.enqueueWorker(() => this.workerClient.updateParameter(parameterId, patch), (workerResult) => this.compareDelta(workerResult, result), revision);
    return result;
  }

  updateParameterAuthoritative(parameterId, patch, { coalesceKey = null } = {}) {
    if (this.mode !== 'worker-drag' || !this.workerClient || this.restartPromise) {
      return this.updateParameter(parameterId, patch);
    }
    return this.performAuthoritativeParameterUpdate(parameterId, patch, { coalesceKey });
  }

  async performAuthoritativeParameterUpdate(parameterId, patch, { coalesceKey = null } = {}) {
    const revision = this.recordWorkerCommand(
      'update-parameter',
      { parameterId, patch },
      { coalesceKey },
    );
    try {
      const result = await this.workerClient.updateParameter(parameterId, patch, { coalesceKey });
      if (!this.acceptWorkerResult(result, revision, { checkpoint: false })) {
        return { entry: this.controller.dimensions.get(parameterId), result, snapshot: null };
      }
      const outcome = this.controller.applyAuthoritativeState({
        entities: result.changedEntities,
        parameters: result.changedParameters,
      }, result);
      if (this.mutationJournal.shouldCheckpoint(this.mutationRevision)) {
        this.mutationJournal.installCheckpoint(this.mutationRevision, this.controller.getSketchSnapshot());
      }
      return {
        entry: this.controller.dimensions.get(parameterId),
        result: outcome.result,
        snapshot: outcome.snapshot,
      };
    } catch (error) {
      await this.restartWorker(error);
      return this.controller.updateParameter(parameterId, patch);
    }
  }

  setDimensionEnabledStates(states) {
    const result = this.controller.setDimensionEnabledStates(states);
    const serializedStates = [...states];
    const revision = this.recordWorkerCommand('set-dimension-enabled-states', { states: serializedStates });
    this.enqueueWorker(() => this.workerClient.setDimensionEnabledStates(states), (workerResult) => this.compareDelta(workerResult, result), revision);
    return result;
  }

  beginDrag(variableIds) {
    this.dragVariableIds = new Set(variableIds);
    return this.controller.beginDrag(variableIds);
  }

  updateEntities(entities, options = {}) {
    const result = this.controller.updateEntities(entities, options);
    const lockedVariableIds = [...new Set([...this.dragVariableIds, ...(options.lockedVariableIds || [])])];
    const previewConstraintTolerance = options.previewConstraintTolerance;
    const interactive = this.dragVariableIds.size > 0;
    const commandType = interactive ? 'drag-update' : 'update-entities';
    const payload = {
      entities,
      lockedVariableIds,
      ...(interactive && previewConstraintTolerance !== undefined ? { previewConstraintTolerance } : {}),
    };
    const revision = this.recordWorkerCommand(commandType, payload, { coalesceKey: interactive ? 'drag-update' : null });
    const send = interactive
      ? () => this.workerClient.dragUpdate(entities, { lockedVariableIds, previewConstraintTolerance })
      : () => this.workerClient.updateEntities(entities, { lockedVariableIds });
    this.enqueueWorker(send, (workerResult) => this.compareDelta(workerResult, result), revision);
    return result;
  }

  updateEntitiesInteractive(entities, options = {}) {
    if (this.mode !== 'worker-drag' || !this.workerClient || this.restartPromise) {
      return this.updateEntities(entities, options);
    }
    return this.performAuthoritativeDragUpdate(entities, options);
  }

  async performAuthoritativeDragUpdate(entities, options = {}) {
    const lockedVariableIds = [...new Set([...this.dragVariableIds, ...(options.lockedVariableIds || [])])];
    const previewConstraintTolerance = options.previewConstraintTolerance;
    const revision = this.recordWorkerCommand(
      'drag-update',
      {
        entities,
        lockedVariableIds,
        ...(previewConstraintTolerance === undefined ? {} : { previewConstraintTolerance }),
      },
      { coalesceKey: 'drag-update' },
    );
    try {
      const result = await this.workerClient.dragUpdate(entities, { lockedVariableIds, previewConstraintTolerance });
      if (!this.acceptWorkerResult(result, revision, { checkpoint: false })) {
        return { result, snapshot: null };
      }
      const previewEntities = previewEntitiesForReplica(
        this.controller,
        result.changedEntities,
        entities.map((entity) => entity.id),
        options.previewHysteresis,
      );
      return this.controller.applyAuthoritativeEntities(previewEntities, result);
    } catch (error) {
      await this.restartWorker(error);
      return this.controller.updateEntities(entities, options);
    }
  }

  endDrag() {
    const seedVariableIds = [...this.dragVariableIds];
    this.dragVariableIds.clear();
    const result = this.controller.endDrag();
    const revision = this.recordWorkerCommand('solve', { options: { seedVariableIds } });
    this.enqueueWorker(() => this.workerClient.solve({ seedVariableIds }), (workerResult) => this.compareDelta(workerResult, result), revision);
    return result;
  }

  endDragInteractive() {
    if (this.mode !== 'worker-drag' || !this.workerClient || this.restartPromise) {
      const result = this.endDrag();
      return { result, snapshot: this.controller.getGeometrySnapshot() };
    }
    return this.performAuthoritativeEndDrag();
  }

  async performAuthoritativeEndDrag() {
    const seedVariableIds = [...this.dragVariableIds];
    const revision = this.recordWorkerCommand('solve', { options: { seedVariableIds } });
    try {
      const result = await this.workerClient.solve({ seedVariableIds });
      if (!this.acceptWorkerResult(result, revision, { checkpoint: false })) {
        return { result, snapshot: null };
      }
      this.dragVariableIds.clear();
      this.controller.releaseDragLocks();
      const outcome = this.controller.applyAuthoritativeEntities(result.changedEntities, result);
      if (this.mutationJournal.shouldCheckpoint(this.mutationRevision)) {
        this.mutationJournal.installCheckpoint(this.mutationRevision, this.controller.getSketchSnapshot());
      }
      return outcome;
    } catch (error) {
      await this.restartWorker(error);
      this.dragVariableIds.clear();
      return {
        result: this.controller.endDrag(),
        snapshot: this.controller.getGeometrySnapshot(),
      };
    }
  }

  invokeController(method, args) {
    const result = this.controller[method](...args);
    if (resyncMethods.has(method)) {
      this.resyncWorker();
    }
    return result;
  }

  terminate() {
    this.terminateRequested = true;
    this.workerClient?.terminate();
    this.workerClient = null;
    this.workerState = 'disabled';
    this.emitExecutionStatus();
  }
}

function proxiedFacade(facade) {
  return new Proxy(facade, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) {
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      const value = target.controller[property];
      if (typeof value !== 'function') return value;
      if (!target.forwardedMethods.has(property)) {
        target.forwardedMethods.set(property, (...args) => target.invokeController(property, args));
      }
      return target.forwardedMethods.get(property);
    },
    set(target, property, value, receiver) {
      if (Reflect.has(target, property)) return Reflect.set(target, property, value, receiver);
      target.controller[property] = value;
      return true;
    },
  });
}

export function solverWorkerModeFromEnvironment(environment = globalThis) {
  if (environment.PARAMAGIC_SOLVER_WORKER_MODE === 'sync') return 'sync';
  if (environment.PARAMAGIC_SOLVER_WORKER_MODE === 'worker-drag') return 'worker-drag';
  if (environment.PARAMAGIC_SOLVER_WORKER_MODE === 'shadow') return 'shadow';
  try {
    const requestedMode = new URLSearchParams(environment.location?.search || '').get('solverWorker');
    if (requestedMode === 'sync') return 'sync';
    if (requestedMode === 'drag') return 'worker-drag';
    return requestedMode === 'shadow' ? 'shadow' : 'worker-drag';
  } catch {
    return 'worker-drag';
  }
}

export function solverJacobianModeFromEnvironment(environment = globalThis) {
  if (environment.PARAMAGIC_SOLVER_JACOBIAN_MODE === 'dense') return 'dense';
  if (environment.PARAMAGIC_SOLVER_JACOBIAN_MODE === 'blocks') return 'blocks';
  try {
    return new URLSearchParams(environment.location?.search || '').get('solverJacobian') === 'dense'
      ? 'dense'
      : 'blocks';
  } catch {
    return 'blocks';
  }
}

export function createSolverExecutionFacade({
  controller = null,
  workerClient = null,
  workerFactory = createBrowserSolverWorkerClient,
  maxRestartAttempts = 2,
  checkpointInterval = 50,
  mode = 'sync',
  jacobianMode = 'dense',
} = {}) {
  const resolvedJacobianMode = jacobianMode === 'blocks' ? 'blocks' : 'dense';
  const resolvedController = controller || createSolverController({ jacobianMode: resolvedJacobianMode });
  const configuredWorkerFactory = () => workerFactory({ jacobianMode: resolvedJacobianMode });
  let client = workerClient;
  let resolvedMode = mode;
  if (resolvedMode !== 'sync' && !client) {
    try {
      client = configuredWorkerFactory();
    } catch {
      resolvedMode = 'sync';
    }
  }
  return proxiedFacade(new SolverExecutionFacade({
    controller: resolvedController,
    workerClient: client,
    workerFactory: configuredWorkerFactory,
    maxRestartAttempts,
    checkpointInterval,
    mode: resolvedMode,
    jacobianMode: resolvedJacobianMode,
  }));
}
