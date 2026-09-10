import { JacobianBlockCancellationError } from './JacobianBlocks.js';

// These bound compilation work/storage, not drawing size. Larger or densely
// coupled graphs continue through the existing matrix-free iterative solver.
const MAX_VARIABLES = 2048;
const MAX_FACTOR_ENTRIES = 65536;
const MAX_SYMBOLIC_WORK = 2000000;
const topologyCache = new Map();

function checkCancellation(shouldCancel) {
  const reason = shouldCancel?.();
  if (reason) throw new JacobianBlockCancellationError(reason === true ? 'cancelled' : String(reason));
}

/**
 * Compile the constraint graph into a sparse elimination program. Eliminated
 * coordinates are recovered by back-substitution; no geometric freedom or
 * constraint is removed. The program depends only on the block topology, so it
 * is reused for every Newton correction and damping retry in this solve.
 */
function compileTopology(contract, shouldCancel) {
  const size = contract.variables.length;
  if (size > MAX_VARIABLES) return null;
  const graph = Array.from({ length: size }, () => new Set());
  let work = 0;
  for (const block of contract.blocks) {
    checkCancellation(shouldCancel);
    work += block.columnIndexes.length ** 2;
    if (work > MAX_SYMBOLIC_WORK) return null;
    for (const first of block.columnIndexes) for (const second of block.columnIndexes) {
      if (first !== second) graph[first].add(second);
    }
  }
  const order = [];
  const neighbors = [];
  const remaining = new Set(graph.map((_, index) => index));
  let fillEntries = size;
  while (remaining.size) {
    checkCancellation(shouldCancel);
    let selected = -1;
    for (const candidate of remaining) {
      if (selected < 0 || graph[candidate].size < graph[selected].size) selected = candidate;
    }
    const adjacent = [...graph[selected]];
    fillEntries += adjacent.length;
    work += adjacent.length ** 2;
    if (fillEntries > MAX_FACTOR_ENTRIES || work > MAX_SYMBOLIC_WORK) return null;
    order.push(selected);
    neighbors.push(adjacent);
    remaining.delete(selected);
    for (const first of adjacent) {
      graph[first].delete(selected);
      for (const second of adjacent) if (first !== second) graph[first].add(second);
    }
  }
  const position = new Int32Array(size);
  order.forEach((column, index) => { position[column] = index; });
  const columns = neighbors.map(adjacent => Int32Array.from(adjacent.map(column => position[column]).sort((a, b) => a - b)));
  const slots = columns.map((entries, row) => new Map([[row, 0], ...[...entries].map((column, index) => [column, index + 1])]));
  // Map local derivative pairs to their fixed sparse storage slots once.
  const assembly = contract.blocks.map(block => {
    const indexes = Int32Array.from(block.columnIndexes, column => position[column]);
    const pairs = [];
    for (let first = 0; first < indexes.length; first += 1) {
      for (let second = first; second < indexes.length; second += 1) {
        const row = Math.min(indexes[first], indexes[second]);
        const column = Math.max(indexes[first], indexes[second]);
        pairs.push([first, second, row, slots[row].get(column)]);
      }
    }
    return { indexes, pairs };
  });
  return { order, columns, slots, assembly, fillEntries };
}

export function compileConstraintSystem(contract, { shouldCancel = null } = {}) {
  checkCancellation(shouldCancel);
  const size = contract.variables.length;
  if (size > MAX_VARIABLES) return null;
  const key = `${size};${contract.blocks.length};${contract.blocks.map(block => block.columnIndexes.join(',')).join(';')}`;
  const cacheHit = topologyCache.has(key);
  const topology = cacheHit ? topologyCache.get(key) : compileTopology(contract, shouldCancel);
  if (!topology) return null;
  topologyCache.delete(key);
  topologyCache.set(key, topology);
  if (topologyCache.size > 8) topologyCache.delete(topologyCache.keys().next().value);
  const { order, columns, slots, assembly, fillEntries } = topology;
  // Numeric workspaces belong to this solve; the cached topology is read-only.
  const normal = columns.map(entries => new Float64Array(entries.length + 1));
  const factors = columns.map(entries => new Float64Array(entries.length));
  const diagonal = new Float64Array(size);
  const rhs = new Float64Array(size);
  const workspace = new Float64Array(size);

  function substitute(input) {
    workspace.set(input);
    for (let row = 0; row < size; row += 1) {
      for (let offset = 0; offset < columns[row].length; offset += 1) {
        workspace[columns[row][offset]] -= factors[row][offset] * workspace[row];
      }
    }
    for (let row = 0; row < size; row += 1) workspace[row] /= diagonal[row];
    for (let row = size - 1; row >= 0; row -= 1) {
      for (let offset = 0; offset < columns[row].length; offset += 1) {
        workspace[row] -= factors[row][offset] * workspace[columns[row][offset]];
      }
    }
    return workspace;
  }

  function solve(operator, errors, lambda, { shouldCancel: cancel = shouldCancel } = {}) {
    if (operator.columnCount !== size || operator.blocks.length !== assembly.length || errors.length !== operator.rowCount) {
      throw new Error('Compiled constraint topology does not match the current Jacobian.');
    }
    for (const row of normal) row.fill(0);
    rhs.fill(0);
    operator.blocks.forEach((block, index) => {
      checkCancellation(cancel);
      const { indexes, pairs } = assembly[index];
      if (indexes.length !== block.columnIndexes.length
        || indexes.some((position, column) => order[position] !== block.columnIndexes[column])) {
        throw new Error('Compiled constraint columns do not match the current Jacobian.');
      }
      block.values.forEach((row, localRow) => {
        const residual = errors[block.rowOffset + localRow];
        for (let column = 0; column < indexes.length; column += 1) rhs[indexes[column]] -= row[column] * residual;
        for (const [first, second, target, slot] of pairs) normal[target][slot] += row[first] * row[second];
      });
    });
    const damping = new Float64Array(size);
    for (let row = 0; row < size; row += 1) {
      damping[order[row]] = lambda * Math.max(Math.abs(normal[row][0]), 1) + 1e-7;
      normal[row][0] += damping[order[row]];
    }
    // Sparse LDLᵀ: each pivot contributes only to its remaining neighbors.
    for (let row = 0; row < size; row += 1) {
      checkCancellation(cancel);
      const pivot = normal[row][0];
      if (!Number.isFinite(pivot) || pivot <= 0) throw new Error('Compiled constraint factorization encountered a non-positive pivot.');
      diagonal[row] = pivot;
      const adjacent = columns[row];
      for (let first = 0; first < adjacent.length; first += 1) {
        const factor = normal[row][first + 1] / pivot;
        factors[row][first] = factor;
        const target = adjacent[first];
        for (let second = first; second < adjacent.length; second += 1) {
          normal[target][slots[target].get(adjacent[second])] -= factor * normal[row][second + 1];
        }
      }
    }
    const step = new Float64Array(size);
    const solution = substitute(rhs);
    for (let row = 0; row < size; row += 1) step[order[row]] = solution[row];
    // Check the original operator, and refine through the same factors if
    // roundoff in the normal equations left a material linear residual.
    const originalRhs = new Float64Array(size);
    for (let row = 0; row < size; row += 1) originalRhs[order[row]] = rhs[row];
    const rhsNorm = Math.hypot(...originalRhs);
    const tolerance = Math.max(1e-12, rhsNorm * 1e-9);
    const product = new Float64Array(size);
    const residual = new Float64Array(size);
    const rows = new Float64Array(operator.rowCount);
    let residualNorm;
    let refinements = 0;
    for (; refinements <= 2; refinements += 1) {
      checkCancellation(cancel);
      operator.applyJacobian(step, rows);
      operator.applyJacobianTranspose(rows, product);
      for (let column = 0; column < size; column += 1) residual[column] = originalRhs[column] - product[column] - damping[column] * step[column];
      residualNorm = Math.hypot(...residual);
      if (residualNorm <= tolerance || refinements === 2) break;
      for (let row = 0; row < size; row += 1) rhs[row] = residual[order[row]];
      const correction = substitute(rhs);
      for (let row = 0; row < size; row += 1) step[order[row]] += correction[row];
    }
    if (!step.every(Number.isFinite)) throw new Error('Compiled constraint solve produced non-finite coordinates.');
    return { step, iterations: 1 + refinements, converged: residualNorm <= tolerance, residualNorm, preconditioner: 'none', fillEntries };
  }
  return { solve, fillEntries, variableCount: size, cacheHit };
}
