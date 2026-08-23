import {
  angleDimensionLayout,
  dimensionExcludedFromExport,
  dimensionMode,
  distanceDimensionLayout,
  mclDimensionLayout,
  radiusDimensionLayout,
} from './DimensionSystem.js';

export const DXF_DIMENSION_LAYER = 'Dimensions';
export const DXF_DIMENSION_STYLE = 'PARAMAGIC';

const finitePoint = (point) => Array.isArray(point)
  && point.length >= 2
  && point.slice(0, 2).every((value) => Number.isFinite(Number(value)));

const distance = (first, second) => Math.hypot(
  Number(second[0]) - Number(first[0]),
  Number(second[1]) - Number(first[1]),
);

function arrowTriangle(path) {
  const values = String(path || '').match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)
    ?.map(Number) || [];
  if (values.length < 6) return null;
  const points = [
    [values[0], values[1]],
    [values[2], values[3]],
    [values[4], values[5]],
  ];
  return points.every(finitePoint) ? points : null;
}

function normalizeAngle(angle) {
  const tau = Math.PI * 2;
  return ((angle % tau) + tau) % tau;
}

function arcMiddlePoint(center, start, end, sweep) {
  const startAngle = Math.atan2(start[1] - center[1], start[0] - center[0]);
  const endAngle = Math.atan2(end[1] - center[1], end[0] - center[0]);
  const span = sweep
    ? normalizeAngle(endAngle - startAngle)
    : -normalizeAngle(startAngle - endAngle);
  const middle = startAngle + span / 2;
  const radius = distance(center, start);
  return [
    center[0] + Math.cos(middle) * radius,
    center[1] + Math.sin(middle) * radius,
  ];
}

function valueOnlyText(entity, resolveValueText) {
  const resolved = resolveValueText?.(entity) ?? entity.text ?? '';
  const perimeter = /^\s*PERIM\s+/i.test(String(resolved));
  const value = String(resolved)
    .replace(/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*/, '')
    .replace(/^MCL\s*=\s*/i, '')
    .replace(/^PERIM\s+/i, '')
    .trim();
  const match = value.match(/^([-+]?(?:\d+\.?\d*|\.\d+))(.*)$/);
  const formatted = match ? `${Number(match[1]).toFixed(3)}${match[2]}` : value;
  return perimeter ? `PERIM ${formatted}` : formatted;
}

function numericTextOnly(value) {
  const normalized = String(value).replace(/^\s*PERIM\s+/i, '');
  return normalized.match(/^[-+]?(?:\d+\.?\d*|\.\d+)/)?.[0] || normalized;
}

function picture(lines, arrowPaths, text, textPoint, {
  arc = null,
  textAngle = 0,
  textAlign = 'center',
} = {}) {
  return {
    lines: lines.filter((line) => finitePoint(line.start) && finitePoint(line.end)),
    arrows: arrowPaths.map(arrowTriangle).filter(Boolean),
    arc,
    text,
    textPoint,
    textAngle,
    textAlign,
  };
}

function distancePlan(entity, index, text) {
  const layout = distanceDimensionLayout(entity, 1);
  const measureStart = entity.measureStart || entity.start;
  const measureEnd = entity.measureEnd || entity.end;
  if (![measureStart, measureEnd, layout.dimensionStart, layout.textPoint].every(finitePoint)) return null;
  const rotated = ['horizontal', 'vertical'].includes(entity.subtype);
  return {
    kind: 'dimension',
    nativeType: rotated ? 'rotated' : 'aligned',
    typeCode: rotated ? 0 : 1,
    blockName: `*D${index + 1}`,
    definitionPoint: layout.dimensionStart,
    textPoint: layout.textPoint,
    extensionA: measureStart,
    extensionB: measureEnd,
    rotation: entity.subtype === 'vertical' ? 90 : 0,
    picture: picture(
      [
        layout.extensionA,
        layout.extensionB,
        { start: layout.dimensionStart, end: layout.dimensionEnd },
      ],
      [layout.arrowA, layout.arrowB],
      text,
      layout.textPoint,
      { textAngle: layout.angle },
    ),
  };
}

function radiusPlan(entity, index, text) {
  const layout = radiusDimensionLayout(entity, 1);
  const diameter = entity.subtype === 'diameter';
  if (![layout.center, layout.target, layout.elbow, layout.landingEnd, layout.label].every(finitePoint)) return null;
  if (diameter && !finitePoint(layout.oppositeTarget)) return null;
  return {
    kind: 'dimension',
    nativeType: diameter ? 'diameter' : 'radius',
    typeCode: diameter ? 3 : 4,
    blockName: `*D${index + 1}`,
    definitionPoint: diameter ? layout.oppositeTarget : layout.center,
    textPoint: layout.label,
    radialPoint: layout.target,
    leaderLength: distance(layout.target, layout.elbow),
    picture: picture(
      diameter ? [
        { start: layout.oppositeTarget, end: layout.target },
        { start: layout.target, end: layout.elbow },
        { start: layout.elbow, end: layout.landingEnd },
      ] : [
        { start: layout.target, end: layout.elbow },
        { start: layout.elbow, end: layout.landingEnd },
      ],
      diameter ? [layout.arrowA, layout.arrowB] : [layout.arrow],
      text,
      layout.label,
      { textAlign: layout.textAnchor === 'end' ? 'right' : 'left' },
    ),
  };
}

function anglePlan(entity, index, text) {
  const layout = angleDimensionLayout(entity, 1);
  if (![layout.vertex, layout.arcStart, layout.arcEnd, layout.textPoint].every(finitePoint)) return null;
  const sweep = /\sA\s+[^\s]+\s+[^\s]+\s+0\s+[01]\s+1\s/.test(layout.arcPath);
  const arcPoint = arcMiddlePoint(layout.vertex, layout.arcStart, layout.arcEnd, sweep);
  return {
    kind: 'dimension',
    nativeType: 'angular-three-point',
    typeCode: 5,
    blockName: `*D${index + 1}`,
    definitionPoint: arcPoint,
    textPoint: layout.textPoint,
    extensionA: finitePoint(entity.start) ? entity.start : layout.arcStart,
    extensionB: finitePoint(entity.end) ? entity.end : layout.arcEnd,
    vertex: layout.vertex,
    picture: picture(
      [layout.extensionA, layout.extensionB],
      [layout.arrowA, layout.arrowB],
      text,
      layout.textPoint,
      {
        arc: {
          type: 'arc',
          center: layout.vertex,
          start: layout.arcStart,
          arcPoint,
          end: layout.arcEnd,
        },
      },
    ),
  };
}

function leaderPlan(entity, text) {
  const layout = mclDimensionLayout(entity, 1);
  if (![layout.target, layout.elbow, layout.landingEnd, layout.label].every(finitePoint)) return null;
  return {
    kind: 'leader',
    picture: picture(
      [
        { start: layout.target, end: layout.elbow },
        { start: layout.elbow, end: layout.landingEnd },
      ],
      [layout.arrow],
      `PERIM ${numericTextOnly(text)}`,
      layout.label,
      { textAlign: layout.textAnchor === 'end' ? 'right' : 'left' },
    ),
  };
}

export function createDxfDimensionPlans(drawing = {}, {
  resolveValueText = null,
} = {}) {
  const annotations = drawing.dimensionAnnotations || drawing.annotations || [];
  let nativeIndex = 0;
  return annotations
    .filter((entity) => (
      dimensionMode(entity) === 'driven'
      && !dimensionExcludedFromExport(entity)
    ))
    .map((entity) => {
      const text = valueOnlyText(entity, resolveValueText);
      let plan = null;
      if (entity.type === 'dimension-line') plan = distancePlan(entity, nativeIndex, text);
      if (entity.type === 'radius-dimension') plan = radiusPlan(entity, nativeIndex, text);
      if (entity.type === 'angle-dimension') plan = anglePlan(entity, nativeIndex, text);
      if (entity.type === 'multi-curve-length-dimension') plan = leaderPlan(entity, text);
      if (entity.type === 'dimension-text' && finitePoint(entity.label)) {
        plan = {
          kind: 'text',
          picture: picture([], [], text, entity.label),
        };
      }
      if (plan?.kind === 'dimension') nativeIndex += 1;
      return plan;
    })
    .filter(Boolean);
}
