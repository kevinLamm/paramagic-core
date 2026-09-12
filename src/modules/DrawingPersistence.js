import { identityAudit } from './DrawingIdentitySystem.js';

// Persistence must not depend on a drawing being fit for editing or solving.
// Keep the failed graph intact so its original identities can be diagnosed.
export function drawingSaveDiagnostics(snapshot, error, stage = 'serialization') {
  let errors;
  try {
    errors = identityAudit(snapshot).errors;
  } catch (auditError) {
    errors = [{ code: 'identity-audit-failed', message: String(auditError?.message || auditError) }];
  }
  return {
    version: 1,
    preservedWithoutNormalization: true,
    errors: [
      { code: 'save-processing-failed', stage, message: String(error?.message || error) },
      ...errors,
    ],
  };
}

export function serializePreservedDrawing(snapshot, name, error, stage) {
  return JSON.stringify({
    ...snapshot,
    format: 'ParaMagic Drawing',
    version: 4,
    name,
    saveDiagnostics: drawingSaveDiagnostics(snapshot, error, stage),
  }, null, 2);
}
