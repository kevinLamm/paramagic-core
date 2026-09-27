import { getOpenCvResourceConfiguration, prepareImageTrace, normalizeImageTraceSettings, imageWorldToPixelPoint, imagePixelToLocalPoint, imageLocalToWorldPoint } from './ImageTrace.js';

function browserWorker() { return new Worker(new URL('./ImageTraceWorker.js', import.meta.url), { type: 'module' }); }

// One persistent Worker per canvas image tool. Only initial/source-changed RGBA pixels
// cross the boundary; subsequent requests carry a seed and three settings.
export class ImageTraceClient {
  constructor({ workerFactory = browserWorker, prepare = prepareImageTrace, resources = getOpenCvResourceConfiguration } = {}) {
    this.workerFactory = workerFactory; this.prepare = prepare; this.resources = resources;
    this.sequence = 0; this.sourceVersion = 0; this.latestTrace = 0; this.pending = new Map(); this.disposed = false;
  }
  request(message, transfer = []) {
    if (this.disposed) return Promise.resolve({ status: 'superseded' });
    if (!this.worker) {
      this.worker = this.workerFactory();
      const worker = this.worker;
      worker.addEventListener('message', ({ data }) => {
        if (this.worker !== worker) return;
        const entry = this.pending.get(data?.id); if (!entry) return;
        this.pending.delete(data.id);
        if (data.status === 'error') entry.reject(Error(data.message)); else entry.resolve(data);
      });
      const failed = event => {
        if (this.worker !== worker) return;
        this.worker?.terminate(); this.worker = null; this.source = null; this.openPromise = null;
        for (const entry of this.pending.values()) entry.reject(Error(event.message || 'The trace Worker could not complete the request.'));
        this.pending.clear();
      };
      this.worker.addEventListener('error', failed); this.worker.addEventListener('messageerror', failed);
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ ...message, id }, transfer); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  async open(entity) {
    if (this.openPromise && this.source === entity.source) return this.openPromise;
    const sourceVersion = ++this.sourceVersion; this.source = entity.source;
    // Stop an obsolete image operation while the new image is decoding.
    if (this.worker) void this.request({ type: 'release', sourceVersion }).catch(() => {});
    this.openPromise = (async () => {
      const prepared = await this.prepare(entity);
      if (this.disposed || sourceVersion !== this.sourceVersion) return null;
      const { naturalWidth: width, naturalHeight: height } = prepared;
      const pixels = prepared.imageData.data.buffer;
      const response = await this.request({ type: 'open', scriptUrl: this.resources().scriptUrl, width, height, pixels, sourceVersion }, [pixels]);
      return response.status === 'ready' ? { width, height, sourceVersion } : null;
    })();
    try { return await this.openPromise; }
    catch (error) {
      if (sourceVersion === this.sourceVersion) {
        this.source = null; this.openPromise = null;
        this.worker?.terminate(); this.worker = null;
        for (const entry of this.pending.values()) entry.resolve({ status: 'superseded' });
        this.pending.clear();
      }
      throw error;
    }
  }
  async trace(entity, worldPoint, inputSettings = {}) {
    const traceId = ++this.latestTrace, snapshot = { ...entity }, point = [...worldPoint], settings = normalizeImageTraceSettings(inputSettings);
    const opened = await this.open(snapshot);
    if (!opened || this.disposed || traceId !== this.latestTrace) return null;
    const seed = imageWorldToPixelPoint(snapshot, point, opened.width, opened.height);
    const response = await this.request({ type: 'trace', sourceVersion: opened.sourceVersion, seed, settings });
    if (response.status !== 'complete' || this.disposed || traceId !== this.latestTrace || response.sourceVersion !== this.sourceVersion) return null;
    const result = response.result;
    const localPoints = result.pixelPoints.map(p => imagePixelToLocalPoint(snapshot, p, opened.width, opened.height));
    return { ...result, localPoints, worldPoints: localPoints.map(p => imageLocalToWorldPoint(snapshot, p)), diagnostics: response.diagnostics };
  }
  release() {
    this.latestTrace++; this.sourceVersion++; this.source = this.openPromise = null;
    // Keep the initialized OpenCV module idle, but release the image's Mats.
    if (this.worker) void this.request({ type: 'release', sourceVersion: this.sourceVersion }).catch(() => {});
  }
  dispose() {
    this.disposed = true; this.latestTrace++; this.sourceVersion++;
    this.worker?.terminate(); this.worker = null; this.source = this.openPromise = null;
    for (const entry of this.pending.values()) entry.resolve({ status: 'superseded' });
    this.pending.clear();
  }
}
