import { GLOBAL_LAYER_ID } from './StackCoordinates.js';
import { normalizeDrawingData, normalizeDrawingDataWithIdentityMap } from './DrawingIO.js';
import { hydratePortableImageAssets } from './ImageSystem.js';
import { normalizeSeamLineExtension } from './SeamLineSystem.js';
import {
  DEFAULT_STACK_ROLE,
  DRAWING_NODE_KIND,
  defaultStackId,
  descendantStackIds,
  normalizeStackArchitectureState,
  subtreeStackIds,
} from './StackArchitecture.js';
import { dimensionDisplayName } from './NamingSystem.js';
import {
  prepareStackClipboardDimensions,
  retargetStackClipboardDimensions,
} from './StackClipboardSystem.js';
import { createDormantStackRelationships } from './StackRelationshipSystem.js';
import { expressionSymbolReferences } from './solver/ParameterRepository.js';

export const PARAMAGIC_CLIPBOARD_FORMAT = 'ParaMagic Clipboard';
export const PARAMAGIC_CLIPBOARD_VERSION = 1;

const clone = (value) => JSON.parse(JSON.stringify(value));

function unique(values = []) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function collectMatchingStrings(value, candidates, result = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectMatchingStrings(item, candidates, result));
    return result;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && candidates.has(value)) result.add(value);
    return result;
  }
  Object.values(value).forEach((item) => collectMatchingStrings(item, candidates, result));
  return result;
}

function entityDependencyRefs(entity, knownEntityIds) {
  const refs = collectMatchingStrings(entity, knownEntityIds);
  refs.delete(entity?.id);
  return refs;
}

function isUpstreamFeature(entity) {
  return entity?.type === 'fillet'
    || entity?.type === 'notch'
    || entity?.composite?.kind === 'finish-size-offset'
    || entity?.composite?.kind === 'symmetric-centerline';
}

function isAutomaticDependent(entity) {
  return entity?.type === 'fillet'
    || entity?.type === 'notch'
    || entity?.composite?.kind === 'finish-size-offset';
}

function expressionSources(value, key) {
  if (typeof value !== 'string') return [];
  if (key === 'text') {
    const fields = [...value.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1].trim()).filter(Boolean);
    return fields.length ? fields : [];
  }
  return key === 'expression' || /Expression$/.test(key) ? [value] : [];
}

function collectParameterReferences(value, symbolsForStack, result = new Set(), contextStackId = null, key = '') {
  if (Array.isArray(value)) {
    value.forEach((item) => collectParameterReferences(item, symbolsForStack, result, contextStackId, key));
    return result;
  }
  if (value && typeof value === 'object') {
    const nextContext = value.stackId || contextStackId;
    Object.entries(value).forEach(([childKey, item]) => {
      collectParameterReferences(item, symbolsForStack, result, nextContext, childKey);
    });
    return result;
  }
  expressionSources(value, key).forEach((expression) => {
    try {
      expressionSymbolReferences(expression, symbolsForStack(contextStackId))
        .forEach(({ parameterId }) => { if (parameterId) result.add(parameterId); });
    } catch {
      // Invalid expressions retain their stored error state; valid references elsewhere are still copied.
    }
  });
  return result;
}

export function createClipboardPackage(snapshotInput, {
  entityIds = [],
  arrayIds = [],
  linkedCopyIds = [],
  stackIds = null,
  label = 'ParaMagic Selection',
} = {}) {
  const normalized = normalizeDrawingDataWithIdentityMap(snapshotInput);
  const snapshot = normalized.drawing;
  const canonicalId = (value) => normalized.idMap.get(String(value)) || String(value);
  const stackState = normalizeStackArchitectureState(snapshot.extensions?.stacks);
  const fallbackStackId = defaultStackId(stackState);
  const includedStackIds = stackIds ? new Set(unique(stackIds)) : null;
  const packageRootStackId = includedStackIds ? unique(stackIds)[0] : null;
  const packageStacks = includedStackIds
    ? stackState.stacks.filter(({ id }) => includedStackIds.has(id)).map((stack) => ({
      ...clone(stack),
      parentStackId: includedStackIds.has(stack.parentStackId) ? stack.parentStackId : null,
      ...(stack.id === packageRootStackId
        ? { systemRole: DEFAULT_STACK_ROLE, removable: false }
        : { systemRole: undefined, removable: true }),
    }))
    : clone(stackState.stacks);
  const packageStackState = normalizeStackArchitectureState({
    version: stackState.version,
    activeStackId: packageStacks.some(({ id }) => id === stackState.activeStackId)
      ? stackState.activeStackId
      : packageStacks[0]?.id,
    stacks: packageStacks,
  });
  const entityMap = new Map(snapshot.entities.filter(({ id }) => id).map((entity) => [entity.id, entity]));
  const annotationMap = new Map(snapshot.dimensionAnnotations.filter(({ id }) => id).map((entity) => [entity.id, entity]));
  const knownEntityIds = new Set([...entityMap.keys()]);
  const includedIds = new Set(unique(entityIds).map(canonicalId).filter((id) => entityMap.has(id)));
  const inferOwnedFeatures = includedIds.size > 0;
  const explicitAnnotationIds = new Set(unique(entityIds).map(canonicalId).filter((id) => annotationMap.has(id)));
  const arrayDefinitions = snapshot.extensions?.arrayTools?.arrays || [];
  const includedArrayIds = new Set(unique(arrayIds).map(canonicalId)
    .filter((id) => arrayDefinitions.some((definition) => definition.id === id)));
  const linkedCopyDefinitions = snapshot.extensions?.linkedCopyTools?.copies || [];
  const includedLinkedCopyIds = new Set(unique(linkedCopyIds).map(canonicalId)
    .filter((id) => linkedCopyDefinitions.some((definition) => definition.id === id)));

  explicitAnnotationIds.forEach((annotationId) => {
    collectMatchingStrings(annotationMap.get(annotationId), knownEntityIds).forEach((id) => includedIds.add(id));
  });

  let changed = true;
  while (changed) {
    changed = false;
    arrayDefinitions.forEach((definition) => {
      if (!includedArrayIds.has(definition.id)) return;
      definition.sourceIds?.forEach((id) => {
        if (!entityMap.has(id) || includedIds.has(id)) return;
        includedIds.add(id);
        changed = true;
      });
      definition.sourceRefs?.forEach((reference) => {
        if (reference?.kind === 'array-placement') {
          const sourceArrayId = String(reference.arrayId || '');
          if (
            arrayDefinitions.some(({ id }) => id === sourceArrayId)
            && !includedArrayIds.has(sourceArrayId)
          ) {
            includedArrayIds.add(sourceArrayId);
            changed = true;
          }
        }
        if (reference?.kind === 'linked-copy') {
          const sourceCopyId = String(reference.copyId || '');
          if (
            linkedCopyDefinitions.some(({ id }) => id === sourceCopyId)
            && !includedLinkedCopyIds.has(sourceCopyId)
          ) {
            includedLinkedCopyIds.add(sourceCopyId);
            changed = true;
          }
        }
        const sourceEntityIds = reference?.kind === 'swell-piece'
          ? [reference.ownerId]
          : reference?.kind === 'seam-line'
            ? (reference.sourceFeatures || []).flatMap((feature) => [feature.sourceId, feature.recordId])
            : [];
        sourceEntityIds.filter(Boolean).forEach((id) => {
          if (!entityMap.has(id) || includedIds.has(id)) return;
          includedIds.add(id);
          changed = true;
        });
      });
      const centerId = definition.centerRef?.recordId;
      if (entityMap.has(centerId) && !includedIds.has(centerId)) {
        includedIds.add(centerId);
        changed = true;
      }
    });
    linkedCopyDefinitions.forEach((definition) => {
      if (!includedLinkedCopyIds.has(definition.id)) return;
      definition.sourceIds?.forEach((id) => {
        if (!entityMap.has(id) || includedIds.has(id)) return;
        includedIds.add(id);
        changed = true;
      });
    });
    [...includedIds].forEach((id) => {
      const entity = entityMap.get(id);
      if (!isUpstreamFeature(entity)) return;
      entityDependencyRefs(entity, knownEntityIds).forEach((dependencyId) => {
        if (includedIds.has(dependencyId)) return;
        includedIds.add(dependencyId);
        changed = true;
      });
    });
    entityMap.forEach((entity, id) => {
      if (includedIds.has(id) || !isAutomaticDependent(entity)) return;
      const refs = entityDependencyRefs(entity, knownEntityIds);
      if (refs.size && [...refs].every((ref) => includedIds.has(ref))) {
        includedIds.add(id);
        changed = true;
      }
    });
    arrayDefinitions.forEach((definition) => {
      if (!inferOwnedFeatures || includedArrayIds.has(definition.id)) return;
      const sourceIds = unique(definition.sourceIds);
      if (!sourceIds.length || !sourceIds.every((id) => includedIds.has(id))) return;
      includedArrayIds.add(definition.id);
      changed = true;
    });
    linkedCopyDefinitions.forEach((definition) => {
      if (!inferOwnedFeatures || includedLinkedCopyIds.has(definition.id)) return;
      const sourceIds = unique(definition.sourceIds);
      if (!sourceIds.length || !sourceIds.every((id) => includedIds.has(id))) return;
      includedLinkedCopyIds.add(definition.id);
      changed = true;
    });
  }

  const arrays = arrayDefinitions
    .filter(({ id }) => includedArrayIds.has(id))
    .map((definition) => ({
      ...clone(definition),
      sourceDefinitionId: definition.sourceDefinitionId || definition.id,
      sourceStackId: definition.sourceStackId || definition.stackId || fallbackStackId,
    }));
  const linkedCopies = linkedCopyDefinitions
    .filter(({ id }) => includedLinkedCopyIds.has(id))
    .map((definition) => ({
      ...clone(definition),
      sourceDefinitionId: definition.sourceDefinitionId || definition.id,
      sourceStackId: definition.sourceStackId || definition.stackId || fallbackStackId,
    }));
  const entities = snapshot.entities.filter(({ id }) => includedIds.has(id)).map(clone);
  const dimensionAnnotations = snapshot.dimensionAnnotations.filter((annotation) => {
    if (explicitAnnotationIds.has(annotation.id)) return true;
    const refs = collectMatchingStrings(annotation, knownEntityIds);
    return refs.size > 0 && [...refs].every((id) => includedIds.has(id));
  }).map(clone);

  const constraints = snapshot.constraints.filter((constraint) => {
    const refs = collectMatchingStrings(constraint, knownEntityIds);
    return refs.size > 0 && [...refs].every((id) => includedIds.has(id));
  }).map(clone);

  const globalParameterByName = new Map(snapshot.parameters
    .filter(({ kind, name }) => kind !== 'dimension' && name)
    .map((entry) => [entry.name, entry]));
  const parameterById = new Map(snapshot.parameters.filter(({ id }) => id).map((entry) => [entry.id, entry]));
  const globalSymbols = snapshot.parameters
    .filter(({ kind, name }) => kind !== 'dimension' && name)
    .map((entry) => ({ name: entry.name, parameterId: entry.id, caseInsensitive: false }));
  const qualifiedDimensionSymbols = snapshot.parameters
    .filter(({ kind, name }) => kind === 'dimension' && name)
    .map((entry) => ({
      name: dimensionDisplayName(entry, stackState),
      parameterId: entry.id,
      caseInsensitive: true,
    }));
  const localDimensionSymbols = new Map();
  snapshot.parameters.filter(({ kind, name }) => kind === 'dimension' && name).forEach((entry) => {
    const ownerStackId = entry.stackId || fallbackStackId;
    if (!localDimensionSymbols.has(ownerStackId)) localDimensionSymbols.set(ownerStackId, []);
    localDimensionSymbols.get(ownerStackId).push({
      name: entry.name,
      parameterId: entry.id,
      caseInsensitive: true,
    });
  });
  const symbolsForStack = (stackId) => [
    ...globalSymbols,
    ...qualifiedDimensionSymbols,
    ...(stackId ? localDimensionSymbols.get(stackId) || [] : []),
  ];
  const requiredParameterIds = collectParameterReferences(
    { entities, constraints, dimensionAnnotations, arrays, linkedCopies, stacks: packageStackState.stacks },
    symbolsForStack,
  );
  dimensionAnnotations.forEach((annotation) => {
    const parameter = parameterById.get(annotation.dimensionId);
    if (parameter?.id) requiredParameterIds.add(parameter.id);
  });
  entities.filter(({ type }) => type === 'control').forEach((entity) => {
    const parameter = parameterById.get(entity.parameterId) || globalParameterByName.get(entity.parameterName);
    if (parameter?.id) requiredParameterIds.add(parameter.id);
  });
  changed = true;
  while (changed) {
    changed = false;
    [...requiredParameterIds].forEach((parameterId) => {
      const parameter = parameterById.get(parameterId);
      collectParameterReferences(
        { expression: parameter?.expression },
        symbolsForStack,
        new Set(),
        parameter?.kind === 'dimension' ? parameter.stackId || fallbackStackId : null,
      ).forEach((dependencyId) => {
        if (requiredParameterIds.has(dependencyId)) return;
        requiredParameterIds.add(dependencyId);
        changed = true;
      });
    });
  }
  const includedDimensionIds = new Set([
    ...dimensionAnnotations.map(({ dimensionId }) => dimensionId).filter(Boolean),
    ...(includedStackIds ? snapshot.parameters
      .filter(({ kind, stackId }) => kind === 'dimension' && includedStackIds.has(stackId || fallbackStackId))
      .map(({ id }) => id) : []),
  ]);
  includedDimensionIds.forEach((dimensionId) => requiredParameterIds.add(dimensionId));
  const parameters = snapshot.parameters.filter((parameter) => (
    requiredParameterIds.has(parameter.id)
    && (parameter.kind !== 'dimension' || includedDimensionIds.has(parameter.id))
  )).map(clone);
  const extensions = {};
  if (arrays.length) {
    extensions.arrayTools = {
      version: snapshot.extensions?.arrayTools?.version || 3,
      arrays,
    };
  }
  if (linkedCopies.length) {
    const positionConstraints = (snapshot.extensions?.linkedCopyTools?.positionConstraints || [])
      .filter((constraint) => {
        if (!includedLinkedCopyIds.has(constraint.externalDrivingTarget?.copyId)) return false;
        const refs = collectMatchingStrings(constraint, knownEntityIds);
        return [...refs].every((id) => includedIds.has(id));
      })
      .map(clone);
    extensions.linkedCopyTools = {
      version: snapshot.extensions?.linkedCopyTools?.version || 1,
      copies: linkedCopies,
      ...(positionConstraints.length ? { positionConstraints } : {}),
    };
  }
  const swellConstraints = (snapshot.extensions?.swell?.constraints || [])
    .filter((constraint) => {
      const refs = collectMatchingStrings(constraint, knownEntityIds);
      return refs.size > 0 && [...refs].every((id) => includedIds.has(id));
    })
    .map(clone);
  if (swellConstraints.length) extensions.swell = {
    version: snapshot.extensions?.swell?.version || 1,
    constraints: swellConstraints,
  };
  const seamDefinitions = normalizeSeamLineExtension(snapshot.extensions?.seamLines).definitions
    .filter((definition) => (
      includedIds.has(definition.regionId)
      || (definition.recordIds.length > 0 && definition.recordIds.every((id) => includedIds.has(id)))
    ));
  if (seamDefinitions.length) {
    extensions.seamLines = {
      version: 2,
      definitions: seamDefinitions,
    };
  }
  extensions.stacks = packageStackState;
  const dormantRelationships = createDormantStackRelationships(snapshot, [...includedIds]);
  if (dormantRelationships.templates.length) extensions.stackRelationships = dormantRelationships;
  const preparedDimensions = prepareStackClipboardDimensions({
    stackArchitectureVersion: snapshot.stackArchitectureVersion,
    drawingUnit: snapshot.drawingUnit,
    dxfExportUnit: snapshot.dxfExportUnit,
    filletRadius: snapshot.filletRadius,
    documentMetadata: clone(snapshot.documentMetadata || {}),
    classes: clone(snapshot.classes || []),
    activeClassId: snapshot.activeClassId || null,
    entities,
    constraints,
    parameters,
    dimensionAnnotations,
    ...(Object.keys(extensions).length ? { extensions } : {}),
  }, {
    parameters: snapshot.parameters,
    requiredParameterIds,
    includedDimensionIds,
    stackState,
  });
  return {
    format: PARAMAGIC_CLIPBOARD_FORMAT,
    version: PARAMAGIC_CLIPBOARD_VERSION,
    label,
    ...(preparedDimensions.externalDimensionReferences.length
      ? { externalDimensionReferences: preparedDimensions.externalDimensionReferences }
      : {}),
    drawing: preparedDimensions.drawing,
  };
}

export function parseClipboardPackage(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : clone(value);
  if (parsed?.format !== PARAMAGIC_CLIPBOARD_FORMAT || Number(parsed.version) !== PARAMAGIC_CLIPBOARD_VERSION) {
    throw new Error('The clipboard does not contain a supported ParaMagic object package.');
  }
  return { ...parsed, drawing: normalizeDrawingData(parsed.drawing) };
}

export function retargetClipboardDrawing(packageInput, stackId, targetStackState = null) {
  const packageValue = parseClipboardPackage(packageInput);
  const drawing = clone(packageValue.drawing);
  const sourceStackState = normalizeStackArchitectureState(drawing.extensions?.stacks);
  const resolvedTargetState = normalizeStackArchitectureState(targetStackState || (stackId ? {
    activeStackId: stackId,
    stacks: [{ id: stackId, name: 'Clipboard Target', visible: true }],
  } : null));
  const targetStack = resolvedTargetState.stacks.find(({ id }) => id === stackId)
    || resolvedTargetState.stacks.find(({ id }) => id === resolvedTargetState.activeStackId)
    || resolvedTargetState.stacks[0];
  const sourceDimensionById = new Map(drawing.parameters
    .filter(({ kind }) => kind === 'dimension')
    .map((parameter) => [parameter.id, parameter]));
  const dormantDimensionParameters = (drawing.extensions?.stackRelationships?.templates || [])
    .filter(({ type }) => type === 'dimension')
    .map((template) => template.payload?.parameter)
    .filter(Boolean);
  const qualifierDimensions = [...new Map([
    ...drawing.parameters.filter(({ kind }) => kind === 'dimension'),
    ...dormantDimensionParameters,
  ].map((parameter) => [parameter.sourceDimensionId || parameter.id, parameter])).values()];
  const rewritten = retargetStackClipboardDimensions(drawing, {
    copiedDimensions: qualifierDimensions,
    externalDimensionReferences: packageValue.externalDimensionReferences,
    sourceStackState,
    targetStackState: resolvedTargetState,
    targetStack,
  });
  drawing.entities = rewritten.entities.map((entity) => ({
    ...entity,
    sourceRecordId: entity.sourceRecordId || entity.id,
    sourceStackId: entity.sourceStackId || sourceStackState.stacks.find(({ id }) => id === entity.stackId)?.sourceStackId || entity.stackId,
    stackId: targetStack.id,
  }));
  drawing.constraints = rewritten.constraints.map((constraint) => ({
    ...constraint,
    stackId: targetStack.id,
    participantStackIds: [],
  }));
  drawing.parameters = rewritten.parameters.map((parameter) => parameter.kind === 'dimension' ? {
    ...parameter,
    sourceDimensionId: parameter.sourceDimensionId || parameter.id,
    stackId: targetStack.id,
    participantStackIds: [],
  } : parameter);
  drawing.dimensions = clone(drawing.parameters);
  drawing.dimensionAnnotations = rewritten.dimensionAnnotations.map((entity) => ({
    ...entity,
    sourceRelationshipId: entity.sourceRelationshipId || entity.dimensionId || entity.id,
    stackId: targetStack.id,
    participantStackIds: [],
    dimensionName: sourceDimensionById.get(entity.dimensionId)?.name || entity.dimensionName,
  }));
  drawing.extensions = { ...(rewritten.extensions || {}), stacks: {
    version: resolvedTargetState.version,
    activeStackId: targetStack.id,
    stacks: [{ ...targetStack, systemRole: DEFAULT_STACK_ROLE, removable: false }],
  } };
  if (drawing.extensions?.arrayTools?.arrays) {
    drawing.extensions.arrayTools.arrays = drawing.extensions.arrayTools.arrays
      .map((definition) => ({ ...definition, stackId: targetStack.id }));
  }
  if (drawing.extensions?.linkedCopyTools?.copies) {
    drawing.extensions.linkedCopyTools.copies = drawing.extensions.linkedCopyTools.copies
      .map((definition) => ({ ...definition, stackId: targetStack.id }));
  }
  return drawing;
}

export function createStackSubtreePackage(snapshotInput, stackId, { label = null } = {}) {
  const snapshot = normalizeDrawingData(snapshotInput);
  const stackState = normalizeStackArchitectureState(snapshot.extensions?.stacks);
  const selectedStackIds = subtreeStackIds(stackState, stackId);
  if (!selectedStackIds.length) throw new Error(`Stack ${stackId} does not exist.`);
  const owners = new Set(selectedStackIds);
  const entityIds = snapshot.entities
    .filter((entity) => owners.has(entity.stackId || defaultStackId(stackState)))
    .map(({ id }) => id);
  const arrayIds = (snapshot.extensions?.arrayTools?.arrays || [])
    .filter((definition) => owners.has(definition.stackId || defaultStackId(stackState)))
    .map(({ id }) => id);
  const linkedCopyIds = (snapshot.extensions?.linkedCopyTools?.copies || [])
    .filter((definition) => owners.has(definition.stackId || defaultStackId(stackState)))
    .map(({ id }) => id);
  const packageValue = createClipboardPackage(snapshot, {
    entityIds,
    arrayIds,
    linkedCopyIds,
    stackIds: selectedStackIds,
    label: label || stackState.stacks.find(({ id }) => id === stackId)?.name || 'Stack',
  });
  packageValue.drawing.documentContext = {
    ...(packageValue.drawing.documentContext || {}),
    contentKind: 'stack-export',
    displayName: packageValue.label,
  };
  return packageValue;
}

export function createDrawingContainerPackage(snapshotInput, containerId, { label = null } = {}) {
  const snapshot = normalizeDrawingData(snapshotInput);
  const stackState = normalizeStackArchitectureState(snapshot.extensions?.stacks);
  const container = stackState.stacks.find(({ id }) => id === containerId);
  if (container?.kind !== DRAWING_NODE_KIND) {
    throw new Error(`Drawing container ${containerId} does not exist.`);
  }
  const selectedStackIds = descendantStackIds(stackState, containerId);
  if (!selectedStackIds.length) throw new Error(`Drawing container “${container.name}” has no Stacks to export.`);
  const packageValue = createClipboardPackage(snapshot, {
    entityIds: snapshot.entities.filter(({ stackId }) => selectedStackIds.includes(stackId)).map(({ id }) => id),
    arrayIds: (snapshot.extensions?.arrayTools?.arrays || [])
      .filter(({ stackId }) => selectedStackIds.includes(stackId)).map(({ id }) => id),
    linkedCopyIds: (snapshot.extensions?.linkedCopyTools?.copies || [])
      .filter(({ stackId }) => selectedStackIds.includes(stackId)).map(({ id }) => id),
    stackIds: selectedStackIds,
    label: label || container.name || 'Drawing',
  });
  packageValue.drawing.documentContext = {
    ...(packageValue.drawing.documentContext || {}),
    contentKind: 'drawing',
    displayName: packageValue.label,
  };
  return packageValue;
}

export function createDrawingClipboard({
  canvas,
  arrayTools = null,
  linkedCopyTools = null,
  symmetricTool = null,
  cutButton = null,
  copyButton = null,
  pasteButton = null,
  importAsset = null,
  onStatus = () => {},
} = {}) {
  let internalText = '';

  function selection() {
    const entityIds = canvas.getSelectedRecordIds();
    const legacyCenterlineId = symmetricTool?.selectedCenterlineId?.();
    if (legacyCenterlineId && !entityIds.includes(legacyCenterlineId)) entityIds.push(legacyCenterlineId);
    const selectedArray = arrayTools?.selectedDefinition?.();
    const selectedLinkedCopy = linkedCopyTools?.selectedDefinition?.();
    return {
      entityIds,
      arrayIds: selectedArray?.id ? [selectedArray.id] : [],
      linkedCopyIds: selectedLinkedCopy?.id ? [selectedLinkedCopy.id] : [],
    };
  }

  function packageForSelection() {
    const selected = selection();
    if (!selected.entityIds.length && !selected.arrayIds.length && !selected.linkedCopyIds.length) return null;
    return createClipboardPackage(canvas.getDrawingData(), selected);
  }

  async function writeText(text) {
    internalText = String(text ?? '');
    try {
      await navigator.clipboard?.writeText?.(internalText);
    } catch {
      // The in-app clipboard remains available when browser clipboard permission is unavailable.
    }
    return internalText;
  }

  async function writePackage(packageValue) {
    await writeText(JSON.stringify(packageValue, null, 2));
    return packageValue;
  }

  async function copy() {
    if (copyButton?.disabled) return false;
    const tableCells = canvas.copySelectedTableCells?.();
    if (tableCells) {
      await writeText(tableCells.text);
      onStatus('Copied table cell contents.');
      return true;
    }
    const packageValue = packageForSelection();
    if (!packageValue) {
      onStatus('Select one or more drawing objects to copy.', true);
      return false;
    }
    await writePackage(packageValue);
    onStatus(`Copied ${packageValue.drawing.entities.length} object${packageValue.drawing.entities.length === 1 ? '' : 's'}.`);
    return true;
  }

  async function cut() {
    if (cutButton?.disabled) return false;
    const tableCells = canvas.cutSelectedTableCells?.();
    if (tableCells) {
      await writeText(tableCells.text);
      onStatus('Cut table cell contents.');
      return true;
    }
    const selected = selection();
    const packageValue = packageForSelection();
    if (!packageValue) {
      onStatus('Select one or more drawing objects to cut.', true);
      return false;
    }
    await writePackage(packageValue);
    const selectedArray = arrayTools?.selectedDefinition?.();
    const selectedLinkedCopy = linkedCopyTools?.selectedDefinition?.();
    if (selectedArray?.id) arrayTools.removeDefinition(selectedArray.id);
    if (selectedLinkedCopy?.id) linkedCopyTools.removeDefinition(selectedLinkedCopy.id);
    const legacyCenterlineId = symmetricTool?.selectedCenterlineId?.();
    const recordIds = unique([...selected.entityIds, legacyCenterlineId]);
    if (recordIds.length) canvas.deleteRecords(recordIds);
    onStatus('Selection cut to the ParaMagic clipboard.');
    return true;
  }

  async function clipboardText() {
    if (internalText) return internalText;
    try {
      return await navigator.clipboard?.readText?.() || '';
    } catch {
      return '';
    }
  }

  async function paste({ stackId = canvas.getActiveStackId() } = {}) {
    const text = await clipboardText();
    if (!text) {
      onStatus('The ParaMagic clipboard is empty.', true);
      return false;
    }
    const tablePaste = canvas.pasteSelectedTableCell?.(text);
    if (tablePaste?.handled) {
      if (tablePaste.changed) onStatus('Pasted table cell contents.');
      return tablePaste;
    }
    let packageValue;
    try {
      packageValue = parseClipboardPackage(text);
    } catch (error) {
      onStatus(error.message, true);
      return false;
    }
    canvas.requestHistoryCheckpoint?.('paste');
    const result = canvas.pasteDrawingData(
      retargetClipboardDrawing(packageValue, stackId, canvas.getStackState?.()),
      { targetStackId: stackId },
    );
    onStatus(`Pasted ${result.count} object${result.count === 1 ? '' : 's'}.`);
    return result;
  }

  function packageForStack(stackId) {
    const snapshot = canvas.getDrawingData();
    const node = canvas.getStackState().stacks.find(({ id }) => id === stackId);
    return node?.kind === DRAWING_NODE_KIND
      ? createDrawingContainerPackage(snapshot, stackId, { label: node.name })
      : createStackSubtreePackage(snapshot, stackId, { label: node?.name || 'Stack' });
  }

  async function importStack(file, { parentStackId = null } = {}) {
    let packageValue;
    try {
      const hydrated = await hydratePortableImageAssets(JSON.parse(await file.text()), { importAsset });
      if (hydrated?.format === PARAMAGIC_CLIPBOARD_FORMAT) {
        packageValue = parseClipboardPackage(hydrated);
      } else {
        packageValue = {
          format: PARAMAGIC_CLIPBOARD_FORMAT,
          version: PARAMAGIC_CLIPBOARD_VERSION,
          label: String(file.name || '').replace(/\.(?:paramagic|json)$/i, '') || 'Stack',
          drawing: normalizeDrawingData(hydrated),
        };
      }
    } catch (error) {
      onStatus(error.message, true);
      return false;
    }
    const drawing = clone(packageValue.drawing);
    const insertAsDrawing = drawing.documentContext?.contentKind !== 'stack-export';
    const sourceStackState = normalizeStackArchitectureState(drawing.extensions?.stacks);
    const sourceRoot = sourceStackState.stacks.find(({ parentStackId }) => !parentStackId);
    if (!insertAsDrawing && sourceRoot?.systemRole === DEFAULT_STACK_ROLE && sourceStackState.stacks.filter(({ id }) => id !== GLOBAL_LAYER_ID).length === 1) {
      sourceRoot.name = packageValue.label || file.name.replace(/\.(?:paramagic|json)$/i, '');
      drawing.extensions = { ...(drawing.extensions || {}), stacks: sourceStackState };
    }
    canvas.requestHistoryCheckpoint?.('insert-stack');
    const result = canvas.pasteDrawingData(drawing, {
      insertParentStackId: parentStackId,
      insertAsDrawing,
      drawingContainerName: packageValue.label,
    });
    const insertedRootId = result.insertedRootNodeIds?.[0] || result.idMap?.get(sourceRoot?.id);
    const insertedName = canvas.getStackState?.().stacks.find(({ id }) => id === insertedRootId)?.name
      || sourceRoot?.name || packageValue.label;
    onStatus(`Inserted ${insertAsDrawing ? 'drawing' : 'Stack'} “${insertedName}” with ${result.count} objects.`);
    return result;
  }

  cutButton?.addEventListener('click', cut);
  copyButton?.addEventListener('click', copy);
  pasteButton?.addEventListener('click', paste);
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    const key = event.key.toLowerCase();
    if (!['x', 'c', 'v'].includes(key)) return;
    if ((key === 'x' && cutButton?.disabled) || (key === 'c' && copyButton?.disabled)) return;
    event.preventDefault();
    if (key === 'x') cut();
    else if (key === 'c') copy();
    else paste();
  });

  return {
    copy,
    cut,
    paste,
    importStack,
    packageForSelection,
    packageForStack,
    expandedRecordIds(entityIds) {
      return createClipboardPackage(canvas.getDrawingData(), { entityIds })
        .drawing.entities.map(({ id }) => id);
    },
    getInternalText: () => internalText,
  };
}
