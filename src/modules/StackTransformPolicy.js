import { GLOBAL_LAYER_ID } from './StackCoordinates.js';
import { isCanvasOriginReference } from './CanvasOrigin.js';

export function constraintAvailableInStackContext(type, activeStackId) {
  return Boolean(activeStackId) || !['Length', 'Equal'].includes(type);
}

export function referencedTransformStackIds(value, getRecordStackId) {
  const ids = new Set(), visited = new Set();
  const visit = item => {
    if (!item || typeof item !== 'object' || visited.has(item)) return;
    visited.add(item);
    const recordId = item.recordId || item.entityId;
    const stackId = isCanvasOriginReference(item) ? item.stackId || GLOBAL_LAYER_ID
      : recordId ? getRecordStackId?.(recordId) : null;
    if (stackId) ids.add(stackId);
    Object.values(item).forEach(visit);
  };
  visit(value);
  return [...ids];
}

export function stackTransformConstraintError(constraint, getRecordStackId) {
  if (['Length', 'Equal', 'Radius', 'Diameter', 'Meta'].includes(constraint.type)) {
    return `${constraint.type} requires an active Stack because it changes local geometry.`;
  }
  const ids = referencedTransformStackIds(constraint, getRecordStackId);
  if (['Horizontal', 'Vertical', 'Fixed'].includes(constraint.type) && ids.some(id => id !== GLOBAL_LAYER_ID)) return null;
  return ids.length > 1 ? null : 'This relation requires different Stacks or the drawing origin. Activate a Stack to constrain its internal geometry.';
}

export function stackTransformDimensionAllowed(dimension, getRecordStackId) {
  return ['dimension-line', 'angle-dimension'].includes(dimension?.type)
    && !dimension.externalDrivingTarget
    && referencedTransformStackIds(dimension.anchors, getRecordStackId).length > 1;
}
