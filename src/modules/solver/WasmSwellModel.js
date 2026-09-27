import { isSwellEntity, swellDefinitionForEntity } from '../SwellGeometry.js';

const sourceTypes = ['line', 'arc', 'circle', 'polyline', 'polygon', 'curve'];
const roles = ['offset', 'start-transition', 'swell', 'end-transition'];
const root = model => { while (model.source) model = model.source; return model; };
const sourceConstraints = model => [...root(model).constraints.values()].filter(c => c.enabled !== false
  && c.type === 'Coincident' && c.featureRefs?.every(r => !r.derivedFeature && isSwellEntity(model.binding(r.recordId))));

// Structural adapter only. All source geometry, joins, transition branches and
// numerical derivatives are evaluated in native/swell_geometry.h.
export class WasmSwellModel {
  constructor(model, variableIndex) {
    this.frameIndexes = ref => (model.placementVariables?.get(ref?.stackId || model.binding(ref?.recordId || ref?.entityId)?.stackId) || [])
      .map(v => variableIndex.get(v.id));
    this.sources = [...model.entities.values()].filter(isSwellEntity);
    this.sourceIndex = new Map(this.sources.map((b, i) => [b.id, i]));
    this.requests = []; this.requestMap = new Map(); this.refs = []; this.records = []; this.definitions = [];
    this.segmentCount = 0; this.sampleCount = 0; this.pieceCount = 0;
    const groups = new Map();
    const consumed = new Set(this.sources.flatMap(b => b.composite?.swellFillet?.sourceEndpoints || [])
      .map(r => r.recordId + ':' + Number(r.index)));
    for (const b of this.sources) {
      const type = sourceTypes.indexOf(b.type) + 1;
      if (!type) throw new Error('Unsupported native Swell source ' + b.type);
      const count = b.type === 'line' ? 2 : b.type === 'arc' ? 3 : b.type === 'circle' ? 1 : b.metadata.pointCount;
      const closed = b.type === 'polygon' || b.metadata.closed === true;
      const segments = b.type === 'line' ? 1 : ['polygon', 'polyline'].includes(b.type) ? count - (closed ? 0 : 1) : 0;
      const samples = b.type === 'curve' ? Math.max(0, (count - 1) * 16 + 1) : 0;
      const offset = this.refs.length;
      const keys = b.type === 'line' ? ['start.x', 'start.y', 'end.x', 'end.y']
        : b.type === 'arc' ? ['start.x', 'start.y', 'center.x', 'center.y', 'end.x', 'end.y']
        : b.type === 'circle' ? ['center.x', 'center.y', 'radius']
        : Array.from({ length: count }, (_, i) => ['p' + i + '.x', 'p' + i + '.y']).flat();
      for (const key of keys) {
        const index = variableIndex.get(b.variables.get(key)?.id);
        if (index === undefined) throw new Error('Missing native Swell source variable ' + key);
        this.refs.push(index);
      }
      let group = -1;
      if (b.composite?.id) {
        if (!groups.has(b.composite.id)) groups.set(b.composite.id, groups.size);
        group = groups.get(b.composite.id);
      }
      const pieces = segments ? segments * 3 : 1;
      this.records.push(type, offset, count, group, +closed, +(b.composite?.closed === true),
        this.definitions.length, this.segmentCount, segments, this.pieceCount, pieces,
        this.sampleCount, samples, +(b.type === 'line' || b.type === 'arc' || (['curve', 'polyline'].includes(b.type) && !closed && count >= 2)),
        +consumed.has(b.id + ':0'), +consumed.has(b.id + ':2'), ...([0, 1, 2].map(i => this.frameIndexes({ stackId: b.stackId })[i] ?? -1)));
      for (let i = 0; i < Math.max(1, segments); i++) this.definitions.push({ id: b.id, segment: segments ? i : null });
      this.segmentCount += segments; this.sampleCount += samples; this.pieceCount += pieces;
    }
    this.pairs = [];
    for (const c of sourceConstraints(model)) {
      const endpoints = c.featureRefs.map(r => {
        const index = this.sourceIndex.get(r.recordId), b = model.binding(r.recordId);
        const end = ['line', 'arc'].includes(b.type) ? 2 : b.metadata.pointCount - 1;
        return index !== undefined && r.kind === 'point' && [0, end].includes(Number(r.index))
          ? index * 2 + (Number(r.index) === 0 ? 0 : 1) : -1;
      }).filter(i => i >= 0);
      // Source topology accepts all endpoint references. Offset joining only
      // uses exactly two references at legacy endpoint indexes 0 or 2.
      for (const endpoint of endpoints.slice(1)) this.pairs.push(endpoints[0], endpoint,
        +(c.featureRefs.length === 2 && c.featureRefs.every(r => [0, 2].includes(Number(r.index)))));
    }
  }
  request(ref, global) {
    const key = JSON.stringify([ref, global]);
    if (this.requestMap.has(key)) return this.requestMap.get(key);
    if (ref.derivedFeature?.provider !== 'swell') throw new Error('Unsupported native derived provider ' + ref.derivedFeature?.provider);
    const source = this.sourceIndex.get(ref.recordId || ref.entityId);
    if (source === undefined) throw new Error('Missing native Swell source.');
    const selector = ref.derivedFeature, role = roles.indexOf(selector.role);
    if (role < 0) throw new Error('Unknown native Swell piece role.');
    if (!Number.isInteger(selector.ordinal) || selector.ordinal < 0
      || (selector.segmentIndex !== null && !Number.isInteger(selector.segmentIndex))) throw new Error('Invalid native Swell piece selector.');
    const type = ['center', 'segment-start', 'segment-end', 'segment-point'].indexOf(ref.type) + 1;
    const index = this.requests.length;
    this.requests.push({ ref, global, data: [source, selector.segmentIndex ?? -1, role, selector.ordinal,
      Number(ref.index) || 0, +(ref.pointRole === 'arc-midpoint'), type, +global, ...([0, 1, 2].map(i => this.frameIndexes(ref)[i] ?? -1))] });
    this.requestMap.set(key, index); return index;
  }
  get integers() { return [...this.records, ...this.refs, ...this.pairs, ...this.requests.flatMap(r => r.data)]; }
  get numberCount() { return this.sources.length * 6 + this.definitions.length * 6 + this.requests.length * 4; }
  get sizes() { return [this.sources.length, this.refs.length, this.definitions.length, this.pairs.length / 3,
    this.requests.length, this.segmentCount, this.sampleCount]; }
  sync(model, dimensions, output, write = (array, index, value) => { array[index] = value; }) {
    const world = model.placementVariables ? model : root(model); let offset = 0;
    const set = values => { for (const value of values) write(output, offset++, value); };
    for (const old of this.sources) {
      const b = model.binding(old.id), frame = world.stackFrame(b.stackId);
      set([frame.x || 0, frame.y || 0, frame.rotation || 0, b.metadata.middleRatio ?? 0.5,
        +Boolean(b.metadata.ccw), +(b.composite?.swellFillet?.sourceEndpoints?.length > 0)]);
    }
    for (const { id, segment } of this.definitions) {
      const b = model.binding(id), def = swellDefinitionForEntity(b, segment);
      const evaluate = key => {
        try { const value = Number(dimensions.evaluateLengthExpression(def[key], { stackId: b.stackId }));
          return Number.isFinite(value) ? value : 0; } catch { return 0; }
      };
      const values = [evaluate('offsetExpression'), ...(def.swellEnabled
        ? ['swellOffsetExpression', 'startTransitionExpression', 'endTransitionExpression'].map(evaluate) : [0, 0, 0])];
      const direction = values.some(v => v < -1e-8) ? -1 : 1;
      const [a, bOffset, start, end] = values.map(Math.abs);
      set([a, def.swellEnabled ? bOffset : a, start, end, direction, +def.swellEnabled]);
    }
    for (const { ref } of this.requests) {
      const frame = world.frameForReference(ref);
      set([frame.x || 0, frame.y || 0, frame.rotation || 0, Math.max(0, Math.min(1, Number(ref.ratio) || 0))]);
    }
  }
  static topology(model) {
    return JSON.stringify([[...model.entities.values()].filter(isSwellEntity).map(b =>
      [b.id, b.type, b.stackId, b.metadata.pointCount, b.metadata.closed, b.composite?.id, b.composite?.closed,
        b.composite?.swellFillet?.sourceEndpoints]), sourceConstraints(model).map(c => [c.id, c.featureRefs])]);
  }
}
