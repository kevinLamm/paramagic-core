export const SOLVER_WORKER_PROTOCOL_VERSION = 1;

export const solverWorkerCommandTypes = new Set([
  'load-sketch',
  'get-snapshot',
  'solve',
  'add-entity',
  'remove-entity',
  'update-entities',
  'drag-update',
  'add-constraint',
  'remove-constraint',
  'set-dimension',
  'update-parameter',
  'set-dimension-enabled-states',
]);

export const interactiveSolverWorkerCommandTypes = new Set(['drag-update']);

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;
const isId = (value) => typeof value === 'string' && value.length > 0;

function validatePayload(type, payload) {
  if (type === 'load-sketch' && !isRecord(payload.snapshot)) throw new TypeError('load-sketch requires a snapshot object.');
  if (type === 'solve' && payload.options !== undefined && !isRecord(payload.options)) throw new TypeError('solve options must be an object.');
  if (type === 'add-entity' && !isRecord(payload.entity)) throw new TypeError('add-entity requires an entity object.');
  if (type === 'remove-entity' && !isId(payload.entityId)) throw new TypeError('remove-entity requires an entityId.');
  if (type === 'update-entities' || type === 'drag-update') {
    if (!Array.isArray(payload.entities)) throw new TypeError(`${type} requires an entities array.`);
    if (payload.lockedVariableIds !== undefined && !Array.isArray(payload.lockedVariableIds)) {
      throw new TypeError(`${type} lockedVariableIds must be an array.`);
    }
    if (payload.previewConstraintTolerance !== undefined
      && (!Number.isFinite(payload.previewConstraintTolerance) || payload.previewConstraintTolerance < 0)) {
      throw new TypeError(`${type} previewConstraintTolerance must be a non-negative finite number.`);
    }
  }
  if (type === 'add-constraint' && !isRecord(payload.constraint)) throw new TypeError('add-constraint requires a constraint object.');
  if (type === 'remove-constraint' && !isId(payload.constraintId)) throw new TypeError('remove-constraint requires a constraintId.');
  if (type === 'set-dimension' && (!isId(payload.dimensionId) || typeof payload.expression !== 'string')) {
    throw new TypeError('set-dimension requires a dimensionId and expression string.');
  }
  if (type === 'update-parameter' && (!isId(payload.parameterId) || !isRecord(payload.patch))) {
    throw new TypeError('update-parameter requires a parameterId and patch object.');
  }
  if (type === 'set-dimension-enabled-states' && !Array.isArray(payload.states)) {
    throw new TypeError('set-dimension-enabled-states requires a states array.');
  }
}

export function validateSolverWorkerRequest(message) {
  if (!isRecord(message)) throw new TypeError('Solver worker request must be an object.');
  if (message.version !== SOLVER_WORKER_PROTOCOL_VERSION) {
    throw new TypeError(`Unsupported solver worker protocol version: ${message.version}.`);
  }
  if (!isNonNegativeInteger(message.requestId)) throw new TypeError('Solver worker requestId must be a non-negative integer.');
  if (!isNonNegativeInteger(message.generation)) throw new TypeError('Solver worker generation must be a non-negative integer.');
  if (!solverWorkerCommandTypes.has(message.type)) throw new TypeError(`Unsupported solver worker command: ${message.type}.`);
  if (!isRecord(message.payload)) throw new TypeError('Solver worker payload must be an object.');
  validatePayload(message.type, message.payload);
  return message;
}

export function createSolverWorkerRequest({ requestId, generation, type, payload = {} }) {
  return validateSolverWorkerRequest({
    version: SOLVER_WORKER_PROTOCOL_VERSION,
    requestId,
    generation,
    type,
    payload,
  });
}

export function createSolverWorkerResult(request, result = {}) {
  return {
    version: SOLVER_WORKER_PROTOCOL_VERSION,
    requestId: request.requestId,
    generation: request.generation,
    type: 'result',
    commandType: request.type,
    status: String(result.status || 'completed'),
    changedEntities: Array.isArray(result.changedEntities) ? result.changedEntities : [],
    changedDimensions: Array.isArray(result.changedDimensions) ? result.changedDimensions : [],
    changedParameters: Array.isArray(result.changedParameters) ? result.changedParameters : [],
    changedConstraints: Array.isArray(result.changedConstraints) ? result.changedConstraints : [],
    removedConstraintIds: Array.isArray(result.removedConstraintIds) ? result.removedConstraintIds : [],
    diagnostics: isRecord(result.diagnostics) ? result.diagnostics : {},
    ...(result.snapshot ? { snapshot: result.snapshot } : {}),
    ...(result.message ? { message: String(result.message) } : {}),
  };
}

export function validateSolverWorkerResult(message) {
  if (!isRecord(message) || message.type !== 'result') throw new TypeError('Solver worker result must be a result object.');
  if (message.version !== SOLVER_WORKER_PROTOCOL_VERSION) throw new TypeError('Unsupported solver worker result version.');
  if (!isNonNegativeInteger(message.requestId) || !isNonNegativeInteger(message.generation)) {
    throw new TypeError('Solver worker result identifiers are invalid.');
  }
  if (typeof message.status !== 'string') throw new TypeError('Solver worker result status is required.');
  if (message.changedParameters !== undefined && !Array.isArray(message.changedParameters)) {
    throw new TypeError('Solver worker changedParameters must be an array.');
  }
  if (message.changedConstraints !== undefined && !Array.isArray(message.changedConstraints)) {
    throw new TypeError('Solver worker changedConstraints must be an array.');
  }
  if (message.removedConstraintIds !== undefined && !Array.isArray(message.removedConstraintIds)) {
    throw new TypeError('Solver worker removedConstraintIds must be an array.');
  }
  return message;
}
