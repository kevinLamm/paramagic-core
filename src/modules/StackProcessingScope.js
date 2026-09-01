const normalizedStackId = (value) => String(value || '').trim();

export function processingRelationshipStackIds(value, fallbackStackId = null) {
  return [...new Set([
    normalizedStackId(value?.stackId || fallbackStackId),
    ...(value?.participantStackIds || []).map(normalizedStackId),
  ].filter(Boolean))];
}

export function createStackProcessingScope({
  isStackEnabled = () => true,
  defaultStackId = () => null,
  resolveRelationshipStackIds = null,
} = {}) {
  const fallbackStackId = () => normalizedStackId(
    typeof defaultStackId === 'function' ? defaultStackId() : defaultStackId,
  );
  const stackIdFor = (value) => normalizedStackId(value?.stackId || fallbackStackId());
  const stackEnabled = (stackId) => {
    const id = normalizedStackId(stackId || fallbackStackId());
    return Boolean(id && isStackEnabled(id));
  };
  const entityEnabled = (entity) => stackEnabled(stackIdFor(entity));
  const relationshipStackIds = (relationship) => {
    const declaredStackIds = processingRelationshipStackIds(relationship, fallbackStackId());
    const resolvedStackIds = typeof resolveRelationshipStackIds === 'function'
      ? resolveRelationshipStackIds(relationship)
      : [];
    return [...new Set([
      ...declaredStackIds,
      ...(resolvedStackIds || []).map(normalizedStackId),
    ].filter(Boolean))];
  };
  const relationshipEnabled = (relationship) => {
    const stackIds = relationshipStackIds(relationship);
    return stackIds.length > 0 && stackIds.every(stackEnabled);
  };
  const recordEnabled = (record) => Boolean(
    record?.entity
    && entityEnabled(record.entity)
    && relationshipEnabled(record.entity),
  );
  return {
    stackEnabled,
    entityEnabled,
    recordEnabled,
    relationshipEnabled,
    relationshipStackIds,
    records(records = []) {
      return records.filter(recordEnabled);
    },
    entities(entities = []) {
      return entities.filter(entityEnabled);
    },
    relationships(relationships = []) {
      return relationships.filter(relationshipEnabled);
    },
  };
}
