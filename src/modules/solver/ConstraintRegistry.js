import { evaluateConstraint, featureLength, residualImplementations } from './NumericSolverCore.js';
import { constraintVariableIds } from './ConstraintGraph.js';
import { createVariableColumnMap } from './JacobianBlocks.js';
import { analyticalJacobianImplementations, intrinsicArcJacobian } from './AnalyticalJacobians.js';
import { isSelfCoincidentConstraint, selfCoincidentConstraintMessage } from './ConstraintValidation.js';

function intrinsicBindings(model) {
  const entityIds = model.scope?.intrinsicEntityIds || model.entities?.keys?.() || [];
  return [...entityIds]
    .map((entityId) => model.binding(entityId))
    .filter((binding) => binding?.intrinsicResiduals().length);
}

function localVariables(variableIds, variablesById, columnByVariableId) {
  return [...variableIds]
    .filter((id) => columnByVariableId.has(id))
    .map((id) => variablesById.get(id))
    .filter(Boolean);
}

export class ConstraintRegistry {
  supports(type) {
    return Boolean(residualImplementations[type]);
  }

  /**
   * Builds residual/Jacobian blocks whose local columns are indexes into the
   * active variables of the current full-model or component-scoped solve.
   * Analytical derivatives are optional; callers use a per-block numerical
   * fallback until a constraint implementation supplies them.
   */
  blocks(model, dimensions, { variables = model.activeVariables() } = {}) {
    const columnByVariableId = createVariableColumnMap(variables);
    const variablesById = new Map(variables.map((variable) => [variable.id, variable]));
    const blocks = [];
    let intrinsicEquationIndex = 0;

    for (const binding of intrinsicBindings(model)) {
      const residualCount = binding.intrinsicResiduals().length;
      const blockVariables = localVariables(
        binding.allVariables().map((variable) => variable.id),
        variablesById,
        columnByVariableId,
      );
      blocks.push({
        id: `intrinsic:${binding.id}`,
        type: 'Intrinsic',
        constraintId: null,
        variables: blockVariables,
        variableIds: blockVariables.map((variable) => variable.id),
        columnIndexes: blockVariables.map((variable) => columnByVariableId.get(variable.id)),
        equations: Array.from({ length: residualCount }, (_, offset) => ({
          constraintId: `intrinsic-${intrinsicEquationIndex + offset}`,
          equationIndex: intrinsicEquationIndex + offset,
        })),
        evaluateResiduals: () => binding.intrinsicResiduals(),
        evaluateAnalyticalJacobian: binding.type === 'arc'
          ? () => intrinsicArcJacobian({ binding, variables: blockVariables })
          : null,
      });
      intrinsicEquationIndex += residualCount;
    }

    for (const constraint of model.constraints.values()) {
      if (constraint.enabled === false) continue;
      const blockVariables = localVariables(
        constraintVariableIds(model, constraint),
        variablesById,
        columnByVariableId,
      );
      const evaluateResiduals = () => evaluateConstraint(model, constraint, dimensions);
      const residualCount = evaluateResiduals().length;
      if (residualCount === 0) continue;
      const analyticalJacobian = analyticalJacobianImplementations[constraint.type];
      blocks.push({
        id: `constraint:${constraint.id}`,
        type: constraint.type,
        constraintId: constraint.id,
        constraint,
        variables: blockVariables,
        variableIds: blockVariables.map((variable) => variable.id),
        columnIndexes: blockVariables.map((variable) => columnByVariableId.get(variable.id)),
        equations: Array.from({ length: residualCount }, (_, equationIndex) => ({
          constraintId: constraint.id,
          equationIndex,
        })),
        evaluateResiduals,
        evaluateAnalyticalJacobian: analyticalJacobian
          ? () => analyticalJacobian({ model, constraint, dimensions, variables: blockVariables })
          : null,
      });
    }

    return { variables, columnByVariableId, blocks };
  }

  evaluate(model, dimensions) {
    const values = [];
    const equations = [];
    const intrinsic = model.intrinsicResiduals();
    intrinsic.forEach((value, index) => {
      values.push(value);
      equations.push({ constraintId: `intrinsic-${index}`, equationIndex: index });
    });
    for (const constraint of model.constraints.values()) {
      if (constraint.enabled === false) continue;
      const residuals = evaluateConstraint(model, constraint, dimensions);
      residuals.forEach((value, equationIndex) => {
        values.push(value);
        equations.push({ constraintId: constraint.id, equationIndex });
      });
    }
    return { values, equations };
  }

  validate(model, constraint, dimensions) {
    if (!this.supports(constraint.type)) throw new Error(`Unsupported constraint type: ${constraint.type}`);
    if (isSelfCoincidentConstraint(constraint)) throw new Error(selfCoincidentConstraintMessage());
    if (constraint.type === 'Length') {
      const refs = constraint.featureRefs || [];
      if (refs.length !== 1 || !['segment', 'arc'].includes(refs[0]?.kind)) {
        throw new Error('Length requires one line segment or arc feature.');
      }
      const measured = featureLength(model, refs[0]);
      if (!Number.isFinite(measured) || measured < 1e-8) throw new Error('Length requires a non-degenerate line segment or arc.');
      const target = Number(constraint.value);
      if (!Number.isFinite(target) || target <= 0) throw new Error('Length requires a positive finite target.');
    }
    for (const ref of constraint.featureRefs || []) {
      if (ref?.kind !== 'segment') continue;
      const segment = model.resolveSegment(ref);
      if (!segment || Math.hypot(segment.end[0] - segment.start[0], segment.end[1] - segment.start[1]) < 1e-8) {
        throw new Error(`${constraint.type} requires a non-degenerate segment.`);
      }
    }
    evaluateConstraint(model, constraint, dimensions);
    return true;
  }
}
