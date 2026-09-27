import { createSolverWorkerRuntime } from './SolverWorkerRuntime.js';
import { createSolverWorkerResult } from './SolverWorkerProtocol.js';
import { loadWasmSolverModule, WasmSolverBackend } from './WasmSolverSession.js';

let runtime, initializationError, nativeRequested = false;
async function initialize({ backend = 'javascript', jacobianMode = 'dense' } = {}) {
  nativeRequested = backend === 'wasm';
  let numericBackend = null;
  if (nativeRequested) {
    try { numericBackend = new WasmSolverBackend(await loadWasmSolverModule()); }
    catch (error) { initializationError = error.message; }
  }
  runtime = createSolverWorkerRuntime({
    jacobianMode: nativeRequested || jacobianMode === 'blocks' ? 'blocks' : 'dense', numericBackend,
  });
}
// Commands remain transactionally ordered. Control messages can run while the
// native loop is suspended. Once converged, no timer or solve loop remains active.
let pending = Promise.resolve(), initialized = false;
globalThis.addEventListener('message', ({ data }) => {
  if (data?.type === 'supersede') { runtime?.supersede(data.requestToken); return; }
  if (data?.type === 'initialize') {
    if (!initialized) { initialized = true; pending = initialize(data); }
    return;
  }
  if (!initialized) { initialized = true; pending = initialize(); }
  pending = pending.then(async () => {
    const response = nativeRequested ? await runtime.handleRequestAsync(data) : runtime.handleRequest(data);
    if (initializationError) response.diagnostics.wasmInitializationError = initializationError;
    globalThis.postMessage(response);
  }).catch(error => {
    globalThis.postMessage(createSolverWorkerResult(data, { status: 'invalid', message: error.message }));
  });
});
