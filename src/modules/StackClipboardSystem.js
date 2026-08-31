import { defaultStackId } from './StackArchitecture.js';
import {
  dimensionDisplayName,
  parameterNameKey,
  qualifiedDimensionName,
  replaceExpressionSymbolReference,
  rewriteQualifiedDimensionReferences,
} from './NamingSystem.js';

function rewriteExpressionReferences(value, renamesByStack, contextStackId = null, key = '') {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteExpressionReferences(item, renamesByStack, contextStackId, key));
  }
  if (value && typeof value === 'object') {
    const isParameter = Object.hasOwn(value, 'expression')
      && Object.hasOwn(value, 'name')
      && ['dimension', 'parameter', 'user', 'control'].includes(value.kind);
    const nextContext = isParameter
      ? (value.kind === 'dimension' ? value.stackId || contextStackId : null)
      : value.stackId || contextStackId;
    return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [
      childKey,
      rewriteExpressionReferences(item, renamesByStack, nextContext, childKey),
    ]));
  }
  if (typeof value !== 'string') return value;
  const replacements = renamesByStack.get(contextStackId);
  if (!replacements?.size) return value;
  const rewrite = (expression) => [...replacements.values()].reduce(
    (source, rename) => replaceExpressionSymbolReference(
      source,
      rename.before,
      rename.after,
      { caseInsensitive: true },
    ),
    expression,
  );
  if (key === 'text') {
    return value.replace(/\[([^\]]+)\]/g, (_match, expression) => `[${rewrite(expression)}]`);
  }
  return key === 'expression' || /Expression$/.test(key) ? rewrite(value) : value;
}

export function prepareStackClipboardDimensions(drawing, {
  parameters = [],
  requiredParameterIds = [],
  includedDimensionIds = [],
  stackState,
} = {}) {
  const requiredIds = new Set(requiredParameterIds);
  const copiedDimensionIds = new Set(includedDimensionIds);
  const stackById = new Map((stackState?.stacks || []).map((stack) => [stack.id, stack]));
  const fallbackStackId = defaultStackId(stackState);
  const renamesByStack = new Map();
  const externalDimensionReferences = [];

  parameters.forEach((parameter) => {
    if (parameter.kind !== 'dimension'
      || !requiredIds.has(parameter.id)
      || copiedDimensionIds.has(parameter.id)) return;
    const ownerStackId = parameter.stackId || fallbackStackId;
    const ownerStack = stackById.get(ownerStackId);
    const displayName = dimensionDisplayName(parameter, stackState);
    if (!displayName || displayName === parameter.name) return;
    externalDimensionReferences.push({
      dimensionId: parameter.id,
      sourceDimensionId: parameter.sourceDimensionId || parameter.id,
      name: parameter.name,
      stackId: ownerStackId,
      sourceStackId: ownerStack?.sourceStackId || ownerStackId,
      stackName: ownerStack?.name || ownerStackId,
      displayName,
    });
    if (!renamesByStack.has(ownerStackId)) renamesByStack.set(ownerStackId, new Map());
    renamesByStack.get(ownerStackId).set(parameterNameKey(parameter.name, 'dimension'), {
      before: parameter.name,
      after: displayName,
    });
  });

  return {
    drawing: rewriteExpressionReferences(drawing, renamesByStack),
    externalDimensionReferences,
  };
}

export function retargetStackClipboardDimensions(drawing, {
  copiedDimensions = [],
  externalDimensionReferences = [],
  sourceStackState,
  targetStackState,
  targetStack,
} = {}) {
  const copiedDimensionRenames = copiedDimensions.map((parameter) => ({
    before: dimensionDisplayName(parameter, sourceStackState),
    after: qualifiedDimensionName(parameter.name, targetStack.name),
  }));
  const externalReferenceRenames = externalDimensionReferences.map((reference) => {
    const liveOwnerStack = (targetStackState?.stacks || []).find(({ id, sourceStackId }) => (
      id === reference.stackId
      || sourceStackId === reference.sourceStackId
      || id === reference.sourceStackId
    ));
    const targetIsOwner = targetStack.id === liveOwnerStack?.id
      || targetStack.id === reference.stackId
      || targetStack.sourceStackId === reference.sourceStackId;
    return {
      before: reference.displayName || qualifiedDimensionName(reference.name, reference.stackName),
      after: targetIsOwner
        ? reference.name
        : qualifiedDimensionName(reference.name, liveOwnerStack?.name || reference.stackName),
    };
  });
  return rewriteQualifiedDimensionReferences(drawing, [
    ...copiedDimensionRenames,
    ...externalReferenceRenames,
  ]);
}
