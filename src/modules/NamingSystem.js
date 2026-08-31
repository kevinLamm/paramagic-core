const RESERVED_STACK_NAME_CHARACTERS = /[@+\-*/^=<>!,&|]/;
const RESERVED_PARAMETER_NAME_CHARACTERS = /[@()+\-*/^=<>!,&|]/;
const DIMENSION_PARAMETER_NAME = /^d[1-9]\d*$/i;

export function normalizedNameWhitespace(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

export function stackNameError(value) {
  const name = normalizedNameWhitespace(value);
  if (!name) return 'Stack name is required.';
  if (RESERVED_STACK_NAME_CHARACTERS.test(name)) {
    return 'Stack names cannot contain @ or expression operators.';
  }
  return null;
}

export function normalizedStackName(value, fallback = 'Stack') {
  const name = normalizedNameWhitespace(value);
  return name || normalizedNameWhitespace(fallback) || 'Stack';
}

export function uniqueStackName(requested, stacks = [], { excludeId = null, fallback = 'Stack' } = {}) {
  const base = normalizedStackName(requested, fallback);
  const used = new Set((stacks || [])
    .filter((stack) => stack?.id !== excludeId)
    .map((stack) => normalizedStackName(stack?.name, '').toLocaleLowerCase()));
  if (!used.has(base.toLocaleLowerCase())) return base;
  let index = 1;
  while (used.has(`${base}(${index})`.toLocaleLowerCase())) index += 1;
  return `${base}(${index})`;
}

export function userParameterNameError(value) {
  const name = normalizedNameWhitespace(value);
  if (!name) return 'Parameter name is required.';
  if (RESERVED_PARAMETER_NAME_CHARACTERS.test(name)) {
    return 'Parameter names cannot contain @, parentheses, commas, or expression operators.';
  }
  if (/^\d/.test(name)) return 'Parameter names cannot start with a number.';
  return null;
}

export function dimensionParameterNameError(value) {
  const name = normalizedNameWhitespace(value);
  if (!name) return 'Dimension name is required.';
  if (!DIMENSION_PARAMETER_NAME.test(name)) return 'Dimension names must use the d1, d2, d3 naming convention.';
  return null;
}

export function dimensionParameterIndex(value) {
  const match = DIMENSION_PARAMETER_NAME.exec(normalizedNameWhitespace(value));
  return match ? Number(match[0].slice(1)) : null;
}

export function parameterNameError(value, kind = 'user') {
  return kind === 'dimension' ? dimensionParameterNameError(value) : userParameterNameError(value);
}

export function parameterNameKey(value, kind = 'user') {
  const name = normalizedNameWhitespace(value);
  return kind === 'dimension' ? name.toLocaleLowerCase() : name;
}

export function dimensionCollectionNameError(parameters = [], { defaultStackId = null } = {}) {
  const usedNamesByStack = new Map();
  for (const parameter of parameters || []) {
    if (parameter?.kind !== 'dimension') continue;
    const nameError = dimensionParameterNameError(parameter.name);
    if (nameError) return nameError;
    const stackId = parameter.stackId || defaultStackId;
    if (!usedNamesByStack.has(stackId)) usedNamesByStack.set(stackId, new Set());
    const usedNames = usedNamesByStack.get(stackId);
    const nameKey = parameterNameKey(parameter.name, 'dimension');
    if (usedNames.has(nameKey)) return `Dimension name already exists in Stack: ${parameter.name}`;
    usedNames.add(nameKey);
  }
  return null;
}

export function qualifiedDimensionName(name, stackName) {
  return `${normalizedNameWhitespace(name)}@${normalizedStackName(stackName)}`;
}

export function stackNameById(stackState = null) {
  return new Map((stackState?.stacks || []).map((stack) => [stack.id, stack.name]));
}

export function dimensionDisplayName(entry, stackState = null) {
  if (entry?.kind !== 'dimension' || !entry?.stackId) return String(entry?.name || '');
  const stackName = stackNameById(stackState).get(entry.stackId);
  return stackName ? qualifiedDimensionName(entry.name, stackName) : String(entry.name || '');
}

export function replaceExpressionSymbolReference(expression, oldName, nextName, options = {}) {
  const { caseInsensitive = false } = options;
  return rewriteExpressionSymbolReferences(expression, [{
    before: oldName,
    after: nextName,
    caseInsensitive,
  }], options);
}

export function rewriteExpressionSymbolReferences(expression, renames = [], options = {}) {
  const activeRenames = (renames || [])
    .map((rename) => ({
      before: String(rename?.before || ''),
      after: String(rename?.after || ''),
      caseInsensitive: rename?.caseInsensitive ?? options.caseInsensitive,
    }))
    .filter(({ before, after }) => before && before !== after);
  if (!activeRenames.length) return String(expression ?? '');
  const caseInsensitive = options.caseInsensitive ?? activeRenames.every((rename) => rename.caseInsensitive);
  const canonical = (name) => caseInsensitive ? name.toLocaleLowerCase() : name;
  const replacements = new Map(activeRenames.map(({ before, after }) => [canonical(before), after]));
  const candidates = [...new Set([
    ...activeRenames.map(({ before }) => before),
    ...(options.knownNames || []).map(String),
  ])].filter(Boolean).sort((first, second) => second.length - first.length);
  const alternatives = candidates
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  if (!alternatives) return String(expression ?? '');
  return String(expression ?? '').replace(
    new RegExp(`(^|[^A-Za-z0-9_@])(${alternatives})(?=$|[^A-Za-z0-9_@])`, caseInsensitive ? 'gi' : 'g'),
    (_match, prefix, name) => `${prefix}${replacements.get(canonical(name)) || name}`,
  );
}

export function rewriteQualifiedDimensionReferences(value, renames = [], key = '') {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteQualifiedDimensionReferences(item, renames, key));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [
      childKey,
      rewriteQualifiedDimensionReferences(item, renames, childKey),
    ]));
  }
  const expressionBearing = key === 'expression' || /Expression$/.test(key) || key === 'text';
  if (typeof value !== 'string' || !expressionBearing) return value;
  return rewriteExpressionSymbolReferences(value, renames, { caseInsensitive: true });
}

export function nextIndexedParameterName(prefix, usedNames = [], {
  caseInsensitive = false,
  startIndex = 1,
} = {}) {
  const canonical = (name) => caseInsensitive ? String(name).toLocaleLowerCase() : String(name);
  const used = usedNames instanceof Map || usedNames instanceof Set
    ? usedNames
    : new Set(usedNames);
  let index = Math.max(1, Number(startIndex) || 1);
  while (used.has(canonical(`${prefix}${index}`))) index += 1;
  return `${prefix}${index}`;
}

export function nextAvailableParameterName(requested, kind, usedNames = [], {
  sequentialDimension = false,
} = {}) {
  const used = usedNames instanceof Map || usedNames instanceof Set
    ? usedNames
    : new Set(usedNames);
  const requestedName = normalizedNameWhitespace(requested);
  const dimension = kind === 'dimension';
  const requestedKey = dimension ? requestedName.toLocaleLowerCase() : requestedName;
  if (!sequentialDimension && requestedName && !used.has(requestedKey)) return requestedName;
  if (dimension) return nextIndexedParameterName('d', used, { caseInsensitive: true });
  if (kind === 'control') return nextIndexedParameterName('c', used);
  let index = 2;
  while (used.has(`${requestedName}_${index}`)) index += 1;
  return `${requestedName}_${index}`;
}

export function nextDimensionNameForStack(parameters = [], stackId, {
  defaultStackId = null,
  requested = '',
  sequential = true,
} = {}) {
  const usedNames = new Set((parameters || [])
    .filter((parameter) => parameter?.kind === 'dimension'
      && (parameter.stackId || defaultStackId) === stackId)
    .map((parameter) => parameterNameKey(parameter.name, 'dimension')));
  return nextAvailableParameterName(requested, 'dimension', usedNames, {
    sequentialDimension: sequential,
  });
}
