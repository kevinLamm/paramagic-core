import {
  evaluateFilletedGeometry,
  filletTopologyConstraints,
} from './FilletSystem.js';
import { sampleNotchFeature } from './NotchSystem.js';
import { arcSweepFromAngles } from './ArcGeometry.js';
import { CANVAS_ORIGIN_RECORD_ID } from './CanvasOrigin.js';

// --- Closed Region Topology Cycle Detection ---
function endpointIndices(entity) {
  if (entity.type === 'line' || entity.type === 'arc') return [0, 2];
  if (entity.type === 'polyline' || entity.type === 'curve') {
    return entity.points?.length >= 2 ? [0, entity.points.length - 1] : null;
  }
  return null;
}

function endpointKey(recordId, index) {
  return `${recordId}:${index}`;
}

export const CLOSED_GEOMETRY_ENDPOINT_TOLERANCE = 1e-6;

// Construction geometry is not a boundary edge, but its endpoint nodes may
// still be part of the connection graph for visible geometry. Keep this
// filtering rule in the topology module so callers do not accidentally throw
// away valid connection scaffolding before cycle detection runs.
export function closedGeometryTopologyEntities(entities = []) {
  return entities.filter((entity) => (
    entity && entity.composite?.kind !== 'finish-size-offset'
  ));
}

export function findClosedGeometryCycles(entities = [], constraints = []) {
  const edges = [];
  const endpointKeys = new Set();
  const endpointPoints = new Map();
  entities.forEach((entity) => {
    const indices = endpointIndices(entity);
    if (!indices || !entity.id) return;
    const startKey = endpointKey(entity.id, indices[0]);
    const endKey = endpointKey(entity.id, indices[1]);
    endpointKeys.add(startKey);
    endpointKeys.add(endKey);
    const startPoint = entity.type === 'line' || entity.type === 'arc' ? entity.start : entity.points[indices[0]];
    const endPoint = entity.type === 'line' || entity.type === 'arc' ? entity.end : entity.points[indices[1]];
    endpointPoints.set(startKey, startPoint);
    endpointPoints.set(endKey, endPoint);
    if (!entity.construction) edges.push({ entityId: entity.id, startKey, endKey });
  });

  const parent = new Map([...endpointKeys].map((key) => [key, key]));
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
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  const samePoint = (a, b) => a && b && Math.hypot(a[0] - b[0], a[1] - b[1]) <= CLOSED_GEOMETRY_ENDPOINT_TOLERANCE;
  const endpointBuckets = new Map();

  // A shared endpoint is a topological join even when the user did not add a
  // direct Coincident constraint. This also connects visible endpoints to
  // construction endpoints when their solved coordinates are shared.
  endpointPoints.forEach((point, key) => {
    if (!Array.isArray(point) || !Number.isFinite(Number(point[0])) || !Number.isFinite(Number(point[1]))) return;
    const x = Number(point[0]);
    const y = Number(point[1]);
    const bucketX = Math.floor(x / CLOSED_GEOMETRY_ENDPOINT_TOLERANCE);
    const bucketY = Math.floor(y / CLOSED_GEOMETRY_ENDPOINT_TOLERANCE);
    const gridKey = (gridX, gridY) => `${gridX},${gridY}`;
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const nearby = endpointBuckets.get(gridKey(bucketX + offsetX, bucketY + offsetY));
        nearby?.forEach((candidateKey) => {
          if (samePoint(point, endpointPoints.get(candidateKey))) union(key, candidateKey);
        });
      }
    }
    const bucket = gridKey(bucketX, bucketY);
    if (!endpointBuckets.has(bucket)) endpointBuckets.set(bucket, []);
    endpointBuckets.get(bucket).push(key);
  });

  const compositeGroups = new Map();
  entities.forEach((entity) => {
    if (entity.construction || !entity.composite?.closed || !entity.composite.id) return;
    if (!compositeGroups.has(entity.composite.id)) compositeGroups.set(entity.composite.id, []);
    compositeGroups.get(entity.composite.id).push(entity);
  });
  compositeGroups.forEach((group) => {
    group.sort((a, b) => a.composite.index - b.composite.index);
    const expectedCount = group[0]?.composite.count;
    if (!expectedCount || group.length !== expectedCount) return;
    group.forEach((entity, index) => {
      const next = group[(index + 1) % group.length];
      const entityIndices = endpointIndices(entity);
      const nextIndices = endpointIndices(next);
      if (!entityIndices || !nextIndices) return;
      const endKey = endpointKey(entity.id, entityIndices[1]);
      const nextStartKey = endpointKey(next.id, nextIndices[0]);
      if (samePoint(endpointPoints.get(endKey), endpointPoints.get(nextStartKey))) union(endKey, nextStartKey);
    });
  });

  constraints.forEach((constraint) => {
    if (constraint.enabled === false || constraint.type !== 'Coincident') return;
    const keys = (constraint.featureRefs || [])
      .filter((ref) => ref.kind === 'point')
      .map((ref) => endpointKey(ref.recordId, ref.index || 0))
      .filter((key) => endpointKeys.has(key));
    keys.slice(1).forEach((key) => union(keys[0], key));
  });

  const graphEdges = edges.map((edge, index) => ({
    ...edge,
    index,
    start: find(edge.startKey),
    end: find(edge.endKey),
  }));
  const incident = new Map();
  const addIncident = (node, edgeIndex) => {
    if (!incident.has(node)) incident.set(node, []);
    incident.get(node).push(edgeIndex);
  };
  graphEdges.forEach((edge) => {
    addIncident(edge.start, edge.index);
    addIncident(edge.end, edge.index);
  });

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
      const edge = graphEdges[edgeIndex];
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
        const parent = parentNode.get(cursor);
        treePath.unshift(oriented(graphEdges[treeEdgeIndex], parent));
        cursor = parent;
      }
      treePath.push(oriented(edge, node));
      cycles.push(treePath);
    });
  };

  incident.forEach((_edgesAtNode, node) => {
    if (visitedNodes.has(node)) return;
    depth.set(node, 0);
    visit(node);
  });
  return cycles;
}

// --- Resolved Boundary System ---
const EPSILON = 1e-7;
const clonePoint = (point) => [Number(point[0]), Number(point[1])];
const finitePoint = (point) => Array.isArray(point) && point.length >= 2
  && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]));
const closeEnough = (a, b, tolerance = EPSILON) => finitePoint(a) && finitePoint(b)
  && Math.hypot(Number(a[0]) - Number(b[0]), Number(a[1]) - Number(b[1])) <= tolerance;

function circleFromThreePoints(a, b, c) {
  if (![a, b, c].every(finitePoint)) return null;
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return null;
  const aa = a[0] ** 2 + a[1] ** 2;
  const bb = b[0] ** 2 + b[1] ** 2;
  const cc = c[0] ** 2 + c[1] ** 2;
  const center = [
    (aa * (b[1] - c[1]) + bb * (c[1] - a[1]) + cc * (a[1] - b[1])) / d,
    (aa * (c[0] - b[0]) + bb * (a[0] - c[0]) + cc * (b[0] - a[0])) / d,
  ];
  return { center, radius: Math.hypot(a[0] - center[0], a[1] - center[1]) };
}

function arcGeometry(entity) {
  if (finitePoint(entity.center) && Number.isFinite(Number(entity.radius))) {
    return { center: clonePoint(entity.center), radius: Math.abs(Number(entity.radius)) };
  }
  return circleFromThreePoints(entity.start, entity.arcPoint, entity.end);
}

function stableFeatureKey(boundaryId, sourceId, kind, index) {
  return `resolved:${boundaryId}:${sourceId}:${kind}:${Number(index) || 0}`;
}

function baseFeature(entity, boundaryId, kind, index = 0) {
  return {
    recordId: entity.id,
    sourceId: entity.id,
    targetId: boundaryId,
    entityType: entity.type,
    kind,
    index,
    sourceFeatureIndex: index,
    boundaryRole: 'outer',
    stableKey: stableFeatureKey(boundaryId, entity.id, kind, index),
  };
}

function segmentFeatures(entity, boundaryId, points) {
  return points.map((start, index) => ({
    ...baseFeature(entity, boundaryId, 'segment', index),
    parameterStart: 0,
    parameterEnd: 1,
    start: clonePoint(start),
    end: clonePoint(points[(index + 1) % points.length]),
  }));
}

export function resolvedBoundaryFeaturesForEntity(entity, boundaryId = entity?.id) {
  if (!entity?.id || entity.construction === true) return [];
  if (entity.type === 'line' && finitePoint(entity.start) && finitePoint(entity.end)) {
    const index = Number(entity.composite?.index) || 0;
    return [{
      ...baseFeature(entity, boundaryId, 'segment', index),
      parameterStart: 0,
      parameterEnd: 1,
      start: clonePoint(entity.start),
      end: clonePoint(entity.end),
    }];
  }
  if (entity.type === 'rect') {
    const x = Number(entity.x); const y = Number(entity.y);
    const width = Number(entity.width); const height = Number(entity.height);
    if (![x, y, width, height].every(Number.isFinite)) return [];
    return segmentFeatures(entity, boundaryId, [
      [x, y], [x + width, y], [x + width, y + height], [x, y + height],
    ]);
  }
  if (entity.type === 'polygon' && entity.points?.length >= 3) {
    return segmentFeatures(entity, boundaryId, entity.points.filter(finitePoint));
  }
  if (entity.type === 'polyline' && entity.points?.length >= 2) {
    return [{
      ...baseFeature(entity, boundaryId, 'polyline'),
      points: entity.points.filter(finitePoint).map(clonePoint),
    }];
  }
  if (entity.type === 'curve' && entity.points?.length >= 2) {
    return [{
      ...baseFeature(entity, boundaryId, 'curve'),
      points: entity.points.filter(finitePoint).map(clonePoint),
    }];
  }
  if (entity.type === 'circle' && finitePoint(entity.center) && Number.isFinite(Number(entity.radius))) {
    return [{
      ...baseFeature(entity, boundaryId, 'circle'),
      center: clonePoint(entity.center),
      radius: Math.abs(Number(entity.radius)),
    }];
  }
  if (entity.type === 'arc' && [entity.start, entity.arcPoint, entity.end].every(finitePoint)) {
    const circle = arcGeometry(entity);
    if (!circle) return [];
    return [{
      ...baseFeature(entity, boundaryId, 'arc'),
      center: circle.center,
      radius: circle.radius,
      start: clonePoint(entity.start),
      arcPoint: clonePoint(entity.arcPoint),
      end: clonePoint(entity.end),
      ...(typeof entity.ccw === 'boolean' ? { ccw: entity.ccw } : {}),
      ...(typeof entity.major === 'boolean' ? { major: entity.major } : {}),
    }];
  }
  return [];
}

export function reverseResolvedBoundaryFeature(feature) {
  if (feature.kind === 'circle') return { ...feature };
  if (feature.kind === 'curve' || feature.kind === 'polyline') {
    return { ...feature, points: [...feature.points].reverse().map(clonePoint) };
  }
  return {
    ...feature,
    start: clonePoint(feature.end),
    end: clonePoint(feature.start),
    ...(feature.kind === 'arc' ? { arcPoint: clonePoint(feature.arcPoint) } : {}),
    ...(feature.parameterStart !== undefined ? {
      parameterStart: feature.parameterEnd,
      parameterEnd: feature.parameterStart,
    } : {}),
  };
}

function arcCommand(feature) {
  const start = Math.atan2(feature.start[1] - feature.center[1], feature.start[0] - feature.center[0]);
  const middle = Math.atan2(feature.arcPoint[1] - feature.center[1], feature.arcPoint[0] - feature.center[0]);
  const end = Math.atan2(feature.end[1] - feature.center[1], feature.end[0] - feature.center[0]);
  const sweep = arcSweepFromAngles(start, end, middle, {
    major: typeof feature.major === 'boolean' ? feature.major : null,
    ccw: typeof feature.ccw === 'boolean' ? feature.ccw : null,
  });
  return `A ${feature.radius} ${feature.radius} 0 ${Math.abs(sweep.span) > Math.PI ? 1 : 0} ${sweep.ccw ? 1 : 0} ${feature.end[0]} ${feature.end[1]}`;
}

function curveCommands(points) {
  if (points.length < 2) return '';
  if (points.length === 2) return `L ${points[1][0]} ${points[1][1]}`;
  const controlPoint = (current, previous, next, tension = 0.18) => [
    current[0] + (next[0] - previous[0]) * tension,
    current[1] + (next[1] - previous[1]) * tension,
  ];
  return points.slice(1).map((point, index) => {
    const currentIndex = index + 1;
    const previous = points[Math.max(0, currentIndex - 2)];
    const current = points[currentIndex - 1];
    const after = points[Math.min(points.length - 1, currentIndex + 1)];
    const first = controlPoint(current, previous, point);
    const second = controlPoint(point, after, current);
    return `C ${first[0]} ${first[1]} ${second[0]} ${second[1]} ${point[0]} ${point[1]}`;
  }).join(' ');
}

function featureStart(feature) {
  if (feature.kind === 'circle') return [feature.center[0] + feature.radius, feature.center[1]];
  if (feature.kind === 'curve' || feature.kind === 'polyline') return feature.points[0];
  return feature.start;
}

function featureCommands(feature) {
  if (feature.kind === 'segment') return `L ${feature.end[0]} ${feature.end[1]}`;
  if (feature.kind === 'arc') return arcCommand(feature);
  if (feature.kind === 'polyline') return feature.points.slice(1).map((point) => `L ${point[0]} ${point[1]}`).join(' ');
  if (feature.kind === 'curve') return curveCommands(feature.points);
  return '';
}

export function resolvedBoundaryPath(features = []) {
  if (features.length === 1 && features[0].kind === 'circle') {
    const feature = features[0];
    const left = feature.center[0] - feature.radius;
    const right = feature.center[0] + feature.radius;
    const y = feature.center[1];
    return `M ${right} ${y} A ${feature.radius} ${feature.radius} 0 1 1 ${left} ${y} A ${feature.radius} ${feature.radius} 0 1 1 ${right} ${y} Z`;
  }
  const start = featureStart(features[0]);
  if (!finitePoint(start)) return '';
  return `M ${start[0]} ${start[1]} ${features.map(featureCommands).filter(Boolean).join(' ')} Z`;
}

function boundaryPolygon(features) {
  const points = [];
  features.forEach((feature, index) => {
    const sampled = sampleNotchFeature(feature);
    if (!sampled.length) return;
    points.push(...(index && closeEnough(points.at(-1), sampled[0]) ? sampled.slice(1) : sampled));
  });
  if (points.length > 1 && closeEnough(points[0], points.at(-1))) points.pop();
  return points.map(clonePoint);
}

function boundaryIdForCycle(cycle, byId) {
  const compositeIds = new Set(cycle
    .map(({ entityId }) => byId.get(entityId)?.composite?.id)
    .filter(Boolean));
  if (compositeIds.size === 1) return [...compositeIds][0];
  return `cycle:${cycle.map(({ entityId }) => entityId).sort().join('|')}`;
}

function boundaryFromFeatures(id, features, recordIds, byId, kind) {
  const polygon = boundaryPolygon(features);
  const appearanceSourceId = recordIds.find((recordId) => byId.has(recordId)) || features[0]?.recordId;
  const sourceEntity = byId.get(appearanceSourceId) || byId.get(features[0]?.recordId);
  return {
    id,
    kind,
    recordIds: [...new Set(recordIds)],
    appearanceSourceId,
    stackId: sourceEntity?.stackId || 'stack-default',
    features,
    polygon,
    points: polygon,
    d: resolvedBoundaryPath(features),
  };
}

export function resolveClosedBoundaries(entities = [], constraints = []) {
  const topologyEntities = closedGeometryTopologyEntities(entities);
  const drawable = topologyEntities.filter((entity) => entity.construction !== true);
  const fillets = drawable.filter((entity) => entity.type === 'fillet');
  const evaluated = evaluateFilletedGeometry(topologyEntities);
  const byId = new Map(evaluated.filter(({ id }) => id).map((entity) => [entity.id, entity]));
  const boundaries = [];

  findClosedGeometryCycles(
    evaluated,
    filletTopologyConstraints(constraints, fillets),
  ).forEach((cycle) => {
    const id = boundaryIdForCycle(cycle, byId);
    const features = cycle.flatMap(({ entityId, reversed }) => {
      const source = resolvedBoundaryFeaturesForEntity(byId.get(entityId), id);
      const oriented = reversed
        ? [...source].reverse().map(reverseResolvedBoundaryFeature)
        : source;
      return oriented;
    });
    if (!features.length) return;
    boundaries.push(boundaryFromFeatures(id, features, cycle.map(({ entityId }) => entityId), byId, 'cycle'));
  });

  evaluated
    .filter((entity) => entity.construction !== true && ['circle', 'rect', 'polygon'].includes(entity.type))
    .forEach((entity) => {
    const features = resolvedBoundaryFeaturesForEntity(entity, entity.id);
    if (!features.length) return;
    boundaries.push(boundaryFromFeatures(entity.id, features, [entity.id], byId, 'primitive'));
  });

  return boundaries.filter((boundary) => boundary.d && boundary.polygon.length >= 3);
}

export function resolveClosedBoundariesForRecordIds(entities = [], constraints = [], recordIds = []) {
  const requested = new Set(recordIds);
  if (!requested.size) return [];
  const scopedEntities = entities.filter((entity) => requested.has(entity?.id));
  const scopedConstraints = constraints.filter((constraint) => {
    const referencedIds = (constraint?.featureRefs || [])
      .map((feature) => feature?.recordId)
      .filter((recordId) => recordId && recordId !== CANVAS_ORIGIN_RECORD_ID);
    return referencedIds.length > 0 && referencedIds.every((recordId) => requested.has(recordId));
  });
  return resolveClosedBoundaries(scopedEntities, scopedConstraints);
}

export function resolvedBoundaryForHost(boundaries = [], host = {}) {
  if (!host?.recordId) return null;
  return boundaries.find((boundary) => (
    boundary.recordIds.includes(host.recordId)
    || boundary.features.some((feature) => feature.sourceId === host.recordId)
  )) || null;
}
