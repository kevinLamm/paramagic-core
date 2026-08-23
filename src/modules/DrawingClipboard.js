import { normalizeDrawingData } from './DrawingIO.js';
import {
  hydratePortableImageAssets, serializePortablePackageJson,
} from './ImageSystem.js';
import { normalizeSeamLineExtension } from './SeamLineSystem.js';

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

function parameterTokens(value, knownNames, result = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => parameterTokens(item, knownNames, result));
    return result;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => parameterTokens(item, knownNames, result));
    return result;
  }
  if (typeof value !== 'string') return result;
  value.match(/[A-Za-z_][A-Za-z0-9_]*/g)?.forEach((name) => {
    if (knownNames.has(name)) result.add(name);
  });
  return result;
}

export function createClipboardPackage(snapshotInput, {
  entityIds = [],
  arrayIds = [],
  linkedCopyIds = [],
  label = 'ParaMagic Selection',
} = {}) {
  const snapshot = normalizeDrawingData(snapshotInput);
  const entityMap = new Map(snapshot.entities.filter(({ id }) => id).map((entity) => [entity.id, entity]));
  const annotationMap = new Map(snapshot.dimensionAnnotations.filter(({ id }) => id).map((entity) => [entity.id, entity]));
  const knownEntityIds = new Set([...entityMap.keys()]);
  const includedIds = new Set(unique(entityIds).filter((id) => entityMap.has(id)));
  const inferOwnedFeatures = includedIds.size > 0;
  const explicitAnnotationIds = new Set(unique(entityIds).filter((id) => annotationMap.has(id)));
  const arrayDefinitions = snapshot.extensions?.arrayTools?.arrays || [];
  const includedArrayIds = new Set(unique(arrayIds)
    .filter((id) => arrayDefinitions.some((definition) => definition.id === id)));
  const linkedCopyDefinitions = snapshot.extensions?.linkedCopyTools?.copies || [];
  const includedLinkedCopyIds = new Set(unique(linkedCopyIds)
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
    .map(clone);
  const linkedCopies = linkedCopyDefinitions
    .filter(({ id }) => includedLinkedCopyIds.has(id))
    .map(clone);
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

  const parameterByName = new Map(snapshot.parameters.filter(({ name }) => name).map((entry) => [entry.name, entry]));
  const parameterById = new Map(snapshot.parameters.filter(({ id }) => id).map((entry) => [entry.id, entry]));
  const knownNames = new Set(parameterByName.keys());
  const requiredNames = parameterTokens({ entities, dimensionAnnotations, arrays, linkedCopies }, knownNames);
  dimensionAnnotations.forEach((annotation) => {
    const parameter = parameterById.get(annotation.dimensionId);
    if (parameter?.name) requiredNames.add(parameter.name);
  });
  entities.filter(({ type }) => type === 'control').forEach((entity) => {
    const parameter = parameterById.get(entity.parameterId) || parameterByName.get(entity.parameterName);
    if (parameter?.name) requiredNames.add(parameter.name);
  });
  changed = true;
  while (changed) {
    changed = false;
    [...requiredNames].forEach((name) => {
      const parameter = parameterByName.get(name);
      parameterTokens(parameter?.expression, knownNames).forEach((dependencyName) => {
        if (requiredNames.has(dependencyName)) return;
        requiredNames.add(dependencyName);
        changed = true;
      });
    });
  }
  const parameters = snapshot.parameters.filter(({ name }) => requiredNames.has(name)).map(clone);
  const extensions = {};
  if (arrays.length) {
    extensions.arrayTools = {
      version: snapshot.extensions?.arrayTools?.version || 3,
      arrays,
    };
  }
  if (linkedCopies.length) {
    extensions.linkedCopyTools = {
      version: snapshot.extensions?.linkedCopyTools?.version || 1,
      copies: linkedCopies,
    };
  }
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
  const drawing = {
    drawingUnit: snapshot.drawingUnit,
    dxfExportUnit: snapshot.dxfExportUnit,
    filletRadius: snapshot.filletRadius,
    entities,
    constraints,
    parameters,
    dimensionAnnotations,
    ...(Object.keys(extensions).length ? { extensions } : {}),
  };
  return {
    format: PARAMAGIC_CLIPBOARD_FORMAT,
    version: PARAMAGIC_CLIPBOARD_VERSION,
    label,
    drawing,
  };
}

export function parseClipboardPackage(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : clone(value);
  if (parsed?.format !== PARAMAGIC_CLIPBOARD_FORMAT || Number(parsed.version) !== PARAMAGIC_CLIPBOARD_VERSION) {
    throw new Error('The clipboard does not contain a supported ParaMagic object package.');
  }
  return { ...parsed, drawing: normalizeDrawingData(parsed.drawing) };
}

export function retargetClipboardDrawing(packageInput, stackId) {
  const packageValue = parseClipboardPackage(packageInput);
  const drawing = clone(packageValue.drawing);
  drawing.entities = drawing.entities.map((entity) => ({ ...entity, stackId }));
  drawing.dimensionAnnotations = drawing.dimensionAnnotations.map((entity) => ({ ...entity, stackId }));
  delete drawing.extensions?.stacks;
  if (drawing.extensions?.arrayTools?.arrays) {
    drawing.extensions.arrayTools.arrays = drawing.extensions.arrayTools.arrays
      .map((definition) => ({ ...definition, stackId }));
  }
  if (drawing.extensions?.linkedCopyTools?.copies) {
    drawing.extensions.linkedCopyTools.copies = drawing.extensions.linkedCopyTools.copies
      .map((definition) => ({ ...definition, stackId }));
  }
  return drawing;
}

function downloadText(text, name, type) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

function safeName(value, extension) {
  const base = String(value || 'Stack').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Stack';
  return `${base}.${extension}`;
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
  stackExporters = {},
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
    const result = canvas.pasteDrawingData(retargetClipboardDrawing(packageValue, stackId));
    onStatus(`Pasted ${result.count} object${result.count === 1 ? '' : 's'}.`);
    return result;
  }

  function packageForStack(stackId) {
    const snapshot = canvas.getDrawingData();
    const entityIds = snapshot.entities
      .filter((entity) => (entity.stackId || 'stack-default') === stackId)
      .map(({ id }) => id);
    const arrayIds = (snapshot.extensions?.arrayTools?.arrays || [])
      .filter((definition) => (definition.stackId || 'stack-default') === stackId)
      .map(({ id }) => id);
    const linkedCopyIds = (snapshot.extensions?.linkedCopyTools?.copies || [])
      .filter((definition) => (definition.stackId || 'stack-default') === stackId)
      .map(({ id }) => id);
    return createClipboardPackage(snapshot, { entityIds, arrayIds, linkedCopyIds, label: canvas.getStackState().stacks.find(({ id }) => id === stackId)?.name || 'Stack' });
  }

  async function exportStack(stackId, format) {
    const stack = canvas.getStackState().stacks.find(({ id }) => id === stackId);
    if (!stack) return false;
    const packageValue = packageForStack(stackId);
    try {
      const exporter = stackExporters[format];
      if (typeof exporter === 'function') {
        await exporter({
          stack,
          stackId,
          snapshot: canvas.getDrawingData(),
          packageValue,
        });
      } else {
        downloadText(await serializePortablePackageJson(packageValue), safeName(stack.name, 'json'), 'application/x-paramagic+json');
      }
      return true;
    } catch (error) {
      onStatus(`Stack export failed: ${error.message}`, true);
      return false;
    }
  }

  async function importStack(file) {
    let packageValue;
    try {
      packageValue = parseClipboardPackage(await hydratePortableImageAssets(
        JSON.parse(await file.text()), { importAsset },
      ));
    } catch (error) {
      onStatus(error.message, true);
      return false;
    }
    const stack = canvas.addStack(packageValue.label || file.name.replace(/\.json$/i, ''));
    canvas.requestHistoryCheckpoint?.('insert-stack');
    const result = canvas.pasteDrawingData(retargetClipboardDrawing(packageValue, stack.id));
    onStatus(`Inserted stack “${stack.name}” with ${result.count} objects.`);
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
    event.preventDefault();
    if (key === 'x') cut();
    else if (key === 'c') copy();
    else paste();
  });

  return {
    copy,
    cut,
    paste,
    exportStack,
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
