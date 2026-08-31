export const unitFactors = Object.freeze({ mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8, deg: 1 });

export function valueInUnit(value, unit = null) {
  const numeric = Number(value);
  if (!unit || unit === 'deg') return numeric;
  return numeric / (unitFactors[unit] || 1);
}

export function formatUnitlessValue(value, unit = null, precision = 3) {
  if (typeof value === 'string') return value;
  const converted = valueInUnit(value, unit);
  const factor = 10 ** precision;
  const rounded = Math.round((converted + Number.EPSILON) * factor) / factor;
  return String(rounded);
}

export function formatParameterFieldValue(entry, drawingUnit = null, precision = 3) {
  const unit = entry?.kind === 'control' || entry?.usesDrawingUnit === false
    ? null
    : drawingUnit;
  return formatUnitlessValue(entry?.value, unit, precision);
}

export function unitDisplaySymbol(unit = null) {
  if (unit === 'in') return '"';
  if (unit === 'ft') return "'";
  if (unit === 'deg') return '°';
  return unit || '';
}

function formatDxfDimensionNumber(value, unit = null, precision = 3) {
  const converted = valueInUnit(value, unit);
  if (unit === 'in') {
    const rounded = Math.round((converted + Number.EPSILON) * 32) / 32;
    return String(Number(rounded.toFixed(5)));
  }
  if (unit === 'mm') return String(Number(converted.toFixed(0)));
  return formatUnitlessValue(value, unit, precision);
}

export function formatDxfDimensionValue(value, unit = null, precision = 3) {
  const numeric = formatDxfDimensionNumber(value, unit, precision);
  const symbol = unitDisplaySymbol(unit);
  if (!symbol) return numeric;
  return unit === 'in' || unit === 'ft' || unit === 'deg' ? `${numeric}${symbol}` : `${numeric} ${symbol}`;
}

function formatValueOnlyDimensionNumber(value, unit = null, precision = 3) {
  const converted = valueInUnit(value, unit);
  if (unit === 'in') {
    const rounded = Math.round((converted + Number.EPSILON) * 8) / 8;
    return String(Number(rounded.toFixed(3)));
  }
  if (unit === 'mm') return String(Number(converted.toFixed(0)));
  return formatUnitlessValue(value, unit, precision);
}

export function formatValueOnlyDimensionValue(value, unit = null, precision = 3) {
  const numeric = formatValueOnlyDimensionNumber(value, unit, precision);
  const symbol = unitDisplaySymbol(unit);
  if (!symbol) return numeric;
  return unit === 'in' || unit === 'ft' || unit === 'deg' ? `${numeric}${symbol}` : `${numeric} ${symbol}`;
}

export function formatUnitValue(value, unit = null, precision = 3) {
  const numeric = formatUnitlessValue(value, unit, precision);
  return unit ? `${numeric} ${unit}` : numeric;
}
