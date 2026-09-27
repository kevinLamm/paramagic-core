import { ImageTraceKernel } from './ImageTraceKernel.js';

export function createImageTraceWorkerRuntime({ loadCv, postMessage, nextTask = () => new Promise(resolve => setTimeout(resolve, 0)) }) {
  let pending = null, running = false, latest = 0, kernel = null, sourceVersion = null;
  const reply = (message, status, extra = {}) => postMessage({ id: message.id, sourceVersion: message.sourceVersion, status, ...extra });
  async function drain() {
    running = true;
    try {
      while (pending) {
        const message = pending; pending = null;
        const current = () => message.id === latest;
        try {
          if (message.type === 'open') {
            const cv = await loadCv(message.scriptUrl);
            if (!current()) { reply(message, 'superseded'); continue; }
            kernel?.dispose(); kernel = null; sourceVersion = null;
            kernel = new ImageTraceKernel(cv); kernel.load(message);
            sourceVersion = message.sourceVersion;
            reply(message, 'ready');
          } else if (message.type === 'trace') {
            if (!kernel || sourceVersion !== message.sourceVersion) throw Error('Trace image is no longer loaded.');
            const work = kernel.trace(message.seed, message.settings), stages = []; let processingMs = 0;
            try {
              let result;
              while (current()) {
                const start = performance.now();
                result = work.next(); processingMs += performance.now() - start;
                if (result.done) break;
                stages.push(result.value); await nextTask();
              }
              if (!current()) reply(message, 'superseded');
              else reply(message, 'complete', { result: result.value, diagnostics: { backend: 'opencv-wasm-worker', processingMs, stages, ...kernel.stats } });
            } finally { work.return(); }
          } else if (message.type === 'release') {
            kernel?.dispose(); kernel = null; sourceVersion = null; reply(message, 'released');
          } else throw Error('Unknown trace request.');
        } catch (error) {
          if (message.type === 'open') { kernel?.dispose(); kernel = null; sourceVersion = null; }
          reply(message, current() ? 'error' : 'superseded', { message: error?.message || String(error) });
        }
      }
    } finally { running = false; }
  }
  return {
    receive(message) {
      if (!message || !Number.isSafeInteger(message.id) || message.id <= latest) return;
      latest = message.id;
      if (pending) reply(pending, 'superseded');
      pending = message;
      if (!running) void drain();
    },
  };
}
