import { createStableId } from './SolverModel.js';
import { formatUnitValue, unitFactors } from './Units.js';

const units = unitFactors;
const UNQUOTED_IMAGE_REFERENCE = /^(?:basic|user|imported)\/[A-Za-z0-9%._~!$&'()+,;=:@/-]+$/;
const constants = { pi: Math.PI, e: Math.E, true: true, false: false, yes: true, no: false };
const functions = {
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  sqrt: Math.sqrt,
  pow: Math.pow,
  clamp: (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value)),
  minmax: (minimum, maximum, initial) => {
    const low = Number(minimum);
    const high = Number(maximum);
    const value = Number(initial);
    if (![low, high, value].every(Number.isFinite)) throw new Error('MinMax arguments must be finite numbers.');
    return Math.min(Math.max(low, high), Math.max(Math.min(low, high), value));
  },
  if: (condition, whenTrue, whenFalse) => (condition ? whenTrue : whenFalse),
  sin: (degrees) => Math.sin(degrees * Math.PI / 180),
  cos: (degrees) => Math.cos(degrees * Math.PI / 180),
  tan: (degrees) => Math.tan(degrees * Math.PI / 180),
  asin: (value) => Math.asin(value) * 180 / Math.PI,
  acos: (value) => Math.acos(value) * 180 / Math.PI,
  atan: (value) => Math.atan(value) * 180 / Math.PI,
};

function tokenize(expression) {
  const source = String(expression).trim();
  if (UNQUOTED_IMAGE_REFERENCE.test(source)) return [JSON.stringify(source)];
  const tokens = [];
  const pattern = /\s*(>=|<=|==|!=|&&|\|\||"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\d+(?:\.\d+)?(?:e[+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|[()+\-*/^!,<>])\s*/giy;
  let index = 0;
  while (index < source.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (!match) throw new Error(`Invalid expression near: ${source.slice(index)}`);
    tokens.push(match[1]);
    index = pattern.lastIndex;
  }
  return tokens;
}

function evaluateTokens(tokens, resolveName, { baseUnit = null } = {}) {
  const baseFactor = baseUnit ? units[baseUnit] || 1 : 1;
  let index = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];

  function primary() {
    if (peek() === '(') {
      take();
      const value = logicalOr();
      if (take() !== ')') throw new Error('Missing closing parenthesis.');
      return value;
    }
    const token = take();
    if (token === undefined) throw new Error('Unexpected end of expression.');
    if (token.startsWith('"') || token.startsWith("'")) {
      const body = token.slice(1, -1);
      return body.replace(/\\(['"\\])/g, '$1');
    }
    const numeric = Number(token);
    if (Number.isFinite(numeric)) {
      const unit = units[String(peek()).toLowerCase()];
      if (unit) take();
      return numeric * (unit ? unit / baseFactor : 1);
    }
    if (/^[A-Za-z_]/.test(token)) {
      const normalized = token.toLowerCase();
      if (peek() === '(') {
        const fn = functions[normalized];
        if (!fn) throw new Error(`Unknown function: ${token}`);
        take();
        const args = [];
        if (peek() !== ')') {
          do {
            args.push(logicalOr());
            if (peek() !== ',') break;
            take();
          } while (peek() !== ')');
        }
        if (take() !== ')') throw new Error(`Missing closing parenthesis for ${token}.`);
        const result = fn(...args);
        if (typeof result === 'number' && !Number.isFinite(result)) throw new Error(`${token} produced a non-finite value.`);
        return result;
      }
      if (Object.hasOwn(constants, normalized)) return constants[normalized];
      return resolveName(token);
    }
    throw new Error(`Unexpected token: ${token}`);
  }

  function unary() {
    if (peek() === '-') { take(); return -Number(unary()); }
    if (peek() === '+') { take(); return Number(unary()); }
    if (peek() === '!') { take(); return !unary(); }
    return primary();
  }

  function power() {
    const left = unary();
    if (peek() !== '^') return left;
    take();
    return Number(left) ** Number(power());
  }

  function product() {
    let value = power();
    while (peek() === '*' || peek() === '/') {
      const operator = take();
      const right = power();
      value = operator === '*' ? Number(value) * Number(right) : Number(value) / Number(right);
    }
    return value;
  }

  function sum() {
    let value = product();
    while (peek() === '+' || peek() === '-') {
      const operator = take();
      const right = product();
      value = operator === '+' ? Number(value) + Number(right) : Number(value) - Number(right);
    }
    return value;
  }

  function comparison() {
    let value = sum();
    while (['<', '<=', '>', '>='].includes(peek())) {
      const operator = take();
      const right = sum();
      if (operator === '<') value = value < right;
      if (operator === '<=') value = value <= right;
      if (operator === '>') value = value > right;
      if (operator === '>=') value = value >= right;
    }
    return value;
  }

  function equality() {
    let value = comparison();
    while (peek() === '==' || peek() === '!=') {
      const operator = take();
      const right = comparison();
      value = operator === '==' ? value === right : value !== right;
    }
    return value;
  }

  function logicalAnd() {
    let value = equality();
    while (peek() === '&&') { take(); const right = equality(); value = Boolean(value) && Boolean(right); }
    return value;
  }

  function logicalOr() {
    let value = logicalAnd();
    while (peek() === '||') { take(); const right = logicalAnd(); value = Boolean(value) || Boolean(right); }
    return value;
  }

  const result = logicalOr();
  if (index !== tokens.length) throw new Error(`Unexpected token: ${tokens[index]}`);
  return result;
}

function parseExpression(source, resolveName, options = {}) {
  return evaluateTokens(tokenize(source), resolveName, options);
}

function replaceReference(expression, oldName, nextName) {
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(expression).replace(new RegExp(`\\b${escaped}\\b`, 'g'), nextName);
}

function clone(entry) {
  return entry ? { ...entry } : null;
}

function isLengthParameter(entry) {
  if (entry?.unit === 'deg') return false;
  if (entry?.kind === 'control') return false;
  return true;
}

export class ParameterRepository {
  constructor() {
    this.entries = new Map();
    this.names = new Map();
    this.externalVariables = new Map();
    this.listeners = new Set();
    this.computedResolvers = new Map();
    this.compiledExpressions = new Map();
    this.dependencies = new Map();
    this.dependents = new Map();
    this.dirtyEntries = new Set();
    this.nextUserIndex = 1;
    this.nextDimensionIndex = 1;
    this.nextControlIndex = 1;
    this.defaultLengthUnit = null;
  }

  markAllDirty() {
    this.entries.forEach((_entry, id) => this.dirtyEntries.add(id));
  }

  markDirty(id, { includeDependents = true } = {}) {
    if (!this.entries.has(id)) return;
    const pending = [id];
    const visited = new Set();
    while (pending.length) {
      const current = pending.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      this.dirtyEntries.add(current);
      if (includeDependents) {
        this.dependents.get(current)?.forEach((dependentId) => pending.push(dependentId));
      }
    }
  }

  affectedIds(idOrName) {
    const id = this.entries.has(idOrName) ? idOrName : this.names.get(idOrName);
    if (!id) return new Set();
    const affected = new Set();
    const pending = [id];
    while (pending.length) {
      const current = pending.pop();
      if (affected.has(current)) continue;
      affected.add(current);
      this.dependents.get(current)?.forEach((dependentId) => pending.push(dependentId));
    }
    return affected;
  }

  replaceDependencies(id, nextDependencies) {
    const previous = this.dependencies.get(id) || new Set();
    previous.forEach((dependencyId) => {
      if (nextDependencies.has(dependencyId)) return;
      const reverse = this.dependents.get(dependencyId);
      reverse?.delete(id);
      if (!reverse?.size) this.dependents.delete(dependencyId);
    });
    nextDependencies.forEach((dependencyId) => {
      if (!this.dependents.has(dependencyId)) this.dependents.set(dependencyId, new Set());
      this.dependents.get(dependencyId).add(id);
    });
    this.dependencies.set(id, nextDependencies);
  }

  removeDependencyEdges(id) {
    const dependencies = this.dependencies.get(id) || new Set();
    dependencies.forEach((dependencyId) => {
      const reverse = this.dependents.get(dependencyId);
      reverse?.delete(id);
      if (!reverse?.size) this.dependents.delete(dependencyId);
    });
    const dependents = this.dependents.get(id) || new Set();
    dependents.forEach((dependentId) => this.dependencies.get(dependentId)?.delete(id));
    this.dependencies.delete(id);
    this.dependents.delete(id);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setDefaultLengthUnit(unit = null) {
    this.defaultLengthUnit = unitFactors[unit] && unit !== 'deg' ? unit : null;
    this.markAllDirty();
    this.evaluateDirty({ strict: false });
  }

  setExternalVariables(entries = []) {
    this.externalVariables = new Map(
      (entries || [])
        .filter((entry) => entry?.name)
        .map((entry) => [entry.name, { ...entry }]),
    );
    this.markAllDirty();
    this.evaluateDirty({ strict: false });
  }

  emit() {
    const snapshot = this.list();
    this.listeners.forEach((listener) => listener(snapshot));
  }

  uniqueName(prefix, requested = '') {
    if (requested && !this.names.has(requested)) return requested;
    const counterKey = prefix === 'd'
      ? 'nextDimensionIndex'
      : prefix === 'c' ? 'nextControlIndex' : 'nextUserIndex';
    let name;
    do {
      name = `${prefix}${this[counterKey]}`;
      this[counterKey] += 1;
    } while (this.names.has(name));
    return name;
  }

  createUser({
    id = createStableId('parameter'),
    name = '',
    expression = '',
    prefix = 'p',
    kind = 'user',
    usesDrawingUnit = false,
  } = {}) {
    const entry = {
      id,
      name: this.uniqueName(prefix, name.trim()),
      expression: String(expression),
      value: 0,
      kind,
      driving: false,
      computed: false,
      unit: null,
      error: null,
      order: this.entries.size,
    };
    if (kind === 'control') entry.usesDrawingUnit = false;
    this.entries.set(id, entry);
    this.names.set(entry.name, id);
    this.markAllDirty();
    this.evaluateDirty({ strict: false });
    this.emit();
    return clone(entry);
  }

  createControl({
    id = createStableId('control-parameter'),
    name = '',
    expression = '',
    usesDrawingUnit = false,
  } = {}) {
    return this.createUser({
      id,
      name,
      expression,
      prefix: 'c',
      kind: 'control',
      usesDrawingUnit,
    });
  }

  addDimension({ id = createStableId('dimension'), name = '', expression, value = 0, driving = false, unit = 'mm', annotationId = null } = {}) {
    const entry = {
      id,
      name: this.uniqueName('d', name.trim()),
      expression: driving ? String(expression ?? value) : this.formatValue(value, unit),
      value: Number(value),
      kind: 'dimension',
      driving: Boolean(driving),
      computed: !driving,
      enabled: true,
      unit,
      annotationId,
      error: null,
      order: this.entries.size,
    };
    this.entries.set(id, entry);
    this.names.set(entry.name, id);
    this.markAllDirty();
    this.evaluateDirty({ strict: false });
    const evaluated = this.entries.get(id);
    if (evaluated.error) {
      const message = evaluated.error;
      this.entries.delete(id);
      this.names.delete(entry.name);
      this.compiledExpressions.delete(id);
      this.removeDependencyEdges(id);
      this.markAllDirty();
      this.evaluateDirty({ strict: false });
      throw new Error(message);
    }
    this.emit();
    return clone(evaluated);
  }

  setComputedResolver(id, resolver) {
    if (!this.entries.get(id)?.computed) return false;
    this.computedResolvers.set(id, resolver);
    this.markDirty(id);
    this.evaluateDirty({ strict: false });
    return true;
  }

  setEnabled(idOrName, enabled, { evaluate = true, emit = true } = {}) {
    const id = this.entries.has(idOrName) ? idOrName : this.names.get(idOrName);
    const entry = this.entries.get(id);
    if (entry?.kind !== 'dimension') return false;
    const next = Boolean(enabled);
    if ((entry.enabled !== false) === next) return false;
    entry.enabled = next;
    this.markDirty(id);
    if (evaluate) this.evaluateDirty({ strict: false });
    if (emit) this.emit();
    return true;
  }

  set({ id = createStableId('dimension'), name, expression, unit = 'mm' }) {
    if (!this.entries.has(id)) return this.addDimension({ id, name, expression, value: 0, driving: true, unit });
    return this.update(id, { name, expression, unit }, { strict: true });
  }

  update(id, patch, { strict = false } = {}) {
    const before = this.snapshotEntries(this.affectedIds(id));
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown parameter: ${id}`);
    if (entry.computed && patch.expression !== undefined) return clone(entry);
    const oldName = entry.name;
    let renamed = false;
    let validationError = null;
    const nextName = patch.name === undefined ? oldName : String(patch.name).trim();
    if (!nextName) {
      if (strict) throw new Error('Parameter name is required.');
      validationError = 'Parameter name is required.';
    } else {
      const duplicate = this.names.get(nextName);
      if (duplicate && duplicate !== id) {
        if (strict) throw new Error(`Parameter name already exists: ${nextName}`);
        validationError = `Parameter name already exists: ${nextName}`;
      } else if (nextName !== oldName) {
        renamed = true;
        this.names.delete(oldName);
        this.names.set(nextName, id);
        entry.name = nextName;
        this.entries.forEach((candidate) => {
          if (candidate.id !== id && !candidate.computed) candidate.expression = replaceReference(candidate.expression, oldName, nextName);
        });
      }
    }
    if (patch.expression !== undefined && !entry.computed) entry.expression = String(patch.expression);
    if (patch.unit !== undefined) entry.unit = patch.unit;
    if (patch.usesDrawingUnit !== undefined && entry.kind === 'control') {
      entry.usesDrawingUnit = false;
    }
    try {
      if (renamed) this.markAllDirty();
      else this.markDirty(id);
      this.evaluateDirty({ strict });
      if (validationError) this.entries.get(id).error = validationError;
    } catch (error) {
      this.restoreEntries(before, { emit: false });
      throw error;
    }
    this.emit();
    return this.get(id);
  }

  evaluateAll({ strict = true, refreshComputed = true } = {}) {
    this.markAllDirty();
    return this.evaluateDirty({ strict, refreshComputed });
  }

  evaluateDirty({ strict = true, refreshComputed = true, refreshComputedIds = null } = {}) {
    if (refreshComputed) {
      this.entries.forEach((entry, id) => {
        if (
          entry.computed
          && this.computedResolvers.has(id)
          && (!refreshComputedIds || refreshComputedIds.has(id))
        ) this.markDirty(id);
      });
    }
    const resolved = new Map();
    const visiting = new Set();
    const evaluate = (id) => {
      if (resolved.has(id)) return resolved.get(id);
      const entry = this.entries.get(id);
      if (!entry) throw new Error(`Unknown parameter: ${id}`);
      if (!this.dirtyEntries.has(id)) {
        if (entry.error) throw new Error(entry.error);
        resolved.set(id, entry.value);
        return entry.value;
      }
      entry.error = null;
      try {
        if (entry.kind === 'dimension' && entry.enabled === false) {
          resolved.set(id, entry.value);
          return entry.value;
        }
        if (entry.computed) {
          const resolver = this.computedResolvers.get(id);
          if (resolver && refreshComputed) {
            const computedValue = Number(resolver());
            if (!Number.isFinite(computedValue)) throw new Error(`${entry.name} measurement is not finite.`);
            entry.value = computedValue;
            entry.expression = this.formatValue(entry.value, entry.unit);
          }
          resolved.set(id, entry.value);
          return entry.value;
        }
        if (visiting.has(id)) throw new Error(`Dependency cycle detected at ${entry.name}.`);
        if (!entry.expression.trim()) throw new Error(`${entry.name} requires an expression.`);
        visiting.add(id);
        const useDrawingUnit = Boolean(this.defaultLengthUnit) && isLengthParameter(entry);
        const drawingUnitFactor = this.defaultLengthUnit ? unitFactors[this.defaultLengthUnit] : 1;
        const cached = this.compiledExpressions.get(id);
        const tokens = cached?.expression === entry.expression
          ? cached.tokens
          : tokenize(entry.expression);
        if (cached?.expression !== entry.expression) {
          this.compiledExpressions.set(id, {
            expression: entry.expression,
            tokens: Object.freeze(tokens.slice()),
          });
        }
        const nextDependencies = new Set();
        let raw;
        try {
          raw = evaluateTokens(tokens, (name) => {
            const dependencyId = this.names.get(name);
            if (!dependencyId) {
              const external = this.externalVariables.get(name);
              if (!external) throw new Error(`Unknown parameter: ${name}`);
              nextDependencies.add(external.id);
              const externalIsLength = typeof external.value === 'number'
                && external.unit && external.unit !== 'deg';
              return this.defaultLengthUnit && externalIsLength
                ? Number(external.value) / drawingUnitFactor
                : external.value;
            }
            nextDependencies.add(dependencyId);
            const dependency = this.entries.get(dependencyId);
            const dependencyValue = evaluate(dependencyId);
            const dependencyIsLength = typeof dependencyValue === 'number' && isLengthParameter(dependency);
            return this.defaultLengthUnit && dependencyIsLength
              ? Number(dependencyValue) / drawingUnitFactor
              : dependencyValue;
          }, { baseUnit: useDrawingUnit ? this.defaultLengthUnit : null });
        } finally {
          this.replaceDependencies(id, nextDependencies);
        }
        if (useDrawingUnit && typeof raw === 'number') raw *= drawingUnitFactor;
        const value = typeof raw === 'boolean' || typeof raw === 'string'
          ? raw
          : Number(raw);
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${entry.name} must evaluate to a finite number.`);
        entry.value = value;
        resolved.set(id, value);
        return value;
      } catch (error) {
        entry.error = error.message;
        throw error;
      } finally {
        visiting.delete(id);
        this.dirtyEntries.delete(id);
      }
    };
    for (const id of [...this.dirtyEntries]) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      try {
        evaluate(id);
      } catch (error) {
        visiting.clear();
        if (strict) throw error;
      }
    }
    return new Map(resolved);
  }

  setComputedValue(id, value, unit = null) {
    const entry = this.entries.get(id);
    if (!entry?.computed) return false;
    entry.value = Number(value);
    if (unit) entry.unit = unit;
    entry.expression = this.formatValue(entry.value, entry.unit);
    this.markDirty(id);
    this.evaluateDirty({ strict: false });
    this.emit();
    return true;
  }

  formatValue(value, unit = null) {
    return formatUnitValue(value, unit);
  }

  remove(id, { allowDimension = false } = {}) {
    const entry = this.entries.get(id);
    if (!entry || (entry.kind === 'dimension' && !allowDimension)) return false;
    this.names.delete(entry.name);
    this.computedResolvers.delete(id);
    this.compiledExpressions.delete(id);
    this.removeDependencyEdges(id);
    this.entries.delete(id);
    this.normalizeOrder();
    this.markAllDirty();
    this.evaluateDirty({ strict: false });
    this.emit();
    return true;
  }

  reorder(id, beforeId = null) {
    const ordered = this.list().filter((entry) => entry.id !== id);
    const moving = this.entries.get(id);
    if (!moving) return false;
    const index = beforeId ? ordered.findIndex((entry) => entry.id === beforeId) : ordered.length;
    ordered.splice(index < 0 ? ordered.length : index, 0, moving);
    ordered.forEach((entry, order) => { this.entries.get(entry.id).order = order; });
    this.emit();
    return true;
  }

  normalizeOrder() {
    this.list().forEach((entry, order) => { this.entries.get(entry.id).order = order; });
  }

  get(idOrName) {
    const id = this.entries.has(idOrName) ? idOrName : this.names.get(idOrName);
    return clone(this.entries.get(id));
  }

  value(idOrName) {
    const entry = this.get(idOrName);
    if (!entry) throw new Error(`Unknown parameter: ${idOrName}`);
    return entry.value;
  }

  evaluateExpression(expression) {
    return parseExpression(expression, (name) => {
      const id = this.names.get(name);
      const entry = id ? this.entries.get(id) : null;
      const external = this.externalVariables.get(name);
      if (!entry && !external) throw new Error(`Unknown parameter: ${name}`);
      if (!entry) {
        const externalIsLength = typeof external.value === 'number' && external.unit && external.unit !== 'deg';
        return this.defaultLengthUnit && externalIsLength
          ? Number(external.value) / drawingUnitFactor
          : external.value;
      }
      if (entry.error) throw new Error(entry.error);
      return entry.value;
    });
  }

  evaluateScalarExpression(expression) {
    if (!this.defaultLengthUnit) return this.evaluateExpression(expression);
    const drawingUnitFactor = unitFactors[this.defaultLengthUnit];
    return parseExpression(expression, (name) => {
      const id = this.names.get(name);
      const entry = id ? this.entries.get(id) : null;
      const external = this.externalVariables.get(name);
      if (!entry && !external) throw new Error(`Unknown parameter: ${name}`);
      if (!entry) {
        const externalIsLength = typeof external.value === 'number' && external.unit && external.unit !== 'deg';
        return this.defaultLengthUnit && externalIsLength
          ? Number(external.value) / drawingUnitFactor
          : external.value;
      }
      if (entry.error) throw new Error(entry.error);
      const entryIsLength = typeof entry.value === 'number' && isLengthParameter(entry);
      return entryIsLength ? Number(entry.value) / drawingUnitFactor : entry.value;
    });
  }

  evaluateLengthExpression(expression) {
    if (!this.defaultLengthUnit) return this.evaluateExpression(expression);
    const drawingUnitFactor = unitFactors[this.defaultLengthUnit];
    const value = parseExpression(expression, (name) => {
      const id = this.names.get(name);
      const entry = id ? this.entries.get(id) : null;
      const external = this.externalVariables.get(name);
      if (!entry && !external) throw new Error(`Unknown parameter: ${name}`);
      if (!entry) return external.value;
      if (entry.error) throw new Error(entry.error);
      const entryIsLength = typeof entry.value === 'number' && isLengthParameter(entry);
      return entryIsLength ? Number(entry.value) / drawingUnitFactor : entry.value;
    }, { baseUnit: this.defaultLengthUnit });
    return Number(value) * drawingUnitFactor;
  }

  list() {
    return [...this.entries.values()].sort((a, b) => a.order - b.order).map(clone);
  }

  snapshot() {
    return this.list();
  }

  snapshotEntries(ids = []) {
    return [...new Set(ids)]
      .map((id) => clone(this.entries.get(id)))
      .filter(Boolean);
  }

  restoreEntries(snapshot, { emit = true } = {}) {
    const restoredIds = new Set();
    (snapshot || []).forEach((item) => {
      if (!item?.id || !this.entries.has(item.id)) return;
      this.entries.set(item.id, { ...item });
      this.compiledExpressions.delete(item.id);
      restoredIds.add(item.id);
    });
    this.names.clear();
    this.entries.forEach((entry, id) => this.names.set(entry.name, id));
    this.dependencies.clear();
    this.dependents.clear();
    this.dirtyEntries.clear();
    this.markAllDirty();
    this.evaluateDirty({ strict: false, refreshComputed: false });
    if (emit) this.emit();
    return restoredIds;
  }

  restore(snapshot, { emit = true } = {}) {
    this.entries.clear();
    this.names.clear();
    this.computedResolvers.clear();
    this.compiledExpressions.clear();
    this.dependencies.clear();
    this.dependents.clear();
    this.dirtyEntries.clear();
    this.nextUserIndex = 1;
    this.nextDimensionIndex = 1;
    this.nextControlIndex = 1;
    (snapshot || []).forEach((item, order) => {
      const entry = { ...item, order: item.order ?? order };
      delete entry.type;
      if (entry.kind === 'control') entry.usesDrawingUnit = false;
      if (entry.kind === 'dimension') entry.enabled = entry.enabled !== false;
      this.entries.set(entry.id, entry);
      this.names.set(entry.name, entry.id);
      const dimensionMatch = /^d(\d+)$/i.exec(entry.name);
      const userMatch = /^p(\d+)$/i.exec(entry.name);
      const controlMatch = /^c(\d+)$/i.exec(entry.name);
      if (dimensionMatch) this.nextDimensionIndex = Math.max(this.nextDimensionIndex, Number(dimensionMatch[1]) + 1);
      if (userMatch) this.nextUserIndex = Math.max(this.nextUserIndex, Number(userMatch[1]) + 1);
      if (controlMatch) this.nextControlIndex = Math.max(this.nextControlIndex, Number(controlMatch[1]) + 1);
    });
    this.markAllDirty();
    if (emit) this.emit();
  }

  clear() {
    this.entries.clear();
    this.names.clear();
    this.computedResolvers.clear();
    this.compiledExpressions.clear();
    this.dependencies.clear();
    this.dependents.clear();
    this.dirtyEntries.clear();
    this.nextUserIndex = 1;
    this.nextDimensionIndex = 1;
    this.nextControlIndex = 1;
    this.emit();
  }
}

export { parseExpression };
