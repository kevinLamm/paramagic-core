import { arcSweepFromAngles } from './ArcGeometry.js';
import { deriveUuidForKey } from './IdentitySystem.js';
import { registerIdentitySchema } from './DrawingIdentitySystem.js';

registerIdentitySchema('swell', {
  declarations: (value) => (value?.constraints || []).map((object, index) => ({
    object, key: 'id', value: object.id, path: ['extensions', 'swell', 'constraints', String(index), 'id'], kind: 'swell-constraint',
  })),
  liveReferenceKeys: [
    'stackId', 'recordId', 'sourceId', 'targetId', 'ownerId', 'ownerRecordId', 'swellOwnerId', 'swellPieceId', 'swellSourceId',
  ],
  liveReferenceArrayKeys: ['participantStackIds', 'recordIds', 'sourceIds', 'sourceRecordIds'],
  lineageReferenceKeys: ['sourceRelationshipId', 'sourceRecordId', 'sourceStackId'],
  targetKindsByKey: {
    stackId: ['stack'],
    participantStackIds: ['stack'],
    recordId: ['entity'],
    sourceId: ['entity'],
    recordIds: ['entity'],
    sourceIds: ['entity'],
    sourceRecordIds: ['entity'],
  },
});
import { drawingCurveCubicPoint, drawingCurveCubicSegment } from './DrawingTools.js';
import { createUuid } from './IdentitySystem.js';

export const SWELL_DEFAULT_EXPRESSIONS = Object.freeze({
  swellEnabled: false,
  offsetExpression: '0.5',
  swellOffsetExpression: '1.5',
  startTransitionExpression: '4',
  endTransitionExpression: '4',
});

const EPSILON = 1e-8;
const TAU = Math.PI * 2;

const clone = (value) => JSON.parse(JSON.stringify(value));
const finitePoint = (point) => Array.isArray(point)
  && point.length >= 2
  && point.slice(0, 2).every(Number.isFinite);
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const subtract = (a, b) => [a[0] - b[0], a[1] - b[1]];
const scale = (point, amount) => [point[0] * amount, point[1] * amount];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const length = (value) => Math.hypot(value[0], value[1]);
const distance = (a, b) => length(subtract(a, b));
const unit = (value) => {
  const magnitude = length(value);
  return magnitude > EPSILON ? scale(value, 1 / magnitude) : null;
};
const rightNormal = (tangent) => [tangent[1], -tangent[0]];
const leftNormal = (tangent) => [-tangent[1], tangent[0]];
const midpoint = (a, b) => scale(add(a, b), 0.5);
const normalizeAngle = (angle) => (angle + TAU) % TAU;

export function normalizeSwellDefinition(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    enabled: source.enabled !== false,
    // Definitions saved before the Swell toggle existed were always in Swell
    // mode. Preserve that behavior while new definitions explicitly default off.
    swellEnabled: Object.prototype.hasOwnProperty.call(source, 'swellEnabled')
      ? source.swellEnabled === true
      : true,
    offsetExpression: String(source.offsetExpression ?? source.offset ?? SWELL_DEFAULT_EXPRESSIONS.offsetExpression),
    swellOffsetExpression: String(source.swellOffsetExpression ?? source.swellOffset ?? SWELL_DEFAULT_EXPRESSIONS.swellOffsetExpression),
    startTransitionExpression: String(source.startTransitionExpression ?? source.startArcLength ?? SWELL_DEFAULT_EXPRESSIONS.startTransitionExpression),
    endTransitionExpression: String(source.endTransitionExpression ?? source.endArcLength ?? SWELL_DEFAULT_EXPRESSIONS.endTransitionExpression),
  };
}

export function swellDefinitionForEntity(entity, segmentIndex = null) {
  const globalDefinition = entity?.composite?.swell;
  if (!globalDefinition?.enabled) return null;
  const segmentDefinition = Number.isInteger(segmentIndex)
    ? entity?.composite?.swellSegments?.[String(segmentIndex)]
    : null;
  return normalizeSwellDefinition(segmentDefinition || globalDefinition);
}

export function withSwellDefinition(entity, definition = SWELL_DEFAULT_EXPRESSIONS, segmentIndex = null) {
  const normalized = normalizeSwellDefinition(definition);
  const composite = clone(entity?.composite || {});
  if (!composite.id) composite.id = createUuid();
  if (!composite.kind) composite.kind = `swell-${entity?.type || 'geometry'}`;
  if (Number.isInteger(segmentIndex)) {
    composite.swell = normalizeSwellDefinition(composite.swell || SWELL_DEFAULT_EXPRESSIONS);
    composite.swellSegments = { ...(composite.swellSegments || {}), [String(segmentIndex)]: normalized };
  } else composite.swell = normalized;
  return { ...entity, construction: true, composite };
}

export function isSwellEntity(entity) {
  return Boolean(swellDefinitionForEntity(entity));
}

function swellFilletSourceEndpoints(entity) {
  return Array.isArray(entity?.composite?.swellFillet?.sourceEndpoints)
    ? entity.composite.swellFillet.sourceEndpoints.filter((endpoint) => (
      endpoint?.recordId && [0, 2].includes(Number(endpoint.index))
    ))
    : [];
}

function evaluatedDefinition(definition, evaluateLength, context = null) {
  const errors = {};
  const evaluate = (key, expression) => {
    try {
      const value = Number(evaluateLength(expression, context || definition));
      if (!Number.isFinite(value)) throw new Error('Expression did not resolve to a finite length.');
      return value;
    } catch (error) {
      errors[key] = error?.message || 'Invalid length expression.';
      return 0;
    }
  };
  const signedOffset = evaluate('offset', definition.offsetExpression);
  if (!definition.swellEnabled) {
    const direction = signedOffset < -EPSILON ? -1 : 1;
    const offset = Math.abs(signedOffset);
    return { direction, offset, swellOffset: offset, startTransition: 0, endTransition: 0, errors };
  }
  const signedSwellOffset = evaluate('swellOffset', definition.swellOffsetExpression);
  const signedStartTransition = evaluate('startTransition', definition.startTransitionExpression);
  const signedEndTransition = evaluate('endTransition', definition.endTransitionExpression);
  const direction = [signedOffset, signedSwellOffset, signedStartTransition, signedEndTransition]
    .some((value) => value < -EPSILON) ? -1 : 1;
  return {
    direction,
    offset: Math.abs(signedOffset),
    swellOffset: Math.abs(signedSwellOffset),
    startTransition: Math.abs(signedStartTransition),
    endTransition: Math.abs(signedEndTransition),
    errors,
  };
}

export function resolveSwellTransitionDistances(segmentLength, assignedStart, assignedEnd) {
  const available = Math.max(0, Number(segmentLength) || 0);
  const start = Math.max(0, Number(assignedStart) || 0);
  const end = Math.max(0, Number(assignedEnd) || 0);
  const assignedTotal = start + end;
  if (assignedTotal <= available + EPSILON) return { enabled: true, start, end, scale: 1 };
  if (assignedTotal <= EPSILON || assignedTotal * 0.5 > available + EPSILON) {
    return { enabled: false, start: 0, end: 0, scale: 0 };
  }
  const ratio = available / assignedTotal;
  return { enabled: true, start: start * ratio, end: end * ratio, scale: ratio };
}

function lineIntersection(a0, a1, b0, b1) {
  const a = subtract(a1, a0);
  const b = subtract(b1, b0);
  const denominator = a[0] * b[1] - a[1] * b[0];
  if (Math.abs(denominator) <= EPSILON) return null;
  const delta = subtract(b0, a0);
  const amount = (delta[0] * b[1] - delta[1] * b[0]) / denominator;
  return add(a0, scale(a, amount));
}

function circleFromThreePoints(a, b, c) {
  if (![a, b, c].every(finitePoint)) return null;
  const denominator = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(denominator) <= EPSILON) return null;
  const aa = a[0] ** 2 + a[1] ** 2;
  const bb = b[0] ** 2 + b[1] ** 2;
  const cc = c[0] ** 2 + c[1] ** 2;
  const center = [
    (aa * (b[1] - c[1]) + bb * (c[1] - a[1]) + cc * (a[1] - b[1])) / denominator,
    (aa * (c[0] - b[0]) + bb * (a[0] - c[0]) + cc * (b[0] - a[0])) / denominator,
  ];
  return { center, radius: distance(center, a) };
}

function pointOnCircle(center, point, radius) {
  const radial = unit(subtract(point, center));
  return radial ? add(center, scale(radial, radius)) : [...point];
}

function arcMiddlePoint(center, radius, start, end, ccw) {
  const startAngle = Math.atan2(start[1] - center[1], start[0] - center[0]);
  const endAngle = Math.atan2(end[1] - center[1], end[0] - center[0]);
  const span = ccw
    ? normalizeAngle(endAngle - startAngle)
    : -normalizeAngle(startAngle - endAngle);
  const angle = startAngle + span / 2;
  return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
}

function tangentArc(start, end, tangent, tangentAt = 'end') {
  const normal = leftNormal(tangent);
  const tangentPoint = tangentAt === 'start' ? start : end;
  const otherPoint = tangentAt === 'start' ? end : start;
  const delta = subtract(otherPoint, tangentPoint);
  const denominator = 2 * dot(delta, normal);
  if (Math.abs(denominator) <= EPSILON) return null;
  const center = add(tangentPoint, scale(normal, dot(delta, delta) / denominator));
  const radius = distance(center, tangentPoint);
  if (!Number.isFinite(radius) || radius <= EPSILON) return null;
  const radial = subtract(tangentPoint, center);
  const ccwTangent = leftNormal(radial);
  const cwTangent = rightNormal(radial);
  const desired = tangent;
  const ccw = dot(ccwTangent, desired) >= dot(cwTangent, desired);
  return {
    type: 'arc',
    start: [...start],
    arcPoint: arcMiddlePoint(center, radius, start, end, ccw),
    end: [...end],
    center,
    radius,
    ccw,
    major: false,
  };
}

function featurePiece(ownerId, segmentIndex, role, entity, ordinal) {
  return {
    id: deriveUuidForKey('swell-piece', ownerId, segmentIndex ?? 'entity', role, ordinal || 0),
    ownerId,
    segmentIndex,
    role,
    ordinal: Number.isInteger(ordinal) ? ordinal : 0,
    entity,
  };
}

function lineSegmentsForEntity(entity) {
  if (entity.type === 'line' && finitePoint(entity.start) && finitePoint(entity.end)) {
    return [{ ownerId: entity.id, segmentIndex: 0, start: entity.start, end: entity.end, entity }];
  }
  if (entity.type === 'rect') {
    const points = [
      [entity.x, entity.y],
      [entity.x + entity.width, entity.y],
      [entity.x + entity.width, entity.y + entity.height],
      [entity.x, entity.y + entity.height],
    ];
    return points.map((start, segmentIndex) => ({
      ownerId: entity.id,
      segmentIndex,
      start,
      end: points[(segmentIndex + 1) % points.length],
      entity,
    }));
  }
  if (!['polyline', 'polygon'].includes(entity.type) || !Array.isArray(entity.points)) return [];
  const closed = entity.type === 'polygon' || entity.closed === true;
  const count = closed ? entity.points.length : entity.points.length - 1;
  return Array.from({ length: Math.max(0, count) }, (_, segmentIndex) => ({
    ownerId: entity.id,
    segmentIndex,
    start: entity.points[segmentIndex],
    end: entity.points[(segmentIndex + 1) % entity.points.length],
    entity,
  })).filter(({ start, end }) => finitePoint(start) && finitePoint(end));
}

function sourceEndpointIndices(entity) {
  if (entity?.type === 'line' || entity?.type === 'arc') return [0, 2];
  if (['polyline', 'curve'].includes(entity?.type) && entity.closed !== true && entity.points?.length >= 2) {
    return [0, entity.points.length - 1];
  }
  return null;
}

function sourceEndpointPoint(entity, index) {
  if (entity?.type === 'line' || entity?.type === 'arc') return Number(index) === 0 ? entity.start : entity.end;
  return entity?.points?.[Number(index)] || null;
}

function sourceEndpointRole(entity, index) {
  const indices = sourceEndpointIndices(entity);
  if (!indices) return null;
  if (Number(index) === Number(indices[0])) return 'start';
  if (Number(index) === Number(indices[1])) return 'end';
  return null;
}

function sourceTopology(entities = [], constraints = []) {
  const byId = new Map(entities.filter(({ id }) => id).map((entity) => [entity.id, entity]));
  const endpointEntries = new Map();
  entities.forEach((entity) => {
    const indices = sourceEndpointIndices(entity);
    if (!indices) return;
    ['start', 'end'].forEach((role, offset) => {
      const index = indices[offset];
      const point = sourceEndpointPoint(entity, index);
      if (!finitePoint(point)) return;
      const key = endpointKey(entity.id, role);
      endpointEntries.set(key, { key, entity, recordId: entity.id, role, index, point });
    });
  });
  const parent = new Map([...endpointEntries.keys()].map((key) => [key, key]));
  const find = (key) => {
    let root = parent.get(key);
    while (root !== parent.get(root)) root = parent.get(root);
    let current = key;
    while (parent.get(current) !== root) {
      const next = parent.get(current);
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const union = (first, second) => {
    if (!parent.has(first) || !parent.has(second)) return;
    const firstRoot = find(first);
    const secondRoot = find(second);
    if (firstRoot !== secondRoot) parent.set(secondRoot, firstRoot);
  };
  const entries = [...endpointEntries.values()];
  entries.forEach((entry, index) => {
    entries.slice(index + 1).forEach((candidate) => {
      if (distance(entry.point, candidate.point) <= 1e-6) union(entry.key, candidate.key);
    });
  });
  constraints.forEach((constraint) => {
    if (constraint?.type !== 'Coincident' || constraint.enabled === false) return;
    const keys = (constraint.featureRefs || []).flatMap((reference) => {
      if (reference?.kind !== 'point') return [];
      const entity = byId.get(reference.recordId);
      const role = sourceEndpointRole(entity, reference.index);
      return role ? [endpointKey(reference.recordId, role)] : [];
    }).filter((key) => endpointEntries.has(key));
    keys.slice(1).forEach((key) => union(keys[0], key));
  });
  const groups = new Map();
  endpointEntries.forEach((entry, key) => {
    const root = find(key);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(entry);
  });
  const graphEdges = entities.flatMap((entity, index) => {
    const indices = sourceEndpointIndices(entity);
    if (!indices) return [];
    const startKey = endpointKey(entity.id, 'start');
    const endKey = endpointKey(entity.id, 'end');
    if (!parent.has(startKey) || !parent.has(endKey)) return [];
    return [{ index, entityId: entity.id, start: find(startKey), end: find(endKey) }];
  });
  const incident = new Map();
  graphEdges.forEach((edge) => {
    [edge.start, edge.end].forEach((node) => {
      if (!incident.has(node)) incident.set(node, []);
      incident.get(node).push(edge.index);
    });
  });
  const edgeByIndex = new Map(graphEdges.map((edge) => [edge.index, edge]));
  const cycles = [];
  const visitedNodes = new Set();
  const handledSelfLoops = new Set();
  const parentNode = new Map();
  const parentEdge = new Map();
  const depth = new Map();
  const oriented = (edge, from) => ({ entityId: edge.entityId, reversed: edge.start !== from });
  const visit = (node) => {
    visitedNodes.add(node);
    (incident.get(node) || []).forEach((edgeIndex) => {
      const edge = edgeByIndex.get(edgeIndex);
      if (!edge) return;
      const other = edge.start === node ? edge.end : edge.start;
      if (edge.start === edge.end) {
        if (!handledSelfLoops.has(edgeIndex)) {
          handledSelfLoops.add(edgeIndex);
          cycles.push([{ entityId: edge.entityId, reversed: false }]);
        }
        return;
      }
      if (!visitedNodes.has(other)) {
        parentNode.set(other, node);
        parentEdge.set(other, edgeIndex);
        depth.set(other, (depth.get(node) || 0) + 1);
        visit(other);
        return;
      }
      if (parentEdge.get(node) === edgeIndex || (depth.get(other) || 0) >= (depth.get(node) || 0)) return;
      const treePath = [];
      let cursor = node;
      while (cursor !== other) {
        const treeEdgeIndex = parentEdge.get(cursor);
        if (treeEdgeIndex === undefined) return;
        const parentValue = parentNode.get(cursor);
        treePath.unshift(oriented(edgeByIndex.get(treeEdgeIndex), parentValue));
        cursor = parentValue;
      }
      treePath.push(oriented(edge, node));
      cycles.push(treePath);
    });
  };
  incident.forEach((_edgeIndices, node) => {
    if (visitedNodes.has(node)) return;
    depth.set(node, 0);
    visit(node);
  });
  return { groups: [...groups.values()], cycles };
}

function sourceCycleCenter(cycle, byId) {
  const points = cycle.flatMap(({ entityId }) => {
    const entity = byId.get(entityId);
    if (!entity) return [];
    if (entity.type === 'line') return [entity.start, entity.end];
    if (entity.type === 'arc') return [entity.start, entity.arcPoint, entity.end];
    return entity.points || [];
  }).filter(finitePoint);
  return points.length
    ? scale(points.reduce((sum, point) => add(sum, point), [0, 0]), 1 / points.length)
    : null;
}

function compositeGroups(entities) {
  const groups = new Map();
  entities.forEach((entity) => {
    const id = entity?.composite?.id;
    if (!id) return;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(entity);
  });
  return groups;
}

function groupCentroid(group = []) {
  const points = group.flatMap((entity) => lineSegmentsForEntity(entity).flatMap(({ start, end }) => [start, end]));
  if (!points.length) return null;
  return scale(points.reduce((sum, point) => add(sum, point), [0, 0]), 1 / points.length);
}

function lineNormal(segment, groups, cycleCenters = new Map()) {
  const tangent = unit(subtract(segment.end, segment.start));
  if (!tangent) return null;
  let normal = rightNormal(tangent);
  const composite = segment.entity?.composite;
  const cycleCenter = cycleCenters.get(segment.ownerId);
  if (cycleCenter || composite?.closed || ['rect', 'polygon'].includes(segment.entity.type)) {
    const center = cycleCenter || groupCentroid((composite?.id && groups.get(composite.id)) || [segment.entity]);
    if (center) {
      const fromCenter = subtract(midpoint(segment.start, segment.end), center);
      if (dot(normal, fromCenter) < 0) normal = scale(normal, -1);
    }
  }
  return { tangent, normal };
}

function endpointKey(recordId, index) {
  return `${recordId}::${index === 'end' || Number(index) === 2 ? 'end' : 'start'}`;
}

function coincidentEndpointPairs(constraints = []) {
  return constraints.flatMap((constraint) => {
    if (constraint?.type !== 'Coincident' || constraint.enabled === false) return [];
    const refs = (constraint.featureRefs || []).filter((ref) => ref.kind === 'point' && [0, 2].includes(Number(ref.index)));
    if (refs.length !== 2) return [];
    return [[endpointKey(refs[0].recordId, refs[0].index), endpointKey(refs[1].recordId, refs[1].index)]];
  });
}

function lineCircleIntersections(lineStart, lineEnd, center, radius) {
  const direction = subtract(lineEnd, lineStart);
  const fromCenter = subtract(lineStart, center);
  const a = dot(direction, direction);
  if (a <= EPSILON) return [];
  const b = 2 * dot(fromCenter, direction);
  const c = dot(fromCenter, fromCenter) - radius ** 2;
  const discriminant = b ** 2 - 4 * a * c;
  if (discriminant < -EPSILON) return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  return [...new Set([(-b - root) / (2 * a), (-b + root) / (2 * a)])]
    .map((amount) => add(lineStart, scale(direction, amount)));
}

function circleCircleIntersections(first, second) {
  const delta = subtract(second.center, first.center);
  const centerDistance = length(delta);
  if (centerDistance <= EPSILON) return [];
  if (centerDistance > first.radius + second.radius + EPSILON) return [];
  if (centerDistance < Math.abs(first.radius - second.radius) - EPSILON) return [];
  const along = (first.radius ** 2 - second.radius ** 2 + centerDistance ** 2) / (2 * centerDistance);
  const heightSquared = first.radius ** 2 - along ** 2;
  if (heightSquared < -EPSILON) return [];
  const base = add(first.center, scale(delta, along / centerDistance));
  const perpendicular = scale(leftNormal(delta), Math.sqrt(Math.max(0, heightSquared)) / centerDistance);
  return heightSquared <= EPSILON ? [base] : [add(base, perpendicular), subtract(base, perpendicular)];
}

function nearestPoint(points, target) {
  return points.reduce((nearest, point) => (
    !nearest || distance(point, target) < distance(nearest, target) ? point : nearest
  ), null);
}

function joinOffsetEndpoints(lineDescriptors, arcDescriptors, constraints) {
  const byEndpoint = new Map();
  lineDescriptors.forEach((descriptor) => {
    byEndpoint.set(endpointKey(descriptor.ownerId, 0), { kind: 'line', descriptor, endpoint: 'start' });
    byEndpoint.set(endpointKey(descriptor.ownerId, 2), { kind: 'line', descriptor, endpoint: 'end' });
  });
  arcDescriptors.forEach((descriptor) => {
    byEndpoint.set(endpointKey(descriptor.ownerId, 0), { kind: 'arc', descriptor, endpoint: 'start' });
    byEndpoint.set(endpointKey(descriptor.ownerId, 2), { kind: 'arc', descriptor, endpoint: 'end' });
  });
  const pairs = coincidentEndpointPairs(constraints);
  lineDescriptors.forEach((descriptor) => {
    if (!['polyline', 'polygon', 'rect'].includes(descriptor.entity.type)) return;
    const entitySegments = lineDescriptors.filter(({ ownerId }) => ownerId === descriptor.ownerId);
    const next = entitySegments.find(({ segmentIndex }) => segmentIndex === descriptor.segmentIndex + 1)
      || (['polygon', 'rect'].includes(descriptor.entity.type) || descriptor.entity.closed ? entitySegments[0] : null);
    if (next) pairs.push([
      `${descriptor.ownerId}::internal-${descriptor.segmentIndex}-end`,
      `${descriptor.ownerId}::internal-${next.segmentIndex}-start`,
    ]);
  });
  const internal = new Map();
  lineDescriptors.forEach((descriptor) => {
    internal.set(`${descriptor.ownerId}::internal-${descriptor.segmentIndex}-start`, { kind: 'line', descriptor, endpoint: 'start' });
    internal.set(`${descriptor.ownerId}::internal-${descriptor.segmentIndex}-end`, { kind: 'line', descriptor, endpoint: 'end' });
  });
  const currentPoint = (entry) => {
    if (entry.kind === 'line') return entry.endpoint === 'start' ? entry.descriptor.baseStart : entry.descriptor.baseEnd;
    return entry.endpoint === 'start' ? entry.descriptor.offset.start : entry.descriptor.offset.end;
  };
  const sourcePoint = (entry) => {
    if (entry.kind === 'line') {
      return entry.endpoint === 'start' ? entry.descriptor.start : entry.descriptor.end;
    }
    return entry.endpoint === 'start' ? entry.descriptor.entity.start : entry.descriptor.entity.end;
  };
  const setPoint = (entry, point) => {
    if (entry.kind === 'line') {
      if (entry.endpoint === 'start') entry.descriptor.baseStart = point;
      else entry.descriptor.baseEnd = point;
      return;
    }
    if (entry.endpoint === 'start') entry.descriptor.offset.start = point;
    else entry.descriptor.offset.end = point;
  };
  pairs.forEach(([aKey, bKey]) => {
    const a = byEndpoint.get(aKey) || internal.get(aKey);
    const b = byEndpoint.get(bKey) || internal.get(bKey);
    if (!a || !b || a.descriptor === b.descriptor) return;
    const target = midpoint(sourcePoint(a), sourcePoint(b));
    let candidates = [];
    if (a.kind === 'line' && b.kind === 'line') {
      const intersection = lineIntersection(
        a.descriptor.baseStart,
        a.descriptor.baseEnd,
        b.descriptor.baseStart,
        b.descriptor.baseEnd,
      );
      if (intersection) candidates = [intersection];
    } else if (a.kind === 'line' || b.kind === 'line') {
      const line = a.kind === 'line' ? a : b;
      const arc = a.kind === 'arc' ? a : b;
      candidates = lineCircleIntersections(
        line.descriptor.baseStart,
        line.descriptor.baseEnd,
        arc.descriptor.offset.center,
        arc.descriptor.offset.radius,
      );
    } else {
      candidates = circleCircleIntersections(a.descriptor.offset, b.descriptor.offset);
    }
    const joined = nearestPoint(candidates, target) || midpoint(currentPoint(a), currentPoint(b));
    setPoint(a, joined);
    setPoint(b, joined);
  });
}

function deriveLinePieces(descriptor) {
  const {
    ownerId, segmentIndex, start, end, tangent, normal, definition, evaluated,
    suppressStartTransition, suppressEndTransition,
  } = descriptor;
  const ordinal = [];
  const push = (role, entity) => ordinal.push(featurePiece(ownerId, segmentIndex, role, entity, ordinal.length));
  const segmentLength = distance(start, end);
  const assignedStart = evaluated.direction < 0 ? evaluated.endTransition : evaluated.startTransition;
  const assignedEnd = evaluated.direction < 0 ? evaluated.startTransition : evaluated.endTransition;
  const transitions = resolveSwellTransitionDistances(
    segmentLength,
    suppressStartTransition ? 0 : assignedStart,
    suppressEndTransition ? 0 : assignedEnd,
  );
  const canSwell = definition.swellEnabled
    && evaluated.swellOffset > evaluated.offset + EPSILON
    && transitions.enabled;
  if (!canSwell) {
    push('offset', { type: 'line', start: descriptor.baseStart, end: descriptor.baseEnd });
    return { pieces: ordinal, definition, evaluated, usedSwell: false };
  }
  const swellStart = suppressStartTransition
    ? descriptor.baseStart
    : add(add(start, scale(tangent, transitions.start)), scale(normal, evaluated.swellOffset));
  const swellEnd = suppressEndTransition
    ? descriptor.baseEnd
    : add(add(end, scale(tangent, -transitions.end)), scale(normal, evaluated.swellOffset));
  const startArc = tangentArc(descriptor.baseStart, swellStart, tangent, 'end');
  const endArc = tangentArc(swellEnd, descriptor.baseEnd, tangent, 'start');
  if (!suppressStartTransition) {
    if (startArc) push('start-transition', startArc);
    else push('start-transition', { type: 'line', start: descriptor.baseStart, end: swellStart });
  }
  if (distance(swellStart, swellEnd) > EPSILON) push('swell', { type: 'line', start: swellStart, end: swellEnd });
  if (!suppressEndTransition) {
    if (endArc) push('end-transition', endArc);
    else push('end-transition', { type: 'line', start: swellEnd, end: descriptor.baseEnd });
  }
  return { pieces: ordinal, definition, evaluated, usedSwell: true, transitions };
}

function offsetPolyline(points, amount, { closed = false, outward = false, center: suppliedCenter = null } = {}) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const center = suppliedCenter || (closed && outward
    ? scale(points.reduce((sum, point) => add(sum, point), [0, 0]), 1 / points.length)
    : null);
  const segmentCount = closed ? points.length : points.length - 1;
  const shifted = Array.from({ length: segmentCount }, (_, index) => {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const tangent = unit(subtract(end, start));
    if (!tangent) return null;
    let normal = rightNormal(tangent);
    if (center && dot(normal, subtract(midpoint(start, end), center)) < 0) normal = scale(normal, -1);
    return { start: add(start, scale(normal, amount)), end: add(end, scale(normal, amount)) };
  });
  return points.map((point, index) => {
    const previousIndex = (index - 1 + segmentCount) % segmentCount;
    const previous = index > 0 || closed ? shifted[previousIndex] : null;
    const next = index < segmentCount ? shifted[index] : null;
    if (previous && next) return lineIntersection(previous.start, previous.end, next.start, next.end) || midpoint(previous.end, next.start);
    return previous?.end || next?.start || [...point];
  });
}

function sampledCurvePoints(entity, samplesPerSegment = 16) {
  const points = entity.points || [];
  if (points.length < 2) return [];
  const sampled = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const cubic = drawingCurveCubicSegment(points, index);
    for (let sample = index === 0 ? 0 : 1; sample <= samplesPerSegment; sample += 1) {
      sampled.push(drawingCurveCubicPoint(cubic, sample / samplesPerSegment));
    }
  }
  return sampled;
}

function deriveRoundOrCurve(entity, definition, evaluated, { cycleCenter = null } = {}) {
  const signedOffset = evaluated.direction * evaluated.offset;
  if (entity.type === 'circle' && finitePoint(entity.center)) {
    return [{
      type: 'circle',
      center: [...entity.center],
      radius: Math.max(EPSILON, Math.abs(Number(entity.radius) || 0) + signedOffset),
    }];
  }
  if (entity.type === 'arc') {
    const circle = finitePoint(entity.center) && Number.isFinite(Number(entity.radius))
      ? { center: entity.center, radius: Math.abs(Number(entity.radius)) }
      : circleFromThreePoints(entity.start, entity.arcPoint, entity.end);
    if (!circle) return [];
    const startAngle = Math.atan2(entity.start[1] - circle.center[1], entity.start[0] - circle.center[0]);
    const endAngle = Math.atan2(entity.end[1] - circle.center[1], entity.end[0] - circle.center[0]);
    const middleAngle = Math.atan2(entity.arcPoint[1] - circle.center[1], entity.arcPoint[0] - circle.center[0]);
    const sweep = arcSweepFromAngles(startAngle, endAngle, middleAngle, entity);
    const filletOffset = swellFilletSourceEndpoints(entity).length
      ? evaluated.direction * (definition.swellEnabled ? Math.max(evaluated.offset, evaluated.swellOffset) : evaluated.offset)
      : null;
    const radialDirection = cycleCenter && finitePoint(entity.arcPoint)
      ? (dot(
        subtract(entity.arcPoint, circle.center),
        subtract(entity.arcPoint, cycleCenter),
      ) >= 0 ? 1 : -1)
      : (sweep.ccw ? 1 : -1);
    const radius = Math.max(
      EPSILON,
      circle.radius + (filletOffset ?? radialDirection * signedOffset),
    );
    return [{
      type: 'arc',
      center: [...circle.center],
      radius,
      start: pointOnCircle(circle.center, entity.start, radius),
      arcPoint: pointOnCircle(circle.center, entity.arcPoint, radius),
      end: pointOnCircle(circle.center, entity.end, radius),
      ccw: sweep.ccw,
      major: sweep.major,
    }];
  }
  if (entity.type === 'curve') {
    const sampled = sampledCurvePoints(entity);
    const points = offsetPolyline(sampled, signedOffset, { center: cycleCenter });
    return points.length >= 2 ? [{ type: 'polyline', points }] : [];
  }
  return [];
}

function terminalPiece(result, role) {
  if (!result?.pieces?.length) return null;
  return role === 'end' ? result.pieces.at(-1) : result.pieces[0];
}

function terminalPoint(piece, role) {
  const entity = piece?.entity;
  if (!entity) return null;
  if (entity.type === 'line' || entity.type === 'arc') return role === 'end' ? entity.end : entity.start;
  if (entity.type === 'polyline' || entity.type === 'polygon') {
    return role === 'end' ? entity.points?.at(-1) : entity.points?.[0];
  }
  return null;
}

function terminalLine(piece, role) {
  const entity = piece?.entity;
  if (!entity) return null;
  if (entity.type === 'line') return [entity.start, entity.end];
  if (entity.type === 'polyline' || entity.type === 'polygon') {
    const points = entity.points || [];
    if (points.length < 2) return null;
    return role === 'end' ? [points.at(-2), points.at(-1)] : [points[0], points[1]];
  }
  return null;
}

function setTerminalPoint(piece, role, point) {
  const entity = piece?.entity;
  if (!entity || !finitePoint(point)) return;
  if (entity.type === 'line' || entity.type === 'arc') {
    if (role === 'end') entity.end = [...point];
    else entity.start = [...point];
    return;
  }
  if (!['polyline', 'polygon'].includes(entity.type) || !entity.points?.length) return;
  if (role === 'end') entity.points[entity.points.length - 1] = [...point];
  else entity.points[0] = [...point];
}

function joinedTerminalPoint(first, second) {
  const firstPiece = terminalPiece(first.result, first.role);
  const secondPiece = terminalPiece(second.result, second.role);
  const firstPoint = terminalPoint(firstPiece, first.role);
  const secondPoint = terminalPoint(secondPiece, second.role);
  if (!finitePoint(firstPoint) || !finitePoint(secondPoint)) return null;
  if (distance(firstPoint, secondPoint) <= EPSILON) return [...firstPoint];
  const target = midpoint(first.sourcePoint, second.sourcePoint);
  const firstArc = firstPiece?.entity?.type === 'arc' ? firstPiece.entity : null;
  const secondArc = secondPiece?.entity?.type === 'arc' ? secondPiece.entity : null;
  let candidates = [];
  if (firstArc && secondArc) {
    candidates = circleCircleIntersections(firstArc, secondArc);
  } else if (firstArc || secondArc) {
    const arc = firstArc || secondArc;
    const lineEntry = firstArc ? second : first;
    const line = terminalLine(terminalPiece(lineEntry.result, lineEntry.role), lineEntry.role);
    if (line) candidates = lineCircleIntersections(line[0], line[1], arc.center, arc.radius);
  } else {
    const firstLine = terminalLine(firstPiece, first.role);
    const secondLine = terminalLine(secondPiece, second.role);
    const intersection = firstLine && secondLine
      ? lineIntersection(firstLine[0], firstLine[1], secondLine[0], secondLine[1])
      : null;
    if (intersection) candidates = [intersection];
  }
  return nearestPoint(candidates, target) || midpoint(firstPoint, secondPoint);
}

function joinDerivedEndpointGroups(results, groups = []) {
  groups.forEach((group) => {
    const entries = group.flatMap((entry) => {
      const result = results.get(entry.recordId);
      return result?.pieces?.length ? [{
        result,
        role: entry.role,
        sourcePoint: entry.point,
      }] : [];
    });
    if (entries.length < 2) return;
    const joined = entries.length === 2
      ? joinedTerminalPoint(entries[0], entries[1])
      : scale(entries.reduce((sum, entry) => (
        add(sum, terminalPoint(terminalPiece(entry.result, entry.role), entry.role))
      ), [0, 0]), 1 / entries.length);
    if (!finitePoint(joined)) return;
    entries.forEach((entry) => setTerminalPoint(terminalPiece(entry.result, entry.role), entry.role, joined));
  });
}

function applyBoundaryMetadata(results, sourceEntities, cycles) {
  const byId = new Map(sourceEntities.map((entity) => [entity.id, entity]));
  sourceEntities.forEach((entity) => {
    const result = results.get(entity.id);
    if (!result?.closed) return;
    result.boundaryId = String(entity.composite?.id || entity.id);
    result.boundaryIndex = Number(entity.composite?.index) || 0;
    result.boundaryCount = Number(entity.composite?.count) || 1;
    result.boundaryReversed = false;
  });
  cycles.forEach((cycle) => {
    const compositeIds = new Set(cycle
      .map(({ entityId }) => byId.get(entityId)?.composite?.id)
      .filter(Boolean));
    const memberIds = cycle.map(({ entityId }) => entityId).sort();
    const cycleId = compositeIds.size === 1
      ? String([...compositeIds][0])
      : deriveUuidForKey('swell-cycle', ...memberIds);
    cycle.forEach(({ entityId, reversed }, index) => {
      const result = results.get(entityId);
      if (!result) return;
      result.closed = true;
      result.boundaryId = cycleId;
      result.boundaryIndex = index;
      result.boundaryCount = cycle.length;
      result.boundaryReversed = reversed;
    });
  });
}

function reversePiece(piece) {
  const reversed = clone(piece);
  const entity = reversed.entity;
  if (entity.type === 'line') [entity.start, entity.end] = [entity.end, entity.start];
  if (entity.type === 'arc') {
    [entity.start, entity.end] = [entity.end, entity.start];
    entity.ccw = entity.ccw === false;
  }
  if (entity.type === 'polyline' || entity.type === 'polygon') entity.points.reverse();
  return reversed;
}

function orientedResultPieces(result) {
  return result.boundaryReversed
    ? [...result.pieces].reverse().map(reversePiece)
    : result.pieces;
}

export function deriveSwellGeometry({ entities = [], constraints = [], evaluateLength = Number } = {}) {
  const sourceEntities = entities.filter(isSwellEntity);
  const sourceById = new Map(sourceEntities.map((entity) => [entity.id, entity]));
  const topology = sourceTopology(sourceEntities, constraints);
  const cycleCenters = new Map();
  topology.cycles.forEach((cycle) => {
    const center = sourceCycleCenter(cycle, sourceById);
    if (center) cycle.forEach(({ entityId }) => cycleCenters.set(entityId, center));
  });
  const groups = compositeGroups(sourceEntities);
  const results = new Map();
  const consumedEndpoints = new Set(sourceEntities.flatMap(swellFilletSourceEndpoints)
    .map((endpoint) => endpointKey(endpoint.recordId, endpoint.index)));
  const descriptors = sourceEntities.flatMap(lineSegmentsForEntity).map((segment) => {
    const definition = swellDefinitionForEntity(segment.entity, segment.segmentIndex);
    const evaluated = evaluatedDefinition(definition, evaluateLength, segment.entity);
    const orientation = lineNormal(segment, groups, cycleCenters);
    if (!orientation) return null;
    if (evaluated.direction < 0) orientation.normal = scale(orientation.normal, -1);
    const suppressStartTransition = consumedEndpoints.has(endpointKey(segment.ownerId, 0));
    const suppressEndTransition = consumedEndpoints.has(endpointKey(segment.ownerId, 2));
    const effectiveSwellOffset = definition.swellEnabled
      ? Math.max(evaluated.offset, evaluated.swellOffset)
      : evaluated.offset;
    return {
      ...segment,
      ...orientation,
      definition,
      evaluated,
      suppressStartTransition,
      suppressEndTransition,
      baseStart: add(segment.start, scale(
        orientation.normal,
        suppressStartTransition ? effectiveSwellOffset : evaluated.offset,
      )),
      baseEnd: add(segment.end, scale(
        orientation.normal,
        suppressEndTransition ? effectiveSwellOffset : evaluated.offset,
      )),
    };
  }).filter(Boolean);
  const arcDescriptors = sourceEntities.filter((entity) => entity.type === 'arc').map((entity) => {
    const definition = swellDefinitionForEntity(entity);
    const evaluated = evaluatedDefinition(definition, evaluateLength, entity);
    const offset = deriveRoundOrCurve(entity, definition, evaluated, {
      cycleCenter: cycleCenters.get(entity.id) || null,
    })[0];
    return offset ? { ownerId: entity.id, entity, definition, evaluated, offset } : null;
  }).filter(Boolean);
  joinOffsetEndpoints(descriptors, arcDescriptors, constraints);
  descriptors.forEach((descriptor) => {
    const derived = deriveLinePieces(descriptor);
    const existing = results.get(descriptor.ownerId) || {
      ownerId: descriptor.ownerId,
      sourceEntity: descriptor.entity,
      closed: ['rect', 'polygon'].includes(descriptor.entity.type) || descriptor.entity.composite?.closed === true,
      pieces: [],
      segmentResults: new Map(),
    };
    existing.pieces.push(...derived.pieces);
    existing.segmentResults.set(descriptor.segmentIndex, derived);
    results.set(descriptor.ownerId, existing);
  });
  sourceEntities.forEach((entity) => {
    if (results.has(entity.id)) return;
    const definition = swellDefinitionForEntity(entity);
    const evaluated = evaluatedDefinition(definition, evaluateLength, entity);
    const preparedArc = arcDescriptors.find(({ ownerId }) => ownerId === entity.id);
    const derived = preparedArc ? [preparedArc.offset] : deriveRoundOrCurve(entity, definition, evaluated, {
      cycleCenter: cycleCenters.get(entity.id) || null,
    });
    results.set(entity.id, {
      ownerId: entity.id,
      sourceEntity: entity,
      closed: entity.type === 'circle' || entity.type === 'polygon' || entity.composite?.closed === true,
      pieces: derived.map((piece, index) => featurePiece(entity.id, null, 'offset', piece, index)),
      segmentResults: new Map(),
      definition,
      evaluated,
    });
  });
  joinDerivedEndpointGroups(results, topology.groups);
  applyBoundaryMetadata(results, sourceEntities, topology.cycles);
  return results;
}

function swellBoundaryFeatureForPiece(piece, boundaryId) {
  const entity = piece?.entity;
  if (!entity) return null;
  const common = {
    recordId: piece.id,
    sourceId: piece.ownerId,
    targetId: boundaryId,
    entityType: entity.type,
    index: 0,
    sourceFeatureIndex: Number.isInteger(piece.segmentIndex) ? piece.segmentIndex : 0,
    boundaryRole: `swell-${piece.role}`,
    stableKey: `swell-boundary:${boundaryId}:${piece.id}`,
    parameterStart: 0,
    parameterEnd: 1,
    swellDerived: true,
    swellSourceId: piece.ownerId,
    swellSegmentIndex: piece.segmentIndex,
    swellRole: piece.role,
  };
  if (entity.type === 'line') {
    return { ...common, kind: 'segment', start: [...entity.start], end: [...entity.end] };
  }
  if (entity.type === 'arc') {
    return {
      ...common,
      kind: 'arc',
      center: [...entity.center],
      radius: entity.radius,
      start: [...entity.start],
      arcPoint: [...entity.arcPoint],
      end: [...entity.end],
      ccw: entity.ccw,
      major: entity.major,
    };
  }
  if (entity.type === 'circle') {
    return { ...common, kind: 'circle', center: [...entity.center], radius: entity.radius };
  }
  if (entity.type === 'polyline' || entity.type === 'polygon') {
    return { ...common, kind: 'polyline', points: (entity.points || []).map((point) => [...point]) };
  }
  return null;
}

function sampleSwellBoundaryFeature(feature) {
  if (feature.kind === 'segment') return [[...feature.start], [...feature.end]];
  if (feature.kind === 'polyline') return feature.points.map((point) => [...point]);
  if (feature.kind === 'circle') {
    return Array.from({ length: 48 }, (_, index) => {
      const angle = TAU * index / 48;
      return add(feature.center, scale([Math.cos(angle), Math.sin(angle)], feature.radius));
    });
  }
  if (feature.kind !== 'arc') return [];
  const start = Math.atan2(feature.start[1] - feature.center[1], feature.start[0] - feature.center[0]);
  const end = Math.atan2(feature.end[1] - feature.center[1], feature.end[0] - feature.center[0]);
  const middle = Math.atan2(feature.arcPoint[1] - feature.center[1], feature.arcPoint[0] - feature.center[0]);
  const sweep = arcSweepFromAngles(start, end, middle, feature);
  const count = Math.max(8, Math.ceil(Math.abs(sweep.span) / (Math.PI / 24)));
  return Array.from({ length: count + 1 }, (_, index) => {
    const angle = start + (sweep.ccw ? 1 : -1) * sweep.span * index / count;
    return add(feature.center, scale([Math.cos(angle), Math.sin(angle)], feature.radius));
  });
}

export function swellBoundariesFromDerived(derived = new Map()) {
  const groups = new Map();
  derived.forEach((result) => {
    if (!result?.closed) return;
    const boundaryId = String(result.boundaryId || result.sourceEntity?.composite?.id || result.ownerId);
    if (!groups.has(boundaryId)) groups.set(boundaryId, []);
    groups.get(boundaryId).push(result);
  });
  return [...groups.entries()].map(([boundaryId, members]) => {
    const ordered = [...members].sort((a, b) => (
      Number(a.boundaryIndex ?? a.sourceEntity?.composite?.index ?? 0)
      - Number(b.boundaryIndex ?? b.sourceEntity?.composite?.index ?? 0)
    ));
    const features = ordered
      .flatMap(orientedResultPieces)
      .map((piece) => swellBoundaryFeatureForPiece(piece, boundaryId))
      .filter(Boolean);
    const polygon = [];
    features.forEach((feature, index) => {
      const sampled = sampleSwellBoundaryFeature(feature);
      if (!sampled.length) return;
      const duplicateStart = index > 0 && polygon.length > 0 && distance(polygon.at(-1), sampled[0]) <= 1e-7;
      polygon.push(...(duplicateStart ? sampled.slice(1) : sampled));
    });
    if (polygon.length > 1 && distance(polygon[0], polygon.at(-1)) <= 1e-7) polygon.pop();
    return {
      id: boundaryId,
      kind: 'swell-derived',
      recordIds: ordered.map(({ ownerId }) => ownerId),
      appearanceSourceId: ordered[0]?.ownerId,
      stackId: ordered[0]?.sourceEntity?.stackId || null,
      features,
      polygon,
      points: polygon,
    };
  }).filter((boundary) => boundary.features.length > 0 && boundary.polygon.length >= 3);
}

export function swellBoundaryPath(features = []) {
  if (features.length === 1 && features[0]?.kind === 'circle') {
    const { center, radius } = features[0];
    if (!finitePoint(center) || !Number.isFinite(Number(radius))) return '';
    const r = Math.max(1e-8, Math.abs(Number(radius)));
    return `M ${center[0] + r} ${center[1]} A ${r} ${r} 0 1 1 ${center[0] - r} ${center[1]} A ${r} ${r} 0 1 1 ${center[0] + r} ${center[1]} Z`;
  }
  const first = features[0];
  const firstPoint = first?.kind === 'segment' || first?.kind === 'arc'
    ? first.start
    : first?.kind === 'polyline' ? first.points?.[0] : null;
  if (!finitePoint(firstPoint)) return '';
  let path = `M ${firstPoint[0]} ${firstPoint[1]}`;
  features.forEach((feature) => {
    if (feature.kind === 'segment') path += ` L ${feature.end[0]} ${feature.end[1]}`;
    else if (feature.kind === 'arc') {
      const radius = Math.max(1e-8, Math.abs(Number(feature.radius) || 0));
      path += ` A ${radius} ${radius} 0 ${feature.major ? 1 : 0} ${feature.ccw === false ? 0 : 1} ${feature.end[0]} ${feature.end[1]}`;
    } else if (feature.kind === 'polyline') {
      (feature.points || []).slice(1).forEach((point) => { path += ` L ${point[0]} ${point[1]}`; });
    }
  });
  return `${path} Z`;
}

export function deriveSwellBoundaries(options = {}) {
  return swellBoundariesFromDerived(deriveSwellGeometry(options));
}
