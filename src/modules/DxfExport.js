import {
  boundaryFeaturesToDxfSegments,
  drawingCurveToDxfSegments,
  DXF_BOUNDARY_ENTITY_TYPE,
  DXF_CURVE_TOLERANCE,
  transformDxfBoundary,
} from './DxfExportGeometry.js';
import { normalizeDrawingData, resolveDrawingScene } from './DrawingIO.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
const finitePoint = (value) => Array.isArray(value) && value.length >= 2
  && value.slice(0, 2).every(Number.isFinite);
const closeEnough = (a, b, tolerance = 1e-6) => finitePoint(a) && finitePoint(b)
  && Math.hypot(a[0] - b[0], a[1] - b[1]) <= tolerance;

function transformPoint(point, matrix) {
  if (!matrix || !finitePoint(point)) return Array.isArray(point) ? [...point] : point;
  return [
    matrix.a * point[0] + matrix.c * point[1] + matrix.e,
    matrix.b * point[0] + matrix.d * point[1] + matrix.f,
  ];
}

function sceneSourceIds(entity) {
  return [...new Set([
    ...(entity?._resolvedSourceIds || []),
    entity?._resolvedSourceId,
    entity?.id,
  ].filter(Boolean).map(String))];
}

function sceneEntityBase(entity, id) {
  return {
    id,
    stackId: entity.stackId || 'stack-default',
    sourceIds: sceneSourceIds(entity),
    appearance: clone(entity.appearance || {}),
    ...(entity.construction === true ? { construction: true } : {}),
    ...(entity.composite ? { composite: clone(entity.composite) } : {}),
  };
}

function circleFromFeature(entity, feature, id) {
  const matrix = entity._resolvedMatrix;
  return {
    ...sceneEntityBase(entity, id),
    type: 'circle',
    center: transformPoint(feature.center, matrix),
    radius: Math.abs(Number(feature.radius)),
  };
}

function boundaryFromFeatures(entity, features, id, {
  closed = true,
  curveTolerance = DXF_CURVE_TOLERANCE,
} = {}) {
  if (
    entity.type !== 'subtract-result'
    && closed
    && features.length === 1
    && features[0].kind === 'circle'
  ) {
    return circleFromFeature(entity, features[0], id);
  }
  const segments = boundaryFeaturesToDxfSegments(features, { curveTolerance });
  if (!segments.length) return null;
  const boundary = {
    ...sceneEntityBase(entity, id),
    type: DXF_BOUNDARY_ENTITY_TYPE,
    closed,
    segments,
    ...(entity.type === 'subtract-result' ? { booleanResult: true } : {}),
  };
  return entity._resolvedMatrix
    ? transformDxfBoundary(boundary, (point) => transformPoint(point, entity._resolvedMatrix))
    : boundary;
}

function transformedEntity(entity, id) {
  const matrix = entity._resolvedMatrix;
  const result = { ...clone(entity), id };
  delete result._resolvedMatrix;
  delete result._resolvedSourceId;
  delete result._resolvedSourceIds;
  delete result._resolvedFeatures;
  delete result._resolvedContours;
  delete result._resolvedTolerance;
  if (!matrix) return result;
  if (result.type === 'line') {
    result.start = transformPoint(result.start, matrix);
    result.end = transformPoint(result.end, matrix);
  } else if (result.type === 'circle') {
    result.center = transformPoint(result.center, matrix);
  } else if (result.type === 'arc') {
    result.start = transformPoint(result.start, matrix);
    result.arcPoint = transformPoint(result.arcPoint, matrix);
    result.end = transformPoint(result.end, matrix);
    if (finitePoint(result.center)) result.center = transformPoint(result.center, matrix);
  } else if (result.type === 'notch') {
    result.point = transformPoint(result.point, matrix);
    result.end = transformPoint(result.end, matrix);
  } else if (result.type === 'text') {
    [result.x, result.y] = transformPoint([result.x, result.y], matrix);
    const rotation = Math.atan2(matrix.b, matrix.a) * 180 / Math.PI;
    result.rotation = Number(result.rotation || 0) + rotation;
  } else if (['polygon', 'polyline', 'curve'].includes(result.type)) {
    result.points = (result.points || []).map((point) => transformPoint(point, matrix));
  }
  return result;
}

function polylineBoundary(entity, id, curveTolerance) {
  const points = (entity.points || []).filter(finitePoint);
  const closed = entity.type === 'polygon'
    || (points.length >= 4 && closeEnough(points[0], points.at(-1)));
  if (!closed) return null;
  const usable = closeEnough(points[0], points.at(-1)) ? points.slice(0, -1) : points;
  if (usable.length < 3) return null;
  const features = usable.map((start, index) => ({
    kind: 'segment',
    start,
    end: usable[(index + 1) % usable.length],
  }));
  return boundaryFromFeatures(entity, features, id, { curveTolerance });
}

function sceneEntityToDxfGeometry(entity, index, {
  curveTolerance = DXF_CURVE_TOLERANCE,
} = {}) {
  const id = `resolved-dxf-${index}`;
  if (entity.type === 'resolved-boundary') {
    const boundary = boundaryFromFeatures(
      entity,
      entity._resolvedFeatures || [],
      id,
      { curveTolerance },
    );
    return boundary ? [boundary] : [];
  }
  if (entity.type === 'subtract-result') {
    return (entity._resolvedContours || [])
      .filter((contour) => contour.closed && contour.features?.length)
      .map((contour, contourIndex) => boundaryFromFeatures(
        entity,
        contour.features,
        `${id}:${contourIndex}`,
        { curveTolerance },
      ))
      .filter(Boolean);
  }
  if (entity.type === 'curve') {
    const transformed = transformedEntity(entity, id);
    const segments = drawingCurveToDxfSegments(transformed.points, curveTolerance);
    return segments.length ? [{
      ...sceneEntityBase(transformed, id),
      type: DXF_BOUNDARY_ENTITY_TYPE,
      closed: false,
      segments,
    }] : [];
  }
  if (entity.type === 'polygon' || entity.type === 'polyline') {
    const transformed = transformedEntity(entity, id);
    const boundary = polylineBoundary(transformed, id, curveTolerance);
    return boundary ? [boundary] : [transformed];
  }
  if (['image', 'control', 'point', 'fillet'].includes(entity.type)) return [];
  return [transformedEntity(entity, id)];
}

export function resolvedSceneDxfGeometry(scene, options = {}) {
  return (scene?.entities || []).flatMap((entity, index) => (
    sceneEntityToDxfGeometry(entity, index, options)
  ));
}

function resolvedSnapshot(snapshotInput, {
  stackId = null,
  evaluateNumeric = null,
  evaluateLength = null,
  evaluateExpression = null,
  curveTolerance = DXF_CURVE_TOLERANCE,
} = {}) {
  const drawing = normalizeDrawingData(snapshotInput);
  const scene = resolveDrawingScene(drawing, {
    stackId,
    evaluateNumeric,
    evaluateLength,
    evaluateExpression,
  });
  return {
    ...drawing,
    entities: resolvedSceneDxfGeometry(scene, { curveTolerance }),
    dimensionAnnotations: scene.dimensionAnnotations,
  };
}

export function createStackDxfSnapshot(snapshotInput, stackId, options = {}) {
  const snapshot = resolvedSnapshot(snapshotInput, { ...options, stackId });
  return {
    ...snapshot,
    entities: snapshot.entities.map((entity, index) => ({
      ...entity,
      id: `dxf-${stackId}-${index}`,
    })),
  };
}

export function createDrawingDxfSnapshot(snapshotInput, options = {}) {
  return resolvedSnapshot(snapshotInput, options);
}
