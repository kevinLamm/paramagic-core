export class WasmGraph {
  constructor(module) { this.native = new WebAssembly.Instance(module, {}).exports; this.builds = 0; }
  components(ids, nodes, incidence) {
    const indexes = new Map(ids.map((id, i) => [id, i]));
    let count = 0;
    for (const node of nodes) for (const id of incidence.get(node) || []) if (indexes.has(id)) count++;
    if (!this.native.graph_configure(ids.length, nodes.length, count)) throw Error('Native graph capacity exceeded.');
    const view = (kind, size) => new Int32Array(this.native.memory.buffer, this.native.graph_buffer(kind), size);
    const offsets = view(0, nodes.length + 1), edges = view(1, count);
    let offset = 0;
    nodes.forEach((node, i) => { offsets[i] = offset; for (const id of incidence.get(node) || []) if (indexes.has(id)) edges[offset++] = indexes.get(id); });
    offsets[nodes.length] = offset;
    this.native.graph_components(); this.builds++;
    const labels = view(2, ids.length), groups = new Map();
    ids.forEach((id, i) => { const key = labels[i]; if (!groups.has(key)) groups.set(key, { variables: new Set(), nodes: new Set() }); groups.get(key).variables.add(id); });
    nodes.forEach((node, i) => { if (offsets[i] !== offsets[i + 1]) groups.get(labels[edges[offsets[i]]]).nodes.add(node); });
    return groups.values();
  }
}
