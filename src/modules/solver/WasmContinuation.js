export class WasmContinuation {
  constructor(module) { this.native = new WebAssembly.Instance(module, {}).exports; this.predictions = 0; }
  begin(controller) {
    this.controller = controller;
    this.variables = controller.model.allVariables();
    this.stacks = controller.stackState.stacks;
    this.count = this.variables.length + this.stacks.length * 3;
    if (!this.native.continuation_configure(this.count)) throw Error('Native continuation capacity exceeded.');
    this.read(); this.native.continuation_reset();
    return this;
  }
  values() { return new Float64Array(this.native.memory.buffer, this.native.continuation_buffer(0), this.count); }
  read() {
    const data = this.values();
    this.variables.forEach((v, i) => { data[i] = v.value; });
    this.stacks.forEach((s, i) => ['x', 'y', 'rotation'].forEach((key, k) => { data[this.variables.length + i * 3 + k] = s.frame?.[key] || 0; }));
  }
  checkpoint() {
    this.read(); this.native.continuation_checkpoint();
    this.annotations = [...this.controller.dimensionAnnotations.entries()].map(([id, a]) => [id, structuredClone(a)]);
  }
  restore() {
    this.native.continuation_restore(); const data = this.values();
    this.variables.forEach((v, i) => { v.value = data[i]; });
    this.stacks.forEach((s, i) => { if (s.frame) ['x', 'y', 'rotation'].forEach((key, k) => { s.frame[key] = data[this.variables.length + i * 3 + k]; }); });
    this.annotations.forEach(([id, a]) => this.controller.setDimensionAnnotation(id, a));
  }
  predict(ratio) {
    const active = new Int32Array(this.native.memory.buffer, this.native.continuation_buffer(1), this.count);
    active.fill(0); this.variables.forEach((v, i) => { active[i] = +v.active; });
    this.native.continuation_predict(ratio); this.predictions++;
    const data = this.values(), changed = new Set();
    this.variables.forEach((v, i) => { if (Math.abs(v.value - data[i]) > 1e-12) changed.add(v.ownerId); v.value = data[i]; });
    return changed;
  }
  accept() { this.read(); this.native.continuation_accept(); }
}
