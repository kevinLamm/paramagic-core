import { GLOBAL_LAYER_ID, stackFrameFor, stackFrameMatrix, transformStackEntity, transformStackPoint } from './StackCoordinates.js';
import { evaluateFilletedGeometry } from './FilletSystem.js';
import { createUuid, deriveUuidForKey } from './IdentitySystem.js';
import {
  cloneDrawingIdentityGraph,
  migrateDrawingIdentities,
  remapDrawingIdentityGraph,
  validateDrawingIdentityGraph,
} from './DrawingIdentitySystem.js';
import {
  DXF_BOUNDARY_ENTITY_TYPE,
  dxfBoundaryVertices,
} from './DxfExportGeometry.js';
import { notchDxfLayer, notchFillColor, notchGeometryPoints, notchGeometryPrimitives, notchSvgPath } from './NotchSystem.js';
import { materializeSeamLineEntitiesForDrawing, normalizeSeamLineExtension } from './SeamLineSystem.js';
import {
  arrayDependentVisualIds,
  evaluateArrayCountExpression,
  evaluateArrayDefinition,
} from './ArrayTools.js';
import {
  angleDimensionLayout,
  dimensionExcludedFromExport,
  distanceDimensionLayout,
  mclDimensionLayout,
  radiusDimensionLayout,
  upgradeLegacyParallelEdgeDimensions,
} from './DimensionSystem.js';
import {
  createDxfDimensionPlans,
  DXF_DIMENSION_LAYER,
  DXF_DIMENSION_STYLE,
  DXF_DIMENSION_SIZE,
} from './DxfDimensionExport.js';
import { ParameterRepository } from './solver/ParameterRepository.js';
import {
  imageFillPatternDefinition,
  imageFillPatternId,
  isImageFillReference,
  resolveGeometryFillAppearance,
} from './ImageSystem.js';
import {
  isDuplicableEntity,
  isMirrorableEntity,
  isSymmetricCenterline,
  linkedCopyMatrix,
  reflectionMatrix,
  seamDependsOnSelectedSources,
} from './SymmetricTool.js';
import {
  drawingTextSvgLayout,
  resolveTextFields,
  textHeightInMillimetres,
} from './TextTools.js';
import { migrateSubtractReferences, subtractBoundaryContours, subtractDrawingResults } from './SubtractSystem.js';
import { resolveClosedBoundaries } from './BoundaryTopology.js';
import {
  formatDxfDimensionValue,
  formatUnitlessValue,
  formatValueOnlyDimensionValue,
} from './solver/Units.js';
import { entityStackId, normalizeStackState } from './StackSystem.js';
import {
  DRAWING_NODE_KIND,
  STACK_ARCHITECTURE_VERSION,
  createStackId,
  defaultStackId,
  migrateStackArchitecture,
  normalizeStackArchitectureState,
} from './StackArchitecture.js';
import {
  nextAvailableParameterName,
  parameterNameKey,
  qualifiedDimensionName,
  rewriteExpressionSymbolReferences,
  rewriteQualifiedDimensionReferences,
  uniqueStackName,
} from './NamingSystem.js';
import { filterVisibleResolvedEntities } from './ObjectVisibility.js';
import { arcExtentPoints, arcSweepFromAngles } from './ArcGeometry.js';
import {
  deriveSwellGeometry,
  isSwellEntity,
  swellBoundariesFromDerived,
  swellBoundaryPath,
} from './SwellGeometry.js';
import { buildDocumentVariables, normalizeDocumentMetadata } from './DocumentVariables.js';
import { reconcileDormantStackRelationships } from './StackRelationshipSystem.js';
import { migrateCanvasOriginReferences } from './CanvasOrigin.js';
import {
  DEFAULT_CLASS_ROLE,
  isClassGeometryEntity,
  materializeDrawingClassAppearances,
  normalizeClassState,
  normalizeEntityClass,
} from './ClassSystem.js';

// --- Drawing Normalization, JSON & DXF Serialization ---
const clone = (value) => JSON.parse(JSON.stringify(value));
const dxfUnitFactors = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 };
const dxfUnits = {
  in: { code: 1, factor: 25.4 },
  ft: { code: 2, factor: 304.8 },
  mm: { code: 4, factor: 1 },
  cm: { code: 5, factor: 10 },
  m: { code: 6, factor: 1000 },
};
export function normalizeDrawingDataWithIdentityMap(input = {}) {
  const source = migrateSubtractReferences(migrateCanvasOriginReferences(input.drawing || input));
  const parameters = source.parameters || source.dimensions || [];
  const classState = normalizeClassState(source);
  const entities = clone(source.entities || []).map((entity) => {
    const normalized = entity.type === 'text'
      ? { ...entity, textHeight: textHeightInMillimetres(entity) }
      : entity;
    return isClassGeometryEntity(normalized)
      ? normalizeEntityClass(normalized, classState, { legacy: !normalized.classId })
      : normalized;
  });
  const extensions = source.extensions && typeof source.extensions === 'object' && !Array.isArray(source.extensions)
    ? clone(source.extensions)
    : null;
  if (extensions?.seamLines) extensions.seamLines = normalizeSeamLineExtension(extensions.seamLines);
  const upgradedDimensions = upgradeLegacyParallelEdgeDimensions({
    entities,
    constraints: clone(source.constraints || []),
    dimensionAnnotations: clone(source.dimensionAnnotations || source.annotations || []),
  });
  const structured = migrateStackArchitecture({
    drawingId: source.drawingId,
    identityArchitectureVersion: source.identityArchitectureVersion,
    stackArchitectureVersion: source.stackArchitectureVersion,
    drawingUnit: source.drawingUnit || 'in',
    dxfExportUnit: source.dxfExportUnit || source.drawingUnit || 'in',
    filletRadius: Number.isFinite(Number(source.filletRadius)) && Number(source.filletRadius) > 0
      ? Number(source.filletRadius)
      : (dxfUnits[source.drawingUnit || 'in']?.factor || 25.4),
    entities,
    constraints: upgradedDimensions.constraints,
    parameters: clone(parameters),
    dimensions: clone(parameters),
    dimensionAnnotations: upgradedDimensions.dimensionAnnotations,
    documentMetadata: normalizeDocumentMetadata(source.documentMetadata),
    documentContext: {
      fileName: String(source.documentContext?.fileName ?? ''),
      filePath: String(source.documentContext?.filePath ?? ''),
      contentKind: source.documentContext?.contentKind === 'stack-export' ? 'stack-export' : 'drawing',
      displayName: String(source.documentContext?.displayName ?? source.name ?? ''),
    },
    classes: clone(classState.classes),
    activeClassId: classState.activeClassId,
    ...(extensions && Object.keys(extensions).length ? { extensions } : {}),
  });
  const migrated = migrateDrawingIdentities(structured);
  if (migrated.errors.length) throw new Error(migrated.errors[0].message);
  return migrated;
}

export function normalizeDrawingData(input = {}) {
  return normalizeDrawingDataWithIdentityMap(input).drawing;
}

export function serializeDrawingJson(snapshot, name = 'Untitled Drawing') {
  if (Number(snapshot?.identityArchitectureVersion) >= 1) validateDrawingIdentityGraph(snapshot);
  const drawing = normalizeDrawingData(snapshot);
  validateDrawingIdentityGraph(drawing);
  delete drawing.dimensions;
  return JSON.stringify({
    format: 'ParaMagic Drawing',
    version: 4,
    name,
    ...drawing,
  }, null, 2);
}

export function createIndependentDrawingSave(snapshot, name = 'Untitled Drawing') {
  const { drawing: remappedDrawing, idMap } = cloneDrawingIdentityGraph(snapshot);
  const content = serializeDrawingJson(remappedDrawing, name);
  const drawing = parseDrawingText(`${name}.paramagic`, content);
  return { content, drawing, idMap };
}

function replaceExpressionNames(expression, nameMap, { caseInsensitive = false } = {}) {
  const renames = [...nameMap.entries()]
    .filter(([before, after]) => before !== after)
    .sort(([first], [second]) => second.length - first.length)
    .map(([before, after]) => ({ before, after, caseInsensitive }));
  return rewriteExpressionSymbolReferences(expression, renames);
}

function mergeExtensionValues(base = {}, inserted = {}) {
  const result = clone(base || {});
  Object.entries(inserted || {}).forEach(([key, value]) => {
    if (Array.isArray(result[key]) && Array.isArray(value)) result[key] = [...result[key], ...clone(value)];
    else if (
      result[key] && value
      && typeof result[key] === 'object' && !Array.isArray(result[key])
      && typeof value === 'object' && !Array.isArray(value)
    ) result[key] = mergeExtensionValues(result[key], value);
    else result[key] = clone(value);
  });
  return result;
}

function mergedStackArchitecture(base, inserted, idMap, {
  targetStackId = null,
  insertParentStackId = null,
  insertAsDrawing = false,
  drawingContainerName = '',
} = {}) {
  const baseState = normalizeStackArchitectureState(base.extensions?.stacks);
  const insertedState = normalizeStackArchitectureState(inserted.extensions?.stacks);
  const stacks = clone(baseState.stacks);
  const targetExists = !insertAsDrawing && targetStackId && stacks.some(({ id }) => id === targetStackId);
  if (targetStackId && !targetExists) throw new Error(`Clipboard target Stack ${targetStackId} does not exist.`);
  if (insertParentStackId && !stacks.some(({ id }) => id === insertParentStackId)) {
    throw new Error(`Inserted subtree parent Stack ${insertParentStackId} does not exist.`);
  }
  if (insertAsDrawing && targetStackId) {
    throw new Error('A full drawing cannot be inserted into a drawable Stack.');
  }
  const insertedRootNodeIds = [];
  let drawingContainerId = null;
  if (insertAsDrawing) {
    drawingContainerId = createStackId();
    const fallbackName = inserted.documentContext?.displayName
      || inserted.documentContext?.fileName?.replace(/\.[^.]+$/, '')
      || 'Drawing';
    stacks.push({
      id: drawingContainerId,
      kind: DRAWING_NODE_KIND,
      sourceStackId: null,
      sourceDrawingId: inserted.drawingId || null,
      parentStackId: insertParentStackId || null,
      order: stacks.filter(({ parentStackId }) => (parentStackId || null) === (insertParentStackId || null)).length,
      name: uniqueStackName(drawingContainerName || fallbackName, stacks, { fallback: 'Drawing' }),
      visible: true,
      enabled: true,
      enabledExpression: '',
      removable: true,
    });
    insertedRootNodeIds.push(drawingContainerId);
  }
  idMap.set(GLOBAL_LAYER_ID, GLOBAL_LAYER_ID);
  if (!targetExists) insertedState.stacks.filter(({ id }) => id !== GLOBAL_LAYER_ID).forEach((stack) => idMap.set(stack.id, createStackId()));
  insertedState.stacks.filter(({ id }) => id !== GLOBAL_LAYER_ID).forEach((stack) => {
    if (targetExists) {
      idMap.set(stack.id, targetStackId);
      return;
    }
    const id = idMap.get(stack.id);
    const parentStackId = stack.parentStackId
      ? idMap.get(stack.parentStackId)
      : drawingContainerId || insertParentStackId || null;
    if (!stack.parentStackId && !drawingContainerId) insertedRootNodeIds.push(id);
    stacks.push({
      ...clone(stack),
      id,
      sourceStackId: stack.sourceStackId || stack.id,
      parentStackId,
      name: uniqueStackName(stack.name, stacks),
      systemRole: undefined,
      removable: true,
    });
  });
  return {
    state: {
      version: baseState.version,
      activeStackId: baseState.activeStackId,
      stacks,
    },
    insertedRootNodeIds,
  };
}

function replaceExpressionFields(value, {
  globalNameMap,
  localNameMapsByStack,
  qualifiedRenames,
  contextStackId = null,
  key = '',
} = {}) {
  if (Array.isArray(value)) {
    return value.map((item) => replaceExpressionFields(item, {
      globalNameMap, localNameMapsByStack, qualifiedRenames, contextStackId, key,
    }));
  }
  if (value && typeof value === 'object') {
    const nextContext = value.stackId
      || (Object.hasOwn(value, 'enabledExpression') ? value.id : null)
      || contextStackId;
    return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [
      childKey,
      replaceExpressionFields(item, {
        globalNameMap,
        localNameMapsByStack,
        qualifiedRenames,
        contextStackId: nextContext,
        key: childKey,
      }),
    ]));
  }
  const expressionBearing = key === 'expression' || /Expression$/.test(key) || key === 'text';
  if (typeof value !== 'string' || !expressionBearing) return value;
  let expression = replaceExpressionNames(value, globalNameMap);
  expression = rewriteQualifiedDimensionReferences({ expression }, qualifiedRenames).expression;
  const localNameMap = localNameMapsByStack.get(contextStackId);
  if (localNameMap) expression = replaceExpressionNames(expression, localNameMap, { caseInsensitive: true });
  return expression;
}

export function mergeDrawingDataWithMap(baseInput, insertedInput, {
  inheritControlParameters = true,
  targetStackId = null,
  insertParentStackId = null,
  insertAsDrawing = false,
  drawingContainerName = '',
} = {}) {
  const base = normalizeDrawingData(baseInput);
  const insertedNormalization = normalizeDrawingDataWithIdentityMap(insertedInput);
  const inserted = insertedNormalization.drawing;
  const idMap = new Map();
  const stackMerge = mergedStackArchitecture(base, inserted, idMap, {
    targetStackId,
    insertParentStackId,
    insertAsDrawing,
    drawingContainerName,
  });
  let stackState = stackMerge.state;
  const baseDefaultStackId = defaultStackId(base.extensions?.stacks);
  const insertedDefaultStackId = defaultStackId(inserted.extensions?.stacks);
  const inheritedParameterIds = new Set();
  const activeNonDimensionParameters = new Map(
    base.parameters
      .filter((parameter) => parameter.kind !== 'dimension' && (inheritControlParameters || parameter.kind !== 'control'))
      .map((parameter) => [parameter.name, parameter]),
  );
  const mergedClasses = clone(base.classes);
  const baseDefaultClass = mergedClasses.find(({ systemRole }) => systemRole === DEFAULT_CLASS_ROLE) || mergedClasses[0];
  const baseClassByName = new Map(base.classes.map((item) => [item.name.toLocaleLowerCase(), item]));
  inserted.classes.forEach((item) => {
    if (item.systemRole === DEFAULT_CLASS_ROLE) {
      idMap.set(item.id, baseDefaultClass.id);
      return;
    }
    const existing = baseClassByName.get(item.name.toLocaleLowerCase());
    if (existing) {
      idMap.set(item.id, existing.id);
      return;
    }
    const id = createUuid();
    idMap.set(item.id, id);
    const merged = { ...clone(item), id };
    mergedClasses.push(merged);
    baseClassByName.set(merged.name.toLocaleLowerCase(), merged);
  });
  inserted.parameters.forEach((parameter) => {
    const inherited = parameter.kind !== 'dimension'
      ? activeNonDimensionParameters.get(parameter.name)
      : null;
    if (inherited) {
      idMap.set(parameter.id, inherited.id);
      inheritedParameterIds.add(parameter.id);
      return;
    }
    if (parameter.kind !== 'dimension') idMap.set(parameter.id, createUuid());
  });

  const usedGlobalNames = new Set(base.parameters
    .filter(({ kind }) => kind !== 'dimension')
    .map((parameter) => parameter.name));
  const usedDimensionNamesByStack = new Map();
  base.parameters.filter(({ kind }) => kind === 'dimension').forEach((parameter) => {
    const stackId = parameter.stackId || baseDefaultStackId;
    if (!usedDimensionNamesByStack.has(stackId)) usedDimensionNamesByStack.set(stackId, new Set());
    usedDimensionNamesByStack.get(stackId).add(parameterNameKey(parameter.name, 'dimension'));
  });
  const nameMap = new Map();
  const parameterNameById = new Map();
  const globalNameMap = new Map();
  const localNameMapsByStack = new Map();
  const insertedStackNames = new Map(normalizeStackArchitectureState(inserted.extensions?.stacks).stacks
    .map((stack) => [stack.id, stack.name]));
  const mergedStackNames = new Map(stackState.stacks.map((stack) => [stack.id, stack.name]));
  const qualifiedRenames = [];
  inserted.parameters.forEach((parameter) => {
    if (inheritedParameterIds.has(parameter.id)) {
      parameterNameById.set(parameter.id, parameter.name);
      nameMap.set(parameter.name, parameter.name);
      globalNameMap.set(parameter.name, parameter.name);
      return;
    }
    const sourceStackId = parameter.stackId || insertedDefaultStackId;
    const targetStackId = idMap.get(sourceStackId) || sourceStackId;
    let nextName;
    if (parameter.kind === 'dimension') {
      if (!usedDimensionNamesByStack.has(targetStackId)) usedDimensionNamesByStack.set(targetStackId, new Set());
      const usedNames = usedDimensionNamesByStack.get(targetStackId);
      nextName = nextAvailableParameterName(parameter.name, parameter.kind, usedNames, {
        sequentialDimension: true,
      });
      usedNames.add(parameterNameKey(nextName, 'dimension'));
      if (!localNameMapsByStack.has(sourceStackId)) localNameMapsByStack.set(sourceStackId, new Map());
      localNameMapsByStack.get(sourceStackId).set(parameter.name, nextName);
      if (!localNameMapsByStack.has(targetStackId)) localNameMapsByStack.set(targetStackId, new Map());
      localNameMapsByStack.get(targetStackId).set(parameter.name, nextName);
      qualifiedRenames.push({
        before: qualifiedDimensionName(
          parameter.name,
          insertedStackNames.get(sourceStackId) || sourceStackId,
        ),
        after: qualifiedDimensionName(
          nextName,
          mergedStackNames.get(targetStackId) || targetStackId,
        ),
      });
    } else {
      nextName = nextAvailableParameterName(parameter.name, parameter.kind, usedGlobalNames);
      usedGlobalNames.add(nextName);
      globalNameMap.set(parameter.name, nextName);
    }
    parameterNameById.set(parameter.id, nextName);
    nameMap.set(parameter.name, nextName);
  });

  stackState = replaceExpressionFields(stackState, {
    globalNameMap,
    localNameMapsByStack,
    qualifiedRenames,
  });

  const remappedIdentity = remapDrawingIdentityGraph(inserted, {
    identityMap: idMap,
  });
  let remapped = remappedIdentity.drawing;
  remapped = replaceExpressionFields(remapped, {
    globalNameMap,
    localNameMapsByStack,
    qualifiedRenames,
  });
  remapped.parameters = remapped.parameters
    .map((parameter, index) => ({ parameter, source: inserted.parameters[index] }))
    .filter(({ source }) => !inheritedParameterIds.has(source.id))
    .map(({ parameter, source }, order) => ({
      ...parameter,
      name: parameterNameById.get(source.id) || parameter.name,
      order: base.parameters.length + order,
    }));
  remapped.dimensions = clone(remapped.parameters);
  const sourceAnnotationByMappedId = new Map(inserted.dimensionAnnotations
    .map((annotation) => [idMap.get(annotation.id), annotation]));
  remapped.dimensionAnnotations = remapped.dimensionAnnotations.map((annotation) => {
    const sourceAnnotation = sourceAnnotationByMappedId.get(annotation.id);
    return {
      ...annotation,
      dimensionName: parameterNameById.get(sourceAnnotation?.dimensionId) || annotation.dimensionName,
    };
  });
  remapped.entities = remapped.entities.map((rawEntity) => {
    const entity = rawEntity;
    if (entity.type === 'control') {
      return {
        ...entity,
        parameterName: globalNameMap.get(entity.parameterName) || entity.parameterName,
      };
    }
    return entity;
  });

  const parameters = [...base.parameters, ...remapped.parameters];
  const extensions = mergeExtensionValues(base.extensions, remapped.extensions);
  extensions.stacks = stackState;
  const drawing = reconcileDormantStackRelationships({
    drawingId: base.drawingId,
    identityArchitectureVersion: base.identityArchitectureVersion,
    stackArchitectureVersion: STACK_ARCHITECTURE_VERSION,
    drawingUnit: base.drawingUnit,
    dxfExportUnit: base.dxfExportUnit,
    filletRadius: base.filletRadius,
    entities: [...base.entities, ...remapped.entities],
    constraints: [...base.constraints, ...remapped.constraints],
    parameters,
    dimensions: clone(parameters),
    dimensionAnnotations: [...base.dimensionAnnotations, ...remapped.dimensionAnnotations],
    documentMetadata: clone(base.documentMetadata),
    documentContext: clone(base.documentContext),
    classes: mergedClasses,
    activeClassId: base.activeClassId,
    ...(Object.keys(extensions).length ? { extensions } : {}),
  });
  insertedNormalization.idMap.forEach((canonicalId, legacyId) => {
    if (idMap.has(canonicalId)) idMap.set(legacyId, idMap.get(canonicalId));
  });
  return { drawing, idMap, nameMap, insertedRootNodeIds: stackMerge.insertedRootNodeIds };
}

export function mergeDrawingData(baseInput, insertedInput) {
  return mergeDrawingDataWithMap(baseInput, insertedInput).drawing;
}

function dxfPairs(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const pairs = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    pairs.push({ code: Number(lines[index].trim()), value: lines[index + 1].trim() });
  }
  return pairs;
}

function dxfUnitFactor(pairs) {
  const marker = pairs.findIndex((pair) => pair.code === 9 && pair.value === '$INSUNITS');
  if (marker < 0) return 1;
  const setting = pairs.slice(marker + 1, marker + 4).find((pair) => pair.code === 70);
  return dxfUnitFactors[Number(setting?.value)] || 1;
}

function dxfUnitName(pairs) {
  const marker = pairs.findIndex((pair) => pair.code === 9 && pair.value === '$INSUNITS');
  const setting = marker < 0 ? null : pairs.slice(marker + 1, marker + 4).find((pair) => pair.code === 70);
  return Object.entries(dxfUnits).find(([, config]) => config.code === Number(setting?.value))?.[0] || 'mm';
}

function entityFields(pairs) {
  const fields = new Map();
  pairs.forEach(({ code, value }) => {
    if (!fields.has(code)) fields.set(code, []);
    fields.get(code).push(value);
  });
  return fields;
}

function lwPolylineVertices(pairs, factor) {
  const vertices = [];
  let current = null;
  pairs.forEach(({ code, value }) => {
    if (code === 10) {
      current = { dxf: [Number(value) * factor, 0], bulge: 0 };
      vertices.push(current);
    } else if (code === 20 && current) {
      current.dxf[1] = Number(value) * factor;
    } else if (code === 42 && current) {
      current.bulge = Number(value) || 0;
    }
  });
  return vertices.map((vertex) => ({
    ...vertex,
    point: [vertex.dxf[0], -vertex.dxf[1]],
  }));
}

function entityFromBulgedSegment(startVertex, endVertex) {
  const start = startVertex.dxf;
  const end = endVertex.dxf;
  const bulge = Number(startVertex.bulge) || 0;
  if (Math.abs(bulge) <= 1e-12) {
    return { type: 'line', start: [...startVertex.point], end: [...endVertex.point] };
  }
  const sweep = 4 * Math.atan(bulge);
  const chord = [end[0] - start[0], end[1] - start[1]];
  const chordLength = Math.hypot(chord[0], chord[1]);
  const tangent = Math.tan(sweep / 2);
  if (chordLength <= 1e-12 || Math.abs(tangent) <= 1e-12) {
    return { type: 'line', start: [...startVertex.point], end: [...endVertex.point] };
  }
  const chordUnit = [chord[0] / chordLength, chord[1] / chordLength];
  const leftNormal = [-chordUnit[1], chordUnit[0]];
  const midpoint = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  const centerOffset = chordLength / (2 * tangent);
  const centerDxf = [
    midpoint[0] + leftNormal[0] * centerOffset,
    midpoint[1] + leftNormal[1] * centerOffset,
  ];
  const radius = Math.hypot(start[0] - centerDxf[0], start[1] - centerDxf[1]);
  const startAngle = Math.atan2(start[1] - centerDxf[1], start[0] - centerDxf[0]);
  const middleAngle = startAngle + sweep / 2;
  return {
    type: 'arc',
    start: [...startVertex.point],
    arcPoint: [
      centerDxf[0] + Math.cos(middleAngle) * radius,
      -(centerDxf[1] + Math.sin(middleAngle) * radius),
    ],
    end: [...endVertex.point],
    center: [centerDxf[0], -centerDxf[1]],
    radius,
    ccw: sweep < 0,
  };
}

export function parseDxf(text) {
  const pairs = dxfPairs(text);
  const factor = dxfUnitFactor(pairs);
  const unit = dxfUnitName(pairs);
  const entities = [];
  let inEntities = false;
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    if (pair.code === 2 && pair.value === 'ENTITIES') { inEntities = true; continue; }
    if (!inEntities || pair.code !== 0) continue;
    if (pair.value === 'ENDSEC') { inEntities = false; continue; }
    const type = pair.value;
    let end = index + 1;
    while (end < pairs.length && pairs[end].code !== 0) end += 1;
    const fields = entityFields(pairs.slice(index + 1, end));
    const number = (code, occurrence = 0) => Number(fields.get(code)?.[occurrence] || 0) * factor;
    const point = (xCode, yCode, occurrence = 0) => [number(xCode, occurrence), -number(yCode, occurrence)];
    if (type === 'LINE') entities.push({ id: createUuid(), type: 'line', start: point(10, 20), end: point(11, 21) });
    if (type === 'CIRCLE') entities.push({ id: createUuid(), type: 'circle', center: point(10, 20), radius: number(40) });
    if (type === 'ARC') {
      const center = point(10, 20);
      const radius = number(40);
      const startAngle = Number(fields.get(50)?.[0] || 0) * Math.PI / 180;
      const endAngleRaw = Number(fields.get(51)?.[0] || 0) * Math.PI / 180;
      const endAngle = endAngleRaw < startAngle ? endAngleRaw + Math.PI * 2 : endAngleRaw;
      const at = (angle) => [center[0] + radius * Math.cos(angle), center[1] - radius * Math.sin(angle)];
      entities.push({ id: createUuid(), type: 'arc', start: at(startAngle), arcPoint: at((startAngle + endAngle) / 2), end: at(endAngle), center, radius, ccw: false });
    }
    if (type === 'LWPOLYLINE') {
      const vertices = lwPolylineVertices(pairs.slice(index + 1, end), factor);
      const closed = Boolean(Number(fields.get(70)?.[0] || 0) & 1);
      const points = vertices.map(({ point: vertex }) => vertex);
      const segmentCount = closed ? vertices.length : Math.max(0, vertices.length - 1);
      const hasBulges = vertices.slice(0, segmentCount)
        .some(({ bulge }) => Math.abs(Number(bulge) || 0) > 1e-12);
      if (points.length >= 2 && !hasBulges) {
        entities.push({ id: createUuid(), type: closed ? 'polygon' : 'polyline', points });
      } else if (segmentCount > 0) {
        const compositeId = createUuid();
        for (let segment = 0; segment < segmentCount; segment += 1) {
          entities.push({
            id: createUuid(),
            ...entityFromBulgedSegment(vertices[segment], vertices[(segment + 1) % vertices.length]),
            composite: {
              id: compositeId,
              kind: 'polyline',
              closed,
              index: segment,
              count: segmentCount,
            },
          });
        }
      }
    }
    index = end - 1;
  }
  return normalizeDrawingData({ drawingUnit: unit, dxfExportUnit: unit, entities });
}

function circleThrough(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return null;
  const aa = a[0] ** 2 + a[1] ** 2;
  const bb = b[0] ** 2 + b[1] ** 2;
  const cc = c[0] ** 2 + c[1] ** 2;
  const center = [
    (aa * (b[1] - c[1]) + bb * (c[1] - a[1]) + cc * (a[1] - b[1])) / d,
    (aa * (c[0] - b[0]) + bb * (a[0] - c[0]) + cc * (b[0] - a[0])) / d,
  ];
  return { center, radius: Math.hypot(a[0] - center[0], a[1] - center[1]) };
}

function arcCircle(entity) {
  if (Array.isArray(entity.center) && entity.center.every(Number.isFinite) && Number.isFinite(entity.radius) && Math.abs(entity.radius) > 1e-8) {
    return { center: [...entity.center], radius: Math.abs(entity.radius) };
  }
  return circleThrough(entity.start, entity.arcPoint, entity.end);
}

const dxfFontFiles = Object.freeze({
  Arial: 'arial.ttf',
  Helvetica: 'arial.ttf',
  Verdana: 'verdana.ttf',
  Tahoma: 'tahoma.ttf',
  'Trebuchet MS': 'trebuc.ttf',
  'Times New Roman': 'times.ttf',
  Georgia: 'georgia.ttf',
  Garamond: 'gara.ttf',
  'Courier New': 'cour.ttf',
  'Comic Sans MS': 'comic.ttf',
  Impact: 'impact.ttf',
  'Lucida Console': 'lucon.ttf',
});

function dxfTextStyles(entities = []) {
  const fonts = [...new Set(
    entities
      .filter(({ type }) => type === 'text')
      .map((entity) => String(entity.fontName || 'Arial')),
  )];
  const usedNames = new Set(['STANDARD']);
  return fonts.map((fontName, index) => {
    const base = String(fontName || 'Arial')
      .toUpperCase()
      .replace(/[^A-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 28) || `FONT_${index + 1}`;
    let name = base;
    let suffix = 2;
    while (usedNames.has(name)) {
      name = `${base.slice(0, 27)}_${suffix}`;
      suffix += 1;
    }
    usedNames.add(name);
    return {
      fontName,
      name,
      file: dxfFontFiles[fontName] || `${fontName.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'arial'}.ttf`,
    };
  });
}

function dxfMtextContent(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/\r\n?|\n/g, '\\P');
}

function dxfSingleLineContent(value) {
  return String(value ?? '').replace(/\s*\r?\n+\s*/g, ' ');
}

export function serializeDxf(snapshot) {
  const drawing = materializeDrawingClassAppearances(normalizeDrawingData(snapshot));
  const textEvaluators = drawingThumbnailEvaluators(drawing);
  const exportUnitName = dxfUnits[drawing.dxfExportUnit]
    ? drawing.dxfExportUnit
    : dxfUnits[drawing.drawingUnit] ? drawing.drawingUnit : 'in';
  const exportUnit = dxfUnits[exportUnitName];
  const scale = 1 / exportUnit.factor;
  const geometry = drawing.entities.filter((entity) => entity.type !== 'image');
  const seamLayer = 'Seam Lines';
  const constructionLayer = 'Construction';
  const textLayer = 'Text';
  const dimensionLayer = DXF_DIMENSION_LAYER;
  const isSeamLine = (entity) => entity.composite?.kind === 'finish-size-offset';
  const isConstructionGeometry = (entity) => (
    entity.construction === true || isSymmetricCenterline(entity)
  );
  const hasSeamLines = geometry.some(isSeamLine);
  const hasConstruction = geometry.some(isConstructionGeometry);
  const hasText = geometry.some(({ type }) => type === 'text');
  const hasDashedLayers = hasSeamLines || hasConstruction;
  const textStyles = dxfTextStyles(geometry);
  const textStyleByFont = new Map(textStyles.map((style) => [style.fontName, style.name]));
  const dimensionPlans = createDxfDimensionPlans(drawing, {
    resolveValueText: drawingThumbnailEvaluators(drawing).dimensionDxfValueText,
    precision: exportUnitName === 'in' ? 5 : 3,
  });
  const nativeDimensionPlans = dimensionPlans.filter(({ kind }) => kind === 'dimension');
  const hasDimensions = dimensionPlans.length > 0;
  const notchLayers = [...new Set(geometry.filter((entity) => entity.type === 'notch').map(notchDxfLayer))];
  const layerNames = [
    '0',
    ...(hasSeamLines ? [seamLayer] : []),
    ...(hasConstruction ? [constructionLayer] : []),
    ...(hasText ? [textLayer] : []),
    ...(hasDimensions ? [dimensionLayer] : []),
    ...notchLayers,
  ];
  const metricMeasurement = ['mm', 'cm', 'm'].includes(exportUnitName) ? 1 : 0;
  const dimensionPostfix = exportUnitName === 'in'
    ? '<>"'
    : exportUnitName === 'ft'
      ? "<>'"
      : `<> ${exportUnitName}`;
  let nextDxfHandleValue = 1;
  const nextDxfHandle = () => {
    const handle = nextDxfHandleValue.toString(16).toUpperCase();
    nextDxfHandleValue += 1;
    return handle;
  };
  const handseedPlaceholder = '__PARAMAGIC_HANDSEED__';
  const tableNames = ['VPORT', 'LTYPE', 'LAYER', 'STYLE', 'VIEW', 'UCS', 'APPID', 'DIMSTYLE', 'BLOCK_RECORD'];
  const tableHandles = new Map(tableNames.map((name) => [name, nextDxfHandle()]));
  const modelSpaceBlockName = '*Model_Space';
  const paperSpaceBlockName = '*Paper_Space';
  const blockRecordHandles = new Map(
    [modelSpaceBlockName, paperSpaceBlockName, ...nativeDimensionPlans.map(({ blockName }) => blockName)]
      .map((name) => [name, nextDxfHandle()]),
  );
  const modelSpaceHandle = blockRecordHandles.get(modelSpaceBlockName);
  const paperSpaceHandle = blockRecordHandles.get(paperSpaceBlockName);
  const namedObjectDictionaryHandle = nextDxfHandle();
  const groupDictionaryHandle = nextDxfHandle();
  const layoutDictionaryHandle = nextDxfHandle();
  const mlineStyleDictionaryHandle = nextDxfHandle();
  const standardMlineStyleHandle = nextDxfHandle();
  const plotSettingsDictionaryHandle = nextDxfHandle();
  const plotStyleDictionaryHandle = nextDxfHandle();
  const normalPlotStyleHandle = nextDxfHandle();
  const modelLayoutHandle = nextDxfHandle();
  const paperLayoutHandle = nextDxfHandle();
  const lines = [
    '0', 'SECTION', '2', 'HEADER',
    '9', '$ACADVER', '1', 'AC1015',
    '9', '$HANDSEED', '5', handseedPlaceholder,
    '9', '$INSUNITS', '70', String(exportUnit.code),
    '9', '$MEASUREMENT', '70', String(metricMeasurement),
    '9', '$LUNITS', '70', '2',
    '9', '$LUPREC', '70', '8',
    '0', 'ENDSEC',
  ];
  const push = (...values) => lines.push(...values.map(String));
  const dxfNumber = (value) => {
    const rounded = Math.round(Number(value) * 1e12) / 1e12;
    return Object.is(rounded, -0) ? 0 : rounded;
  };
  const x = (value) => dxfNumber(Number(value) * scale);
  const y = (value) => dxfNumber(-Number(value) * scale);
  const pushEntityHeader = (type, layer, ownerHandle, subclass) => {
    const isModelSpaceEntity = !ownerHandle || ownerHandle === modelSpaceHandle;
    push(
      0, type,
      5, nextDxfHandle(),
      330, ownerHandle || modelSpaceHandle,
      100, 'AcDbEntity',
      8, layer,
      ...(isModelSpaceEntity ? [410, 'Model'] : []),
      370, -1,
      100, subclass,
    );
  };
  const pushLine = (entity, layer = '0', ownerHandle = modelSpaceHandle) => {
    pushEntityHeader('LINE', layer, ownerHandle, 'AcDbLine');
    push(10, x(entity.start[0]), 20, y(entity.start[1]), 11, x(entity.end[0]), 21, y(entity.end[1]));
  };
  const pushArc = (entity, layer = '0', ownerHandle = modelSpaceHandle) => {
    const circle = arcCircle(entity);
    if (!circle) return;
    const angle = (point) => ((Math.atan2(-(point[1] - circle.center[1]), point[0] - circle.center[0]) * 180 / Math.PI) + 360) % 360;
    let startAngle = angle(entity.start);
    let endAngle = angle(entity.end);
    const midAngle = angle(entity.arcPoint);
    const containsMid = ((midAngle - startAngle + 360) % 360) <= ((endAngle - startAngle + 360) % 360);
    if (!containsMid) [startAngle, endAngle] = [endAngle, startAngle];
    pushEntityHeader('ARC', layer, ownerHandle, 'AcDbCircle');
    push(10, x(circle.center[0]), 20, y(circle.center[1]), 40, x(circle.radius), 100, 'AcDbArc', 50, startAngle, 51, endAngle);
  };
  const pushBoundary = (entity, layer = '0', ownerHandle = modelSpaceHandle) => {
    const vertices = dxfBoundaryVertices(entity, ([pointX, pointY]) => [x(pointX), y(pointY)]);
    if (vertices.length < 2) return;
    pushEntityHeader('LWPOLYLINE', layer, ownerHandle, 'AcDbPolyline');
    push(90, vertices.length, 70, entity.closed === true ? 1 : 0);
    vertices.forEach((vertex) => {
      push(10, vertex.point[0], 20, vertex.point[1], 42, vertex.bulge);
    });
  };
  const resolvedText = (entity) => resolveTextFields(
    entity.text,
    textEvaluators.expressionEntries(entity),
    (entry) => formatUnitlessValue(entry.value, drawing.drawingUnit),
    (expression) => textEvaluators.evaluateExpression(expression, entity),
  );
  const textStyle = (entity) => textStyleByFont.get(String(entity.fontName || 'Arial'))
    || textStyles[0]?.name
    || 'STANDARD';
  const pushText = (entity, ownerHandle = modelSpaceHandle) => {
    const anchorX = x(entity.x);
    const anchorY = y(entity.y);
    const height = x(textHeightInMillimetres(entity));
    const alignment = entity.textAlign === 'center' ? 1 : entity.textAlign === 'right' ? 2 : 0;
    const value = dxfSingleLineContent(resolvedText(entity));
    pushEntityHeader('TEXT', textLayer, ownerHandle, 'AcDbText');
    push(
      7, textStyle(entity),
      10, anchorX, 20, anchorY,
      40, height, 1, value,
      72, alignment,
      11, anchorX, 21, anchorY,
      100, 'AcDbText', 73, 3,
    );
  };
  const pushMtext = (entity, ownerHandle = modelSpaceHandle) => {
    const value = resolvedText(entity);
    const lines = String(value).split(/\r\n?|\n/);
    const height = x(textHeightInMillimetres(entity));
    const longestLineLength = Math.max(1, ...lines.map((line) => line.length));
    const referenceWidth = Math.max(height, longestLineLength * height * 0.65);
    const attachment = entity.textAlign === 'center' ? 2 : entity.textAlign === 'right' ? 3 : 1;
    pushEntityHeader('MTEXT', textLayer, ownerHandle, 'AcDbMText');
    push(
      7, textStyle(entity),
      10, x(entity.x), 20, y(entity.y),
      40, height, 41, referenceWidth,
      71, attachment, 72, 1,
      1, dxfMtextContent(value),
      44, 1.25,
    );
  };
  const pushSolid = (points, layer = dimensionLayer, ownerHandle = modelSpaceHandle) => {
    if (!Array.isArray(points) || points.length < 3) return;
    const [first, second, third] = points;
    pushEntityHeader('SOLID', layer, ownerHandle, 'AcDbTrace');
    push(
      10, x(first[0]), 20, y(first[1]),
      11, x(second[0]), 21, y(second[1]),
      12, x(third[0]), 22, y(third[1]),
      13, x(third[0]), 23, y(third[1]),
    );
  };
  const pushDimensionText = (picture, ownerHandle = modelSpaceHandle) => {
    const point = picture.textPoint;
    if (!point || !picture.text) return;
    const alignment = picture.textAlign === 'right' ? 2 : picture.textAlign === 'left' ? 0 : 1;
    pushEntityHeader('TEXT', dimensionLayer, ownerHandle, 'AcDbText');
    push(
      10, x(point[0]), 20, y(point[1]),
      40, x(DXF_DIMENSION_SIZE), 1, dxfSingleLineContent(picture.text),
      50, dxfNumber(-Number(picture.textAngle || 0)),
      72, alignment,
      11, x(point[0]), 21, y(point[1]),
      100, 'AcDbText', 73, 2,
    );
  };
  const pushDimensionPicture = (picture, ownerHandle = modelSpaceHandle) => {
    picture.lines?.forEach((line) => pushLine(line, dimensionLayer, ownerHandle));
    if (picture.arc) pushArc(picture.arc, dimensionLayer, ownerHandle);
    picture.arrows?.forEach((points) => pushSolid(points, dimensionLayer, ownerHandle));
    pushDimensionText(picture, ownerHandle);
  };
  const pushNativeLeader = ({ picture }) => {
    const annotationHandle = nextDxfHandle();
    const leaderHandle = nextDxfHandle();
    const point = picture.textPoint;
    const angle = Number(picture.textAngle || 0) * Math.PI / 180;
    const direction = [Math.cos(angle), -Math.sin(angle)];
    const vertices = [picture.lines[0].start, ...picture.lines.map((line) => line.end)];
    const last = vertices.at(-1);
    push(
      0, 'MTEXT', 5, annotationHandle,
      102, '{ACAD_REACTORS', 330, leaderHandle, 102, '}',
      330, modelSpaceHandle, 100, 'AcDbEntity', 8, dimensionLayer, 410, 'Model',
      100, 'AcDbMText',
      10, x(point[0]), 20, y(point[1]), 30, 0,
      40, x(DXF_DIMENSION_SIZE), 41, 0,
      71, picture.textAlign === 'right' ? 6 : 4, 72, 1,
      1, dxfSingleLineContent(picture.text), 7, 'STANDARD',
      11, direction[0], 21, direction[1], 31, 0,
    );
    push(
      0, 'LEADER', 5, leaderHandle, 330, modelSpaceHandle,
      100, 'AcDbEntity', 8, dimensionLayer, 410, 'Model',
      100, 'AcDbLeader', 3, DXF_DIMENSION_STYLE,
      71, 1, 72, 0, 73, 0, 74, picture.textAlign === 'right' ? 0 : 1, 75, 0,
      40, x(DXF_DIMENSION_SIZE), 41, 0, 76, vertices.length,
    );
    vertices.forEach((vertex) => push(10, x(vertex[0]), 20, y(vertex[1]), 30, 0));
    push(
      77, 256, 340, annotationHandle,
      210, 0, 220, 0, 230, 1,
      211, direction[0], 221, direction[1], 231, 0,
      212, 0, 222, 0, 232, 0,
      213, x(last[0] - point[0]), 223, y(last[1] - point[1]), 233, 0,
    );
  };
  const pushNativeDimension = (plan) => {
    push(
      0, 'DIMENSION',
      5, nextDxfHandle(),
      330, modelSpaceHandle,
      100, 'AcDbEntity',
      8, dimensionLayer,
      410, 'Model',
      370, -1,
      100, 'AcDbDimension',
      2, plan.blockName,
      10, x(plan.definitionPoint[0]), 20, y(plan.definitionPoint[1]), 30, 0,
      11, x(plan.textPoint[0]), 21, y(plan.textPoint[1]), 31, 0,
      70, plan.typeCode + 32 + 128,
      1, '<>',
      3, DXF_DIMENSION_STYLE,
    );
    if (plan.nativeType === 'aligned' || plan.nativeType === 'rotated') {
      push(
        100, 'AcDbAlignedDimension',
        13, x(plan.extensionA[0]), 23, y(plan.extensionA[1]), 33, 0,
        14, x(plan.extensionB[0]), 24, y(plan.extensionB[1]), 34, 0,
      );
      if (plan.nativeType === 'rotated') {
        push(50, plan.rotation, 100, 'AcDbRotatedDimension');
      }
    }
    if (plan.nativeType === 'radius' || plan.nativeType === 'diameter') {
      push(
        100, plan.nativeType === 'diameter' ? 'AcDbDiametricDimension' : 'AcDbRadialDimension',
        15, x(plan.radialPoint[0]), 25, y(plan.radialPoint[1]), 35, 0,
        40, x(plan.leaderLength),
      );
    }
    if (plan.nativeType === 'angular-three-point') {
      push(
        100, 'AcDb3PointAngularDimension',
        13, x(plan.extensionA[0]), 23, y(plan.extensionA[1]), 33, 0,
        14, x(plan.extensionB[0]), 24, y(plan.extensionB[1]), 34, 0,
        15, x(plan.vertex[0]), 25, y(plan.vertex[1]), 35, 0,
      );
    }
  };
  const symbolRecord = (subclass, values, handle = nextDxfHandle()) => ({ handle, subclass, values });
  const pushSymbolTable = (name, records, tableSubclass = null) => {
    const tableHandle = tableHandles.get(name);
    push(0, 'TABLE', 2, name, 5, tableHandle, 330, 0, 100, 'AcDbSymbolTable', 70, records.length);
    if (tableSubclass) push(100, tableSubclass);
    records.forEach((record) => push(
      0, name,
      name === 'DIMSTYLE' ? 105 : 5, record.handle,
      330, tableHandle,
      100, 'AcDbSymbolTableRecord',
      100, record.subclass,
      ...record.values,
    ));
    push(0, 'ENDTAB');
  };
  const dimensionStyleValues = (name, postfix = '', rounding = 0, precision = 3) => [
    2, name, 70, 0,
    3, postfix, 4, '<>%%d',
    40, 1, 41, x(DXF_DIMENSION_SIZE), 42, x(1.25), 44, x(1.25), 45, rounding,
    140, x(DXF_DIMENSION_SIZE), 144, 1, 147, x(0.625),
    77, 1, 78, 0, 79, 0, 179, 3, 271, precision, 275, 0, 277, 2,
  ];
  const viewportRecords = [symbolRecord('AcDbViewportTableRecord', [
    2, '*ACTIVE', 70, 0,
    10, 0, 20, 0, 11, 1, 21, 1,
    12, 0, 22, 0, 13, 0, 23, 0,
    14, 0.5, 24, 0.5, 15, 0.5, 25, 0.5,
    16, 0, 26, 0, 36, 1, 17, 0, 27, 0, 37, 0,
    40, 1000, 41, 1, 42, 50, 43, 0, 44, 0, 50, 0, 51, 0,
    71, 0, 72, 1000, 73, 1, 74, 3, 75, 0, 76, 0, 77, 0, 78, 0,
  ])];
  const linetypeRecords = [
    symbolRecord('AcDbLinetypeTableRecord', [2, 'BYBLOCK', 70, 0, 3, '', 72, 65, 73, 0, 40, 0]),
    symbolRecord('AcDbLinetypeTableRecord', [2, 'BYLAYER', 70, 0, 3, '', 72, 65, 73, 0, 40, 0]),
    symbolRecord('AcDbLinetypeTableRecord', [2, 'CONTINUOUS', 70, 0, 3, 'Solid line', 72, 65, 73, 0, 40, 0]),
    ...(hasDashedLayers ? [symbolRecord('AcDbLinetypeTableRecord', [
      2, 'DASHED', 70, 0, 3, 'Dashed line', 72, 65, 73, 2,
      40, x(18), 49, x(12), 74, 0, 49, -x(6), 74, 0,
    ])] : []),
  ];
  const layerRecords = layerNames.map((layer) => symbolRecord('AcDbLayerTableRecord', [
    2, layer, 70, 0,
    62, layer === constructionLayer ? 1 : layer === dimensionLayer ? 5 : 7,
    6, [seamLayer, constructionLayer].includes(layer) ? 'DASHED' : 'CONTINUOUS',
    370, -3,
    390, normalPlotStyleHandle,
  ]));
  const styleRecords = [
    symbolRecord('AcDbTextStyleTableRecord', [
      2, 'STANDARD', 70, 0, 40, 0, 41, 1, 50, 0, 71, 0, 42, x(2.5), 3, 'txt', 4, '',
    ]),
    ...textStyles.map((style) => symbolRecord('AcDbTextStyleTableRecord', [
      2, style.name, 70, 0,
      40, 0, 41, 1, 50, 0, 71, 0, 42, x(2.5),
      3, style.file, 4, '',
    ])),
  ];
  const dimensionStyleRecords = [
    symbolRecord('AcDbDimStyleTableRecord', dimensionStyleValues('STANDARD')),
    ...(dimensionPlans.some((plan) => ['dimension', 'leader'].includes(plan.kind)) ? [
      symbolRecord('AcDbDimStyleTableRecord', dimensionStyleValues(
        DXF_DIMENSION_STYLE,
        dimensionPostfix,
        exportUnitName === 'in' ? 0.03125 : 0,
        exportUnitName === 'in' ? 5 : 3,
      )),
    ] : []),
  ];
  const blockRecords = [...blockRecordHandles].map(([name, handle]) => {
    const layoutHandle = name === modelSpaceBlockName
      ? modelLayoutHandle
      : name === paperSpaceBlockName ? paperLayoutHandle : null;
    return symbolRecord(
      'AcDbBlockTableRecord',
      [2, name, ...(layoutHandle ? [340, layoutHandle] : [])],
      handle,
    );
  });

  push(0, 'SECTION', 2, 'TABLES');
  pushSymbolTable('VPORT', viewportRecords);
  pushSymbolTable('LTYPE', linetypeRecords);
  pushSymbolTable('LAYER', layerRecords);
  pushSymbolTable('STYLE', styleRecords);
  pushSymbolTable('VIEW', []);
  pushSymbolTable('UCS', []);
  pushSymbolTable('APPID', [symbolRecord('AcDbRegAppTableRecord', [2, 'ACAD', 70, 0])]);
  pushSymbolTable('DIMSTYLE', dimensionStyleRecords, 'AcDbDimStyleTable');
  pushSymbolTable('BLOCK_RECORD', blockRecords);
  push(0, 'ENDSEC');
  const pushBlock = (name, layer, flags, body = null) => {
    const ownerHandle = blockRecordHandles.get(name);
    push(
      0, 'BLOCK', 5, nextDxfHandle(), 330, ownerHandle,
      100, 'AcDbEntity', 8, layer, 100, 'AcDbBlockBegin',
      2, name, 70, flags, 10, 0, 20, 0, 30, 0, 3, name, 1, '',
    );
    body?.(ownerHandle);
    push(
      0, 'ENDBLK', 5, nextDxfHandle(), 330, ownerHandle,
      100, 'AcDbEntity', 8, layer, 100, 'AcDbBlockEnd',
    );
  };
  push(0, 'SECTION', 2, 'BLOCKS');
  pushBlock(modelSpaceBlockName, '0', 0);
  pushBlock(paperSpaceBlockName, '0', 0);
  nativeDimensionPlans.forEach((plan) => pushBlock(
    plan.blockName,
    dimensionLayer,
    1,
    (ownerHandle) => pushDimensionPicture(plan.picture, ownerHandle),
  ));
  push(0, 'ENDSEC');
  push(0, 'SECTION', 2, 'ENTITIES');

  geometry.forEach((entity) => {
    const layer = isConstructionGeometry(entity)
      ? constructionLayer
      : isSeamLine(entity) ? seamLayer : '0';
    if (entity.type === 'line') pushLine(entity, layer);
    if (entity.type === 'circle') {
      pushEntityHeader('CIRCLE', layer, modelSpaceHandle, 'AcDbCircle');
      push(10, x(entity.center[0]), 20, y(entity.center[1]), 40, x(entity.radius));
    }
    if (entity.type === 'arc') pushArc(entity, layer);
    if (entity.type === DXF_BOUNDARY_ENTITY_TYPE) pushBoundary(entity, layer);
    if (entity.type === 'text') {
      if (entity.multiline === false) pushText(entity);
      else pushMtext(entity);
    }
    if (['polyline', 'polygon', 'curve'].includes(entity.type)) {
      pushEntityHeader('LWPOLYLINE', layer, modelSpaceHandle, 'AcDbPolyline');
      push(90, entity.points.length, 70, entity.type === 'polygon' ? 1 : 0);
      entity.points.forEach((point) => push(10, x(point[0]), 20, y(point[1])));
    }
    if (entity.type === 'notch') {
      const layer = notchDxfLayer(entity);
      notchGeometryPrimitives(entity).forEach((primitive) => {
        if (primitive.type === 'line') pushLine(primitive, layer);
        if (primitive.type === 'arc') pushArc(primitive, layer);
      });
    }
  });
  dimensionPlans.forEach((plan) => {
    if (plan.kind === 'dimension') pushNativeDimension(plan);
    else if (plan.kind === 'leader') pushNativeLeader(plan);
    else pushDimensionPicture(plan.picture);
  });
  push(0, 'ENDSEC');

  const pushDictionary = (handle, ownerHandle, entries = []) => {
    push(0, 'DICTIONARY', 5, handle, 330, ownerHandle, 100, 'AcDbDictionary', 281, 1);
    entries.forEach(([name, entryHandle]) => push(3, name, 350, entryHandle));
  };
  const pushLayout = (handle, name, tabOrder, blockRecordHandle, model = false) => {
    push(
      0, 'LAYOUT',
      5, handle,
      330, layoutDictionaryHandle,
      100, 'AcDbPlotSettings',
      1, '',
      2, model ? 'none_device' : 'None',
      4, '',
      6, '',
      40, 0, 41, 0, 42, 0, 43, 0,
      44, 0, 45, 0, 46, 0, 47, 0, 48, 0, 49, 0,
      140, 0, 141, 0, 142, 1, 143, 1,
      70, model ? 11952 : 688,
      72, 0, 73, model ? 1 : 0, 74, model ? 0 : 5,
      7, '', 75, model ? 0 : 16,
      147, 1, 148, 0, 149, 0,
      100, 'AcDbLayout',
      1, name,
      70, 1,
      71, tabOrder,
      10, 0, 20, 0,
      11, 12, 21, 9,
      12, 0, 22, 0, 32, 0,
      14, 0, 24, 0, 34, 0,
      15, 0, 25, 0, 35, 0,
      146, 0,
      13, 0, 23, 0, 33, 0,
      16, 1, 26, 0, 36, 0,
      17, 0, 27, 1, 37, 0,
      76, 0,
      330, blockRecordHandle,
    );
  };

  push(0, 'SECTION', 2, 'OBJECTS');
  pushDictionary(namedObjectDictionaryHandle, 0, [
    ['ACAD_GROUP', groupDictionaryHandle],
    ['ACAD_LAYOUT', layoutDictionaryHandle],
    ['ACAD_MLINESTYLE', mlineStyleDictionaryHandle],
    ['ACAD_PLOTSETTINGS', plotSettingsDictionaryHandle],
    ['ACAD_PLOTSTYLENAME', plotStyleDictionaryHandle],
  ]);
  pushDictionary(groupDictionaryHandle, namedObjectDictionaryHandle);
  pushDictionary(layoutDictionaryHandle, namedObjectDictionaryHandle, [
    ['Layout1', paperLayoutHandle],
    ['Model', modelLayoutHandle],
  ]);
  pushDictionary(mlineStyleDictionaryHandle, namedObjectDictionaryHandle, [
    ['Standard', standardMlineStyleHandle],
  ]);
  push(
    0, 'MLINESTYLE',
    5, standardMlineStyleHandle,
    330, mlineStyleDictionaryHandle,
    100, 'AcDbMlineStyle',
    2, 'STANDARD', 70, 0, 3, '', 62, 256, 51, 90, 52, 90, 71, 2,
    49, 0.5, 62, 256, 6, 'BYLAYER',
    49, -0.5, 62, 256, 6, 'BYLAYER',
  );
  pushDictionary(plotSettingsDictionaryHandle, namedObjectDictionaryHandle);
  push(
    0, 'ACDBDICTIONARYWDFLT',
    5, plotStyleDictionaryHandle,
    330, namedObjectDictionaryHandle,
    100, 'AcDbDictionary',
    281, 1,
    3, 'Normal', 350, normalPlotStyleHandle,
    100, 'AcDbDictionaryWithDefault',
    340, normalPlotStyleHandle,
  );
  push(0, 'ACDBPLACEHOLDER', 5, normalPlotStyleHandle, 330, plotStyleDictionaryHandle);
  pushLayout(modelLayoutHandle, 'Model', 0, modelSpaceHandle, true);
  pushLayout(paperLayoutHandle, 'Layout1', 1, paperSpaceHandle);
  push(0, 'ENDSEC', 0, 'EOF');
  lines[lines.indexOf(handseedPlaceholder)] = nextDxfHandleValue.toString(16).toUpperCase();
  return lines.join('\n');
}

export function parseDrawingText(fileName, text) {
  if (/\.dxf$/i.test(fileName)) return parseDxf(text);
  const parsed = JSON.parse(text);
  if (Number(parsed.identityArchitectureVersion) >= 1) validateDrawingIdentityGraph(parsed);
  const drawing = normalizeDrawingData(parsed);
  if (Number(parsed.identityArchitectureVersion) >= 1) validateDrawingIdentityGraph(drawing);
  return drawing;
}

// --- Drawing Thumbnail Generation ---
const finitePoint = (point) => Array.isArray(point) && point.length >= 2 && point.slice(0, 2).every(Number.isFinite);
const escapeXml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[character]);
const svgAttributes = (attributes = {}) => Object.entries(attributes)
  .map(([name, value]) => `${name}="${escapeXml(value)}"`).join(' ');
const points = (value = []) => value.filter(finitePoint).map(([x, y]) => `${x},${y}`).join(' ');
const identityMatrix = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

export const DRAWING_CANVAS_BACKGROUND = '#fafbfd';
export const drawingThumbnailVersion = 'paramagic-thumbnail-v19';

function entityImageFillReference(entity) {
  const reference = entity.appearance?.fillImageReference || entity.appearance?.fillExpression;
  return isImageFillReference(reference) ? reference : null;
}

function thumbnailImagePatternId(entity) {
  return imageFillPatternId(
    entity.appearance,
    'thumbnail-image-fill',
    entityLocalDataBounds(entity),
  );
}

export function drawingThumbnailEvaluators(drawing = {}) {
  const drawingUnit = drawing.drawingUnit || 'in';
  const repository = new ParameterRepository();
  repository.setStackState(drawing.stackState || drawing.extensions?.stacks, { rewriteExpressions: false, emit: false });
  repository.setDefaultLengthUnit(drawingUnit);
  const documentVariables = buildDocumentVariables({
    metadata: drawing.documentMetadata,
    context: drawing.documentContext,
    drawingUnit,
    entities: drawing.entities || [],
  });
  repository.setExternalVariables(documentVariables);
  repository.restore(drawing.parameters || drawing.dimensions || [], { emit: false });
  repository.evaluateAll({ strict: false, refreshComputed: false });
  const contextStackId = (context) => typeof context === 'string' ? context : context?.stackId || null;
  const evaluateLength = (expression, context = null) => repository.evaluateLengthExpression(expression, {
    stackId: contextStackId(context),
  });
  const dimensionText = (annotation, formatter) => {
    const entry = repository.get(annotation?.dimensionId || annotation?.dimensionName);
    const prefix = annotation?.type === 'multi-curve-length-dimension' ? 'PERIM ' : '';
    if (entry && Number.isFinite(Number(entry.value))) {
      return `${prefix}${formatter(entry.value, entry.unit)}`;
    }
    return `${prefix}${String(annotation?.text || '').replace(/^.*?=\s*/, '')}`;
  };
  return {
    documentVariables,
    expressionEntries: (context = null) => [
      ...documentVariables,
      ...repository.expressionEntries({
        stackId: contextStackId(context),
        includeLocalAliases: true,
      }),
    ],
    evaluateExpression: (expression, context = null) => repository.evaluateExpression(expression, {
      stackId: contextStackId(context),
    }),
    evaluateLength,
    dimensionValueText: (annotation) => dimensionText(annotation, formatValueOnlyDimensionValue),
    dimensionDxfValueText: (annotation) => dimensionText(annotation, formatDxfDimensionValue),
    evaluateNumeric: (expression, context = null) => evaluateArrayCountExpression(expression, {
      evaluateLength: (value) => evaluateLength(value, context),
      drawingUnit,
    }),
  };
}

function transformPoint(point, matrix = identityMatrix) {
  if (!finitePoint(point)) return point;
  return [
    matrix.a * point[0] + matrix.c * point[1] + matrix.e,
    matrix.b * point[0] + matrix.d * point[1] + matrix.f,
  ];
}

function matrixNumber(value) {
  const rounded = Math.round(Number(value) * 1e9) / 1e9;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function matrixAttribute(matrix) {
  return [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].map(matrixNumber).join(' ');
}

function translationMatrix(x, y) {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

function rotationMatrix(angle, center) {
  const radians = angle * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const [x, y] = center;
  return {
    a: cos,
    b: sin,
    c: -sin,
    d: cos,
    e: x - cos * x + sin * y,
    f: y - sin * x - cos * y,
  };
}

function imageCorners(entity) {
  const x = Number(entity.x); const y = Number(entity.y);
  const width = Number(entity.width); const height = Number(entity.height);
  if (![x, y, width, height].every(Number.isFinite)) return [];
  const corners = [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
  const angle = Number(entity.rotation) || 0;
  if (!angle) return corners;
  const matrix = rotationMatrix(angle, [x + width / 2, y + height / 2]);
  return corners.map((point) => transformPoint(point, matrix));
}

function rawEntityPoints(entity) {
  if (entity.type === 'line') return [entity.start, entity.end];
  if (entity.type === 'circle') {
    const [x, y] = entity.center || [];
    const radius = Math.abs(Number(entity.radius));
    return Number.isFinite(radius) ? [[x - radius, y - radius], [x + radius, y + radius]] : [];
  }
  if (entity.type === 'rect' || entity.type === 'image' || entity.type === 'control') return imageCorners(entity);
  if (['polygon', 'polyline', 'curve'].includes(entity.type)) return entity.points || [];
  if (entity.type === 'arc') {
    const extentPoints = arcExtentPoints(entity);
    return extentPoints.length ? extentPoints : [entity.start, entity.arcPoint, entity.end];
  }
  if (entity.type === 'notch') return notchGeometryPoints(entity);
  if (entity.type === 'subtract-result' || entity.type === 'resolved-boundary') return entity.points || [];
  if (entity.type === 'text') {
    const x = Number(entity.x); const y = Number(entity.y);
    const fontSize = Math.max(1, Number(entity.fontSize) || 14);
    const lines = String(entity.text || '').split('\n');
    const width = Math.max(1, ...lines.map((line) => line.length)) * fontSize * 0.65;
    const height = Math.max(1, lines.length) * fontSize * 1.25;
    const left = entity.textAlign === 'center' ? x - width / 2 : entity.textAlign === 'right' ? x - width : x;
    const corners = [[left, y], [left + width, y], [left + width, y + height], [left, y + height]];
    const rotation = Number(entity.rotation) || 0;
    return rotation ? corners.map((point) => transformPoint(point, rotationMatrix(rotation, [x, y]))) : corners;
  }
  if (entity.type === 'table') {
    const width = (entity.columns || []).reduce((sum, column) => sum + Math.abs(Number(column?.width) || 0), 0);
    const height = (entity.rows || []).reduce((sum, row) => sum + Math.abs(Number(row?.height) || 0), 0);
    return [[Number(entity.x) || 0, Number(entity.y) || 0], [(Number(entity.x) || 0) + width, (Number(entity.y) || 0) + height]];
  }
  if (entity.type === 'dimension-line') return [entity.start, entity.end, entity.measureStart, entity.measureEnd, entity.label];
  if (entity.type === 'radius-dimension') {
    const result = [entity.center, entity.target, entity.elbow, entity.label];
    if (finitePoint(entity.center) && Number.isFinite(Number(entity.radius))) {
      const radius = Math.abs(Number(entity.radius));
      result.push([entity.center[0] - radius, entity.center[1] - radius], [entity.center[0] + radius, entity.center[1] + radius]);
    }
    return result;
  }
  if (entity.type === 'angle-dimension') return [entity.vertex, entity.start, entity.end, entity.label];
  if (entity.type === 'multi-curve-length-dimension') return [entity.target, entity.elbow, entity.label];
  if (entity.type === 'dimension-text') return [entity.label];
  return [];
}

function entityPoints(entity) {
  const matrix = entity._resolvedMatrix;
  const source = rawEntityPoints(entity).filter(finitePoint);
  return matrix ? source.map((point) => transformPoint(point, matrix)) : source;
}

function entityDataBounds(entities) {
  const all = entities.flatMap(entityPoints).filter(finitePoint);
  if (!all.length) return null;
  const xs = all.map(([x]) => x); const ys = all.map(([, y]) => y);
  const x = Math.min(...xs); const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function entityLocalDataBounds(entity) {
  return entityDataBounds([{ ...entity, _resolvedMatrix: null }]);
}

function drawingBounds(entities) {
  const bounds = entityDataBounds(entities);
  if (!bounds) return [0, 0, 100, 60];
  const width = Math.max(1, bounds.width); const height = Math.max(1, bounds.height);
  const pad = Math.max(width, height) * 0.15 + 4;
  return [bounds.x - pad, bounds.y - pad, width + pad * 2, height + pad * 2];
}

function pointFeature(entity, index = 0) {
  if (!entity) return null;
  if (entity.type === 'point') return index === 0 ? entity.point : null;
  if (entity.type === 'line') {
    if (index === 0) return entity.start;
    if (index === 1) return finitePoint(entity.start) && finitePoint(entity.end)
      ? [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2]
      : null;
    return entity.end;
  }
  if (entity.type === 'circle') return entity.center;
  if (entity.type === 'arc') return [entity.start, entity.arcPoint, entity.end][index] || entity.center;
  if (['polygon', 'polyline', 'curve'].includes(entity.type)) return entity.points?.[index] || null;
  if (entity.type === 'notch') return index === 0 ? entity.point : entity.end;
  if (['text', 'control', 'image', 'rect'].includes(entity.type)) return [entity.x, entity.y];
  return null;
}

function evaluatedEntities(drawing) {
  const raw = Array.isArray(drawing?.entities) ? drawing.entities : [];
  if (!raw.some((entity) => entity.type === 'fillet')) return raw.map(clone);
  const rawById = new Map(raw.filter(({ id }) => id).map((entity) => [entity.id, entity]));
  return evaluateFilletedGeometry(raw).map((entity) => {
    if (!entity.derivedFromFillet) return entity;
    return { ...(rawById.get(entity.id) || {}), ...entity };
  });
}

function derivedEntity(entity, matrix, stackId, id) {
  return {
    ...clone(entity),
    id,
    stackId,
    _resolvedMatrix: matrix,
    _resolvedSourceId: entity._resolvedSourceId || entity.id,
  };
}

function isOriginPlacement(definition, placement) {
  return definition.arrayType === 'rectangular'
    ? Math.abs(placement.translateX) < 1e-9 && Math.abs(placement.translateY) < 1e-9
    : Math.abs(placement.angle) < 1e-9;
}

export function materializeDrawingInstances(drawing = {}, {
  stackId = null,
  stackIds = null,
  evaluateNumeric = Number,
  evaluateLength = evaluateNumeric,
} = {}) {
  const fallbackStackId = defaultStackId(drawing.extensions?.stacks);
  const includedStackIds = stackIds ? new Set(stackIds) : null;
  const rawEntities = Array.isArray(drawing.entities) ? drawing.entities : [];
  const rawById = new Map(rawEntities.filter(({ id }) => id).map((entity) => [entity.id, entity]));
  const evaluated = evaluatedEntities(drawing);
  const evaluatedById = new Map(evaluated.filter(({ id }) => id).map((entity) => [entity.id, entity]));
  const swellDerived = deriveSwellGeometry({
    entities: evaluated,
    constraints: drawing.constraints || [],
    evaluateLength,
  });
  const presentationBoundsEntities = (sourceIds, sources) => {
    const selected = new Set(sourceIds);
    const pieces = [...swellDerived.values()]
      .filter(({ ownerId }) => selected.has(ownerId))
      .flatMap(({ pieces: derivedPieces }) => derivedPieces.map(({ entity }) => entity));
    return [...sources, ...pieces];
  };
  const ownsTargetStack = (entity) => {
    const ownerStackId = entity.stackId || fallbackStackId;
    return (stackId === null || ownerStackId === stackId)
      && (!includedStackIds || includedStackIds.has(ownerStackId));
  };
  const relationshipAvailable = (definition) => ownsTargetStack(definition)
    && (!includedStackIds || (definition.participantStackIds || [])
      .every((participantStackId) => includedStackIds.has(participantStackId)));
  const baseEntities = evaluated.filter(ownsTargetStack);
  const dimensionAnnotations = (drawing.dimensionAnnotations || []).filter(ownsTargetStack);
  const derived = [];

  (drawing.extensions?.linkedCopyTools?.copies || [])
    .filter(relationshipAvailable)
    .forEach((definition) => {
      const sourceIds = [...new Set((definition.sourceIds || []).filter(Boolean).map(String))];
      const directSources = sourceIds
        .map((id) => evaluatedById.get(id) || rawById.get(id))
        .filter((entity) => definition.type === 'symmetric' ? isMirrorableEntity(entity) : isDuplicableEntity(entity));
      const coordinateFrame = stackFrameFor(drawing.stackState, definition.stackId);
      const sourceBounds = entityDataBounds(presentationBoundsEntities(sourceIds, directSources)
        .map((entity) => transformStackEntity(entity, coordinateFrame, true)));
      if (!sourceBounds) return;
      const sourceAnchor = transformStackPoint([sourceBounds.x + sourceBounds.width / 2, sourceBounds.y + sourceBounds.height / 2], coordinateFrame);
      const matrix = linkedCopyMatrix(definition, sourceAnchor, coordinateFrame);
      const dependentIds = arrayDependentVisualIds(rawById, sourceIds);
      const sources = [...new Map([
        ...directSources,
        ...dependentIds.map((id) => evaluatedById.get(id) || rawById.get(id)).filter(Boolean),
      ].map((entity) => [entity.id, entity])).values()];
      sources.forEach((entity, index) => {
        derived.push(derivedEntity(
          entity,
          matrix,
          definition.stackId || fallbackStackId,
          deriveUuidForKey('thumbnail-linked-copy', definition.id, entity.id || index),
        ));
      });
    });

  (drawing.extensions?.arrayTools?.arrays || [])
    .filter(relationshipAvailable)
    .forEach((definition) => {
      const dependentIds = arrayDependentVisualIds(rawById, definition.sourceIds || []);
      const sourceIds = [...new Set([...(definition.sourceIds || []), ...dependentIds])];
      const sources = sourceIds.map((id) => evaluatedById.get(id) || rawById.get(id)).filter(Boolean);
      const coordinateFrame = stackFrameFor(drawing.stackState, definition.stackId);
      const boundsSources = presentationBoundsEntities(definition.sourceIds || [], sources);
      const sourceBounds = entityDataBounds(definition.arrayType === 'rectangular'
        ? boundsSources.map((entity) => transformStackEntity(entity, coordinateFrame, true)) : boundsSources);
      if (!sourceBounds) return;
      const centerEntity = rawById.get(definition.centerRef?.recordId);
      const referencedCenter = pointFeature(centerEntity, Number(definition.centerRef?.index) || 0);
      const centerPoint = finitePoint(referencedCenter) ? referencedCenter : definition.centerPoint;
      const result = evaluateArrayDefinition(definition, {
        evaluateNumeric: (expression) => evaluateNumeric(expression, definition),
        evaluateLength: (expression) => evaluateLength(expression, definition),
        sourceBounds,
        centerPoint,
        coordinateFrame,
      });
      if (!result.valid) return;
      result.placements.forEach((placement, placementIndex) => {
        if (isOriginPlacement(result.definition, placement)) return;
        const matrix = result.definition.arrayType === 'rectangular'
          ? translationMatrix(placement.translateX, placement.translateY)
          : rotationMatrix(placement.angle, centerPoint);
        sources.forEach((entity, entityIndex) => {
          derived.push(derivedEntity(
            entity,
            matrix,
            result.definition.stackId,
            deriveUuidForKey('thumbnail-array', result.definition.id, placementIndex, entity.id || entityIndex),
          ));
        });
      });
    });

  rawEntities
    .filter((entity) => isSymmetricCenterline(entity) && ownsTargetStack(entity))
    .forEach((centerline) => {
      const matrix = reflectionMatrix(centerline.start, centerline.end);
      if (!matrix) return;
      const sourceIds = centerline.composite?.sourceIds || [];
      const selected = new Set(sourceIds);
      const directSources = sourceIds
        .map((id) => rawById.get(id))
        .filter(isMirrorableEntity);
      const seamSources = rawEntities.filter((entity) => seamDependsOnSelectedSources(entity, selected));
      const sources = [...new Map([...directSources, ...seamSources].map((entity) => [entity.id, entity])).values()]
        .map((entity) => evaluatedById.get(entity.id) || entity);
      sources.forEach((entity, index) => {
        derived.push(derivedEntity(
          entity,
          matrix,
          centerline.stackId || fallbackStackId,
          deriveUuidForKey('thumbnail-symmetric', centerline.id, entity.id || index),
        ));
      });
    });

  return { ...drawing, entities: [...baseEntities, ...derived], dimensionAnnotations };
}

function materializeSwellScenePresentation(drawing, entities, evaluateLength) {
  const derived = deriveSwellGeometry({
    entities: evaluatedEntities(drawing),
    constraints: drawing.constraints || [],
    evaluateLength,
  });
  if (!derived.size) return entities;
  const boundaries = swellBoundariesFromDerived(derived);
  const closedOwnerIds = new Set(boundaries.flatMap(({ recordIds }) => recordIds));
  const results = [];
  const instancesFor = (ownerIds) => {
    const owners = new Set(ownerIds);
    const instances = new Map();
    entities.forEach((entity) => {
      if (!owners.has(thumbnailSourceId(entity))) return;
      const key = `${entity.stackId || ''}:${thumbnailMatrixKey(entity._resolvedMatrix)}`;
      if (!instances.has(key)) instances.set(key, entity);
    });
    return instances;
  };
  boundaries.forEach((boundary) => {
    instancesFor(boundary.recordIds).forEach((anchor, key) => {
      const appearanceSource = entities.find((entity) => (
        thumbnailSourceId(entity) === boundary.appearanceSourceId
        && thumbnailMatrixKey(entity._resolvedMatrix) === thumbnailMatrixKey(anchor._resolvedMatrix)
      )) || anchor;
      results.push({
        id: deriveUuidForKey('swell-thumbnail-boundary', boundary.id, key),
        type: 'resolved-boundary',
        stackId: anchor.stackId || boundary.stackId,
        d: swellBoundaryPath(boundary.features),
        points: clone(boundary.points),
        appearance: clone(appearanceSource.appearance || {}),
        _resolvedMatrix: anchor._resolvedMatrix,
        _resolvedSourceId: boundary.appearanceSourceId,
        _resolvedSourceIds: [...boundary.recordIds],
        _resolvedFeatures: clone(boundary.features),
        composite: {
          kind: 'swell-derived-presentation',
          ownerRecordId: boundary.appearanceSourceId,
          sourceRecordIds: [...boundary.recordIds],
        },
      });
    });
  });
  derived.forEach((result, ownerId) => {
    if (closedOwnerIds.has(ownerId)) return;
    instancesFor([ownerId]).forEach((anchor, key) => {
      result.pieces.forEach((piece, index) => results.push({
        ...clone(piece.entity),
        id: deriveUuidForKey('swell-thumbnail-piece', piece.id, key, index),
        stackId: anchor.stackId || result.sourceEntity?.stackId || null,
        appearance: clone(anchor.appearance || {}),
        _resolvedMatrix: anchor._resolvedMatrix,
        _resolvedSourceId: ownerId,
        _resolvedSourceIds: [ownerId],
        composite: {
          kind: 'swell-derived-presentation',
          ownerRecordId: ownerId,
          sourceRecordIds: [ownerId],
          pieceId: piece.id,
        },
      }));
    });
  });
  return [...entities, ...results];
}

function geometryStyle(entity, { closed = false, fillOverride = null } = {}) {
  const seam = entity.composite?.kind === 'finish-size-offset';
  const stroke = entity.construction ? '#dc2626' : seam ? '#666666' : entity.appearance?.strokeColor || '#202020';
  const thickness = Math.max(0.5, Number(entity.appearance?.strokeThickness) || 1);
  const opacity = Math.min(1, Math.max(0, Number(entity.appearance?.strokeOpacity) || 1));
  const hasFillOverride = typeof fillOverride === 'string';
  const fill = hasFillOverride
    ? fillOverride
    : closed && !entity.construction
      ? entityImageFillReference(entity)
        ? `url(#${thumbnailImagePatternId(entity)})`
        : entity.appearance?.fillColor || '#ffffff'
      : 'none';
  const fillOpacity = hasFillOverride
    ? fill === 'none' ? 0 : 1
    : closed && !entity.construction
      ? Math.min(1, Math.max(0, Number(entity.appearance?.fillOpacity ?? 1)))
      : 0;
  const dash = entity.construction ? '4 3' : seam ? '5 4' : '';
  return `fill="${escapeXml(fill)}" fill-opacity="${fillOpacity}" stroke="${stroke}" stroke-opacity="${opacity}" stroke-width="${thickness}" vector-effect="non-scaling-stroke"${dash ? ` stroke-dasharray="${dash}"` : ''}`;
}

function arcPath(entity) {
  if (!finitePoint(entity.start) || !finitePoint(entity.end) || !Number.isFinite(Number(entity.radius))) return '';
  const startAngle = finitePoint(entity.center)
    ? Math.atan2(entity.start[1] - entity.center[1], entity.start[0] - entity.center[0])
    : 0;
  const middleAngle = finitePoint(entity.center) && finitePoint(entity.arcPoint)
    ? Math.atan2(entity.arcPoint[1] - entity.center[1], entity.arcPoint[0] - entity.center[0])
    : null;
  const endAngle = finitePoint(entity.center)
    ? Math.atan2(entity.end[1] - entity.center[1], entity.end[0] - entity.center[0])
    : 0;
  const sweep = arcSweepFromAngles(startAngle, endAngle, middleAngle, {
    major: typeof entity.major === 'boolean' ? entity.major : null,
    ccw: typeof entity.ccw === 'boolean' ? entity.ccw : null,
  });
  return `M${entity.start[0]} ${entity.start[1]} A${entity.radius} ${entity.radius} 0 ${Math.abs(sweep.span) > Math.PI ? 1 : 0} ${sweep.ccw ? 1 : 0} ${entity.end[0]} ${entity.end[1]}`;
}

function controlMarkup(entity) {
  const x = Number(entity.x); const y = Number(entity.y);
  const width = Number(entity.width) || 80; const height = Number(entity.height) || 28;
  const label = entity.label ? `<text x="${x}" y="${y - 4}" fill="#202020" font-size="10">${escapeXml(entity.label)}</text>` : '';
  const body = entity.controlType === 'checkbox'
    ? `<rect x="${x + 4}" y="${y + 4}" width="${Math.min(16, height - 8)}" height="${Math.min(16, height - 8)}" ${geometryStyle(entity)}/>`
    : entity.controlType === 'vertical-slider'
      ? `<line x1="${x + width / 2}" y1="${y + 4}" x2="${x + width / 2}" y2="${y + height - 4}" ${geometryStyle(entity)}/><circle cx="${x + width / 2}" cy="${y + height / 2}" r="3" fill="#ffffff" stroke="#202020" vector-effect="non-scaling-stroke"/>`
      : entity.controlType === 'horizontal-slider'
        ? `<line x1="${x + 4}" y1="${y + height / 2}" x2="${x + width - 4}" y2="${y + height / 2}" ${geometryStyle(entity)}/><circle cx="${x + width / 2}" cy="${y + height / 2}" r="3" fill="#ffffff" stroke="#202020" vector-effect="non-scaling-stroke"/>`
        : `<rect x="${x + 2}" y="${y + 3}" width="${Math.max(1, width - 4)}" height="${Math.max(1, height - 6)}" ${geometryStyle(entity)}/>`;
  return `${label}${body}`;
}

function dimensionTextMarkup(entity, point, scale, { angle = 0, anchor = 'middle' } = {}) {
  if (!finitePoint(point)) return '';
  const transform = angle ? ` transform="rotate(${angle} ${point[0]} ${point[1]})"` : '';
  return `<text class="thumbnail-dimension-text" x="${point[0]}" y="${point[1]}" fill="#8b3dff" font-size="${10 / scale}" text-anchor="${anchor}" dominant-baseline="central"${transform}>${escapeXml(entity.text || '')}</text>`;
}

function dimensionSegmentMarkup(className, segment, common) {
  if (!finitePoint(segment?.start) || !finitePoint(segment?.end)) return '';
  return `<path class="${className}" d="M ${segment.start[0]} ${segment.start[1]} L ${segment.end[0]} ${segment.end[1]}" ${common}/>`;
}

function dimensionMarkup(entity, scale = 1) {
  if (entity.coordinateFrame) {
    const local = transformStackEntity(entity, entity.coordinateFrame, true);
    delete local.coordinateFrame;
    return `<g transform="${stackFrameMatrix(entity.coordinateFrame)}">${dimensionMarkup(local, scale)}</g>`;
  }
  const common = 'fill="none" stroke="#8b3dff" stroke-width="1" vector-effect="non-scaling-stroke"';
  const arrowStyle = 'fill="#8b3dff" stroke="none"';
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  if (entity.type === 'dimension-line') {
    if (!finitePoint(entity.start) || !finitePoint(entity.end)) return '';
    const layoutEntity = {
      ...entity,
      measureStart: finitePoint(entity.measureStart) ? entity.measureStart : entity.start,
      measureEnd: finitePoint(entity.measureEnd) ? entity.measureEnd : entity.end,
      label: finitePoint(entity.label)
        ? entity.label
        : [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2],
    };
    const layout = distanceDimensionLayout(layoutEntity, safeScale);
    return `${dimensionSegmentMarkup('thumbnail-dimension-extension', layout.extensionA, common)}${dimensionSegmentMarkup('thumbnail-dimension-extension', layout.extensionB, common)}${dimensionSegmentMarkup('thumbnail-dimension-path', { start: layout.dimensionStart, end: layout.dimensionEnd }, common)}<path class="thumbnail-dimension-arrow" d="${layout.arrowA}" ${arrowStyle}/><path class="thumbnail-dimension-arrow" d="${layout.arrowB}" ${arrowStyle}/>${dimensionTextMarkup(entity, layout.textPoint, safeScale, { angle: layout.angle })}`;
  }
  if (entity.type === 'radius-dimension') {
    if (!finitePoint(entity.center)) return '';
    const layout = radiusDimensionLayout(entity, safeScale);
    const secondArrow = layout.arrowB
      ? `<path class="thumbnail-dimension-arrow" d="${layout.arrowB}" ${arrowStyle}/>`
      : '';
    return `<path class="thumbnail-dimension-path" d="${layout.leaderPath}" ${common}/><path class="thumbnail-dimension-arrow" d="${layout.arrowA}" ${arrowStyle}/>${secondArrow}${dimensionTextMarkup(entity, layout.label, safeScale, { anchor: layout.textAnchor })}`;
  }
  if (entity.type === 'multi-curve-length-dimension') {
    if (!finitePoint(entity.target)) return '';
    const layout = mclDimensionLayout(entity, safeScale);
    return `<path class="thumbnail-dimension-path" d="${layout.leaderPath}" ${common}/><path class="thumbnail-dimension-arrow" d="${layout.arrow}" ${arrowStyle}/>${dimensionTextMarkup(entity, layout.label, safeScale, { anchor: layout.textAnchor })}`;
  }
  if (entity.type === 'angle-dimension') {
    if (![entity.vertex, entity.start, entity.end].every(finitePoint)) return '';
    const layoutEntity = { ...entity, label: finitePoint(entity.label) ? entity.label : entity.vertex };
    const layout = angleDimensionLayout(layoutEntity, safeScale);
    return `${dimensionSegmentMarkup('thumbnail-dimension-extension', layout.extensionA, common)}${dimensionSegmentMarkup('thumbnail-dimension-extension', layout.extensionB, common)}<path class="thumbnail-dimension-path" d="${layout.arcPath}" ${common}/><path class="thumbnail-dimension-arrow" d="${layout.arrowA}" ${arrowStyle}/><path class="thumbnail-dimension-arrow" d="${layout.arrowB}" ${arrowStyle}/>${dimensionTextMarkup(entity, layout.textPoint, safeScale)}`;
  }
  if (entity.type === 'dimension-text') return dimensionTextMarkup(entity, entity.label, safeScale);
  return '';
}

function drawingTextMarkup(entity) {
  const layout = drawingTextSvgLayout(entity);
  const transform = Number(entity.rotation)
    ? ` transform="rotate(${Number(entity.rotation)} ${entity.x} ${entity.y})"`
    : '';
  const lines = layout.lines.map((line, index) => (
    `<tspan x="${layout.contentX}" y="${layout.contentY + index * layout.lineHeight}">${escapeXml(line)}</tspan>`
  )).join('');
  return `<text class="thumbnail-drawing-text" x="${layout.contentX}" y="${layout.contentY}" fill="${escapeXml(entity.fontColor || '#202020')}" font-family="${escapeXml(entity.fontName || 'Arial')}" font-size="${layout.fontSize}" text-anchor="${layout.anchor}" dominant-baseline="text-before-edge" xml:space="preserve"${transform}>${lines}</text>`;
}

function rawEntityMarkup(entity, scale) {
  if (entity.type === 'subtract-result') {
    return `<path class="thumbnail-subtract-result" d="${escapeXml(entity.d)}" fill-rule="evenodd" ${geometryStyle(entity, { closed: true })}/>`;
  }
  if (entity.type === 'resolved-boundary') {
    return `<path class="thumbnail-resolved-boundary" d="${escapeXml(entity.d)}" ${geometryStyle(entity, { closed: true })}/>`;
  }
  if (entity.type === 'line') return `<line x1="${entity.start?.[0]}" y1="${entity.start?.[1]}" x2="${entity.end?.[0]}" y2="${entity.end?.[1]}" ${geometryStyle(entity)}/>`;
  if (entity.type === 'circle') return `<circle cx="${entity.center?.[0]}" cy="${entity.center?.[1]}" r="${entity.radius}" ${geometryStyle(entity, { closed: true })}/>`;
  if (entity.type === 'rect') return `<rect x="${entity.x}" y="${entity.y}" width="${entity.width}" height="${entity.height}" ${geometryStyle(entity, { closed: true })}/>`;
  if (entity.type === 'polygon') return `<polygon points="${points(entity.points)}" ${geometryStyle(entity, { closed: true })}/>`;
  if (entity.type === 'polyline') return `<polyline points="${points(entity.points)}" ${geometryStyle(entity)}/>`;
  if (entity.type === 'curve' && entity.points?.length >= 4) {
    const [a, b, c, d] = entity.points;
    return `<path d="M${a} C${b} ${c} ${d}" ${geometryStyle(entity)}/>`;
  }
  if (entity.type === 'arc') return `<path d="${arcPath(entity)}" ${geometryStyle(entity)}/>`;
  if (entity.type === 'notch') {
    return `<path d="${notchSvgPath(entity)}" ${geometryStyle(entity, { fillOverride: notchFillColor(entity) })}/>`;
  }
  if (entity.type === 'image') {
    const corners = imageCorners(entity);
    return `<polygon points="${points(corners)}" fill="#e5e7eb" fill-opacity=".7" stroke="#202020" stroke-width="1" vector-effect="non-scaling-stroke"/><line x1="${corners[0]?.[0]}" y1="${corners[0]?.[1]}" x2="${corners[2]?.[0]}" y2="${corners[2]?.[1]}" stroke="#9ca3af" vector-effect="non-scaling-stroke"/><line x1="${corners[1]?.[0]}" y1="${corners[1]?.[1]}" x2="${corners[3]?.[0]}" y2="${corners[3]?.[1]}" stroke="#9ca3af" vector-effect="non-scaling-stroke"/>`;
  }
  if (entity.type === 'control') return controlMarkup(entity);
  if (entity.type === 'text') return drawingTextMarkup(entity);
  if (entity.type === 'table') {
    const columns = entity.columns || [];
    const rows = entity.rows || [];
    const x = Number(entity.x) || 0;
    const y = Number(entity.y) || 0;
    const width = columns.reduce((sum, column) => sum + Math.abs(Number(column?.width) || 0), 0);
    const height = rows.reduce((sum, row) => sum + Math.abs(Number(row?.height) || 0), 0);
    const stroke = entity.appearance?.strokeColor || '#202020';
    const fill = entity.appearance?.fillColor || '#ffffff';
    const cells = [];
    let rowY = y;
    rows.forEach((row, rowIndex) => {
      let columnX = x;
      columns.forEach((column, columnIndex) => {
        const cell = entity.cells?.[rowIndex]?.[columnIndex] || {};
        const cellWidth = Math.abs(Number(column?.width) || 0);
        const cellHeight = Math.abs(Number(row?.height) || 0);
        if (!cell.mergedInto) {
          cells.push(`<rect x="${columnX}" y="${rowY}" width="${cellWidth}" height="${cellHeight}" fill="${cell.fillColor || fill}" fill-opacity="${cell.fillOpacity ?? 1}" stroke="${cell.strokeColor || stroke}" stroke-opacity="${cell.strokeOpacity ?? 1}" stroke-width="${cell.strokeThickness || 1}"/>`);
          if (cell.text) {
            const textAlign = ['left', 'center', 'right'].includes(cell.textAlign) ? cell.textAlign : 'left';
            const textVerticalAlign = ['top', 'middle', 'bottom'].includes(cell.textVerticalAlign) ? cell.textVerticalAlign : 'top';
            const textX = textAlign === 'center'
              ? columnX + cellWidth / 2
              : textAlign === 'right' ? columnX + cellWidth - 4 : columnX + 4;
            const textY = textVerticalAlign === 'middle'
              ? rowY + cellHeight / 2
              : textVerticalAlign === 'bottom' ? rowY + cellHeight - 3 : rowY + 4;
            const textAnchor = textAlign === 'center' ? 'middle' : textAlign === 'right' ? 'end' : 'start';
            const dominantBaseline = textVerticalAlign === 'middle' ? 'middle' : textVerticalAlign === 'bottom' ? 'alphabetic' : 'hanging';
            cells.push(`<text x="${textX}" y="${textY}" fill="${cell.fontColor || '#202020'}" font-family="${cell.fontName || 'Arial'}" font-size="${Number(cell.fontSize) || 14}" text-anchor="${textAnchor}" dominant-baseline="${dominantBaseline}">${escapeXml(cell.text)}</text>`);
          }
        }
        columnX += cellWidth;
      });
      rowY += Math.abs(Number(row?.height) || 0);
    });
    return `<g class="table-export" data-entity-id="${entity.id || ''}">${cells.join('')}<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" stroke="${stroke}"/></g>`;
  }
  if (String(entity.type || '').includes('dimension')) return dimensionMarkup(entity, scale);
  return '';
}

function entityMarkup(entity, scale) {
  const markup = rawEntityMarkup(entity, scale);
  if (!markup || !entity._resolvedMatrix) return markup;
  return `<g transform="matrix(${matrixAttribute(entity._resolvedMatrix)})">${markup}</g>`;
}

function thumbnailSourceId(entity) {
  return entity?._resolvedSourceId || entity?.id;
}

function thumbnailSourceIds(entity) {
  return new Set([
    thumbnailSourceId(entity),
    ...(entity?._resolvedSourceIds || []),
  ].filter(Boolean));
}

function thumbnailMatrixKey(matrix) {
  return matrixAttribute(matrix || identityMatrix);
}

function isSeamLinePresentation(entity) {
  return entity?.composite?.kind === 'finish-size-offset';
}

function thumbnailPresentationLayer(entity) {
  if (String(entity?.type || '').includes('dimension')) return 3;
  if (entity?.type === 'notch') return 2;
  if (entity?.construction === true) return 1;
  return 0;
}

function thumbnailPresentationOwnerId(entity) {
  return entity?.composite?.ownerRecordId
    || entity?.composite?.sourceRecordIds?.[0]
    || null;
}

function sharesThumbnailInstance(owner, presentation, ownerRecordId) {
  return thumbnailPresentationLayer(owner) === 0
    && thumbnailSourceIds(owner).has(ownerRecordId)
    && (owner.stackId || null) === (presentation.stackId || null)
    && thumbnailMatrixKey(owner._resolvedMatrix) === thumbnailMatrixKey(presentation._resolvedMatrix);
}

export function orderThumbnailEntities(drawing = {}, entities = []) {
  const stackState = normalizeStackState(drawing.extensions?.stacks);
  const knownStackIds = new Set(stackState.stacks.map(({ id }) => id));
  const stackOrder = new Map(stackState.stacks.map(({ id }, index) => [id, index]));
  const sourceOrder = new Map([
    ...(drawing.entities || []),
    ...(drawing.dimensionAnnotations || drawing.annotations || []),
  ].map((entity, index) => [entity.id, index]));
  const presentationEntities = entities.filter(isSeamLinePresentation);
  const orderedOwners = entities
    .filter((entity) => !isSeamLinePresentation(entity))
    .map((entity, materializedIndex) => {
      const sourceIndexes = [...thumbnailSourceIds(entity)]
        .map((sourceId) => sourceOrder.get(sourceId))
        .filter(Number.isFinite);
      const originalIndex = sourceIndexes.length ? Math.min(...sourceIndexes) : materializedIndex;
      const rawZIndex = entity.appearance?.zIndex;
      const zIndex = rawZIndex !== null && rawZIndex !== undefined && Number.isFinite(Number(rawZIndex))
        ? Number(rawZIndex)
        : originalIndex;
      const stackId = entityStackId(entity, knownStackIds);
      return {
        entity,
        materializedIndex,
        originalIndex,
        layer: thumbnailPresentationLayer(entity),
        stackIndex: stackOrder.get(stackId) ?? 0,
        zIndex,
      };
    })
    .sort((a, b) => (
      a.layer - b.layer
      || (a.layer === 0 ? a.stackIndex - b.stackIndex : 0)
      || a.zIndex - b.zIndex
      || a.originalIndex - b.originalIndex
      || a.materializedIndex - b.materializedIndex
    ))
    .map(({ entity }) => entity);

  const presentationsByOwner = new Map();
  presentationEntities.forEach((presentation) => {
    const ownerRecordId = thumbnailPresentationOwnerId(presentation);
    const ownerIndex = ownerRecordId
      ? orderedOwners.findIndex((owner) => sharesThumbnailInstance(owner, presentation, ownerRecordId))
      : -1;
    if (ownerIndex < 0) {
      return;
    }
    const owned = presentationsByOwner.get(ownerIndex) || [];
    owned.push(presentation);
    presentationsByOwner.set(ownerIndex, owned);
  });

  return orderedOwners.flatMap((owner, index) => [
    owner,
    ...(presentationsByOwner.get(index) || []),
  ]);
}

function applySubtractScenePresentation(drawing, entities, {
  evaluateExpression,
  evaluateNumeric,
  evaluateLength,
} = {}) {
  const presentation = subtractDrawingResults(drawing, {
    evaluateExpression,
    evaluateNumeric,
    evaluateLength,
  });
  if (!presentation.suppressedRecordIds.size) return entities;
  const resultEntities = [];
  presentation.results.forEach((result) => {
    const instances = new Map();
    entities.forEach((entity) => {
      if (!result.recordIds.some((recordId) => thumbnailSourceIds(entity).has(recordId))) return;
      const key = `${entity.stackId || result.stackId}:${thumbnailMatrixKey(entity._resolvedMatrix)}`;
      if (!instances.has(key)) instances.set(key, entity);
    });
    instances.forEach((anchor, key) => {
      resultEntities.push({
        id: deriveUuidForKey('thumbnail-subtract', result.id, key),
        type: 'subtract-result',
        stackId: anchor.stackId || result.stackId,
        d: result.d,
        points: result.points,
        appearance: clone(result.appearance),
        _resolvedMatrix: anchor._resolvedMatrix,
        _resolvedSourceId: result.recordIds[0],
        _resolvedSourceIds: [...result.recordIds],
        ...(anchor.construction === true ? { construction: true } : {}),
        ...(anchor.composite ? { composite: clone(anchor.composite) } : {}),
        _resolvedContours: clone(subtractBoundaryContours(
          result.plan.features,
          result.plan.tolerance,
        )),
        _resolvedTolerance: result.plan.tolerance,
      });
    });
  });
  return [
    ...entities.filter((entity) => (
      ![...thumbnailSourceIds(entity)].some((sourceId) => presentation.suppressedRecordIds.has(sourceId))
    )),
    ...resultEntities,
  ];
}

function applyResolvedBoundaryScenePresentation(drawing, entities) {
  const sourceEntities = (drawing?.entities || []).filter((entity) => !isSwellEntity(entity));
  const boundaries = [
    ...resolveClosedBoundaries(sourceEntities, drawing?.constraints || []),
    ...resolveClosedBoundaries(
      sourceEntities
        .filter((entity) => (
          entity.type !== 'circle'
          && (entity.construction === true || isSymmetricCenterline(entity))
        ))
        .map((entity) => ({ ...clone(entity), construction: false })),
      drawing?.constraints || [],
    ),
  ];
  if (!boundaries.length) return entities;
  const suppressed = new Set(boundaries.flatMap((boundary) => boundary.recordIds));
  const results = [];
  boundaries.forEach((boundary) => {
    const instances = new Map();
    entities.forEach((entity) => {
      if (!boundary.recordIds.includes(thumbnailSourceId(entity))) return;
      const key = `${entity.stackId || boundary.stackId}:${thumbnailMatrixKey(entity._resolvedMatrix)}`;
      if (!instances.has(key)) instances.set(key, entity);
    });
    instances.forEach((anchor, key) => {
      const appearanceSource = entities.find((entity) => (
        thumbnailSourceId(entity) === boundary.appearanceSourceId
        && thumbnailMatrixKey(entity._resolvedMatrix) === thumbnailMatrixKey(anchor._resolvedMatrix)
      )) || anchor;
      results.push({
        id: deriveUuidForKey('thumbnail-resolved', boundary.id, key),
        type: 'resolved-boundary',
        stackId: anchor.stackId || boundary.stackId,
        d: boundary.d,
        points: boundary.points,
        appearance: clone(appearanceSource.appearance || {}),
        _resolvedMatrix: anchor._resolvedMatrix,
        _resolvedSourceId: boundary.appearanceSourceId,
        _resolvedSourceIds: [...boundary.recordIds],
        _resolvedFeatures: clone(boundary.features),
        ...(appearanceSource.construction === true ? { construction: true } : {}),
        ...(appearanceSource.composite ? { composite: clone(appearanceSource.composite) } : {}),
      });
    });
  });
  return [
    ...entities.filter((entity) => !suppressed.has(thumbnailSourceId(entity))),
    ...results,
  ];
}

export function resolveDrawingScene(drawing, {
  stackId = null,
  stackIds = null,
  evaluateNumeric = null,
  evaluateLength = null,
  evaluateExpression = null,
  excludeConstruction = false,
} = {}) {
  drawing = materializeDrawingClassAppearances(drawing);
  const storedEvaluators = drawingThumbnailEvaluators(drawing);
  const resolvedEvaluateLength = evaluateLength || storedEvaluators.evaluateLength;
  const resolvedEvaluateNumeric = evaluateNumeric || ((expression, context = null) => evaluateArrayCountExpression(expression, {
    evaluateLength: (value) => resolvedEvaluateLength(value, context),
    drawingUnit: drawing?.drawingUnit || 'in',
  }));
  const resolvedEvaluateExpression = evaluateExpression || storedEvaluators.evaluateExpression;
  const seamEntities = materializeSeamLineEntitiesForDrawing(drawing, {
    evaluateExpression: resolvedEvaluateExpression,
    evaluateNumeric: resolvedEvaluateNumeric,
    evaluateLength: resolvedEvaluateLength,
  });
  const legacySeamEntities = (drawing.entities || []).filter(
    (entity) => entity.composite?.kind === 'finish-size-offset',
  );
  const drawingWithSeams = {
    ...drawing,
    entities: [
      ...(drawing.entities || []).filter((entity) => entity.composite?.kind !== 'finish-size-offset'),
      ...(seamEntities.length ? seamEntities : legacySeamEntities),
    ],
  };
  const materialized = materializeDrawingInstances(drawingWithSeams, {
    stackId,
    stackIds,
    evaluateNumeric: resolvedEvaluateNumeric,
    evaluateLength: resolvedEvaluateLength,
  });
  const swellPresented = materializeSwellScenePresentation(
    drawingWithSeams,
    Array.isArray(materialized.entities) ? materialized.entities : [],
    resolvedEvaluateLength,
  );
  const includedStackIds = stackIds ? new Set(stackIds) : null;
  const entities = filterVisibleResolvedEntities(drawingWithSeams, applySubtractScenePresentation(
    drawingWithSeams,
    applyResolvedBoundaryScenePresentation(
      drawingWithSeams,
      swellPresented.filter((entity) => !excludeConstruction || entity.construction !== true),
    ),
    {
      evaluateExpression: resolvedEvaluateExpression,
      evaluateNumeric: resolvedEvaluateNumeric,
      evaluateLength: resolvedEvaluateLength,
    },
  ), resolvedEvaluateExpression).filter((entity) => (
    !includedStackIds || includedStackIds.has(entity.stackId || defaultStackId(drawingWithSeams.extensions?.stacks))
  ));
  return {
    drawing: drawingWithSeams,
    entities,
    dimensionAnnotations: Array.isArray(materialized.dimensionAnnotations)
      ? materialized.dimensionAnnotations
      : [],
    evaluators: {
      ...storedEvaluators,
      evaluateExpression: resolvedEvaluateExpression,
      evaluateNumeric: resolvedEvaluateNumeric,
      evaluateLength: resolvedEvaluateLength,
    },
  };
}

export const materializeThumbnailDrawing = materializeDrawingInstances;

export function createDrawingThumbnailSvg(drawing, {
  width = 240,
  height = 150,
  stackId = null,
  includeDimensions = true,
  dimensionTextMode = 'value',
  evaluateNumeric = null,
  evaluateLength = null,
  evaluateExpression = null,
  background = DRAWING_CANVAS_BACKGROUND,
} = {}) {
  const scene = resolveDrawingScene(drawing, {
    stackId,
    evaluateNumeric,
    evaluateLength,
    evaluateExpression,
    excludeConstruction: dimensionTextMode === 'value',
  });
  const {
    drawing: drawingWithSeams,
    entities,
    evaluators: storedEvaluators,
  } = scene;
  const resolvedEvaluateNumeric = storedEvaluators.evaluateNumeric;
  const resolvedEvaluateExpression = storedEvaluators.evaluateExpression;
  const resolvedEvaluateAppearance = (expression, context = null) => {
    try {
      return resolvedEvaluateExpression(expression, context);
    } catch {
      return resolvedEvaluateNumeric(expression, context);
    }
  };
  const annotations = includeDimensions && Array.isArray(scene.dimensionAnnotations)
    ? scene.dimensionAnnotations
      .filter((annotation) => !dimensionExcludedFromExport(annotation))
      .map((annotation) => dimensionTextMode === 'value'
        ? { ...annotation, text: storedEvaluators.dimensionValueText(annotation) }
        : annotation)
    : [];
  const drawable = orderThumbnailEntities(drawingWithSeams, [...entities, ...annotations]).map((entity) => {
    const withText = entity.type === 'text'
      ? {
        ...entity,
        text: resolveTextFields(
          entity.text,
          storedEvaluators.expressionEntries(entity),
          (entry) => formatUnitlessValue(entry.value, drawingWithSeams.drawingUnit),
          (expression) => storedEvaluators.evaluateExpression(expression, entity),
        ),
      }
      : entity;
    if (!withText.appearance) return withText;
    const resolved = resolveGeometryFillAppearance(
      withText.appearance,
      (expression) => resolvedEvaluateAppearance(expression, withText),
      (expression) => storedEvaluators.evaluateLength(expression, withText),
    );
    return { ...withText, appearance: { ...withText.appearance, ...resolved } };
  });
  let [x, y, viewWidth, viewHeight] = drawingBounds(drawable);
  const targetRatio = width / height;
  const viewRatio = viewWidth / viewHeight;
  if (viewRatio > targetRatio) {
    const adjustedHeight = viewWidth / targetRatio;
    y -= (adjustedHeight - viewHeight) / 2;
    viewHeight = adjustedHeight;
  } else {
    const adjustedWidth = viewHeight * targetRatio;
    x -= (adjustedWidth - viewWidth) / 2;
    viewWidth = adjustedWidth;
  }
  const thumbnailScale = Math.max(0.0001, Math.min(width / viewWidth, height / viewHeight));
  const patternDefinitions = new Map();
  drawable.filter(entityImageFillReference).forEach((entity) => {
    const bounds = entityLocalDataBounds(entity);
    const definition = imageFillPatternDefinition(entity.appearance, bounds);
    patternDefinitions.set(definition.key, {
      definition,
      id: imageFillPatternId(entity.appearance, 'thumbnail-image-fill', bounds),
    });
  });
  const patterns = [...patternDefinitions.values()].map(({ definition, id }) => (
    `<pattern id="${id}" ${svgAttributes(definition.pattern)}><rect ${svgAttributes(definition.rect)}/><image ${svgAttributes(definition.image)}/></pattern>`
  )).join('');
  const backgroundMarkup = background === null || background === 'none' || background === 'transparent'
    ? ''
    : `<rect x="${x}" y="${y}" width="${viewWidth}" height="${viewHeight}" fill="${escapeXml(background)}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${viewWidth} ${viewHeight}" preserveAspectRatio="xMidYMid meet"><metadata>${drawingThumbnailVersion}</metadata>${patterns ? `<defs>${patterns}</defs>` : ''}${backgroundMarkup}${drawable.map((entity) => entityMarkup(entity, thumbnailScale)).join('')}</svg>`;
}

export function createDrawingThumbnail(drawing, options = {}) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(createDrawingThumbnailSvg(drawing, options))}`;
}

export function drawingThumbnailSvgFromDataUrl(value) {
  const prefix = 'data:image/svg+xml;charset=utf-8,';
  if (!String(value || '').startsWith(prefix)) return '';
  try {
    const svg = decodeURIComponent(String(value).slice(prefix.length));
    return svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')
      && svg.includes(`<metadata>${drawingThumbnailVersion}</metadata>`)
      ? svg
      : '';
  } catch {
    return '';
  }
}
