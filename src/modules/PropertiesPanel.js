export function syncPropertiesPanelAvailability(root, availability = {}) {
  const rows = [...(root?.querySelectorAll?.('[data-property-availability]') || [])];
  rows.forEach((row) => {
    const key = row.dataset?.propertyAvailability || '';
    const available = availability[key] === true;
    row.hidden = !available;
    row.querySelectorAll?.('button, input, select, textarea').forEach((control) => {
      control.disabled = !available;
    });
  });
  return rows.filter((row) => !row.hidden);
}
