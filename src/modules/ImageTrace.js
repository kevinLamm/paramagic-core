let openCvPromise = null;
const DEFAULT_OPEN_CV_RESOURCES = Object.freeze({ scriptUrl: '' });
let openCvResources = DEFAULT_OPEN_CV_RESOURCES;

function absoluteOpenCvUrl(value) {
  return new URL(String(value), globalThis.location?.href || 'http://localhost/').href;
}

export function configureOpenCvResources(configuration = null) {
  if (configuration == null) {
    openCvResources = DEFAULT_OPEN_CV_RESOURCES;
    openCvPromise = null;
    return { ...openCvResources };
  }
  const scriptUrl = String(configuration.scriptUrl || '').trim();
  if (!scriptUrl) throw new Error('OpenCV resources require a scriptUrl.');
  openCvResources = Object.freeze({ scriptUrl: absoluteOpenCvUrl(scriptUrl) });
  openCvPromise = null;
  return { ...openCvResources };
}

export function getOpenCvResourceConfiguration() {
  return { ...openCvResources };
}

export async function loadOpenCv() {
  if (globalThis.cv?.Mat) return globalThis.cv;
  if (openCvPromise) return openCvPromise;
  if (!openCvResources.scriptUrl) throw new Error('OpenCV.js is not configured by the host application.');
  openCvPromise = new Promise((resolve, reject) => {
    if (typeof document === 'undefined' || !document.head) {
      reject(new Error('OpenCV.js is only available in the browser.'));
      return;
    }
    const script = document.createElement('script');
    script.async = true;
    script.src = openCvResources.scriptUrl;
    script.onload = async () => {
      try {
        if (globalThis.cv?.then) globalThis.cv = await globalThis.cv;
        if (globalThis.cv?.Mat) resolve(globalThis.cv);
        else if (globalThis.cv) globalThis.cv.onRuntimeInitialized = () => resolve(globalThis.cv);
        else reject(new Error('OpenCV.js loaded but did not expose cv.'));
      } catch (error) {
        reject(error);
      }
    };
    script.onerror = () => reject(new Error('Could not load OpenCV.js.'));
    document.head.appendChild(script);
  });
  return openCvPromise;
}

const defaultSettings = Object.freeze({ tolerance: 24, detail: 8, smoothing: 1 });
const minimumRegionPixels = 12;
const maximumPolygonPoints = 240;

const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

function rotatePoint([x, y], degrees) {
  const angle = degrees * Math.PI / 180;
  return [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)];
}

export function normalizeImageTraceSettings(input = {}) {
  return {
    tolerance: clamp(Math.round(finite(input.tolerance, defaultSettings.tolerance)), 0, 100),
    detail: clamp(Math.round(finite(input.detail, defaultSettings.detail)), 1, 10),
    smoothing: clamp(Math.round(finite(input.smoothing, defaultSettings.smoothing)), 0, 10),
  };
}

export function imageWorldToLocalPoint(entity, worldPoint) {
  const translated = [worldPoint[0] - entity.x, worldPoint[1] - entity.y];
  const rotated = rotatePoint(translated, -finite(entity.rotation, 0));
  return [rotated[0] * (entity.flipX ? -1 : 1), rotated[1] * (entity.flipY ? -1 : 1)];
}

export function imageLocalToWorldPoint(entity, localPoint) {
  const flipped = [localPoint[0] * (entity.flipX ? -1 : 1), localPoint[1] * (entity.flipY ? -1 : 1)];
  const rotated = rotatePoint(flipped, finite(entity.rotation, 0));
  return [rotated[0] + entity.x, rotated[1] + entity.y];
}

export function imagePixelToLocalPoint(entity, pixelPoint, naturalWidth, naturalHeight) {
  const widthDivisor = Math.max(1, naturalWidth - 1);
  const heightDivisor = Math.max(1, naturalHeight - 1);
  return [
    (pixelPoint[0] / widthDivisor - 0.5) * entity.width,
    (pixelPoint[1] / heightDivisor - 0.5) * entity.height,
  ];
}

export function imageWorldToPixelPoint(entity, worldPoint, naturalWidth, naturalHeight) {
  const local = imageWorldToLocalPoint(entity, worldPoint);
  return [
    clamp(Math.round((local[0] / entity.width + 0.5) * Math.max(1, naturalWidth - 1)), 0, naturalWidth - 1),
    clamp(Math.round((local[1] / entity.height + 0.5) * Math.max(1, naturalHeight - 1)), 0, naturalHeight - 1),
  ];
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The image could not be loaded for tracing.'));
    image.src = source;
  });
}

export async function prepareImageTrace(entity) {
  if (typeof document === 'undefined') throw new Error('Image tracing is only available in the browser.');
  const image = await loadImage(entity.source);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  let imageData;
  try {
    imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    throw new Error('This image source does not permit pixel tracing.');
  }
  return {
    source: entity.source,
    canvas,
    imageData,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
  };
}

function approximateContour(cv, contour, detail) {
  const perimeter = cv.arcLength(contour, true);
  let epsilon = perimeter * (0.001 + (10 - detail) * 0.0015);
  let approximation = new cv.Mat();
  cv.approxPolyDP(contour, approximation, epsilon, true);
  while (approximation.rows > maximumPolygonPoints) {
    approximation.delete();
    epsilon *= 1.5;
    approximation = new cv.Mat();
    cv.approxPolyDP(contour, approximation, epsilon, true);
  }
  return approximation;
}

function contourPoints(approximation) {
  const points = [];
  for (let index = 0; index < approximation.rows; index += 1) {
    const point = [approximation.data32S[index * 2], approximation.data32S[index * 2 + 1]];
    const prior = points[points.length - 1];
    if (!prior || prior[0] !== point[0] || prior[1] !== point[1]) points.push(point);
  }
  if (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) points.pop();
  }
  return points;
}

export async function tracePreparedImageRegion(prepared, entity, worldPoint, inputSettings = {}) {
  const settings = normalizeImageTraceSettings(inputSettings);
  const cv = await loadOpenCv();
  const seedPixel = imageWorldToPixelPoint(entity, worldPoint, prepared.naturalWidth, prepared.naturalHeight);
  const alphaIndex = (seedPixel[1] * prepared.naturalWidth + seedPixel[0]) * 4 + 3;
  if (prepared.imageData.data[alphaIndex] < 8) throw new Error('Pick an opaque point inside the object to trace.');
  const colorIndex = alphaIndex - 3;
  const seedColor = [
    prepared.imageData.data[colorIndex],
    prepared.imageData.data[colorIndex + 1],
    prepared.imageData.data[colorIndex + 2],
  ];

  const src = cv.imread(prepared.canvas);
  const rgb = new cv.Mat();
  const lowerBound = new cv.Mat();
  const upperBound = new cv.Mat();
  const candidateMask = new cv.Mat();
  const labels = new cv.Mat();
  const regionMask = cv.Mat.zeros(src.rows, src.cols, cv.CV_8UC1);
  let kernel = null;
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let chosenContour = null;
  let approximation = null;
  try {
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    lowerBound.create(src.rows, src.cols, rgb.type());
    lowerBound.setTo(new cv.Scalar(
      Math.max(0, seedColor[0] - settings.tolerance),
      Math.max(0, seedColor[1] - settings.tolerance),
      Math.max(0, seedColor[2] - settings.tolerance),
      0,
    ));
    upperBound.create(src.rows, src.cols, rgb.type());
    upperBound.setTo(new cv.Scalar(
      Math.min(255, seedColor[0] + settings.tolerance),
      Math.min(255, seedColor[1] + settings.tolerance),
      Math.min(255, seedColor[2] + settings.tolerance),
      255,
    ));
    cv.inRange(rgb, lowerBound, upperBound, candidateMask);
    cv.connectedComponents(candidateMask, labels, 8, cv.CV_32S);
    const seedLabel = labels.data32S[seedPixel[1] * labels.cols + seedPixel[0]];
    if (!seedLabel) throw new Error('No traceable color region was found at that point.');
    for (let index = 0; index < labels.data32S.length; index += 1) {
      regionMask.data[index] = labels.data32S[index] === seedLabel ? 255 : 0;
    }

    if (settings.smoothing > 0) {
      const kernelSize = settings.smoothing * 2 + 1;
      kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kernelSize, kernelSize));
      cv.morphologyEx(regionMask, regionMask, cv.MORPH_CLOSE, kernel);
      cv.morphologyEx(regionMask, regionMask, cv.MORPH_OPEN, kernel);
    }
    if (cv.countNonZero(regionMask) < minimumRegionPixels) {
      throw new Error('The selected region is too small to create a closed polygon.');
    }

    cv.findContours(regionMask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
    let chosenArea = 0;
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index);
      const area = Math.abs(cv.contourArea(contour));
      const containsSeed = cv.pointPolygonTest(contour, new cv.Point(seedPixel[0], seedPixel[1]), false) >= 0;
      if (containsSeed && area > chosenArea) {
        chosenContour?.delete();
        chosenContour = contour.clone();
        chosenArea = area;
      }
      contour.delete();
    }
    if (!chosenContour || chosenArea < minimumRegionPixels) {
      throw new Error('No closed edge was found around the selected point.');
    }

    approximation = approximateContour(cv, chosenContour, settings.detail);
    const pixelPoints = contourPoints(approximation);
    if (pixelPoints.length < 3) throw new Error('The detected edge could not form a closed polygon.');
    const localPoints = pixelPoints.map((point) => imagePixelToLocalPoint(
      entity,
      point,
      prepared.naturalWidth,
      prepared.naturalHeight,
    ));
    return {
      settings,
      seedPixel,
      pixelPoints,
      localPoints,
      worldPoints: localPoints.map((point) => imageLocalToWorldPoint(entity, point)),
      areaPixels: chosenArea,
    };
  } finally {
    approximation?.delete();
    chosenContour?.delete();
    hierarchy.delete();
    contours.delete();
    kernel?.delete();
    regionMask.delete();
    labels.delete();
    candidateMask.delete();
    upperBound.delete();
    lowerBound.delete();
    rgb.delete();
    src.delete();
  }
}
