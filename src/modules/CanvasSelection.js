export function resolveWindowSelectionIds(currentIds = [], matchedIds = [], additive = false) {
  const current = new Set(currentIds);
  const matched = [...new Set(matchedIds)];
  if (!additive) return matched;
  const remove = matched.length > 0 && matched.every((id) => current.has(id));
  matched.forEach((id) => {
    if (remove) current.delete(id);
    else current.add(id);
  });
  return [...current];
}
