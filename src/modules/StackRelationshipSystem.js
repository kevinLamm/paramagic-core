import {
  collectRecordReferences,
  defaultStackId,
  normalizeStackArchitectureState,
} from './StackArchitecture.js';
import { nextDimensionNameForStack } from './NamingSystem.js';
import { createUuid } from './IdentitySystem.js';
import { registerIdentitySchema } from './DrawingIdentitySystem.js';

registerIdentitySchema('stackRelationships', {
  declarations: (value) => (value?.templates || []).map((object, index) => ({
    object, key: 'id', value: object.id, path: ['extensions', 'stackRelationships', 'templates', String(index), 'id'], kind: 'stack-relationship-template',
  })),
  lineageReferenceKeys: [
    'stackId', 'ownerStackId', 'recordId', 'dimensionId', 'dimensionRef', 'parameterId', 'copyId', 'sourceId',
    'sourceStackId', 'sourceRecordId', 'sourceDimensionId', 'sourceDefinitionId', 'sourceRelationshipId', 'ownerSourceStackId',
  ],
  lineageReferenceArrayKeys: ['participantStackIds', 'recordIds', 'sourceIds', 'requiredSourceStackIds'],
});

export const STACK_RELATIONSHIP_VERSION = 1;
export const ENTITY_RELATIONSHIP_SOLVE_DOMAIN = 'entity';
export const STACK_FRAME_RELATIONSHIP_SOLVE_DOMAIN = 'stack-frame';

export function stackRelationshipSolveDomain(activeStackId = null) {
  return activeStackId
    ? ENTITY_RELATIONSHIP_SOLVE_DOMAIN
    : STACK_FRAME_RELATIONSHIP_SOLVE_DOMAIN;
}

export function normalizedStackRelationshipSolveDomain(value) {
  return value === ENTITY_RELATIONSHIP_SOLVE_DOMAIN
    ? ENTITY_RELATIONSHIP_SOLVE_DOMAIN
    : STACK_FRAME_RELATIONSHIP_SOLVE_DOMAIN;
}

export function isStackFrameRelationship(value) {
  return value?.coordinateSpace === 'global'
    && normalizedStackRelationshipSolveDomain(value?.solveDomain) === STACK_FRAME_RELATIONSHIP_SOLVE_DOMAIN;
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const unique = (values = []) => [...new Set(values.filter(Boolean).map(String))];

function replacePortableIds(value, replacements) {
  if (Array.isArray(value)) return value.map((item) => replacePortableIds(item, replacements));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /^source(?:Record|Stack|Relationship|Dimension|Definition)Id$/.test(key)
        ? item
        : replacePortableIds(item, replacements),
    ]));
  }
  return typeof value === 'string' && replacements.has(value) ? replacements.get(value) : value;
}

function dormantPayload(value) {
  if (Array.isArray(value)) return value.map(dormantPayload);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'id')
    .map(([key, item]) => [key, dormantPayload(item)]));
}

function stackSources(snapshot) {
  const state = normalizeStackArchitectureState(snapshot.extensions?.stacks);
  return {
    state,
    sourceByLiveId: new Map(state.stacks.map((stack) => [stack.id, stack.sourceStackId || stack.id])),
    nameBySourceId: new Map(state.stacks.map((stack) => [stack.sourceStackId || stack.id, stack.name])),
  };
}

function drawingDefaultStackId(snapshot) {
  return defaultStackId(snapshot?.extensions?.stacks);
}

function portableRecordSources(snapshot, referencedIds) {
  const fallbackStackId = drawingDefaultStackId(snapshot);
  const entityById = new Map(snapshot.entities.map((entity) => [entity.id, entity]));
  return [...referencedIds].map((recordId) => {
    const entity = entityById.get(recordId);
    return entity ? {
      sourceRecordId: entity.sourceRecordId || entity.id,
      sourceStackId: entity.sourceStackId || entity.stackId || fallbackStackId,
    } : null;
  }).filter(Boolean);
}

function relationshipTemplate({
  type,
  payload,
  snapshot,
  referencedIds,
  sourceRelationshipId,
  ownerStackId,
  extensionKey = null,
  definitionSources = [],
}) {
  const { sourceByLiveId, nameBySourceId } = stackSources(snapshot);
  const fallbackStackId = drawingDefaultStackId(snapshot);
  const recordSources = portableRecordSources(snapshot, referencedIds);
  const ownerSourceStackId = sourceByLiveId.get(ownerStackId) || ownerStackId || recordSources[0]?.sourceStackId || fallbackStackId;
  const requiredSourceStackIds = unique([
    ownerSourceStackId,
    ...recordSources.map(({ sourceStackId }) => sourceStackId),
    ...definitionSources.map(({ sourceStackId }) => sourceStackId),
  ]);
  const recordIdMap = new Map(snapshot.entities.map((entity) => [
    entity.id,
    entity.sourceRecordId || entity.id,
  ]));
  definitionSources.forEach(({ liveDefinitionId, sourceDefinitionId }) => {
    recordIdMap.set(liveDefinitionId, sourceDefinitionId);
  });
  return {
    id: createUuid(),
    sourceRelationshipId: String(sourceRelationshipId || createUuid()),
    type,
    ...(extensionKey ? { extensionKey } : {}),
    ownerSourceStackId,
    requiredSourceStackIds,
    sourceStackNames: Object.fromEntries(requiredSourceStackIds.map((sourceStackId) => [
      sourceStackId,
      nameBySourceId.get(sourceStackId) || sourceStackId,
    ])),
    recordSources,
    definitionSources: definitionSources.map(({ liveDefinitionId: _liveDefinitionId, ...source }) => source),
    payload: dormantPayload(replacePortableIds(payload, recordIdMap)),
  };
}

function includedSourceStackIds(snapshot, includedIds) {
  const fallbackStackId = drawingDefaultStackId(snapshot);
  return new Set(snapshot.entities
    .filter(({ id }) => includedIds.has(id))
    .map((entity) => entity.sourceStackId || entity.stackId || fallbackStackId));
}

function relationshipIsDormant(template, includedStacks) {
  return template.requiredSourceStackIds.some((sourceStackId) => !includedStacks.has(sourceStackId));
}

function extensionConstraintTemplates(snapshot, includedStacks, knownRecordIds) {
  const fallbackStackId = drawingDefaultStackId(snapshot);
  const templates = [];
  const append = (extensionKey, constraints, definitions = []) => {
    const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));
    constraints.forEach((constraint) => {
      const referencedIds = collectRecordReferences(constraint, knownRecordIds);
      const definitionId = constraint.externalDrivingTarget?.copyId;
      const definition = definitionById.get(definitionId);
      const definitionSources = definition ? [{
        liveDefinitionId: definition.id,
        sourceDefinitionId: definition.sourceDefinitionId || definition.id,
        sourceStackId: definition.sourceStackId || definition.stackId || fallbackStackId,
      }] : [];
      const template = relationshipTemplate({
        type: 'extension-constraint',
        extensionKey,
        payload: constraint,
        snapshot,
        referencedIds,
        definitionSources,
        sourceRelationshipId: constraint.sourceRelationshipId || constraint.id,
        ownerStackId: constraint.stackId || definition?.stackId,
      });
      if (
        template.requiredSourceStackIds.some((id) => includedStacks.has(id))
        && relationshipIsDormant(template, includedStacks)
      ) templates.push(template);
    });
  };
  append(
    'linkedCopyTools',
    snapshot.extensions?.linkedCopyTools?.positionConstraints || [],
    snapshot.extensions?.linkedCopyTools?.copies || [],
  );
  append('swell', snapshot.extensions?.swell?.constraints || []);
  return templates;
}

export function createDormantStackRelationships(snapshotInput, includedEntityIds = []) {
  const snapshot = clone(snapshotInput || {});
  const includedIds = new Set(includedEntityIds.map(String));
  const knownRecordIds = new Set(snapshot.entities.map(({ id }) => id));
  const includedStacks = includedSourceStackIds(snapshot, includedIds);
  const templates = [];
  snapshot.constraints
    .filter((constraint) => constraint.source !== 'dimension' && !constraint.dimensionRef)
    .forEach((constraint) => {
      const referencedIds = collectRecordReferences(constraint, knownRecordIds);
      const template = relationshipTemplate({
        type: 'constraint',
        payload: constraint,
        snapshot,
        referencedIds,
        sourceRelationshipId: constraint.sourceRelationshipId || constraint.id,
        ownerStackId: constraint.stackId,
      });
      if (
        template.requiredSourceStackIds.some((id) => includedStacks.has(id))
        && relationshipIsDormant(template, includedStacks)
      ) templates.push(template);
    });
  const parameterById = new Map(snapshot.parameters.map((parameter) => [parameter.id, parameter]));
  snapshot.dimensionAnnotations.forEach((annotation) => {
    const parameter = parameterById.get(annotation.dimensionId);
    if (!parameter) return;
    const dimensionConstraints = snapshot.constraints
      .filter((constraint) => constraint.dimensionRef === parameter.id);
    const referencedIds = collectRecordReferences(
      { annotation, constraints: dimensionConstraints },
      knownRecordIds,
    );
    const template = relationshipTemplate({
      type: 'dimension',
      payload: { parameter, annotation, constraints: dimensionConstraints },
      snapshot,
      referencedIds,
      sourceRelationshipId: annotation.sourceRelationshipId || parameter.sourceDimensionId || parameter.id,
      ownerStackId: parameter.stackId || annotation.stackId,
    });
    if (
      template.requiredSourceStackIds.some((id) => includedStacks.has(id))
      && relationshipIsDormant(template, includedStacks)
    ) templates.push(template);
  });
  templates.push(...extensionConstraintTemplates(snapshot, includedStacks, knownRecordIds));
  const inherited = (snapshot.extensions?.stackRelationships?.templates || []).map((template) => ({
    ...clone(template),
    payload: dormantPayload(template.payload),
  }));
  const byKey = new Map([...inherited, ...templates].map((template) => [
    `${template.type}:${template.sourceRelationshipId || template.id}`,
    template,
  ]));
  return {
    version: STACK_RELATIONSHIP_VERSION,
    templates: [...byKey.values()].map(clone),
  };
}

function definitionsInDrawing(drawing) {
  return [
    ...(drawing.extensions?.linkedCopyTools?.copies || []).map((definition) => ({ ...definition, extensionKey: 'linkedCopyTools' })),
    ...(drawing.extensions?.arrayTools?.arrays || []).map((definition) => ({ ...definition, extensionKey: 'arrayTools' })),
  ];
}

function candidatesBySource(drawing) {
  const records = new Map();
  drawing.entities.forEach((entity) => {
    const sourceRecordId = entity.sourceRecordId || entity.id;
    if (!records.has(sourceRecordId)) records.set(sourceRecordId, []);
    records.get(sourceRecordId).push(entity);
  });
  const definitions = new Map();
  definitionsInDrawing(drawing).forEach((definition) => {
    const sourceDefinitionId = definition.sourceDefinitionId || definition.id;
    if (!definitions.has(sourceDefinitionId)) definitions.set(sourceDefinitionId, []);
    definitions.get(sourceDefinitionId).push(definition);
  });
  return { records, definitions };
}

function sourceStackInstances(template, candidates) {
  const result = new Map();
  template.requiredSourceStackIds.forEach((sourceStackId) => {
    let liveStackIds = null;
    const intersect = (values) => {
      const next = new Set(values);
      liveStackIds = liveStackIds === null
        ? next
        : new Set([...liveStackIds].filter((id) => next.has(id)));
    };
    template.recordSources.filter((source) => source.sourceStackId === sourceStackId).forEach((source) => {
      intersect((candidates.records.get(source.sourceRecordId) || []).map((entity) => entity.stackId).filter(Boolean));
    });
    template.definitionSources.filter((source) => source.sourceStackId === sourceStackId).forEach((source) => {
      intersect((candidates.definitions.get(source.sourceDefinitionId) || []).map((definition) => definition.stackId).filter(Boolean));
    });
    result.set(sourceStackId, [...(liveStackIds || [])]);
  });
  return result;
}

function stackCombinations(instances) {
  const entries = [...instances];
  if (entries.some(([, stackIds]) => !stackIds.length)) return [];
  let combinations = [new Map()];
  entries.forEach(([sourceStackId, stackIds]) => {
    combinations = combinations.flatMap((combination) => stackIds.map((stackId) => {
      const next = new Map(combination);
      next.set(sourceStackId, stackId);
      return next;
    }));
  });
  return combinations;
}

function bindingKey(template, stackBinding) {
  return `${template.type}:${template.sourceRelationshipId || template.id}|${[...stackBinding]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([source, live]) => `${source}=${live}`)
    .join('|')}`;
}

function liveIdMap(template, stackBinding, candidates) {
  const replacements = new Map();
  template.recordSources.forEach((source) => {
    const liveStackId = stackBinding.get(source.sourceStackId);
    const entity = (candidates.records.get(source.sourceRecordId) || [])
      .find((candidate) => candidate.stackId === liveStackId);
    if (entity) replacements.set(source.sourceRecordId, entity.id);
  });
  template.definitionSources.forEach((source) => {
    const liveStackId = stackBinding.get(source.sourceStackId);
    const definition = (candidates.definitions.get(source.sourceDefinitionId) || [])
      .find((candidate) => candidate.stackId === liveStackId);
    if (definition) replacements.set(source.sourceDefinitionId, definition.id);
  });
  return replacements;
}

function existingBindingKeys(drawing) {
  return new Set([
    ...drawing.constraints,
    ...drawing.dimensionAnnotations,
    ...(drawing.extensions?.linkedCopyTools?.positionConstraints || []),
    ...(drawing.extensions?.swell?.constraints || []),
  ].map(({ stackRelationshipBindingKey }) => stackRelationshipBindingKey).filter(Boolean));
}

function materializeTemplate(drawing, template, stackBinding, candidates, bindingKeys) {
  const key = bindingKey(template, stackBinding);
  if (bindingKeys.has(key)) return drawing;
  const replacements = liveIdMap(template, stackBinding, candidates);
  const fallbackStackId = drawingDefaultStackId(drawing);
  const ownerStackId = stackBinding.get(template.ownerSourceStackId) || fallbackStackId;
  const participantStackIds = unique([...stackBinding.values()].filter((id) => id !== ownerStackId));
  if (template.type === 'constraint') {
    drawing.constraints.push({
      ...replacePortableIds(clone(template.payload), replacements),
      id: createUuid(),
      sourceRelationshipId: template.sourceRelationshipId || template.id,
      stackRelationshipBindingKey: key,
      stackId: ownerStackId,
      participantStackIds,
    });
  } else if (template.type === 'dimension') {
    const payload = replacePortableIds(clone(template.payload), replacements);
    const sourceName = payload.parameter.name;
    const name = nextDimensionNameForStack(drawing.parameters, ownerStackId, {
      defaultStackId: fallbackStackId,
      requested: sourceName,
      sequential: true,
    });
    const dimensionId = createUuid();
    const annotationId = createUuid();
    drawing.parameters.push({
      ...payload.parameter,
      id: dimensionId,
      sourceDimensionId: payload.parameter.sourceDimensionId || template.sourceRelationshipId || template.id,
      name,
      stackId: ownerStackId,
      participantStackIds,
      order: drawing.parameters.length,
    });
    drawing.dimensionAnnotations.push({
      ...payload.annotation,
      id: annotationId,
      dimensionId,
      dimensionName: name,
      sourceRelationshipId: template.sourceRelationshipId || template.id,
      stackRelationshipBindingKey: key,
      stackId: ownerStackId,
      participantStackIds,
    });
    (payload.constraints || []).forEach((constraint) => {
      drawing.constraints.push({
        ...constraint,
        id: createUuid(),
        dimensionRef: dimensionId,
        sourceRelationshipId: constraint.sourceRelationshipId || template.sourceRelationshipId || template.id,
        stackRelationshipBindingKey: key,
        stackId: ownerStackId,
        participantStackIds,
      });
    });
  } else if (template.type === 'extension-constraint') {
    const constraint = {
      ...replacePortableIds(clone(template.payload), replacements),
      id: createUuid(),
      sourceRelationshipId: template.sourceRelationshipId || template.id,
      stackRelationshipBindingKey: key,
      stackId: ownerStackId,
      participantStackIds,
    };
    if (template.extensionKey === 'linkedCopyTools') {
      drawing.extensions.linkedCopyTools ||= { version: 3, copies: [] };
      drawing.extensions.linkedCopyTools.positionConstraints ||= [];
      drawing.extensions.linkedCopyTools.positionConstraints.push(constraint);
    }
    if (template.extensionKey === 'swell') {
      drawing.extensions.swell ||= { version: 2, constraints: [] };
      drawing.extensions.swell.constraints ||= [];
      drawing.extensions.swell.constraints.push(constraint);
    }
  }
  bindingKeys.add(key);
  return drawing;
}

export function reconcileDormantStackRelationships(drawingInput) {
  let drawing = clone(drawingInput || {});
  drawing.extensions ||= {};
  drawing.parameters ||= [];
  drawing.constraints ||= [];
  drawing.dimensionAnnotations ||= [];
  const templates = drawing.extensions.stackRelationships?.templates || [];
  const byKey = new Map(templates.map((template) => [`${template.type}:${template.id}`, template]));
  drawing.extensions.stackRelationships = {
    version: STACK_RELATIONSHIP_VERSION,
    templates: [...byKey.values()].map(clone),
  };
  const candidates = candidatesBySource(drawing);
  const bindingKeys = existingBindingKeys(drawing);
  drawing.extensions.stackRelationships.templates.forEach((template) => {
    stackCombinations(sourceStackInstances(template, candidates)).forEach((stackBinding) => {
      drawing = materializeTemplate(drawing, template, stackBinding, candidates, bindingKeys);
    });
  });
  drawing.dimensions = clone(drawing.parameters);
  return drawing;
}

export function pruneDormantStackRelationships(extensionInput, {
  removedSourceStackIds = [],
  remainingSourceStackIds = [],
} = {}) {
  const extension = clone(extensionInput || { version: STACK_RELATIONSHIP_VERSION, templates: [] });
  const removed = new Set(removedSourceStackIds.map(String));
  const remaining = new Set(remainingSourceStackIds.map(String));
  const unavailable = new Set([...removed].filter((sourceStackId) => !remaining.has(sourceStackId)));
  extension.templates = (extension.templates || []).filter((template) => (
    !(template.requiredSourceStackIds || []).some((sourceStackId) => unavailable.has(String(sourceStackId)))
  ));
  return extension;
}
