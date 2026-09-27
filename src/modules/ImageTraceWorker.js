import { createImageTraceWorkerRuntime } from './ImageTraceWorkerRuntime.js';

let cvPromise;
const runtime = createImageTraceWorkerRuntime({
  async loadCv(scriptUrl) {
    if (!cvPromise) cvPromise = (async () => {
      // The host's pinned OpenCV UMD asset embeds its WASM. Loading it as a
      // module also works in a module Worker; no DOM/Canvas helpers are called.
      await import(/* @vite-ignore */ scriptUrl);
      const cv = await globalThis.cv;
      if (!cv?.Mat || !cv.compare) throw Error('OpenCV did not initialize in the trace Worker.');
      return cv;
    })();
    return cvPromise;
  },
  postMessage: message => globalThis.postMessage(message),
});
globalThis.onmessage = ({ data }) => runtime.receive(data);
