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

export function unitDisplaySymbol(unit = null) {
  if (unit === 'in') return '"';
  if (unit === 'ft') return "'";
  if (unit === 'deg') return '°';
  return unit || '';
}

function formatDrivenDimensionNumber(value, unit = null, precision = 3) {
  const converted = valueInUnit(value, unit);
  if (unit === 'in') {
    const twoDecimalValue = Number(converted.toFixed(2));
    return String(Number((Math.round(twoDecimalValue * 4) / 4).toFixed(2)));
  }
  if (unit === 'mm') return String(Number(converted.toFixed(0)));
  return formatUnitlessValue(value, unit, precision);
}

export function formatDrivenDimensionValue(value, unit = null, precision = 3) {
  const numeric = formatDrivenDimensionNumber(value, unit, precision);
  const symbol = unitDisplaySymbol(unit);
  if (!symbol) return numeric;
  return unit === 'in' || unit === 'ft' || unit === 'deg' ? `${numeric}${symbol}` : `${numeric} ${symbol}`;
}

export function formatUnitValue(value, unit = null, precision = 3) {
  const numeric = formatUnitlessValue(value, unit, precision);
  return unit ? `${numeric} ${unit}` : numeric;
}
