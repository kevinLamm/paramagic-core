import { solveLevenbergMarquardt } from './NumericSolverCore.js';

// Transactions yield one complete numerical solve. Both entry points execute
// the same controller transaction; only the native Worker driver can suspend.
function referenceSolve(options, backend) {
  const result = solveLevenbergMarquardt(options);
  return { ...result, backend: 'javascript', ...(backend?.fallbackReason ? {
    jacobianStats: { ...result.jacobianStats, fallbackReason: backend.fallbackReason },
  } : {}) };
}

export function runSolverWork(work) {
  try {
    let next = work.next();
    while (!next.done) {
      const { numericBackend, ...options } = next.value;
      next = work.next(numericBackend?.trySolve(options) || referenceSolve(options, numericBackend));
    }
    return next.value;
  } finally { work.return(); }
}

export async function runSolverWorkAsync(work, shouldCancel) {
  try {
    let next = work.next();
    while (!next.done) {
      const { numericBackend, ...options } = next.value;
      const originalCancel = options.shouldCancel;
      options.shouldCancel = () => shouldCancel?.() || originalCancel?.();
      const native = numericBackend ? await numericBackend.trySolveAsync(options) : null;
      next = work.next(native || referenceSolve(options, numericBackend));
    }
    return next.value;
  } finally { work.return(); }
}
