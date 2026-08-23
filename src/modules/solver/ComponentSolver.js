import {
  DEFAULT_MATRIX_FREE_VARIABLE_THRESHOLD,
  INTERACTIVE_MATRIX_FREE_VARIABLE_THRESHOLD,
  isSuccessfulSolve,
  solveLevenbergMarquardt,
} from './NumericSolverCore.js';
import { isCanvasOriginReference } from '../CanvasOrigin.js';

const now = () => globalThis.performance?.now?.() ?? Date.now();

function restoreEntities(model, entities) {
  entities.forEach((entity) => model.updateEntity(entity));
}

function addTiming(timings, result) {
  for (const key of ['residualMs', 'jacobianMs', 'linearSolveMs']) {
    timings[key] += Number(result?.timings?.[key]) || 0;
  }
}

function aggregateJacobianStats(results, requestedMode) {
  const stats = {
    requestedMode: requestedMode === 'blocks' ? 'blocks' : 'dense',
    mode: 'not-required',
    totalBlocks: 0,
    analyticalBlocks: 0,
    fallbackBlocks: 0,
    residualRows: 0,
  };
  const modes = new Set();
  const fallbackReasons = new Set();
  let matrixFreeComponentCount = 0;
  let derivativeEntries = 0;
  let linearIterations = 0;
  let linearConverged = true;
  results.forEach((result) => {
    const componentStats = result?.jacobianStats;
    if (!componentStats) return;
    if (componentStats.mode && componentStats.mode !== 'not-required') modes.add(componentStats.mode);
    if (componentStats.fallbackReason) fallbackReasons.add(componentStats.fallbackReason);
    stats.totalBlocks += Number(componentStats.totalBlocks) || 0;
    stats.analyticalBlocks += Number(componentStats.analyticalBlocks) || 0;
    stats.fallbackBlocks += Number(componentStats.fallbackBlocks) || 0;
    stats.residualRows += Number(componentStats.residualRows) || 0;
    if (componentStats.mode === 'matrix-free') {
      matrixFreeComponentCount += 1;
      derivativeEntries += Number(componentStats.derivativeEntries) || 0;
      linearIterations += Number(componentStats.linearIterations) || 0;
      linearConverged = linearConverged && componentStats.linearConverged !== false;
    }
  });
  if (modes.size === 1) stats.mode = [...modes][0];
  else if (modes.size > 1) stats.mode = 'mixed';
  if (fallbackReasons.size === 1) stats.fallbackReason = [...fallbackReasons][0];
  else if (fallbackReasons.size > 1) stats.fallbackReason = [...fallbackReasons].sort().join(', ');
  if (matrixFreeComponentCount) {
    stats.matrixFreeComponentCount = matrixFreeComponentCount;
    stats.derivativeEntries = derivativeEntries;
    stats.linearIterations = linearIterations;
    stats.linearConverged = linearConverged;
  }
  return stats;
}

function solvableComponents(graph) {
  return [...graph.components.values()].filter((component) => (
    component.constraintIds.size > 0 || component.intrinsicEntityIds.size > 0
  ));
}

function componentScope(component) {
  return {
    ...component,
    componentIds: new Set([component.id]),
  };
}

function referencesCanvasOrigin(value) {
  if (!value || typeof value !== 'object') return false;
  if (isCanvasOriginReference(value)) return true;
  if (Array.isArray(value)) return value.some(referencesCanvasOrigin);
  return Object.values(value).some(referencesCanvasOrigin);
}

function variablesInEntityCreationOrder(model, variables) {
  const included = new Set(variables);
  const ordered = [];
  model.entities?.forEach?.((binding) => {
    binding?.allVariables?.().forEach((variable) => {
      if (!included.delete(variable)) return;
      ordered.push(variable);
    });
  });
  variables.forEach((variable) => {
    if (included.delete(variable)) ordered.push(variable);
  });
  return ordered;
}

function translationGaugeVariables(model) {
  const variables = model.allVariables();
  if (variables.length < 2 || variables.some((variable) => variable.fixed || variable.locked)) return [];
  if ([...model.constraints.values()].some((constraint) => (
    constraint.enabled !== false
    && (constraint.type === 'Fixed' || referencesCanvasOrigin(constraint))
  ))) return [];

  const byId = new Map(variables.map((variable) => [variable.id, variable]));
  for (const variable of variablesInEntityCreationOrder(model, variables)) {
    if (!variable.active || !variable.id.endsWith('.x')) continue;
    const paired = byId.get(`${variable.id.slice(0, -2)}.y`);
    if (paired?.active && paired.owner === variable.owner) return [variable, paired];
  }
  return [];
}

function usesMatrixFreeSolver(model, {
  jacobianMode,
  solveMode,
  matrixFreeVariableThreshold,
} = {}, temporarilyLockedVariableCount = 0) {
  if (jacobianMode !== 'blocks') return false;
  const automaticThreshold = solveMode === 'interactive'
    ? INTERACTIVE_MATRIX_FREE_VARIABLE_THRESHOLD
    : DEFAULT_MATRIX_FREE_VARIABLE_THRESHOLD;
  const threshold = matrixFreeVariableThreshold === undefined || matrixFreeVariableThreshold === null
    ? automaticThreshold
    : Math.max(0, Number(matrixFreeVariableThreshold) || 0);
  return model.activeVariables().length - temporarilyLockedVariableCount >= threshold;
}

export function solveConstraintScope({ model, ...options } = {}) {
  const gaugeCandidate = translationGaugeVariables(model);
  const gaugeVariables = usesMatrixFreeSolver(model, options, gaugeCandidate.length)
    ? gaugeCandidate
    : [];
  const previousLocks = gaugeVariables.map((variable) => [variable, variable.locked]);
  gaugeVariables.forEach((variable) => { variable.locked = true; });
  try {
    const result = solveLevenbergMarquardt({ ...options, model });
    return gaugeVariables.length
      ? { ...result, translationGaugeVariableIds: gaugeVariables.map((variable) => variable.id) }
      : result;
  } finally {
    previousLocks.forEach(([variable, locked]) => { variable.locked = locked; });
  }
}

export function solveConstraintComponents({
  model,
  graph,
  registry,
  dimensions,
  maxIterations,
  tolerance,
  solveMode = 'final',
  timeBudgetMs = Infinity,
  shouldCancel,
  jacobianMode = 'dense',
  matrixFreeVariableThreshold,
} = {}) {
  if (!model || !graph || !registry) throw new TypeError('Component solving requires a model, graph, and registry.');
  const startedAt = now();
  const components = solvableComponents(graph);
  const entityIds = new Set(components.flatMap((component) => [...component.entityIds]));
  const beforeEntities = [...entityIds].map((id) => model.entity(id)).filter(Boolean);
  const componentResults = [];
  const changedEntityIds = new Set();
  const problematicConstraintIds = new Set();
  const timings = { residualMs: 0, jacobianMs: 0, linearSolveMs: 0, totalMs: 0 };
  let initialError = 0;
  let finalError = 0;
  let iterations = 0;
  let acceptedSteps = 0;
  let rejectedSteps = 0;
  let failedResult = null;

  const evaluateParameters = dimensions?.evaluateDirty?.bind(dimensions)
    || dimensions?.evaluateAll?.bind(dimensions);
  evaluateParameters?.({ strict: false, refreshComputed: true });

  for (const component of components) {
    const elapsedMs = now() - startedAt;
    const remainingTimeBudget = Number.isFinite(Number(timeBudgetMs))
      ? Math.max(0, Number(timeBudgetMs) - elapsedMs)
      : Infinity;
    const result = solveConstraintScope({
      model: graph.scopedModel(componentScope(component)),
      registry,
      dimensions,
      solveMode,
      timeBudgetMs: remainingTimeBudget,
      evaluateParameterTargets: false,
      ...(maxIterations === undefined ? {} : { maxIterations }),
      ...(tolerance === undefined ? {} : { tolerance }),
      ...(shouldCancel === undefined ? {} : { shouldCancel }),
      ...(jacobianMode === undefined ? {} : { jacobianMode }),
      ...(matrixFreeVariableThreshold === undefined ? {} : { matrixFreeVariableThreshold }),
    });
    componentResults.push(result);
    addTiming(timings, result);
    initialError += Number(result.initialError) || 0;
    finalError += Number(result.finalError) || 0;
    iterations += Number(result.iterations) || 0;
    acceptedSteps += Number(result.acceptedSteps) || 0;
    rejectedSteps += Number(result.rejectedSteps) || 0;
    (result.changedEntityIds || []).forEach((id) => changedEntityIds.add(id));
    (result.problematicConstraintIds || []).forEach((id) => problematicConstraintIds.add(id));
    if (!isSuccessfulSolve(result)) {
      failedResult = result;
      break;
    }
  }

  timings.totalMs = now() - startedAt;
  const jacobianStats = aggregateJacobianStats(componentResults, jacobianMode);
  const common = {
    solveMode: solveMode === 'interactive' ? 'interactive' : 'final',
    iterations,
    initialError,
    finalError,
    acceptedSteps,
    rejectedSteps,
    timings,
    jacobianStats,
    componentStats: {
      componentCount: graph.components.size,
      solvedComponentCount: componentResults.length,
      constrainedComponentCount: components.length,
      largestVariableCount: components.reduce((largest, component) => Math.max(largest, component.variableIds.size), 0),
      largestConstraintCount: components.reduce((largest, component) => Math.max(largest, component.constraintIds.size), 0),
    },
  };

  if (failedResult) {
    restoreEntities(model, beforeEntities);
    return {
      ...failedResult,
      ...common,
      finalError: initialError,
      changedEntityIds: [],
      problematicConstraintIds: [...problematicConstraintIds],
      message: failedResult.message || 'A constraint component could not be solved; the drawing was restored.',
    };
  }

  const converged = componentResults.some((result) => result.status === 'converged');
  return {
    ...common,
    status: converged ? 'converged' : 'unchanged',
    changedEntityIds: [...changedEntityIds],
    problematicConstraintIds: [],
    message: converged ? 'Constraint components converged.' : 'Constraints already satisfied.',
  };
}
