import { createStableId } from './solver/SolverModel.js';

export const DEFAULT_CLASS_ID = 'class-x';
export const DEFAULT_CLASS_NAME = 'X';
export const CLASS_STATE_VERSION = 1;

const clone = (value) => JSON.parse(JSON.stringify(value));
const normalizedName = (value) => String(value ?? '').trim();
const nameKey = (value) => normalizedName(value).toLocaleLowerCase();

export const CLASS_APPEARANCE_GROUPS = Object.freeze({
  fill: Object.freeze([
    'fillExpression',
    'fillColor',
    'fillType',
    'fillImageReference',
    'fillImageMode',
    'fillImageRotationAngle',
    'fillImageScaleExpression',
    'fillImageScale',
    'fillImageAspectRatio',
    'fillImagePixelWidth',
    'fillImagePixelHeight',
    'fillImageWidthExpression',
    'fillImageHeightExpression',
    'fillImageWidth',
    'fillImageHeight',
    'fillImageLeftExpression',
    'fillImageTopExpression',
    'fillImageLeft',
    'fillImageTop',
  ]),
  fillOpacity: Object.freeze(['fillOpacityExpression', 'fillOpacity']),
  stroke: Object.freeze([
    'strokeExpression',
    'strokeColor',
    'strokeType',
    'strokeImageReference',
    'strokeImageAspectRatio',
    'strokeImagePixelWidth',
    'strokeImagePixelHeight',
    'strokeImageWidthExpression',
    'strokeImageHeightExpression',
    'strokeImageWidth',
    'strokeImageHeight',
  ]),
  strokeThickness: Object.freeze(['strokeThickness']),
  strokeOpacity: Object.freeze(['strokeOpacityExpression', 'strokeOpacity']),
  visible: Object.freeze(['visibleExpression', 'visible']),
});

export const CLASS_ENTITY_PROPERTY_GROUPS = Object.freeze({
  fontName: Object.freeze(['fontName']),
  fontSize: Object.freeze(['fontSize', 'textHeight']),
  fontColor: Object.freeze(['fontColor']),
  scaleWithZoom: Object.freeze(['scaleWithZoom']),
  multiline: Object.freeze(['multiline']),
  textAlign: Object.freeze(['textAlign']),
  textVerticalAlign: Object.freeze(['textVerticalAlign']),
});

const ALL_CLASS_PROPERTY_GROUPS = Object.freeze({
  ...CLASS_APPEARANCE_GROUPS,
  ...CLASS_ENTITY_PROPERTY_GROUPS,
});
const GROUP_NAMES = Object.freeze(Object.keys(ALL_CLASS_PROPERTY_GROUPS));
const GROUP_BY_PROPERTY = new Map(GROUP_NAMES.flatMap((group) => (
  ALL_CLASS_PROPERTY_GROUPS[group].map((property) => [property, group])
)));
const CLASS_GEOMETRY_TYPES = new Set([
  'point', 'line', 'circle', 'rect', 'polygon', 'polyline', 'curve', 'arc', 'fillet', 'text',
]);
const TEXT_CLASS_PROPERTY_GROUPS = new Set([
  'fontName', 'fontSize', 'fontColor', 'scaleWithZoom', 'multiline', 'textAlign', 'textVerticalAlign',
]);

export function isClassGeometryEntity(entity = {}) {
  return CLASS_GEOMETRY_TYPES.has(entity?.type);
}

export function createDefaultClassProperties() {
  return {
    fillExpression: '#ffffff',
    fillOpacityExpression: '100',
    strokeExpression: '#202020',
    strokeThickness: 1.5,
    strokeOpacityExpression: '100',
    visibleExpression: 'TRUE',
    fontName: 'Arial',
    fontSize: 28,
    fontColor: '#202020',
    scaleWithZoom: true,
    multiline: true,
    textAlign: 'left',
    textVerticalAlign: 'top',
  };
}

export function createDefaultClass() {
  return {
    id: DEFAULT_CLASS_ID,
    name: DEFAULT_CLASS_NAME,
    removable: false,
    duplicable: false,
    properties: createDefaultClassProperties(),
  };
}

export function normalizeClassProperties(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = { ...createDefaultClassProperties(), ...clone(source) };
  result.fillExpression = String(result.fillExpression ?? '#ffffff').trim() || '#ffffff';
  result.fillOpacityExpression = String(result.fillOpacityExpression ?? '100').trim() || '100';
  result.strokeExpression = String(result.strokeExpression ?? '#202020').trim() || '#202020';
  result.strokeOpacityExpression = String(result.strokeOpacityExpression ?? '100').trim() || '100';
  result.visibleExpression = String(result.visibleExpression ?? 'TRUE').trim() || 'TRUE';
  const thickness = Number(result.strokeThickness);
  result.strokeThickness = Number.isFinite(thickness)
    ? Math.min(40, Math.max(0.1, thickness))
    : 1.5;
  delete result.construction;
  result.fontName = String(result.fontName || 'Arial');
  const fontSize = Number(result.fontSize);
  result.fontSize = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 28;
  result.fontColor = /^#[0-9a-f]{6}$/i.test(String(result.fontColor || ''))
    ? String(result.fontColor)
    : '#202020';
  result.scaleWithZoom = result.scaleWithZoom !== false;
  result.multiline = result.multiline !== false;
  result.textAlign = ['left', 'center', 'right'].includes(result.textAlign) ? result.textAlign : 'left';
  result.textVerticalAlign = ['top', 'middle', 'bottom'].includes(result.textVerticalAlign)
    ? result.textVerticalAlign
    : 'top';
  return result;
}

export function normalizeClassState(value = null) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sourceClasses = Array.isArray(input.classes) ? input.classes : [];
  const classes = [];
  const seenIds = new Set();
  const seenNames = new Set();
  let defaultProperties = null;

  sourceClasses.forEach((item, index) => {
    const requestedId = normalizedName(item?.id);
    const requestedName = normalizedName(item?.name);
    const isDefault = requestedId === DEFAULT_CLASS_ID || nameKey(requestedName) === nameKey(DEFAULT_CLASS_NAME);
    if (isDefault) {
      if (!defaultProperties) defaultProperties = normalizeClassProperties(item?.properties);
      return;
    }
    if (!requestedId || seenIds.has(requestedId) || !requestedName) return;
    const key = nameKey(requestedName);
    if (seenNames.has(key) || key === nameKey(DEFAULT_CLASS_NAME)) return;
    seenIds.add(requestedId);
    seenNames.add(key);
    classes.push({
      id: requestedId,
      name: requestedName || `Class ${index + 1}`,
      removable: true,
      duplicable: true,
      properties: normalizeClassProperties(item?.properties),
    });
  });

  const defaultClass = createDefaultClass();
  if (defaultProperties) defaultClass.properties = defaultProperties;
  classes.unshift(defaultClass);
  seenIds.add(DEFAULT_CLASS_ID);
  const requestedActiveId = normalizedName(input.activeClassId);
  const activeClassId = classes.some(({ id }) => id === requestedActiveId)
    ? requestedActiveId
    : DEFAULT_CLASS_ID;
  return { version: CLASS_STATE_VERSION, activeClassId, classes };
}

function classState(value) {
  return value?.version === CLASS_STATE_VERSION
    && Array.isArray(value.classes)
    && value.classes.some(({ id }) => id === DEFAULT_CLASS_ID)
    ? value
    : normalizeClassState(value);
}

function normalizedOverrideGroups(value) {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.keys(value).filter((key) => value[key])
      : [];
  return [...new Set(source.filter((group) => GROUP_NAMES.includes(group)))];
}

export function classOverrideGroupsForAppearance(appearance = {}) {
  const result = new Set();
  Object.keys(appearance || {}).forEach((property) => {
    const group = GROUP_BY_PROPERTY.get(property);
    if (group) result.add(group);
  });
  return [...result];
}

export function classOverrideGroupsForEntity(entity = {}) {
  const result = new Set(classOverrideGroupsForAppearance(entity.appearance || {}));
  Object.keys(entity || {}).forEach((property) => {
    const group = GROUP_BY_PROPERTY.get(property);
    if (group && CLASS_ENTITY_PROPERTY_GROUPS[group]) result.add(group);
  });
  return [...result];
}

export function classOverrideGroupsForPatch(patch = {}) {
  return classOverrideGroupsForAppearance(patch);
}

export function classIdForEntity(entity = {}, stateInput = null) {
  const state = classState(stateInput);
  const requested = normalizedName(entity?.classId);
  return state.classes.some(({ id }) => id === requested) ? requested : DEFAULT_CLASS_ID;
}

export function normalizeEntityClass(entity = {}, stateInput = null, { legacy = false } = {}) {
  const state = classState(stateInput);
  const result = clone(entity || {});
  const requested = normalizedName(result.classId);
  const known = state.classes.some(({ id }) => id === requested);
  result.classId = known
    ? requested
    : legacy || !requested
      ? DEFAULT_CLASS_ID
      : state.activeClassId;
  result.classPropertyOverrides = result.classPropertyOverrides === undefined
    ? classOverrideGroupsForEntity(result)
    : normalizedOverrideGroups(result.classPropertyOverrides);
  return result;
}

export function resolveClassAppearance(entity = {}, stateInput = null) {
  const state = classState(stateInput);
  const classId = classIdForEntity(entity, state);
  const definition = state.classes.find(({ id }) => id === classId) || state.classes[0];
  const inherited = {};
  Object.values(CLASS_APPEARANCE_GROUPS).flat().forEach((property) => {
    if (definition.properties[property] !== undefined) inherited[property] = clone(definition.properties[property]);
  });
  const direct = clone(entity.appearance || {});
  const overrides = new Set(normalizedOverrideGroups(entity.classPropertyOverrides));
  Object.keys(CLASS_APPEARANCE_GROUPS).forEach((group) => {
    CLASS_APPEARANCE_GROUPS[group].forEach((property) => {
      if (overrides.has(group)) delete inherited[property];
      else delete direct[property];
    });
  });
  return { ...inherited, ...direct };
}

function entityPropertyGroups(entity = {}) {
  return entity.type === 'text' ? [...TEXT_CLASS_PROPERTY_GROUPS] : [];
}

export function resolveClassEntityProperties(entity = {}, stateInput = null) {
  const state = classState(stateInput);
  const classId = classIdForEntity(entity, state);
  const definition = state.classes.find(({ id }) => id === classId) || state.classes[0];
  const overrides = new Set(normalizedOverrideGroups(entity.classPropertyOverrides));
  const result = {};
  entityPropertyGroups(entity).forEach((group) => {
    CLASS_ENTITY_PROPERTY_GROUPS[group].forEach((property) => {
      if (overrides.has(group) && entity[property] !== undefined) result[property] = clone(entity[property]);
      else if (definition.properties[property] !== undefined) result[property] = clone(definition.properties[property]);
    });
  });
  if (entity.type === 'text' && !overrides.has('fontSize')) {
    result.textHeight = Number(result.fontSize) * 25.4 / 96;
  }
  return result;
}

export function resolveClassEntity(entity = {}, stateInput = null) {
  return {
    ...clone(entity || {}),
    ...resolveClassEntityProperties(entity, stateInput),
    appearance: resolveClassAppearance(entity, stateInput),
  };
}

export function withClassAppearanceOverrides(entity = {}, appearance = {}, patch = {}) {
  const result = clone(entity || {});
  const overrides = new Set(normalizedOverrideGroups(result.classPropertyOverrides));
  classOverrideGroupsForPatch(patch).forEach((group) => overrides.add(group));
  result.appearance = clone(appearance || {});
  result.classPropertyOverrides = [...overrides];
  return result;
}

export function withClassEntityPropertyOverrides(entity = {}, patch = {}) {
  const result = clone(entity || {});
  const overrides = new Set(normalizedOverrideGroups(result.classPropertyOverrides));
  Object.keys(patch || {}).forEach((property) => {
    const group = GROUP_BY_PROPERTY.get(property);
    if (group && CLASS_ENTITY_PROPERTY_GROUPS[group]) overrides.add(group);
  });
  Object.assign(result, clone(patch || {}));
  result.classPropertyOverrides = [...overrides];
  return result;
}

export function materializeDrawingClassAppearances(drawingInput = {}) {
  const drawing = clone(drawingInput || {});
  const state = normalizeClassState(drawing);
  drawing.classes = clone(state.classes);
  drawing.activeClassId = state.activeClassId;
  drawing.entities = (drawing.entities || []).map((entity) => {
    if (!isClassGeometryEntity(entity)) return entity;
    // Drawings created before Classes have no class metadata. Their existing
    // appearance is direct entity intent, so migrate it before resolving the
    // effective class appearance used by exports and thumbnails.
    const normalized = normalizeEntityClass(entity, state, { legacy: !entity.classId });
    return resolveClassEntity(normalized, state);
  });
  return drawing;
}

export function createClassSystem({
  records = [],
  selectedIds = new Set(),
  persistRecord = (_record, entity) => entity,
  onChange = () => {},
} = {}) {
  let state = normalizeClassState();
  const listeners = new Set();

  function definition(classId) {
    return state.classes.find(({ id }) => id === classId) || null;
  }

  function eligibleRecord(record) {
    return Boolean(record && ['geometry', 'fillet', 'text'].includes(record.recordType));
  }

  function getState() {
    return clone(state);
  }

  function emit(reason, { history = 'coalesce', recordIds = [] } = {}) {
    syncPresentation();
    const snapshot = getState();
    listeners.forEach((listener) => listener(snapshot, { reason, recordIds: [...recordIds] }));
    onChange({ reason, history, recordIds: [...recordIds] });
  }

  function restore(value, { notify = false, propagate = true } = {}) {
    state = normalizeClassState(value);
    syncPresentation();
    if (notify) {
      const recordIds = records.filter(eligibleRecord).map(({ id }) => id);
      const snapshot = getState();
      listeners.forEach((listener) => listener(snapshot, { reason: 'restore', recordIds }));
      if (propagate) onChange({ reason: 'restore', history: 'none', recordIds });
    }
    return getState();
  }

  function clear() {
    state = normalizeClassState();
    return getState();
  }

  function activeClassId() {
    return state.activeClassId;
  }

  function assignEntity(entity = {}, requestedClassId = state.activeClassId, options = {}) {
    const result = clone(entity || {});
    const targetId = definition(requestedClassId) ? requestedClassId : DEFAULT_CLASS_ID;
    result.classId = targetId;
    const fresh = options.fresh ?? (!normalizedName(entity?.classId) && !options.legacy);
    result.classPropertyOverrides = result.classPropertyOverrides === undefined
      ? fresh ? [] : classOverrideGroupsForEntity(result)
      : normalizedOverrideGroups(result.classPropertyOverrides);
    if (options.legacy && !normalizedName(entity?.classId)) result.classId = DEFAULT_CLASS_ID;
    return { ...result, ...resolveClassEntityProperties(result, state) };
  }

  function resolveAppearance(entity = {}) {
    return resolveClassAppearance(entity, state);
  }

  function resolveEntityProperties(entity = {}) {
    return resolveClassEntityProperties(entity, state);
  }

  function resolveEntity(entity = {}) {
    return resolveClassEntity(entity, state);
  }

  function applyAppearanceOverrides(entity = {}, appearance = {}, patch = {}) {
    return withClassAppearanceOverrides(assignEntity(entity, entity.classId), appearance, patch);
  }

  function applyEntityPropertyOverrides(entity = {}, patch = {}) {
    return withClassEntityPropertyOverrides(assignEntity(entity, entity.classId), patch);
  }

  function availableName(baseName = 'Class') {
    const base = normalizedName(baseName) || 'Class';
    const used = new Set(state.classes.map(({ name }) => nameKey(name)));
    if (!used.has(nameKey(base))) return base;
    let index = 2;
    while (used.has(nameKey(`${base} ${index}`))) index += 1;
    return `${base} ${index}`;
  }

  function validateName(name, { exceptId = null } = {}) {
    const next = normalizedName(name);
    if (!next) return { success: false, error: 'Class name is required.' };
    const duplicate = state.classes.find((item) => item.id !== exceptId && nameKey(item.name) === nameKey(next));
    if (duplicate) return { success: false, error: `A class named “${next}” already exists.` };
    return { success: true, name: next, error: null };
  }

  function addClass(name = '') {
    const requested = normalizedName(name);
    let nextName = requested;
    if (!nextName) {
      let index = 1;
      const used = new Set(state.classes.map((item) => nameKey(item.name)));
      while (used.has(nameKey(`Class ${index}`))) index += 1;
      nextName = `Class ${index}`;
    }
    const validation = validateName(nextName);
    if (!validation.success) return validation;
    const item = {
      id: createStableId('class'),
      name: validation.name,
      removable: true,
      duplicable: true,
      properties: createDefaultClassProperties(),
    };
    state.classes.push(item);
    state.activeClassId = item.id;
    emit('add', { history: 'commit' });
    return { success: true, class: clone(item), error: null };
  }

  function duplicateClass(classId, name = '') {
    const source = definition(classId);
    if (!source) return { success: false, error: 'Class was not found.' };
    if (!source.duplicable) return { success: false, error: 'Class X cannot be duplicated.' };
    const requested = normalizedName(name) || availableName(`${source.name} Copy`);
    const validation = validateName(requested);
    if (!validation.success) return validation;
    const item = {
      id: createStableId('class'),
      name: validation.name,
      removable: true,
      duplicable: true,
      properties: clone(source.properties),
    };
    state.classes.push(item);
    state.activeClassId = item.id;
    emit('duplicate', { history: 'commit' });
    return { success: true, class: clone(item), error: null };
  }

  function renameClass(classId, name) {
    const target = definition(classId);
    if (!target) return { success: false, error: 'Class was not found.' };
    if (target.id === DEFAULT_CLASS_ID) return { success: false, error: 'Class X cannot be renamed.' };
    const validation = validateName(name, { exceptId: classId });
    if (!validation.success) return validation;
    if (target.name === validation.name) return { success: true, class: clone(target), error: null };
    target.name = validation.name;
    emit('rename', { history: 'commit' });
    return { success: true, class: clone(target), error: null };
  }

  function updateClassProperties(classId, patch = {}) {
    const target = definition(classId);
    if (!target) return { success: false, error: 'Class was not found.' };
    target.properties = normalizeClassProperties({ ...target.properties, ...clone(patch || {}) });
    const recordIds = recordIdsForClass(classId);
    records.filter((record) => recordIds.includes(record.id)).forEach((record) => {
      const next = resolveEntity(assignEntity(record.entity, classId));
      record.entity = clone(persistRecord(record, next) || next);
    });
    emit('properties', { history: 'commit', recordIds });
    return { success: true, class: clone(target), error: null };
  }

  function setRecordClassIds(recordIds = [], classId, { history = 'commit', notify = true } = {}) {
    if (!definition(classId)) return { success: false, error: 'Class was not found.', recordIds: [] };
    const requested = new Set((recordIds || []).map(String));
    const targets = records.filter((record) => requested.has(String(record.id)) && eligibleRecord(record));
    const changed = targets.filter((record) => classIdForEntity(record.entity, state) !== classId);
    changed.forEach((record) => {
      const next = resolveEntity(assignEntity({ ...record.entity, classId }, classId));
      record.entity = clone(persistRecord(record, next) || next);
    });
    const changedIds = changed.map(({ id }) => id);
    if (notify && changedIds.length) emit('assign', { history, recordIds: changedIds });
    return { success: true, error: null, recordIds: changedIds };
  }

  function setActiveClass(classId) {
    if (!definition(classId)) return { success: false, error: 'Class was not found.', recordIds: [] };
    const activeChanged = state.activeClassId !== classId;
    state.activeClassId = classId;
    if (activeChanged) emit('activate', { history: 'none' });
    return { success: true, error: null, recordIds: [] };
  }

  function recordIdsForClass(classId) {
    return records
      .filter((record) => eligibleRecord(record) && classIdForEntity(record.entity, state) === classId)
      .map(({ id }) => id);
  }

  function syncPresentation() {
    records.filter(eligibleRecord).forEach((record) => {
      record.group?.setAttribute?.('data-class-id', classIdForEntity(record.entity, state));
    });
  }

  function removeClass(classId) {
    const target = definition(classId);
    if (!target) return { success: false, error: 'Class was not found.' };
    if (!target.removable) return { success: false, error: 'Class X cannot be deleted.' };
    const reassigned = setRecordClassIds(recordIdsForClass(classId), DEFAULT_CLASS_ID, { notify: false });
    state.classes = state.classes.filter(({ id }) => id !== classId);
    if (state.activeClassId === classId) state.activeClassId = DEFAULT_CLASS_ID;
    emit('remove', { history: 'commit', recordIds: reassigned.recordIds });
    return { success: true, error: null, recordIds: reassigned.recordIds };
  }

  function selectionClassProperties() {
    const selected = records.filter((record) => selectedIds.has(record.id) && eligibleRecord(record));
    const ids = new Set(selected.map((record) => classIdForEntity(record.entity, state)));
    return {
      canEditClass: selected.length > 0,
      selectedClassId: ids.size === 1 ? [...ids][0] : null,
      mixedClass: ids.size > 1,
    };
  }

  function onStateChange(listener) {
    listeners.add(listener);
    listener(getState(), { reason: 'subscribe', recordIds: [] });
    return () => listeners.delete(listener);
  }

  return {
    getState,
    restore,
    clear,
    definition,
    activeClassId,
    assignEntity,
    resolveAppearance,
    resolveEntityProperties,
    resolveEntity,
    applyAppearanceOverrides,
    applyEntityPropertyOverrides,
    availableName,
    validateName,
    addClass,
    duplicateClass,
    renameClass,
    updateClassProperties,
    setRecordClassIds,
    setActiveClass,
    removeClass,
    recordIdsForClass,
    syncPresentation,
    selectionClassProperties,
    onStateChange,
  };
}
