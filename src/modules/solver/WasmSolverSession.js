import { isCanvasOriginReference } from '../CanvasOrigin.js';
import { constraintVariableIds } from './ConstraintGraph.js';
import { ConstraintProgram } from './WasmConstraintCompiler.js';
import { prepareArcSolveGeometry } from './ArcSolveGeometry.js';
import { WasmSwellModel } from './WasmSwellModel.js';
import { compileConstraintTopology } from './CompiledConstraintSystem.js';
import { WasmGraph } from './WasmGraph.js';
import { WasmParameters } from './WasmParameters.js';
import { WasmContinuation } from './WasmContinuation.js';
import { isSwellEntity, swellDisplayKey } from '../SwellGeometry.js';

export const WASM_SOLVER_URL = new URL('./wasm/solver.wasm', import.meta.url);
const kinds = new Map(['Coincident', 'Horizontal', 'Vertical', 'Distance', 'Horizontal Distance',
  'Vertical Distance', 'Fixed', 'Radius', 'Diameter', 'Midpoint', 'Concentric', 'Point-on Circle'].map((name, i) => [name, i + 1]));
const statuses = ['solving', 'converged', 'unchanged', 'max-iterations', 'invalid', 'cancelled', 'preview', 'failed'];
const dimensionalTypes = new Set(['Distance', 'Horizontal Distance', 'Vertical Distance', 'Point Line Distance',
  'Line Line Distance', 'Radius', 'Diameter', 'Angle', 'Meta']);
const now = () => globalThis.performance?.now?.() ?? Date.now();
// A timer turn lets Worker message events run. scheduler.yield() continuations
// can outrank incoming messages and starve revision cancellation in Chromium.
const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));

export async function loadWasmSolverModule(bytes = null) {
  const source = bytes ?? await (async () => {
    const response = await fetch(WASM_SOLVER_URL);
    if (!response.ok) throw new Error(`WASM solver download failed: ${response.status}`);
    return response.arrayBuffer();
  })();
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  if (WebAssembly.Module.imports(module).length) throw new Error('Unexpected WASM solver imports.');
  return module;
}

function referenceKey(ref) {
  if (!ref) return '';
  return JSON.stringify(ref);
}
function constraintKey(constraint) {
  // Values/targets deliberately do not participate in the topology key.
  return [constraint.type, constraint.enabled !== false, constraint.coordinateSpace, constraint.parameterRef,
    constraint.dimensionRef, referenceKey(constraint.featureRefs), referenceKey(constraint.anchors),
    referenceKey(constraint.direction), Boolean(constraint.fixedPoint), referenceKey(constraint.tangentPoint),
    constraint.tangentMode, Boolean(Number(constraint.tangentOrientation)), constraint.subtype, constraint.projectionMode].join('|');
}
function rootModel(model) { while (model.source) model = model.source; return model; }

export class WasmSolverSession {
  constructor(module) {
    this.instance = new WebAssembly.Instance(module, {});
    this.native = this.instance.exports;
    if (this.native.abi_version() !== 4) throw new Error('Unsupported native solver ABI.');
    this.signature = null;
    this.topologyBuilds = 0;
    this.lastSyncBytes = 0;
    this.busy = false;
  }

  view(kind, Type, length) { return new Type(this.native.memory.buffer, this.native.buffer(kind), length); }

  compile(model) {
    this.signature = null;
    const variables = model.allVariables();
    const dependencies = this.arcGeometry?.dependencies || new Map();
    const active = variables.filter(v => v.active && !dependencies.has(v.id));
    const variableIndex = new Map(variables.map((v, i) => [v.id, i]));
    const columnIndex = new Map(active.map((v, i) => [v.id, i]));
    const originalConstraints = [...model.constraints.values()];
    const needsSwell = model.displaySwell || originalConstraints.some(c => [...(c.featureRefs || []), c.anchors?.start, c.anchors?.end, c.tangentPoint].some(r => r?.derivedFeature));
    this.swell = needsSwell ? new WasmSwellModel(model, variableIndex) : null;
    const intrinsicIds = model.placementVariables || model.displaySwell ? [] : model.scope?.intrinsicEntityIds || model.entities.keys();
    const constraints = [...intrinsicIds].filter(id => model.binding(id)?.type === 'arc')
      .map(id => ({ runtimeKey: `intrinsic:${id}`, type: 'Intrinsic', entityId: id })).concat(originalConstraints);
    const slot = (binding, key) => {
      const index = variableIndex.get(binding.variables.get(key)?.id);
      if (index === undefined) throw new Error(`Native feature requires ${key}.`);
      return index;
    };
    const point = ref => {
      if (isCanvasOriginReference(ref)) return [-1, -1];
      if (!ref || ref.derivedFeature || ref.pointRole || ref.type === 'segment-point') throw new Error('Unsupported native point feature.');
      const binding = model.binding(ref.recordId || ref.entityId);
      if (!binding) throw new Error('Native point binding is missing.');
      if (ref.type === 'center' && binding.type !== 'circle') throw new Error('Requires native round feature.');
      const index = ref.type === 'segment-start' ? 0 : ref.type === 'segment-end' ? 2 : Number(ref.index) || 0;
      const prefix = binding.type === 'line' ? (index === 0 ? 'start' : index === 2 ? 'end' : null)
        : binding.type === 'point' && index === 0 ? 'point'
        : binding.type === 'circle' && index === 0 ? 'center' : null;
      if (!prefix) throw new Error('Unsupported native point index.');
      return [slot(binding, `${prefix}.x`), slot(binding, `${prefix}.y`)];
    };
    const segment = ref => {
      const binding = model.binding(ref?.recordId || ref?.entityId);
      if (binding?.type !== 'line' || ref.derivedFeature || Number(ref.index || 0) !== 0) throw new Error('Unsupported native segment.');
      return ['start.x', 'start.y', 'end.x', 'end.y'].map(key => slot(binding, key));
    };
    const round = ref => {
      const binding = model.binding(ref?.recordId || ref?.entityId);
      if (binding?.type !== 'circle' || ref.derivedFeature) throw new Error('Unsupported native circle.');
      return ['center.x', 'center.y', 'radius'].map(key => slot(binding, key));
    };
    const descriptors = [], constants = [], rows = [0], columns = [], included = [], parameterIds = [], parameterIndex = new Map();
    const programs = [], programData = [], programUpdates = [];
    let programCapacity = 0;
    const parameterSlot = id => {
      if (!parameterIndex.has(id)) { parameterIndex.set(id, parameterIds.length); parameterIds.push(id); }
      return parameterIndex.get(id);
    };
    for (const constraint of constraints) {
      if (constraint.enabled === false) continue;
      let refs, count = 1, nativeKind = kinds.get(constraint.type), program = null;
      const features = constraint.featureRefs || [];
      try {
      if (constraint.coordinateSpace === 'global' || !nativeKind) throw new Error('Requires native program.');
      switch (constraint.type) {
        case 'Horizontal': case 'Vertical': refs = segment(features[0]); break;
        case 'Coincident': refs = [...point(features[0]), ...point(features[1])]; count = 2; break;
        case 'Distance': case 'Horizontal Distance': case 'Vertical Distance':
          refs = [...point(constraint.anchors?.start || features[0]), ...point(constraint.anchors?.end || features[1])];
          if (constraint.type === 'Distance' && Array.isArray(constraint.direction)) {
            const length = Math.hypot(...constraint.direction);
            if (length > 1e-12 && length <= 1e-9) throw new Error('Tiny direction uses the JavaScript derivative fallback.');
            if (Number.isFinite(length) && length > 1e-9) count = 2;
          } break;
        case 'Fixed': {
          const ref = features.find(ref => ref.kind === 'point' || ref.type === 'point');
          if (!ref || !constraint.fixedPoint) continue;
          refs = point(ref); count = 2; break;
        }
        case 'Radius': case 'Diameter': refs = [round(features[0])[2]]; break;
        case 'Concentric': refs = [...round(features[0]).slice(0, 2), ...round(features[1]).slice(0, 2)]; count = 2; break;
        case 'Midpoint': refs = [...point(features[0]), ...segment(features[1])]; count = 2; break;
        case 'Point-on Circle': refs = [...point(features[0]), ...round(features[1])]; break;
        default: throw new Error('Unsupported native constraint.');
      }
      } catch {
        program = new ConstraintProgram(model, constraint, variableIndex, parameterSlot, dependencies, this.swell);
        const outputs = program.compile(); count = outputs.length;
        if (!count) continue;
        const offset = programData.length;
        refs = [offset, program.data.length, ...outputs, ...Array(3 - count).fill(-1), 0, program.forceDifference ? 1 : 0, 0];
        programs.push(...program.code); programData.push(...program.data);
        programUpdates.push(...program.updates.map(update => ({ ...update, index: offset + update.index })));
        programCapacity = Math.max(programCapacity, program.data.length); nativeKind = 100;
      }
      const ids = model.placementVariables ? model.placementVariableIds(constraint)
        : constraint.type === 'Intrinsic' ? model.binding(constraint.entityId).allVariables().map(v => v.id) : constraintVariableIds(model, constraint);
      const localColumns = [...new Set([...ids].flatMap(id => dependencies.has(id) ? dependencies.get(id).map(({ variable }) => variable.id) : [id]))]
        .filter(id => columnIndex.has(id)).map(id => columnIndex.get(id));
      // Keep the original registry's variable order, including structural zeroes.
      if (!program && localColumns.length > 8) throw new Error('Native direct constraint exceeds the local column capacity.');
      let parameter = -1;
      if (constraint.dimensionRef) {
        parameter = parameterSlot(constraint.dimensionRef);
      }
      descriptors.push(nativeKind, rows.length - 1, count, parameter, ...refs, ...Array(8 - refs.length).fill(-1));
      for (let row = 0; row < count; row++) { columns.push(...localColumns); rows.push(columns.length); }
      constants.push(0, 0, 0, 0, 0, 0);
      included.push(constraint);
    }
    const byOwner = new Map();
    active.forEach((variable, column) => {
      const owner = active.length >= 96 ? variable.ownerId : column;
      if (!byOwner.has(owner)) byOwner.set(owner, []);
      byOwner.get(owner).push(column);
    });
    const groups = [...byOwner.values()].flatMap(group => group.length <= 8 ? [group] : group.map(column => [column]));
    const groupStarts = [0], groupColumns = [], groupOffsets = [0], columnGroups = new Int32Array(active.length), columnLocal = new Int32Array(active.length);
    groups.forEach((group, g) => {
      group.forEach((column, local) => { groupColumns.push(column); columnGroups[column] = g; columnLocal[column] = local; });
      groupStarts.push(groupColumns.length); groupOffsets.push(groupOffsets.at(-1) + group.length ** 2);
    });
    const sparseTopology = (model.placementVariables || [...model.entities.values()].some(b => b.type === 'arc')) && active.length
      ? compileConstraintTopology({ variables: active, variableCount: active.length,
        blocks: included.map((_, i) => ({ columnIndexes: columns.slice(rows[descriptors[i * 12 + 1]], rows[descriptors[i * 12 + 1] + 1]) })) }) : null;
    if (!this.native.configure(variables.length, active.length, included.length, rows.length - 1, columns.length,
      parameterIds.length, groups.length, groupOffsets.at(-1), programData.length, programCapacity,
      dependencies.size, this.arcSeeds?.length || 0, ...(this.swell?.sizes || Array(7).fill(0)), sparseTopology?.fillEntries || 0)) throw new Error('Native solver capacity exceeded.');
    if (sparseTopology) {
      const { order, columns: fill } = sparseTopology;
      this.view(22, Int32Array, active.length).set(order);
      const position = new Int32Array(this.native.memory.buffer, this.native.sparse_buffer(0), active.length);
      order.forEach((c, i) => { position[c] = i; });
      const offsets = new Int32Array(this.native.memory.buffer, this.native.sparse_buffer(1), active.length + 1);
      const storage = this.view(23, Int32Array, sparseTopology.fillEntries);
      let offset = 0;
      fill.forEach((adjacent, row) => { offsets[row] = offset; storage[offset++] = row; storage.set(adjacent, offset); offset += adjacent.length; });
      offsets[active.length] = offset;
    }
    this.variables = variables; this.active = active; this.constraints = included; this.parameterIds = parameterIds;
    this.rowCount = rows.length - 1; this.entryCount = columns.length;
    this.programUpdates = programUpdates; this.programCount = programData.length;
    this.view(15, Int32Array, programs.length).set(programs); this.view(16, Float64Array, programData.length).set(programData);
    this.view(17, Int32Array, dependencies.size * 3).set([...dependencies].flatMap(([id, sources]) => [variableIndex.get(id), ...sources.map(({ variable }) => variableIndex.get(variable.id))]));
    this.view(2, Int32Array, descriptors.length).set(descriptors);
    this.view(3, Float64Array, constants.length).set(constants);
    this.view(4, Int32Array, active.length).set(active.map(v => variableIndex.get(v.id)));
    this.view(5, Int32Array, rows.length).set(rows); this.view(6, Int32Array, columns.length).set(columns);
    this.view(9, Int32Array, groupStarts.length).set(groupStarts); this.view(10, Int32Array, groupColumns.length).set(groupColumns);
    this.view(11, Int32Array, groupOffsets.length).set(groupOffsets); this.view(12, Int32Array, columnGroups.length).set(columnGroups);
    this.view(13, Int32Array, columnLocal.length).set(columnLocal);
    if (this.swell) this.view(20, Int32Array, this.swell.integers.length).set(this.swell.integers);
    this.signature = { variables: variables.map(v => [v.id, v.active]), constraints: originalConstraints.map(c => [c.id, constraintKey(c)]), root: rootModel(model), derived: this.derivedTopology(model),
      reduction: [...dependencies.keys()].join('|'), seedCount: this.arcSeeds?.length || 0,
      swell: this.swell ? WasmSwellModel.topology(model) : null };
    this.topologyBuilds++;
  }

  derivedTopology(model) {
    return JSON.stringify([...rootModel(model).derivedEntities.values()].map(d => [d.id, d.type, d.sourceA, d.sourceB, d.radiusDimensionId]));
  }

  compatible(model, topologyToken = null) {
    if (!this.signature || this.signature.root !== rootModel(model)) return false;
    const trusted = topologyToken && this.topologyToken === topologyToken;
    if (!trusted && this.swell && this.signature.swell !== WasmSwellModel.topology(model)) return false;
    if (this.signature.reduction !== [...(this.arcGeometry?.dependencies.keys() || [])].join('|') || this.signature.seedCount !== (this.arcSeeds?.length || 0)) return false;
    if (!trusted && this.signature.derived !== this.derivedTopology(model)) return false;
    const variables = model.allVariables();
    if (variables.length !== this.signature.variables.length || model.constraints.size !== this.signature.constraints.length) return false;
    for (let i = 0; i < variables.length; i++) if (variables[i].id !== this.signature.variables[i][0] || variables[i].active !== this.signature.variables[i][1]) return false;
    let i = 0;
    for (const c of model.constraints.values()) { const previous = this.signature.constraints[i++]; if (c.id !== previous[0] || (!trusted && constraintKey(c) !== previous[1])) return false; }
    return true;
  }

  prepare({ model, dimensions, evaluateParameterTargets = true, computedDimensionIds = null, topologyToken = null } = {}) {
    this.preparedAt = now();
    if (evaluateParameterTargets) dimensions?.evaluateDirty?.({ strict: false, refreshComputed: true, refreshComputedIds: computedDimensionIds });
    this.arcGeometry = null; this.arcSeeds = [];
    if (!model.placementVariables && !model.displaySwell && [...model.entities.values()].some(b => b.type === 'arc')) {
      const variables = model.allVariables();
      if (!this.arcPrevious || this.arcPrevious.length < variables.length) this.arcPrevious = new Float64Array(variables.length);
      const before = this.arcPrevious; variables.forEach((v, i) => { before[i] = v.value; });
      try {
        this.arcGeometry = prepareArcSolveGeometry(model, dimensions, variables.filter(v => v.active));
        variables.forEach((v, index) => { if (v.value !== before[index]) this.arcSeeds.push({ index, value: v.value }); });
      } finally { variables.forEach((v, i) => { v.value = before[i]; }); }
    }
    if (!this.compatible(model, topologyToken)) this.compile(model);
    this.topologyToken = topologyToken;
    this.lastSyncBytes = 0;
    const write = (data, index, value) => { if (!Object.is(data[index], value)) { data[index] = value; this.lastSyncBytes += data.BYTES_PER_ELEMENT; } };
    // Binding objects can be replaced during undo/rollback while stable IDs remain.
    this.variables = model.allVariables();
    const values = this.view(0, Float64Array, this.variables.length);
    this.variables.forEach((variable, index) => { write(values, index, variable.value); });
    this.view(18, Int32Array, this.arcSeeds.length).set(this.arcSeeds.map(s => s.index));
    this.view(19, Float64Array, this.arcSeeds.length).set(this.arcSeeds.map(s => s.value));
    const targets = this.view(1, Float64Array, this.parameterIds.length);
    this.parameterIds.forEach((id, index) => {
      const value = dimensions?.value(id); if (!Number.isFinite(value)) throw new Error(`Non-numeric native target ${id}.`);
      write(targets, index, value);
    });
    const constants = this.view(3, Float64Array, this.constraints.length * 6);
    this.constraints.forEach((previous, index) => {
      if (previous.type === 'Intrinsic') return;
      const c = model.constraints.get(previous.id);
      if (dimensionalTypes.has(c.type) && !c.dimensionRef && !Number.isFinite(c.value)) throw new Error('Dimensional constraint requires a finite target.');
      if (c.type === 'Length' && (!Number.isFinite(Number(c.value)) || Number(c.value) <= 0)) throw new Error('Length requires a positive finite target.');
      const start = index * 6, directionLength = Math.hypot(...(c.direction || [0, 0]));
      write(constants, start, c.value ?? 0); write(constants, start + 1, c.fixedPoint?.[0] ?? 0); write(constants, start + 2, c.fixedPoint?.[1] ?? 0);
      write(constants, start + 3, directionLength > 1e-9 ? c.direction[0] / directionLength : 0);
      write(constants, start + 4, directionLength > 1e-9 ? c.direction[1] / directionLength : 0); write(constants, start + 5, c.orientation || 0);
    });
    const programData = this.view(16, Float64Array, this.programCount);
    this.programUpdates.forEach(({ index, read }) => { write(programData, index, read(model, dimensions)); });
    if (this.swell) this.swell.sync(model, dimensions, this.view(21, Float64Array, this.swell.numberCount), write);
    this.lastSyncBytes += this.arcSeeds.length * 12;
    this.preparationMs = now() - this.preparedAt;
  }

  result(model, startedAt, cancellationReason = null) {
    const s = this.view(14, Float64Array, 20), values = this.view(0, Float64Array, this.variables.length);
    const changed = new Set();
    this.variables.forEach((variable, index) => {
      if (Math.abs(variable.value - values[index]) > 1e-10) changed.add(variable.ownerId);
      variable.value = values[index];
    });
    const status = statuses[s[0]];
    const terminationReason = s[16] === 1 ? 'stagnation' : null;
    if (status === 'preview' && !cancellationReason) cancellationReason = terminationReason || 'iteration-budget';
    const problematicConstraintIds = [];
    if (['failed', 'max-iterations', 'invalid'].includes(status)) {
      const residuals = this.view(8, Float64Array, this.rowCount);
      const descriptors = this.view(2, Int32Array, this.constraints.length * 12);
      const scores = this.constraints.map((constraint, index) => {
        const row = descriptors[index * 12 + 1], count = descriptors[index * 12 + 2];
        let score = 0; for (let r = row; r < row + count; r++) score = Math.max(score, Math.abs(residuals[r]));
        return { id: constraint.id, score };
      });
      problematicConstraintIds.push(...scores.filter(c => c.score > 0 && model.constraints.has(c.id)).sort((a, b) => b.score - a.score).slice(0, 5).map(c => c.id));
    }
    return { status, backend: 'wasm', iterations: s[1], initialError: s[2], finalError: s[3], acceptedSteps: s[4], rejectedSteps: s[5],
      changedEntityIds: [...changed], problematicConstraintIds, ...(cancellationReason ? { cancellationReason } : {}),
      ...(terminationReason ? { terminationReason } : {}),
      message: `Native solver ${status}.`,
      timings: { totalMs: now() - startedAt, preparationMs: this.preparationMs },
      jacobianStats: { requestedMode: 'blocks', mode: 'matrix-free', linearSolver: s[17] ? 'native-compiled-elimination' : 'native-pcg', factorEntries: s[17],
        totalBlocks: this.constraints.length, analyticalBlocks: s[9], fallbackBlocks: s[10], residualRows: this.rowCount,
        derivativeEntries: this.entryCount, linearIterations: s[6], totalLinearIterations: s[7], linearConverged: Boolean(s[8]),
        arenaBytes: s[11], memoryGrowths: s[12], topologyBuilds: this.topologyBuilds, lastSyncBytes: this.lastSyncBytes },
    };
  }

  start(options, prepared = false) {
    if (this.busy) throw new Error('Native solver session is already solving.');
    if (!prepared) this.prepare(options);
    const startedAt = this.preparedAt; this.busy = true;
    this.native.begin(options.tolerance ?? 1e-3, options.maxIterations ?? 2000, options.solveMode === 'interactive' ? 1 : 0);
    return startedAt;
  }

  advance(options, startedAt) {
    const reason = options.shouldCancel?.() || (now() - startedAt >= (options.timeBudgetMs ?? Infinity) ? 'time-budget' : null);
    if (reason) { this.native.cancel(options.solveMode === 'interactive' ? 1 : 0); return reason === true ? 'cancelled' : reason; }
    this.native.advance(500000); return null;
  }

  solve(options, prepared = false) {
    const startedAt = this.start(options, prepared); let reason;
    try {
      while (this.view(14, Float64Array, 20)[0] === 0) reason = this.advance(options, startedAt);
      return this.result(options.model, startedAt, reason);
    } finally { this.busy = false; }
  }

  async solveAsync(options, prepared = false) {
    const startedAt = this.start(options, prepared); let reason;
    try {
      while (this.view(14, Float64Array, 20)[0] === 0) {
        const sliceStart = now();
        do { reason = this.advance(options, startedAt); }
        while (this.view(14, Float64Array, 20)[0] === 0 && now() - sliceStart < 16);
        if (this.view(14, Float64Array, 20)[0] === 0) await nextTask();
      }
      return this.result(options.model, startedAt, reason);
    } finally { this.busy = false; }
  }
}

// A bounded component-session cache; unsupported components always use the
// complete original JS implementation. Native Swell geometry is packed above.
export class WasmSolverBackend {
  constructor(module) { this.module = module; this.sessions = new Map(); this.fallbackReason = null; }
  createGraph() { return this.graphKernel ||= new WasmGraph(this.module); }
  createParameters() { return new WasmParameters(this.module); }
  beginContinuation(controller) { return (this.continuation ||= new WasmContinuation(this.module)).begin(controller); }
  derivedGeometry(model, dimensions) {
    try { return this.exportDerivedGeometry(model, dimensions); }
    catch (error) { return { swell: null, fallbackReason: error.message }; }
  }
  exportDerivedGeometry(model, dimensions) {
    const sources = [...model.entities.values()].filter(isSwellEntity);
    if (!sources.length) return { swell: null };
    const entities = sources.map(b => model.entity(b.id)), constraints = [...model.constraints.values()];
    const key = swellDisplayKey({ entities, constraints, evaluateLength: (expression, entity) => dimensions.evaluateLengthExpression(expression, { stackId: entity.stackId }) });
    if (this.displayPacket?.swell?.key === key) return this.displayPacket;
    const view = Object.create(model);
    view.source = model; view.displaySwell = true; view.constraints = new Map();
    view.entities = new Map(sources.map(b => [b.id, b]));
    const variables = sources.flatMap(b => b.allVariables()).map(v => ({ id: v.id, value: v.value, active: false, ownerId: v.ownerId }));
    view.allVariables = () => variables;
    this.displaySession ||= new WasmSolverSession(this.module);
    this.displaySession.prepare({ model: view, dimensions, evaluateParameterTargets: false });
    const native = this.displaySession.native, count = native.swell_export();
    const pieces = new Float64Array(native.memory.buffer, native.swell_export_buffer(0), count * 18).slice();
    const points = new Float64Array(native.memory.buffer, native.swell_export_buffer(1), this.displaySession.swell.sampleCount * 2).slice();
    return this.displayPacket = { swell: { key, sourceIds: sources.map(b => b.id), pieces, points } };
  }
  session(model) {
    const key = model.nativeSessionKey || model.allVariables()[0]?.id || 'empty';
    let session = this.sessions.get(key);
    if (!session) {
      session = new WasmSolverSession(this.module); this.sessions.set(key, session);
      if (this.sessions.size > 8) this.sessions.delete(this.sessions.keys().next().value);
    }
    return session;
  }
  trySolve(options) {
    const session = this.session(options.model);
    try { session.prepare(options); }
    catch (error) { this.fallbackReason = error.message; return null; }
    this.fallbackReason = null;
    return session.solve(options, true);
  }
  async trySolveAsync(options) {
    const session = this.session(options.model);
    try { session.prepare(options); }
    catch (error) { this.fallbackReason = error.message; return null; }
    this.fallbackReason = null;
    return session.solveAsync(options, true);
  }
}
