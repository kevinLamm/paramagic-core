import { Variable } from './SolverModel.js';
import { isSuccessfulSolve } from './NumericSolverCore.js';
import { GLOBAL_LAYER_ID, stackFrameFor } from '../StackCoordinates.js';
import { isStackFrameRelationship } from '../StackRelationshipSystem.js';
import { runSolverWork } from './SolverWork.js';
import { isSwellEntity } from '../SwellGeometry.js';

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
    id: `stack-frame:${stackId}:${key}`,
    value: frame[key],
    ownerId: stackId,
    parameterKey: key,
  }));
}

function placementGeometry(controller, constraints) {
  const selected = new Set(), visited = new Set(); let swell = false;
  const visit = value => {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    const id = value.recordId || value.entityId;
    if (id && !selected.has(id)) { selected.add(id); visit(controller.model.derivedEntity(id)); }
    if (value.derivedFeature) swell = true;
    Object.values(value).forEach(visit);
  };
  constraints.forEach(visit);
  if (swell) for (const b of controller.model.entities.values()) if (isSwellEntity(b)) selected.add(b.id);
  return new Map([...selected].map(id => [id, controller.model.binding(id)]).filter(([, b]) => b));
}

function activePlacementConstraints(controller) {
  return controller.constraints().filter((constraint) => (
    constraint.coordinateSpace === 'global'
    && relationshipStackIds(constraint).length > 1
    && constraint.enabled !== false
    && controller.relationshipIsEnabled(constraint)
  ));
}

// Every cross-Stack relationship component is one global placement system.
// A temporary frame gauge keeps one requested/reference Stack still while all
// other frames in the component remain available to satisfy its relationships.
export function solveStackPlacements(controller, options = {}) { return runSolverWork(solveStackPlacementsWork(controller, options)); }

export function* solveStackPlacementsWork(controller, options = {}) {
  const constraints = activePlacementConstraints(controller);
  for (const constraint of constraints) {
    if (isStackFrameRelationship(constraint) && (!constraint.movingStackId || !constraint.referenceStackId)) {
      return { status: 'invalid', message: 'Global relationships require a reference Stack and a moving Stack.', changedEntityIds: [] };
    }
  }

  const explicitLocks = new Set((options.lockedStackIds || []).map(String));
  const components = placementComponents(constraints).filter((component) => (
    options.projectStackId ? component.stackIds.includes(options.projectStackId)
      : !explicitLocks.size || component.stackIds.some((id) => explicitLocks.has(id))
  ));
  if (!components.length) {
    return { status: 'unchanged', changedStackIds: [], changedEntityIds: [], finalError: 0, iterations: 0 };
  }

  const before = controller.stackState.stacks.map((stack) => [stack, structuredClone(stack.frame)]);
  const changedStackIds = new Set();
  let result = { status: 'unchanged', changedEntityIds: [], finalError: 0, iterations: 0 };

  for (const component of components) {
    const lockedStackIds = lockedStackIdsForComponent(component, options);
    controller.placementWorlds ||= new Map();
    const key = component.stackIds.join('|');
    let resident = controller.placementWorlds.get(key);
    if (!resident) {
      resident = { frames: new Map(component.stackIds.map(id => [id, stackVariables(id, stackFrameFor(controller.stackState, id))])), geometry: new Map(), model: Object.create(controller.model) };
      controller.placementWorlds.set(key, resident);
      if (controller.placementWorlds.size > 8) controller.placementWorlds.delete(controller.placementWorlds.keys().next().value);
    }
    const variablesByStack = resident.frames;
    for (const [id, variables] of variablesByStack) {
      const frame = stackFrameFor(controller.stackState, id);
      variables.forEach(v => { v.value = frame[v.parameterKey]; });
    }
    for (const [id, variables] of variablesByStack) variables.forEach(v => { v.locked = id === GLOBAL_LAYER_ID || lockedStackIds.has(id); });
    const frameVariables = [...variablesByStack.values()].flat();
    // Geometry is constant in the frame solve. These read-only variable views
    // retain its packed coordinates without changing document fixed/lock flags.
    const bindings = controller.numericBackend ? placementGeometry(controller, component.constraints) : controller.model.entities;
    const geometry = controller.numericBackend ? [...bindings.values()].flatMap(b => b.allVariables()).map(v => {
      let constant = resident.geometry.get(v.id);
      if (!constant) { constant = { id: v.id, ownerId: v.ownerId, parameterKey: v.parameterKey, active: false }; resident.geometry.set(v.id, constant); }
      constant.value = v.value; return constant;
    }) : [];
    if (resident.geometry.size !== geometry.length) resident.geometry = new Map(geometry.map(v => [v.id, v]));
    const variables = [...frameVariables, ...geometry];
    const model = resident.model;
    model.entities = bindings;
    model.source = controller.model;
    model.nativeSessionKey = `placement:${component.stackIds.join('|')}`;
    model.placementVariables = variablesByStack;
    model.placementVariableIds = constraint => {
      const stacks = new Set(relationshipStackIds(constraint));
      const visit = value => {
        if (!value || typeof value !== 'object') return;
        if (value.recordId || value.entityId) stacks.add(value.stackId || model.binding(value.recordId || value.entityId)?.stackId);
        if (value.derivedFeature) for (const b of model.entities.values()) if (isSwellEntity(b)) stacks.add(b.stackId);
        Object.values(value).forEach(visit);
      };
      visit(constraint);
      return [...stacks].flatMap(id => (variablesByStack.get(id) || []).map(v => v.id));
    };
    model.constraints = new Map(component.constraints.map((constraint) => [constraint.id, constraint]));
    model.stackFrame = (id) => {
      const stackVariablesForId = variablesByStack.get(id);
      return stackVariablesForId
        ? Object.fromEntries(stackVariablesForId.map((variable) => [variable.parameterKey, variable.value]))
        : stackFrameFor(controller.stackState, id);
    };
    model.allVariables = () => variables;
    model.activeVariables = () => frameVariables.filter(v => v.active);
    model.intrinsicResiduals = () => [];
    try {
      const solveOptions = {
        ...options,
        numericBackend: controller.numericBackend,
        tolerance: options.tolerance ?? 1e-8,
        model,
        registry: controller.registry,
        dimensions: controller.dimensions,
        jacobianMode: 'dense',
      };
      // Distance edits should preserve the accepted frame directions when
      // translation can satisfy the equations. These are temporary solve
      // locks, never drawing constraints; release them when rotation is needed.
      const distanceEdit = seededPlacementConstraints(component, options).some(constraint => (
        constraint.source === 'dimension'
        && ['Distance', 'Horizontal Distance', 'Vertical Distance', 'Point Line Distance', 'Line Line Distance'].includes(constraint.type)
      ));
      const rotations = distanceEdit || options.projectStackId
        ? frameVariables.filter(v => v.parameterKey === 'rotation' && !v.locked) : [];
      if (rotations.length) {
        const values = frameVariables.map(v => v.value);
        rotations.forEach(v => { v.locked = true; });
        result = yield solveOptions;
        rotations.forEach(v => { v.locked = false; });
        if (!isSuccessfulSolve(result) && result.status !== 'cancelled') {
          const translationResult = result;
          frameVariables.forEach((v, i) => { v.value = values[i]; });
          result = yield solveOptions;
          result = { ...result, translationIterations: translationResult.iterations || 0 };
        }
      } else result = yield solveOptions;
    } finally { frameVariables.forEach(v => { v.locked = false; }); }
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
      if (lockedStackIds.has(stackId) || stackId === GLOBAL_LAYER_ID) continue;
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
