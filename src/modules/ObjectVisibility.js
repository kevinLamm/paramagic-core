export const OBJECT_VISIBILITY_HIDDEN_CLASS = 'object-visibility-hidden';

export const OBJECT_VISIBILITY_ICON = `
  <path d="M2.5 12c2.5-4 6-6 9.5-6s7 2 9.5 6c-2.5 4-6 6-9.5 6s-7-2-9.5-6z"/>
  <circle cx="12" cy="12" r="2.5"/>
  <path d="M4 4l16 16"/>
`;

const unique = (values = []) => [...new Set([...values].filter(Boolean).map(String))];

export function normalizeVisibleExpression(expression, fallback = 'TRUE') {
  const value = String(expression ?? '').trim();
  return value || fallback;
}

export function hasObjectVisibilityState(entity) {
  return Object.prototype.hasOwnProperty.call(entity?.appearance || {}, 'visible')
    || Object.prototype.hasOwnProperty.call(entity?.appearance || {}, 'visibleExpression');
}

export function visibleExpressionFor(entity) {
  const appearance = entity?.appearance || {};
  return normalizeVisibleExpression(
    appearance.visibleExpression,
    appearance.visible === false ? 'FALSE' : 'TRUE',
  );
}

export function evaluateVisibleExpression(expression, evaluate) {
  const normalized = normalizeVisibleExpression(expression);
  if (typeof evaluate !== 'function') {
    return { value: true, expression: normalized, error: 'Boolean evaluator is unavailable.' };
  }
  try {
    const value = evaluate(normalized);
    if (typeof value !== 'boolean') {
      return { value: true, expression: normalized, error: 'Visible expression must evaluate to TRUE or FALSE.' };
    }
    return { value, expression: normalized, error: null };
  } catch (error) {
    return {
      value: true,
      expression: normalized,
      error: error.message || 'Visible expression is invalid.',
    };
  }
}

export function objectVisibilityState(entity, evaluate) {
  if (!hasObjectVisibilityState(entity)) {
    return { value: true, expression: 'TRUE', error: null };
  }
  return evaluateVisibleExpression(visibleExpressionFor(entity), evaluate);
}

export function objectVisibilityPropertiesMarkup() {
  return `
    <label class="property-row object-visibility-property-row" for="visibleProperty" hidden><span>Visible</span><input id="visibleProperty" type="checkbox" disabled /></label>
    <label class="property-row object-visibility-property-row" for="visibleExpressionProperty" hidden><span>Visible Expression</span><input id="visibleExpressionProperty" type="text" value="TRUE" spellcheck="false" disabled /></label>
  `;
}

export function bindObjectVisibilityProperties({ root, canvas } = {}) {
  const rows = [...(root?.querySelectorAll?.('.object-visibility-property-row') || [])];
  const checkbox = root?.querySelector?.('#visibleProperty');
  const expression = root?.querySelector?.('#visibleExpressionProperty');
  if (!checkbox || !expression) return { update() {} };

  checkbox.addEventListener('change', () => {
    checkbox.indeterminate = false;
    const nextExpression = checkbox.checked ? 'TRUE' : 'FALSE';
    expression.value = nextExpression;
    canvas?.setSelectedVisibility?.({
      visible: checkbox.checked,
      visibleExpression: nextExpression,
    });
  });
  expression.addEventListener('change', () => {
    canvas?.setSelectedVisibility?.({ visibleExpression: expression.value });
  });
  expression.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') expression.blur();
  });

  return {
    update(properties = {}) {
      const enabled = properties.canEditVisible === true;
      rows.forEach((row) => { row.hidden = !enabled; });
      checkbox.disabled = !enabled;
      expression.disabled = !enabled;
      checkbox.checked = properties.visible === true;
      checkbox.indeterminate = properties.mixedVisible === true;
      if (globalThis.document?.activeElement !== expression) {
        expression.value = properties.visibleExpression ?? '';
      }
      expression.placeholder = properties.mixedVisible ? 'Mixed' : 'TRUE, FALSE, or expression';
      expression.setAttribute('aria-invalid', String(Boolean(properties.errors?.visible)));
      expression.title = properties.errors?.visible || 'Boolean expression or parameter name';
    },
  };
}

export function bindObjectVisibilityOverride({ button, canvas } = {}) {
  if (!button) return { update() {} };
  const update = (showHidden = canvas?.getShowHiddenObjects?.() === true) => {
    const label = showHidden ? 'Hide Hidden Objects' : 'Show Hidden Objects';
    button.classList.toggle('active', showHidden);
    button.setAttribute('aria-pressed', String(showHidden));
    button.setAttribute('aria-label', label);
    button.title = label;
  };
  button.addEventListener('click', () => {
    update(canvas?.setShowHiddenObjects?.(!(canvas?.getShowHiddenObjects?.() === true)) === true);
  });
  update();
  return { update };
}

function visibilityEntityForOwner(owner, records) {
  const ownerRecords = (owner?.recordIds || [])
    .map((id) => records.find((record) => record.id === id))
    .filter(Boolean);
  return ownerRecords.find((record) => hasObjectVisibilityState(record.entity))?.entity
    || ownerRecords[0]?.entity
    || owner?.entity
    || {};
}

export function createObjectVisibilitySystem({
  records = [],
  selectedIds = new Set(),
  canvasElement = null,
  owners = () => [],
  ownerForRecord = () => null,
  evaluateExpression = null,
  resolveEntityAppearance = (entity) => entity?.appearance || {},
  applyEntityAppearanceOverrides = (entity, appearance) => ({ ...entity, appearance }),
  updateEntity = null,
  updateEntityAppearances = () => [],
  applyChangedEntity = () => {},
  requestHistoryCheckpoint = () => {},
  notifyObjectChange = () => {},
  notifySelectionChange = () => {},
} = {}) {
  let showHiddenObjects = false;
  let visibleByRecordId = new Map();

  function stateForOwner(owner) {
    const entity = visibilityEntityForOwner(owner, records);
    return objectVisibilityState(
      { ...entity, appearance: resolveEntityAppearance(entity) },
      evaluateExpression,
    );
  }

  function targetsForRecordIds(recordIds = []) {
    const result = new Map();
    unique(recordIds).forEach((recordId) => {
      const owner = ownerForRecord(recordId);
      if (owner?.id) result.set(owner.id, owner);
    });
    return [...result.values()];
  }

  function propertiesForRecordIds(recordIds = []) {
    const requestedIds = new Set(unique(recordIds));
    const targets = targetsForRecordIds(requestedIds);
    const targetIds = new Set(targets.flatMap((owner) => owner.recordIds || []));
    const states = targets.map(stateForOwner);
    const values = new Set(states.map(({ value }) => value));
    const expressions = new Set(states.map(({ expression }) => expression));
    const errors = states.map(({ error }) => error).filter(Boolean);
    return {
      canEditVisible: targets.length > 0
        && targetIds.size === requestedIds.size
        && [...requestedIds].every((id) => targetIds.has(id)),
      visible: values.size === 1 ? [...values][0] : null,
      mixedVisible: values.size > 1,
      visibleExpression: expressions.size === 1 ? [...expressions][0] : null,
      errors: { visible: errors[0] || null },
    };
  }

  function setRecordVisibility(recordIds, patch = {}, {
    history = true,
    notify = true,
  } = {}) {
    const requestedIds = new Set(unique(recordIds));
    const targets = targetsForRecordIds(requestedIds);
    const targetIds = new Set(targets.flatMap((owner) => owner.recordIds || []));
    if (!targets.length || targetIds.size !== requestedIds.size
      || [...requestedIds].some((id) => !targetIds.has(id))) {
      return { success: false, error: 'Select one or more complete closed objects.' };
    }
    const expression = patch.visibleExpression !== undefined
      ? normalizeVisibleExpression(patch.visibleExpression)
      : (patch.visible === false ? 'FALSE' : 'TRUE');
    const evaluated = evaluateVisibleExpression(expression, evaluateExpression);
    if (evaluated.error) {
      targetIds.forEach((id) => {
        const record = records.find((candidate) => candidate.id === id);
        if (record) record.visibilityError = evaluated.error;
      });
      notifySelectionChange();
      return { success: false, error: evaluated.error };
    }
    if (history) requestHistoryCheckpoint('object-visibility-update');
    const updates = [...targetIds].map((id) => {
      const record = records.find((candidate) => candidate.id === id);
      const entity = record?.entity;
      const appearance = {
        ...resolveEntityAppearance(entity),
        visible: evaluated.value,
        visibleExpression: evaluated.expression,
      };
      return {
        id,
        appearance,
        entity: applyEntityAppearanceOverrides(entity, appearance, patch),
      };
    });
    const changed = typeof updateEntity === 'function'
      ? updates.map(({ entity }) => updateEntity(entity))
      : updateEntityAppearances(updates);
    changed.forEach((entity) => applyChangedEntity(entity));
    targetIds.forEach((id) => {
      const record = records.find((candidate) => candidate.id === id);
      if (record) record.visibilityError = null;
    });
    if (notify) notifyObjectChange({ history: history ? 'commit' : 'coalesce' });
    return { success: true, error: null };
  }

  function selectedProperties() {
    return propertiesForRecordIds(selectedIds);
  }

  function setSelectedVisibility(patch = {}) {
    return setRecordVisibility(selectedIds, patch);
  }

  function syncPresentation(regionNodes = []) {
    const next = new Map(records.map((record) => [record.id, true]));
    owners().forEach((owner) => {
      const state = stateForOwner(owner);
      (owner.recordIds || []).forEach((recordId) => {
        next.set(recordId, state.value);
        const record = records.find((candidate) => candidate.id === recordId);
        if (record) record.visibilityError = state.error;
      });
    });
    records.forEach((record) => {
      const entity = record.entity;
      if (entity?.composite?.kind === 'finish-size-offset') {
        const sourceIds = unique((entity.composite.sourceFeatures || []).map(({ recordId }) => recordId));
        if (sourceIds.length) next.set(record.id, sourceIds.every((id) => next.get(id) !== false));
      } else if (entity?.type === 'notch' && entity.host?.recordId) {
        next.set(record.id, next.get(entity.host.recordId) !== false);
      }
    });
    visibleByRecordId = next;
    records.forEach((record) => {
      const visible = next.get(record.id) !== false;
      record.group?.classList?.toggle(OBJECT_VISIBILITY_HIDDEN_CLASS, !visible);
      record.group?.setAttribute?.('data-object-visible', String(visible));
    });
    [...regionNodes].forEach((region) => {
      const parentIds = String(region.dataset?.parentIds || '').split(',').filter(Boolean);
      const visible = parentIds.length > 0 && parentIds.every((id) => next.get(id) !== false);
      region.classList?.toggle(OBJECT_VISIBILITY_HIDDEN_CLASS, !visible);
      region.setAttribute?.('data-object-visible', String(visible));
    });
    canvasElement?.classList?.toggle('show-hidden-objects', showHiddenObjects);
    return next;
  }

  function isRecordVisible(recordOrId) {
    const id = typeof recordOrId === 'string' ? recordOrId : recordOrId?.id;
    return visibleByRecordId.get(id) !== false;
  }

  function isRecordShown(recordOrId) {
    return showHiddenObjects || isRecordVisible(recordOrId);
  }

  function setShowHiddenObjects(value) {
    showHiddenObjects = Boolean(value);
    syncPresentation();
    return showHiddenObjects;
  }

  return {
    propertiesForRecordIds,
    selectedProperties,
    setRecordVisibility,
    setSelectedVisibility,
    syncPresentation,
    isRecordVisible,
    isRecordShown,
    getShowHiddenObjects: () => showHiddenObjects,
    setShowHiddenObjects,
  };
}

export function thumbnailVisibilitySourceIds(entity) {
  const compositeSources = entity?.composite?.sourceFeatures
    ?.map(({ recordId }) => recordId) || [];
  return unique([
    ...(entity?._resolvedSourceIds || entity?._thumbnailSourceIds || []),
    entity?._resolvedSourceId || entity?._thumbnailSourceId,
    ...compositeSources,
    ...(entity?.composite?.sourceRecordIds || []),
    entity?.composite?.ownerRecordId,
    entity?.host?.recordId,
    entity?.id,
  ]);
}

export function filterVisibleResolvedEntities(drawing = {}, entities = [], evaluateExpression) {
  const visibleById = new Map((drawing.entities || [])
    .filter(({ id }) => id)
    .map((entity) => [entity.id, objectVisibilityState(entity, evaluateExpression).value]));
  return entities.filter((entity) => {
    const sourceIds = thumbnailVisibilitySourceIds(entity).filter((id) => visibleById.has(id));
    return !sourceIds.length || sourceIds.every((id) => visibleById.get(id) !== false);
  });
}

export const filterVisibleThumbnailEntities = filterVisibleResolvedEntities;
