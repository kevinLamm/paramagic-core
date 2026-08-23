import { createSolverWorkerRuntime } from './SolverWorkerRuntime.js';

let jacobianMode = 'dense';
try {
  jacobianMode = new URL(globalThis.location?.href || 'http://localhost/').searchParams.get('jacobianMode') === 'blocks'
    ? 'blocks'
    : 'dense';
} catch {
  jacobianMode = 'dense';
}
const runtime = createSolverWorkerRuntime({ jacobianMode });

globalThis.addEventListener('message', (event) => {
  globalThis.postMessage(runtime.handleRequest(event.data));
});
