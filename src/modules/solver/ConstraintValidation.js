function referenceEntityId(reference) {
  return reference?.recordId || reference?.entityId || null;
}

/**
 * Coincident relates two distinct geometric points. Two points from the same
 * entity are not a placement relation: for example, coinciding a line's
 * endpoints would make the line degenerate, and coinciding table corners
 * would turn a location constraint into an accidental resize.
 */
export function isSelfCoincidentConstraint(constraint) {
  if (constraint?.type !== 'Coincident') return false;
  const refs = constraint.featureRefs || [];
  if (refs.length !== 2 || refs.some((reference) => reference?.kind !== 'point')) return false;
  const firstEntityId = referenceEntityId(refs[0]);
  const secondEntityId = referenceEntityId(refs[1]);
  return Boolean(firstEntityId && firstEntityId === secondEntityId);
}

export function selfCoincidentConstraintMessage() {
  return 'Coincident requires points from two different entities.';
}
