import { isCanvasOriginReference } from '../CanvasOrigin.js';
import { ARC_MIDPOINT_ROLE, arcSweepFromAngles } from '../ArcGeometry.js';

// --- Solver Variable & Unique ID Allocator ---
let fallbackId = 0;

export function createStableId(prefix = 'id') {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  fallbackId += 1;
  return `${prefix}-${fallbackId}`;
}

export class Variable {
  constructor({ id = createStableId('variable'), value = 0, fixed = false, owner = null, parameter = null } = {}) {
    this.id = id;
    this.value = Number(value);
    this.fixed = Boolean(fixed);
    this.locked = false;
    this.owner = owner;
    this.parameter = parameter;
  }

  get active() {
    return !this.fixed && !this.locked;
  }
}

// --- Geometry Bindings & Spatial Entity Adapters ---
const clone = (value) => JSON.parse(JSON.stringify(value));
const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const tau = Math.PI * 2;
const normalizeAngle = (angle) => (angle + tau) % tau;
const isFinitePoint = (point) => Array.isArray(point) && point.length >= 2 && point.every(Number.isFinite);

export function circleFromThreePoints(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-10) return null;
  const aa = a[0] ** 2 + a[1] ** 2;
  const bb = b[0] ** 2 + b[1] ** 2;
  const cc = c[0] ** 2 + c[1] ** 2;
  const center = [
    (aa * (b[1] - c[1]) + bb * (c[1] - a[1]) + cc * (a[1] - b[1])) / d,
    (aa * (c[0] - b[0]) + bb * (a[0] - c[0]) + cc * (b[0] - a[0])) / d,
  ];
  return { center, radius: distance(a, center) };
}

function circleFromArcEntity(entity) {
  if (isFinitePoint(entity.center) && Number.isFinite(entity.radius) && Math.abs(entity.radius) > 1e-8) {
    return { center: [...entity.center], radius: Math.abs(entity.radius) };
  }
  return circleFromThreePoints(entity.start, entity.arcPoint, entity.end);
}

function arcMetadata(entity, circle, { retainedCcw = null } = {}) {
  const startAngle = Math.atan2(entity.start[1] - circle.center[1], entity.start[0] - circle.center[0]);
  const middleAngle = Math.atan2(entity.arcPoint[1] - circle.center[1], entity.arcPoint[0] - circle.center[0]);
  const endAngle = Math.atan2(entity.end[1] - circle.center[1], entity.end[0] - circle.center[0]);
  const sweep = arcSweepFromAngles(startAngle, endAngle, typeof retainedCcw === 'boolean' ? null : middleAngle, {
    major: typeof entity.major === 'boolean' ? entity.major : null,
    ccw: typeof retainedCcw === 'boolean'
      ? retainedCcw
      : (typeof entity.ccw === 'boolean' ? entity.ccw : null),
  });
  const traveled = sweep.ccw
    ? normalizeAngle(middleAngle - startAngle)
    : normalizeAngle(startAngle - middleAngle);
  const span = Math.abs(sweep.span);
  return {
    ccw: sweep.ccw,
    major: sweep.major,
    middleRatio: span > 1e-9 ? Math.max(0.05, Math.min(0.95, traveled / span)) : 0.5,
  };
}

function pointKeys(prefix, point) {
  return [[`${prefix}.x`, point[0]], [`${prefix}.y`, point[1]]];
}

export class GeometryBinding {
  constructor(inputEntity) {
    const entity = clone(inputEntity);
    this.id = entity.id || createStableId('entity');
    this.type = entity.type;
    this.hasStackId = Object.prototype.hasOwnProperty.call(entity, 'stackId');
    this.stackId = String(entity.stackId || 'stack-default');
    this.hasClassId = Object.prototype.hasOwnProperty.call(entity, 'classId');
    this.classId = String(entity.classId || 'class-x');
    this.classPropertyOverrides = Array.isArray(entity.classPropertyOverrides)
      ? clone(entity.classPropertyOverrides)
      : [];
    this.construction = Boolean(entity.construction);
    this.composite = entity.composite ? clone(entity.composite) : null;
    this.appearance = entity.appearance ? clone(entity.appearance) : null;
    this.hasSubtractState = Object.prototype.hasOwnProperty.call(entity, 'subtract')
      || Object.prototype.hasOwnProperty.call(entity, 'subtractExpression');
    this.subtract = Boolean(entity.subtract);
    this.subtractExpression = String(entity.subtractExpression ?? (this.subtract ? 'TRUE' : 'FALSE'));
    this.hasSubtractParentState = Object.prototype.hasOwnProperty.call(entity, 'subtractFrom');
    this.subtractFrom = Array.isArray(entity.subtractFrom) ? clone(entity.subtractFrom) : [];
    this.metadata = {};
    this.variables = new Map();
    this.cachedArcMetrics = null;
    this.load(entity);
  }

  setVariable(name, value) {
    const current = this.variables.get(name);
    if (current) current.value = Number(value);
    else this.variables.set(name, new Variable({ id: `${this.id}:${name}`, value, owner: this.id, parameter: name }));
  }

  setPoints(points) {
    points.forEach((point, index) => pointKeys(`p${index}`, point).forEach(([name, value]) => this.setVariable(name, value)));
    [...this.variables.keys()]
      .filter((name) => {
        const match = /^p(\d+)\.[xy]$/.exec(name);
        return match && Number(match[1]) >= points.length;
      })
      .forEach((name) => this.variables.delete(name));
    this.metadata.pointCount = points.length;
  }

  load(entity) {
    this.type = entity.type;
    if (Object.prototype.hasOwnProperty.call(entity, 'stackId')) {
      this.hasStackId = true;
      this.stackId = String(entity.stackId || 'stack-default');
    }
    if (Object.prototype.hasOwnProperty.call(entity, 'classId')) {
      this.hasClassId = true;
      this.classId = String(entity.classId || 'class-x');
      this.classPropertyOverrides = Array.isArray(entity.classPropertyOverrides)
        ? clone(entity.classPropertyOverrides)
        : [];
    }
    this.construction = Boolean(entity.construction);
    this.composite = entity.composite ? clone(entity.composite) : null;
    this.appearance = entity.appearance ? clone(entity.appearance) : null;
    if (Object.prototype.hasOwnProperty.call(entity, 'subtract')
      || Object.prototype.hasOwnProperty.call(entity, 'subtractExpression')) {
      this.hasSubtractState = true;
      this.subtract = Boolean(entity.subtract);
      this.subtractExpression = String(entity.subtractExpression ?? (this.subtract ? 'TRUE' : 'FALSE'));
    }
    if (Object.prototype.hasOwnProperty.call(entity, 'subtractFrom')) {
      this.hasSubtractParentState = true;
      this.subtractFrom = Array.isArray(entity.subtractFrom) ? clone(entity.subtractFrom) : [];
    }
    if (entity.type === 'line') {
      pointKeys('start', entity.start).concat(pointKeys('end', entity.end)).forEach(([name, value]) => this.setVariable(name, value));
      return;
    }
    if (entity.type === 'point') {
      pointKeys('point', entity.point).forEach(([name, value]) => this.setVariable(name, value));
      return;
    }
    if (entity.type === 'text') {
      pointKeys('anchor', [entity.x, entity.y]).forEach(([name, value]) => this.setVariable(name, value));
      this.metadata.text = clone(entity);
      return;
    }
    if (entity.type === 'control') {
      const controlType = String(entity.controlType || 'horizontal-slider');
      this.metadata.control = {
        controlType,
        label: String(entity.label ?? ''),
        width: Math.max(24, Number(entity.width) || 180),
        height: Math.max(24, Number(entity.height) || 48),
        scaleWithZoom: entity.scaleWithZoom !== false,
        controlLength: Boolean(entity.controlLength),
        minExpression: String(entity.minExpression ?? '0'),
        maxExpression: String(entity.maxExpression ?? '100'),
        initialExpression: String(entity.initialExpression ?? (controlType === 'checkbox' ? 'FALSE' : controlType === 'options' || controlType === 'dropdown' ? '0' : '50')),
        options: Array.isArray(entity.options) ? clone(entity.options) : ['Option 1', 'Option 2', 'Option 3'],
        parameterId: String(entity.parameterId || ''),
        parameterName: String(entity.parameterName || ''),
      };
      pointKeys('anchor', [entity.x, entity.y]).forEach(([name, value]) => this.setVariable(name, value));
      if (controlType === 'horizontal-slider') {
        pointKeys('middle', [entity.x + Math.max(24, Number(entity.width) || 180) / 2, entity.y])
          .forEach(([name, value]) => this.setVariable(name, value));
      }
      if (controlType === 'vertical-slider') {
        pointKeys('middle', [entity.x, entity.y + Math.max(24, Number(entity.height) || 180) / 2])
          .forEach(([name, value]) => this.setVariable(name, value));
      }
      return;
    }
    if (entity.type === 'table') {
      this.setVariable('x', Number(entity.x) || 0);
      this.setVariable('y', Number(entity.y) || 0);
      this.setVariable('width', Math.max(1e-8, Math.abs(Number(entity.width) || 0)));
      this.setVariable('height', Math.max(1e-8, Math.abs(Number(entity.height) || 0)));
      return;
    }
    if (entity.type === 'circle') {
      pointKeys('center', entity.center).forEach(([name, value]) => this.setVariable(name, value));
      this.setVariable('radius', Math.max(1e-8, entity.radius));
      return;
    }
    if (entity.type === 'rect') {
      this.type = 'polygon';
      this.setPoints([
        [entity.x, entity.y],
        [entity.x + entity.width, entity.y],
        [entity.x + entity.width, entity.y + entity.height],
        [entity.x, entity.y + entity.height],
      ]);
      return;
    }
    if (['polygon', 'polyline', 'curve'].includes(entity.type)) {
      this.setPoints(entity.points || []);
      return;
    }
    if (entity.type === 'arc') {
      const circle = circleFromArcEntity(entity);
      if (!circle) throw new Error('Arc points must define a finite circle.');
      pointKeys('center', circle.center)
        .concat(pointKeys('start', entity.start), pointKeys('end', entity.end))
        .forEach(([name, value]) => this.setVariable(name, value));
      this.metadata = {
        ...this.metadata,
        ...arcMetadata(entity, circle),
      };
      return;
    }
    throw new Error(`Unsupported geometry type: ${entity.type}`);
  }

  value(name) {
    return this.variables.get(name)?.value;
  }

  point(prefix) {
    return [this.value(`${prefix}.x`), this.value(`${prefix}.y`)];
  }

  indexedPoint(index) {
    return this.point(`p${index}`);
  }

  arcPoints() {
    const metrics = this.arcMetrics();
    if (!metrics) return null;
    const middleAngle = metrics.startAngle + metrics.span * (this.metadata.middleRatio ?? 0.5);
    const midpointAngle = metrics.startAngle + metrics.span * 0.5;
    return {
      center: metrics.center,
      start: metrics.start,
      end: metrics.end,
      arcPoint: [
        metrics.center[0] + Math.cos(middleAngle) * metrics.radius,
        metrics.center[1] + Math.sin(middleAngle) * metrics.radius,
      ],
      midpoint: [
        metrics.center[0] + Math.cos(midpointAngle) * metrics.radius,
        metrics.center[1] + Math.sin(midpointAngle) * metrics.radius,
      ],
      radius: metrics.radius,
      ccw: metrics.ccw,
      major: metrics.major,
    };
  }

  arcMetrics() {
    if (this.type !== 'arc') return null;
    const center = this.point('center');
    const start = this.point('start');
    const end = this.point('end');
    const cached = this.cachedArcMetrics;
    if (cached
      && cached.center[0] === center[0]
      && cached.center[1] === center[1]
      && cached.start[0] === start[0]
      && cached.start[1] === start[1]
      && cached.end[0] === end[0]
      && cached.end[1] === end[1]
      && cached.metadataMajor === this.metadata.major
      && cached.metadataCcw === this.metadata.ccw) {
      return cached;
    }
    const startVector = [start[0] - center[0], start[1] - center[1]];
    const endVector = [end[0] - center[0], end[1] - center[1]];
    const startSquared = startVector[0] ** 2 + startVector[1] ** 2;
    const endSquared = endVector[0] ** 2 + endVector[1] ** 2;
    const startRadius = Math.sqrt(startSquared);
    const endRadius = Math.sqrt(endSquared);
    const startAngle = Math.atan2(startVector[1], startVector[0]);
    const endAngle = Math.atan2(endVector[1], endVector[0]);
    const sweep = arcSweepFromAngles(startAngle, endAngle, null, {
      major: this.metadata.major,
      ccw: this.metadata.ccw,
    });
    const radius = (startRadius + endRadius) / 2;
    this.cachedArcMetrics = {
      center,
      start,
      end,
      startVector,
      endVector,
      startSquared,
      endSquared,
      startRadius,
      endRadius,
      startAngle,
      endAngle,
      span: sweep.span,
      sweep: Math.abs(sweep.span),
      radius,
      length: radius * Math.abs(sweep.span),
      ccw: sweep.ccw,
      major: sweep.major,
      metadataMajor: this.metadata.major,
      metadataCcw: this.metadata.ccw,
    };
    return this.cachedArcMetrics;
  }

  toEntity() {
    const base = { id: this.id, type: this.type };
    if (this.hasStackId) base.stackId = this.stackId;
    if (this.hasClassId) {
      base.classId = this.classId;
      base.classPropertyOverrides = clone(this.classPropertyOverrides);
    }
    if (this.construction) base.construction = true;
    if (this.composite) base.composite = clone(this.composite);
    if (this.appearance) base.appearance = clone(this.appearance);
    if (this.hasSubtractState) {
      base.subtract = this.subtract;
      base.subtractExpression = this.subtractExpression;
    }
    if (this.hasSubtractParentState) base.subtractFrom = clone(this.subtractFrom);
    if (this.type === 'control') {
      const control = clone(this.metadata.control || {});
      const anchor = this.point('anchor');
      const result = { ...base, ...control, x: anchor[0], y: anchor[1] };
      if (control.controlType === 'horizontal-slider') {
        const middle = this.point('middle');
        result.width = Math.max(24, (middle[0] - anchor[0]) * 2);
      }
      if (control.controlType === 'vertical-slider') {
        const middle = this.point('middle');
        result.height = Math.max(24, (middle[1] - anchor[1]) * 2);
      }
      return result;
    }
    if (this.type === 'table') {
      return {
        ...base,
        x: this.value('x'),
        y: this.value('y'),
        width: Math.abs(this.value('width')),
        height: Math.abs(this.value('height')),
      };
    }
    if (this.type === 'line') return { ...base, start: this.point('start'), end: this.point('end') };
    if (this.type === 'point') return { ...base, point: this.point('point') };
    if (this.type === 'text') return { ...clone(this.metadata.text), ...base, x: this.point('anchor')[0], y: this.point('anchor')[1] };
    if (this.type === 'circle') return { ...base, center: this.point('center'), radius: Math.abs(this.value('radius')) };
    if (['polygon', 'polyline', 'curve'].includes(this.type)) {
      return { ...base, points: Array.from({ length: this.metadata.pointCount }, (_, index) => this.indexedPoint(index)) };
    }
    if (this.type === 'arc') {
      const arc = this.arcPoints();
      return {
        ...base,
        start: arc.start,
        arcPoint: arc.arcPoint,
        end: arc.end,
        center: arc.center,
        radius: arc.radius,
        ccw: arc.ccw,
        major: arc.major,
      };
    }
    return base;
  }

  updateFromEntity(entity) {
    if (Object.prototype.hasOwnProperty.call(entity, 'stackId')) {
      this.hasStackId = true;
      this.stackId = String(entity.stackId || 'stack-default');
    }
    if (Object.prototype.hasOwnProperty.call(entity, 'classId')) {
      this.hasClassId = true;
      this.classId = String(entity.classId || 'class-x');
      this.classPropertyOverrides = Array.isArray(entity.classPropertyOverrides)
        ? clone(entity.classPropertyOverrides)
        : [];
    }
    this.construction = Boolean(entity.construction);
    this.composite = entity.composite ? clone(entity.composite) : null;
    this.appearance = entity.appearance ? clone(entity.appearance) : null;
    if (Object.prototype.hasOwnProperty.call(entity, 'subtract')
      || Object.prototype.hasOwnProperty.call(entity, 'subtractExpression')) {
      this.hasSubtractState = true;
      this.subtract = Boolean(entity.subtract);
      this.subtractExpression = String(entity.subtractExpression ?? (this.subtract ? 'TRUE' : 'FALSE'));
    }
    if (Object.prototype.hasOwnProperty.call(entity, 'subtractFrom')) {
      this.hasSubtractParentState = true;
      this.subtractFrom = Array.isArray(entity.subtractFrom) ? clone(entity.subtractFrom) : [];
    }
    if (entity.type === 'arc') {
      const circle = circleFromArcEntity(entity);
      if (!circle) return false;
      pointKeys('center', circle.center)
        .concat(pointKeys('start', entity.start), pointKeys('end', entity.end))
        .forEach(([name, value]) => this.setVariable(name, value));
      this.metadata = {
        ...this.metadata,
        ...arcMetadata(entity, circle, { retainedCcw: this.metadata.ccw }),
      };
      return true;
    }
    this.load({ ...entity, id: this.id });
    return true;
  }

  allVariables() {
    return [...this.variables.values()];
  }

  pointFeature(index = 0, pointRole = null) {
    if (this.type === 'point') return index === 0 ? this.point('point') : null;
    if (this.type === 'line') {
      if (index === 0) return this.point('start');
      if (index === 1) return midpoint(this.point('start'), this.point('end'));
      if (index === 2) return this.point('end');
    }
    if (this.type === 'text') return index === 0 ? this.point('anchor') : null;
    if (this.type === 'control') {
      if (index === 0) return this.point('anchor');
      if (index === 1 && (this.metadata.control?.controlType === 'horizontal-slider' || this.metadata.control?.controlType === 'vertical-slider')) return this.point('middle');
      return null;
    }
    if (this.type === 'table') {
      const x = this.value('x');
      const y = this.value('y');
      const width = this.value('width');
      const height = this.value('height');
      return [
        [x, y],
        [x + width, y],
        [x + width, y + height],
        [x, y + height],
      ][index] || null;
    }
    if (this.type === 'circle') {
      const center = this.point('center');
      const radius = Math.abs(this.value('radius'));
      return [center, [center[0] - radius, center[1]], [center[0], center[1] - radius], [center[0] + radius, center[1]], [center[0], center[1] + radius]][index] || null;
    }
    if (['polygon', 'polyline', 'curve'].includes(this.type)) return index < this.metadata.pointCount ? this.indexedPoint(index) : null;
    if (this.type === 'arc') {
      const arc = this.arcPoints();
      if (pointRole === ARC_MIDPOINT_ROLE) return arc.midpoint;
      return [arc.start, arc.arcPoint, arc.end, arc.center][index] || null;
    }
    return null;
  }

  segmentFeature(index = 0) {
    if (this.type === 'line' && index === 0) return { start: this.point('start'), end: this.point('end'), index };
    if (this.type === 'table' && index >= 0 && index < 4) {
      return { start: this.pointFeature(index), end: this.pointFeature((index + 1) % 4), index };
    }
    if (this.type === 'polygon' || this.type === 'polyline') {
      const closed = this.type === 'polygon';
      const limit = closed ? this.metadata.pointCount : this.metadata.pointCount - 1;
      if (index < 0 || index >= limit) return null;
      return { start: this.indexedPoint(index), end: this.indexedPoint((index + 1) % this.metadata.pointCount), index };
    }
    return null;
  }

  entityFeature() {
    if (this.type === 'circle') return { kind: 'circle', center: this.point('center'), radius: Math.abs(this.value('radius')) };
    if (this.type === 'arc') return { kind: 'arc', ...this.arcPoints() };
    if (this.type === 'curve') return { kind: 'curve', points: Array.from({ length: this.metadata.pointCount }, (_, index) => this.indexedPoint(index)) };
    return null;
  }

  variableIdsForPoint(index = 0, pointRole = null) {
    const ids = (...names) => names.map((name) => this.variables.get(name)?.id).filter(Boolean);
    if (this.type === 'point') return index === 0 ? ids('point.x', 'point.y') : [];
    if (this.type === 'line') {
      if (index === 0) return ids('start.x', 'start.y');
      if (index === 2) return ids('end.x', 'end.y');
      return this.allVariables().map((variable) => variable.id);
    }
    if (this.type === 'text') return index === 0 ? ids('anchor.x', 'anchor.y') : [];
    if (this.type === 'control') {
      if (index === 0) return ids('anchor.x', 'anchor.y');
      if (index === 1 && (this.metadata.control?.controlType === 'horizontal-slider' || this.metadata.control?.controlType === 'vertical-slider')) return ids('middle.x', 'middle.y');
      return [];
    }
    if (this.type === 'table') {
      if (index === 0) return ids('x', 'y');
      if (index === 1) return ids('x', 'y', 'width');
      if (index === 2) return ids('x', 'y', 'width', 'height');
      if (index === 3) return ids('x', 'y', 'height');
      return [];
    }
    if (this.type === 'circle') return index === 0 ? ids('center.x', 'center.y') : ids('radius');
    if (['polygon', 'polyline', 'curve'].includes(this.type)) return ids(`p${index}.x`, `p${index}.y`);
    if (this.type === 'arc') {
      if (pointRole === ARC_MIDPOINT_ROLE) return this.allVariables().map((variable) => variable.id);
      if (index === 0) return ids('start.x', 'start.y');
      if (index === 2) return ids('end.x', 'end.y');
      return this.allVariables().map((variable) => variable.id);
    }
    return [];
  }

  fixedVariableIdsForPoint(index = 0, pointRole = null) {
    if (this.type === 'line') {
      return index === 1 ? [] : this.variableIdsForPoint(index);
    }
    if (this.type === 'arc') {
      if (pointRole === ARC_MIDPOINT_ROLE) return [];
      return index === 0 || index === 2 ? this.variableIdsForPoint(index) : [];
    }
    if (this.type === 'circle') {
      return index === 0 ? this.variableIdsForPoint(index) : [];
    }
    return this.variableIdsForPoint(index);
  }

  variableIdsForSegment(index = 0) {
    if (this.type === 'line') return this.allVariables().map((variable) => variable.id);
    if (this.type === 'table') return index >= 0 && index < 4 ? this.allVariables().map((variable) => variable.id) : [];
    if (this.type === 'polygon' || this.type === 'polyline') {
      return [...this.variableIdsForPoint(index), ...this.variableIdsForPoint((index + 1) % this.metadata.pointCount)];
    }
    return [];
  }

  intrinsicResiduals() {
    if (this.type !== 'arc') return [];
    const metrics = this.arcMetrics();
    return [metrics.startRadius - metrics.endRadius];
  }
}

export function createGeometryBinding(entity) {
  return new GeometryBinding(entity);
}

// --- Sketch Graph Model ---
export class SketchModel {
  constructor() {
    this.entities = new Map();
    this.derivedEntities = new Map();
    this.constraints = new Map();
    this.variablesById = new Map();
  }

  indexBinding(binding, previousVariableIds = []) {
    const nextVariables = binding.allVariables();
    const nextVariableIds = new Set(nextVariables.map((variable) => variable.id));
    previousVariableIds.forEach((id) => {
      if (!nextVariableIds.has(id)) this.variablesById.delete(id);
    });
    nextVariables.forEach((variable) => this.variablesById.set(variable.id, variable));
  }

  unindexBinding(binding) {
    binding?.allVariables().forEach((variable) => this.variablesById.delete(variable.id));
  }

  addEntity(entity) {
    const binding = createGeometryBinding(entity);
    if (this.entities.has(binding.id)) throw new Error(`Duplicate entity ID: ${binding.id}`);
    this.entities.set(binding.id, binding);
    this.indexBinding(binding);
    return binding.toEntity();
  }

  updateEntity(entity) {
    const binding = this.entities.get(entity.id);
    if (!binding) throw new Error(`Unknown entity: ${entity.id}`);
    const previousVariableIds = binding.allVariables().map((variable) => variable.id);
    if (!binding.updateFromEntity(entity)) throw new Error(`Invalid ${entity.type} geometry.`);
    this.indexBinding(binding, previousVariableIds);
    return binding.toEntity();
  }

  removeEntity(entityId, { constraintIds = null } = {}) {
    this.unindexBinding(this.entities.get(entityId));
    const removed = this.entities.delete(entityId);
    if (constraintIds) {
      for (const constraintId of constraintIds) this.constraints.delete(constraintId);
    } else {
      for (const [constraintId, constraint] of this.constraints) {
        const text = JSON.stringify(constraint);
        if (text.includes(`"${entityId}"`)) this.constraints.delete(constraintId);
      }
    }
    return removed;
  }

  clear() {
    this.entities.clear();
    this.derivedEntities.clear();
    this.constraints.clear();
    this.variablesById.clear();
  }

  setDerivedEntity(entity) {
    if (!entity?.id) throw new Error('Derived entity requires a stable ID.');
    this.derivedEntities.set(entity.id, clone(entity));
    return clone(entity);
  }

  removeDerivedEntity(entityId) {
    return this.derivedEntities.delete(entityId);
  }

  derivedEntity(entityId) {
    const entity = this.derivedEntities.get(entityId);
    return entity ? clone(entity) : null;
  }

  addConstraint(input) {
    return this.addConstraints([input])[0];
  }

  addConstraints(inputs = []) {
    const constraints = inputs.map((input) => {
      const constraint = clone({ ...input, id: input.id || createStableId('constraint'), enabled: input.enabled !== false });
      if (constraint.type === 'Fixed' && !constraint.fixedPoint) {
        const pointRef = constraint.featureRefs?.find((ref) => ref.kind === 'point' || ref.type === 'point');
        const point = pointRef && this.resolvePoint(pointRef);
        if (point) constraint.fixedPoint = [...point];
      }
      return constraint;
    });
    constraints.forEach((constraint) => this.constraints.set(constraint.id, constraint));
    if (constraints.length) this.refreshFixedVariables();
    return constraints.map(clone);
  }

  removeConstraint(constraintId) {
    return this.removeConstraints([constraintId]) > 0;
  }

  removeConstraints(constraintIds) {
    let removedCount = 0;
    for (const constraintId of constraintIds) {
      if (this.constraints.delete(constraintId)) removedCount += 1;
    }
    if (removedCount) this.refreshFixedVariables();
    return removedCount;
  }

  refreshFixedVariables() {
    this.allVariables().forEach((variable) => { variable.fixed = false; });
    for (const constraint of this.constraints.values()) {
      if (constraint.enabled === false || constraint.type !== 'Fixed') continue;
      for (const feature of constraint.featureRefs || []) {
        const binding = this.binding(feature?.entityId || feature?.recordId);
        const variableIds = binding && (feature.kind === 'point' || feature.type === 'point')
          ? binding.fixedVariableIdsForPoint(feature.index || 0, feature.pointRole)
          : this.variableIdsForFeature(feature);
        variableIds.forEach((id) => {
          const variable = this.variableById(id);
          if (variable) variable.fixed = true;
        });
      }
    }
  }

  binding(entityId) {
    return this.entities.get(entityId) || null;
  }

  entity(entityId) {
    return this.binding(entityId)?.toEntity() || null;
  }

  snapshot() {
    return [...this.entities.values()].map((binding) => binding.toEntity());
  }

  allVariables() {
    return [...this.entities.values()].flatMap((binding) => binding.allVariables());
  }

  activeVariables() {
    return this.allVariables().filter((variable) => variable.active);
  }

  variableById(id) {
    return this.variablesById.get(id) || null;
  }

  resolvePoint(ref) {
    if (!ref) return null;
    if (isCanvasOriginReference(ref)) return [0, 0];
    const binding = this.binding(ref.entityId || ref.recordId);
    if (!binding) return null;
    if (ref.type === 'segment-start' || ref.type === 'segment-end') {
      const segment = binding.segmentFeature(ref.index || 0);
      return segment ? [...(ref.type === 'segment-start' ? segment.start : segment.end)] : null;
    }
    if (ref.type === 'segment-point') {
      const segment = binding.segmentFeature(ref.index || 0);
      if (!segment) return null;
      const ratio = Math.max(0, Math.min(1, Number(ref.ratio) || 0));
      return [
        segment.start[0] + (segment.end[0] - segment.start[0]) * ratio,
        segment.start[1] + (segment.end[1] - segment.start[1]) * ratio,
      ];
    }
    if (ref.type === 'center') return binding.entityFeature()?.center || null;
    return binding.pointFeature(ref.index || 0, ref.pointRole);
  }

  resolveSegment(ref) {
    if (!ref) return null;
    return this.binding(ref.entityId || ref.recordId)?.segmentFeature(ref.index || 0) || null;
  }

  resolveEntity(ref) {
    if (!ref) return null;
    return this.binding(ref.entityId || ref.recordId)?.entityFeature() || null;
  }

  resolveFeature(ref) {
    if (ref?.kind === 'point') return { kind: 'point', point: this.resolvePoint(ref) };
    if (ref?.kind === 'segment') return { kind: 'segment', ...this.resolveSegment(ref) };
    return this.resolveEntity(ref);
  }

  variableIdsForFeature(ref) {
    if (isCanvasOriginReference(ref)) return [];
    const binding = this.binding(ref?.entityId || ref?.recordId);
    if (!binding) return [];
    if (ref.kind === 'point' || ref.type === 'point') return binding.variableIdsForPoint(ref.index || 0, ref.pointRole);
    if (
      ref.kind === 'segment'
      || ref.type === 'segment-start'
      || ref.type === 'segment-end'
      || ref.type === 'segment-point'
    ) return binding.variableIdsForSegment(ref.index || 0);
    if (ref.kind === 'circle' || ref.kind === 'arc' || ref.type === 'center' || ref.type === 'radius') return binding.allVariables().map((variable) => variable.id);
    return binding.allVariables().map((variable) => variable.id);
  }

  intrinsicResiduals() {
    return [...this.entities.values()].flatMap((binding) => binding.intrinsicResiduals());
  }
}
