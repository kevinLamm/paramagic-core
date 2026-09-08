import { GLOBAL_LAYER_ID } from './StackCoordinates.js';
import {
  createUuidAllocator,
  isUuid,
  normalizeUuid,
} from './IdentitySystem.js';

export const IDENTITY_ARCHITECTURE_VERSION = 1;

const clone = (value) => JSON.parse(JSON.stringify(value));

const LINEAGE_KEYS = new Set([
  'sourceDrawingId',
  'sourceStackId',
  'sourceRecordId',
  'sourceDimensionId',
  'sourceDefinitionId',
  'sourceRelationshipId',
]);

const LIVE_REFERENCE_KEYS = new Set([
  'activeClassId',
  'activeStackId',
  'annotationId',
  'appearanceSourceId',
  'arrayId',
  'arrayPaintAnchorRecordId',
  'arraySourceId',
  'arraySourceOwnerId',
  'boundaryId',
  'boundaryRecordId',
  'centerId',
  'centerlineId',
  'classId',
  'constraintId',
  'copyId',
  'cutterId',
  'definitionId',
  'dimensionId',
  'dimensionRef',
  'drivingConstraintId',
  'entityId',
  'linkedCopyId',
  'linkedSourceId',
  'ownerId',
  'ownerRecordId',
  'ownerStackId',
  'paintAfterRecordId',
  'paintAnchorId',
  'paintBeforeRecordId',
  'parameterId',
  'parentId',
  'parentStackId',
  'pieceId',
  'recordId',
  'referenceEntityId',
  'regionId',
  'sourceId',
  'sourceOwnerId',
  'stackId',
  'referenceStackId',
  'movingStackId',
  'swellOwnerId',
  'swellPieceId',
  'swellSourceId',
  'targetId',
  'targetStackId',
]);

const LIVE_REFERENCE_ARRAY_KEYS = new Set([
  'anchorIds',
  'anchorRecordIds',
  'arrayIds',
  'baselineEntityIds',
  'constraintIds',
  'dependentIds',
  'dimensionIds',
  'entityIds',
  'geometryIds',
  'hostIds',
  'linkedCopyIds',
  'memberRecordIds',
  'ownerIds',
  'participantStackIds',
  'recordIds',
  'referencedRecordIds',
  'referencedStackIds',
  'requiredIds',
  'sourceIds',
  'sourceRecordIds',
  'stackIds',
  'subtractFrom',
  'subtractParentIds',
  'targetIds',
]);

const extensionSchemas = new Map();

const STACK_IDENTITY_SCHEMA = Object.freeze({
  liveReferenceKeys: ['activeStackId', 'parentStackId'],
  lineageReferenceKeys: ['sourceDrawingId', 'sourceStackId'],
  targetKindsByKey: {
    activeStackId: ['stack'],
    parentStackId: ['stack'],
  },
});

const CORE_TARGET_KINDS_BY_KEY = Object.freeze({
  activeClassId: ['class'],
  annotationId: ['dimension-annotation'],
  arrayId: ['array-definition'],
  classId: ['class'],
  constraintId: ['constraint', 'linked-position-constraint', 'swell-constraint'],
  copyId: ['linked-copy-definition'],
  dimensionId: ['parameter'],
  dimensionRef: ['parameter'],
  drivingConstraintId: ['constraint', 'linked-position-constraint', 'swell-constraint'],
  linkedCopyId: ['linked-copy-definition'],
  parameterId: ['parameter'],
  parentStackId: ['stack'],
  stackId: ['stack'],
  referenceStackId: ['stack'],
  movingStackId: ['stack'],
  targetStackId: ['stack'],
  constraintIds: ['constraint', 'linked-position-constraint', 'swell-constraint'],
  dimensionIds: ['parameter'],
  linkedCopyIds: ['linked-copy-definition'],
  participantStackIds: ['stack'],
  referencedStackIds: ['stack'],
  stackIds: ['stack'],
});

function pathText(path) {
  return path.length ? path.join('.') : '<drawing>';
}

function visit(value, visitor, path = [], parentKey = '', omittedRootKeys = null) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, visitor, [...path, String(index)], parentKey));
    return;
  }
  if (!value || typeof value !== 'object') return;
  visitor(value, path, parentKey);
  Object.entries(value).forEach(([key, item]) => {
    if (!path.length && omittedRootKeys?.has(key)) return;
    visit(item, visitor, [...path, key], key);
  });
}

function arrayRecordDeclarations(value, path, result, kind) {
  if (!Array.isArray(value)) return;
  value.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !Object.hasOwn(item, 'id')) return;
    result.push({ object: item, key: 'id', value: item.id, path: [...path, String(index), 'id'], kind });
  });
}

function coreDeclarations(drawing) {
  const declarations = [];
  if (Object.hasOwn(drawing, 'drawingId')) {
    declarations.push({ object: drawing, key: 'drawingId', value: drawing.drawingId, path: ['drawingId'], kind: 'drawing' });
  }
  arrayRecordDeclarations(drawing.entities, ['entities'], declarations, 'entity');
  arrayRecordDeclarations(drawing.constraints, ['constraints'], declarations, 'constraint');
  arrayRecordDeclarations(drawing.classes, ['classes'], declarations, 'class');
  const parameterKey = Array.isArray(drawing.parameters) ? 'parameters' : 'dimensions';
  arrayRecordDeclarations(drawing[parameterKey], [parameterKey], declarations, 'parameter');
  const annotationKey = Array.isArray(drawing.dimensionAnnotations) ? 'dimensionAnnotations' : 'annotations';
  arrayRecordDeclarations(drawing[annotationKey], [annotationKey], declarations, 'dimension-annotation');
  arrayRecordDeclarations(drawing.extensions?.stacks?.stacks, ['extensions', 'stacks', 'stacks'], declarations, 'stack');

  const compositeIds = new Map();
  for (const [index, entity] of (drawing.entities || []).entries()) {
    const composite = entity?.composite;
    if (!composite || typeof composite !== 'object' || !composite.id) continue;
    const oldValue = String(composite.id);
    if (!compositeIds.has(oldValue)) {
      const entry = {
        object: composite,
        key: 'id',
        value: composite.id,
        path: ['entities', String(index), 'composite', 'id'],
        kind: 'composite',
      };
      compositeIds.set(oldValue, entry);
      declarations.push(entry);
    }
  }

  const extensions = drawing.extensions || {};
  Object.entries(extensions).forEach(([extensionKey, extensionValue]) => {
    if (extensionKey === 'stacks') return;
    const schema = extensionSchemas.get(extensionKey);
    if (schema?.declarations) {
      for (const declaration of schema.declarations(extensionValue, drawing) || []) declarations.push(declaration);
      return;
    }
    visit(extensionValue, (object, path, parentKey) => {
      if (!Object.hasOwn(object, 'id') || !/^\d+$/.test(path.at(-1) || '')) return;
      declarations.push({
        object,
        key: 'id',
        value: object.id,
        path: ['extensions', extensionKey, ...path, 'id'],
        extensionKey,
        inferred: true,
        kind: null,
        parentKey,
      });
    });
  });
  return declarations;
}

function descriptorReferences(value, path, descriptor = {}, { omitRootKeys = [] } = {}) {
  const references = [];
  const liveKeys = new Set(descriptor.liveReferenceKeys || []);
  const liveArrayKeys = new Set(descriptor.liveReferenceArrayKeys || []);
  const lineageKeys = new Set(descriptor.lineageReferenceKeys || []);
  const lineageArrayKeys = new Set(descriptor.lineageReferenceArrayKeys || []);
  const targetKindsByKey = descriptor.targetKindsByKey || {};
  visit(value, (object, relativePath) => {
    Object.entries(object).forEach(([key, value]) => {
      const lineage = lineageKeys.has(key);
      if ((lineage || liveKeys.has(key)) && value != null && value !== '') {
        references.push({
          object,
          key,
          value,
          path: [...path, ...relativePath, key],
          lineage,
          array: false,
          expectedKinds: targetKindsByKey[key] || null,
        });
      } else if ((lineageArrayKeys.has(key) || liveArrayKeys.has(key)) && Array.isArray(value)) {
        value.forEach((item, index) => {
          if (item == null || item === '' || typeof item !== 'string') return;
          references.push({
            object: value,
            key: index,
            value: item,
            path: [...path, ...relativePath, key, String(index)],
            lineage: lineageArrayKeys.has(key),
            array: true,
            expectedKinds: targetKindsByKey[key] || null,
          });
        });
      }
    });
  }, [], '', new Set(omitRootKeys));
  return references;
}

function coreReferenceEntries(drawing) {
  const references = [];
  references.push(...descriptorReferences(drawing, [], {
    liveReferenceKeys: LIVE_REFERENCE_KEYS,
    liveReferenceArrayKeys: LIVE_REFERENCE_ARRAY_KEYS,
    lineageReferenceKeys: LINEAGE_KEYS,
    targetKindsByKey: CORE_TARGET_KINDS_BY_KEY,
  }, { omitRootKeys: ['extensions'] }));
  const stacks = drawing.extensions?.stacks;
  if (stacks) references.push(...descriptorReferences(stacks, ['extensions', 'stacks'], STACK_IDENTITY_SCHEMA));
  return references;
}

function extensionReferenceEntries(drawing) {
  return Object.entries(drawing.extensions || {}).flatMap(([extensionKey, value]) => {
    if (extensionKey === 'stacks') return [];
    const descriptor = extensionSchemas.get(extensionKey);
    if (!descriptor) return [];
    return descriptorReferences(value, ['extensions', extensionKey], descriptor);
  });
}

function compositeIdentityReferences(drawing) {
  const references = [];
  const seen = new Set();
  (drawing.entities || []).forEach((entity, index) => {
    const composite = entity?.composite;
    if (!composite || typeof composite !== 'object' || !composite.id) return;
    const value = String(composite.id);
    if (!seen.has(value)) {
      seen.add(value);
      return;
    }
    references.push({
      object: composite,
      key: 'id',
      value,
      path: ['entities', String(index), 'composite', 'id'],
      lineage: false,
      array: false,
    });
  });
  return references;
}

function referenceEntries(drawing) {
  return [
    ...coreReferenceEntries(drawing),
    ...extensionReferenceEntries(drawing),
    ...compositeIdentityReferences(drawing),
  ];
}

function unclassifiedExtensionIdentityEntries(drawing, declarations, references) {
  const classified = new WeakMap();
  const mark = ({ object, key }) => {
    if (!object || (typeof object !== 'object' && typeof object !== 'function')) return;
    const keys = classified.get(object) || new Set();
    keys.add(String(key));
    classified.set(object, keys);
  };
  declarations.forEach(mark);
  references.forEach(mark);
  const result = [];
  Object.entries(drawing.extensions || {}).forEach(([extensionKey, value]) => {
    if (extensionKey === 'stacks') return;
    const descriptor = extensionSchemas.get(extensionKey) || {};
    const classifiedNames = new Set([
      ...(descriptor.liveReferenceKeys || []),
      ...(descriptor.liveReferenceArrayKeys || []),
      ...(descriptor.lineageReferenceKeys || []),
      ...(descriptor.lineageReferenceArrayKeys || []),
      ...(descriptor.externalIdentityKeys || []),
    ]);
    visit(value, (object, path) => {
      Object.keys(object).forEach((key) => {
        if (key !== 'id' && !/Ids?$/.test(key)) return;
        if (classifiedNames.has(key)) return;
        if (classified.get(object)?.has(key)) return;
        result.push({ extensionKey, path: ['extensions', extensionKey, ...path, key], value: object[key] });
      });
    });
  });
  return result;
}

function allocateDeclarationMap(drawing, { preserveCanonical = true, allocator = null } = {}) {
  const declarations = coreDeclarations(drawing);
  const canonicalValues = declarations
    .map(({ value }) => normalizeUuid(value))
    .filter(Boolean);
  const uuidAllocator = allocator || createUuidAllocator(canonicalValues);
  const idMap = new Map();
  const declarationByOldValue = new Map();
  const errors = [];

  declarations.forEach((declaration) => {
    const oldValue = String(declaration.value ?? '').trim();
    if (!oldValue) {
      declaration.object[declaration.key] = uuidAllocator.allocate();
      return;
    }
    if (declarationByOldValue.has(oldValue) && declarationByOldValue.get(oldValue).object !== declaration.object) {
      errors.push({
        code: 'duplicate-legacy-id',
        path: pathText(declaration.path),
        value: oldValue,
        message: `Identity ${JSON.stringify(oldValue)} is declared more than once.`,
      });
      return;
    }
    declarationByOldValue.set(oldValue, declaration);
    const normalized = normalizeUuid(oldValue);
    const next = preserveCanonical && normalized ? normalized : uuidAllocator.allocate();
    idMap.set(oldValue, next);
    declaration.object[declaration.key] = next;
  });
  return { declarations, idMap, allocator: uuidAllocator, errors };
}

function remapReferences(drawing, idMap, allocator, {
  preserveUnknownCanonical = true,
  remapLineage = true,
  extraReferences = [],
} = {}) {
  const lineageMap = new Map();
  const unresolved = [];
  [...referenceEntries(drawing), ...extraReferences].forEach((reference) => {
    const oldValue = String(reference.value ?? '').trim();
    let next = reference.lineage && !remapLineage ? normalizeUuid(oldValue) : idMap.get(oldValue);
    if (!next && reference.lineage) {
      const normalized = normalizeUuid(oldValue);
      next = normalized || lineageMap.get(oldValue) || allocator.allocate();
      lineageMap.set(oldValue, next);
    }
    if (!next && preserveUnknownCanonical) next = normalizeUuid(oldValue);
    if (!next) {
      unresolved.push({
        code: 'unresolved-reference',
        path: pathText(reference.path),
        value: oldValue,
        message: `Reference ${JSON.stringify(oldValue)} does not resolve to a declared identity.`,
      });
      return;
    }
    reference.object[reference.key] = next;
  });
  return { lineageMap, unresolved };
}

export function registerIdentitySchema(extensionKey, descriptor) {
  const key = String(extensionKey || '').trim();
  if (!key) throw new Error('An extension identity schema requires a key.');
  if (!descriptor || typeof descriptor !== 'object') throw new Error(`Identity schema ${key} is invalid.`);
  extensionSchemas.set(key, descriptor);
  return () => extensionSchemas.delete(key);
}

export function registeredIdentitySchemaKeys() {
  return Object.freeze([...extensionSchemas.keys()].sort());
}

export function migrateDrawingIdentities(input = {}, {
  preserveCanonical = true,
  allowUnresolvedLegacyReferences = true,
} = {}) {
  const drawing = clone(input || {});
  if (!drawing.drawingId) drawing.drawingId = '';
  const compositeReferences = compositeIdentityReferences(drawing);
  const allocated = allocateDeclarationMap(drawing, { preserveCanonical });
  const remapped = remapReferences(drawing, allocated.idMap, allocated.allocator, {
    extraReferences: compositeReferences,
  });
  drawing.identityArchitectureVersion = IDENTITY_ARCHITECTURE_VERSION;
  const errors = [
    ...allocated.errors,
    ...(allowUnresolvedLegacyReferences ? [] : remapped.unresolved),
  ];
  return {
    drawing,
    idMap: allocated.idMap,
    lineageMap: remapped.lineageMap,
    unresolved: remapped.unresolved,
    errors,
  };
}

export function remapDrawingIdentityGraph(input = {}, {
  preserveDrawingId = false,
  sharedIds = [],
  identityMap = null,
} = {}) {
  const drawing = clone(input || {});
  const compositeReferences = compositeIdentityReferences(drawing);
  const shared = new Set([GLOBAL_LAYER_ID, ...sharedIds].map((value) => normalizeUuid(value)).filter(Boolean));
  const declarations = coreDeclarations(drawing);
  const allocator = createUuidAllocator([
    ...shared,
    ...declarations.map(({ value }) => normalizeUuid(value)).filter(Boolean),
  ]);
  const idMap = identityMap instanceof Map ? identityMap : new Map(identityMap || []);
  declarations.forEach((declaration) => {
    const oldValue = String(declaration.value ?? '').trim();
    if (!oldValue) {
      declaration.object[declaration.key] = allocator.allocate();
      return;
    }
    const normalized = normalizeUuid(oldValue);
    const requested = normalizeUuid(idMap.get(oldValue));
    const keep = requested
      || ((declaration.key === 'drawingId' && preserveDrawingId) || (normalized && shared.has(normalized))
        ? normalized
        : null);
    const next = keep || allocator.allocate();
    idMap.set(oldValue, next);
    declaration.object[declaration.key] = next;
  });
  remapReferences(drawing, idMap, allocator, {
    remapLineage: false,
    extraReferences: compositeReferences,
  });
  drawing.identityArchitectureVersion = IDENTITY_ARCHITECTURE_VERSION;
  return { drawing, idMap };
}

export function cloneDrawingIdentityGraph(input = {}, options = {}) {
  return remapDrawingIdentityGraph(input, {
    ...options,
    preserveDrawingId: false,
  });
}

export function createDrawingIdentityIndex(input = {}) {
  const declarations = coreDeclarations(input);
  const byId = new Map();
  const duplicateIds = new Set();
  const byKind = new Map();
  declarations.forEach((declaration) => {
    const id = normalizeUuid(declaration.value);
    if (!id) return;
    if (byId.has(id) && byId.get(id).object !== declaration.object) duplicateIds.add(id);
    else byId.set(id, declaration);
    if (declaration.kind) {
      if (!byKind.has(declaration.kind)) byKind.set(declaration.kind, new Map());
      byKind.get(declaration.kind).set(id, declaration);
    }
  });
  return { byId, byKind, duplicateIds, declarations };
}

export function identityAudit(input = {}, { allowExternalLineage = true } = {}) {
  const errors = [];
  const index = createDrawingIdentityIndex(input);
  const references = referenceEntries(input);
  index.declarations.forEach((declaration) => {
    if (declaration.inferred) {
      errors.push({
        code: 'unregistered-extension-identity',
        path: pathText(declaration.path),
        value: declaration.value,
        message: `Extension ${JSON.stringify(declaration.extensionKey)} declares an identity without an identity schema.`,
      });
    }
    if (!isUuid(declaration.value)) {
      errors.push({
        code: 'invalid-declaration-id',
        path: pathText(declaration.path),
        value: declaration.value,
        message: `Declared identity at ${pathText(declaration.path)} is not a UUID.`,
      });
    }
  });
  index.duplicateIds.forEach((id) => errors.push({
    code: 'duplicate-id',
    value: id,
    message: `UUID ${id} is declared more than once.`,
  }));
  references.forEach((reference) => {
    const value = normalizeUuid(reference.value);
    if (!value) {
      errors.push({
        code: 'invalid-reference-id',
        path: pathText(reference.path),
        value: reference.value,
        message: `Reference at ${pathText(reference.path)} is not a UUID.`,
      });
      return;
    }
    if (!reference.lineage && !index.byId.has(value)) {
      errors.push({
        code: 'dangling-reference-id',
        path: pathText(reference.path),
        value,
        message: `Reference at ${pathText(reference.path)} does not resolve.`,
      });
    }
    const target = !reference.lineage ? index.byId.get(value) : null;
    if (target && reference.expectedKinds?.length && !reference.expectedKinds.includes(target.kind)) {
      errors.push({
        code: 'wrong-reference-target-kind',
        path: pathText(reference.path),
        value,
        actualKind: target.kind,
        expectedKinds: [...reference.expectedKinds],
        message: `Reference at ${pathText(reference.path)} resolves to ${target.kind || 'an unclassified record'}; expected ${reference.expectedKinds.join(' or ')}.`,
      });
    }
    if (reference.lineage && !allowExternalLineage && !index.byId.has(value)) {
      errors.push({
        code: 'external-lineage-id',
        path: pathText(reference.path),
        value,
        message: `Lineage reference at ${pathText(reference.path)} is external.`,
      });
    }
  });
  unclassifiedExtensionIdentityEntries(input, index.declarations, references).forEach((entry) => {
    errors.push({
      code: 'unclassified-extension-identity-field',
      path: pathText(entry.path),
      value: entry.value,
      message: `Extension ${JSON.stringify(entry.extensionKey)} has an unclassified identity field at ${pathText(entry.path)}.`,
    });
  });
  if (Number(input.identityArchitectureVersion) >= IDENTITY_ARCHITECTURE_VERSION) {
    const roleRules = [
      { records: input.classes, role: 'default-class', label: 'Default Class' },
      { records: input.extensions?.stacks?.stacks, role: 'default-stack', label: 'Default Stack' },
    ];
    roleRules.forEach(({ records, role, label }) => {
      const matches = Array.isArray(records) ? records.filter(({ systemRole }) => systemRole === role) : [];
      if (matches.length === 1) return;
      errors.push({
        code: matches.length ? 'duplicate-system-role' : 'missing-system-role',
        role,
        message: `${label} role must resolve to exactly one live record; found ${matches.length}.`,
      });
    });
  }
  return { valid: errors.length === 0, errors, index };
}

export function validateDrawingIdentityGraph(input = {}, options = {}) {
  const audit = identityAudit(input, options);
  if (!audit.valid) {
    const first = audit.errors[0];
    throw new Error(`Drawing identity validation failed: ${first.message}`);
  }
  return audit.index;
}
