import {
  dimensionParameterNameError,
  nextAvailableParameterName,
  normalizedStackName,
  qualifiedDimensionName,
  rewriteExpressionSymbolReferences,
  stackNameById,
  uniqueStackName,
} from './NamingSystem.js';
import { createUuid } from './IdentitySystem.js';

export {
  dimensionCollectionNameError,
  dimensionDisplayName,
  dimensionParameterIndex,
  dimensionParameterNameError,
  normalizedNameWhitespace,
  normalizedStackName,
  parameterNameError,
  parameterNameKey,
  qualifiedDimensionName,
  replaceExpressionSymbolReference,
  rewriteExpressionSymbolReferences,
  rewriteQualifiedDimensionReferences,
  stackNameById,
  stackNameError,
  uniqueStackName,
  userParameterNameError,
} from './NamingSystem.js';

export const STACK_ARCHITECTURE_VERSION = 5;
export const DEFAULT_STACK_ROLE = 'default-stack';
export const STACK_NODE_KIND = 'stack';
export const DRAWING_NODE_KIND = 'drawing';
const LEGACY_DEFAULT_STACK_ID = 'stack-default';
const LEGACY_NAMING_ARCHITECTURE_VERSION = 2;
const STACK_TREE_ARCHITECTURE_VERSION = 3;

const clone = (value) => JSON.parse(JSON.stringify(value));

export function collectRecordReferences(value, knownRecordIds, result = new Set(), visited = new Set()) {
  if (typeof value === 'string') {
    if (knownRecordIds.has(value)) result.add(value);
    return result;
  }
  if (!value || typeof value !== 'object' || visited.has(value)) return result;
  visited.add(value);
  if (Array.isArray(value)) value.forEach((item) => collectRecordReferences(item, knownRecordIds, result, visited));
  else Object.values(value).forEach((item) => collectRecordReferences(item, knownRecordIds, result, visited));
  return result;
}

export function participantStackIds(value, entities = [], ownerStackId = null) {
  const entityById = new Map((entities || []).filter(({ id }) => id).map((entity) => [entity.id, entity]));
  const recordIds = collectRecordReferences(value, new Set(entityById.keys()));
  return [...new Set([...recordIds]
    .map((recordId) => entityById.get(recordId)?.stackId || ownerStackId)
    .filter((stackId) => stackId && stackId !== ownerStackId))];
}

export function createStackId() {
  return createUuid();
}

function stackStateVersion(value) {
  return Number(value?.version || 0);
}

function normalizedSiblingOrder(value, fallback) {
  const order = Number(value);
  return Number.isFinite(order) && order >= 0 ? Math.trunc(order) : fallback;
}

function canonicalStackRecord(item, index, stacks) {
  const id = String(item?.id || '').trim();
  const isDefault = item?.systemRole === DEFAULT_STACK_ROLE || id === LEGACY_DEFAULT_STACK_ID;
  const kind = item?.kind === DRAWING_NODE_KIND ? DRAWING_NODE_KIND : STACK_NODE_KIND;
  const fallback = `Stack ${Math.max(1, index + 1)}`;
  const sourceStackId = Object.hasOwn(item || {}, 'sourceStackId')
    ? (item.sourceStackId ? String(item.sourceStackId) : null)
    : id;
  const requestedExpression = String(item?.enabledExpression ?? '').trim();
  const literalExpression = ['TRUE', 'YES', '1'].includes(requestedExpression.toUpperCase())
    ? true
    : ['FALSE', 'NO', '0'].includes(requestedExpression.toUpperCase()) ? false : null;
  const hasManualEnabled = typeof item?.enabled === 'boolean';
  const enabled = hasManualEnabled
    ? item.enabled
    : literalExpression ?? (requestedExpression ? false : true);
  const expression = hasManualEnabled || literalExpression === null ? requestedExpression : '';
  const normalized = {
    ...clone(item || {}),
    id,
    kind: isDefault ? STACK_NODE_KIND : kind,
    sourceStackId,
    parentStackId: item?.parentStackId ? String(item.parentStackId) : null,
    order: normalizedSiblingOrder(item?.order, index),
    name: uniqueStackName(item?.name, stacks, { fallback }),
    visible: item?.visible !== false,
    enabled,
    enabledExpression: expression,
    removable: true,
    ...(isDefault ? { systemRole: DEFAULT_STACK_ROLE } : {}),
  };
  if (normalized.kind === DRAWING_NODE_KIND) {
    normalized.sourceDrawingId = item?.sourceDrawingId ? String(item.sourceDrawingId) : null;
  } else {
    delete normalized.sourceDrawingId;
  }
  delete normalized.localEnabled;
  delete normalized.effectiveEnabled;
  delete normalized.activationError;
  delete normalized.selected;
  delete normalized.expanded;
  return normalized;
}

function validateStackParents(stacks, { canonical = false } = {}) {
  const byId = new Map(stacks.map((stack) => [stack.id, stack]));
  stacks.forEach((stack) => {
    if (!stack.parentStackId) return;
    if (!byId.has(stack.parentStackId)) {
      if (!canonical) {
        stack.parentStackId = null;
        return;
      }
      throw new Error(`Stack "${stack.name}" (${stack.id}) references missing parent ${stack.parentStackId}.`);
    }
    if (stack.parentStackId === stack.id) {
      throw new Error(`Stack "${stack.name}" (${stack.id}) cannot be its own parent.`);
    }
  });
  stacks.forEach((stack) => {
    const visited = new Set([stack.id]);
    let cursor = stack;
    while (cursor?.parentStackId) {
      if (visited.has(cursor.parentStackId)) {
        const parent = byId.get(cursor.parentStackId);
        throw new Error(`Stack hierarchy cycle includes "${stack.name}" (${stack.id}) and "${parent?.name || cursor.parentStackId}" (${cursor.parentStackId}).`);
      }
      visited.add(cursor.parentStackId);
      cursor = byId.get(cursor.parentStackId);
    }
  });
}

function orderedStackRecords(stacks) {
  const sourceIndex = new Map(stacks.map((stack, index) => [stack.id, index]));
  const children = new Map();
  const add = (parentStackId, stack) => {
    const key = parentStackId || null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(stack);
  };
  stacks.forEach((stack) => add(stack.parentStackId, stack));
  children.forEach((siblings) => {
    siblings.sort((first, second) => (
      first.order - second.order || sourceIndex.get(first.id) - sourceIndex.get(second.id)
    ));
    siblings.forEach((stack, order) => { stack.order = order; });
  });
  const result = [];
  const visit = (stack) => {
    result.push(stack);
    (children.get(stack.id) || []).forEach(visit);
  };
  (children.get(null) || []).forEach(visit);
  return result;
}

export function normalizeStackArchitectureState(value = null) {
  const input = value && typeof value === 'object' ? value : {};
  const sourceStacks = Array.isArray(input.stacks) ? input.stacks : [];
  const stacks = [];
  const seenIds = new Set();
  let defaultStack = null;
  const sourceVersion = stackStateVersion(input);
  const canonical = sourceVersion >= STACK_TREE_ARCHITECTURE_VERSION;
  const supportsTree = sourceVersion >= STACK_TREE_ARCHITECTURE_VERSION;
  const add = (item, index) => {
    const id = String(item?.id || '').trim();
    if (!id) return;
    if (seenIds.has(id)) {
      if (canonical) throw new Error(`Stack ID ${id} is declared more than once.`);
      return;
    }
    seenIds.add(id);
    const normalized = canonicalStackRecord(item, index, stacks);
    if (!supportsTree) normalized.parentStackId = null;
    stacks.push(normalized);
    if (normalized.systemRole === DEFAULT_STACK_ROLE) {
      if (defaultStack) throw new Error('Default Stack role is declared more than once.');
      defaultStack = normalized;
    }
  };
  sourceStacks.forEach(add);
  if (!defaultStack) {
    defaultStack = stacks.find(({ kind }) => kind === STACK_NODE_KIND) || null;
    if (defaultStack) defaultStack.systemRole = DEFAULT_STACK_ROLE;
  }
  if (!defaultStack) {
    add({
      id: createStackId(),
      name: 'Stack 1',
      systemRole: DEFAULT_STACK_ROLE,
      removable: true,
    }, 0);
    defaultStack = stacks.find(({ systemRole }) => systemRole === DEFAULT_STACK_ROLE);
  }
  validateStackParents(stacks, { canonical });
  const hasExplicitActiveStack = Object.hasOwn(input, 'activeStackId');
  const requestedActiveStackId = input.activeStackId == null ? null : String(input.activeStackId).trim();
  if (canonical && requestedActiveStackId && !seenIds.has(requestedActiveStackId)) {
    throw new Error(`Active Stack ${requestedActiveStackId} does not exist.`);
  }
  const requestedActiveNode = requestedActiveStackId ? stacks.find(({ id }) => id === requestedActiveStackId) : null;
  if (canonical && requestedActiveStackId && requestedActiveNode?.kind !== STACK_NODE_KIND) {
    throw new Error(`Active Stack ${requestedActiveStackId} is not a drawable Stack.`);
  }
  const activeStackId = requestedActiveNode?.kind === STACK_NODE_KIND
    ? requestedActiveNode.id
    : hasExplicitActiveStack && sourceVersion >= STACK_ARCHITECTURE_VERSION ? null : defaultStack.id;
  return { version: STACK_ARCHITECTURE_VERSION, activeStackId, stacks: orderedStackRecords(stacks) };
}

export function isDrawableStack(stack) {
  return stack?.kind !== DRAWING_NODE_KIND;
}

export function isDrawingContainer(stack) {
  return stack?.kind === DRAWING_NODE_KIND;
}

export function createStackTreeIndex(stateInput = null) {
  const state = normalizeStackArchitectureState(stateInput);
  const byId = new Map(state.stacks.map((stack) => [stack.id, stack]));
  const childrenByParentId = new Map();
  state.stacks.forEach((stack) => {
    const key = stack.parentStackId || null;
    if (!childrenByParentId.has(key)) childrenByParentId.set(key, []);
    childrenByParentId.get(key).push(stack);
  });
  return {
    state,
    byId,
    childrenByParentId,
    parent(stackId) {
      const parentStackId = byId.get(stackId)?.parentStackId;
      return parentStackId ? byId.get(parentStackId) || null : null;
    },
    children(stackId = null) {
      return [...(childrenByParentId.get(stackId || null) || [])];
    },
  };
}

export function ancestorStackIds(stateInput, stackId) {
  const index = createStackTreeIndex(stateInput);
  const result = [];
  let cursor = index.byId.get(stackId);
  while (cursor?.parentStackId) {
    result.push(cursor.parentStackId);
    cursor = index.byId.get(cursor.parentStackId);
  }
  return result;
}

export function descendantStackIds(stateInput, stackId) {
  const index = createStackTreeIndex(stateInput);
  if (!index.byId.has(stackId)) return [];
  const result = [];
  const visit = (parentStackId) => index.children(parentStackId).forEach((child) => {
    result.push(child.id);
    visit(child.id);
  });
  visit(stackId);
  return result;
}

export function subtreeStackIds(stateInput, stackId) {
  const index = createStackTreeIndex(stateInput);
  return index.byId.has(stackId) ? [stackId, ...descendantStackIds(index.state, stackId)] : [];
}

export function validateStackReparent(stateInput, stackId, parentStackId = null) {
  const state = normalizeStackArchitectureState(stateInput);
  const index = createStackTreeIndex(state);
  const stack = index.byId.get(stackId);
  if (!stack) return { valid: false, error: `Stack ${stackId} does not exist.` };
  if (parentStackId && !index.byId.has(parentStackId)) {
    return { valid: false, error: `Parent Stack ${parentStackId} does not exist.` };
  }
  if (parentStackId === stackId) return { valid: false, error: `Stack "${stack.name}" cannot parent itself.` };
  if (parentStackId && descendantStackIds(state, stackId).includes(parentStackId)) {
    const parent = index.byId.get(parentStackId);
    return { valid: false, error: `Stack "${stack.name}" cannot be moved inside descendant "${parent?.name || parentStackId}".` };
  }
  return { valid: true, error: null };
}

export function reparentStack(stateInput, stackId, parentStackId = null, siblingIndex = Number.POSITIVE_INFINITY) {
  const state = normalizeStackArchitectureState(stateInput);
  const validation = validateStackReparent(state, stackId, parentStackId);
  if (!validation.valid) throw new Error(validation.error);
  const target = state.stacks.find((stack) => stack.id === stackId);
  target.parentStackId = parentStackId || null;
  const siblings = state.stacks.filter((stack) => stack.id !== stackId && stack.parentStackId === target.parentStackId);
  const requested = Number.isFinite(Number(siblingIndex)) ? Math.trunc(Number(siblingIndex)) : siblings.length;
  const index = Math.max(0, Math.min(siblings.length, requested));
  siblings.splice(index, 0, target);
  siblings.forEach((stack, order) => { stack.order = order; });
  return normalizeStackArchitectureState(state);
}

export function reorderStack(stateInput, stackId, siblingIndex) {
  const state = normalizeStackArchitectureState(stateInput);
  const stack = state.stacks.find((candidate) => candidate.id === stackId);
  if (!stack) throw new Error(`Stack ${stackId} does not exist.`);
  return reparentStack(state, stackId, stack.parentStackId, siblingIndex);
}

export function nextActiveStackId(stateInput, unavailableStackIds = [], previousActiveStackId = null) {
  const state = normalizeStackArchitectureState(stateInput);
  const unavailable = new Set([...unavailableStackIds].map(String));
  const available = (stackId) => Boolean(
    stackId
    && !unavailable.has(stackId)
    && state.stacks.some((stack) => stack.id === stackId && isDrawableStack(stack)),
  );
  if (available(previousActiveStackId) && state.stacks.some(({ id }) => id === previousActiveStackId)) return previousActiveStackId;
  for (const ancestorId of ancestorStackIds(state, previousActiveStackId)) {
    if (available(ancestorId)) return ancestorId;
  }
  const previousIndex = state.stacks.findIndex(({ id }) => id === previousActiveStackId);
  const ordered = previousIndex < 0
    ? state.stacks
    : [...state.stacks.slice(previousIndex + 1), ...state.stacks.slice(0, previousIndex)];
  return ordered.find(({ id }) => available(id))?.id || null;
}

export function defaultStackId(stateInput = null) {
  const state = stateInput?.stacks ? stateInput : normalizeStackArchitectureState(stateInput);
  return state.stacks.find(({ systemRole }) => systemRole === DEFAULT_STACK_ROLE)?.id || null;
}

function firstReferencedStack(value, entities, fallback = null) {
  const entityById = new Map((entities || []).filter(({ id }) => id).map((entity) => [entity.id, entity]));
  const recordIds = collectRecordReferences(value, new Set(entityById.keys()));
  const firstId = recordIds.values().next().value;
  return entityById.get(firstId)?.stackId || fallback;
}

function replaceNameTokens(expression, replacements) {
  return rewriteExpressionSymbolReferences(
    expression,
    [...replacements.entries()].map(([before, after]) => ({ before, after, caseInsensitive: true })),
  );
}

function expressionContextStackId(value, dimensionStackById) {
  if (value?.kind === 'dimension') return dimensionStackById.get(value.id) || value.stackId || null;
  return null;
}

function migrateExpression(expression, contextStackId, legacyDimensionByName, stackNames) {
  const replacements = new Map();
  legacyDimensionByName.forEach((entry, name) => {
    if (!entry?.stackId) return;
    replacements.set(name, contextStackId === entry.stackId
      ? entry.name
      : qualifiedDimensionName(entry.name, stackNames.get(entry.stackId) || entry.stackId));
  });
  return replaceNameTokens(expression, replacements);
}

function migrateExpressionFields(value, contextStackId, legacyDimensionByName, stackNames, key = '') {
  if (Array.isArray(value)) {
    return value.map((item) => migrateExpressionFields(item, contextStackId, legacyDimensionByName, stackNames, key));
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && (/Expression$/.test(key) || key === 'expression')) {
      return migrateExpression(value, contextStackId, legacyDimensionByName, stackNames);
    }
    return value;
  }
  const nextContext = value.stackId || contextStackId;
  return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [
    childKey,
    migrateExpressionFields(item, nextContext, legacyDimensionByName, stackNames, childKey),
  ]));
}

function declaredLiveStackIds(value, result = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => declaredLiveStackIds(item, result));
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  Object.entries(value).forEach(([key, item]) => {
    if (key === 'stackId' && typeof item === 'string' && item) result.add(item);
    if (key === 'participantStackIds' && Array.isArray(item)) item.filter(Boolean).forEach((id) => result.add(String(id)));
    declaredLiveStackIds(item, result);
  });
  return result;
}

function legacyStackState(source) {
  const stackIds = declaredLiveStackIds({
    entities: source.entities,
    constraints: source.constraints,
    parameters: source.parameters || source.dimensions,
    dimensionAnnotations: source.dimensionAnnotations || source.annotations,
    extensions: source.extensions,
  });
  stackIds.delete(LEGACY_DEFAULT_STACK_ID);
  const defaultStack = { id: createUuid(), name: 'Default', systemRole: DEFAULT_STACK_ROLE, visible: true };
  return {
    activeStackId: defaultStack.id,
    stacks: [
      defaultStack,
      ...[...stackIds].map((id) => ({ id, name: id, visible: true })),
    ],
  };
}

function migrateExtensionOwnership(extensions, entities, stackState) {
  const result = clone(extensions || {});
  const knownStackIds = new Set(stackState.stacks.map(({ id }) => id));
  const fallbackStackId = defaultStackId(stackState);
  const entityStackById = new Map(entities.map((entity) => [entity.id, entity.stackId || fallbackStackId]));
  const validStackId = (stackId) => knownStackIds.has(stackId) ? stackId : null;
  const firstEntityStack = (value, fallback = stackState.activeStackId || fallbackStackId) => {
    const recordId = collectRecordReferences(value, new Set(entityStackById.keys())).values().next().value;
    return entityStackById.get(recordId) || fallback;
  };
  const ownDefinitions = (definitions = []) => definitions.map((definition) => {
    const stackId = validStackId(definition.stackId) || firstEntityStack(definition);
    return {
      ...definition,
      sourceDefinitionId: String(definition.sourceDefinitionId || definition.id || ''),
      sourceStackId: String(definition.sourceStackId || stackId),
      stackId,
    };
  });
  if (result.arrayTools?.arrays) result.arrayTools.arrays = ownDefinitions(result.arrayTools.arrays);
  if (result.linkedCopyTools?.copies) result.linkedCopyTools.copies = ownDefinitions(result.linkedCopyTools.copies);
  const linkedDefinitionStack = new Map((result.linkedCopyTools?.copies || []).map(({ id, stackId }) => [id, stackId]));
  const ownRelationships = (relationships = [], ownerFor = null) => relationships.map((relationship) => {
    const stackId = validStackId(relationship.stackId)
      || ownerFor?.(relationship)
      || firstEntityStack(relationship);
    return {
      ...relationship,
      sourceRelationshipId: String(relationship.sourceRelationshipId || relationship.id || ''),
      stackId,
      participantStackIds: participantStackIds(relationship, entities, stackId),
    };
  });
  if (result.linkedCopyTools?.positionConstraints) {
    result.linkedCopyTools.positionConstraints = ownRelationships(
      result.linkedCopyTools.positionConstraints,
      (relationship) => linkedDefinitionStack.get(relationship.externalDrivingTarget?.copyId),
    );
  }
  if (result.swell?.constraints) result.swell.constraints = ownRelationships(result.swell.constraints);
  return result;
}

export function migrateStackArchitecture(input = {}) {
  const source = clone(input || {});
  const rewriteLegacyExpressions = Number(source.stackArchitectureVersion || 0) < LEGACY_NAMING_ARCHITECTURE_VERSION;
  const priorState = source.extensions?.stacks || legacyStackState(source);
  const stackState = normalizeStackArchitectureState(priorState);
  const fallbackStackId = defaultStackId(stackState);
  const knownStackIds = new Set(stackState.stacks.map(({ id }) => id));
  const sourceStackIdById = new Map(stackState.stacks.map(({ id, sourceStackId }) => [id, sourceStackId || id]));
  const entities = (source.entities || []).map((entity) => ({
    ...entity,
    sourceRecordId: String(entity?.sourceRecordId || entity?.id || ''),
    stackId: knownStackIds.has(entity?.stackId) ? entity.stackId : fallbackStackId,
    sourceStackId: String(entity?.sourceStackId || sourceStackIdById.get(
      knownStackIds.has(entity?.stackId) ? entity.stackId : fallbackStackId,
    ) || fallbackStackId),
  }));
  const annotations = (source.dimensionAnnotations || source.annotations || []).map((annotation) => {
    const ownerStackId = knownStackIds.has(annotation?.stackId)
      ? annotation.stackId
      : firstReferencedStack(annotation, entities);
    return {
      ...annotation,
      sourceRelationshipId: String(annotation?.sourceRelationshipId || annotation?.dimensionId || annotation?.id || ''),
      stackId: ownerStackId,
      participantStackIds: participantStackIds(annotation, entities, ownerStackId),
    };
  });
  const annotationByDimensionId = new Map(annotations
    .filter(({ dimensionId }) => dimensionId)
    .map((annotation) => [annotation.dimensionId, annotation]));
  const usedDimensionNames = new Map();
  const legacyDimensionByName = new Map();
  const parameters = (source.parameters || source.dimensions || []).map((parameter, order) => {
    if (parameter.kind !== 'dimension') return { ...parameter, order: parameter.order ?? order };
    const annotation = annotationByDimensionId.get(parameter.id);
    const ownerStackId = knownStackIds.has(parameter.stackId)
      ? parameter.stackId
      : annotation?.stackId || fallbackStackId;
    if (!usedDimensionNames.has(ownerStackId)) usedDimensionNames.set(ownerStackId, new Set());
    const used = usedDimensionNames.get(ownerStackId);
    const invalidName = dimensionParameterNameError(parameter.name);
    if (!rewriteLegacyExpressions && invalidName) throw new Error(invalidName);
    const name = nextAvailableParameterName(invalidName ? '' : parameter.name, 'dimension', used);
    used.add(name.toLocaleLowerCase());
    const migrated = {
      ...parameter,
      sourceDimensionId: String(parameter?.sourceDimensionId || parameter?.id || ''),
      name,
      stackId: ownerStackId,
      participantStackIds: annotation?.participantStackIds || [],
      order: parameter.order ?? order,
    };
    if (parameter.name && !legacyDimensionByName.has(parameter.name)) legacyDimensionByName.set(parameter.name, migrated);
    return migrated;
  });
  const dimensionStackById = new Map(parameters
    .filter(({ kind }) => kind === 'dimension')
    .map((parameter) => [parameter.id, parameter.stackId]));
  const stackNames = stackNameById(stackState);
  const migratedParameters = parameters.map((parameter) => ({
    ...parameter,
    expression: rewriteLegacyExpressions ? migrateExpression(
      parameter.expression,
      expressionContextStackId(parameter, dimensionStackById),
      legacyDimensionByName,
      stackNames,
    ) : parameter.expression,
  }));
  const constraints = (source.constraints || []).map((constraint) => {
    const dimensionStackId = dimensionStackById.get(constraint.dimensionRef);
    const ownerStackId = knownStackIds.has(constraint.stackId)
      ? constraint.stackId
      : dimensionStackId || firstReferencedStack(constraint, entities);
    return {
      ...constraint,
      sourceRelationshipId: String(constraint?.sourceRelationshipId || constraint?.id || ''),
      stackId: ownerStackId,
      participantStackIds: participantStackIds(constraint, entities, ownerStackId),
    };
  });
  const migratedEntities = rewriteLegacyExpressions
    ? entities.map((entity) => migrateExpressionFields(
      entity,
      entity.stackId,
      legacyDimensionByName,
      stackNames,
    ))
    : entities;
  const rawExtensions = {
    ...migrateExtensionOwnership(source.extensions, entities, stackState),
    stacks: stackState,
  };
  const extensions = rewriteLegacyExpressions
    ? migrateExpressionFields(rawExtensions, null, legacyDimensionByName, stackNames)
    : rawExtensions;
  return {
    ...source,
    stackArchitectureVersion: STACK_ARCHITECTURE_VERSION,
    entities: migratedEntities,
    constraints,
    parameters: migratedParameters,
    dimensions: clone(migratedParameters),
    dimensionAnnotations: annotations.map((annotation) => {
      const parameter = migratedParameters.find(({ id }) => id === annotation.dimensionId);
      return parameter ? { ...annotation, dimensionName: parameter.name } : annotation;
    }),
    extensions,
  };
}
