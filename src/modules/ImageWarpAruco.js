import { loadOpenCv } from './ImageTrace.js';

export const ARUCO_WARP_DICTIONARY = 'DICT_4X4_50';
export const ARUCO_WARP_REQUIRED_IDS = Object.freeze([0, 1, 2, 3]);

const finitePoint = (point) => (
  Array.isArray(point)
  && point.length >= 2
  && Number.isFinite(Number(point[0]))
  && Number.isFinite(Number(point[1]))
);

function polygonArea(points) {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;
}

function isConvexQuad(points) {
  if (points.length !== 4 || Math.abs(polygonArea(points)) < 1e-6) return false;
  let sign = 0;
  for (let index = 0; index < 4; index += 1) {
    const first = points[index];
    const second = points[(index + 1) % 4];
    const third = points[(index + 2) % 4];
    const turn = (second[0] - first[0]) * (third[1] - second[1])
      - (second[1] - first[1]) * (third[0] - second[0]);
    if (Math.abs(turn) < 1e-6) return false;
    if (sign && Math.sign(turn) !== sign) return false;
    sign = Math.sign(turn);
  }
  return true;
}

export function arucoMarkerCenter(corners) {
  if (!Array.isArray(corners) || corners.length !== 4 || !corners.every(finitePoint)) return null;
  return corners.reduce((center, point) => [center[0] + Number(point[0]) / 4, center[1] + Number(point[1]) / 4], [0, 0]);
}

export function orderArucoWarpMarkers(markers = []) {
  if (!Array.isArray(markers) || markers.length !== 4 || markers.some((marker) => !finitePoint(marker?.center))) return null;
  const centroid = markers.reduce((center, marker) => [
    center[0] + Number(marker.center[0]) / 4,
    center[1] + Number(marker.center[1]) / 4,
  ], [0, 0]);
  let ordered = markers
    .map((marker) => ({ ...marker, center: [Number(marker.center[0]), Number(marker.center[1])] }))
    .sort((first, second) => (
      Math.atan2(first.center[1] - centroid[1], first.center[0] - centroid[0])
      - Math.atan2(second.center[1] - centroid[1], second.center[0] - centroid[0])
    ));
  if (polygonArea(ordered.map(({ center }) => center)) < 0) ordered = ordered.reverse();
  const startIndex = ordered.reduce((bestIndex, marker, index) => {
    const score = marker.center[0] + marker.center[1];
    const best = ordered[bestIndex];
    const bestScore = best.center[0] + best.center[1];
    return score < bestScore || (score === bestScore && marker.center[0] < best.center[0]) ? index : bestIndex;
  }, 0);
  ordered = [...ordered.slice(startIndex), ...ordered.slice(0, startIndex)];
  return isConvexQuad(ordered.map(({ center }) => center)) ? ordered : null;
}

export function classifyArucoWarpMarkers(markers = [], requiredIds = ARUCO_WARP_REQUIRED_IDS) {
  const normalized = (Array.isArray(markers) ? markers : [])
    .filter((marker) => Number.isInteger(Number(marker?.id)) && finitePoint(marker?.center))
    .map((marker) => ({
      ...marker,
      id: Number(marker.id),
      center: [Number(marker.center[0]), Number(marker.center[1])],
    }));
  const detectedIds = [...new Set(normalized.map(({ id }) => id))].sort((a, b) => a - b);
  const missingIds = requiredIds.filter((id) => !detectedIds.includes(id));
  const duplicateIds = requiredIds.filter((id) => normalized.filter((marker) => marker.id === id).length > 1);
  const extraIds = detectedIds.filter((id) => !requiredIds.includes(id));
  const requiredMarkers = requiredIds.flatMap((id) => normalized.filter((marker) => marker.id === id));
  if (!normalized.length) {
    return { state: 'none', markers: normalized, orderedMarkers: [], points: [], detectedIds, missingIds, duplicateIds, extraIds };
  }
  if (missingIds.length || duplicateIds.length || requiredMarkers.length !== requiredIds.length) {
    return { state: 'partial', markers: normalized, orderedMarkers: [], points: [], detectedIds, missingIds, duplicateIds, extraIds };
  }
  const orderedMarkers = orderArucoWarpMarkers(requiredMarkers);
  if (!orderedMarkers) {
    return { state: 'invalid', markers: normalized, orderedMarkers: [], points: [], detectedIds, missingIds, duplicateIds, extraIds };
  }
  return {
    state: 'complete',
    markers: normalized,
    orderedMarkers,
    points: orderedMarkers.map(({ center }) => [...center]),
    detectedIds,
    missingIds,
    duplicateIds,
    extraIds,
  };
}

function matCornerPoints(cornerMat) {
  const values = cornerMat?.data32F || cornerMat?.data64F || [];
  const points = [];
  for (let index = 0; index + 1 < values.length && points.length < 4; index += 2) {
    points.push([Number(values[index]), Number(values[index + 1])]);
  }
  return points;
}

export function detectArucoMarkersInMat(cv, imageMat) {
  if (!cv?.aruco_ArucoDetector || !cv?.aruco_DetectorParameters || !cv?.getPredefinedDictionary) {
    throw new Error('This OpenCV.js build does not include ArUCo marker detection.');
  }
  const dictionaryType = cv[ARUCO_WARP_DICTIONARY];
  if (!Number.isInteger(dictionaryType)) throw new Error(`OpenCV.js does not expose ${ARUCO_WARP_DICTIONARY}.`);
  const dictionary = cv.getPredefinedDictionary(dictionaryType);
  const parameters = new cv.aruco_DetectorParameters();
  parameters.cornerRefinementMethod = cv.CORNER_REFINE_SUBPIX;
  const refineParameters = new cv.aruco_RefineParameters(10, 3, true);
  const detector = new cv.aruco_ArucoDetector(dictionary, parameters, refineParameters);
  const corners = new cv.MatVector();
  const ids = new cv.Mat();
  const rejected = new cv.MatVector();
  try {
    detector.detectMarkers(imageMat, corners, ids, rejected);
    const markers = [];
    const markerCount = ids.rows * ids.cols;
    for (let index = 0; index < markerCount; index += 1) {
      const cornerMat = corners.get(index);
      const markerCorners = matCornerPoints(cornerMat);
      cornerMat.delete();
      const center = arucoMarkerCenter(markerCorners);
      if (center) markers.push({ id: Number(ids.data32S[index]), corners: markerCorners, center });
    }
    return { markers, rejectedCount: rejected.size() };
  } finally {
    corners.delete();
    ids.delete();
    rejected.delete();
    detector.delete?.();
    refineParameters.delete?.();
    parameters.delete?.();
    dictionary.delete?.();
  }
}

function loadDetectionImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load the image for ArUCo marker detection.'));
    image.src = source;
  });
}

function pixelToImageLocal(point, rasterWidth, rasterHeight, displayWidth, displayHeight) {
  return [
    point[0] / rasterWidth * displayWidth - displayWidth / 2,
    point[1] / rasterHeight * displayHeight - displayHeight / 2,
  ];
}

export async function detectImageWarpMarkers(entity) {
  const source = String(entity?.warp?.source || entity?.source || '');
  if (!source) throw new Error('The image has no source data for marker detection.');
  const [cv, image] = await Promise.all([loadOpenCv(), loadDetectionImage(source)]);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext('2d').drawImage(image, 0, 0);
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const detected = detectArucoMarkersInMat(cv, gray);
    const displayWidth = Number(entity.width) || image.naturalWidth;
    const displayHeight = Number(entity.height) || image.naturalHeight;
    const localMarkers = detected.markers.map((marker) => ({
      ...marker,
      rasterCorners: marker.corners.map((point) => [...point]),
      rasterCenter: [...marker.center],
      corners: marker.corners.map((point) => pixelToImageLocal(point, image.naturalWidth, image.naturalHeight, displayWidth, displayHeight)),
      center: pixelToImageLocal(marker.center, image.naturalWidth, image.naturalHeight, displayWidth, displayHeight),
    }));
    return {
      ...classifyArucoWarpMarkers(localMarkers),
      rejectedCount: detected.rejectedCount,
      rasterWidth: image.naturalWidth,
      rasterHeight: image.naturalHeight,
    };
  } finally {
    src.delete();
    gray.delete();
  }
}
