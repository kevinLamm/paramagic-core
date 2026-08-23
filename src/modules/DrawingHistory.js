const clone = (value) => JSON.parse(JSON.stringify(value));
const fingerprint = (value) => JSON.stringify(value);

export class DrawingHistory {
  constructor({ capture, restore, onChange = () => {}, limit = 100, coalesceMs = 180 }) {
    this.capture = capture;
    this.restore = restore;
    this.onChange = onChange;
    this.limit = limit;
    this.coalesceMs = coalesceMs;
    this.past = [];
    this.future = [];
    this.current = clone(capture());
    this.currentFingerprint = fingerprint(this.current);
    this.timer = null;
    this.restoring = false;
    this.emit();
  }

  emit() {
    this.onChange({ canUndo: this.past.length > 0, canRedo: this.future.length > 0 });
  }

  record() {
    if (this.restoring) return false;
    const next = clone(this.capture());
    const nextFingerprint = fingerprint(next);
    if (nextFingerprint === this.currentFingerprint) return false;
    this.past.push(this.current);
    if (this.past.length > this.limit) this.past.shift();
    this.current = next;
    this.currentFingerprint = nextFingerprint;
    this.future = [];
    this.emit();
    return true;
  }

  recordSoon() {
    if (this.restoring) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.record();
    }, this.coalesceMs);
  }

  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.record();
  }

  reset(snapshot = this.capture()) {
    clearTimeout(this.timer);
    this.timer = null;
    this.past = [];
    this.future = [];
    this.current = clone(snapshot);
    this.currentFingerprint = fingerprint(this.current);
    this.emit();
  }

  apply(snapshot) {
    this.restoring = true;
    try {
      this.restore(clone(snapshot));
    } finally {
      this.restoring = false;
    }
  }

  undo() {
    this.flush();
    if (!this.past.length) return false;
    this.future.push(this.current);
    this.current = this.past.pop();
    this.currentFingerprint = fingerprint(this.current);
    this.apply(this.current);
    this.emit();
    return true;
  }

  redo() {
    this.flush();
    if (!this.future.length) return false;
    this.past.push(this.current);
    this.current = this.future.pop();
    this.currentFingerprint = fingerprint(this.current);
    this.apply(this.current);
    this.emit();
    return true;
  }
}
