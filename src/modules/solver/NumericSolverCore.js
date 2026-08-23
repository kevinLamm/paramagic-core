import { evaluateFillet } from '../FilletSystem.js';
import { ParameterRepository } from './ParameterRepository.js';
import {
  assembleJacobianBlocks,
  createMatrixFreeJacobian,
  JacobianBlockCancellationError,
} from './JacobianBlocks.js';
import { ARC_MIDPOINT_ROLE } from '../ArcGeometry.js';

// --- DimensionRepository Compatibility ---
export class DimensionRepository extends ParameterRepository {}
export { ParameterRepository };

// --- Solver Diagnostics Helpers ---
export function isSuccessfulSolve(result) {
  return result?.status === 'converged' || result?.status === 'unchanged';
}

export function solverMessage(result) {
  if (!result) return 'Solver did not return a result.';
  return result.message || `Solver status: ${result.status}`;
}

// --- Linear Algebra Math Utilities ---
export function transpose(matrix) {
  if (!matrix.length) return [];
  return Array.from({ length: matrix[0].length }, (_, column) => matrix.map((row) => row[column]));
}

export class SolverCancellationError extends Error {
  constructor(reason = 'cancelled') {
    super(`Solver cancelled: ${reason}.`);
    this.name = 'SolverCancellationError';
    this.reason = reason;
  }
}

function cancellationReason(shouldCancel) {
  const reason = shouldCancel?.();
  if (!reason) return null;
  return reason === true ? 'cancelled' : String(reason);
}

function throwIfCancelled(shouldCancel) {
  const reason = cancellationReason(shouldCancel);
  if (reason) throw new SolverCancellationError(reason);
}

export function multiply(left, right, shouldCancel = null) {
  if (!left.length || !right.length) return [];
  const result = Array.from({ length: left.length }, () => Array(right[0].length).fill(0));
  for (let row = 0; row < left.length; row += 1) {
    throwIfCancelled(shouldCancel);
    for (let inner = 0; inner < right.length; inner += 1) {
      for (let column = 0; column < right[0].length; column += 1) result[row][column] += left[row][inner] * right[inner][column];
    }
  }
  return result;
}

export function multiplyMatrixVector(matrix, vector, shouldCancel = null) {
  return matrix.map((row) => {
    throwIfCancelled(shouldCancel);
    return row.reduce((sum, value, index) => sum + value * vector[index], 0);
  });
}

export function squaredNorm(vector) {
  return vector.reduce((sum, value) => sum + value * value, 0);
}

export function solveLinearSystem(matrix, vector, pivotTolerance = 1e-12, shouldCancel = null) {
  const size = matrix.length;
  if (size === 0) return [];
  if (matrix.some((row) => row.length !== size) || vector.length !== size) throw new Error('Linear system dimensions do not match.');
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    throwIfCancelled(shouldCancel);
    let pivotRow = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivotRow][column])) pivotRow = row;
    }
    if (Math.abs(augmented[pivotRow][column]) < pivotTolerance) throw new Error('Singular or ill-conditioned linear system.');
    [augmented[column], augmented[pivotRow]] = [augmented[pivotRow], augmented[column]];
    for (let row = column + 1; row < size; row += 1) {
      const factor = augmented[row][column] / augmented[column][column];
      for (let item = column; item <= size; item += 1) augmented[row][item] -= factor * augmented[column][item];
    }
  }
  const solution = Array(size).fill(0);
  for (let row = size - 1; row >= 0; row -= 1) {
    let value = augmented[row][size];
    for (let column = row + 1; column < size; column += 1) value -= augmented[row][column] * solution[column];
    solution[row] = value / augmented[row][row];
    if (!Number.isFinite(solution[row])) throw new Error('Linear solve produced a non-finite value.');
  }
  return solution;
}

function vectorDot(left, right) {
  let value = 0;
  for (let index = 0; index < left.length; index += 1) value += left[index] * right[index];
  return value;
}

function choleskyFactor(normalBlock, damping) {
  const size = normalBlock.columnIndexes.length;
  const factor = Array.from({ length: size }, () => new Float64Array(size));
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column <= row; column += 1) {
      let value = normalBlock.values[row][column];
      if (row === column) value += damping[normalBlock.columnIndexes[row]];
      for (let inner = 0; inner < column; inner += 1) {
        value -= factor[row][inner] * factor[column][inner];
      }
      if (row === column) {
        if (!Number.isFinite(value) || value <= 1e-20) return null;
        factor[row][column] = Math.sqrt(value);
      } else {
        factor[row][column] = value / factor[column][column];
      }
    }
  }
  return factor;
}

function createMatrixFreePreconditioner(operator, damping) {
  const useEntityBlocks = operator.normalBlocks?.some((block) => block.columnIndexes.length > 1);
  if (!useEntityBlocks) {
    const inverseDiagonal = Float64Array.from(operator.diagonal, (value, column) => (
      1 / Math.max(value + damping[column], 1e-20)
    ));
    return {
      kind: 'diagonal',
      apply(input, output) {
        for (let column = 0; column < operator.columnCount; column += 1) {
          output[column] = input[column] * inverseDiagonal[column];
        }
        return output;
      },
    };
  }
  const blocks = operator.normalBlocks;
  const factoredBlocks = blocks.map((block) => {
    const factor = choleskyFactor(block, damping);
    return {
      columnIndexes: block.columnIndexes,
      factor,
      workspace: new Float64Array(block.columnIndexes.length),
      diagonalFallback: factor ? null : Float64Array.from(block.columnIndexes, (column) => (
        1 / Math.max(operator.diagonal[column] + damping[column], 1e-20)
      )),
    };
  });
  return {
    kind: 'entity-block',
    apply(input, output) {
      output.fill(0);
      for (const block of factoredBlocks) {
        const { columnIndexes, factor, workspace, diagonalFallback } = block;
        if (!factor) {
          for (let local = 0; local < columnIndexes.length; local += 1) {
            output[columnIndexes[local]] = input[columnIndexes[local]] * diagonalFallback[local];
          }
          continue;
        }
        for (let row = 0; row < columnIndexes.length; row += 1) {
          let value = input[columnIndexes[row]];
          for (let column = 0; column < row; column += 1) value -= factor[row][column] * workspace[column];
          workspace[row] = value / factor[row][row];
        }
        for (let row = columnIndexes.length - 1; row >= 0; row -= 1) {
          let value = workspace[row];
          for (let column = row + 1; column < columnIndexes.length; column += 1) {
            value -= factor[column][row] * output[columnIndexes[column]];
          }
          output[columnIndexes[row]] = value / factor[row][row];
        }
      }
      return output;
    },
  };
}

export function solveMatrixFreeDampedLeastSquares(operator, errors, lambda, {
  maxIterations = Math.min(1000, Math.max(32, operator.columnCount * 2)),
  relativeTolerance = 1e-9,
  absoluteTolerance = 1e-12,
  shouldCancel = null,
} = {}) {
  if (errors.length !== operator.rowCount) {
    throw new Error('Matrix-free residual dimensions do not match the Jacobian operator.');
  }
  const size = operator.columnCount;
  const step = new Float64Array(size);
  if (!size) return { step, iterations: 0, converged: true, residualNorm: 0 };

  const damping = new Float64Array(size);
  for (let index = 0; index < size; index += 1) {
    damping[index] = lambda * Math.max(Math.abs(operator.diagonal[index]), 1) + 1e-7;
  }
  const preconditioner = createMatrixFreePreconditioner(operator, damping);

  const rhs = operator.applyJacobianTranspose(errors, new Float64Array(size));
  for (let index = 0; index < size; index += 1) rhs[index] = -rhs[index];
  const rhsNormSquared = vectorDot(rhs, rhs);
  const targetNormSquared = Math.max(
    absoluteTolerance * absoluteTolerance,
    relativeTolerance * relativeTolerance * rhsNormSquared,
  );
  if (rhsNormSquared <= targetNormSquared) {
    return {
      step,
      iterations: 0,
      converged: true,
      residualNorm: Math.sqrt(rhsNormSquared),
      preconditioner: preconditioner.kind,
    };
  }

  const residual = Float64Array.from(rhs);
  const preconditioned = new Float64Array(size);
  const direction = new Float64Array(size);
  const normalProduct = new Float64Array(size);
  const jacobianProduct = new Float64Array(operator.rowCount);
  preconditioner.apply(residual, preconditioned);
  direction.set(preconditioned);
  let residualPreconditioned = vectorDot(residual, preconditioned);
  let residualNormSquared = vectorDot(residual, residual);
  let completedIterations = 0;

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    completedIterations = iteration;
    throwIfCancelled(shouldCancel);
    operator.applyJacobian(direction, jacobianProduct);
    operator.applyJacobianTranspose(jacobianProduct, normalProduct);
    for (let index = 0; index < size; index += 1) {
      normalProduct[index] += damping[index] * direction[index];
    }
    const curvature = vectorDot(direction, normalProduct);
    if (!Number.isFinite(curvature) || curvature <= 1e-30) {
      throw new Error('Matrix-free linear solve encountered non-positive curvature.');
    }
    const alpha = residualPreconditioned / curvature;
    if (!Number.isFinite(alpha)) throw new Error('Matrix-free linear solve produced a non-finite step.');
    for (let index = 0; index < size; index += 1) {
      step[index] += alpha * direction[index];
      residual[index] -= alpha * normalProduct[index];
    }
    residualNormSquared = vectorDot(residual, residual);
    if (residualNormSquared <= targetNormSquared) {
      return {
        step,
        iterations: iteration,
        converged: true,
        residualNorm: Math.sqrt(residualNormSquared),
        preconditioner: preconditioner.kind,
      };
    }
    preconditioner.apply(residual, preconditioned);
    const nextResidualPreconditioned = vectorDot(residual, preconditioned);
    if (!Number.isFinite(nextResidualPreconditioned) || Math.abs(residualPreconditioned) <= 1e-30) break;
    const beta = nextResidualPreconditioned / residualPreconditioned;
    for (let index = 0; index < size; index += 1) {
      direction[index] = preconditioned[index] + beta * direction[index];
    }
    residualPreconditioned = nextResidualPreconditioned;
  }

  return {
    step,
    iterations: completedIterations,
    converged: false,
    residualNorm: Math.sqrt(residualNormSquared),
    preconditioner: preconditioner.kind,
  };
}

// --- Numerical Jacobian Matrix Computation ---
export function computeJacobian(variables, evaluate, baseErrors = evaluate(), baseDelta = 1e-6, shouldCancel = null) {
  const jacobian = Array.from({ length: baseErrors.length }, () => Array(variables.length).fill(0));
  variables.forEach((variable, column) => {
    throwIfCancelled(shouldCancel);
    const original = variable.value;
    const delta = baseDelta * Math.max(1, Math.abs(original));
    try {
      variable.value = original + delta;
      const perturbed = evaluate();
      if (perturbed.length !== baseErrors.length) throw new Error('Residual count changed during Jacobian evaluation.');
      perturbed.forEach((value, row) => { jacobian[row][column] = (value - baseErrors[row]) / delta; });
    } finally {
      variable.value = original;
    }
  });
  return jacobian;
}

// --- Constraint Residual Functions ---
const subtract = (a, b) => [a[0] - b[0], a[1] - b[1]];
const scale = (point, value) => [point[0] * value, point[1] * value];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const length2 = (v) => dot(v, v);
const length = (v) => Math.hypot(v[0], v[1]);
const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const pointDistance2 = (a, b) => length2(subtract(a, b));
const safeScale = (...values) => Math.max(1, ...values.map((value) => Math.abs(value)));
const tau = Math.PI * 2;
const normalizeAngle = (angle) => (angle + tau) % tau;
const angleDistance = (a, b) => Math.min(normalizeAngle(a - b), normalizeAngle(b - a));

function required(value, message) {
  if (!value || (Array.isArray(value) && value.some((item) => !Number.isFinite(item)))) throw new Error(message);
  return value;
}

function point(model, ref) {
  return required(model.resolvePoint(ref), 'Constraint requires a valid point feature.');
}

function segment(model, ref) {
  return required(model.resolveSegment(ref), 'Constraint requires a valid segment feature.');
}

function entity(model, ref) {
  return required(model.resolveEntity(ref), 'Constraint requires a valid circle, arc, or curve feature.');
}

export function arcLength(arc) {
  const startAngle = Math.atan2(arc.start[1] - arc.center[1], arc.start[0] - arc.center[0]);
  const endAngle = Math.atan2(arc.end[1] - arc.center[1], arc.end[0] - arc.center[0]);
  const sweep = arc.ccw ? normalizeAngle(endAngle - startAngle) : normalizeAngle(startAngle - endAngle);
  return Math.abs(arc.radius) * sweep;
}

export function featureLength(model, ref) {
  if (ref?.kind === 'segment') {
    const line = segment(model, ref);
    return length(subtract(line.end, line.start));
  }
  if (ref?.kind === 'arc') {
    const binding = model.binding?.(ref.recordId || ref.entityId);
    const metrics = binding?.type === 'arc' ? binding.arcMetrics?.() : null;
    return metrics?.length ?? arcLength(entity(model, ref));
  }
  throw new Error('Length requires a line segment or arc feature.');
}

function target(constraint, dimensions) {
  if (constraint.dimensionRef) return dimensions.value(constraint.dimensionRef);
  if (Number.isFinite(constraint.value)) return constraint.value;
  throw new Error('Dimensional constraint requires a finite target.');
}

function normalizedLineCross(pointValue, line) {
  const direction = subtract(line.end, line.start);
  return cross(subtract(pointValue, line.start), direction) / safeScale(length(direction));
}

function projectionOnSegment(pointValue, line, projectionMode = 'segment') {
  const direction = subtract(line.end, line.start);
  const sizeSquared = length2(direction);
  if (sizeSquared < 1e-12) return line.start;
  const rawRatio = dot(subtract(pointValue, line.start), direction) / sizeSquared;
  const ratio = projectionMode === 'line' ? rawRatio : Math.max(0, Math.min(1, rawRatio));
  return [line.start[0] + direction[0] * ratio, line.start[1] + direction[1] * ratio];
}

function derivedFilletArc(model, ref, dimensions) {
  const definition = required(model.derivedEntity(ref?.recordId), 'Constraint requires a valid fillet feature.');
  const radius = definition.radiusDimensionId
    ? dimensions.value(definition.radiusDimensionId)
    : definition.radius;
  const fillet = { ...definition, radius };
  const entities = new Map([
    [fillet.sourceA.recordId, model.entity(fillet.sourceA.recordId)],
    [fillet.sourceB.recordId, model.entity(fillet.sourceB.recordId)],
  ]);
  const evaluated = evaluateFillet(fillet, entities);
  return required(evaluated.valid ? evaluated.arc : null, evaluated.error || 'Fillet geometry is invalid.');
}

function pointOnArcResidual(pointValue, arc) {
  const measured = pointDistance2(pointValue, arc.center);
  const radial = (measured - arc.radius ** 2) / safeScale(measured, arc.radius ** 2);
  const startAngle = Math.atan2(arc.start[1] - arc.center[1], arc.start[0] - arc.center[0]);
  const endAngle = Math.atan2(arc.end[1] - arc.center[1], arc.end[0] - arc.center[0]);
  const pointAngle = Math.atan2(pointValue[1] - arc.center[1], pointValue[0] - arc.center[0]);
  const span = arc.ccw ? normalizeAngle(endAngle - startAngle) : normalizeAngle(startAngle - endAngle);
  const traveled = arc.ccw ? normalizeAngle(pointAngle - startAngle) : normalizeAngle(startAngle - pointAngle);
  const domain = traveled <= span + 1e-9 ? 0 : Math.min(angleDistance(pointAngle, startAngle), angleDistance(pointAngle, endAngle));
  return [radial, domain];
}

export const residualImplementations = {
  Coincident(model, constraint) {
    const [a, b] = constraint.featureRefs.map((ref) => point(model, ref));
    return [a[0] - b[0], a[1] - b[1]];
  },
  Horizontal(model, constraint) {
    const line = segment(model, constraint.featureRefs[0]);
    return [line.start[1] - line.end[1]];
  },
  Vertical(model, constraint) {
    const line = segment(model, constraint.featureRefs[0]);
    return [line.start[0] - line.end[0]];
  },
  Parallel(model, constraint) {
    const [a, b] = constraint.featureRefs.map((ref) => segment(model, ref));
    const av = subtract(a.end, a.start);
    const bv = subtract(b.end, b.start);
    return [cross(av, bv) / safeScale(length(av) * length(bv))];
  },
  Perpendicular(model, constraint) {
    const [a, b] = constraint.featureRefs.map((ref) => segment(model, ref));
    const av = subtract(a.end, a.start);
    const bv = subtract(b.end, b.start);
    return [dot(av, bv) / safeScale(length(av) * length(bv))];
  },
  'Point-on Line'(model, constraint) {
    return [normalizedLineCross(point(model, constraint.featureRefs[0]), segment(model, constraint.featureRefs[1]))];
  },
  'Point Line Distance'(model, constraint, dimensions) {
    const pointValue = point(model, constraint.featureRefs[0]);
    const projected = projectionOnSegment(
      pointValue,
      segment(model, constraint.featureRefs[1]),
      constraint.projectionMode,
    );
    const desired = target(constraint, dimensions);
    if (constraint.subtype === 'horizontal') {
      const sign = constraint.orientation || Math.sign(pointValue[0] - projected[0]) || 1;
      return [pointValue[0] - projected[0] - sign * desired];
    }
    if (constraint.subtype === 'vertical') {
      const sign = constraint.orientation || Math.sign(pointValue[1] - projected[1]) || 1;
      return [pointValue[1] - projected[1] - sign * desired];
    }
    const measured2 = pointDistance2(pointValue, projected);
    return [(measured2 - desired ** 2) / safeScale(measured2, desired ** 2)];
  },
  'Line Line Distance'(model, constraint, dimensions) {
    const [reference, measured] = constraint.featureRefs.map((ref) => segment(model, ref));
    const referenceDirection = subtract(reference.end, reference.start);
    const measuredDirection = subtract(measured.end, measured.start);
    const referenceLength = length(referenceDirection);
    const measuredLength = length(measuredDirection);
    const measuredMidpoint = [
      (measured.start[0] + measured.end[0]) / 2,
      (measured.start[1] + measured.end[1]) / 2,
    ];
    const offset = subtract(measuredMidpoint, reference.start);
    const signedDistance = cross(referenceDirection, offset) / safeScale(referenceLength);
    const desired = target(constraint, dimensions);
    const orientation = Math.sign(Number(constraint.orientation)) || Math.sign(signedDistance) || 1;
    return [
      cross(referenceDirection, measuredDirection) / safeScale(referenceLength * measuredLength),
      signedDistance - orientation * desired,
    ];
  },
  Collinear(model, constraint) {
    const [driver, follower] = constraint.featureRefs.map((ref) => segment(model, ref));
    return [normalizedLineCross(follower.start, driver), normalizedLineCross(follower.end, driver)];
  },
  Equal(model, constraint) {
    const refs = constraint.featureRefs || [];
    const kind = refs[0]?.kind;
    if (refs.length !== 2 || kind !== refs[1]?.kind) {
      throw new Error('Equal requires two segments, two arcs, or two circles.');
    }
    if (kind === 'segment') {
      const [a, b] = refs.map((ref) => segment(model, ref));
      const a2 = pointDistance2(a.start, a.end);
      const b2 = pointDistance2(b.start, b.end);
      return [(a2 - b2) / safeScale(a2, b2)];
    }
    if (kind === 'arc') {
      const [a, b] = refs.map((ref) => featureLength(model, ref));
      return [(a - b) / safeScale(a, b)];
    }
    if (kind === 'circle') {
      const [a, b] = refs.map((ref) => entity(model, ref).radius);
      return [(a - b) / safeScale(a, b)];
    }
    throw new Error('Equal requires two segments, two arcs, or two circles.');
  },
  Length(model, constraint) {
    const refs = constraint.featureRefs || [];
    if (refs.length !== 1 || !['segment', 'arc'].includes(refs[0]?.kind)) {
      throw new Error('Length requires one line segment or arc feature.');
    }
    const desired = Number(constraint.value);
    if (!Number.isFinite(desired) || desired <= 0) throw new Error('Length requires a positive finite target.');
    const measured = featureLength(model, refs[0]);
    return [(measured - desired) / safeScale(measured, desired)];
  },
  Midpoint(model, constraint) {
    const p = point(model, constraint.featureRefs[0]);
    const line = segment(model, constraint.featureRefs[1]);
    const middle = midpoint(line.start, line.end);
    return [p[0] - middle[0], p[1] - middle[1]];
  },
  Concentric(model, constraint) {
    const [a, b] = constraint.featureRefs.map((ref) => entity(model, ref));
    return [a.center[0] - b.center[0], a.center[1] - b.center[1]];
  },
  Tangent(model, constraint) {
    const lineRef = constraint.featureRefs.find((ref) => ref.kind === 'segment');
    const roundRefs = constraint.featureRefs.filter((ref) => ref.kind === 'circle' || ref.kind === 'arc');
    if (lineRef && roundRefs.length === 1) {
      const line = segment(model, lineRef);
      const round = entity(model, roundRefs[0]);
      const direction = subtract(line.end, line.start);
      const tangentOrientation = Math.sign(Number(constraint.tangentOrientation));
      let branchResidual = null;
      if (tangentOrientation) {
        const referencePoint = constraint.tangentPoint
          ? point(model, constraint.tangentPoint)
          : line.start;
        const centerOffset = subtract(round.center, referencePoint);
        const tangentScale = Math.max(1e-12, length(direction) * Math.abs(round.radius));
        const signedDistanceRatio = cross(direction, centerOffset)
          / tangentScale;
        branchResidual = Math.min(0, tangentOrientation * signedDistanceRatio);
      }
      if (roundRefs[0].kind === 'arc' && constraint.tangentPoint) {
        const tangentPoint = point(model, constraint.tangentPoint);
        const radial = subtract(round.center, tangentPoint);
        const tangentResidual = dot(direction, radial) / safeScale(length(direction) * round.radius);
        return branchResidual === null ? [tangentResidual] : [tangentResidual, branchResidual];
      }
      const denominator = Math.max(1e-12, length2(direction));
      const area = cross(direction, subtract(round.center, line.start));
      const distanceSquared = (area * area) / denominator;
      const tangentResidual = (distanceSquared - round.radius ** 2)
        / safeScale(distanceSquared, round.radius ** 2);
      return branchResidual === null ? [tangentResidual] : [tangentResidual, branchResidual];
    }
    if (!lineRef && roundRefs.length === 2) {
      const [a, b] = roundRefs.map((ref) => entity(model, ref));
      const centerDistanceSquared = pointDistance2(a.center, b.center);
      const targetDistance = constraint.tangentMode === 'internal'
        ? Math.abs(a.radius - b.radius)
        : a.radius + b.radius;
      const targetDistanceSquared = targetDistance ** 2;
      return [(centerDistanceSquared - targetDistanceSquared) / safeScale(centerDistanceSquared, targetDistanceSquared)];
    }
    throw new Error('Tangent requires a line and a circle/arc, or two circles/arcs.');
  },
  'Point-on Circle'(model, constraint) {
    const p = point(model, constraint.featureRefs[0]);
    const round = entity(model, constraint.featureRefs[1]);
    const measured = pointDistance2(p, round.center);
    return [(measured - round.radius ** 2) / safeScale(measured, round.radius ** 2)];
  },
  'Point-on Arc'(model, constraint) {
    const p = point(model, constraint.featureRefs[0]);
    const arc = entity(model, constraint.featureRefs[1]);
    return pointOnArcResidual(p, arc);
  },
  'Point-on Fillet'(model, constraint, dimensions) {
    const p = point(model, constraint.featureRefs[0]);
    const arc = derivedFilletArc(model, constraint.featureRefs[1], dimensions);
    return pointOnArcResidual(p, arc);
  },
  Distance(model, constraint, dimensions) {
    const a = point(model, constraint.anchors?.start || constraint.featureRefs[0]);
    const b = point(model, constraint.anchors?.end || constraint.featureRefs[1]);
    const desired = target(constraint, dimensions);
    const measured2 = pointDistance2(a, b);
    return [(measured2 - desired ** 2) / safeScale(measured2, desired ** 2)];
  },
  'Horizontal Distance'(model, constraint, dimensions) {
    const a = point(model, constraint.anchors?.start || constraint.featureRefs[0]);
    const b = point(model, constraint.anchors?.end || constraint.featureRefs[1]);
    const desired = target(constraint, dimensions);
    const sign = constraint.orientation || Math.sign(b[0] - a[0]) || 1;
    return [b[0] - a[0] - sign * desired];
  },
  'Vertical Distance'(model, constraint, dimensions) {
    const a = point(model, constraint.anchors?.start || constraint.featureRefs[0]);
    const b = point(model, constraint.anchors?.end || constraint.featureRefs[1]);
    const desired = target(constraint, dimensions);
    const sign = constraint.orientation || Math.sign(b[1] - a[1]) || 1;
    return [b[1] - a[1] - sign * desired];
  },
  Radius(model, constraint, dimensions) {
    const round = entity(model, constraint.featureRefs[0]);
    return [round.radius - target(constraint, dimensions)];
  },
  Diameter(model, constraint, dimensions) {
    const round = entity(model, constraint.featureRefs[0]);
    return [round.radius * 2 - target(constraint, dimensions)];
  },
  Angle(model, constraint, dimensions) {
    const [a, b] = constraint.featureRefs.map((ref) => segment(model, ref));
    const av = scale(subtract(a.end, a.start), constraint.firstRaySign || 1);
    const bv = scale(subtract(b.end, b.start), constraint.secondRaySign || 1);
    const measured = Math.atan2(cross(av, bv), dot(av, bv));
    const desired = (constraint.angleOrientation || 1) * target(constraint, dimensions) * Math.PI / 180;
    return [Math.atan2(Math.sin(measured - desired), Math.cos(measured - desired))];
  },
  Meta(model, constraint, dimensions) {
    const variable = model.variableById(constraint.parameterRef);
    if (!variable) throw new Error(`Unknown meta-constraint variable: ${constraint.parameterRef}`);
    return [variable.value - target(constraint, dimensions)];
  },
  Fixed(model, constraint) {
    const pointRef = constraint.featureRefs?.find((ref) => ref.kind === 'point' || ref.type === 'point');
    if (!pointRef || !constraint.fixedPoint) return [];
    const current = point(model, pointRef);
    return [current[0] - constraint.fixedPoint[0], current[1] - constraint.fixedPoint[1]];
  },
};

export function evaluateConstraint(model, constraint, dimensions) {
  const implementation = residualImplementations[constraint.type];
  if (!implementation) throw new Error(`Unsupported constraint type: ${constraint.type}`);
  const values = implementation(model, constraint, dimensions);
  if (!values.every(Number.isFinite)) throw new Error(`Constraint ${constraint.id} produced a non-finite residual.`);
  return values;
}

// --- Levenberg-Marquardt Optimizer ---
function diagnosticConstraints(evaluation) {
  return evaluation.values
    .map((value, index) => ({ value: Math.abs(value), constraintId: evaluation.equations[index]?.constraintId }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5)
    .filter((item) => item.value > 1e-6)
    .map((item) => item.constraintId);
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

function hasHalfChordDistanceTarget(constraints, dimensions, binding, targetRadius, rootForReference) {
  const arcRoots = [
    rootForReference({ type: 'point', recordId: binding.id, index: 0 }),
    rootForReference({ type: 'point', recordId: binding.id, index: 2 }),
  ];
  if (arcRoots.some((root) => !root)) return false;
  for (const constraint of constraints) {
    if (constraint.enabled === false || constraint.type !== 'Distance' || !constraint.dimensionRef) continue;
    const distanceRoots = [
      rootForReference(constraint.anchors?.start || constraint.featureRefs?.[0]),
      rootForReference(constraint.anchors?.end || constraint.featureRefs?.[1]),
    ];
    const sameEndpoints = (
      distanceRoots[0] === arcRoots[0] && distanceRoots[1] === arcRoots[1]
    ) || (
      distanceRoots[0] === arcRoots[1] && distanceRoots[1] === arcRoots[0]
    );
    if (!sameEndpoints) continue;
    const targetChord = Number(dimensions.value(constraint.dimensionRef));
    const expectedChord = targetRadius * 2;
    const matchTolerance = Math.max(1e-7, Math.max(Math.abs(targetChord), Math.abs(expectedChord)) * 1e-8);
    if (Number.isFinite(targetChord) && Math.abs(targetChord - expectedChord) <= matchTolerance) return true;
  }
  return false;
}

// At the semicircle limit, radius - target is quadratic in the arc center's
// distance from the chord and its first derivative vanishes at the solution.
// Keep the implied center-at-midpoint relationship active throughout every
// Jacobian evaluation so later constraints can move the semicircle as a unit.
function createHalfChordArcProjection(model, dimensions) {
  const constraints = model.constraints?.values ? [...model.constraints.values()] : [];
  if (!constraints.length) return null;
  const rootForReference = coincidentPointRootResolver(model, constraints);
  const projectedBindings = [];
  for (const constraint of constraints) {
    if (constraint.enabled === false || constraint.type !== 'Radius' || !constraint.dimensionRef) continue;
    const ref = constraint.featureRefs?.[0];
    const binding = ref?.recordId ? model.binding(ref.recordId) : null;
    if (binding?.type !== 'arc') continue;
    const centerX = binding.variables.get('center.x');
    const centerY = binding.variables.get('center.y');
    if (!centerX?.active || !centerY?.active) continue;
    const targetRadius = Number(dimensions.value(constraint.dimensionRef));
    if (!Number.isFinite(targetRadius) || targetRadius <= 0) continue;
    const start = binding.point('start');
    const end = binding.point('end');
    const halfChord = Math.hypot(end[0] - start[0], end[1] - start[1]) / 2;
    const matchTolerance = Math.max(1e-7, Math.max(Math.abs(targetRadius), halfChord) * 1e-8);
    const matchesCurrentChord = Math.abs(targetRadius - halfChord) <= matchTolerance;
    const matchesDrivingChord = hasHalfChordDistanceTarget(
      constraints,
      dimensions,
      binding,
      targetRadius,
      rootForReference,
    );
    if (matchesCurrentChord || matchesDrivingChord) projectedBindings.push(binding);
  }
  if (!projectedBindings.length) return null;
  return () => {
    for (const binding of projectedBindings) {
      const start = binding.point('start');
      const end = binding.point('end');
      binding.variables.get('center.x').value = (start[0] + end[0]) / 2;
      binding.variables.get('center.y').value = (start[1] + end[1]) / 2;
    }
  };
}

export const DEFAULT_MAX_ITERATIONS = 2000;
export const DEFAULT_MATRIX_FREE_VARIABLE_THRESHOLD = 192;
export const INTERACTIVE_MATRIX_FREE_VARIABLE_THRESHOLD = 48;
const MAX_LEVENBERG_MARQUARDT_DAMPING = 1e12;

export function solveLevenbergMarquardt({
  model,
  registry,
  dimensions,
  maxIterations = DEFAULT_MAX_ITERATIONS,
  tolerance = 1e-8,
  solveMode = 'final',
  timeBudgetMs = Infinity,
  shouldCancel = null,
  jacobianMode = 'dense',
  matrixFreeVariableThreshold,
  evaluateParameterTargets = true,
  computedDimensionIds = null,
}) {
  const convergenceThreshold = tolerance ** 2;
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const startedAt = now();
  const resolvedMode = solveMode === 'interactive' ? 'interactive' : 'final';
  const automaticMatrixFreeThreshold = resolvedMode === 'interactive'
    ? INTERACTIVE_MATRIX_FREE_VARIABLE_THRESHOLD
    : DEFAULT_MATRIX_FREE_VARIABLE_THRESHOLD;
  const resolvedMatrixFreeThreshold = matrixFreeVariableThreshold === undefined || matrixFreeVariableThreshold === null
    ? automaticMatrixFreeThreshold
    : Math.max(0, Number(matrixFreeVariableThreshold) || 0);
  const resolvedTimeBudgetMs = Number.isFinite(Number(timeBudgetMs)) && Number(timeBudgetMs) >= 0
    ? Number(timeBudgetMs)
    : Infinity;
  const cancellationCheck = () => (
    cancellationReason(shouldCancel)
    || (now() - startedAt >= resolvedTimeBudgetMs ? 'time-budget' : null)
  );
  const timings = { residualMs: 0, jacobianMs: 0, linearSolveMs: 0, totalMs: 0 };
  const requestedJacobianMode = jacobianMode === 'blocks' ? 'blocks' : 'dense';
  const jacobianStats = {
    requestedMode: requestedJacobianMode,
    mode: 'not-required',
    totalBlocks: 0,
    analyticalBlocks: 0,
    fallbackBlocks: 0,
    residualRows: 0,
  };
  const finish = (result) => {
    timings.totalMs = now() - startedAt;
    return { ...result, solveMode: resolvedMode, timings: { ...timings }, jacobianStats: { ...jacobianStats } };
  };
  // Sample parameter targets and driven measurements once. These values must
  // remain read-only while finite-difference Jacobian columns are evaluated.
  if (evaluateParameterTargets) {
    const evaluateParameters = dimensions?.evaluateDirty?.bind(dimensions)
      || dimensions?.evaluateAll?.bind(dimensions);
    evaluateParameters?.({
      strict: false,
      refreshComputed: true,
      refreshComputedIds: computedDimensionIds,
    });
  }
  const allVariables = model.allVariables();
  const activeVariables = model.activeVariables();
  const initialValues = allVariables.map((variable) => variable.value);
  let projectHalfChordArcs = null;
  const evaluate = () => {
    const started = now();
    try {
      projectHalfChordArcs?.();
      return registry.evaluate(model, dimensions);
    } finally {
      timings.residualMs += now() - started;
    }
  };
  let evaluation;
  try {
    evaluation = evaluate();
  } catch (error) {
    return finish({ status: 'invalid', iterations: 0, initialError: Infinity, finalError: Infinity, acceptedSteps: 0, rejectedSteps: 0, changedEntityIds: [], problematicConstraintIds: [], message: error.message });
  }
  const initialError = squaredNorm(evaluation.values);
  if (initialError < convergenceThreshold) return finish({ status: 'unchanged', iterations: 0, initialError, finalError: initialError, acceptedSteps: 0, rejectedSteps: 0, changedEntityIds: [], problematicConstraintIds: [], message: 'Constraints already satisfied.' });
  projectHalfChordArcs = createHalfChordArcProjection(model, dimensions);
  if (projectHalfChordArcs) {
    try {
      evaluation = evaluate();
    } catch (error) {
      allVariables.forEach((variable, index) => { variable.value = initialValues[index]; });
      return finish({ status: 'invalid', iterations: 0, initialError, finalError: initialError, acceptedSteps: 0, rejectedSteps: 0, changedEntityIds: [], problematicConstraintIds: diagnosticConstraints(evaluation), message: error.message });
    }
  }
  let jacobianContract = null;
  let useMatrixFreeJacobian = false;
  if (requestedJacobianMode === 'blocks' && !projectHalfChordArcs) {
    try {
      jacobianContract = registry.blocks(model, dimensions, { variables: activeVariables });
      useMatrixFreeJacobian = activeVariables.length >= resolvedMatrixFreeThreshold;
      jacobianStats.mode = useMatrixFreeJacobian ? 'matrix-free' : 'blocks';
      if (useMatrixFreeJacobian) {
        jacobianStats.matrixFreeThreshold = resolvedMatrixFreeThreshold;
        jacobianStats.matrixFreeThresholdSource = matrixFreeVariableThreshold === undefined || matrixFreeVariableThreshold === null
          ? resolvedMode
          : 'explicit';
      }
    } catch (error) {
      allVariables.forEach((variable, index) => { variable.value = initialValues[index]; });
      return finish({ status: 'invalid', iterations: 0, initialError, finalError: initialError, acceptedSteps: 0, rejectedSteps: 0, changedEntityIds: [], problematicConstraintIds: diagnosticConstraints(evaluation), message: error.message });
    }
  } else {
    jacobianStats.mode = requestedJacobianMode === 'blocks' ? 'dense-reference' : 'dense';
    if (projectHalfChordArcs) jacobianStats.fallbackReason = 'half-chord-arc-projection';
  }
  let error = squaredNorm(evaluation.values);
  const changedEntityIds = () => [...new Set(allVariables
    .filter((variable, index) => Math.abs(variable.value - initialValues[index]) > 1e-10)
    .map((variable) => variable.owner))];
  const cancellationResult = (reason, iterations, currentError = error) => {
    if (resolvedMode === 'interactive') {
      const message = reason === 'time-budget'
        ? 'Interactive solve reached its time budget; the best preview was retained.'
        : reason === 'stagnation'
          ? 'Interactive solve stalled before convergence; the best preview was retained.'
          : reason === 'iteration-budget'
            ? 'Interactive solve reached its iteration budget; the best preview was retained.'
            : 'Interactive solve was superseded; the best preview was retained.';
      return finish({
        status: 'preview',
        iterations,
        initialError,
        finalError: currentError,
        acceptedSteps,
        rejectedSteps,
        changedEntityIds: changedEntityIds(),
        problematicConstraintIds: [],
        cancellationReason: reason,
        message,
      });
    }
    allVariables.forEach((variable, index) => { variable.value = initialValues[index]; });
    return finish({
      status: 'cancelled',
      iterations,
      initialError,
      finalError: initialError,
      acceptedSteps,
      rejectedSteps,
      changedEntityIds: [],
      problematicConstraintIds: [],
      cancellationReason: reason,
      message: 'Solver was cancelled; geometry was restored.',
    });
  };
  if (error < convergenceThreshold) {
    return finish({ status: 'converged', iterations: 0, initialError, finalError: error, acceptedSteps: 0, rejectedSteps: 0, changedEntityIds: changedEntityIds(), problematicConstraintIds: [], message: 'Constraints converged.' });
  }
  if (!activeVariables.length) return finish({ status: 'failed', iterations: 0, initialError, finalError: initialError, acceptedSteps: 0, rejectedSteps: 0, changedEntityIds: [], problematicConstraintIds: diagnosticConstraints(evaluation), message: 'No free variables are available to satisfy the constraints.' });

  let lambda = 0.01;
  let acceptedSteps = 0;
  let rejectedSteps = 0;
  let lastIteration = 0;
  let terminationReason = null;
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    lastIteration = iteration;
    const cancelledBeforeIteration = cancellationCheck();
    if (cancelledBeforeIteration) return cancellationResult(cancelledBeforeIteration, iteration - 1);
    const errors = evaluation.values;
    let jacobian;
    let jacobianOperator;
    const jacobianStarted = now();
    try {
      if (useMatrixFreeJacobian) {
        jacobianOperator = createMatrixFreeJacobian(jacobianContract, { shouldCancel: cancellationCheck });
        if (jacobianOperator.rowCount !== errors.length) {
          throw new Error('Matrix-free Jacobian row count does not match the current residual vector.');
        }
        Object.assign(jacobianStats, jacobianOperator.diagnostics);
      } else if (jacobianContract) {
        const assembled = assembleJacobianBlocks(jacobianContract, { shouldCancel: cancellationCheck });
        jacobian = assembled.matrix;
        if (jacobian.length !== errors.length) throw new Error('Block Jacobian row count does not match the current residual vector.');
        Object.assign(jacobianStats, assembled.diagnostics);
      } else {
        jacobian = computeJacobian(activeVariables, () => evaluate().values, errors, 1e-6, cancellationCheck);
      }
    } catch (jacobianError) {
      if (jacobianError instanceof SolverCancellationError || jacobianError instanceof JacobianBlockCancellationError) {
        return cancellationResult(jacobianError.reason, iteration - 1);
      }
      allVariables.forEach((variable, index) => { variable.value = initialValues[index]; });
      return finish({ status: 'invalid', iterations: iteration, initialError, finalError: initialError, acceptedSteps, rejectedSteps, changedEntityIds: [], problematicConstraintIds: diagnosticConstraints(evaluation), message: jacobianError.message });
    } finally {
      timings.jacobianMs += now() - jacobianStarted;
    }
    projectHalfChordArcs?.();
    let step;
    const linearStarted = now();
    try {
      if (jacobianOperator) {
        const linearResult = solveMatrixFreeDampedLeastSquares(jacobianOperator, errors, lambda, {
          shouldCancel: cancellationCheck,
        });
        step = linearResult.step;
        jacobianStats.linearIterations = linearResult.iterations;
        jacobianStats.linearConverged = linearResult.converged;
        jacobianStats.linearResidual = linearResult.residualNorm;
        jacobianStats.linearPreconditioner = linearResult.preconditioner;
      } else {
        const jt = transpose(jacobian);
        const normal = multiply(jt, jacobian, cancellationCheck);
        for (let index = 0; index < normal.length; index += 1) {
          throwIfCancelled(cancellationCheck);
          normal[index][index] += lambda * Math.max(Math.abs(normal[index][index]), 1) + 1e-7;
        }
        const gradient = multiplyMatrixVector(jt, errors, cancellationCheck).map((value) => -value);
        step = solveLinearSystem(normal, gradient, 1e-12, cancellationCheck);
      }
    } catch (linearError) {
      if (linearError instanceof SolverCancellationError || linearError instanceof JacobianBlockCancellationError) {
        return cancellationResult(linearError.reason, iteration - 1);
      }
      lambda *= 10;
      rejectedSteps += 1;
      if (!Number.isFinite(lambda) || lambda > MAX_LEVENBERG_MARQUARDT_DAMPING) {
        terminationReason = 'stagnation';
        break;
      }
      continue;
    } finally {
      timings.linearSolveMs += now() - linearStarted;
    }
    const previous = activeVariables.map((variable) => variable.value);
    activeVariables.forEach((variable, index) => { variable.value += step[index]; });
    let candidate;
    try {
      candidate = evaluate();
    } catch {
      candidate = null;
    }
    const candidateError = candidate ? squaredNorm(candidate.values) : Infinity;
    if (Number.isFinite(candidateError) && candidateError < error) {
      evaluation = candidate;
      error = candidateError;
      acceptedSteps += 1;
      lambda = Math.max(1e-12, lambda / 10);
      if (error < convergenceThreshold) {
        return finish({ status: 'converged', iterations: iteration, initialError, finalError: error, acceptedSteps, rejectedSteps, changedEntityIds: changedEntityIds(), problematicConstraintIds: [], message: 'Constraints converged.' });
      }
      if (squaredNorm(step) < 1e-18) {
        terminationReason = 'stagnation';
        break;
      }
    } else {
      activeVariables.forEach((variable, index) => { variable.value = previous[index]; });
      rejectedSteps += 1;
      lambda *= 10;
      if (!Number.isFinite(lambda) || lambda > MAX_LEVENBERG_MARQUARDT_DAMPING) {
        terminationReason = 'stagnation';
        break;
      }
    }
  }
  if (resolvedMode === 'interactive') return cancellationResult(terminationReason || 'iteration-budget', lastIteration);
  allVariables.forEach((variable, index) => { variable.value = initialValues[index]; });
  return finish({
    status: 'max-iterations',
    iterations: lastIteration,
    initialError,
    finalError: initialError,
    acceptedSteps,
    rejectedSteps,
    changedEntityIds: [],
    problematicConstraintIds: diagnosticConstraints(evaluation),
    ...(terminationReason ? { terminationReason } : {}),
    message: terminationReason === 'stagnation'
      ? 'Solver stalled before convergence; geometry was restored.'
      : 'Solver did not converge; geometry was restored.',
  });
}
