const nodeKey = (kind, id) => `${kind}:${id}`;

function collectReferences(value, references, visited = new Set()) {
  if (!value || typeof value !== 'object' || visited.has(value)) return;
  visited.add(value);
  if (!Array.isArray(value) && (value.recordId || value.entityId)) {
    references.push(value);
  }
  if (Array.isArray(value)) value.forEach((item) => collectReferences(item, references, visited));
  else Object.values(value).forEach((item) => collectReferences(item, references, visited));
}

function referenceVariableIds(model, reference) {
  const ids = new Set(model.variableIdsForFeature(reference));
  if (ids.size) return ids;
  const derivedId = reference?.recordId || reference?.entityId;
  const derived = derivedId ? model.derivedEntity(derivedId) : null;
  if (!derived) return ids;
  const sourceReferences = [];
  collectReferences(derived, sourceReferences);
  sourceReferences.forEach((source) => {
    model.variableIdsForFeature(source).forEach((id) => ids.add(id));
  });
  return ids;
}

function referencedRecordIds(value) {
  const references = [];
  collectReferences(value, references);
  return new Set(references
    .map((reference) => reference.recordId || reference.entityId)
    .filter(Boolean));
}

export function constraintVariableIds(model, constraint) {
  const ids = new Set();
  const references = [];
  collectReferences(constraint?.featureRefs || [], references);
  collectReferences(constraint?.anchors || null, references);
  collectReferences(constraint?.tangentPoint || null, references);
  references.forEach((reference) => {
    referenceVariableIds(model, reference).forEach((id) => ids.add(id));
  });
  if (constraint?.parameterRef) ids.add(constraint.parameterRef);
  return ids;
}

export class ScopedSketchModel {
  constructor(model, scope, variablesById = null) {
    this.source = model;
    this.scope = scope;
    this.entities = model.entities;
    this.derivedEntities = model.derivedEntities;
    this.constraints = new Map([...scope.constraintIds]
      .map((id) => [id, model.constraints.get(id)])
      .filter(([, constraint]) => constraint));
    this.variablesById = variablesById || new Map(model.allVariables().map((variable) => [variable.id, variable]));
    this.variables = [...scope.variableIds]
      .map((id) => this.variablesById.get(id))
      .filter(Boolean);
  }

  allVariables() {
    return this.variables;
  }

  activeVariables() {
    return this.variables.filter((variable) => variable.active);
  }

  variableById(id) {
    return this.variablesById.get(id) || null;
  }

  binding(id) {
    return this.source.binding(id);
  }

  entity(id) {
    return this.source.entity(id);
  }

  derivedEntity(id) {
    return this.source.derivedEntity(id);
  }

  resolvePoint(ref) {
    return this.source.resolvePoint(ref);
  }

  resolveSegment(ref) {
    return this.source.resolveSegment(ref);
  }

  resolveEntity(ref) {
    return this.source.resolveEntity(ref);
  }

  resolveFeature(ref) {
    return this.source.resolveFeature(ref);
  }

  variableIdsForFeature(ref) {
    return this.source.variableIdsForFeature(ref);
  }

  intrinsicResiduals() {
    return [...this.scope.intrinsicEntityIds].flatMap((id) => this.source.binding(id)?.intrinsicResiduals() || []);
  }
}

export class ConstraintGraph {
  constructor(model) {
    this.model = model;
    this.variableConstraints = new Map();
    this.constraintVariables = new Map();
    this.intrinsicEntityByNode = new Map();
    this.components = new Map();
    this.componentForVariable = new Map();
    this.componentForConstraint = new Map();
    this.variablesById = new Map();
    this.recordsForConstraint = new Map();
    this.constraintsForRecord = new Map();
    this.sourcesForDerivedEntity = new Map();
    this.derivedEntitiesForSource = new Map();
    this.rebuild();
  }

  connect(constraintNode, variableId) {
    if (!this.variableConstraints.has(variableId)) this.variableConstraints.set(variableId, new Set());
    if (!this.constraintVariables.has(constraintNode)) this.constraintVariables.set(constraintNode, new Set());
    this.variableConstraints.get(variableId).add(constraintNode);
    this.constraintVariables.get(constraintNode).add(variableId);
  }

  indexConstraintRecords(constraintId, constraint) {
    this.unindexConstraintRecords(constraintId);
    const recordIds = referencedRecordIds(constraint);
    this.recordsForConstraint.set(constraintId, recordIds);
    recordIds.forEach((recordId) => {
      if (!this.constraintsForRecord.has(recordId)) this.constraintsForRecord.set(recordId, new Set());
      this.constraintsForRecord.get(recordId).add(constraintId);
    });
  }

  unindexConstraintRecords(constraintId) {
    this.recordsForConstraint.get(constraintId)?.forEach((recordId) => {
      const constraintIds = this.constraintsForRecord.get(recordId);
      constraintIds?.delete(constraintId);
      if (!constraintIds?.size) this.constraintsForRecord.delete(recordId);
    });
    this.recordsForConstraint.delete(constraintId);
  }

  indexDerivedEntity(entityId, entity) {
    this.unindexDerivedEntity(entityId);
    const sourceIds = referencedRecordIds(entity);
    this.sourcesForDerivedEntity.set(entityId, sourceIds);
    sourceIds.forEach((sourceId) => {
      if (!this.derivedEntitiesForSource.has(sourceId)) this.derivedEntitiesForSource.set(sourceId, new Set());
      this.derivedEntitiesForSource.get(sourceId).add(entityId);
    });
  }

  unindexDerivedEntity(entityId) {
    this.sourcesForDerivedEntity.get(entityId)?.forEach((sourceId) => {
      const derivedIds = this.derivedEntitiesForSource.get(sourceId);
      derivedIds?.delete(entityId);
      if (!derivedIds?.size) this.derivedEntitiesForSource.delete(sourceId);
    });
    this.sourcesForDerivedEntity.delete(entityId);
  }

  rebuild() {
    this.variableConstraints.clear();
    this.constraintVariables.clear();
    this.intrinsicEntityByNode.clear();
    this.components.clear();
    this.componentForVariable.clear();
    this.componentForConstraint.clear();
    this.recordsForConstraint.clear();
    this.constraintsForRecord.clear();
    this.sourcesForDerivedEntity.clear();
    this.derivedEntitiesForSource.clear();

    const variables = this.model.allVariables();
    this.variablesById = new Map(variables.map((variable) => [variable.id, variable]));
    variables.forEach((variable) => this.variableConstraints.set(variable.id, new Set()));
    for (const [entityId, entity] of this.model.derivedEntities) this.indexDerivedEntity(entityId, entity);
    for (const [constraintId, constraint] of this.model.constraints) {
      this.indexConstraintRecords(constraintId, constraint);
      if (constraint.enabled === false) continue;
      const constraintNode = nodeKey('constraint', constraintId);
      constraintVariableIds(this.model, constraint).forEach((variableId) => this.connect(constraintNode, variableId));
    }
    for (const [entityId, binding] of this.model.entities) {
      if (!binding.intrinsicResiduals().length) continue;
      const intrinsicNode = nodeKey('intrinsic', entityId);
      this.intrinsicEntityByNode.set(intrinsicNode, entityId);
      binding.allVariables().forEach((variable) => this.connect(intrinsicNode, variable.id));
    }

    const visitedVariables = new Set();
    for (const variable of variables) {
      if (visitedVariables.has(variable.id)) continue;
      const pendingVariables = [variable.id];
      const visitedConstraintNodes = new Set();
      const variableIds = new Set();
      const constraintIds = new Set();
      const intrinsicEntityIds = new Set();
      while (pendingVariables.length) {
        const variableId = pendingVariables.pop();
        if (visitedVariables.has(variableId)) continue;
        visitedVariables.add(variableId);
        variableIds.add(variableId);
        for (const constraintNode of this.variableConstraints.get(variableId) || []) {
          if (visitedConstraintNodes.has(constraintNode)) continue;
          visitedConstraintNodes.add(constraintNode);
          if (constraintNode.startsWith('constraint:')) constraintIds.add(constraintNode.slice('constraint:'.length));
          const intrinsicEntityId = this.intrinsicEntityByNode.get(constraintNode);
          if (intrinsicEntityId) intrinsicEntityIds.add(intrinsicEntityId);
          for (const connectedVariableId of this.constraintVariables.get(constraintNode) || []) {
            if (!visitedVariables.has(connectedVariableId)) pendingVariables.push(connectedVariableId);
          }
        }
      }
      const stableAnchor = [...variableIds].sort()[0] || `empty-${this.components.size}`;
      const componentId = `component:${stableAnchor}`;
      const entityIds = new Set([...variableIds]
        .map((id) => this.variablesById.get(id)?.owner)
        .filter(Boolean));
      const dimensionIds = new Set([...constraintIds]
        .map((id) => this.model.constraints.get(id)?.dimensionRef)
        .filter(Boolean));
      const component = {
        id: componentId,
        variableIds,
        constraintIds,
        intrinsicEntityIds,
        entityIds,
        dimensionIds,
      };
      this.components.set(componentId, component);
      variableIds.forEach((id) => this.componentForVariable.set(id, componentId));
      constraintIds.forEach((id) => this.componentForConstraint.set(id, componentId));
    }
    return this;
  }

  installComponent(variableIds, constraintNodes) {
    const constraintIds = new Set();
    const intrinsicEntityIds = new Set();
    constraintNodes.forEach((constraintNode) => {
      if (constraintNode.startsWith('constraint:')) constraintIds.add(constraintNode.slice('constraint:'.length));
      const intrinsicEntityId = this.intrinsicEntityByNode.get(constraintNode);
      if (intrinsicEntityId) intrinsicEntityIds.add(intrinsicEntityId);
    });
    const stableAnchor = [...variableIds].sort()[0] || `empty-${this.components.size}`;
    const componentId = `component:${stableAnchor}`;
    const entityIds = new Set([...variableIds]
      .map((id) => this.variablesById.get(id)?.owner)
      .filter(Boolean));
    const dimensionIds = new Set([...constraintIds]
      .map((id) => this.model.constraints.get(id)?.dimensionRef)
      .filter(Boolean));
    const component = {
      id: componentId,
      variableIds,
      constraintIds,
      intrinsicEntityIds,
      entityIds,
      dimensionIds,
    };
    this.components.set(componentId, component);
    variableIds.forEach((id) => this.componentForVariable.set(id, componentId));
    constraintIds.forEach((id) => this.componentForConstraint.set(id, componentId));
    return component;
  }

  removeComponents(componentIds) {
    componentIds.forEach((componentId) => {
      const component = this.components.get(componentId);
      component?.variableIds.forEach((id) => this.componentForVariable.delete(id));
      component?.constraintIds.forEach((id) => this.componentForConstraint.delete(id));
      this.components.delete(componentId);
    });
  }

  rebuildComponentsForVariables(seedVariableIds) {
    const affected = new Set();
    const pending = [...seedVariableIds].filter((id) => this.variableConstraints.has(id));
    while (pending.length) {
      const variableId = pending.pop();
      if (affected.has(variableId) || !this.variableConstraints.has(variableId)) continue;
      affected.add(variableId);
      const previousComponent = this.components.get(this.componentForVariable.get(variableId));
      previousComponent?.variableIds.forEach((id) => {
        if (!affected.has(id) && this.variableConstraints.has(id)) pending.push(id);
      });
      for (const constraintNode of this.variableConstraints.get(variableId) || []) {
        for (const connectedVariableId of this.constraintVariables.get(constraintNode) || []) {
          if (!affected.has(connectedVariableId)) pending.push(connectedVariableId);
        }
      }
    }
    const removedComponentIds = new Set([...affected]
      .map((id) => this.componentForVariable.get(id))
      .filter(Boolean));
    this.removeComponents(removedComponentIds);

    const visited = new Set();
    for (const startId of affected) {
      if (visited.has(startId)) continue;
      const variableIds = new Set();
      const constraintNodes = new Set();
      const componentPending = [startId];
      while (componentPending.length) {
        const variableId = componentPending.pop();
        if (visited.has(variableId) || !affected.has(variableId)) continue;
        visited.add(variableId);
        variableIds.add(variableId);
        for (const constraintNode of this.variableConstraints.get(variableId) || []) {
          constraintNodes.add(constraintNode);
          for (const connectedVariableId of this.constraintVariables.get(constraintNode) || []) {
            if (!visited.has(connectedVariableId)) componentPending.push(connectedVariableId);
          }
        }
      }
      this.installComponent(variableIds, constraintNodes);
    }
  }

  addEntity(entityId) {
    const binding = this.model.binding(entityId);
    if (!binding) return false;
    const variables = binding.allVariables();
    variables.forEach((variable) => {
      this.variablesById.set(variable.id, variable);
      if (!this.variableConstraints.has(variable.id)) this.variableConstraints.set(variable.id, new Set());
    });
    if (binding.intrinsicResiduals().length) {
      const intrinsicNode = nodeKey('intrinsic', entityId);
      this.intrinsicEntityByNode.set(intrinsicNode, entityId);
      variables.forEach((variable) => this.connect(intrinsicNode, variable.id));
    }
    this.rebuildComponentsForVariables(variables.map((variable) => variable.id));
    return true;
  }

  addConstraint(constraintId) {
    const constraint = this.model.constraints.get(constraintId);
    if (!constraint) return false;
    this.indexConstraintRecords(constraintId, constraint);
    if (constraint.enabled === false) return false;
    const constraintNode = nodeKey('constraint', constraintId);
    const variableIds = constraintVariableIds(this.model, constraint);
    variableIds.forEach((variableId) => this.connect(constraintNode, variableId));
    this.rebuildComponentsForVariables(variableIds);
    return true;
  }

  variableIdsForEntity(entityId) {
    const binding = this.model.binding(entityId);
    if (binding) return new Set(binding.allVariables().map((variable) => variable.id));
    return new Set([...this.variablesById]
      .filter(([, variable]) => variable.owner === entityId)
      .map(([id]) => id));
  }

  constraintIdsForEntity(entityId) {
    const constraintIds = new Set();
    this.variableIdsForEntity(entityId).forEach((variableId) => {
      for (const constraintNode of this.variableConstraints.get(variableId) || []) {
        if (constraintNode.startsWith('constraint:')) {
          constraintIds.add(constraintNode.slice('constraint:'.length));
        }
      }
    });
    return constraintIds;
  }

  constraintIdsForRecord(recordId) {
    return new Set(this.constraintsForRecord.get(recordId) || []);
  }

  hasDerivedDependency(entityId) {
    return Boolean(this.derivedEntitiesForSource.get(entityId)?.size);
  }

  disconnectConstraintNode(constraintNode) {
    const variableIds = new Set(this.constraintVariables.get(constraintNode) || []);
    variableIds.forEach((variableId) => this.variableConstraints.get(variableId)?.delete(constraintNode));
    this.constraintVariables.delete(constraintNode);
    return variableIds;
  }

  refreshConstraints(constraintIds) {
    const affectedVariableIds = new Set();
    const ids = new Set(constraintIds);
    ids.forEach((constraintId) => {
      const constraintNode = nodeKey('constraint', constraintId);
      this.disconnectConstraintNode(constraintNode).forEach((id) => affectedVariableIds.add(id));
      const constraint = this.model.constraints.get(constraintId);
      if (!constraint) {
        this.unindexConstraintRecords(constraintId);
        this.componentForConstraint.delete(constraintId);
        return;
      }
      this.indexConstraintRecords(constraintId, constraint);
      if (constraint.enabled === false) return;
      constraintVariableIds(this.model, constraint).forEach((variableId) => {
        this.connect(constraintNode, variableId);
        affectedVariableIds.add(variableId);
      });
    });
    this.rebuildComponentsForVariables(affectedVariableIds);
    return affectedVariableIds;
  }

  removeConstraints(constraintIds, { retainReferences = false } = {}) {
    const affectedVariableIds = new Set();
    new Set(constraintIds).forEach((constraintId) => {
      const constraintNode = nodeKey('constraint', constraintId);
      this.disconnectConstraintNode(constraintNode).forEach((variableId) => {
        const component = this.components.get(this.componentForVariable.get(variableId));
        component?.variableIds.forEach((id) => affectedVariableIds.add(id));
      });
      this.componentForConstraint.delete(constraintId);
      if (!retainReferences) this.unindexConstraintRecords(constraintId);
    });
    this.rebuildComponentsForVariables(affectedVariableIds);
    return affectedVariableIds;
  }

  removeConstraint(constraintId, options = {}) {
    return this.removeConstraints([constraintId], options);
  }

  updateEntity(entityId, previousVariableIds, constraintIds = []) {
    const oldVariableIds = new Set(previousVariableIds);
    const affectedVariableIds = new Set();
    const affectedComponentIds = new Set();
    const constraintNodes = new Set();
    oldVariableIds.forEach((variableId) => {
      const componentId = this.componentForVariable.get(variableId);
      if (componentId) affectedComponentIds.add(componentId);
      const component = this.components.get(componentId);
      component?.variableIds.forEach((id) => affectedVariableIds.add(id));
      this.variableConstraints.get(variableId)?.forEach((constraintNode) => constraintNodes.add(constraintNode));
    });
    constraintIds.forEach((constraintId) => constraintNodes.add(nodeKey('constraint', constraintId)));
    const intrinsicNode = nodeKey('intrinsic', entityId);
    if (this.constraintVariables.has(intrinsicNode)) constraintNodes.add(intrinsicNode);

    constraintNodes.forEach((constraintNode) => {
      this.disconnectConstraintNode(constraintNode).forEach((id) => affectedVariableIds.add(id));
    });
    this.removeComponents(affectedComponentIds);
    oldVariableIds.forEach((variableId) => {
      this.variableConstraints.delete(variableId);
      this.componentForVariable.delete(variableId);
      this.variablesById.delete(variableId);
    });
    this.intrinsicEntityByNode.delete(intrinsicNode);

    const binding = this.model.binding(entityId);
    if (!binding) {
      this.rebuildComponentsForVariables(affectedVariableIds);
      return affectedVariableIds;
    }
    const variables = binding.allVariables();
    variables.forEach((variable) => {
      this.variablesById.set(variable.id, variable);
      this.variableConstraints.set(variable.id, new Set());
      affectedVariableIds.add(variable.id);
    });
    constraintNodes.forEach((constraintNode) => {
      if (!constraintNode.startsWith('constraint:')) return;
      const constraintId = constraintNode.slice('constraint:'.length);
      const constraint = this.model.constraints.get(constraintId);
      if (!constraint || constraint.enabled === false) return;
      this.indexConstraintRecords(constraintId, constraint);
      constraintVariableIds(this.model, constraint).forEach((variableId) => {
        this.connect(constraintNode, variableId);
        affectedVariableIds.add(variableId);
      });
    });
    if (binding.intrinsicResiduals().length) {
      this.intrinsicEntityByNode.set(intrinsicNode, entityId);
      variables.forEach((variable) => this.connect(intrinsicNode, variable.id));
    }
    this.rebuildComponentsForVariables(affectedVariableIds);
    return affectedVariableIds;
  }

  updateDerivedEntity(entityId) {
    this.indexDerivedEntity(entityId, this.model.derivedEntities.get(entityId));
    return this.refreshConstraints(this.constraintIdsForRecord(entityId));
  }

  removeDerivedEntity(entityId, removedConstraintIds = []) {
    this.unindexDerivedEntity(entityId);
    return this.removeConstraints(removedConstraintIds);
  }

  removeEntity(entityId, removedConstraintIds = [], knownVariableIds = null) {
    const removedVariableIds = knownVariableIds
      ? new Set(knownVariableIds)
      : this.variableIdsForEntity(entityId);
    if (!removedVariableIds.size) return new Set();

    const affectedComponentIds = new Set([...removedVariableIds]
      .map((id) => this.componentForVariable.get(id))
      .filter(Boolean));
    const removedConstraintNodes = new Set([...removedConstraintIds].map((id) => nodeKey('constraint', id)));
    const intrinsicNode = nodeKey('intrinsic', entityId);
    if (this.constraintVariables.has(intrinsicNode)) removedConstraintNodes.add(intrinsicNode);

    removedConstraintNodes.forEach((constraintNode) => {
      for (const variableId of this.constraintVariables.get(constraintNode) || []) {
        const componentId = this.componentForVariable.get(variableId);
        if (componentId) affectedComponentIds.add(componentId);
        this.variableConstraints.get(variableId)?.delete(constraintNode);
      }
      this.constraintVariables.delete(constraintNode);
      if (constraintNode.startsWith('constraint:')) {
        const constraintId = constraintNode.slice('constraint:'.length);
        this.componentForConstraint.delete(constraintId);
        this.unindexConstraintRecords(constraintId);
      }
    });
    this.intrinsicEntityByNode.delete(intrinsicNode);

    const affectedVariableIds = new Set();
    affectedComponentIds.forEach((componentId) => {
      this.components.get(componentId)?.variableIds.forEach((id) => {
        if (!removedVariableIds.has(id)) affectedVariableIds.add(id);
      });
    });
    removedVariableIds.forEach((variableId) => {
      for (const constraintNode of this.variableConstraints.get(variableId) || []) {
        this.constraintVariables.get(constraintNode)?.delete(variableId);
      }
      this.variableConstraints.delete(variableId);
      this.componentForVariable.delete(variableId);
      this.variablesById.delete(variableId);
    });

    this.removeComponents(affectedComponentIds);
    this.rebuildComponentsForVariables(affectedVariableIds);
    return affectedVariableIds;
  }

  scopeForSeeds({ variableIds = [], entityIds = [], constraintIds = [], dimensionIds = [] } = {}) {
    const componentIds = new Set();
    variableIds.forEach((id) => {
      const componentId = this.componentForVariable.get(id);
      if (componentId) componentIds.add(componentId);
    });
    entityIds.forEach((entityId) => {
      this.model.binding(entityId)?.allVariables().forEach((variable) => {
        const componentId = this.componentForVariable.get(variable.id);
        if (componentId) componentIds.add(componentId);
      });
    });
    constraintIds.forEach((id) => {
      const componentId = this.componentForConstraint.get(id);
      if (componentId) componentIds.add(componentId);
    });
    const dimensions = new Set(dimensionIds);
    if (dimensions.size) {
      this.components.forEach((component, componentId) => {
        if ([...component.dimensionIds].some((id) => dimensions.has(id))) componentIds.add(componentId);
      });
    }
    if (!componentIds.size) return null;

    const scope = {
      componentIds,
      variableIds: new Set(),
      constraintIds: new Set(),
      intrinsicEntityIds: new Set(),
      entityIds: new Set(),
      dimensionIds: new Set(),
    };
    componentIds.forEach((componentId) => {
      const component = this.components.get(componentId);
      if (!component) return;
      for (const key of ['variableIds', 'constraintIds', 'intrinsicEntityIds', 'entityIds', 'dimensionIds']) {
        component[key].forEach((id) => scope[key].add(id));
      }
    });
    return scope;
  }

  diagnostics({ registry = null, dimensions = null } = {}) {
    const parameterIds = new Set();
    const collectParameterDependencies = (id) => {
      if (!id || parameterIds.has(id)) return;
      parameterIds.add(id);
      dimensions?.dependencies?.get(id)?.forEach(collectParameterDependencies);
    };
    this.components.forEach((component) => component.dimensionIds.forEach(collectParameterDependencies));
    const components = [...this.components.values()].map((component) => {
      let residualCount = null;
      if (registry) {
        try {
          residualCount = registry.evaluate(this.scopedModel({
            ...component,
            componentIds: new Set([component.id]),
          }), dimensions).values.length;
        } catch {
          residualCount = null;
        }
      }
      return {
        id: component.id,
        variableCount: component.variableIds.size,
        constraintCount: component.constraintIds.size,
        intrinsicEntityCount: component.intrinsicEntityIds.size,
        entityCount: component.entityIds.size,
        dimensionCount: component.dimensionIds.size,
        residualCount,
      };
    });
    return {
      componentCount: this.components.size,
      variableCount: this.variableConstraints.size,
      constraintCount: this.componentForConstraint.size,
      fixedVariableCount: this.model.allVariables().filter((variable) => variable.fixed).length,
      residualCount: components.every((component) => component.residualCount !== null)
        ? components.reduce((sum, component) => sum + component.residualCount, 0)
        : null,
      referencedParameterCount: parameterIds.size,
      components,
    };
  }

  scopedModel(scope) {
    return new ScopedSketchModel(this.model, scope, this.variablesById);
  }
}
