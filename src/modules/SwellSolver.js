import { createSwellGeometryEvaluator, isSwellEntity, swellDefinitionForEntity, swellSourceComponents } from './SwellGeometry.js';
import { createGeometryBinding } from './solver/SolverModel.js';
import { transformStackEntity } from './StackCoordinates.js';

// Derived features have no independent variables. Resolve them from the current
// source values on every residual evaluation, including finite-difference trials.
export function createSwellSolverProvider(model, dimensions) {
  const evaluate = createSwellGeometryEvaluator();
  let parameterKey = null;
  const lengthValues = new Map();
  const sources = () => [...model.entities.values()]
    .filter((binding) => isSwellEntity(binding))
    .map((binding) => model.entity(binding.id));
  // Only source endpoint connectivity participates in constructing Swell.
  // Dimensions and relationships to derived pieces are equations on the
  // result; including them here would turn them into source topology.
  const constraints = () => [...model.constraints.values()].filter((constraint) => (
    constraint.enabled !== false && constraint.type === 'Coincident'
    && constraint.featureRefs?.every((ref) => !ref.derivedFeature && isSwellEntity(model.binding(ref.recordId)))
  ));
  const geometry = () => {
    // Source coordinates change in every Jacobian trial, while parameter
    // expressions stay constant. Parse each expression once per parameter
    // state, including continuation steps and computed parameter updates.
    const key = JSON.stringify([
      dimensions.defaultLengthUnit, [...dimensions.entries.values()],
      [...dimensions.externalVariables], [...dimensions.stackNamesById],
      dimensions.enabledStackIds && [...dimensions.enabledStackIds],
    ]);
    if (key !== parameterKey) {
      lengthValues.clear();
      parameterKey = key;
    }
    return evaluate({
      entities: sources(),
      constraints: constraints(),
      evaluateLength: (expression, entity) => {
        const expressionKey = JSON.stringify([entity.stackId, expression]);
        if (!lengthValues.has(expressionKey)) {
          lengthValues.set(expressionKey, dimensions.evaluateLengthExpression(expression, { stackId: entity.stackId }));
        }
        return lengthValues.get(expressionKey);
      },
    });
  };
  const pieceFor = (ref) => {
    const derived = geometry();
    const selector = ref?.derivedFeature;
    if (!selector) return [...derived.values()].flatMap(({ pieces }) => pieces).find(({ id }) => id === ref?.recordId);
    return derived.get(ref.recordId || ref.entityId)?.pieces.find((piece) => (
      piece.segmentIndex === selector.segmentIndex
      && piece.role === selector.role
      && piece.ordinal === selector.ordinal
    ));
  };
  return {
    parameterEntityIds(parameterIds) {
      const affected = new Set(parameterIds);
      return sources().filter((entity) => {
        const dependencies = new Set();
        const definitions = [swellDefinitionForEntity(entity), ...Object.keys(entity.composite?.swellSegments || {})
          .map((index) => swellDefinitionForEntity(entity, Number(index)))];
        for (const definition of definitions) {
          for (const [key, expression] of Object.entries(definition || {})) {
            if (!key.endsWith('Expression')) continue;
            try { dimensions.evaluateLengthExpression(expression, { stackId: entity.stackId, dependencies }); }
            catch { /* Geometry evaluation reports invalid definitions. Retain known dependencies. */ }
          }
        }
        return [...dependencies].some((id) => affected.has(id));
      }).map(({ id }) => id);
    },
    binding(ref) {
      const piece = pieceFor(ref);
      if (!piece) return null;
      return createGeometryBinding(transformStackEntity(
        { ...piece.entity, id: piece.id }, model.frameForReference(ref), true,
      ));
    },
    variableIds(ref) {
      const ownerId = ref.recordId || ref.entityId;
      const groups = swellSourceComponents(sources(), constraints());
      const group = [...groups.values()].find((entries) => entries.some(({ id }) => id === ownerId)) || [];
      return group.flatMap(({ id }) => model.binding(id).allVariables().map((variable) => variable.id));
    },
    // Versions 1 and 2 stored these equations outside the solver. Import them
    // once into the ordinary graph, retaining their IDs and source selectors.
    restoreConstraints(snapshot) {
      const restored = [...(snapshot?.constraints || [])];
      const restoredIds = new Set(restored.map(({ id }) => id).filter(Boolean));
      for (const input of snapshot?.extensions?.swell?.constraints || []) {
        if (restoredIds.has(input.id)) continue;
        const target = input.externalTarget;
        const supplied = target?.derivedRef;
        const piece = supplied && !supplied.derivedFeature && pieceFor(supplied);
        const derivedRef = supplied?.derivedFeature ? supplied : piece ? {
          ...supplied,
          recordId: piece.ownerId,
          derivedFeature: { provider: 'swell', segmentIndex: piece.segmentIndex, role: piece.role, ordinal: piece.ordinal },
        } : supplied;
        const ordinaryRef = input.type === 'Concentric'
          ? { kind: model.binding(target?.movableRef?.recordId)?.type, recordId: target?.movableRef?.recordId }
          : target?.movableRef;
        const { externalTarget, ...constraint } = input;
        restored.push({
          ...constraint,
          featureRefs: derivedRef && ordinaryRef
            ? (input.type.startsWith('Point-on ') ? [ordinaryRef, derivedRef] : [derivedRef, ordinaryRef])
            : constraint.featureRefs,
        });
        restoredIds.add(input.id);
      }
      return restored;
    },
  };
}
