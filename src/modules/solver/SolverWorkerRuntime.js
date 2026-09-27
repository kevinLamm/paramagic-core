import { createSolverController } from './SolverController.js';
import { isSuccessfulSolve } from './NumericSolverCore.js';
import {
  createSolverWorkerResult,
  interactiveSolverWorkerCommandTypes,
  validateSolverWorkerRequest,
} from './SolverWorkerProtocol.js';

const now = () => globalThis.performance?.now?.() ?? Date.now();
export const INTERACTIVE_SOLVE_MAX_ITERATIONS = 24;
export const INTERACTIVE_SOLVE_TIME_BUDGET_MS = 10;

function solveResult(outcome, controller) {
  if (outcome?.result) return outcome.result;
  if (outcome?.status) return outcome;
  return controller.lastResult || { status: 'completed', changedEntityIds: [] };
}

export class SolverWorkerRuntime {
  constructor({
    controller = null,
    interactiveSolveOptions = {},
    jacobianMode = 'dense',
    numericBackend = null,
  } = {}) {
    this.jacobianMode = jacobianMode === 'blocks' ? 'blocks' : 'dense';
    this.controller = controller || createSolverController({ jacobianMode: this.jacobianMode, numericBackend });
    this.latestInteractiveGeneration = -1;
    this.interactiveBaseline = null;
    this.interactiveRequest = null;
    this.interactiveSolveOptions = {
      solveMode: 'interactive',
      maxIterations: INTERACTIVE_SOLVE_MAX_ITERATIONS,
      timeBudgetMs: INTERACTIVE_SOLVE_TIME_BUDGET_MS,
      ...interactiveSolveOptions,
    };
  }

  dispatch(type, payload) {
    switch (type) {
      case 'load-sketch':
        this.interactiveBaseline = null;
        this.interactiveRequest = null;
        return this.controller.loadSketch(payload.snapshot || {});
      case 'apply-geometry':
        return this.controller.applyAuthoritativeEntities(payload.entities, payload.result || {});
      case 'update-model': {
        for (const update of payload.updates) {
          this.controller[update.method](...update.args);
          if (update.parameters?.length) this.controller.dimensions.restoreEntries(update.parameters, { emit: false });
        }
        return { status: 'completed', changedEntityIds: [] };
      }
      case 'get-snapshot':
        return { status: 'completed', snapshot: this.controller.getSketchSnapshot(), changedEntityIds: [] };
      case 'solve':
      {
        let result;
        if (this.interactiveRequest && typeof this.controller.commitDragEntities === 'function') {
          result = this.controller.commitDragEntities(
            this.interactiveRequest.entities,
            this.interactiveRequest.lockedVariableIds,
            payload.options || {},
          );
        } else {
          result = this.controller.solve({ ...(payload.options || {}), solveMode: 'final' });
        }
        if (this.interactiveBaseline) {
          const baselineEntityIds = this.interactiveBaseline.entities.map((entity) => entity.id);
          if (!isSuccessfulSolve(result)) {
            this.controller.restoreGeometryTransaction(this.interactiveBaseline);
            result = {
              ...result,
              restoredInteractiveBaseline: true,
            };
          }
          result.changedEntityIds = [...new Set([...(result.changedEntityIds || []), ...baselineEntityIds])];
          this.interactiveBaseline = null;
        }
        this.interactiveRequest = null;
        return result;
      }
      case 'add-entity':
        return { status: 'completed', entity: this.controller.addEntity(payload.entity), changedEntityIds: [payload.entity?.id].filter(Boolean) };
      case 'remove-entity':
        return { status: this.controller.removeEntity(payload.entityId) ? 'completed' : 'unchanged', changedEntityIds: [] };
      case 'update-entities':
        return this.controller.updateEntities(payload.entities || [], {
          lockedVariableIds: payload.lockedVariableIds || [],
          solveOptions: { solveMode: 'final' },
        });
      case 'drag-update':
        if (!this.interactiveBaseline) {
          this.interactiveBaseline = this.controller.snapshotGeometryForSeeds({
            entityIds: (payload.entities || []).map((entity) => entity.id),
            variableIds: payload.lockedVariableIds || [],
          }, { fallbackToFull: true });
        }
        this.interactiveRequest = {
          entities: structuredClone(payload.entities || []),
          lockedVariableIds: [...(payload.lockedVariableIds || [])],
        };
        return this.controller.updateEntities(payload.entities || [], {
          lockedVariableIds: payload.lockedVariableIds || [],
          solveOptions: this.interactiveSolveOptions,
          previewConstraintTolerance: payload.previewConstraintTolerance,
        });
      case 'add-constraint':
        return this.controller.addConstraint(payload.constraint);
      case 'remove-constraint':
      {
        const removed = this.controller.removeConstraint(payload.constraintId);
        return {
          ...(removed ? this.controller.lastResult : {}),
          status: removed ? this.controller.lastResult?.status || 'unchanged' : 'unchanged',
          removed,
          changedEntityIds: removed ? this.controller.lastResult?.changedEntityIds || [] : [],
        };
      }
      case 'set-dimension':
        return this.controller.setDimension(payload.dimensionId, payload.expression);
      case 'update-parameter':
        return this.controller.updateParameter(payload.parameterId, payload.patch || {});
      case 'set-dimension-enabled-states':
        return this.controller.setDimensionEnabledStates(payload.states || []);
      case 'set-enabled-stack-ids':
      {
        const transition = this.controller.setEnabledStackIds(payload.stackIds);
        return { status: 'completed', changedEntityIds: [], diagnostics: {
          enabledStackIds: [...transition.enabledStackIds],
          enabled: transition.enabled || [],
          disabled: transition.disabled || [],
        } };
      }
      default:
        throw new TypeError(`Unsupported solver worker command: ${type}.`);
    }
  }

  supersede(requestToken) {
    if (this.activeRequest?.requestToken === requestToken) this.activeRequest.superseded = true;
  }

  async dispatchAsync(type, payload, shouldCancel) {
    if (type === 'set-dimension') return this.controller.setDimensionAsync(payload.dimensionId, payload.expression, shouldCancel);
    if (type === 'update-parameter') return this.controller.updateParameterAsync(payload.parameterId, payload.patch || {}, shouldCancel);
    if (type === 'solve' && !this.interactiveRequest) return this.controller.solveAsync({ ...payload.options, solveMode: 'final' }, shouldCancel);
    return this.dispatch(type, payload);
  }

  handleRequest(message) {
    const work = this.requestWork(message);
    try {
      const next = work.next();
      if (next.done) return next.value;
      return work.next(this.dispatch(next.value.type, next.value.payload)).value;
    } catch (error) { return work.throw(error).value; }
    finally { work.return(); }
  }

  async handleRequestAsync(message) {
    if (this.activeRequest) throw new Error('Worker commands must be serialized.');
    const work = this.requestWork(message);
    this.activeRequest = { requestToken: message?.requestToken, superseded: false };
    try {
      const next = work.next();
      if (next.done) return next.value;
      const outcome = await this.dispatchAsync(next.value.type, next.value.payload,
        () => this.activeRequest.superseded ? 'superseded' : false);
      const response = work.next(outcome).value;
      // The controller has restored the cancelled transaction before returning.
      if (response.diagnostics.cancellationReason === 'superseded') {
        response.status = 'superseded';
        response.changedEntities = []; response.changedParameters = []; response.changedConstraints = [];
      }
      return response;
    } catch (error) { return work.throw(error).value; }
    finally { this.activeRequest = null; work.return(); }
  }

  *requestWork(message) {
    let request;
    try {
      request = validateSolverWorkerRequest(message);
    } catch (error) {
      const fallback = {
        requestToken: Number.isInteger(message?.requestToken) ? message.requestToken : 0,
        generation: Number.isInteger(message?.generation) ? message.generation : 0,
        type: String(message?.type || 'invalid'),
      };
      return createSolverWorkerResult(fallback, { status: 'invalid', message: error.message });
    }

    const interactive = interactiveSolverWorkerCommandTypes.has(request.type);
    if (interactive && request.generation < this.latestInteractiveGeneration) {
      return createSolverWorkerResult(request, { status: 'stale', message: 'A newer interactive generation is already pending.' });
    }
    if (interactive) this.latestInteractiveGeneration = request.generation;

    const startedAt = now();
    try {
      const parameterMutationId = request.type === 'set-dimension'
        ? request.payload.dimensionId
        : request.type === 'update-parameter'
          ? request.payload.parameterId
          : null;
      const changedParameterIds = parameterMutationId
        ? this.controller.dimensions.affectedIds(parameterMutationId)
        : new Set();
      const outcome = yield request;
      const result = solveResult(outcome, this.controller);
      if (parameterMutationId) {
        this.controller.dimensions.affectedIds(parameterMutationId).forEach((id) => changedParameterIds.add(id));
        if (outcome?.entry?.id) changedParameterIds.add(outcome.entry.id);
      }
      const changedEntityIds = new Set(result.changedEntityIds || []);
      if (request.type === 'update-entities' || request.type === 'drag-update') {
        request.payload.entities.forEach((entity) => {
          if (entity?.id) changedEntityIds.add(entity.id);
        });
      }
      if (outcome?.entity?.id) changedEntityIds.add(outcome.entity.id);
      const changedEntities = [...changedEntityIds]
        .map((id) => this.controller.getEntity(id))
        .filter(Boolean);
      const changedParameters = [...changedParameterIds]
        .map((id) => this.controller.dimensions.get(id))
        .filter(Boolean);
      const changedConstraints = outcome?.constraint ? [outcome.constraint] : [];
      const removedConstraintIds = request.type === 'remove-constraint' && outcome?.removed
        ? [request.payload.constraintId]
        : [];
      return createSolverWorkerResult(request, {
        status: result.status || 'completed',
        derivedGeometry: this.controller.numericBackend && isSuccessfulSolve(result)
          ? this.controller.numericBackend.derivedGeometry?.(this.controller.model, this.controller.dimensions) : undefined,
        stackState: structuredClone(this.controller.stackState),
        message: result.message,
        changedEntities,
        changedDimensions: [],
        changedParameters,
        changedConstraints,
        removedConstraintIds,
        snapshot: request.type === 'get-snapshot' ? outcome?.snapshot : undefined,
        diagnostics: {
          durationMs: now() - startedAt,
          backend: result.backend || 'javascript',
          placementBackend: result.placementBackend || null,
          placementIterations: result.placementIterations || 0,
          placementMs: result.placementTimings?.totalMs || 0,
          initialError: result.initialError ?? null,
          finalError: result.finalError ?? null,
          solveScope: result.solveScope || null,
          iterations: Number(result.iterations) || 0,
          continuationSteps: Number(result.continuationSteps) || 0,
          continuationIterations: Number(result.continuationIterations) || 0,
          solveMode: result.solveMode || null,
          cancellationReason: result.cancellationReason || null,
          acceptedSteps: Number(result.acceptedSteps) || 0,
          rejectedSteps: Number(result.rejectedSteps) || 0,
          rigidFirstSolveAttempted: Boolean(result.rigidFirstSolveAttempted),
          rigidFirstSolveAccepted: Boolean(result.rigidFirstSolveAccepted),
          rigidFirstSolveFallback: Boolean(result.rigidFirstSolveFallback),
          restoredInteractivePreview: Boolean(result.restoredInteractivePreview),
          restoredInteractiveBaseline: Boolean(result.restoredInteractiveBaseline),
          jacobianStats: result.jacobianStats || null,
        },
      });
    } catch (error) {
      return createSolverWorkerResult(request, {
        status: 'invalid',
        message: error.message,
        diagnostics: { durationMs: now() - startedAt },
      });
    }
  }
}

export function createSolverWorkerRuntime(options) {
  return new SolverWorkerRuntime(options);
}
