import { ARC_MIDPOINT_ROLE } from '../ArcGeometry.js';
import { createVariableColumnMap } from './JacobianBlocks.js';

function dimensionalTarget(constraint, dimensions) {
  return Number(constraint.dimensionRef ? dimensions.value(constraint.dimensionRef) : constraint.value);
}

function sameLength(first, second) {
  return Math.abs(first - second) <= Math.max(1e-9, Math.max(Math.abs(first), Math.abs(second)) * 1e-10);
}

function pointReferenceKey(model, reference) {
  const recordId = reference?.recordId;
  if (!recordId) return null;
  const type = reference.kind || reference.type;
  if (type === 'point') {
    return reference.pointRole === ARC_MIDPOINT_ROLE
      ? `${recordId}:${ARC_MIDPOINT_ROLE}`
      : `${recordId}:${Number(reference.index) || 0}`;
  }
  if (type !== 'segment-start' && type !== 'segment-end') return null;
  const binding = model.binding?.(recordId);
  if (!binding) return null;
  const segmentIndex = Number(reference.index) || 0;
  if (binding.type === 'line' || binding.type === 'arc') {
    return `${recordId}:${type === 'segment-start' ? 0 : 2}`;
  }
  if (binding.type === 'polygon' || binding.type === 'polyline') {
    const pointCount = binding.metadata?.pointCount || 0;
    if (!pointCount) return null;
    const pointIndex = type === 'segment-start'
      ? segmentIndex
      : (segmentIndex + 1) % pointCount;
    return `${recordId}:${pointIndex}`;
  }
  return null;
}

function coincidentPointRootResolver(model, constraints) {
  const parents = new Map();
  const find = (key) => {
    if (!parents.has(key)) parents.set(key, key);
    const parent = parents.get(key);
    if (parent === key) return key;
    const root = find(parent);
    parents.set(key, root);
    return root;
  };
  const union = (first, second) => {
    const firstRoot = find(first);
    const secondRoot = find(second);
    if (firstRoot !== secondRoot) parents.set(secondRoot, firstRoot);
  };
  for (const constraint of constraints) {
    if (constraint.enabled === false || constraint.type !== 'Coincident') continue;
    const keys = (constraint.featureRefs || [])
      .map((reference) => pointReferenceKey(model, reference))
      .filter(Boolean);
    if (keys.length >= 2) union(keys[0], keys[1]);
  }
  return (reference) => {
    const key = pointReferenceKey(model, reference);
    return key ? find(key) : null;
  };
}

function chordTarget(constraints, dimensions, binding, rootForReference) {
  const roots = [0, 2].map((index) => rootForReference({ type: 'point', recordId: binding.id, index }));
  for (const constraint of constraints) {
    // Only a Euclidean distance in the arc's coordinate system proves its chord.
    if (constraint.type !== 'Distance' || constraint.coordinateSpace === 'global') continue;
    const first = rootForReference(constraint.anchors?.start || constraint.featureRefs?.[0]);
    const second = rootForReference(constraint.anchors?.end || constraint.featureRefs?.[1]);
    if ((first === roots[0] && second === roots[1]) || (first === roots[1] && second === roots[0])) {
      const value = dimensionalTarget(constraint, dimensions);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  const fixedPoints = new Map();
  for (const constraint of constraints) {
    if (constraint.type !== 'Fixed' || constraint.coordinateSpace === 'global' || !constraint.fixedPoint) continue;
    const ref = constraint.featureRefs?.find((reference) => (reference.kind || reference.type) === 'point');
    const root = rootForReference(ref);
    if (root) fixedPoints.set(root, constraint.fixedPoint);
  }
  const points = ['start', 'end'].map((prefix, index) => {
    if (fixedPoints.has(roots[index])) return fixedPoints.get(roots[index]);
    return ['x', 'y'].every((axis) => !binding.variables.get(`${prefix}.${axis}`).active)
      ? binding.point(prefix) : null;
  });
  return points.every(Boolean) ? Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]) : null;
}

/**
 * Reduce an arc center only when this solve's constraints require a diameter
 * chord. A semicircle in the starting geometry alone is not such a constraint.
 * The reduction is local to the solve: no variable locks or drawing constraints
 * are changed. All original residuals still participate in convergence checks.
 */
export function prepareArcSolveGeometry(model, dimensions, originalVariables) {
  const constraints = [...(model.constraints?.values?.() || [])].filter((constraint) => constraint.enabled !== false);
  // Local coincidence is safe to use for local arc coordinates. Cross-stack
  // coincidence must retain its transform and cannot identify local points.
  const rootForReference = coincidentPointRootResolver(model, constraints.filter((constraint) => constraint.coordinateSpace !== 'global'));
  const activeIds = new Set(originalVariables.map((variable) => variable.id));
  const dependencies = new Map();
  const projected = [];
  const visited = new Set();
  let seeded = false;
  for (const constraint of constraints) {
    if (constraint.type !== 'Radius' || constraint.coordinateSpace === 'global') continue;
    const binding = model.binding(constraint.featureRefs?.[0]?.recordId);
    if (binding?.type !== 'arc' || visited.has(binding.id)) continue;
    visited.add(binding.id);
    const centers = ['x', 'y'].map((axis) => binding.variables.get(`center.${axis}`));
    if (!centers.every((variable) => activeIds.has(variable.id))) continue;
    const radius = dimensionalTarget(constraint, dimensions);
    if (!Number.isFinite(radius) || radius <= 0) continue;
    const chord = chordTarget(constraints, dimensions, binding, rootForReference);
    if (chord === null) continue;
    if (sameLength(chord, 2 * radius)) {
      for (const axis of ['x', 'y']) {
        dependencies.set(binding.variables.get(`center.${axis}`).id,
          ['start', 'end'].map((prefix) => ({ variable: binding.variables.get(`${prefix}.${axis}`), weight: 0.5 })));
      }
      projected.push(binding);
    } else if (chord < 2 * radius) {
      const start = binding.point('start');
      const end = binding.point('end');
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const length = Math.hypot(dx, dy);
      if (length === 0) continue;
      const midpoint = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
      const offset = ((centers[0].value - midpoint[0]) * -dy + (centers[1].value - midpoint[1]) * dx) / length;
      // At an exactly straight diameter the radius derivative in this direction
      // is zero. Seed the branch from the requested chord, then let the original
      // equations solve freely. Retain an existing side; at the limit choose the
      // minor arc with the saved winding, independent of world orientation.
      if (Math.abs(offset) <= Math.max(1e-10, length * 1e-10)) {
        const side = offset < -1e-12 ? -1 : offset > 1e-12 ? 1 : binding.metadata.ccw ? 1 : -1;
        const height = side * Math.sqrt((radius - chord / 2) * (radius + chord / 2));
        centers[0].value = midpoint[0] - dy / length * height;
        centers[1].value = midpoint[1] + dx / length * height;
        seeded = true;
      }
    }
  }
  const variables = originalVariables.filter((variable) => !dependencies.has(variable.id));
  const columnByVariableId = createVariableColumnMap(variables);
  const project = () => {
    for (const binding of projected) {
      for (const axis of ['x', 'y']) {
        binding.variables.get(`center.${axis}`).value =
          (binding.variables.get(`start.${axis}`).value + binding.variables.get(`end.${axis}`).value) / 2;
      }
    }
  };
  const reduceBlocks = (contract) => {
    if (!dependencies.size) return contract;
    const blocks = contract.blocks.map((block) => {
      const sources = block.variables.map((variable) => (dependencies.get(variable.id) || [{ variable, weight: 1 }])
        .filter((entry) => columnByVariableId.has(entry.variable.id)));
      const local = [...new Map(sources.flat().map(({ variable }) => [variable.id, variable])).values()];
      const localColumns = createVariableColumnMap(local);
      return {
        ...block,
        variables: local,
        variableIds: local.map((variable) => variable.id),
        columnIndexes: local.map((variable) => columnByVariableId.get(variable.id)),
        evaluateResiduals: () => { project(); return block.evaluateResiduals(); },
        evaluateAnalyticalJacobian: () => {
          project();
          const original = block.evaluateAnalyticalJacobian?.();
          if (!original) return null;
          return original.map((row) => {
            const reduced = Array(local.length).fill(0);
            row.forEach((value, column) => {
              for (const { variable, weight } of sources[column]) reduced[localColumns.get(variable.id)] += value * weight;
            });
            return reduced;
          });
        },
      };
    });
    return { ...contract, variables, columnByVariableId, blocks };
  };
  return { variables, project, reduceBlocks, changed: seeded || projected.length > 0, reducedArcCenters: projected.length };
}
