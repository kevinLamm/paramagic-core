import {
  evaluateFilletedGeometry,
  filletTopologyConstraints,
} from './FilletSystem.js';
import { sampleNotchFeature } from './NotchSystem.js';
import { arcSweepFromAngles } from './ArcGeometry.js';
import { deriveUuidForKey } from './IdentitySystem.js';

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
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
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

  constraints.forEach((constraint) => {
    if (constraint.enabled === false || constraint.type !== 'Coincident') return;
    const keys = (constraint.featureRefs || [])
      .filter((ref) => ref.kind === 'point')
      .map((ref) => endpointKey(ref.recordId, ref.index || 0))
      .filter((key) => endpointKeys.has(key));
    keys.slice(1).forEach((key) => union(keys[0], key));
  });

  const graphEdges = edges.map((edge) => ({
    ...edge,
    start: find(edge.startKey),
    end: find(edge.endKey),
  }));
  // A declared closed object owns its boundary even when another object
  // touches it or has an overlapping edge. Coordinate joins do not transfer
  // that ownership. Incomplete objects still participate in inferred faces.
  const compositeGroups = new Map();
  graphEdges.forEach((edge) => {
    const composite = byId.get(edge.entityId)?.composite;
    if (!composite?.closed || !composite.id) return;
    if (!compositeGroups.has(composite.id)) compositeGroups.set(composite.id, []);
    compositeGroups.get(composite.id).push(edge);
  });
  const cycles = [];
  const owned = new Set();
  const filletEdges = graphEdges.filter((edge) => byId.get(edge.entityId)?.derivedFromFillet);
  compositeGroups.forEach((group) => {
    const count = byId.get(group[0].entityId).composite.count;
    if (!count || group.length !== count) return;
    const nodes = new Set(group.flatMap((edge) => [edge.start, edge.end]));
    const members = [...group, ...filletEdges.filter((edge) => nodes.has(edge.start) && nodes.has(edge.end))];
    const faces = boundedGeometryFaces(members, byId);
    if (faces.length !== 1 || faces[0].length !== members.length) return;
    cycles.push(faces[0]);
    members.forEach((edge) => owned.add(edge.entityId));
  });
  return [...cycles, ...boundedGeometryFaces(graphEdges.filter((edge) => !owned.has(edge.entityId)), byId)];
}

// Order outgoing half-edges by the actual geometry at the junction. The
// endpoint chord alone cannot distinguish arcs or curves with common ends.
function boundaryDeparture(feature, sampled) {
  const start = sampled[0];
  const next = sampled.slice(1).find((point) => !closeEnough(start, point));
  if (!next) return { angle: 0, curvature: 0 };
  let tangent = [next[0] - start[0], next[1] - start[1]];
  let curvature = 0;
  if (feature.kind === 'arc') {
    const a = Math.atan2(feature.start[1] - feature.center[1], feature.start[0] - feature.center[0]);
    const b = Math.atan2(feature.end[1] - feature.center[1], feature.end[0] - feature.center[0]);
    const m = Math.atan2(feature.arcPoint[1] - feature.center[1], feature.arcPoint[0] - feature.center[0]);
    const direction = arcSweepFromAngles(a, b, m).ccw ? 1 : -1;
    tangent = [-Math.sin(a) * direction, Math.cos(a) * direction];
    curvature = direction / feature.radius;
  } else if (feature.kind === 'curve' && feature.points.length > 2) {
    const [p, q, r] = feature.points;
    const first = [(q[0] - p[0]) * 0.54, (q[1] - p[1]) * 0.54];
    const second = [0, 1].map((i) => 6 * (0.64 * (q[i] - p[i]) - 0.18 * (r[i] - p[i])));
    const length = Math.hypot(...first);
    if (length > EPSILON) {
      tangent = first;
      curvature = (first[0] * second[1] - first[1] * second[0]) / length ** 3;
    }
  }
  const tau = Math.PI * 2;
  let angle = (Math.atan2(tangent[1], tangent[0]) + tau) % tau;
  if (angle < 1e-10 || tau - angle < 1e-10) angle = 0;
  return { angle, curvature };
}

function signedBoundaryArea(points) {
  if (!points.length) return 0;
  // Translate before summing to retain precision far from the origin.
  const [x, y] = points[0];
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + (point[0] - x) * (next[1] - y) - (next[0] - x) * (point[1] - y);
  }, 0) / 2;
}

function boundedGeometryFaces(edges, byId) {
  const outgoing = new Map();
  const halfEdges = [];
  edges.forEach((edge) => {
    const feature = resolvedBoundaryFeaturesForEntity(byId.get(edge.entityId))[0];
    if (!feature) return;
    const points = sampleNotchFeature(feature);
    if (points.length < 2) return;
    const pair = [false, true].map((reversed) => {
      const samples = reversed ? [...points].reverse() : points;
      return {
        entityId: edge.entityId, reversed,
        from: reversed ? edge.end : edge.start,
        to: reversed ? edge.start : edge.end,
        points: samples,
        ...boundaryDeparture(reversed ? reverseResolvedBoundaryFeature(feature) : feature, samples),
      };
    });
    pair.forEach((halfEdge, index) => {
      halfEdge.twin = pair[1 - index];
      if (!outgoing.has(halfEdge.from)) outgoing.set(halfEdge.from, []);
      outgoing.get(halfEdge.from).push(halfEdge);
      halfEdges.push(halfEdge);
    });
  });
  outgoing.forEach((incident) => {
    incident.sort((a, b) => (Math.abs(a.angle - b.angle) > 1e-10 ? a.angle - b.angle
      : a.curvature - b.curvature || a.entityId.localeCompare(b.entityId) || Number(a.reversed) - Number(b.reversed)));
    incident.forEach((edge, index) => { edge.position = index; });
  });
  halfEdges.forEach((edge) => {
    const incident = outgoing.get(edge.to);
    edge.next = incident[(edge.twin.position + incident.length - 1) % incident.length];
  });
  const visited = new Set();
  const faces = [];
  const addFace = (boundary) => {
    if (!boundary.length || signedBoundaryArea(boundary.flatMap((edge) => edge.points)) <= EPSILON ** 2) return;
    const memberIndex = (edge) => {
      const composite = byId.get(edge.entityId)?.composite;
      return composite?.closed ? Number(composite.index) || 0 : Infinity;
    };
    const first = boundary.reduce((best, edge, index) => (
      (memberIndex(edge) - memberIndex(boundary[best]) || edge.entityId.localeCompare(boundary[best].entityId)) < 0 ? index : best
    ), 0);
    faces.push([...boundary.slice(first), ...boundary.slice(0, first)]
      .map(({ entityId, reversed }) => ({ entityId, reversed })));
  };
  halfEdges.forEach((start) => {
    if (visited.has(start)) return;
    const walk = [];
    let cursor = start;
    while (!visited.has(cursor)) {
      visited.add(cursor);
      walk.push(cursor);
      cursor = cursor.next;
    }
    if (cursor !== start) return;
    // Split repeated junctions into continuous contours. This discards
    // zero-area out-and-back bridges without concatenating separate loops
    // (for example an inner outline connected to an outer one by a branch).
    const path = [];
    const positions = new Map([[start.from, 0]]);
    walk.forEach((edge) => {
      path.push(edge);
      if (positions.has(edge.to)) {
        const contour = path.splice(positions.get(edge.to));
        contour.forEach((member) => positions.delete(member.from));
        addFace(contour);
      }
      positions.set(edge.to, path.length);
    });
  });
  return faces;
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
  const entities = cycle.map(({ entityId }) => byId.get(entityId));
  const composite = entities.find((entity) => entity?.composite?.closed)?.composite;
  if (composite?.id && entities.every((entity) => (
    entity?.composite?.id === composite.id || entity?.derivedFromFillet
  )) && entities.filter((entity) => entity?.composite?.id === composite.id).length === composite.count) {
    return composite.id;
  }
  const memberIds = cycle.map(({ entityId }) => entityId).sort();
  return deriveUuidForKey('boundary-cycle', ...memberIds);
}

function boundaryFromFeatures(id, features, recordIds, byId, kind, membership = new Map()) {
  const polygon = boundaryPolygon(features);
  // Prefer the object's first declared member, then an edge belonging only
  // to this face. Keep the choice stable when drawing/z order changes.
  const appearanceSourceId = [...recordIds].filter((recordId) => byId.has(recordId)).sort((a, b) => {
    const first = byId.get(a).composite;
    const second = byId.get(b).composite;
    const rank = (composite) => composite?.id === id ? Number(composite.index) || 0 : Infinity;
    return rank(first) - rank(second)
      || (membership.get(a) || 1) - (membership.get(b) || 1)
      || a.localeCompare(b);
  })[0] || features[0]?.recordId;
  const sourceEntity = byId.get(appearanceSourceId) || byId.get(features[0]?.recordId);
  return {
    id,
    kind,
    recordIds: [...new Set(recordIds)],
    appearanceSourceId,
    stackId: sourceEntity?.stackId || null,
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

  const cycles = findClosedGeometryCycles(
    evaluated,
    filletTopologyConstraints(constraints, fillets),
  );
  const membership = new Map();
  cycles.forEach((cycle) => cycle.forEach(({ entityId }) => {
    membership.set(entityId, (membership.get(entityId) || 0) + 1);
  }));
  cycles.forEach((cycle) => {
    const id = boundaryIdForCycle(cycle, byId);
    const features = cycle.flatMap(({ entityId, reversed }) => {
      const source = resolvedBoundaryFeaturesForEntity(byId.get(entityId), id);
      const oriented = reversed
        ? [...source].reverse().map(reverseResolvedBoundaryFeature)
        : source;
      return oriented;
    });
    if (!features.length) return;
    boundaries.push(boundaryFromFeatures(id, features, cycle.map(({ entityId }) => entityId), byId, 'cycle', membership));
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
      .filter(Boolean);
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
