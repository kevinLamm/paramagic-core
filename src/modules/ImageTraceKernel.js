import { normalizeImageTraceSettings } from './ImageTrace.js';

// OpenCV's existing WASM kernels. Each stage owns its cached output; a cancelled
// request may leave completed stages ready for the next request, never a partial
// stage marked valid. No image-sized JavaScript loop runs here.
export class ImageTraceKernel {
  constructor(cv) {
    this.cv = cv;
    this.stats = { uploads: 0, segmentations: 0, masks: 0, smoothings: 0, contourExtractions: 0, selections: 0, approximations: 0 };
    this.owned = [];
    const mat = () => { const value = new cv.Mat(); this.owned.push(value); return value; };
    try {
      for (const name of ['src', 'rgb', 'candidate', 'labels', 'rawMask', 'regionMask', 'hierarchy', 'chosen', 'approximation']) this[name] = mat();
      this.contours = new cv.MatVector(); this.owned.push(this.contours);
      this.lower = cv.Mat.zeros(4, 1, cv.CV_64F); this.owned.push(this.lower);
      this.upper = cv.Mat.zeros(4, 1, cv.CV_64F); this.owned.push(this.upper);
      this.label = cv.Mat.zeros(1, 1, cv.CV_64F); this.owned.push(this.label);
    } catch (error) { this.dispose(); throw error; }
  }
  load({ width, height, pixels }) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
      || !(pixels instanceof ArrayBuffer) || pixels.byteLength !== width * height * 4) throw Error('Invalid trace image pixels.');
    this.invalidate();
    this.src.create(height, width, this.cv.CV_8UC4);
    this.src.data.set(new Uint8Array(pixels));
    this.cv.cvtColor(this.src, this.rgb, this.cv.COLOR_RGBA2RGB);
    this.width = width; this.height = height; this.stats.uploads++;
  }
  invalidate() { this.segmentKey = this.maskKey = this.smoothKey = this.contourKey = this.selectionKey = null; }
  *trace(seed, inputSettings) {
    const cv = this.cv, settings = normalizeImageTraceSettings(inputSettings);
    if (!this.width || !Array.isArray(seed) || seed.length !== 2 || seed.some((v, i) => !Number.isInteger(v) || v < 0 || v >= (i ? this.height : this.width))) throw Error('Invalid trace seed.');
    const offset = (seed[1] * this.width + seed[0]) * 4, rgba = this.src.data;
    if (rgba[offset + 3] < 8) throw Error('Pick an opaque point inside the object to trace.');
    const color = [rgba[offset], rgba[offset + 1], rgba[offset + 2]];
    const segmentKey = [...color, settings.tolerance].join(':');
    if (segmentKey !== this.segmentKey) {
      this.invalidate();
      const lower = this.lower.data64F, upper = this.upper.data64F;
      color.forEach((value, i) => { lower[i] = Math.max(0, value - settings.tolerance); upper[i] = Math.min(255, value + settings.tolerance); });
      lower[3] = 0; upper[3] = 255;
      cv.inRange(this.rgb, this.lower, this.upper, this.candidate);
      yield 'threshold';
      cv.connectedComponents(this.candidate, this.labels, 8, cv.CV_32S);
      this.segmentKey = segmentKey; this.stats.segmentations++;
      yield 'components';
    }
    const selectedLabel = this.labels.data32S[seed[1] * this.width + seed[0]];
    if (!selectedLabel) throw Error('No traceable color region was found at that point.');
    const maskKey = `${segmentKey}:${selectedLabel}`;
    if (maskKey !== this.maskKey) {
      this.maskKey = this.smoothKey = this.contourKey = this.selectionKey = null;
      this.label.data64F[0] = selectedLabel;
      cv.compare(this.labels, this.label, this.rawMask, cv.CMP_EQ);
      this.maskKey = maskKey; this.stats.masks++;
      yield 'mask';
    }
    const smoothKey = `${maskKey}:${settings.smoothing}`;
    if (smoothKey !== this.smoothKey) {
      this.smoothKey = this.contourKey = this.selectionKey = null;
      this.rawMask.copyTo(this.regionMask);
      if (settings.smoothing > 0) {
        if (this.kernelSize !== settings.smoothing) {
          this.kernel?.delete(); this.kernel = null;
          const size = settings.smoothing * 2 + 1;
          this.kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(size, size)); this.kernelSize = settings.smoothing;
        }
        cv.morphologyEx(this.regionMask, this.regionMask, cv.MORPH_CLOSE, this.kernel);
        cv.morphologyEx(this.regionMask, this.regionMask, cv.MORPH_OPEN, this.kernel);
      }
      if (cv.countNonZero(this.regionMask) < 12) throw Error('The selected region is too small to create a closed polygon.');
      this.smoothKey = smoothKey; this.stats.smoothings++;
      yield 'smoothing';
    }
    if (this.contourKey !== smoothKey) {
      cv.findContours(this.regionMask, this.contours, this.hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
      this.contourKey = smoothKey; this.stats.contourExtractions++;
      yield 'contours';
    }
    const selectionKey = `${smoothKey}:${seed.join(':')}`;
    if (this.selectionKey !== selectionKey) {
      this.selectionKey = null; this.area = 0;
      for (let i = 0; i < this.contours.size(); i++) {
        const contour = this.contours.get(i);
        try {
          const area = Math.abs(cv.contourArea(contour));
          if (cv.pointPolygonTest(contour, new cv.Point(...seed), false) >= 0 && area > this.area) {
            contour.copyTo(this.chosen); this.area = area;
          }
        } finally { contour.delete(); }
      }
      if (this.area < 12) throw Error('No closed edge was found around the selected point.');
      this.selectionKey = selectionKey; this.stats.selections++;
      yield 'selection';
    }
    const perimeter = cv.arcLength(this.chosen, true);
    let epsilon = perimeter * (0.001 + (10 - settings.detail) * 0.0015);
    cv.approxPolyDP(this.chosen, this.approximation, epsilon, true);
    while (this.approximation.rows > 240) { epsilon *= 1.5; cv.approxPolyDP(this.chosen, this.approximation, epsilon, true); }
    this.stats.approximations++;
    const points = [], data = this.approximation.data32S;
    for (let i = 0; i < this.approximation.rows; i++) {
      const p = [data[i * 2], data[i * 2 + 1]], prior = points.at(-1);
      if (!prior || prior[0] !== p[0] || prior[1] !== p[1]) points.push(p);
    }
    if (points.length > 1 && points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1]) points.pop();
    if (points.length < 3) throw Error('The detected edge could not form a closed polygon.');
    return { settings, seedPixel: [...seed], pixelPoints: points, areaPixels: this.area };
  }
  dispose() {
    this.kernel?.delete(); this.kernel = null;
    for (const value of this.owned.splice(0)) value.delete();
    this.width = this.height = 0; this.invalidate();
  }
}
