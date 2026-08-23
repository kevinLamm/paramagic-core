const clone = (value) => JSON.parse(JSON.stringify(value));

export class SolverMutationJournal {
  constructor({ revision = 0, snapshot = {}, checkpointInterval = 50 } = {}) {
    this.checkpoint = { revision, snapshot: clone(snapshot) };
    this.acceptedRevision = revision;
    this.entries = [];
    this.checkpointInterval = Math.max(1, Number(checkpointInterval) || 50);
  }

  record({ revision, type, payload = {}, coalesceKey = null }) {
    if (!Number.isInteger(revision) || revision <= this.checkpoint.revision) {
      throw new TypeError('Journal revisions must be integers newer than the checkpoint.');
    }
    const entry = { revision, type, payload: clone(payload), coalesceKey };
    const previous = this.entries[this.entries.length - 1];
    if (coalesceKey && previous?.coalesceKey === coalesceKey && previous.revision > this.acceptedRevision) {
      this.entries[this.entries.length - 1] = entry;
    } else {
      this.entries.push(entry);
    }
    return clone(entry);
  }

  accept(revision) {
    if (Number.isInteger(revision)) this.acceptedRevision = Math.max(this.acceptedRevision, revision);
    return this.acceptedRevision;
  }

  installCheckpoint(revision, snapshot) {
    if (!Number.isInteger(revision) || revision < this.checkpoint.revision) return false;
    this.checkpoint = { revision, snapshot: clone(snapshot) };
    this.acceptedRevision = Math.max(this.acceptedRevision, revision);
    this.entries = this.entries.filter((entry) => entry.revision > revision);
    return true;
  }

  shouldCheckpoint(currentRevision) {
    return this.acceptedRevision === currentRevision
      && this.acceptedRevision - this.checkpoint.revision >= this.checkpointInterval;
  }

  recoveryPlan(afterRevision = this.checkpoint.revision, throughRevision = Infinity) {
    return this.entries
      .filter((entry) => entry.revision > afterRevision && entry.revision <= throughRevision)
      .map(clone);
  }

  checkpointSnapshot() {
    return { revision: this.checkpoint.revision, snapshot: clone(this.checkpoint.snapshot) };
  }

  diagnostics() {
    return {
      checkpointRevision: this.checkpoint.revision,
      acceptedRevision: this.acceptedRevision,
      entryCount: this.entries.length,
      oldestRevision: this.entries[0]?.revision ?? null,
      newestRevision: this.entries[this.entries.length - 1]?.revision ?? null,
    };
  }
}

export function createSolverMutationJournal(options) {
  return new SolverMutationJournal(options);
}
