export function derivedPaintAnchor(node) {
  const beforeRecordId = String(node?.dataset?.paintBeforeRecordId || '').trim();
  if (beforeRecordId) return { recordId: beforeRecordId, placement: 'before' };
  const afterRecordId = String(node?.dataset?.paintAfterRecordId || '').trim();
  if (afterRecordId) return { recordId: afterRecordId, placement: 'after' };
  return null;
}

export function organizeDerivedPaintNodes(nodes = []) {
  const beforeByRecordId = new Map();
  const afterByRecordId = new Map();
  const unanchored = [];
  const anchorRecordIds = new Set();
  [...nodes].forEach((node) => {
    const anchor = derivedPaintAnchor(node);
    if (!anchor) {
      unanchored.push(node);
      return;
    }
    anchorRecordIds.add(anchor.recordId);
    const target = anchor.placement === 'before' ? beforeByRecordId : afterByRecordId;
    if (!target.has(anchor.recordId)) target.set(anchor.recordId, []);
    target.get(anchor.recordId).push(node);
  });
  return { beforeByRecordId, afterByRecordId, unanchored, anchorRecordIds };
}

export function splitDerivedPresentationNodes(nodes = []) {
  const before = [];
  const after = [];
  [...nodes].forEach((node) => {
    if (derivedPaintAnchor(node)?.placement === 'before') before.push(node);
    else after.push(node);
  });
  return { before, after };
}
