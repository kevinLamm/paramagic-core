function expandHex(value) {
  const source = String(value).trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(source)) return `#${[...source].map((digit) => digit.repeat(2)).join('').toLowerCase()}`;
  if (/^[0-9a-f]{6}$/i.test(source)) return `#${source.toLowerCase()}`;
  return null;
}

export function resolveColorExpression(expression, evaluateNumeric) {
  const source = String(expression ?? '').trim();
  const direct = expandHex(source);
  if (direct) return direct;
  if (!source) throw new Error('Fill color requires a hex value or expression.');
  const evaluated = evaluateNumeric(source);
  const evaluatedColor = expandHex(evaluated);
  if (evaluatedColor) return evaluatedColor;
  const numeric = Number(evaluated);
  if (!Number.isFinite(numeric)) throw new Error('Fill color expression must evaluate to a finite number.');
  return `#${Math.min(0xffffff, Math.max(0, Math.round(numeric))).toString(16).padStart(6, '0')}`;
}

export function resolveOpacityExpression(expression, evaluateNumeric) {
  const source = String(expression ?? '').trim();
  if (!source) throw new Error('Opacity requires an expression from 0 to 100.');
  const numeric = Number(evaluateNumeric(source));
  if (!Number.isFinite(numeric)) throw new Error('Opacity expression must evaluate to a finite number.');
  return Math.min(1, Math.max(0, numeric / 100));
}
