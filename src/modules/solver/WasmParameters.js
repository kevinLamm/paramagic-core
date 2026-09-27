import { tokenize, evaluateTokens, isLengthParameter } from './ParameterRepository.js';
import { unitFactors } from './Units.js';

const binary = ['+', '-', '*', '/', '^', '<', '<=', '>', '>=', '==', '!=', '&&', '||'];
const functions = ['abs', 'min', 'max', 'round', 'floor', 'ceil', 'sqrt', 'pow', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'if', 'minmax'];
class Program {
  constructor() { this.code = []; this.data = []; this.references = []; }
  op(kind, a = -1, b = -1, c = -1, data = 0) { const index = this.data.length; this.code.push(kind, a, b, c); this.data.push(data); return index; }
  literal(value) { return this.op(0, +(typeof value === 'boolean'), -1, -1, Number(value)); }
  input(name) { this.references.push(name); return this.op(1, this.references.length - 1); }
  binary(kind, a, b) { return this.op(2 + binary.indexOf(kind), a, b); }
  unary(kind, a) { return this.op(15 + ['-', '+', '!'].indexOf(kind), a); }
  call(name, args) {
    let result;
    if (name === 'clamp') { if (args.length < 3) throw Error('Missing arguments.'); result = this.op(19, args[2], this.op(20, args[1], args[0])); }
    else {
      const kind = functions.indexOf(name) + 18;
      const arity = ['if', 'minmax'].includes(name) ? 3 : name === 'pow' ? 2 : 1;
      if (kind < 18 || args.length < arity) throw Error('Unsupported numeric function.');
      result = ['min', 'max'].includes(name)
        ? args.length === 1 ? this.op(kind, args[0], args[0]) : args.reduce((a, b) => this.op(kind, a, b))
        : this.op(kind, ...args.slice(0, arity));
    }
    return this.op(34, result);
  }
}

// Parse with the reference grammar. Only numeric/boolean programs enter this
// batch; strings, unavailable symbols, cycles and errors retain JS semantics.
export class WasmParameters {
  constructor(module) { this.native = new WebAssembly.Instance(module, {}).exports; this.cache = new Map(); this.evaluations = 0; this.evaluatedEntries = 0; }
  tryResident(repository) {
    const plan = this.plan;
    if (!plan || repository.entries.size !== plan.entryCount || repository.defaultLengthUnit !== plan.unit
      || repository.symbolDefinitions(null).key !== plan.symbolKey) return null;
    for (const input of plan.inputs) {
      const entry = input.external ? repository.externalVariable(input.name, input.context) : repository.entries.get(input.id);
      if (!entry || entry.unit !== input.unit || entry.kind !== input.kind || !repository.isEntryAvailable(entry)) return null;
      if (entry.stackId !== input.stackId || (entry.error && !repository.dirtyEntries.has(entry.id))) return null;
      if (entry.computed !== input.computed || entry.enabled !== input.enabled) return null;
      if (!['number', 'boolean'].includes(typeof entry.value)) return null;
      plan.values[input.index] = Number(entry.value); plan.types[input.index] = +(typeof entry.value === 'boolean');
    }
    const selected = [];
    plan.records.forEach((_, i) => { if (i % 5 === 4) plan.records[i] = 0; });
    for (const id of repository.dirtyEntries) {
      const row = plan.rows.get(id), entry = repository.entries.get(id);
      if (!row || entry.computed || entry.enabled === false) return null;
      if (row.expression !== entry.expression) {
        try {
          const symbols = repository.symbolDefinitions(row.context), tokens = Object.freeze(tokenize(entry.expression, { symbols })), program = new Program();
          const output = evaluateTokens(tokens, name => program.input(name), { baseUnit: row.baseUnit, builder: program });
          if (output !== row.output || program.code.length !== row.program.code.length
            || program.code.some((v, i) => v !== row.program.code[i])
            || program.references.some((name, i) => name !== row.program.references[i])) return null;
          program.data.forEach((value, i) => { if (program.code[i * 4] !== 1) plan.data[row.offset + i] = value; });
          row.expression = entry.expression;
          repository.compiledExpressions.set(id, { expression: entry.expression, symbolKey: symbols.key, tokens });
          this.cache.set(id, { ...row, program });
        } catch { return null; }
      }
      plan.records[row.record * 5 + 4] = 1; selected.push(id);
    }
    if (!this.native.expression_evaluate()) return null;
    const result = new Map(); this.evaluations++; this.evaluatedEntries += selected.length;
    for (const id of selected) { const entry = repository.entries.get(id), index = plan.rows.get(id).index;
      entry.value = plan.types[index] ? Boolean(plan.values[index]) : plan.values[index]; entry.error = null;
      const dependencies = plan.rows.get(id).dependencyIds;
      const previous = repository.dependencies.get(id);
      if (!previous || previous.size !== dependencies.size || [...dependencies].some(dep => !previous.has(dep)))
        repository.replaceDependencies(id, new Set(dependencies));
      repository.dirtyEntries.delete(id); result.set(id, entry.value);
    }
    return result;
  }
  evaluate(repository) {
    if (!repository.dirtyEntries.size) return new Map();
    const resident = this.tryResident(repository);
    if (resident) return resident;
    this.plan = null;
    const entries = [...repository.entries.values()], byId = new Map(entries.map((e, i) => [e.id, i]));
    const programs = new Map(), dependencies = new Map(), external = [], externalIndexes = new Map();
    const drawingFactor = unitFactors[repository.defaultLengthUnit] || 1;
    const resolve = (name, context) => {
      const id = repository.idForName(name, { stackId: context, allowUniqueDimension: false });
      if (id) { repository.assertEntryAvailable(repository.entries.get(id), name); return byId.get(id); }
      const value = repository.externalVariable(name, context);
      if (!value || !['number', 'boolean'].includes(typeof value.value)) throw Error('Reference expression input.');
      const key = `${context || ''}:${name}`;
      if (!externalIndexes.has(key)) { externalIndexes.set(key, entries.length + external.length); external.push({ ...value, context, external: true }); }
      return externalIndexes.get(key);
    };
    for (const entry of entries) {
      if (entry.computed || entry.enabled === false || !repository.isEntryAvailable(entry)) continue;
      if (entry.error && !repository.dirtyEntries.has(entry.id)) continue;
      try {
        const context = entry.kind === 'dimension' ? entry.stackId || repository.defaultStackId() : null;
        const symbols = repository.symbolDefinitions(context), baseUnit = repository.defaultLengthUnit && isLengthParameter(entry) ? repository.defaultLengthUnit : null;
        let cached = this.cache.get(entry.id);
        if (!cached || cached.expression !== entry.expression || cached.symbolKey !== symbols.key || cached.baseUnit !== baseUnit) {
          const old = repository.compiledExpressions.get(entry.id);
          const tokens = old?.expression === entry.expression && old?.symbolKey === symbols.key ? old.tokens : Object.freeze(tokenize(entry.expression, { symbols }));
          repository.compiledExpressions.set(entry.id, { expression: entry.expression, symbolKey: symbols.key, tokens });
          const program = new Program();
          const output = evaluateTokens(tokens, name => program.input(name), { baseUnit, builder: program });
          cached = { expression: entry.expression, symbolKey: symbols.key, baseUnit, context, program, output };
          this.cache.set(entry.id, cached);
        }
        const inputs = cached.program.references.map(name => resolve(name, context));
        programs.set(entry.id, { ...cached, inputs });
        dependencies.set(entry.id, new Set(inputs.filter(i => i < entries.length).map(i => entries[i].id)));
      } catch { /* The reference evaluator supplies the original error/type semantics. */ }
    }
    for (const id of this.cache.keys()) if (!byId.has(id)) this.cache.delete(id);
    // Kahn order also excludes cycles without recursive traversal of long chains.
    const pending = new Map(), dependents = new Map(), queue = [];
    for (const [id, program] of programs) {
      const deps = dependencies.get(id);
      const blocked = program.inputs.some(i => {
        const entry = entries[i] || external[i - entries.length];
        return !programs.has(entry.id) && (repository.dirtyEntries.has(entry.id) || entry.error || !['number', 'boolean'].includes(typeof entry.value));
      });
      pending.set(id, [...deps].filter(dep => programs.has(dep)).length + (blocked ? 1 : 0));
      for (const dep of deps) { if (!dependents.has(dep)) dependents.set(dep, []); dependents.get(dep).push(id); }
      if (!pending.get(id)) queue.push(id);
    }
    const order = [];
    for (let i = 0; i < queue.length; i++) { const id = queue[i]; order.push(id); for (const next of dependents.get(id) || []) { pending.set(next, pending.get(next) - 1); if (!pending.get(next)) queue.push(next); } }
    const selected = order.filter(id => repository.dirtyEntries.has(id));
    if (!selected.length) return new Map();
    const all = [...entries, ...external], count = order.reduce((n, id) => n + programs.get(id).program.data.length, 0);
    if (!this.native.expression_configure(all.length, count)) return new Map();
    const view = (kind, Type, size) => new Type(this.native.memory.buffer, this.native.expression_buffer(kind), size);
    const records = view(0, Int32Array, all.length * 5), types = view(1, Int32Array, all.length), values = view(2, Float64Array, all.length), scales = view(3, Float64Array, all.length);
    const code = view(4, Int32Array, count * 4), data = view(5, Float64Array, count);
    records.fill(0);
    all.forEach((entry, i) => { values[i] = Number(entry.value); types[i] = +(typeof entry.value === 'boolean'); scales[i] = !entry.external && repository.defaultLengthUnit && isLengthParameter(entry) ? drawingFactor : 1; });
    let offset = 0; const residentRows = new Map();
    order.forEach((id, row) => {
      const { program, inputs, output } = programs.get(id);
      records.set([byId.get(id), offset, program.data.length, offset + output, +repository.dirtyEntries.has(id)], row * 5);
      residentRows.set(id, { ...programs.get(id), index: byId.get(id), record: row, offset,
        dependencyIds: new Set(inputs.map(i => all[i].external ? all[i].symbolKey : all[i].id)) });
      data.set(program.data, offset);
      for (let i = 0; i < program.data.length; i++) {
        const [op, a, b, c] = program.code.slice(i * 4, i * 4 + 4);
        code.set([op, op > 1 ? a + offset : op === 1 ? inputs[a] : a, b < 0 ? b : b + offset, c < 0 ? c : c + offset], (offset + i) * 4);
        if (op === 1) { const input = all[inputs[a]]; data[offset + i] = repository.defaultLengthUnit && (input.external ? input.unit && input.unit !== 'deg' : isLengthParameter(input)) ? 1 / drawingFactor : 1; }
      }
      offset += program.data.length;
    });
    if (!this.native.expression_evaluate()) return new Map();
    this.plan = { rows: residentRows, records, values, types, data, entryCount: entries.length,
      inputs: all.map((entry, index) => ({ ...entry, index })), unit: repository.defaultLengthUnit,
      symbolKey: repository.symbolDefinitions(null).key };
    const result = new Map(); this.evaluations++; this.evaluatedEntries += selected.length;
    for (const id of selected) {
      const index = byId.get(id), entry = entries[index];
      entry.value = types[index] ? Boolean(values[index]) : values[index]; entry.error = null;
      repository.replaceDependencies(id, new Set(programs.get(id).inputs.map(i => all[i].external ? all[i].symbolKey : all[i].id)));
      repository.dirtyEntries.delete(id); result.set(id, entry.value);
    }
    return result;
  }
}
