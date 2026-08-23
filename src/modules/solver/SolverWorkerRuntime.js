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
  } = {}) {
    this.jacobianMode = jacobianMode === 'blocks' ? 'blocks' : 'dense';
    this.controller = controller || createSolverController({ jacobianMode: this.jacobianMode });
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
      default:
        throw new TypeError(`Unsupported solver worker command: ${type}.`);
    }
  }

  handleRequest(message) {
    let request;
    try {
      request = validateSolverWorkerRequest(message);
    } catch (error) {
      const fallback = {
        requestId: Number.isInteger(message?.requestId) ? message.requestId : 0,
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
      const outcome = this.dispatch(request.type, request.payload);
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
        message: result.message,
        changedEntities,
        changedDimensions: [],
        changedParameters,
        changedConstraints,
        removedConstraintIds,
        snapshot: request.type === 'get-snapshot' ? outcome?.snapshot : undefined,
        diagnostics: {
          durationMs: now() - startedAt,
          solveScope: result.solveScope || null,
          iterations: Number(result.iterations) || 0,
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
