import { createUuid } from '../IdentitySystem.js';
import { formatUnitValue, unitFactors } from './Units.js';
import {
  defaultStackId as resolveDefaultStackId,
  normalizeStackArchitectureState,
} from '../StackArchitecture.js';
import {
  dimensionCollectionNameError,
  dimensionParameterIndex,
  nextIndexedParameterName,
  parameterNameError,
  parameterNameKey,
  qualifiedDimensionName,
  replaceExpressionSymbolReference,
  rewriteExpressionSymbolReferences,
  userParameterNameError,
} from '../NamingSystem.js';

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

function expressionSymbolBoundary(character) {
  return character === undefined || /\s|[()+\-*/^!,<>=&|]/.test(character);
}

function normalizedSymbols(symbols = []) {
  return [...symbols]
    .filter((symbol) => symbol?.name)
    .sort((first, second) => second.name.length - first.name.length);
}

function tokenize(expression, { symbols = [] } = {}) {
  const source = String(expression).trim();
  if (UNQUOTED_IMAGE_REFERENCE.test(source)) return [JSON.stringify(source)];
  const tokens = [];
  const candidates = normalizedSymbols(symbols);
  const pattern = /(>=|<=|==|!=|&&|\|\||"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\d+(?:\.\d+)?(?:e[+-]?\d+)?|d\d+@[A-Za-z_][A-Za-z0-9_]*(?:\s+[A-Za-z_][A-Za-z0-9_]*)*|[A-Za-z_][A-Za-z0-9_]*|[()+\-*/^!,<>])/iy;
  let index = 0;
  while (index < source.length) {
    while (/\s/.test(source[index] || '')) index += 1;
    if (index >= source.length) break;
    const matchedSymbol = candidates.find((symbol) => {
      const candidate = source.slice(index, index + symbol.name.length);
      const matches = symbol.caseInsensitive
        ? candidate.toLocaleLowerCase() === symbol.name.toLocaleLowerCase()
        : candidate === symbol.name;
      return matches && expressionSymbolBoundary(source[index + symbol.name.length]);
    });
    if (matchedSymbol) {
      tokens.push(source.slice(index, index + matchedSymbol.name.length));
      index += matchedSymbol.name.length;
      continue;
    }
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (!match) throw new Error(`Invalid expression near: ${source.slice(index)}`);
    tokens.push(match[1]);
    index = pattern.lastIndex;
  }
  return tokens;
}

export function expressionSymbolReferences(expression, symbols = []) {
  const candidates = normalizedSymbols(symbols);
  const tokens = tokenize(expression, { symbols: candidates });
  const references = [];
  const seen = new Set();
  tokens.forEach((token) => {
    const symbol = candidates.find((candidate) => (
      candidate.caseInsensitive
        ? token.toLocaleLowerCase() === candidate.name.toLocaleLowerCase()
        : token === candidate.name
    ));
    if (!symbol) return;
    const key = symbol.parameterId || symbol.symbolKey || `${symbol.caseInsensitive ? 'i' : 's'}:${symbol.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    references.push({ ...symbol });
  });
  return references;
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
  return evaluateTokens(tokenize(source, options), resolveName, options);
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
    this.dimensionNamesByStack = new Map();
    this.nextDimensionIndexByStack = new Map();
    this.stackState = normalizeStackArchitectureState();
    this.stackNamesById = new Map();
    this.stackIdsByName = new Map();
    this.externalVariables = new Map();
    this.listeners = new Set();
    this.computedResolvers = new Map();
    this.compiledExpressions = new Map();
    this.dependencies = new Map();
    this.dependents = new Map();
    this.dirtyEntries = new Set();
    this.nextUserIndex = 1;
    this.nextControlIndex = 1;
    this.defaultLengthUnit = null;
    this.enabledStackIds = null;
    this.rebuildStackIndexes();
  }

  rebuildStackIndexes() {
    this.stackNamesById = new Map(this.stackState.stacks.map((stack) => [stack.id, stack.name]));
    this.stackIdsByName = new Map(this.stackState.stacks.map((stack) => [stack.name.toLocaleLowerCase(), stack.id]));
  }

  defaultStackId() {
    return resolveDefaultStackId(this.stackState);
  }

  isEntryAvailable(entry) {
    return this.isEntryAvailableForStackIds(entry, this.enabledStackIds);
  }

  isEntryAvailableForStackIds(entry, enabledStackIds) {
    return entry?.kind !== 'dimension'
      || enabledStackIds === null
      || [
        entry.stackId || this.defaultStackId(),
        ...(entry.participantStackIds || []),
      ].every((stackId) => enabledStackIds.has(stackId));
  }

  unavailableStackId(entry) {
    if (entry?.kind !== 'dimension' || this.enabledStackIds === null) return null;
    return [
      entry.stackId || this.defaultStackId(),
      ...(entry.participantStackIds || []),
    ].find((stackId) => !this.enabledStackIds.has(stackId)) || null;
  }

  computedDependencyIds(entryIds = []) {
    const result = new Set();
    const visited = new Set();
    const pending = [...new Set(entryIds || [])];
    while (pending.length) {
      const id = pending.pop();
      if (!id || visited.has(id)) continue;
      visited.add(id);
      const entry = this.entries.get(id);
      if (entry?.computed && this.isEntryAvailable(entry)) result.add(id);
      this.dependencies.get(id)?.forEach((dependencyId) => {
        if (this.entries.has(dependencyId)) pending.push(dependencyId);
      });
    }
    return result;
  }

  assertEntryAvailable(entry, referencedName = entry?.name) {
    if (this.isEntryAvailable(entry)) return;
    const stackId = this.unavailableStackId(entry) || entry.stackId || this.defaultStackId();
    const stackName = this.stackNamesById.get(stackId) || stackId;
    throw new Error(`Dimension ${this.qualifiedName(entry) || referencedName} is unavailable because Stack "${stackName}" is disabled.`);
  }

  setEnabledStackIds(stackIds = null, { emit = true } = {}) {
    const next = stackIds === null ? null : new Set([...stackIds].map(String));
    const changed = [...this.entries.values()].some((entry) => (
      entry.kind === 'dimension'
      && this.isEntryAvailableForStackIds(entry, this.enabledStackIds)
        !== this.isEntryAvailableForStackIds(entry, next)
    ));
    this.enabledStackIds = next;
    if (!changed) return false;
    this.entries.forEach((entry) => {
      if (entry.kind === 'dimension') this.markDirty(entry.id);
    });
    this.evaluateDirty({ strict: false });
    if (emit) this.emit();
    return true;
  }

  rebuildNameIndexes() {
    const collectionError = dimensionCollectionNameError([...this.entries.values()], {
      defaultStackId: this.defaultStackId(),
    });
    if (collectionError) throw new Error(collectionError);
    this.names.clear();
    this.dimensionNamesByStack.clear();
    this.nextDimensionIndexByStack.clear();
    this.entries.forEach((entry, id) => {
      if (entry.kind !== 'dimension') {
        this.names.set(entry.name, id);
        return;
      }
      const stackId = entry.stackId || this.defaultStackId();
      entry.stackId = stackId;
      if (!this.dimensionNamesByStack.has(stackId)) this.dimensionNamesByStack.set(stackId, new Map());
      const dimensionIndex = dimensionParameterIndex(entry.name);
      const dimensionNames = this.dimensionNamesByStack.get(stackId);
      const nameKey = parameterNameKey(entry.name, 'dimension');
      dimensionNames.set(nameKey, id);
      const next = dimensionIndex + 1;
      this.nextDimensionIndexByStack.set(stackId, Math.max(this.nextDimensionIndexByStack.get(stackId) || 1, next));
    });
  }

  dimensionNameMap(stackId = null) {
    stackId ||= this.defaultStackId();
    if (!this.dimensionNamesByStack.has(stackId)) this.dimensionNamesByStack.set(stackId, new Map());
    return this.dimensionNamesByStack.get(stackId);
  }

  qualifiedName(entry) {
    if (entry?.kind !== 'dimension') return String(entry?.name || '');
    const stackId = entry.stackId || this.defaultStackId();
    const stackName = this.stackNamesById.get(stackId) || stackId;
    return qualifiedDimensionName(entry.name, stackName);
  }

  symbolDefinitions(stackId = null) {
    const symbols = [];
    this.entries.forEach((entry) => {
      if (entry.kind !== 'dimension') {
        symbols.push({ name: entry.name, id: entry.id, caseInsensitive: false });
        return;
      }
      symbols.push({ name: this.qualifiedName(entry), id: entry.id, caseInsensitive: true });
      if (stackId && entry.stackId === stackId) {
        symbols.push({ name: entry.name, id: entry.id, caseInsensitive: true });
      }
    });
    this.externalVariables.forEach((entry) => symbols.push({ name: entry.name, symbolKey: entry.symbolKey, caseInsensitive: false }));
    return normalizedSymbols(symbols);
  }

  expressionSymbols({ stackId = null, includeLocalAliases = false } = {}) {
    const symbols = [];
    this.entries.forEach((entry) => {
      if (entry.kind !== 'dimension') {
        symbols.push({ name: entry.name, parameterId: entry.id, kind: entry.kind });
        return;
      }
      symbols.push({
        name: this.qualifiedName(entry),
        parameterId: entry.id,
        kind: entry.kind,
        stackId: entry.stackId,
        local: entry.stackId === stackId,
      });
      if (includeLocalAliases && stackId && entry.stackId === stackId) {
        symbols.push({
          name: entry.name,
          parameterId: entry.id,
          kind: entry.kind,
          stackId: entry.stackId,
          local: true,
          alias: true,
        });
      }
    });
    this.externalVariables.forEach((entry) => symbols.push({
      name: entry.name,
      symbolKey: entry.symbolKey,
      kind: 'external',
    }));
    return symbols.sort((first, second) => first.name.localeCompare(second.name, undefined, { numeric: true }));
  }

  expressionEntries(options = {}) {
    return this.expressionSymbols(options).map((symbol) => {
      const entry = this.entries.get(symbol.parameterId) || this.externalVariables.get(symbol.name);
      return entry ? { ...entry, name: symbol.name, alias: Boolean(symbol.alias) } : null;
    }).filter(Boolean);
  }

  idForName(name, { stackId = null, allowUniqueDimension = true } = {}) {
    if (this.entries.has(name)) return name;
    const globalId = this.names.get(name);
    if (globalId) return globalId;
    const text = String(name ?? '');
    const at = text.indexOf('@');
    if (at > 0) {
      const localName = parameterNameKey(text.slice(0, at), 'dimension');
      const referencedStackId = this.stackIdsByName.get(text.slice(at + 1).toLocaleLowerCase());
      return referencedStackId ? this.dimensionNameMap(referencedStackId).get(localName) : undefined;
    }
    if (stackId) {
      const localId = this.dimensionNameMap(stackId).get(parameterNameKey(text, 'dimension'));
      if (localId) return localId;
    }
    if (!allowUniqueDimension) return undefined;
    const matches = [...this.dimensionNamesByStack.values()]
      .map((names) => names.get(parameterNameKey(text, 'dimension')))
      .filter(Boolean);
    return matches.length === 1 ? matches[0] : undefined;
  }

  setStackState(value, { rewriteExpressions = true, emit = true } = {}) {
    const previousNames = new Map(this.stackNamesById);
    this.stackState = normalizeStackArchitectureState(value);
    this.rebuildStackIndexes();
    if (rewriteExpressions) {
      const renames = [];
      this.entries.forEach((entry) => {
        if (entry.kind !== 'dimension') return;
        const beforeStackName = previousNames.get(entry.stackId);
        const afterStackName = this.stackNamesById.get(entry.stackId);
        if (!beforeStackName || !afterStackName || beforeStackName === afterStackName) return;
        renames.push({
          before: qualifiedDimensionName(entry.name, beforeStackName),
          after: qualifiedDimensionName(entry.name, afterStackName),
        });
      });
      if (renames.length) {
        this.entries.forEach((entry) => {
          if (entry.computed) return;
          entry.expression = rewriteExpressionSymbolReferences(entry.expression, renames, { caseInsensitive: true });
          this.compiledExpressions.delete(entry.id);
        });
      }
    }
    this.markAllDirty();
    this.evaluateDirty({ strict: false });
    if (emit) this.emit();
    return clone(this.stackState);
  }

  updateDimensionScope(id, {
    stackId = null,
    participantStackIds = [],
    emit = true,
  } = {}) {
    const entry = this.entries.get(id);
    if (entry?.kind !== 'dimension') return null;
    stackId ||= this.defaultStackId();
    const previousStackId = entry.stackId || this.defaultStackId();
    const previousName = entry.name;
    const previousQualifiedName = this.qualifiedName(entry);
    if (previousStackId !== stackId) {
      this.dimensionNameMap(previousStackId).delete(parameterNameKey(previousName, 'dimension'));
      entry.stackId = stackId;
      entry.name = this.uniqueName('d', previousName, { stackId });
      this.dimensionNameMap(stackId).set(parameterNameKey(entry.name, 'dimension'), id);
      const nextQualifiedName = this.qualifiedName(entry);
      this.entries.forEach((candidate) => {
        if (candidate.computed) return;
        const knownNames = this.symbolDefinitions(candidate.kind === 'dimension' ? candidate.stackId : null)
          .map(({ name }) => name);
        candidate.expression = replaceExpressionSymbolReference(
          candidate.expression,
          previousQualifiedName,
          nextQualifiedName,
          { caseInsensitive: true, knownNames },
        );
        if (candidate.id !== id && candidate.kind === 'dimension' && candidate.stackId === previousStackId) {
          candidate.expression = replaceExpressionSymbolReference(
            candidate.expression,
            previousName,
            nextQualifiedName,
            { caseInsensitive: true, knownNames },
          );
        }
        this.compiledExpressions.delete(candidate.id);
      });
    }
    entry.participantStackIds = [...new Set(participantStackIds || [])]
      .filter((participantId) => participantId && participantId !== stackId);
    this.markAllDirty();
    this.evaluateDirty({ strict: false });
    if (emit) this.emit();
    return clone(entry);
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
    const id = this.idForName(idOrName);
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
    const next = new Map(
      (entries || [])
        .filter((entry) => entry?.name)
        .map((entry) => [entry.name, { ...entry }]),
    );
    const unchanged = JSON.stringify([...this.externalVariables].map(([name, entry]) => [name, entry.value, entry.unit]))
      === JSON.stringify([...next].map(([name, entry]) => [name, entry.value, entry.unit]));
    this.externalVariables = next;
    if (unchanged) return;
    this.markAllDirty();
    this.evaluateDirty({ strict: false });
  }

  referencesExternalVariables(names = []) {
    const externalIds = new Set(names
      .map((name) => this.externalVariables.get(name)?.symbolKey)
      .filter(Boolean));
    if (!externalIds.size) return false;
    return [...this.dependencies.values()].some((dependencies) => (
      [...dependencies].some((dependencyId) => externalIds.has(dependencyId))
    ));
  }

  emit() {
    const snapshot = this.list();
    this.listeners.forEach((listener) => listener(snapshot));
  }

  uniqueName(prefix, requested = '', { stackId = null, sequential = false } = {}) {
    stackId ||= this.defaultStackId();
    const dimensionNames = prefix === 'd' ? this.dimensionNameMap(stackId) : null;
    if (!sequential
      && requested
      && !(dimensionNames ? dimensionNames.has(parameterNameKey(requested, 'dimension')) : this.names.has(requested))) return requested;
    const counterKey = prefix === 'c' ? 'nextControlIndex' : 'nextUserIndex';
    const nextIndex = prefix === 'd'
      ? (sequential ? 1 : (this.nextDimensionIndexByStack.get(stackId) || 1))
      : this[counterKey];
    const names = dimensionNames || this.names;
    const name = nextIndexedParameterName(prefix, names, {
      caseInsensitive: prefix === 'd',
      startIndex: nextIndex,
    });
    const followingIndex = Number(name.slice(prefix.length)) + 1;
    if (prefix === 'd') {
      this.nextDimensionIndexByStack.set(stackId, followingIndex);
    } else {
      this[counterKey] = followingIndex;
    }
    return name;
  }

  createUser({
    id = createUuid(),
    name = '',
    expression = '',
    prefix = 'p',
    kind = 'user',
    usesDrawingUnit = false,
  } = {}) {
    const requestedName = String(name).trim().replace(/\s+/g, ' ');
    const nameError = requestedName ? userParameterNameError(requestedName) : null;
    if (nameError) throw new Error(nameError);
    const entry = {
      id,
      name: this.uniqueName(prefix, requestedName),
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
    this.compiledExpressions.clear();
    this.markAllDirty();
    this.evaluateDirty({ strict: false });
    this.emit();
    return clone(entry);
  }

  createControl({
    id = createUuid(),
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

  addDimension({
    id = createUuid(),
    name = '',
    expression,
    value = 0,
    driving = false,
    unit = 'mm',
    annotationId = null,
    stackId = null,
    participantStackIds = [],
  } = {}) {
    stackId ||= this.defaultStackId();
    const requestedName = String(name).trim().replace(/\s+/g, ' ');
    const nameError = requestedName ? parameterNameError(requestedName, 'dimension') : null;
    if (nameError) throw new Error(nameError);
    const entry = {
      id,
      name: this.uniqueName('d', requestedName, { stackId, sequential: true }),
      expression: driving ? String(expression ?? value) : this.formatValue(value, unit),
      value: Number(value),
      kind: 'dimension',
      driving: Boolean(driving),
      computed: !driving,
      enabled: true,
      unit,
      annotationId,
      stackId,
      participantStackIds: [...new Set(participantStackIds || [])].filter((id) => id && id !== stackId),
      error: null,
      order: this.entries.size,
    };
    this.entries.set(id, entry);
    this.dimensionNameMap(stackId).set(parameterNameKey(entry.name, 'dimension'), id);
    this.compiledExpressions.clear();
    this.markAllDirty();
    this.evaluateDirty({ strict: false });
    const evaluated = this.entries.get(id);
    if (evaluated.error) {
      const message = evaluated.error;
      this.entries.delete(id);
      this.dimensionNameMap(stackId).delete(parameterNameKey(entry.name, 'dimension'));
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
    const id = this.idForName(idOrName);
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

  set(input = {}) {
    const id = input.id || createUuid();
    if (!this.entries.has(id)) return this.addDimension({ ...input, id, value: input.value ?? 0, driving: true });
    return this.update(id, { name: input.name, expression: input.expression, unit: input.unit }, { strict: true });
  }

  update(id, patch, { strict = false } = {}) {
    const before = this.snapshotEntries(this.affectedIds(id));
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown parameter: ${id}`);
    if (entry.computed && patch.expression !== undefined) return clone(entry);
    const oldName = entry.name;
    let renamed = false;
    let validationError = null;
    const nextName = patch.name === undefined ? oldName : String(patch.name).trim().replace(/\s+/g, ' ');
    if (!nextName) {
      if (strict) throw new Error('Parameter name is required.');
      validationError = 'Parameter name is required.';
    } else {
      const nameError = parameterNameError(nextName, entry.kind);
      if (nameError) {
        if (strict) throw new Error(nameError);
        validationError = nameError;
      }
      const duplicate = nameError ? null : entry.kind === 'dimension'
        ? this.dimensionNameMap(entry.stackId || this.defaultStackId()).get(parameterNameKey(nextName, 'dimension'))
        : this.names.get(nextName);
      if (!nameError && duplicate && duplicate !== id) {
        if (strict) throw new Error(`Parameter name already exists: ${nextName}`);
        validationError = `Parameter name already exists: ${nextName}`;
      } else if (!nameError && nextName !== oldName) {
        renamed = true;
        const oldQualifiedName = entry.kind === 'dimension' ? this.qualifiedName(entry) : null;
        if (entry.kind === 'dimension') {
          this.dimensionNameMap(entry.stackId || this.defaultStackId()).delete(parameterNameKey(oldName, 'dimension'));
          this.dimensionNameMap(entry.stackId || this.defaultStackId()).set(parameterNameKey(nextName, 'dimension'), id);
        } else {
          this.names.delete(oldName);
          this.names.set(nextName, id);
        }
        entry.name = nextName;
        this.entries.forEach((candidate) => {
          if (candidate.id === id || candidate.computed) return;
          const knownNames = this.symbolDefinitions(candidate.kind === 'dimension' ? candidate.stackId : null)
            .map(({ name }) => name);
          if (entry.kind === 'dimension') {
            candidate.expression = replaceExpressionSymbolReference(
              candidate.expression,
              oldQualifiedName,
              this.qualifiedName(entry),
              { caseInsensitive: true, knownNames },
            );
            if (candidate.kind === 'dimension' && candidate.stackId === entry.stackId) {
              candidate.expression = replaceExpressionSymbolReference(
                candidate.expression,
                oldName,
                nextName,
                { caseInsensitive: true, knownNames },
              );
            }
          } else {
            candidate.expression = replaceExpressionSymbolReference(candidate.expression, oldName, nextName, { knownNames });
          }
          this.compiledExpressions.delete(candidate.id);
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
    const requestedComputedIds = refreshComputedIds === null
      ? null
      : new Set(refreshComputedIds);
    if (refreshComputed) {
      this.entries.forEach((entry, id) => {
        if (
          entry.computed
          && this.isEntryAvailable(entry)
          && this.computedResolvers.has(id)
          && (requestedComputedIds === null || requestedComputedIds.has(id))
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
        const contextStackId = entry.kind === 'dimension' ? (entry.stackId || this.defaultStackId()) : null;
        const symbols = this.symbolDefinitions(contextStackId);
        const symbolKey = symbols.map((symbol) => `${symbol.caseInsensitive ? 'i' : 's'}:${symbol.name}`).join('\u0000');
        const cached = this.compiledExpressions.get(id);
        const tokens = cached?.expression === entry.expression && cached?.symbolKey === symbolKey
          ? cached.tokens
          : tokenize(entry.expression, { symbols });
        if (cached?.expression !== entry.expression || cached?.symbolKey !== symbolKey) {
          this.compiledExpressions.set(id, {
            expression: entry.expression,
            symbolKey,
            tokens: Object.freeze(tokens.slice()),
          });
        }
        const nextDependencies = new Set();
        let raw;
        try {
          raw = evaluateTokens(tokens, (name) => {
            const dependencyId = this.idForName(name, {
              stackId: contextStackId,
              allowUniqueDimension: false,
            });
            if (!dependencyId) {
              const external = this.externalVariables.get(name);
              if (!external) throw new Error(`Unknown parameter: ${name}`);
              nextDependencies.add(external.symbolKey);
              const externalIsLength = typeof external.value === 'number'
                && external.unit && external.unit !== 'deg';
              return this.defaultLengthUnit && externalIsLength
                ? Number(external.value) / drawingUnitFactor
                : external.value;
            }
            nextDependencies.add(dependencyId);
            const dependency = this.entries.get(dependencyId);
            this.assertEntryAvailable(dependency, name);
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
      if (!this.isEntryAvailable(entry)) {
        this.dirtyEntries.delete(id);
        continue;
      }
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
    if (!entry?.computed || !this.isEntryAvailable(entry)) return false;
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

  removeMany(ids = [], { allowDimension = false } = {}) {
    const removedIds = [];
    [...new Set(ids)].forEach((id) => {
      const entry = this.entries.get(id);
      if (!entry || (entry.kind === 'dimension' && !allowDimension)) return;
      if (entry.kind === 'dimension') {
        this.dimensionNameMap(entry.stackId || this.defaultStackId()).delete(parameterNameKey(entry.name, 'dimension'));
      } else {
        this.names.delete(entry.name);
      }
      this.computedResolvers.delete(id);
      this.compiledExpressions.delete(id);
      this.removeDependencyEdges(id);
      this.entries.delete(id);
      removedIds.push(id);
    });
    if (!removedIds.length) return [];
    this.normalizeOrder();
    this.markAllDirty();
    this.evaluateDirty({ strict: false });
    this.emit();
    return removedIds;
  }

  remove(id, options = {}) {
    return this.removeMany([id], options).length > 0;
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
    const id = this.idForName(idOrName);
    return clone(this.entries.get(id));
  }

  value(idOrName) {
    const entry = this.get(idOrName);
    if (!entry) throw new Error(`Unknown parameter: ${idOrName}`);
    return entry.value;
  }

  evaluateExpression(expression, { stackId = null } = {}) {
    const symbols = this.symbolDefinitions(stackId);
    const drawingUnitFactor = this.defaultLengthUnit ? unitFactors[this.defaultLengthUnit] : 1;
    return parseExpression(expression, (name) => {
      const id = this.idForName(name, { stackId, allowUniqueDimension: false });
      const entry = id ? this.entries.get(id) : null;
      const external = this.externalVariables.get(name);
      if (!entry && !external) throw new Error(`Unknown parameter: ${name}`);
      if (!entry) {
        const externalIsLength = typeof external.value === 'number' && external.unit && external.unit !== 'deg';
        return this.defaultLengthUnit && externalIsLength
          ? Number(external.value) / drawingUnitFactor
          : external.value;
      }
      this.assertEntryAvailable(entry, name);
      if (entry.error) throw new Error(entry.error);
      return entry.value;
    }, { symbols });
  }

  evaluateScalarExpression(expression, { stackId = null } = {}) {
    if (!this.defaultLengthUnit) return this.evaluateExpression(expression, { stackId });
    const drawingUnitFactor = unitFactors[this.defaultLengthUnit];
    const symbols = this.symbolDefinitions(stackId);
    return parseExpression(expression, (name) => {
      const id = this.idForName(name, { stackId, allowUniqueDimension: false });
      const entry = id ? this.entries.get(id) : null;
      const external = this.externalVariables.get(name);
      if (!entry && !external) throw new Error(`Unknown parameter: ${name}`);
      if (!entry) {
        const externalIsLength = typeof external.value === 'number' && external.unit && external.unit !== 'deg';
        return this.defaultLengthUnit && externalIsLength
          ? Number(external.value) / drawingUnitFactor
          : external.value;
      }
      this.assertEntryAvailable(entry, name);
      if (entry.error) throw new Error(entry.error);
      const entryIsLength = typeof entry.value === 'number' && isLengthParameter(entry);
      return entryIsLength ? Number(entry.value) / drawingUnitFactor : entry.value;
    }, { symbols });
  }

  evaluateLengthExpression(expression, { stackId = null } = {}) {
    const finiteLength = (value) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) throw new Error('Length expression must evaluate to a finite number.');
      return numeric;
    };
    if (!this.defaultLengthUnit) return finiteLength(this.evaluateExpression(expression, { stackId }));
    const drawingUnitFactor = unitFactors[this.defaultLengthUnit];
    const symbols = this.symbolDefinitions(stackId);
    const value = parseExpression(expression, (name) => {
      const id = this.idForName(name, { stackId, allowUniqueDimension: false });
      const entry = id ? this.entries.get(id) : null;
      const external = this.externalVariables.get(name);
      if (!entry && !external) throw new Error(`Unknown parameter: ${name}`);
      if (!entry) return external.value;
      this.assertEntryAvailable(entry, name);
      if (entry.error) throw new Error(entry.error);
      const entryIsLength = typeof entry.value === 'number' && isLengthParameter(entry);
      return entryIsLength ? Number(entry.value) / drawingUnitFactor : entry.value;
    }, { baseUnit: this.defaultLengthUnit, symbols });
    return finiteLength(value) * drawingUnitFactor;
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
    this.rebuildNameIndexes();
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
    this.dimensionNamesByStack.clear();
    this.nextDimensionIndexByStack.clear();
    this.computedResolvers.clear();
    this.compiledExpressions.clear();
    this.dependencies.clear();
    this.dependents.clear();
    this.dirtyEntries.clear();
    this.nextUserIndex = 1;
    this.nextControlIndex = 1;
    (snapshot || []).forEach((item, order) => {
      const entry = { ...item, order: item.order ?? order };
      delete entry.type;
      if (entry.kind === 'control') entry.usesDrawingUnit = false;
      if (entry.kind === 'dimension') {
        entry.enabled = entry.enabled !== false;
        entry.stackId = entry.stackId || this.defaultStackId();
        entry.participantStackIds = [...new Set(entry.participantStackIds || [])]
          .filter((stackId) => stackId && stackId !== entry.stackId);
      }
      this.entries.set(entry.id, entry);
      const userMatch = /^p(\d+)$/i.exec(entry.name);
      const controlMatch = /^c(\d+)$/i.exec(entry.name);
      if (userMatch) this.nextUserIndex = Math.max(this.nextUserIndex, Number(userMatch[1]) + 1);
      if (controlMatch) this.nextControlIndex = Math.max(this.nextControlIndex, Number(controlMatch[1]) + 1);
    });
    this.rebuildNameIndexes();
    this.markAllDirty();
    if (emit) this.emit();
  }

  clear() {
    this.entries.clear();
    this.names.clear();
    this.dimensionNamesByStack.clear();
    this.nextDimensionIndexByStack.clear();
    this.computedResolvers.clear();
    this.compiledExpressions.clear();
    this.dependencies.clear();
    this.dependents.clear();
    this.dirtyEntries.clear();
    this.nextUserIndex = 1;
    this.nextControlIndex = 1;
    this.enabledStackIds = null;
    this.stackState = normalizeStackArchitectureState();
    this.rebuildStackIndexes();
    this.emit();
  }
}

export { parseExpression };
