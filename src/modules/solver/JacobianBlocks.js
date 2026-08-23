const DEFAULT_STEP = 1e-6;
const DEFAULT_ABSOLUTE_TOLERANCE = 1e-7;
const DEFAULT_RELATIVE_TOLERANCE = 1e-5;
const MAX_ENTITY_PRECONDITIONER_BLOCK_SIZE = 8;
export const ENTITY_BLOCK_PRECONDITIONER_VARIABLE_THRESHOLD = 96;

export class JacobianBlockCancellationError extends Error {
  constructor(reason = 'cancelled') {
    super(`Jacobian block evaluation cancelled: ${reason}.`);
    this.name = 'JacobianBlockCancellationError';
    this.reason = reason;
  }
}

function throwIfCancelled(shouldCancel) {
  const cancellation = shouldCancel?.();
  if (cancellation) throw new JacobianBlockCancellationError(cancellation === true ? 'cancelled' : String(cancellation));
}

function assertMatrixShape(matrix, rowCount, columnCount, label) {
  if (!Array.isArray(matrix) || matrix.length !== rowCount) {
    throw new Error(`${label} row count does not match its residual block.`);
  }
  matrix.forEach((row) => {
    if (!Array.isArray(row) || row.length !== columnCount || !row.every(Number.isFinite)) {
      throw new Error(`${label} must contain one finite column per local variable.`);
    }
  });
}

export function createVariableColumnMap(variables) {
  const columns = new Map();
  variables.forEach((variable, column) => {
    if (!variable?.id) throw new Error('Jacobian variables require stable IDs.');
    if (columns.has(variable.id)) throw new Error(`Duplicate Jacobian variable ID: ${variable.id}`);
    columns.set(variable.id, column);
  });
  return columns;
}

export function centralDifferenceJacobianBlock(block, {
  baseStep = DEFAULT_STEP,
  shouldCancel = null,
} = {}) {
  const baseResiduals = block.evaluateResiduals();
  const variables = block.variables || [];
  const jacobian = Array.from({ length: baseResiduals.length }, () => Array(variables.length).fill(0));

  variables.forEach((variable, column) => {
    throwIfCancelled(shouldCancel);
    const original = variable.value;
    const step = baseStep * Math.max(1, Math.abs(original));
    let positive;
    let negative;
    try {
      variable.value = original + step;
      positive = block.evaluateResiduals();
      variable.value = original - step;
      negative = block.evaluateResiduals();
    } finally {
      variable.value = original;
    }
    if (positive.length !== baseResiduals.length || negative.length !== baseResiduals.length) {
      throw new Error(`Residual count changed while differentiating Jacobian block ${block.id}.`);
    }
    for (let row = 0; row < baseResiduals.length; row += 1) {
      jacobian[row][column] = (positive[row] - negative[row]) / (2 * step);
    }
  });

  assertMatrixShape(jacobian, baseResiduals.length, variables.length, 'Finite-difference Jacobian');
  return jacobian;
}

export function evaluateJacobianBlock(block, options = {}) {
  if (typeof block.evaluateAnalyticalJacobian !== 'function') {
    return {
      kind: 'finite-difference',
      matrix: centralDifferenceJacobianBlock(block, options),
    };
  }
  const matrix = block.evaluateAnalyticalJacobian();
  if (matrix === null) {
    return {
      kind: 'finite-difference',
      matrix: centralDifferenceJacobianBlock(block, options),
    };
  }
  const residualCount = Number.isInteger(options.expectedResidualCount)
    ? options.expectedResidualCount
    : block.evaluateResiduals().length;
  assertMatrixShape(matrix, residualCount, block.variables.length, 'Analytical Jacobian');
  return { kind: 'analytical', matrix };
}

export function assembleJacobianBlocks(contract, options = {}) {
  const rowCount = contract.blocks.reduce((count, block) => count + block.equations.length, 0);
  const matrix = Array.from({ length: rowCount }, () => Array(contract.variables.length).fill(0));
  const diagnostics = {
    totalBlocks: contract.blocks.length,
    analyticalBlocks: 0,
    fallbackBlocks: 0,
    residualRows: rowCount,
  };
  let rowOffset = 0;
  for (const block of contract.blocks) {
    throwIfCancelled(options.shouldCancel);
    const evaluated = evaluateJacobianBlock(block, {
      ...options,
      expectedResidualCount: block.equations.length,
    });
    diagnostics[evaluated.kind === 'analytical' ? 'analyticalBlocks' : 'fallbackBlocks'] += 1;
    if (evaluated.matrix.length !== block.equations.length) {
      throw new Error(`Jacobian block ${block.id} row count does not match its equation metadata.`);
    }
    evaluated.matrix.forEach((row, localRow) => {
      row.forEach((value, localColumn) => {
        const componentColumn = block.columnIndexes[localColumn];
        if (!Number.isInteger(componentColumn) || componentColumn < 0 || componentColumn >= contract.variables.length) {
          throw new Error(`Jacobian block ${block.id} has an invalid component column.`);
        }
        matrix[rowOffset + localRow][componentColumn] = value;
      });
    });
    rowOffset += block.equations.length;
  }
  return { matrix, diagnostics };
}

/**
 * Evaluates the same local derivative blocks as assembleJacobianBlocks without
 * expanding them into a residualCount x variableCount matrix. The returned
 * operator owns only the small per-constraint matrices and reusable typed
 * arrays, so its memory grows with the derivative entries that actually exist.
 */
export function createMatrixFreeJacobian(contract, options = {}) {
  const rowCount = contract.blocks.reduce((count, block) => count + block.equations.length, 0);
  const columnCount = contract.variables.length;
  const diagonal = new Float64Array(columnCount);
  const evaluatedBlocks = [];
  const entityColumns = new Map();
  const normalBlocks = [];
  const normalBlockByColumn = new Map();
  if (columnCount >= ENTITY_BLOCK_PRECONDITIONER_VARIABLE_THRESHOLD) {
    contract.variables.forEach((variable, column) => {
      const owner = variable.owner || `variable:${column}`;
      if (!entityColumns.has(owner)) entityColumns.set(owner, []);
      entityColumns.get(owner).push(column);
    });
    for (const [owner, columns] of entityColumns) {
      const groups = columns.length <= MAX_ENTITY_PRECONDITIONER_BLOCK_SIZE
        ? [columns]
        : columns.map((column) => [column]);
      for (const group of groups) {
        const normalBlock = {
          owner,
          columnIndexes: Int32Array.from(group),
          values: Array.from({ length: group.length }, () => new Float64Array(group.length)),
        };
        const blockIndex = normalBlocks.length;
        normalBlocks.push(normalBlock);
        group.forEach((column, localIndex) => normalBlockByColumn.set(column, { blockIndex, localIndex }));
      }
    }
  }
  const diagnostics = {
    totalBlocks: contract.blocks.length,
    analyticalBlocks: 0,
    fallbackBlocks: 0,
    residualRows: rowCount,
    derivativeEntries: 0,
    preconditionerBlocks: normalBlocks.length,
    largestPreconditionerBlock: normalBlocks.reduce(
      (largest, block) => Math.max(largest, block.columnIndexes.length),
      0,
    ),
  };
  let rowOffset = 0;

  for (const block of contract.blocks) {
    throwIfCancelled(options.shouldCancel);
    const evaluated = evaluateJacobianBlock(block, {
      ...options,
      expectedResidualCount: block.equations.length,
    });
    diagnostics[evaluated.kind === 'analytical' ? 'analyticalBlocks' : 'fallbackBlocks'] += 1;
    if (evaluated.matrix.length !== block.equations.length) {
      throw new Error(`Jacobian block ${block.id} row count does not match its equation metadata.`);
    }
    const columnIndexes = Int32Array.from(block.columnIndexes);
    columnIndexes.forEach((componentColumn) => {
      if (!Number.isInteger(componentColumn) || componentColumn < 0 || componentColumn >= columnCount) {
        throw new Error(`Jacobian block ${block.id} has an invalid component column.`);
      }
    });
    const values = evaluated.matrix.map((row) => Float64Array.from(row));
    values.forEach((row) => {
      row.forEach((value, localColumn) => {
        const componentColumn = columnIndexes[localColumn];
        diagonal[componentColumn] += value * value;
        diagnostics.derivativeEntries += 1;
      });
      for (let firstLocalColumn = 0; firstLocalColumn < row.length; firstLocalColumn += 1) {
        const firstComponentColumn = columnIndexes[firstLocalColumn];
        const firstLocation = normalBlockByColumn.get(firstComponentColumn);
        if (!firstLocation) continue;
        const normalBlock = normalBlocks[firstLocation.blockIndex];
        for (let secondLocalColumn = firstLocalColumn; secondLocalColumn < row.length; secondLocalColumn += 1) {
          const secondComponentColumn = columnIndexes[secondLocalColumn];
          const secondLocation = normalBlockByColumn.get(secondComponentColumn);
          if (!secondLocation || secondLocation.blockIndex !== firstLocation.blockIndex) continue;
          const contribution = row[firstLocalColumn] * row[secondLocalColumn];
          normalBlock.values[firstLocation.localIndex][secondLocation.localIndex] += contribution;
          if (firstLocation.localIndex !== secondLocation.localIndex) {
            normalBlock.values[secondLocation.localIndex][firstLocation.localIndex] += contribution;
          }
        }
      }
    });
    evaluatedBlocks.push({ rowOffset, columnIndexes, values });
    rowOffset += block.equations.length;
  }

  const residualWorkspace = new Float64Array(rowCount);
  const variableWorkspace = new Float64Array(columnCount);
  const applyJacobian = (vector, output = residualWorkspace) => {
    if (vector.length !== columnCount || output.length !== rowCount) {
      throw new Error('Matrix-free Jacobian-vector dimensions do not match.');
    }
    output.fill(0);
    for (const block of evaluatedBlocks) {
      throwIfCancelled(options.shouldCancel);
      block.values.forEach((row, localRow) => {
        let value = 0;
        for (let localColumn = 0; localColumn < row.length; localColumn += 1) {
          value += row[localColumn] * vector[block.columnIndexes[localColumn]];
        }
        output[block.rowOffset + localRow] = value;
      });
    }
    return output;
  };
  const applyJacobianTranspose = (vector, output = variableWorkspace) => {
    if (vector.length !== rowCount || output.length !== columnCount) {
      throw new Error('Matrix-free transpose-Jacobian-vector dimensions do not match.');
    }
    output.fill(0);
    for (const block of evaluatedBlocks) {
      throwIfCancelled(options.shouldCancel);
      block.values.forEach((row, localRow) => {
        const residualValue = vector[block.rowOffset + localRow];
        for (let localColumn = 0; localColumn < row.length; localColumn += 1) {
          output[block.columnIndexes[localColumn]] += row[localColumn] * residualValue;
        }
      });
    }
    return output;
  };

  return {
    rowCount,
    columnCount,
    diagonal,
    normalBlocks,
    diagnostics,
    applyJacobian,
    applyJacobianTranspose,
  };
}

export function verifyJacobianBlock(block, {
  absoluteTolerance = DEFAULT_ABSOLUTE_TOLERANCE,
  relativeTolerance = DEFAULT_RELATIVE_TOLERANCE,
  ...differenceOptions
} = {}) {
  if (typeof block.evaluateAnalyticalJacobian !== 'function') {
    throw new Error(`Jacobian block ${block.id} does not provide analytical derivatives.`);
  }
  const residuals = block.evaluateResiduals();
  const analytical = block.evaluateAnalyticalJacobian();
  if (analytical === null) {
    throw new Error(`Jacobian block ${block.id} does not support analytical derivatives for its current features.`);
  }
  const numerical = centralDifferenceJacobianBlock(block, differenceOptions);
  assertMatrixShape(analytical, residuals.length, block.variables.length, 'Analytical Jacobian');

  const differences = [];
  let maxAbsoluteError = 0;
  let maxScaledError = 0;
  for (let row = 0; row < analytical.length; row += 1) {
    for (let column = 0; column < analytical[row].length; column += 1) {
      const expected = numerical[row][column];
      const actual = analytical[row][column];
      const absoluteError = Math.abs(actual - expected);
      const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
      const tolerance = absoluteTolerance + relativeTolerance * scale;
      const scaledError = absoluteError / tolerance;
      maxAbsoluteError = Math.max(maxAbsoluteError, absoluteError);
      maxScaledError = Math.max(maxScaledError, scaledError);
      if (absoluteError > tolerance) {
        differences.push({ row, column, actual, expected, absoluteError, tolerance });
      }
    }
  }
  return {
    valid: differences.length === 0,
    maxAbsoluteError,
    maxScaledError,
    differences,
    analytical,
    numerical,
  };
}
