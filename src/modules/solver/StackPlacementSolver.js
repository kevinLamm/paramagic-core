import { Variable } from './SolverModel.js';
import { solveLevenbergMarquardt, isSuccessfulSolve } from './NumericSolverCore.js';
import { GLOBAL_LAYER_ID, stackFrameFor } from '../StackCoordinates.js';
import { isStackFrameRelationship } from '../StackRelationshipSystem.js';
import { transitiveParticipantStackIds } from './StackSolveSystem.js';

function relationshipStackIds(constraint) {
  return [...new Set([
    ...(constraint.participantStackIds || []),
    constraint.referenceStackId,
    constraint.movingStackId,
  ].filter(Boolean).map(String))];
}

function placementComponents(constraints) {
  const adjacency = new Map();
  const constraintsByStack = new Map();
  for (const constraint of constraints) {
    const ids = relationshipStackIds(constraint);
    for (const id of ids) {
      if (!adjacency.has(id)) adjacency.set(id, new Set());
      if (!constraintsByStack.has(id)) constraintsByStack.set(id, []);
      constraintsByStack.get(id).push(constraint);
    }
    for (const id of ids) {
      for (const other of ids) {
        if (id !== other) adjacency.get(id).add(other);
      }
    }
  }

  const components = [];
  const visited = new Set();
  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue;
    const stackIds = [];
    const pending = [start];
    const componentConstraints = new Map();
    while (pending.length) {
      const id = pending.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      stackIds.push(id);
      for (const constraint of constraintsByStack.get(id) || []) {
        componentConstraints.set(constraint.id, constraint);
      }
      for (const relatedId of adjacency.get(id) || []) {
        if (!visited.has(relatedId)) pending.push(relatedId);
      }
    }
    components.push({ stackIds, constraints: [...componentConstraints.values()] });
  }
  return components;
}

function seededPlacementConstraints(component, options) {
  const constraintIds = new Set((options.seedConstraintIds || []).map(String));
  const dimensionIds = new Set((options.seedDimensionIds || []).map(String));
  return component.constraints.filter((constraint) => (
    constraintIds.has(String(constraint.id))
    || (constraint.dimensionRef && dimensionIds.has(String(constraint.dimensionRef)))
  ));
}

function lockedStackIdsForComponent(component, options) {
  const componentIds = new Set(component.stackIds);
  const explicit = new Set((options.lockedStackIds || []).map(String));
  const locked = new Set([...explicit].filter((id) => componentIds.has(id)));
  if (componentIds.has(GLOBAL_LAYER_ID)) locked.add(GLOBAL_LAYER_ID);
  if (locked.size) return locked;

  for (const constraint of seededPlacementConstraints(component, options)) {
    if (componentIds.has(constraint.referenceStackId)) locked.add(constraint.referenceStackId);
  }
  if (locked.size) return locked;

  const firstReference = component.constraints
    .map(({ referenceStackId }) => referenceStackId)
    .find((id) => componentIds.has(id));
  locked.add(firstReference || component.stackIds[0]);
  return locked;
}

function stackVariables(stackId, frame) {
  return ['x', 'y', 'rotation'].map((key) => new Variable({
    value: frame[key],
    ownerId: stackId,
    parameterKey: key,
  }));
}

function activePlacementConstraints(controller) {
  return controller.constraints().filter((constraint) => (
    constraint.coordinateSpace === 'global'
    && relationshipStackIds(constraint).length > 1
    && constraint.enabled !== false
    && controller.relationshipIsEnabled(constraint)
  ));
}

export function translateStackPlacementComponent(controller, stackId, dx, dy) {
  const stackIds = [...transitiveParticipantStackIds(
    controller.stackParticipationGraph(),
    [String(stackId)],
  )];
  for (const relatedStackId of stackIds) {
    const stack = controller.stackState.stacks.find(({ id }) => id === relatedStackId);
    if (!stack?.frame) continue;
    const frame = stackFrameFor(controller.stackState, relatedStackId);
    stack.frame = { ...frame, x: frame.x + dx, y: frame.y + dy };
  }
  return stackIds;
}

// Every cross-Stack relationship component is one global placement system.
// A temporary frame gauge keeps one requested/reference Stack still while all
// other frames in the component remain available to satisfy its relationships.
export function solveStackPlacements(controller, options = {}) {
  const constraints = activePlacementConstraints(controller);
  for (const constraint of constraints) {
    if (isStackFrameRelationship(constraint) && (!constraint.movingStackId || !constraint.referenceStackId)) {
      return { status: 'invalid', message: 'Global relationships require a reference Stack and a moving Stack.', changedEntityIds: [] };
    }
  }

  const explicitLocks = new Set((options.lockedStackIds || []).map(String));
  const components = placementComponents(constraints).filter((component) => (
    !explicitLocks.size || component.stackIds.some((id) => explicitLocks.has(id))
  ));
  if (!components.length) {
    return { status: 'unchanged', changedStackIds: [], changedEntityIds: [], finalError: 0, iterations: 0 };
  }

  const before = controller.stackState.stacks.map((stack) => [stack, structuredClone(stack.frame)]);
  const changedStackIds = new Set();
  let result = { status: 'unchanged', changedEntityIds: [], finalError: 0, iterations: 0 };

  for (const component of components) {
    const lockedStackIds = lockedStackIdsForComponent(component, options);
    const variablesByStack = new Map(component.stackIds
      .filter((stackId) => stackId !== GLOBAL_LAYER_ID && !lockedStackIds.has(stackId))
      .map((stackId) => [stackId, stackVariables(stackId, stackFrameFor(controller.stackState, stackId))]));
    const variables = [...variablesByStack.values()].flat();
    const model = Object.create(controller.model);
    model.constraints = new Map(component.constraints.map((constraint) => [constraint.id, constraint]));
    model.stackFrame = (id) => {
      const stackVariablesForId = variablesByStack.get(id);
      return stackVariablesForId
        ? Object.fromEntries(stackVariablesForId.map((variable) => [variable.parameterKey, variable.value]))
        : stackFrameFor(controller.stackState, id);
    };
    model.allVariables = () => variables;
    model.activeVariables = () => variables;
    model.intrinsicResiduals = () => [];
    result = solveLevenbergMarquardt({
      ...options,
      tolerance: options.tolerance ?? 1e-8,
      model,
      registry: controller.registry,
      dimensions: controller.dimensions,
      jacobianMode: 'dense',
    });
    if (!isSuccessfulSolve(result)) {
      before.forEach(([stack, original]) => { if (original) stack.frame = original; });
      return {
        ...result,
        changedStackIds: [],
        changedEntityIds: [],
        message: result.message || 'The related Stack placements cannot satisfy their Global relationships.',
      };
    }

    for (const [stackId, stackVariablesForId] of variablesByStack) {
      const frame = stackFrameFor(controller.stackState, stackId);
      if (!stackVariablesForId.some((variable) => Math.abs(variable.value - frame[variable.parameterKey]) > 1e-10)) continue;
      const stack = controller.stackState.stacks.find(({ id }) => id === stackId);
      stack.frame = Object.fromEntries(stackVariablesForId.map((variable) => [variable.parameterKey, variable.value]));
      changedStackIds.add(stackId);
    }
  }

  const changedEntityIds = [...changedStackIds]
    .flatMap((stackId) => [...(controller.entityIdsByStack.get(stackId) || [])]);
  return {
    ...result,
    status: changedStackIds.size ? 'converged' : 'unchanged',
    changedStackIds: [...changedStackIds],
    changedEntityIds: [...new Set(changedEntityIds)],
    solveScope: {
      mode: 'stack-placement-components',
      stackIds: [...new Set(components.flatMap(({ stackIds }) => stackIds))],
    },
  };
}
