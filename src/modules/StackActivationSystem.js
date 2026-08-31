import {
  createStackTreeIndex,
  normalizeStackArchitectureState,
} from './StackArchitecture.js';
import { expressionSymbolReferences } from './solver/ParameterRepository.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

function normalizedRuntimeState(value = null) {
  return {
    localEnabled: value?.localEnabled !== false && !value?.error,
    effectiveEnabled: value?.effectiveEnabled !== false && !value?.error,
    error: value?.error || null,
    awaiting: Boolean(value?.awaiting),
  };
}

function stateEntries(value) {
  if (value instanceof Map) return [...value];
  return Object.entries(value || {});
}

export function effectiveEnabledStackIds(stackStateInput, localStatesInput = new Map()) {
  const index = createStackTreeIndex(stackStateInput);
  const localStates = new Map(stateEntries(localStatesInput));
  const enabled = new Set();
  index.state.stacks.forEach((stack) => {
    const local = normalizedRuntimeState(localStates.get(stack.id)).localEnabled;
    const parentEnabled = !stack.parentStackId || enabled.has(stack.parentStackId);
    if (local && parentEnabled) enabled.add(stack.id);
  });
  return enabled;
}

function activationSignature(enabledStackIds) {
  return [...enabledStackIds].sort().join('|');
}

function dependencyCycles(stackIds, dependencyStackIdsByStack) {
  const visiting = new Set();
  const visited = new Set();
  const path = [];
  const cycles = [];
  const cycleKeys = new Set();
  const visit = (stackId) => {
    if (visiting.has(stackId)) {
      const start = path.indexOf(stackId);
      const cycle = [...path.slice(start), stackId];
      const key = [...new Set(cycle)].sort().join('|');
      if (!cycleKeys.has(key)) {
        cycleKeys.add(key);
        cycles.push(cycle);
      }
      return;
    }
    if (visited.has(stackId)) return;
    visiting.add(stackId);
    path.push(stackId);
    (dependencyStackIdsByStack.get(stackId) || []).forEach(visit);
    path.pop();
    visiting.delete(stackId);
    visited.add(stackId);
  };
  stackIds.forEach(visit);
  return cycles;
}

function cycleDiagnostic(cycle, stackById, compiledByStackId) {
  const parts = cycle.slice(0, -1).map((stackId, index) => {
    const sourceStackId = cycle[index + 1];
    const reference = compiledByStackId.get(stackId)?.references.find((item) => item.stackId === sourceStackId);
    const stackName = stackById.get(stackId)?.name || stackId;
    const sourceName = stackById.get(sourceStackId)?.name || sourceStackId;
    return `"${stackName}" depends on ${reference?.name || 'a dimension'} from "${sourceName}"`;
  });
  return {
    code: 'activation-cycle',
    stackIds: [...new Set(cycle)],
    dimensionIds: [...new Set(cycle.slice(0, -1).flatMap((stackId, index) => compiledByStackId
      .get(stackId)?.references
      .filter((item) => item.stackId === cycle[index + 1])
      .map((item) => item.parameterId) || []))],
    message: `Stack activation cycle: ${parts.join(', and ')}.`,
  };
}

export function createStackActivationSystem({
  getStackState = () => null,
  expressionSymbols = () => [],
  expressionEntries = () => [],
  evaluateExpression = () => true,
} = {}) {
  let stackState = normalizeStackArchitectureState(getStackState());
  let compiledByStackId = new Map();
  let reverseDependents = new Map();
  let dependencyStackIdsByStack = new Map();
  let localStates = new Map();
  let effectiveIds = effectiveEnabledStackIds(stackState, localStates);
  let dirtyStackIds = new Set();
  let diagnostics = [];
  let cycleStackIds = new Set();
  let lastEvaluationCount = 0;
  let acceptedState = null;
  let observedSignatures = new Map();

  function symbolsFor(stackId, source = expressionSymbols) {
    if (typeof source === 'function') return source({ stackId, includeLocalAliases: true }) || [];
    return source || [];
  }

  function entriesFor(stackId) {
    const entries = typeof expressionEntries === 'function'
      ? expressionEntries({ stackId, includeLocalAliases: true }) || []
      : expressionEntries || [];
    return new Map(entries.map((entry) => [entry.id, entry]));
  }

  function compileStackExpressions(stackStateInput = getStackState(), symbolsInput = expressionSymbols) {
    stackState = normalizeStackArchitectureState(stackStateInput);
    const stackById = new Map(stackState.stacks.map((stack) => [stack.id, stack]));
    compiledByStackId = new Map();
    reverseDependents = new Map();
    dependencyStackIdsByStack = new Map();
    diagnostics = [];
    stackState.stacks.forEach((stack) => {
      if (stack.enabled !== false) {
        compiledByStackId.set(stack.id, {
          expression: stack.enabledExpression,
          references: [],
          error: null,
          manualEnabled: true,
        });
        dependencyStackIdsByStack.set(stack.id, new Set());
        localStates.set(stack.id, { localEnabled: true, error: null, awaiting: false });
        return;
      }
      if (!String(stack.enabledExpression || '').trim()) {
        compiledByStackId.set(stack.id, {
          expression: '',
          references: [],
          error: null,
          manualEnabled: false,
        });
        dependencyStackIdsByStack.set(stack.id, new Set());
        localStates.set(stack.id, { localEnabled: false, error: null, awaiting: false });
        return;
      }
      const symbols = symbolsFor(stack.id, symbolsInput);
      const entryById = entriesFor(stack.id);
      try {
        const references = expressionSymbolReferences(stack.enabledExpression, symbols).map((reference) => {
          const entry = entryById.get(reference.parameterId) || {};
          return {
            ...reference,
            kind: reference.kind || entry.kind,
            stackId: reference.stackId || entry.stackId || null,
            driven: (reference.kind || entry.kind) === 'dimension'
              && (entry.driving === false || entry.computed === true),
          };
        });
        compiledByStackId.set(stack.id, { expression: stack.enabledExpression, references, error: null });
        const dependencies = new Set(references
          .filter(({ kind, stackId }) => kind === 'dimension' && stackId)
          .map(({ stackId }) => stackId));
        dependencyStackIdsByStack.set(stack.id, dependencies);
        references.forEach(({ parameterId, symbolKey }) => {
          const sourceId = parameterId || symbolKey;
          if (!sourceId) return;
          if (!reverseDependents.has(sourceId)) reverseDependents.set(sourceId, new Set());
          reverseDependents.get(sourceId).add(stack.id);
        });
      } catch (error) {
        const message = `Stack "${stack.name}" enable expression failed: ${error.message}`;
        compiledByStackId.set(stack.id, { expression: stack.enabledExpression, references: [], error: message });
        diagnostics.push({ code: 'invalid-expression', stackIds: [stack.id], dimensionIds: [], message });
      }
    });
    const cycles = dependencyCycles(stackState.stacks.map(({ id }) => id), dependencyStackIdsByStack);
    cycleStackIds = new Set(cycles.flat());
    cycles.forEach((cycle) => diagnostics.push(cycleDiagnostic(cycle, stackById, compiledByStackId)));
    localStates = new Map([...localStates].filter(([stackId]) => stackById.has(stackId)));
    stackState.stacks.forEach((stack) => {
      const compiled = compiledByStackId.get(stack.id);
      if (!compiled?.error && !cycleStackIds.has(stack.id)) return;
      const error = compiled?.error || diagnostics.find((item) => item.stackIds.includes(stack.id))?.message;
      localStates.set(stack.id, { localEnabled: false, effectiveEnabled: false, error, awaiting: false });
    });
    effectiveIds = effectiveEnabledStackIds(stackState, localStates);
    dirtyStackIds = new Set(stackState.stacks.map(({ id }) => id));
    return {
      compiled: [...compiledByStackId].map(([stackId, value]) => ({ stackId, ...clone(value) })),
      diagnostics: activationDiagnostics(),
    };
  }

  function markActivationDependentsDirty(parameterIds = []) {
    [...new Set(parameterIds || [])].forEach((parameterId) => {
      reverseDependents.get(parameterId)?.forEach((stackId) => dirtyStackIds.add(stackId));
    });
    return new Set(dirtyStackIds);
  }

  function markStacksDirty(stackIds = []) {
    stackIds.forEach((stackId) => {
      if (compiledByStackId.has(stackId)) dirtyStackIds.add(stackId);
    });
    return new Set(dirtyStackIds);
  }

  function evaluateDirtyStackExpressions({
    availableDimensionIds = null,
    refreshedDimensionIds = null,
  } = {}) {
    const previousEffectiveIds = new Set(effectiveIds);
    const evaluatedStackIds = [];
    const evaluationDiagnostics = diagnostics.filter(({ code }) => ['invalid-expression', 'activation-cycle'].includes(code));
    const available = availableDimensionIds ? new Set(availableDimensionIds) : null;
    const refreshed = refreshedDimensionIds ? new Set(refreshedDimensionIds) : null;
    const stackById = new Map(stackState.stacks.map((stack) => [stack.id, stack]));
    const sourceEffectiveIds = effectiveEnabledStackIds(stackState, localStates);
    const pending = [...dirtyStackIds];
    dirtyStackIds.clear();
    pending.forEach((stackId) => {
      const stack = stackById.get(stackId);
      const compiled = compiledByStackId.get(stackId);
      if (!stack || !compiled) return;
      evaluatedStackIds.push(stackId);
      if (compiled.error || cycleStackIds.has(stackId)) return;
      if (stack.enabled !== false) {
        localStates.set(stackId, { localEnabled: true, error: null, awaiting: false });
        return;
      }
      if (!String(compiled.expression || '').trim()) {
        localStates.set(stackId, { localEnabled: false, error: null, awaiting: false });
        return;
      }
      const unavailable = compiled.references.find((reference) => {
        if (reference.kind !== 'dimension' || !reference.stackId) return false;
        if (!sourceEffectiveIds.has(reference.stackId)) return true;
        if (available && !available.has(reference.parameterId)) return true;
        return reference.driven && refreshed && !refreshed.has(reference.parameterId);
      });
      if (unavailable) {
        const sourceName = stackById.get(unavailable.stackId)?.name || unavailable.stackId;
        const message = `Stack "${stack.name}" is disabled because ${unavailable.name} from Stack "${sourceName}" is unavailable.`;
        localStates.set(stackId, { localEnabled: false, effectiveEnabled: false, error: message, awaiting: true });
        evaluationDiagnostics.push({
          code: 'unavailable-source', stackIds: [stackId, unavailable.stackId],
          dimensionIds: [unavailable.parameterId], message,
        });
        return;
      }
      try {
        const value = evaluateExpression(compiled.expression, { stackId });
        localStates.set(stackId, { localEnabled: Boolean(value), error: null, awaiting: false });
      } catch (error) {
        const message = `Stack "${stack.name}" enable expression failed: ${error.message}`;
        localStates.set(stackId, { localEnabled: false, effectiveEnabled: false, error: message, awaiting: false });
        evaluationDiagnostics.push({ code: 'evaluation-error', stackIds: [stackId], dimensionIds: [], message });
      }
    });
    effectiveIds = effectiveEnabledStackIds(stackState, localStates);
    stackState.stacks.forEach((stack) => {
      const runtime = normalizedRuntimeState(localStates.get(stack.id));
      localStates.set(stack.id, { ...runtime, effectiveEnabled: effectiveIds.has(stack.id) });
    });
    const changedEffectiveStackIds = stackState.stacks
      .filter(({ id }) => previousEffectiveIds.has(id) !== effectiveIds.has(id))
      .map(({ id }) => id);
    changedEffectiveStackIds.forEach((sourceStackId) => {
      dependencyStackIdsByStack.forEach((sourceIds, dependentStackId) => {
        if (sourceIds.has(sourceStackId)) dirtyStackIds.add(dependentStackId);
      });
    });
    diagnostics = evaluationDiagnostics;
    lastEvaluationCount = evaluatedStackIds.length;
    return {
      states: runtimeStates(),
      effectiveEnabledStackIds: new Set(effectiveIds),
      evaluatedStackIds,
      changedEffectiveStackIds,
      dirtyStackIds: new Set(dirtyStackIds),
      diagnostics: activationDiagnostics(),
    };
  }

  function runtimeStates() {
    return new Map(stackState.stacks.map(({ id }) => [id, normalizedRuntimeState(localStates.get(id))]));
  }

  function activationDiagnostics() {
    return clone(diagnostics);
  }

  function beginStabilization() {
    observedSignatures = new Map();
    acceptedState = {
      states: runtimeStates(),
      effectiveIds: new Set(effectiveIds),
    };
    return activationSignature(effectiveIds);
  }

  function recordActivationRound(round) {
    const signature = activationSignature(effectiveIds);
    if (observedSignatures.has(signature)) {
      const previousRound = observedSignatures.get(signature);
      const message = `Stack activation oscillation repeated the state from round ${previousRound} at round ${round}.`;
      diagnostics.push({
        code: 'activation-oscillation',
        stackIds: stackState.stacks.map(({ id }) => id),
        dimensionIds: [...new Set([...compiledByStackId.values()].flatMap(({ references }) => references
          .filter(({ kind }) => kind === 'dimension').map(({ parameterId }) => parameterId)))],
        message,
      });
      return { stable: false, oscillating: true, signature, previousRound, message };
    }
    observedSignatures.set(signature, round);
    return { stable: true, oscillating: false, signature };
  }

  function restoreAcceptedState() {
    if (!acceptedState) return runtimeStates();
    localStates = new Map([...acceptedState.states].map(([id, value]) => [id, clone(value)]));
    effectiveIds = new Set(acceptedState.effectiveIds);
    return runtimeStates();
  }

  function stats() {
    return {
      compiledStackCount: compiledByStackId.size,
      dirtyStackCount: dirtyStackIds.size,
      reverseDependencyCount: reverseDependents.size,
      lastEvaluationCount,
    };
  }

  compileStackExpressions(stackState, expressionSymbols);

  return {
    compileStackExpressions,
    markActivationDependentsDirty,
    markStacksDirty,
    evaluateDirtyStackExpressions,
    effectiveEnabledStackIds: () => new Set(effectiveIds),
    runtimeStates,
    activationDiagnostics,
    beginStabilization,
    recordActivationRound,
    restoreAcceptedState,
    stats,
  };
}

function parameterFingerprint(parameters = []) {
  return new Map(parameters.map((entry) => [entry.id, JSON.stringify({
    value: entry.value,
    error: entry.error || null,
    expression: entry.expression,
    name: entry.name,
    stackId: entry.stackId || null,
    driving: entry.driving,
    computed: entry.computed,
  })]));
}

function changedParameterIds(previous, next) {
  const changed = new Set();
  next.forEach((value, parameterId) => {
    if (previous.get(parameterId) !== value) changed.add(parameterId);
  });
  previous.forEach((_value, parameterId) => {
    if (!next.has(parameterId)) changed.add(parameterId);
  });
  return changed;
}

export function createStackActivationCoordinator({
  activationSystem,
  getParameters = () => [],
  getStackState = () => null,
  getStackRuntimeState = () => ({ stacks: [] }),
  restoreStackState = () => {},
  applyStackRuntimeStates = () => {},
  setEnabledStackIds = () => ({ changed: false, enabled: [], disabled: [] }),
  getSolverSnapshot = () => null,
  restoreSolverSnapshot = () => {},
  entityIdsForStackIds = () => [],
  solve = () => ({ status: 'unchanged', changedEntityIds: [] }),
  applySolvedGeometry = () => {},
  afterStable = () => {},
} = {}) {
  if (!activationSystem) throw new Error('Stack activation coordinator requires an activation system.');
  let evaluating = false;
  let acceptedParameterFingerprint = new Map();
  let acceptedStackState = clone(getStackState());
  let acceptedRuntimeStates = new Map((getStackRuntimeState()?.stacks || []).map((stack) => [stack.id, {
    localEnabled: stack.localEnabled,
    effectiveEnabled: stack.effectiveEnabled,
    error: stack.activationError,
    awaiting: stack.activationAwaiting,
  }]));
  let lastRefreshResult = null;

  function currentParameterFingerprint() {
    return parameterFingerprint(getParameters() || []);
  }

  function refresh({ compile = false, allowRollback = true, maximumRounds = 16 } = {}) {
    if (evaluating) return null;
    const nextFingerprint = currentParameterFingerprint();
    const changedIds = changedParameterIds(acceptedParameterFingerprint, nextFingerprint);
    if (!compile && !changedIds.size) return null;
    const beforeSolver = allowRollback ? getSolverSnapshot() : null;
    evaluating = true;
    try {
      if (compile) {
        const compilation = activationSystem.compileStackExpressions(getStackState());
        const blocking = compilation.diagnostics.filter(({ code }) => (
          code === 'invalid-expression' || code === 'activation-cycle'
        ));
        if (blocking.length) {
          const failedStates = activationSystem.runtimeStates();
          applyStackRuntimeStates(failedStates);
          setEnabledStackIds([...failedStates]
            .filter(([, runtime]) => runtime.effectiveEnabled !== false && !runtime.error)
            .map(([stackId]) => stackId));
          const error = new Error(blocking.map(({ message }) => message).join(' '));
          error.diagnostics = blocking;
          throw error;
        }
      }
      if (changedIds.size) activationSystem.markActivationDependentsDirty(changedIds);
      activationSystem.beginStabilization();
      for (let round = 1; round <= maximumRounds; round += 1) {
        const parametersBeforeSolve = new Map((getParameters() || []).map((entry) => [entry.id, JSON.stringify({
          value: entry.value,
          error: entry.error || null,
        })]));
        const sourceEnabledIds = activationSystem.effectiveEnabledStackIds();
        const availableDimensionIds = (getParameters() || [])
          .filter((entry) => entry.kind === 'dimension' && sourceEnabledIds.has(entry.stackId))
          .map(({ id }) => id);
        const evaluation = activationSystem.evaluateDirtyStackExpressions({
          availableDimensionIds,
          refreshedDimensionIds: availableDimensionIds,
        });
        applyStackRuntimeStates(evaluation.states);
        const transition = setEnabledStackIds(evaluation.effectiveEnabledStackIds) || { changed: false };
        let solveResult = null;
        if (transition.changed && transition.enabled?.length) {
          const enabledIds = new Set(transition.enabled);
          solveResult = solve({ seedEntityIds: entityIdsForStackIds(enabledIds) });
          if (!['converged', 'unchanged', 'preview'].includes(solveResult?.status)) {
            const enabledNames = getStackState().stacks
              .filter(({ id }) => enabledIds.has(id)).map(({ name }) => `"${name}"`).join(', ');
            throw new Error(`Stack activation failed while enabling ${enabledNames}: ${solveResult?.message || 'solve failed'}`);
          }
          if (solveResult.changedEntityIds?.length) applySolvedGeometry(solveResult.changedEntityIds);
        }
        const changedSourceIds = (getParameters() || [])
          .filter((entry) => parametersBeforeSolve.get(entry.id) !== JSON.stringify({
            value: entry.value,
            error: entry.error || null,
          }))
          .map(({ id }) => id);
        if (changedSourceIds.length) activationSystem.markActivationDependentsDirty(changedSourceIds);
        const hasMoreWork = transition.changed
          || changedSourceIds.length
          || activationSystem.stats().dirtyStackCount > 0;
        if (!hasMoreWork) {
          acceptedParameterFingerprint = currentParameterFingerprint();
          acceptedStackState = clone(getStackState());
          acceptedRuntimeStates = new Map([...evaluation.states].map(([stackId, runtime]) => [stackId, clone(runtime)]));
          afterStable();
          lastRefreshResult = { status: 'stable', rounds: round, evaluation, solveResult };
          return lastRefreshResult;
        }
        if (transition.changed) {
          const signature = activationSystem.recordActivationRound(round);
          if (signature.oscillating) throw new Error(signature.message);
        }
      }
      throw new Error(`Stack activation did not stabilize within ${maximumRounds} rounds.`);
    } catch (error) {
      const failedDiagnostics = error.diagnostics || activationSystem.activationDiagnostics();
      if (allowRollback && beforeSolver && acceptedStackState) {
        restoreSolverSnapshot(beforeSolver);
        restoreStackState(acceptedStackState);
        activationSystem.compileStackExpressions(acceptedStackState);
        applyStackRuntimeStates(acceptedRuntimeStates);
        setEnabledStackIds([...acceptedRuntimeStates]
          .filter(([, runtime]) => runtime.effectiveEnabled !== false && !runtime.error)
          .map(([stackId]) => stackId));
        applySolvedGeometry();
      }
      acceptedParameterFingerprint = currentParameterFingerprint();
      lastRefreshResult = { status: 'failed', message: error.message, diagnostics: clone(failedDiagnostics) };
      return lastRefreshResult;
    } finally {
      evaluating = false;
    }
  }

  return {
    refresh,
    lastResult: () => lastRefreshResult ? clone(lastRefreshResult) : null,
    isEvaluating: () => evaluating,
    resetParameterFingerprint() {
      acceptedParameterFingerprint = new Map();
    },
  };
}
