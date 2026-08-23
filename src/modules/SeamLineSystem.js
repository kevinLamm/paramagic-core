import { projectPointToNotchFeature, sampleNotchFeature } from './NotchSystem.js';
import { resolveClosedBoundaries } from './BoundaryTopology.js';
import {
  isSubtractCutterEntity,
  subtractCutterAppliesTo,
  subtractDrawingResults,
  subtractMaterialTarget,
} from './SubtractSystem.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const clone = (value) => JSON.parse(JSON.stringify(value));
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const closeEnough = (a, b) => distance(a, b) < 0.01;
const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const quantize = (value) => Math.round(Number(value) * 1e6) / 1e6;
const subtract = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const scale = (point, value) => [point[0] * value, point[1] * value];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

export const SEAM_LINE_EXTENSION_VERSION = 2;
export const SEAM_LINE_INSET = 12.7;
export const isSeamLineEntity = (entity) => entity?.composite?.kind === 'finish-size-offset';

function unit(point) {
  const length = Math.hypot(point[0], point[1]);
  return length > 1e-9 ? scale(point, 1 / length) : [0, 0];
}

function lineIntersection(a, directionA, b, directionB) {
  const denominator = directionA[0] * directionB[1] - directionA[1] * directionB[0];
  if (Math.abs(denominator) < 1e-8) return midpoint(a, b);
  const delta = subtract(b, a);
  const ratio = (delta[0] * directionB[1] - delta[1] * directionB[0]) / denominator;
  return add(a, scale(directionA, ratio));
}

function lineCircleIntersections(linePoint, lineDirection, center, radius) {
  const directionLengthSquared = dot(lineDirection, lineDirection);
  if (directionLengthSquared < 1e-12 || !Number.isFinite(radius) || radius <= 0) return [];
  const relative = subtract(linePoint, center);
  const linear = 2 * dot(relative, lineDirection);
  const constant = dot(relative, relative) - radius * radius;
  const discriminant = linear * linear - 4 * directionLengthSquared * constant;
  if (discriminant < -1e-8) return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  const first = (-linear - root) / (2 * directionLengthSquared);
  const second = (-linear + root) / (2 * directionLengthSquared);
  const points = [add(linePoint, scale(lineDirection, first))];
  if (Math.abs(second - first) > 1e-9) points.push(add(linePoint, scale(lineDirection, second)));
  return points;
}

function circleCircleIntersections(firstCenter, firstRadius, secondCenter, secondRadius) {
  const centerDelta = subtract(secondCenter, firstCenter);
  const centerDistance = Math.hypot(centerDelta[0], centerDelta[1]);
  if (
    centerDistance < 1e-9
    || centerDistance > firstRadius + secondRadius + 1e-8
    || centerDistance < Math.abs(firstRadius - secondRadius) - 1e-8
  ) return [];
  const along = (
    firstRadius * firstRadius - secondRadius * secondRadius + centerDistance * centerDistance
  ) / (2 * centerDistance);
  const heightSquared = firstRadius * firstRadius - along * along;
  if (heightSquared < -1e-8) return [];
  const direction = scale(centerDelta, 1 / centerDistance);
  const base = add(firstCenter, scale(direction, along));
  const height = Math.sqrt(Math.max(0, heightSquared));
  const normal = [-direction[1], direction[0]];
  const points = [add(base, scale(normal, height))];
  if (height > 1e-9) points.push(add(base, scale(normal, -height)));
  return points;
}

function lineSegmentIntersection(linePoint, lineDirection, start, end) {
  const segmentDirection = subtract(end, start);
  const denominator = lineDirection[0] * segmentDirection[1] - lineDirection[1] * segmentDirection[0];
  if (Math.abs(denominator) < 1e-8) return null;
  const delta = subtract(start, linePoint);
  const lineRatio = (delta[0] * segmentDirection[1] - delta[1] * segmentDirection[0]) / denominator;
  const segmentRatio = (delta[0] * lineDirection[1] - delta[1] * lineDirection[0]) / denominator;
  if (segmentRatio < -1e-8 || segmentRatio > 1 + 1e-8) return null;
  return add(linePoint, scale(lineDirection, lineRatio));
}

function pointOnSegment(point, start, end) {
  const segment = subtract(end, start);
  const relative = subtract(point, start);
  const cross = segment[0] * relative[1] - segment[1] * relative[0];
  const tolerance = 1e-7 * Math.max(1, Math.hypot(segment[0], segment[1]));
  if (Math.abs(cross) > tolerance) return false;
  const projection = relative[0] * segment[0] + relative[1] * segment[1];
  const lengthSquared = segment[0] ** 2 + segment[1] ** 2;
  return projection >= -tolerance && projection <= lengthSquared + tolerance;
}

function pointInsideBoundary(point, features) {
  let inside = false;
  for (const feature of features) {
    const sampled = sampleNotchFeature(feature);
    for (let index = 1; index < sampled.length; index += 1) {
      const start = sampled[index - 1];
      const end = sampled[index];
      if (pointOnSegment(point, start, end)) return true;
      const crosses = (start[1] > point[1]) !== (end[1] > point[1])
        && point[0] < (end[0] - start[0]) * (point[1] - start[1])
          / ((end[1] - start[1]) || 1e-12) + start[0];
      if (crosses) inside = !inside;
    }
  }
  return inside;
}

export function seamLineFeatureKey(feature) {
  return feature.stableKey || `${feature.recordId}:${feature.sourceId || feature.recordId}:${feature.kind}:${feature.index ?? 0}`;
}

export function seamLineEdgeReference(feature = {}) {
  const parameterStart = Number(feature.parameterStart);
  const parameterEnd = Number(feature.parameterEnd);
  const sourceParameter = Number.isFinite(Number(feature.sourceParameter))
    ? Number(feature.sourceParameter)
    : Number.isFinite(parameterStart) && Number.isFinite(parameterEnd)
      ? (parameterStart + parameterEnd) / 2
      : null;
  return {
    sourceId: String(feature.sourceId || feature.recordId || ''),
    sourceFeatureIndex: Number(feature.sourceFeatureIndex ?? feature.index ?? 0) || 0,
    boundaryRole: String(feature.boundaryRole || 'outer'),
    kind: String(feature.kind || 'segment'),
    ...(sourceParameter !== null ? { sourceParameter: quantize(sourceParameter) } : {}),
  };
}

export function seamLineEdgeKey(feature = {}) {
  const reference = seamLineEdgeReference(feature);
  return [
    reference.sourceId,
    reference.sourceFeatureIndex,
    reference.boundaryRole,
    ...(reference.sourceParameter !== undefined ? [reference.sourceParameter] : []),
  ].join('|');
}

function sameSeamLineSourceEdge(first = {}, second = {}) {
  const a = seamLineEdgeReference(first);
  const b = seamLineEdgeReference(second);
  return a.sourceId === b.sourceId
    && a.sourceFeatureIndex === b.sourceFeatureIndex
    && a.boundaryRole === b.boundaryRole;
}

function seamLineOverrideForFeature(overrides = [], feature = {}) {
  const exactKey = seamLineEdgeKey(feature);
  const exact = overrides.find((item) => seamLineEdgeKey(item) === exactKey);
  if (exact) return exact;
  const sourceMatches = overrides.filter((item) => sameSeamLineSourceEdge(item, feature));
  const broad = sourceMatches.find((item) => item.sourceParameter === undefined);
  if (broad) return broad;
  const start = Math.min(Number(feature.parameterStart), Number(feature.parameterEnd));
  const end = Math.max(Number(feature.parameterStart), Number(feature.parameterEnd));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return sourceMatches.find((item) => (
    Number.isFinite(Number(item.sourceParameter))
    && Number(item.sourceParameter) >= start - 1e-7
    && Number(item.sourceParameter) <= end + 1e-7
  )) || null;
}

function normalizeSeamLineOverride(value = {}) {
  const reference = seamLineEdgeReference(value);
  if (!reference.sourceId) return null;
  return { ...reference, enabled: value.enabled !== false };
}

export function normalizeSeamLineDefinition(value = {}) {
  const regionId = String(value.regionId || value.id || '').trim();
  const recordIds = [...new Set((value.recordIds || []).map(String).filter(Boolean))];
  if (!regionId && !recordIds.length) return null;
  const overrides = new Map();
  (value.overrides || []).forEach((item) => {
    const normalized = normalizeSeamLineOverride(item);
    if (normalized) overrides.set(seamLineEdgeKey(normalized), normalized);
  });
  return {
    regionId: regionId || recordIds[0],
    recordIds,
    defaultEnabled: value.defaultEnabled === true,
    overrides: [...overrides.values()],
  };
}

export function normalizeSeamLineExtension(value = null) {
  const definitions = new Map();
  (value?.definitions || []).forEach((item) => {
    const normalized = normalizeSeamLineDefinition(item);
    if (!normalized) return;
    definitions.set(normalized.regionId, normalized);
  });
  return {
    version: SEAM_LINE_EXTENSION_VERSION,
    definitions: [...definitions.values()],
  };
}

export function seamLineDefinitionsDependOn(definitions = [], changedRecordIds = null) {
  if (!changedRecordIds) return true;
  return definitions.some((definition) => (
    (definition.recordIds || []).some((recordId) => changedRecordIds.has(recordId))
    || (definition.overrides || []).some((reference) => (
      [reference.recordId, reference.sourceId, reference.targetId]
        .some((recordId) => recordId && changedRecordIds.has(recordId))
    ))
  ));
}

export function seamLineEnabledForFeature(definition, feature) {
  if (!definition) return false;
  const normalized = normalizeSeamLineDefinition(definition);
  if (!normalized) return false;
  const override = seamLineOverrideForFeature(normalized.overrides, feature);
  return override ? override.enabled : normalized.defaultEnabled;
}

function mergeLegacySeamDefinition(definitions, regionId, recordIds, references, defaultEnabled = false) {
  if (!regionId) return;
  const current = normalizeSeamLineDefinition(definitions.get(regionId) || {
    regionId,
    recordIds,
    defaultEnabled,
    overrides: [],
  });
  current.recordIds = [...new Set([...current.recordIds, ...recordIds].filter(Boolean))];
  if (defaultEnabled) {
    current.defaultEnabled = true;
    current.overrides = [];
  } else if (!current.defaultEnabled) {
    const overrides = new Map(current.overrides.map((item) => [seamLineEdgeKey(item), item]));
    references.forEach((reference) => {
      const normalized = normalizeSeamLineOverride({ ...reference, enabled: true });
      if (normalized) overrides.set(seamLineEdgeKey(normalized), normalized);
    });
    current.overrides = [...overrides.values()];
  }
  definitions.set(regionId, current);
}

export function migrateLegacySeamLineDrawing(drawing = {}) {
  const extension = normalizeSeamLineExtension(drawing.extensions?.seamLines);
  const definitions = new Map(extension.definitions.map((item) => [item.regionId, item]));
  const legacyEnabledIds = new Set();
  (drawing.entities || []).forEach((entity) => {
    if (entity?.appearance?.displayFinishSize !== true) return;
    [entity.id, entity.composite?.id].filter(Boolean).forEach((id) => legacyEnabledIds.add(String(id)));
  });
  const entities = [];
  let migratedCount = 0;
  (drawing.entities || []).forEach((entity) => {
    if (entity?.composite?.kind === 'finish-size-offset') {
      const sources = entity.composite?.sourceFeatures || [];
      const groups = new Map();
      sources.forEach((source) => {
        const regionId = String(source.targetId || source.recordId || '').trim();
        if (!regionId) return;
        const group = groups.get(regionId) || [];
        group.push(source);
        groups.set(regionId, group);
      });
      groups.forEach((references, regionId) => {
        const explicitlyEnabled = references.some((source) => [
          source.targetId,
          source.recordId,
          source.sourceId,
        ].filter(Boolean).some((id) => legacyEnabledIds.has(String(id))));
        if (!explicitlyEnabled) return;
        mergeLegacySeamDefinition(
          definitions,
          regionId,
          [...new Set(references.map((source) => source.recordId).filter(Boolean))],
          references,
        );
      });
      migratedCount += 1;
      return;
    }
    const next = clone(entity);
    if (next?.appearance?.displayFinishSize === true) {
      const regionId = String(next.composite?.id || next.id || '').trim();
      mergeLegacySeamDefinition(definitions, regionId, [next.id], [], true);
      delete next.appearance.displayFinishSize;
      migratedCount += 1;
    }
    entities.push(next);
  });
  const seamLines = normalizeSeamLineExtension({ definitions: [...definitions.values()] });
  const extensions = clone(drawing.extensions || {});
  if (seamLines.definitions.length) extensions.seamLines = seamLines;
  else delete extensions.seamLines;
  return {
    drawing: {
      ...clone(drawing),
      entities,
      ...(Object.keys(extensions).length ? { extensions } : { extensions: {} }),
    },
    extension: seamLines,
    migratedCount,
  };
}

export function seamLineSourceReference(feature) {
  const sampled = sampleNotchFeature(feature);
  const middle = (sampled.length - 1) / 2;
  const firstMiddle = sampled[Math.floor(middle)];
  const secondMiddle = sampled[Math.ceil(middle)];
  const referencePoint = feature.kind === 'circle'
    ? [feature.center[0] + feature.radius, feature.center[1]]
    : firstMiddle && secondMiddle
      ? midpoint(firstMiddle, secondMiddle)
      : null;
  return {
    recordId: feature.recordId,
    kind: feature.kind,
    index: feature.index ?? 0,
    ...(feature.sourceId ? { sourceId: feature.sourceId } : {}),
    ...(feature.targetId ? { targetId: feature.targetId } : {}),
    ...(feature.sourceFeatureIndex !== undefined ? { sourceFeatureIndex: feature.sourceFeatureIndex } : {}),
    ...(feature.boundaryRole ? { boundaryRole: feature.boundaryRole } : {}),
    ...(feature.stableKey ? { stableKey: feature.stableKey } : {}),
    ...(Number.isFinite(Number(feature.parameterStart))
      && Number.isFinite(Number(feature.parameterEnd))
      ? { sourceParameter: (Number(feature.parameterStart) + Number(feature.parameterEnd)) / 2 }
      : {}),
    ...(referencePoint ? { referencePoint: [...referencePoint] } : {}),
  };
}

export function refreshSeamLineSourceReferences(hosts, resolvedFeatures) {
  if (hosts.length !== resolvedFeatures.length) return clone(hosts);
  return hosts.map((host, index) => {
    const resolved = seamLineSourceReference(resolvedFeatures[index]);
    return {
      ...clone(host),
      ...(resolved.sourceParameter !== undefined ? { sourceParameter: resolved.sourceParameter } : {}),
      ...(resolved.referencePoint ? { referencePoint: resolved.referencePoint } : {}),
    };
  });
}

function reverseArcFeature(feature) {
  return {
    ...feature,
    start: [...feature.end],
    end: [...feature.start],
    arcPoint: [...feature.arcPoint],
    parameterStart: feature.parameterEnd,
    parameterEnd: feature.parameterStart,
  };
}

function connectedFeatureRuns(features) {
  const remaining = [...features];
  const runs = [];
  while (remaining.length) {
    const run = [remaining.shift()];
    let changed = true;
    while (changed) {
      changed = false;
      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        const first = run[0];
        const last = run[run.length - 1];
        if (closeEnough(last.end, candidate.start)) run.push(candidate);
        else if (closeEnough(last.end, candidate.end)) run.push(reverseArcFeature(candidate));
        else if (closeEnough(first.start, candidate.end)) run.unshift(candidate);
        else if (closeEnough(first.start, candidate.start)) run.unshift(reverseArcFeature(candidate));
        else continue;
        remaining.splice(index, 1);
        changed = true;
        break;
      }
    }
    runs.push(run);
  }
  return runs;
}

function mergeConnectedArcFeatures(features) {
  const groups = new Map();
  const nonArcs = [];
  features.forEach((feature) => {
    if (feature.kind !== 'arc') {
      nonArcs.push(feature);
      return;
    }
    const key = [
      feature.sourceId || feature.recordId,
      feature.sourceFeatureIndex ?? feature.index ?? 0,
      feature.center?.map((value) => quantize(value)).join(','),
      quantize(feature.radius),
    ].join(':');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(feature);
  });
  const merged = [];
  groups.forEach((group) => connectedFeatureRuns(group).forEach((run) => {
    if (run.length === 1) {
      merged.push(run[0]);
      return;
    }
    const points = run.flatMap((feature, index) => {
      const sampled = sampleNotchFeature(feature);
      return index ? sampled.slice(1) : sampled;
    });
    const midpointPoint = points[Math.floor((points.length - 1) / 2)] || run[0].arcPoint;
    merged.push({
      ...run[0],
      start: [...run[0].start],
      end: [...run.at(-1).end],
      arcPoint: [...midpointPoint],
      sourceFeatures: run.flatMap((feature) => feature.sourceFeatures || [feature]),
      stableKey: `${run[0].stableKey || seamLineFeatureKey(run[0])}:merged:${run.at(-1).stableKey || seamLineFeatureKey(run.at(-1))}`,
    });
  }));
  return [...nonArcs, ...merged];
}

function reverseCurveBoundarySegment(feature) {
  return {
    ...feature,
    start: [...feature.end],
    end: [...feature.start],
    parameterStart: feature.parameterEnd,
    parameterEnd: feature.parameterStart,
  };
}

function connectedCurveBoundaryRuns(features) {
  const remaining = [...features];
  const runs = [];
  while (remaining.length) {
    const run = [remaining.shift()];
    let changed = true;
    while (changed) {
      changed = false;
      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        const first = run[0];
        const last = run.at(-1);
        if (closeEnough(last.end, candidate.start)) run.push(candidate);
        else if (closeEnough(last.end, candidate.end)) run.push(reverseCurveBoundarySegment(candidate));
        else if (closeEnough(first.start, candidate.end)) run.unshift(candidate);
        else if (closeEnough(first.start, candidate.start)) run.unshift(reverseCurveBoundarySegment(candidate));
        else continue;
        remaining.splice(index, 1);
        changed = true;
        break;
      }
    }
    runs.push(run);
  }
  return runs;
}

function mergeBooleanCurveSegments(features) {
  const groups = new Map();
  const ordinary = [];
  features.forEach((feature) => {
    if (feature.kind !== 'segment' || feature.sourceBoundaryKind !== 'curve') {
      ordinary.push(feature);
      return;
    }
    const key = [
      feature.targetId || feature.recordId,
      feature.sourceId || feature.recordId,
      feature.sourceFeatureIndex ?? feature.index ?? 0,
      feature.boundaryRole || 'outer',
    ].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(feature);
  });
  const merged = [];
  groups.forEach((group) => connectedCurveBoundaryRuns(group).forEach((run) => {
    const points = [[...run[0].start], ...run.map((feature) => [...feature.end])];
    merged.push({
      ...run[0],
      kind: 'polyline',
      points,
      sourceFeatures: run.map((feature) => clone(feature)),
      parameterStart: run[0].parameterStart,
      parameterEnd: run.at(-1).parameterEnd,
      stableKey: `${run[0].stableKey || seamLineFeatureKey(run[0])}:curve-run:${run.at(-1).stableKey || seamLineFeatureKey(run.at(-1))}`,
    });
  }));
  return [...ordinary, ...merged];
}

function curveFrame(points, segmentIndex, t) {
  const current = points[segmentIndex];
  const next = points[segmentIndex + 1];
  const previous = points[Math.max(0, segmentIndex - 1)];
  const after = points[Math.min(points.length - 1, segmentIndex + 2)];
  const firstControl = add(current, scale(subtract(next, previous), 0.18));
  const secondControl = add(next, scale(subtract(current, after), 0.18));
  const inverse = 1 - t;
  const point = add(
    add(scale(current, inverse ** 3), scale(firstControl, 3 * inverse * inverse * t)),
    add(scale(secondControl, 3 * inverse * t * t), scale(next, t ** 3)),
  );
  const tangent = add(
    add(scale(subtract(firstControl, current), 3 * inverse * inverse), scale(subtract(secondControl, firstControl), 6 * inverse * t)),
    scale(subtract(next, secondControl), 3 * t * t),
  );
  return { point, tangent: unit(tangent) };
}

function sampleCurveFrames(feature, samplesPerSegment = 48) {
  if (feature.kind !== 'curve' || !Array.isArray(feature.points) || feature.points.length < 2) return null;
  const frames = [];
  for (let index = 0; index < feature.points.length - 1; index += 1) {
    for (let sample = index ? 1 : 0; sample <= samplesPerSegment; sample += 1) {
      frames.push(curveFrame(feature.points, index, sample / samplesPerSegment));
    }
  }
  return frames;
}

function offsetFeature(feature, inwardTarget, inset) {
  const curveFrames = sampleCurveFrames(feature);
  const sampled = curveFrames?.map(({ point }) => point) || sampleNotchFeature(feature);
  if (sampled.length < 2) return null;
  if (feature.kind === 'arc' && feature.center && Number.isFinite(feature.radius)) {
    const sourceMidpoint = feature.arcPoint || sampled[Math.floor((sampled.length - 1) / 2)];
    const midpointIndex = Math.floor((sampled.length - 1) / 2);
    const midpointTangent = unit(subtract(
      sampled[Math.min(sampled.length - 1, midpointIndex + 1)],
      sampled[Math.max(0, midpointIndex - 1)],
    ));
    const target = inwardTarget(feature, sourceMidpoint, midpointTangent);
    const radial = subtract(sourceMidpoint, feature.center);
    const targetDirection = subtract(target || feature.center, sourceMidpoint);
    const towardCenter = dot(radial, targetDirection) < 0;
    const offsetRadius = feature.radius + (towardCenter ? -inset : inset);
    if (offsetRadius <= 0) return null;
    const points = sampled.map((point) => {
      const radialPoint = subtract(point, feature.center);
      const length = Math.hypot(radialPoint[0], radialPoint[1]) || 1;
      return add(feature.center, scale(radialPoint, offsetRadius / length));
    });
    return {
      feature: clone(feature),
      sourceFeatures: clone(feature.sourceFeatures || [feature]),
      sourceStart: [...sampled[0]],
      sourceEnd: [...sampled[sampled.length - 1]],
      points,
      offsetRadius,
      startTangent: unit(subtract(points[1], points[0])),
      endTangent: unit(subtract(points.at(-1), points.at(-2))),
    };
  }
  const middle = (sampled.length - 1) / 2;
  const lowerMiddle = Math.floor(middle);
  const upperMiddle = Math.ceil(middle);
  const referencePoint = midpoint(sampled[lowerMiddle], sampled[upperMiddle]);
  const referencePrevious = sampled[Math.max(0, lowerMiddle - 1)];
  const referenceNext = sampled[Math.min(sampled.length - 1, upperMiddle + 1)];
  const referenceTangent = curveFrames?.[Math.floor(middle)]?.tangent
    || unit(subtract(referenceNext, referencePrevious));
  const referenceTarget = inwardTarget(feature, referencePoint, referenceTangent);
  const referenceLeftNormal = [-referenceTangent[1], referenceTangent[0]];
  const referenceTargetDirection = subtract(referenceTarget || referencePoint, referencePoint);
  const inwardSide = dot(referenceLeftNormal, referenceTargetDirection) >= 0 ? 1 : -1;
  const points = sampled.map((point, index) => {
    const previous = sampled[Math.max(0, index - 1)];
    const next = sampled[Math.min(sampled.length - 1, index + 1)];
    const tangent = curveFrames?.[index]?.tangent || unit(subtract(next, previous));
    const leftNormal = [-tangent[1], tangent[0]];
    const inward = scale(leftNormal, inwardSide);
    return add(point, scale(inward, inset));
  });
  return {
    feature: clone(feature),
    sourceFeatures: clone(feature.sourceFeatures || [feature]),
    sourceStart: [...sampled[0]],
    sourceEnd: [...sampled[sampled.length - 1]],
    points,
    startTangent: curveFrames?.[0]?.tangent || unit(subtract(points[1], points[0])),
    endTangent: curveFrames?.at(-1)?.tangent || unit(subtract(points.at(-1), points.at(-2))),
  };
}

function reverseOffset(item) {
  return {
    ...item,
    sourceStart: item.sourceEnd,
    sourceEnd: item.sourceStart,
    points: [...item.points].reverse(),
    startTangent: scale(item.endTangent, -1),
    endTangent: scale(item.startTangent, -1),
  };
}

function offsetArcEntity(item, sourceFeatures = item.sourceFeatures || item.feature.sourceFeatures || [item.feature]) {
  const feature = item.feature;
  const center = [...feature.center];
  const radius = item.offsetRadius ?? distance(item.points[0], center);
  if (!Number.isFinite(radius) || radius <= 0) return null;
  const sourceMidpoint = feature.arcPoint || midpoint(feature.start, feature.end);
  const midpointVector = subtract(sourceMidpoint, center);
  const midpointLength = Math.hypot(midpointVector[0], midpointVector[1]) || 1;
  const arcPoint = add(center, scale(midpointVector, radius / midpointLength));
  return {
    type: 'arc',
    center,
    radius,
    start: [...item.points[0]],
    arcPoint,
    end: [...item.points[item.points.length - 1]],
    appearance: { fillOpacity: 0, fillOpacityExpression: '0' },
    composite: {
      kind: 'finish-size-offset',
      sourceFeatures: sourceFeatures.map(seamLineSourceReference),
    },
  };
}

function offsetArcRunEntity(run, points) {
  if (!run.length || !run.every(({ feature }) => feature.kind === 'arc')) return null;
  if (run.length === 1) {
    return offsetArcEntity(run[0], run[0].sourceFeatures || run[0].feature.sourceFeatures || [run[0].feature]);
  }
  const firstFeature = run[0].feature;
  if (!firstFeature.center || !Number.isFinite(firstFeature.radius)) return null;
  const sameCircle = run.every(({ feature }) => (
    feature.center
    && Math.hypot(feature.center[0] - firstFeature.center[0], feature.center[1] - firstFeature.center[1]) < 1e-7
    && Math.abs(Number(feature.radius) - Number(firstFeature.radius)) < 1e-7
  ));
  if (!sameCircle || points.length < 2) return null;
  const midpointPoint = points[Math.floor((points.length - 1) / 2)] || points[0];
  const midpointVector = subtract(midpointPoint, firstFeature.center);
  const midpointLength = Math.hypot(midpointVector[0], midpointVector[1]) || 1;
  const radius = run[0].offsetRadius ?? distance(run[0].points[0], firstFeature.center);
  if (!Number.isFinite(radius) || radius <= 0) return null;
  return {
    type: 'arc',
    center: [...firstFeature.center],
    radius,
    start: [...points[0]],
    arcPoint: add(firstFeature.center, scale(midpointVector, radius / midpointLength)),
    end: [...points[points.length - 1]],
    appearance: { fillOpacity: 0, fillOpacityExpression: '0' },
    composite: {
      kind: 'finish-size-offset',
      sourceFeatures: run.flatMap((item) => item.sourceFeatures || item.feature.sourceFeatures || [item.feature]).map(seamLineSourceReference),
    },
  };
}

function connectedRuns(items) {
  const remaining = [...items];
  const runs = [];
  while (remaining.length) {
    const run = [remaining.shift()];
    let changed = true;
    while (changed) {
      changed = false;
      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        const first = run[0];
        const last = run[run.length - 1];
        if (closeEnough(last.sourceEnd, candidate.sourceStart)) run.push(candidate);
        else if (closeEnough(last.sourceEnd, candidate.sourceEnd)) run.push(reverseOffset(candidate));
        else if (closeEnough(first.sourceStart, candidate.sourceEnd)) run.unshift(candidate);
        else if (closeEnough(first.sourceStart, candidate.sourceStart)) run.unshift(reverseOffset(candidate));
        else continue;
        remaining.splice(index, 1);
        changed = true;
        break;
      }
    }
    runs.push(run);
  }
  return runs;
}

function splineOffsetItem(item) {
  return item.feature.kind === 'curve'
    || item.feature.sourceBoundaryKind === 'curve'
    || item.feature.sourceFeatures?.some((feature) => (
      feature.kind === 'curve' || feature.sourceBoundaryKind === 'curve'
    ));
}

export function seamLineSplineLineTrim(points, linePoint, lineDirection, joinPoint = points?.at(-1)) {
  if (!Array.isArray(points) || points.length < 2 || !linePoint || !lineDirection || !joinPoint) return null;
  const candidates = points.slice(1).flatMap((point, index) => {
    const intersection = lineSegmentIntersection(linePoint, lineDirection, points[index], point);
    return intersection ? [{ point: intersection, segmentIndex: index }] : [];
  });
  return candidates.reduce((best, candidate) => {
    const score = distance(candidate.point, joinPoint);
    return !best || score < best.score ? { ...candidate, score } : best;
  }, null);
}

function offsetArcTrimFeature(item) {
  if (item.feature.kind !== 'arc' || !item.feature.center || !Number.isFinite(item.offsetRadius)) return null;
  const radial = subtract(item.feature.arcPoint, item.feature.center);
  const radialLength = Math.hypot(radial[0], radial[1]) || 1;
  return {
    ...item.feature,
    radius: item.offsetRadius,
    start: [...item.points[0]],
    arcPoint: add(item.feature.center, scale(radial, item.offsetRadius / radialLength)),
    end: [...item.points.at(-1)],
  };
}

function splineCircleTrim(points, center, radius, joinPoint, arcFeature = null) {
  const candidates = points.slice(1).flatMap((point, index) => (
    lineCircleIntersections(points[index], subtract(point, points[index]), center, radius)
      .filter((candidate) => pointOnSegment(candidate, points[index], point))
      .filter((candidate) => !arcFeature || pointOnTrimFeature(candidate, arcFeature))
      .map((candidate) => ({ point: candidate, segmentIndex: index }))
  ));
  return candidates.reduce((best, candidate) => {
    const score = distance(candidate.point, joinPoint);
    return !best || score < best.score ? { ...candidate, score } : best;
  }, null);
}

function trimSplineOffsetToNeighbor(spline, atEnd, neighbor, neighborAtStart) {
  const splineJoinPoint = atEnd ? spline.points.at(-1) : spline.points[0];
  const neighborJoinPoint = neighborAtStart ? neighbor.points[0] : neighbor.points.at(-1);
  const neighborArc = offsetArcTrimFeature(neighbor);
  const hit = neighborArc
    ? splineCircleTrim(
      spline.points,
      neighborArc.center,
      neighborArc.radius,
      splineJoinPoint,
      neighborArc,
    )
    : seamLineSplineLineTrim(
      spline.points,
      neighborJoinPoint,
      neighborAtStart ? neighbor.startTangent : neighbor.endTangent,
      splineJoinPoint,
    );
  if (!hit) return null;
  if (atEnd) {
    spline.points = [...spline.points.slice(0, hit.segmentIndex + 1), hit.point];
    spline.endTangent = unit(subtract(hit.point, spline.points.at(-2)));
  } else {
    spline.points = [hit.point, ...spline.points.slice(hit.segmentIndex + 1)];
    spline.startTangent = unit(subtract(spline.points[1], hit.point));
  }
  return hit.point;
}

function joinOffsetPair(first, second) {
  const firstEnd = first.points[first.points.length - 1];
  const secondStart = second.points[0];
  const firstArc = first.feature.kind === 'arc' && first.feature.center && Number.isFinite(first.offsetRadius);
  const secondArc = second.feature.kind === 'arc' && second.feature.center && Number.isFinite(second.offsetRadius);
  const firstSpline = splineOffsetItem(first);
  const secondSpline = splineOffsetItem(second);
  if (firstSpline && !secondSpline) {
    const trim = trimSplineOffsetToNeighbor(first, true, second, true);
    if (trim) {
      second.points[0] = trim;
      return;
    }
  } else if (secondSpline && !firstSpline) {
    const trim = trimSplineOffsetToNeighbor(second, false, first, false);
    if (trim) {
      first.points[first.points.length - 1] = trim;
      return;
    }
  }
  let candidates = [];
  if (firstArc && secondArc) {
    candidates = circleCircleIntersections(
      first.feature.center,
      first.offsetRadius,
      second.feature.center,
      second.offsetRadius,
    );
  } else if (firstArc) {
    candidates = lineCircleIntersections(
      secondStart,
      second.startTangent,
      first.feature.center,
      first.offsetRadius,
    );
  } else if (secondArc) {
    candidates = lineCircleIntersections(
      firstEnd,
      first.endTangent,
      second.feature.center,
      second.offsetRadius,
    );
  }
  const finiteCandidates = candidates.filter((point) => point.every(Number.isFinite));
  const join = finiteCandidates.length
    ? finiteCandidates.reduce((best, point) => (
      !best || distance(point, firstEnd) + distance(point, secondStart) < best.score
        ? { point, score: distance(point, firstEnd) + distance(point, secondStart) }
        : best
    ), null).point
    : lineIntersection(firstEnd, first.endTangent, secondStart, second.startTangent);
  first.points[first.points.length - 1] = join;
  second.points[0] = join;
}

function pointOnTrimFeature(point, feature) {
  if (feature.kind === 'segment') return pointOnSegment(point, feature.start, feature.end);
  if (feature.kind === 'arc' || feature.kind === 'circle') {
    const projection = projectPointToNotchFeature(point, feature);
    const tolerance = 1e-6 * Math.max(1, Number(feature.radius) || 1);
    return Boolean(projection && projection.distance <= tolerance);
  }
  return true;
}

function trimIntersections(item, offsetPoint, offsetDirection, feature) {
  const itemIsArc = item.feature.kind === 'arc'
    && item.feature.center
    && Number.isFinite(item.offsetRadius);
  const featureIsRound = (feature.kind === 'arc' || feature.kind === 'circle')
    && feature.center
    && Number.isFinite(feature.radius);
  let candidates = [];
  if (itemIsArc && featureIsRound) {
    candidates = circleCircleIntersections(
      item.feature.center,
      item.offsetRadius,
      feature.center,
      feature.radius,
    );
  } else if (itemIsArc && feature.kind === 'segment') {
    candidates = lineCircleIntersections(
      feature.start,
      subtract(feature.end, feature.start),
      item.feature.center,
      item.offsetRadius,
    );
  } else if (featureIsRound) {
    candidates = lineCircleIntersections(
      offsetPoint,
      offsetDirection,
      feature.center,
      feature.radius,
    );
  } else if (feature.kind === 'segment') {
    const intersection = lineSegmentIntersection(
      offsetPoint,
      offsetDirection,
      feature.start,
      feature.end,
    );
    candidates = intersection ? [intersection] : [];
  } else {
    const sampled = sampleCurveFrames(feature)?.map(({ point }) => point) || sampleNotchFeature(feature);
    candidates = sampled.slice(1).flatMap((point, index) => {
      if (itemIsArc) {
        return lineCircleIntersections(
          sampled[index],
          subtract(point, sampled[index]),
          item.feature.center,
          item.offsetRadius,
        ).filter((candidate) => pointOnSegment(candidate, sampled[index], point));
      }
      const intersection = lineSegmentIntersection(
        offsetPoint,
        offsetDirection,
        sampled[index],
        point,
      );
      return intersection ? [intersection] : [];
    });
  }
  return candidates.filter((point) => (
    point.every(Number.isFinite) && pointOnTrimFeature(point, feature)
  ));
}

function clipOpenEnd(item, atStart, selectedKeys, boundaryFeatures) {
  const offsetIndex = atStart ? 0 : item.points.length - 1;
  const adjacentIndex = atStart ? 1 : item.points.length - 2;
  const offsetPoint = item.points[offsetIndex];
  const offsetDirection = subtract(item.points[adjacentIndex], offsetPoint);
  const boundary = boundaryFeatures(item.feature);
  if (pointInsideBoundary(offsetPoint, boundary)) return;
  const intersections = boundary
    .filter((feature) => !selectedKeys.has(seamLineFeatureKey(feature)))
    .flatMap((feature) => trimIntersections(item, offsetPoint, offsetDirection, feature))
    .sort((a, b) => distance(a, offsetPoint) - distance(b, offsetPoint));
  if (intersections.length) item.points[offsetIndex] = intersections[0];
}

export function createSeamLineEntities(
  features,
  inwardTarget,
  inset = SEAM_LINE_INSET,
  boundaryFeatures = () => [],
  completeBoundaryFeatures = features,
) {
  const uniqueFeatures = [...new Map(features.map((feature) => [seamLineFeatureKey(feature), feature])).values()];
  const selectedKeys = new Set(uniqueFeatures.map(seamLineFeatureKey));
  const completeFeatures = [...new Map(
    completeBoundaryFeatures.map((feature) => [seamLineFeatureKey(feature), feature]),
  ).values()];
  const circles = completeFeatures.filter((feature) => (
    feature.kind === 'circle' && selectedKeys.has(seamLineFeatureKey(feature))
  ))
    .map((feature) => {
      const boundaryPoint = [feature.center[0] + feature.radius, feature.center[1]];
      const target = inwardTarget(feature, boundaryPoint, [0, 1]);
      const radialDirection = [1, 0];
      const targetDirection = subtract(target || feature.center, boundaryPoint);
      const radialProjection = dot(radialDirection, targetDirection);
      const towardCenter = Math.abs(radialProjection) < 1e-8
        ? !target || target[0] <= boundaryPoint[0]
        : radialProjection < 0;
      const radius = feature.radius + (towardCenter ? -inset : inset);
      return radius > 0 ? {
        type: 'circle',
        center: [...feature.center],
        radius,
        appearance: { fillOpacity: 0, fillOpacityExpression: '0' },
        composite: {
          kind: 'finish-size-offset',
          sourceFeatures: [seamLineSourceReference(feature)],
        },
      } : null;
    })
    .filter(Boolean);
  const offsets = mergeBooleanCurveSegments(
    mergeConnectedArcFeatures(completeFeatures.filter((feature) => feature.kind !== 'circle')),
  )
    .map((feature) => offsetFeature(feature, inwardTarget, inset))
    .filter(Boolean);
  const itemIsSelected = (item) => (
    item.sourceFeatures || item.feature.sourceFeatures || [item.feature]
  ).some((feature) => selectedKeys.has(seamLineFeatureKey(feature)));
  const splitSelectedRuns = (run, closed) => {
    const selectedRuns = [];
    let current = [];
    run.forEach((item) => {
      if (itemIsSelected(item)) current.push(item);
      else if (current.length) {
        selectedRuns.push(current);
        current = [];
      }
    });
    if (current.length) selectedRuns.push(current);
    if (closed && selectedRuns.length > 1 && itemIsSelected(run[0]) && itemIsSelected(run.at(-1))) {
      selectedRuns[0] = [...selectedRuns.pop(), ...selectedRuns[0]];
    }
    return selectedRuns;
  };
  const polylineEntity = (run, points) => ({
    type: 'polyline',
    points,
    composite: {
      kind: 'finish-size-offset',
      sourceFeatures: run.flatMap((item) => (
        item.sourceFeatures || item.feature.sourceFeatures || [item.feature]
      )).map(seamLineSourceReference),
    },
  });
  const runEntities = (run, closed) => {
    const points = run.flatMap((item, index) => index ? item.points.slice(1) : item.points);
    if (closed && !closeEnough(points[0], points[points.length - 1])) points.push([...points[0]]);
    if (run.every(({ feature }) => feature.kind === 'arc')) {
      const combinedArc = offsetArcRunEntity(run, points);
      if (combinedArc) return [combinedArc];
      return run.map((item) => offsetArcEntity(item)).filter(Boolean);
    }
    if (run.some(({ feature }) => feature.kind === 'arc')) {
      return run.flatMap((item) => item.feature.kind === 'arc'
        ? [offsetArcEntity(item)].filter(Boolean)
        : [polylineEntity([item], item.points)]);
    }
    return [polylineEntity(run, points)];
  };
  const runs = connectedRuns(offsets).flatMap((run) => {
    for (let index = 0; index < run.length - 1; index += 1) joinOffsetPair(run[index], run[index + 1]);
    const closed = run.length > 1 && closeEnough(run[0].sourceStart, run[run.length - 1].sourceEnd);
    if (closed) joinOffsetPair(run[run.length - 1], run[0]);
    else {
      clipOpenEnd(run[0], true, selectedKeys, boundaryFeatures);
      clipOpenEnd(run[run.length - 1], false, selectedKeys, boundaryFeatures);
    }
    const selectedRuns = splitSelectedRuns(run, closed);
    return selectedRuns.flatMap((selectedRun) => runEntities(
      selectedRun,
      closed && selectedRuns.length === 1 && selectedRun.length === run.length,
    ));
  });
  return [...circles, ...runs];
}

function sameRecordSet(first = [], second = []) {
  const a = [...new Set(first)].sort();
  const b = [...new Set(second)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function boundaryForDefinition(definition, subtractPresentation, resolvedBoundaries) {
  const subtractResult = subtractPresentation.results.find((result) => (
    result.ownerId === definition.regionId
    || (definition.recordIds.length && sameRecordSet(result.recordIds, definition.recordIds))
  ));
  if (subtractResult) {
    const owner = subtractPresentation.owners.find((candidate) => candidate.id === subtractResult.ownerId);
    return {
      id: subtractResult.ownerId,
      recordIds: subtractResult.recordIds,
      appearanceSourceId: owner?.appearanceEntity?.id || subtractResult.recordIds[0],
      stackId: subtractResult.stackId,
      features: subtractResult.plan.features,
      polygon: subtractResult.points,
      appearance: subtractResult.appearance,
    };
  }
  const resolved = resolvedBoundaries.find((boundary) => (
    boundary.id === definition.regionId
    || (definition.recordIds.length && sameRecordSet(boundary.recordIds, definition.recordIds))
  ));
  return resolved ? {
    ...resolved,
    appearance: null,
  } : null;
}

function explicitSeamLineDefinition(definition, features = []) {
  const normalized = normalizeSeamLineDefinition(definition);
  if (!normalized) return null;
  const overrides = new Map();
  features.forEach((feature) => {
    if (!seamLineEnabledForFeature(normalized, feature)) return;
    const reference = normalizeSeamLineOverride({ ...seamLineEdgeReference(feature), enabled: true });
    if (reference) overrides.set(seamLineEdgeKey(reference), reference);
  });
  return {
    regionId: normalized.regionId,
    recordIds: [...normalized.recordIds],
    defaultEnabled: false,
    overrides: [...overrides.values()],
  };
}

export function migrateSeamLineDrawingToExplicitEdges(drawing = {}, options = {}) {
  const migrated = migrateLegacySeamLineDrawing(drawing).drawing;
  const extension = normalizeSeamLineExtension(migrated.extensions?.seamLines);
  if (!extension.definitions.length) return migrated;
  const subtractPresentation = subtractDrawingResults(migrated, options);
  const resolvedBoundaries = resolveClosedBoundaries(
    migrated.entities || [],
    migrated.constraints || [],
  );
  const definitions = extension.definitions
    .map((definition) => {
      const boundary = boundaryForDefinition(definition, subtractPresentation, resolvedBoundaries);
      return boundary?.features?.length
        ? explicitSeamLineDefinition(definition, boundary.features)
        : normalizeSeamLineDefinition(definition);
    })
    .filter((definition) => definition && (definition.defaultEnabled || definition.overrides.length));
  const extensions = clone(migrated.extensions || {});
  if (definitions.length) {
    extensions.seamLines = normalizeSeamLineExtension({ definitions });
  } else {
    delete extensions.seamLines;
  }
  return { ...migrated, extensions };
}

function ownerForBoundary(boundary, subtractPresentation) {
  return subtractPresentation.owners.find((owner) => (
    owner.id === boundary.id
    || sameRecordSet(owner.recordIds, boundary.recordIds)
  )) || null;
}

function centroid(points = []) {
  const finite = points.filter((point) => Array.isArray(point) && point.length >= 2
    && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])));
  if (!finite.length) return null;
  return finite.reduce((sum, point) => [
    sum[0] + Number(point[0]) / finite.length,
    sum[1] + Number(point[1]) / finite.length,
  ], [0, 0]);
}

function seamMaterialTarget(boundary, subtractPresentation) {
  const owner = ownerForBoundary(boundary, subtractPresentation);
  const ownerId = owner?.id || boundary.id;
  const cutters = subtractPresentation.owners
    .filter((candidate) => (
      candidate.id !== ownerId
      && isSubtractCutterEntity(candidate.entity)
      && subtractCutterAppliesTo(candidate.entity, ownerId)
    ))
    .map((candidate) => candidate.entity);
  const fallback = centroid(boundary.polygon || boundary.features.flatMap(sampleNotchFeature));
  return (_feature, point, tangent) => (
    subtractMaterialTarget(point, tangent, owner?.entity, cutters) || fallback || point
  );
}

export function materializeSeamLineEntitiesForDrawing(drawing = {}, options = {}) {
  const migrated = migrateSeamLineDrawingToExplicitEdges(drawing, options);
  const extension = normalizeSeamLineExtension(migrated.extensions?.seamLines);
  if (!extension.definitions.length) return [];
  const subtractPresentation = subtractDrawingResults(migrated, options);
  const resolvedBoundaries = resolveClosedBoundaries(
    migrated.entities || [],
    migrated.constraints || [],
  );
  return extension.definitions.flatMap((definition) => {
    const boundary = boundaryForDefinition(definition, subtractPresentation, resolvedBoundaries);
    if (!boundary?.features?.length) return [];
    const enabledFeatures = boundary.features.filter((feature) => seamLineEnabledForFeature(definition, feature));
    if (!enabledFeatures.length) return [];
    const inwardTarget = seamMaterialTarget(boundary, subtractPresentation);
    return createSeamLineEntities(
      enabledFeatures,
      inwardTarget,
      options.inset ?? SEAM_LINE_INSET,
      () => boundary.features,
      boundary.features,
    ).map((entity, index) => ({
      ...entity,
      id: `seam-line-v2:${definition.regionId}:${index}`,
      stackId: boundary.stackId || 'stack-default',
      appearance: {
        strokeThickness: 1.5,
        strokeOpacity: 1,
        ...(entity.appearance || {}),
      },
      composite: {
        ...(entity.composite || {}),
        kind: 'finish-size-offset',
        seamLineVersion: SEAM_LINE_EXTENSION_VERSION,
        regionId: definition.regionId,
        ownerRecordId: boundary.appearanceSourceId || boundary.recordIds[0],
        sourceRecordIds: [...boundary.recordIds],
      },
    }));
  });
}

function arcPath(entity) {
  if (!entity?.center || !entity?.start || !entity?.arcPoint || !entity?.end) return '';
  const start = Math.atan2(entity.start[1] - entity.center[1], entity.start[0] - entity.center[0]);
  const middle = Math.atan2(entity.arcPoint[1] - entity.center[1], entity.arcPoint[0] - entity.center[0]);
  const end = Math.atan2(entity.end[1] - entity.center[1], entity.end[0] - entity.center[0]);
  const tau = Math.PI * 2;
  const normalize = (angle) => ((angle % tau) + tau) % tau;
  const ccwSpan = normalize(end - start);
  const followsCcw = normalize(middle - start) <= ccwSpan;
  const span = followsCcw ? ccwSpan : tau - ccwSpan;
  return `M ${entity.start[0]} ${entity.start[1]} A ${entity.radius} ${entity.radius} 0 ${span > Math.PI ? 1 : 0} ${followsCcw ? 1 : 0} ${entity.end[0]} ${entity.end[1]}`;
}

function createSvg(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
  return node;
}

function presentationNode(entity) {
  let node = null;
  if (entity.type === 'line') {
    node = createSvg('line', {
      x1: entity.start[0], y1: entity.start[1], x2: entity.end[0], y2: entity.end[1],
    });
  } else if (entity.type === 'circle') {
    node = createSvg('circle', { cx: entity.center[0], cy: entity.center[1], r: entity.radius });
  } else if (entity.type === 'arc') {
    node = createSvg('path', { d: arcPath(entity) });
  } else if (['polyline', 'polygon', 'curve'].includes(entity.type)) {
    node = createSvg('polyline', {
      points: (entity.points || []).map((point) => point.join(',')).join(' '),
    });
  }
  if (!node) return null;
  node.setAttribute('class', 'seam-line-path derived-seam-line');
  node.setAttribute('fill', 'none');
  node.setAttribute('pointer-events', 'none');
  return node;
}

export function createSeamLineSystem({
  records,
  selectedIds,
  notchBoundaryResolver,
  subtractOwnerForRecord,
  subtractFeaturesForRecord,
  screenToWorld,
  requestHistoryCheckpoint,
  notifyObjectChange,
  syncGeometryStacking,
  getScale = () => 1,
  getDrawingSnapshot = () => ({ entities: [] }),
  resolvePresentationHost = () => null,
  isStackVisible = () => true,
  isStackActive = () => true,
}) {
  let propertyFeatures = [];
  let state = normalizeSeamLineExtension();
  const presentationRoots = new Set();

  function removePresentationRoots() {
    presentationRoots.forEach((root) => root.remove());
    presentationRoots.clear();
  }

  function normalizedPresentationHost(value) {
    if (value?.container?.appendChild) {
      return {
        container: value.container,
        before: value.before?.parentNode === value.container ? value.before : null,
      };
    }
    return value?.appendChild ? { container: value, before: null } : null;
  }

  function seamLineFeatureFromEvent(event) {
    const target = event.paramagicSelectionTarget || event.target;
    const feature = notchBoundaryResolver.featureFromEvent(event);
    if (!feature || !isSeamLineFeatureEligible(feature)) return null;
    const explicitSegment = Boolean(target.closest?.('.segment-select-line'));
    if (!explicitSegment) {
      const projection = projectPointToNotchFeature(screenToWorld(event.clientX, event.clientY), feature);
      if (!projection || projection.distance > 14 / getScale()) return null;
    }
    return clone(feature);
  }

  function isSeamLineFeatureEligible(feature) {
    if (!feature || !['segment', 'arc', 'circle', 'curve', 'polyline'].includes(feature.kind)) return false;
    return notchBoundaryResolver.isClosedHost(feature);
  }

  function setPropertyFeatureFromEvent(event, { additive = Boolean(event?.ctrlKey || event?.metaKey) } = {}) {
    const feature = seamLineFeatureFromEvent(event);
    if (!additive) {
      propertyFeatures = feature ? [feature] : [];
      return feature;
    }
    if (!feature) return null;
    const key = seamLineFeatureKey(feature);
    const index = propertyFeatures.findIndex((item) => seamLineFeatureKey(item) === key);
    if (index >= 0) propertyFeatures.splice(index, 1);
    else propertyFeatures.push(feature);
    return feature;
  }

  function clearPropertyFeature() {
    propertyFeatures = [];
  }

  function selectionContexts() {
    const contexts = new Map();
    propertyFeatures.forEach((propertyFeature) => {
      const feature = notchBoundaryResolver.featureForHost(propertyFeature) || propertyFeature;
      if (!feature || !isSeamLineFeatureEligible(feature)) return;
      const owner = subtractOwnerForRecord(feature.targetId || feature.recordId)
        || subtractOwnerForRecord(feature.recordId);
      const boundary = notchBoundaryResolver.boundaryForHost?.(feature);
      const regionId = String(feature.targetId || owner?.id || boundary?.id || feature.recordId);
      const recordIds = [...(owner?.recordIds || boundary?.recordIds || [feature.recordId])];
      const ownerRecordId = recordIds[0] || feature.recordId;
      const derived = subtractFeaturesForRecord(ownerRecordId);
      const boundaryFeatures = derived.length
        ? derived
        : notchBoundaryResolver.boundaryFeatures(feature);
      const allFeatures = boundaryFeatures.filter(isSeamLineFeatureEligible);
      const context = contexts.get(regionId) || {
        regionId,
        recordIds,
        features: [],
        allFeatures: allFeatures.length ? allFeatures : [feature],
      };
      const featureKey = seamLineFeatureKey(feature);
      if (!context.features.some((item) => seamLineFeatureKey(item) === featureKey)) {
        context.features.push(feature);
      }
      contexts.set(regionId, context);
    });
    return [...contexts.values()].filter((context) => context.features.length);
  }

  function definitionForContext(context) {
    if (!context) return null;
    return state.definitions.find((definition) => (
      definition.regionId === context.regionId
      || (definition.recordIds.length && sameRecordSet(definition.recordIds, context.recordIds))
    )) || null;
  }

  function setDefinition(nextDefinition, previousDefinition = null) {
    const previous = previousDefinition || state.definitions.find((definition) => definition.regionId === nextDefinition.regionId);
    const definitions = state.definitions.filter((definition) => definition !== previous);
    const normalized = normalizeSeamLineDefinition(nextDefinition);
    const enabledOverrides = normalized?.overrides.filter((item) => item.enabled !== normalized.defaultEnabled) || [];
    if (normalized && (normalized.defaultEnabled || enabledOverrides.length)) {
      definitions.push({ ...normalized, overrides: enabledOverrides });
    }
    state = normalizeSeamLineExtension({ definitions });
  }

  function setSelectedSeamLine(enabled) {
    const contexts = selectionContexts();
    if (!contexts.length) return false;
    const requested = Boolean(enabled);
    const changedContexts = contexts.filter((context) => {
      const current = definitionForContext(context);
      return context.features.some((feature) => seamLineEnabledForFeature(current, feature) !== requested);
    });
    if (!changedContexts.length) return true;
    requestHistoryCheckpoint('seam-line-update');
    changedContexts.forEach((context) => {
      const current = definitionForContext(context);
      const next = current
        ? explicitSeamLineDefinition(current, context.allFeatures)
        : normalizeSeamLineDefinition({
        regionId: context.regionId,
        recordIds: context.recordIds,
        defaultEnabled: false,
        overrides: [],
      });
      next.regionId = context.regionId;
      next.recordIds = [...context.recordIds];
      next.defaultEnabled = false;
      next.overrides = next.overrides.filter((item) => !context.features.some((feature) => (
        seamLineOverrideForFeature([item], feature)
      )));
      const overrides = new Map(next.overrides.map((item) => [seamLineEdgeKey(item), item]));
      context.features.forEach((feature) => {
        if (!requested) return;
        const reference = { ...seamLineEdgeReference(feature), enabled: true };
        overrides.set(seamLineEdgeKey(reference), reference);
      });
      next.overrides = [...overrides.values()];
      setDefinition(next, current);
    });
    refresh();
    syncGeometryStacking?.();
    notifyObjectChange({ history: 'commit' });
    return true;
  }

  function properties() {
    const contexts = selectionContexts();
    const features = contexts.flatMap((context) => context.features.map((feature) => ({ context, feature })));
    const canEditSeamLine = features.length > 0
      && features.every(({ feature }) => isSeamLineFeatureEligible(feature));
    const values = features.map(({ context, feature }) => (
      seamLineEnabledForFeature(definitionForContext(context), feature)
    ));
    return {
      canEditSeamLine,
      seamLine: canEditSeamLine ? values.every(Boolean) : null,
      mixedSeamLine: canEditSeamLine && values.some(Boolean) && values.some((value) => !value),
    };
  }

  function refresh(changedRecordIds = null) {
    if (!seamLineDefinitionsDependOn(state.definitions, changedRecordIds)) return false;
    let entities = [];
    try {
      const drawing = getDrawingSnapshot();
      entities = materializeSeamLineEntitiesForDrawing({
        ...drawing,
        extensions: {
          ...(drawing.extensions || {}),
          seamLines: state,
        },
      });
    } catch {
      entities = [];
    }
    if (!globalThis.document) return entities;
    const hosts = new Map();
    entities.forEach((entity) => {
      const node = presentationNode(entity);
      if (!node) return;
      const sourceIds = entity.composite?.sourceRecordIds
        || [...new Set((entity.composite?.sourceFeatures || []).map((source) => source.recordId).filter(Boolean))];
      const ownerRecordId = entity.composite?.ownerRecordId || sourceIds[0];
      const host = normalizedPresentationHost(resolvePresentationHost(ownerRecordId, entity));
      if (!host) return;
      let entry = hosts.get(host.container);
      if (!entry) {
        const root = createSvg('g', {
          class: 'seam-line-presentation-layer',
          'aria-hidden': 'true',
          'data-owner-record-id': ownerRecordId || '',
        });
        root.style.pointerEvents = 'none';
        entry = { ...host, root, groups: [] };
        hosts.set(host.container, entry);
      }
      const group = createSvg('g', {
        class: 'seam-line-presentation',
        'data-seam-line-id': entity.id,
        'data-owner-record-id': ownerRecordId || '',
        'data-source-ids': sourceIds.join(','),
        'data-stack-id': entity.stackId || 'stack-default',
      });
      group.classList.toggle('stack-hidden', !isStackVisible(entity.stackId || 'stack-default'));
      group.classList.toggle('stack-inactive', !isStackActive(entity.stackId || 'stack-default'));
      group.style.pointerEvents = 'none';
      group.appendChild(node);
      entry.groups.push(group);
    });
    removePresentationRoots();
    hosts.forEach(({ container, before, root, groups }) => {
      root.replaceChildren(...groups);
      if (before?.parentNode === container) container.insertBefore(root, before);
      else container.appendChild(root);
      presentationRoots.add(root);
    });
    return entities;
  }

  function presentationNodesForSourceIds(sourceIds = []) {
    const selected = new Set(sourceIds);
    return [...presentationRoots].flatMap((root) => [...root.children]).filter((node) => {
      const dependencies = String(node.dataset.sourceIds || '').split(',').filter(Boolean);
      return dependencies.length > 0 && dependencies.every((id) => selected.has(id));
    });
  }

  function removeReferences(recordIds = []) {
    const removed = new Set(recordIds);
    state = normalizeSeamLineExtension({
      definitions: state.definitions.filter((definition) => (
        !removed.has(definition.regionId)
        && !definition.recordIds.some((id) => removed.has(id))
      )),
    });
    refresh();
  }

  function prepareDrawingLoad(snapshot = {}) {
    return migrateSeamLineDrawingToExplicitEdges(snapshot);
  }

  function restore(value) {
    state = normalizeSeamLineExtension(value);
    refresh();
    return clone(state);
  }

  function clear() {
    state = normalizeSeamLineExtension();
    propertyFeatures = [];
    removePresentationRoots();
  }

  return {
    clearPropertyFeature,
    setPropertyFeatureFromEvent,
    getPropertyFeature: () => (propertyFeatures.length === 1 ? clone(propertyFeatures[0]) : null),
    getPropertyFeatures: () => clone(propertyFeatures),
    isSeamLineFeatureEligible,
    isSeamLineEntity,
    properties,
    refresh,
    setSelectedSeamLine,
    presentationNodesForSourceIds,
    removeReferences,
    prepareDrawingLoad,
    extensionProvider: {
      serialize() {
        return state.definitions.length ? clone(state) : null;
      },
      restore,
      clear,
    },
  };
}
