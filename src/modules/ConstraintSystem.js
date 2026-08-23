import { CANVAS_ORIGIN_RECORD_ID } from './CanvasOrigin.js';
import { ARC_MIDPOINT_ROLE } from './ArcGeometry.js';
import { isSelfCoincidentConstraint } from './solver/ConstraintValidation.js';

// --- Auto-Constraint Detection ---
const angleTolerance = 1.5 * Math.PI / 180;

function segments(entity) {
  if (entity.type === 'line') return [{ index: 0, start: entity.start, end: entity.end }];
  if (entity.type === 'polyline' || entity.type === 'polygon') {
    const count = entity.type === 'polygon' ? entity.points.length : entity.points.length - 1;
    return Array.from({ length: Math.max(0, count) }, (_, index) => ({
      index,
      start: entity.points[index],
      end: entity.points[(index + 1) % entity.points.length],
    }));
  }
  return [];
}

function segmentAngle(segment) {
  const angle = Math.atan2(segment.end[1] - segment.start[1], segment.end[0] - segment.start[0]);
  return (angle + Math.PI) % Math.PI;
}

function parallelError(a, b) {
  const delta = Math.abs(a - b);
  return Math.min(delta, Math.PI - delta);
}

function perpendicularError(a, b) {
  return Math.abs(parallelError(a, b) - Math.PI / 2);
}

function circleCenterFromThreePoints(a, b, c) {
  const denominator = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(denominator) < 0.0001) return null;
  const aa = a[0] ** 2 + a[1] ** 2;
  const bb = b[0] ** 2 + b[1] ** 2;
  const cc = c[0] ** 2 + c[1] ** 2;
  return [
    (aa * (b[1] - c[1]) + bb * (c[1] - a[1]) + cc * (a[1] - b[1])) / denominator,
    (aa * (c[0] - b[0]) + bb * (a[0] - c[0]) + cc * (b[0] - a[0])) / denominator,
  ];
}

function roundFeature(entity) {
  if (entity.type === 'circle') return { kind: 'circle', center: entity.center };
  if (entity.type === 'arc') {
    const center = entity.center || circleCenterFromThreePoints(entity.start, entity.arcPoint, entity.end);
    if (center) return { kind: 'arc', center };
  }
  return null;
}

function newPointIndex(entity, clickIndex, snapCount) {
  if (entity.type === 'line') return [0, 2][clickIndex];
  if (entity.type === 'circle') return clickIndex === 0 ? 0 : undefined;
  if (entity.type === 'arc') return clickIndex <= 2 ? clickIndex : undefined;
  if (entity.type === 'polygon' && entity.points.length === 4 && snapCount === 2) return [0, 2][clickIndex];
  if (entity.type === 'polygon' || entity.type === 'polyline' || entity.type === 'curve') return clickIndex < entity.points.length ? clickIndex : undefined;
  return undefined;
}

function descriptorKey(constraint) {
  return JSON.stringify(constraint);
}

export function detectAutoConstraints({ entity, recordId, snapRefs = [], existingEntities = [], worldTolerance = 1 }) {
  const constraints = [];
  const keys = new Set();
  const add = (constraint) => {
    const key = descriptorKey(constraint);
    if (keys.has(key)) return;
    keys.add(key);
    constraints.push(constraint);
  };

  snapRefs.forEach((snap, clickIndex) => {
    if (!snap?.recordId || snap.recordId === recordId) return;
    const pointIndex = newPointIndex(entity, clickIndex, snapRefs.length);
    if (pointIndex === undefined) return;
    const target = existingEntities.find((candidate) => candidate.id === snap.recordId);
    const newRound = roundFeature(entity);
    const targetRound = target && roundFeature(target);
    const newCenterIndex = entity.type === 'circle' ? 0 : 3;
    const targetCenterIndex = target?.type === 'circle' ? 0 : 3;
    if (newRound && targetRound && pointIndex === newCenterIndex && snap.index === targetCenterIndex) {
      add({ type: 'Concentric', featureRefs: [{ kind: entity.type, recordId }, { kind: target.type, recordId: target.id }], source: 'auto' });
      return;
    }
    add({
      type: 'Coincident',
      featureRefs: [
        { kind: 'point', recordId, index: pointIndex },
        {
          kind: 'point',
          recordId: snap.recordId,
          index: snap.index,
          ...(snap.pointRole === ARC_MIDPOINT_ROLE ? { pointRole: ARC_MIDPOINT_ROLE } : {}),
        },
      ],
      source: 'auto',
    });
  });

  const existingSegments = existingEntities.flatMap((candidate) => segments(candidate).map((segment) => ({ ...segment, recordId: candidate.id })));
  segments(entity).forEach((segment) => {
    const angle = segmentAngle(segment);
    const horizontalError = Math.min(angle, Math.PI - angle);
    const verticalError = Math.abs(angle - Math.PI / 2);
    if (horizontalError <= angleTolerance) {
      add({ type: 'Horizontal', featureRefs: [{ kind: 'segment', recordId, index: segment.index }], source: 'auto' });
      return;
    }
    if (verticalError <= angleTolerance) {
      add({ type: 'Vertical', featureRefs: [{ kind: 'segment', recordId, index: segment.index }], source: 'auto' });
      return;
    }
    let best = null;
    existingSegments.forEach((candidate) => {
      const candidateAngle = segmentAngle(candidate);
      const options = [
        { type: 'Parallel', error: parallelError(angle, candidateAngle) },
        { type: 'Perpendicular', error: perpendicularError(angle, candidateAngle) },
      ];
      options.forEach((option) => {
        if (option.error > angleTolerance || (best && option.error >= best.error)) return;
        best = { ...option, candidate };
      });
    });
    if (best) add({
      type: best.type,
      featureRefs: [{ kind: 'segment', recordId, index: segment.index }, { kind: 'segment', recordId: best.candidate.recordId, index: best.candidate.index }],
      source: 'auto',
    });
  });

  const newRound = roundFeature(entity);
  if (newRound) {
    let closest = null;
    existingEntities.forEach((candidate) => {
      const targetRound = roundFeature(candidate);
      if (!targetRound) return;
      const distance = Math.hypot(newRound.center[0] - targetRound.center[0], newRound.center[1] - targetRound.center[1]);
      if (distance <= worldTolerance && (!closest || distance < closest.distance)) closest = { entity: candidate, distance };
    });
    if (closest) add({
      type: 'Concentric',
      featureRefs: [{ kind: entity.type, recordId }, { kind: closest.entity.type, recordId: closest.entity.id }],
      source: 'auto',
    });
  }
  return constraints;
}

export function detectAutoConstraintsForEntities({ entries = [], existingEntities = [], worldTolerance = 1 }) {
  const availableEntities = [...existingEntities];
  const constraints = [];
  entries.forEach(({ entity, snapRefs = [] }) => {
    if (!entity?.id) throw new TypeError('Batched auto-constraint entities require stable IDs.');
    constraints.push(...detectAutoConstraints({
      entity,
      recordId: entity.id,
      snapRefs,
      existingEntities: availableEntities,
      worldTolerance,
    }));
    availableEntities.push(entity);
  });
  return constraints;
}

function autoConstraintBatchOutcome(constraints, outcomes) {
  const accepted = outcomes.map((outcome) => outcome?.constraint).filter(Boolean);
  const latest = [...outcomes].reverse().find((outcome) => outcome?.snapshot || outcome?.result) || null;
  return {
    committed: accepted.length === constraints.length,
    constraints: accepted,
    result: latest?.result || null,
    snapshot: latest?.snapshot || null,
  };
}

/**
 * Detects and commits all constraints created by one drawing action as one
 * solver transaction. A rectangle therefore solves once for its four edge
 * constraints instead of queuing four complete authoritative solves.
 */
export function applyAutoConstraints({ solver, ...detectionOptions }) {
  if (!solver) throw new TypeError('Auto constraints require a solver.');
  const constraints = detectAutoConstraints(detectionOptions);
  if (!constraints.length) {
    return { committed: true, constraints: [], result: null, snapshot: null };
  }
  if (typeof solver.applyConstraintBatch === 'function') {
    return solver.applyConstraintBatch({ constraints });
  }
  const outcomes = constraints.map((constraint) => (
    typeof solver.addConstraintAuthoritative === 'function'
      ? solver.addConstraintAuthoritative(constraint)
      : solver.addConstraint(constraint)
  ));
  return outcomes.some((outcome) => outcome?.then)
    ? Promise.all(outcomes).then((resolved) => autoConstraintBatchOutcome(constraints, resolved))
    : autoConstraintBatchOutcome(constraints, outcomes);
}

// --- Constraint Handlers & Overlay Helpers ---
const supportedConstraints = [
  'Coincident',
  'Concentric',
  'Collinear',
  'Midpoint',
  'Fixed',
  'Parallel',
  'Perpendicular',
  'Horizontal',
  'Vertical',
  'Equal',
  'Length',
  'Tangent',
  'Point-on',
];
const MIN_CONSTRAINT_HELPER_ZOOM = 0.1;

const constraintIconPaths = {
  Coincident: '<path d="M4 18l8-8 8 8"/><circle cx="12" cy="10" r="2" fill="currentColor"/>',
  Concentric: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/>',
  Collinear: '<path d="M4 12h16"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/>',
  Midpoint: '<path d="M5 12h14"/><path d="M12 7l4 5-4 5-4-5z"/>',
  Fixed: '<rect x="5" y="10" width="14" height="10" rx="1"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2"/>',
  Length: '<path d="M5 8h14M5 16h14"/><path d="M8 5v6M16 13v6"/>',
  Parallel: '<path d="M8 5v14M16 5v14"/>',
  Perpendicular: '<path d="M7 5v12h12"/>',
  Horizontal: '<path d="M5 12h14"/>',
  Vertical: '<path d="M12 5v14"/>',
  Equal: '<path d="M6 9h12M6 15h12"/>',
  Tangent: '<circle cx="9" cy="14" r="5"/><path d="M8 6l12 12"/>',
  'Point-on Line': '<path d="M5 16l14-8"/><circle cx="12" cy="12" r="2.5"/>',
  'Point-on Circle': '<circle cx="12" cy="12" r="7"/><circle cx="17" cy="12" r="2"/>',
  'Point-on Arc': '<path d="M6 16a8 8 0 0 1 12 0"/><circle cx="12" cy="8" r="2"/>',
  'Point-on Fillet': '<path d="M6 16a8 8 0 0 1 12 0"/><circle cx="12" cy="8" r="2"/>',
};

const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

export function constraintHelperPoint(feature) {
  if (!feature) return null;
  if (feature.kind === 'point') return feature.point || null;
  if (feature.kind === 'segment' && feature.start && feature.end) return midpoint(feature.start, feature.end);
  if (feature.kind === 'arc') {
    if (feature.arcPoint) return feature.arcPoint;
    if (feature.start && feature.end) return midpoint(feature.start, feature.end);
  }
  return feature.center || null;
}

function isSameFeature(a, b) {
  return a.recordId === b.recordId
    && a.kind === b.kind
    && a.index === b.index
    && a.pointRole === b.pointRole;
}

function requiredSelectionCount(constraint) {
  return ['Horizontal', 'Vertical', 'Fixed', 'Length'].includes(constraint) ? 1 : 2;
}

export function featureAllowed(constraint, feature) {
  if (!feature) return false;
  if (constraint === 'Coincident') return feature.kind === 'point';
  if (constraint === 'Concentric') return feature.kind === 'circle' || feature.kind === 'arc';
  if (constraint === 'Equal') return ['segment', 'arc', 'circle'].includes(feature.kind);
  if (constraint === 'Length') return feature.kind === 'segment' || feature.kind === 'arc';
  if (['Collinear', 'Parallel', 'Perpendicular', 'Horizontal', 'Vertical'].includes(constraint)) return feature.kind === 'segment';
  if (constraint === 'Midpoint') return feature.kind === 'point' || feature.kind === 'segment';
  if (constraint === 'Tangent') return feature.kind === 'segment' || feature.kind === 'circle' || feature.kind === 'arc';
  if (constraint === 'Point-on') return feature.kind === 'point' || feature.kind === 'segment' || feature.kind === 'circle' || feature.kind === 'arc';
  if (constraint === 'Fixed') return ['point', 'segment', 'circle', 'arc'].includes(feature.kind);
  return false;
}

export function pairAllowed(constraint, features) {
  if (features.length < 2) return true;
  if (isSelfCoincidentConstraint({ type: constraint, featureRefs: features })) return false;
  const kinds = features.map((feature) => feature.kind);
  if (constraint === 'Equal') return kinds[0] === kinds[1] && ['segment', 'arc', 'circle'].includes(kinds[0]);
  if (constraint === 'Midpoint' || constraint === 'Point-on') return kinds.includes('point') && kinds.some((kind) => kind !== 'point');
  if (constraint === 'Tangent') {
    const roundCount = kinds.filter((kind) => kind === 'circle' || kind === 'arc').length;
    const segmentCount = kinds.filter((kind) => kind === 'segment').length;
    return (roundCount === 1 && segmentCount === 1) || roundCount === 2;
  }
  return true;
}

function tangentMode(features) {
  const rounds = features.filter((feature) => feature.kind === 'circle' || feature.kind === 'arc');
  if (rounds.length !== 2) return null;
  const centerDistance = Math.hypot(
    rounds[1].center[0] - rounds[0].center[0],
    rounds[1].center[1] - rounds[0].center[1],
  );
  const externalDistance = rounds[0].radius + rounds[1].radius;
  const internalDistance = Math.abs(rounds[0].radius - rounds[1].radius);
  return Math.abs(centerDistance - internalDistance) < Math.abs(centerDistance - externalDistance) ? 'internal' : 'external';
}

function orderedFeatures(constraint, features) {
  if (constraint === 'Midpoint' || constraint === 'Point-on') return [...features].sort((a) => (a.kind === 'point' ? -1 : 1));
  return features;
}

function solverConstraintType(constraint, features) {
  if (constraint !== 'Point-on') return constraint;
  const target = features.find((feature) => feature.kind !== 'point');
  if (target?.derivedFromFillet) return 'Point-on Fillet';
  if (target?.kind === 'segment') return 'Point-on Line';
  if (target?.kind === 'circle') return 'Point-on Circle';
  if (target?.kind === 'arc') return 'Point-on Arc';
  return null;
}

function featureRef(feature) {
  return {
    kind: feature.kind,
    recordId: feature.recordId,
    entityType: feature.entityType,
    index: feature.index,
    ...(feature.pointRole ? { pointRole: feature.pointRole } : {}),
  };
}

export function constraintReferencesVisible(constraint, isRecordVisible) {
  const recordIds = [...new Set((constraint?.featureRefs || [])
    .map((feature) => feature?.recordId)
    .filter((recordId) => recordId && recordId !== CANVAS_ORIGIN_RECORD_ID))];
  return recordIds.length === 0 || recordIds.every((recordId) => isRecordVisible(recordId));
}

export function constraintReferencesActiveStack(constraint, isRecordInActiveStack) {
  const recordIds = [...new Set((constraint?.featureRefs || [])
    .map((feature) => feature?.recordId)
    .filter((recordId) => recordId && recordId !== CANVAS_ORIGIN_RECORD_ID))];
  return recordIds.length === 0 || recordIds.some((recordId) => isRecordInActiveStack(recordId));
}

export function constraintReferencesAnyRecord(constraint, recordIds) {
  return (constraint?.featureRefs || []).some(({ recordId }) => recordId && recordIds.has(recordId));
}

export function constraintRecordVisible(canvas, recordId) {
  return canvas?.isRecordVisible?.(recordId) !== false
    && canvas?.isObjectVisible?.(recordId) !== false;
}

export function setConstraintSelectionActive(canvas, active) {
  const canvasElement = canvas?.getCanvasElement?.();
  canvasElement?.classList?.toggle('constraint-selection-active', Boolean(active));
}

export function setConstraintPointAffordances(canvas, constraint) {
  const acceptsPoints = featureAllowed(constraint, { kind: 'point' });
  canvas.setOriginPointEnabled?.(acceptsPoints);
  canvas.setPointHandlesEnabled?.(acceptsPoints);
  return acceptsPoints;
}

export function constraintFeatureFromEvent(canvas, event) {
  return canvas.getFeatureFromEvent(event, { rendered: true });
}

export function createConstraintHandlers({ canvas, solver, onApplied = null }) {
  let activeConstraint = null;
  let selections = [];
  let mutationPending = false;
  let helpersRequestedVisible = true;
  const constraintOperations = new Set();
  const helperLayer = document.createElement('div');
  helperLayer.className = 'constraint-helper-layer';
  canvas.getCanvasElement().appendChild(helperLayer);

  function normalizeFeature(constraint, feature) {
    if (!feature) return null;
    if (constraint === 'Concentric' && feature.kind === 'point') return canvas.getEntityFeature(feature.recordId);
    if (constraint === 'Equal' && feature.kind === 'point') {
      const entityFeature = canvas.getEntityFeature(feature.recordId);
      if (entityFeature?.kind === 'circle' || entityFeature?.kind === 'arc') return entityFeature;
      return canvas.getSegmentFeature(feature.recordId, feature.index);
    }
    if (constraint === 'Tangent' && feature.kind === 'point') {
      const entityFeature = canvas.getEntityFeature(feature.recordId);
      if (entityFeature?.kind === 'circle' || entityFeature?.kind === 'arc') return entityFeature;
      return canvas.getSegmentFeature(feature.recordId, feature.index);
    }
    if (['Collinear', 'Parallel', 'Perpendicular', 'Horizontal', 'Vertical'].includes(constraint) && feature.kind === 'point') {
      return canvas.getSegmentFeature(feature.recordId, feature.index);
    }
    return feature;
  }

  function featureWorldPoint(ref) {
    if (ref.kind === 'point') {
      const feature = canvas.getPointFeature(ref.recordId, ref.index, { pointRole: ref.pointRole, rendered: true })
        || [...constraintOperations].map((operation) => operation.resolveFeature?.(ref)).find(Boolean);
      return feature?.point || null;
    }
    if (ref.kind === 'segment') {
      const segment = canvas.getSegmentFeature(ref.recordId, ref.index);
      return constraintHelperPoint(segment ? { kind: 'segment', ...segment } : null);
    }
    return constraintHelperPoint(canvas.getEntityFeature(ref.recordId));
  }

  function tangentWorldPoint(featureRefs, mode = null) {
    const features = featureRefs.map((ref) => {
      if (ref.kind === 'segment') return canvas.getSegmentFeature(ref.recordId, ref.index);
      if (ref.kind === 'circle' || ref.kind === 'arc') return canvas.getEntityFeature(ref.recordId);
      return null;
    }).filter(Boolean);
    const segment = features.find((feature) => feature.kind === 'segment');
    const round = features.find((feature) => feature.kind === 'circle' || feature.kind === 'arc');
    if (segment && round?.center) {
      const direction = [segment.end[0] - segment.start[0], segment.end[1] - segment.start[1]];
      const lengthSquared = direction[0] ** 2 + direction[1] ** 2;
      if (!lengthSquared) return segment.start;
      const projection = (
        (round.center[0] - segment.start[0]) * direction[0]
        + (round.center[1] - segment.start[1]) * direction[1]
      ) / lengthSquared;
      return [
        segment.start[0] + direction[0] * projection,
        segment.start[1] + direction[1] * projection,
      ];
    }
    const rounds = features.filter((feature) => feature.kind === 'circle' || feature.kind === 'arc');
    if (rounds.length === 2) {
      const direction = [
        rounds[1].center[0] - rounds[0].center[0],
        rounds[1].center[1] - rounds[0].center[1],
      ];
      const distance = Math.hypot(...direction);
      if (!distance) return rounds[0].center;
      const sign = mode === 'internal' && rounds[0].radius < rounds[1].radius ? -1 : 1;
      return [
        rounds[0].center[0] + sign * direction[0] * rounds[0].radius / distance,
        rounds[0].center[1] + sign * direction[1] * rounds[0].radius / distance,
      ];
    }
    return null;
  }

  function geometricConstraints(changedRecordIds = null) {
    const external = [...constraintOperations].flatMap((operation) => (
      (operation.constraints?.() || []).map((constraint) => ({
        ...constraint,
        constraintOperation: operation,
      }))
    ));
    const builtIn = changedRecordIds && solver.constraintsForRecordIds
      ? solver.constraintsForRecordIds(changedRecordIds)
      : solver.constraints();
    return [...builtIn, ...external].filter((constraint) => (
      constraint.source !== 'dimension'
      && constraint.featureRefs?.length
      && constraintIconPaths[constraint.type]
      && constraintReferencesActiveStack(
        constraint,
        (recordId) => canvas.isRecordInActiveStack?.(recordId) !== false,
      )
      && (constraint.constraintOperation
        ? constraint.constraintOperation.isConstraintVisible?.(constraint) !== false
        : constraintReferencesVisible(
          constraint,
          (recordId) => constraintRecordVisible(canvas, recordId),
        ))
    ));
  }

  function renderConstraintHelpers({ changedRecordIds = null } = {}) {
    syncHelpersVisibility();
    canvas.setReferenceHighlight?.([]);
    const incremental = changedRecordIds instanceof Set;
    const constraints = geometricConstraints(changedRecordIds);
    const renderable = incremental
      ? constraints.filter((constraint) => (
        constraintReferencesAnyRecord(constraint, changedRecordIds)
        || constraint.constraintOperation?.dependsOn?.(constraint, changedRecordIds)
      ))
      : constraints;
    if (!incremental) helperLayer.replaceChildren();
    else {
      const affectedConstraintIds = new Set(renderable.map(({ id }) => id));
      helperLayer.querySelectorAll('.constraint-helper-button').forEach((button) => {
        if (affectedConstraintIds.has(button.dataset.constraintId)) button.remove();
      });
    }
    if (helperLayer.hidden) return;
    const occupied = new Map();
    if (incremental) {
      helperLayer.querySelectorAll('.constraint-helper-button').forEach((button) => {
        const left = Number.parseFloat(button.style.left);
        const top = Number.parseFloat(button.style.top);
        if (!Number.isFinite(left) || !Number.isFinite(top)) return;
        const key = `${Math.round((left - 10) / 24)},${Math.round((top + 28) / 24)}`;
        occupied.set(key, (occupied.get(key) || 0) + 1);
      });
    }
    renderable.forEach((constraint) => {
      const tangentPoint = constraint.type === 'Tangent'
        ? tangentWorldPoint(constraint.featureRefs, constraint.tangentMode)
        : null;
      const helperFeatures = constraint.type === 'Coincident' || constraint.type === 'Tangent'
        ? constraint.featureRefs.slice(0, 1)
        : constraint.featureRefs;
      const coincidentPoints = constraint.type === 'Coincident'
        ? constraint.featureRefs.map(featureWorldPoint).filter(Boolean)
        : [];
      helperFeatures.forEach((feature, featureIndex) => {
        const world = tangentPoint || (coincidentPoints.length
          ? coincidentPoints.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0]).map((value) => value / coincidentPoints.length)
          : featureWorldPoint(feature));
        if (!world) return;
        const [screenX, screenY] = canvas.worldToScreen(world);
        const key = `${Math.round(screenX / 24)},${Math.round(screenY / 24)}`;
        const stackIndex = occupied.get(key) || 0;
        occupied.set(key, stackIndex + 1);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'canvas-overlay-button constraint-helper-button';
        button.title = `${constraint.type} constraint`;
        button.setAttribute('aria-label', `Remove ${constraint.type} constraint`);
        button.dataset.constraintId = constraint.id;
        button.dataset.featureIndex = String(featureIndex);
        button.style.left = `${screenX + 10 + stackIndex * 22}px`;
        button.style.top = `${screenY - 28}px`;
        button.innerHTML = `<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">${constraintIconPaths[constraint.type]}</svg>`;
        button.addEventListener('pointerdown', (event) => event.stopPropagation());
        button.addEventListener('pointerenter', () => {
          canvas.setReferenceHighlight?.(constraint.featureRefs.map((reference) => reference.recordId));
        });
        button.addEventListener('pointerleave', () => canvas.setReferenceHighlight?.([]));
        let removing = false;
        const remove = (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (removing) return;
          removing = true;
          window.dispatchEvent(new CustomEvent('paramagic:tool-activated', { detail: { source: 'constraint-helper' } }));
          const outcome = constraint.constraintOperation
            ? constraint.constraintOperation.removeConstraint?.(constraint.id)
            : solver.removeConstraintAuthoritative
              ? solver.removeConstraintAuthoritative(constraint.id)
              : solver.removeConstraint(constraint.id);
          const finish = (resolved) => {
            const removed = typeof resolved === 'boolean' ? resolved : Boolean(resolved?.removed);
            if (removed) {
              if (resolved?.snapshot) canvas.applySolverSnapshot(resolved.snapshot);
              canvas.notifyObjectChange();
            }
            renderConstraintHelpers();
            removing = false;
          };
          if (outcome?.then) {
            button.disabled = true;
            Promise.resolve(outcome).then(finish).catch(() => {
              removing = false;
              renderConstraintHelpers();
            });
          } else {
            finish(outcome);
          }
        };
        button.addEventListener('pointerup', remove);
        button.addEventListener('click', remove);
        helperLayer.appendChild(button);
      });
    });
  }

  function setHelpersVisible(visible) {
    helpersRequestedVisible = Boolean(visible);
    renderConstraintHelpers();
  }

  function syncHelpersVisibility() {
    const scale = Number(canvas.getScale?.() ?? 1);
    const visible = helpersRequestedVisible && Number.isFinite(scale) && scale >= MIN_CONSTRAINT_HELPER_ZOOM;
    helperLayer.hidden = !visible;
    if (!visible) canvas.setReferenceHighlight?.([]);
  }

  function clearSelections() {
    selections = [];
    canvas.setFeatureSelection([]);
  }

  function deactivate() {
    activeConstraint = null;
    setConstraintSelectionActive(canvas, false);
    canvas.setOriginPointEnabled?.(false);
    canvas.setPointHandlesEnabled?.(true);
    clearSelections();
    canvas.setFeatureCommandDelegate(null);
  }

  function setActiveConstraint(constraint) {
    if (!supportedConstraints.includes(constraint)) {
      deactivate();
      return false;
    }
    activeConstraint = constraint;
    setConstraintSelectionActive(canvas, true);
    setConstraintPointAffordances(canvas, constraint);
    clearSelections();
    canvas.setFeatureCommandDelegate(delegate);
    return true;
  }

  function addSelection(rawFeature) {
    if (mutationPending) return false;
    if (rawFeature?.kind === 'point' && !featureAllowed(activeConstraint, rawFeature)) return false;
    const feature = normalizeFeature(activeConstraint, rawFeature);
    if (!featureAllowed(activeConstraint, feature)) return false;
    if (selections.some((selected) => isSameFeature(selected, feature))) {
      selections = selections.filter((selected) => !isSameFeature(selected, feature));
      canvas.setFeatureSelection(selections);
      return false;
    }
    const candidate = selections.length >= 2 ? [feature] : [...selections, feature];
    if (!pairAllowed(activeConstraint, candidate)) return false;
    selections = candidate;
    canvas.setFeatureSelection(selections);
    if (selections.length < requiredSelectionCount(activeConstraint)) return true;
    const ordered = orderedFeatures(activeConstraint, selections);
    const type = solverConstraintType(activeConstraint, ordered);
    if (type) {
      const mode = type === 'Tangent' ? tangentMode(ordered) : null;
      const request = {
        type,
        featureRefs: ordered.map(featureRef),
        source: 'geometric',
        ...(mode ? { tangentMode: mode } : {}),
      };
      let outcome;
      for (const operation of constraintOperations) {
        outcome = operation.applyConstraint?.({ type, features: ordered, request });
        if (outcome !== undefined) break;
      }
      if (outcome === undefined) {
        outcome = solver.addConstraintAuthoritative
          ? solver.addConstraintAuthoritative({
          type,
          featureRefs: request.featureRefs,
          source: 'geometric',
          ...(mode ? { tangentMode: mode } : {}),
        })
          : solver.addConstraint(request);
      }
      const appliedConstraint = activeConstraint;
      const finish = (resolved) => {
        if (resolved?.constraint) {
          if (resolved.snapshot) canvas.applySolverSnapshot(resolved.snapshot);
          canvas.notifyObjectChange();
          onApplied?.({ constraint: appliedConstraint });
        }
        mutationPending = false;
        renderConstraintHelpers();
      };
      if (outcome?.then) {
        mutationPending = true;
        Promise.resolve(outcome).then(finish).catch(() => {
          mutationPending = false;
          renderConstraintHelpers();
        });
      } else {
        finish(outcome);
      }
    }
    clearSelections();
    if (mutationPending) renderConstraintHelpers();
    return true;
  }

  const delegate = {
    pointerDown(event) {
      if (!activeConstraint || event.button !== 0) return false;
      const feature = constraintFeatureFromEvent(canvas, event);
      event.preventDefault();
      event.stopPropagation();
      addSelection(feature);
      return true;
    },
    pointerMove() {
      return false;
    },
    keyDown(event) {
      if (!activeConstraint) return false;
      if (event.key === 'Escape') {
        clearSelections();
        event.preventDefault();
        return true;
      }
      return false;
    },
  };

  canvas.setConstraintOverlaySystem({
    prune: renderConstraintHelpers,
    clear() {
      canvas.setReferenceHighlight?.([]);
      helperLayer.replaceChildren();
    },
    render: renderConstraintHelpers,
  });
  canvas.onObjectsChange?.(renderConstraintHelpers);

  window.addEventListener('paramagic:tool-activated', (event) => {
    if (event.detail?.source !== 'constraint') deactivate();
  });

  return {
    setActiveConstraint,
    clearSelections,
    deactivate,
    setHelpersVisible,
    registerConstraintOperation(operation) {
      if (!operation || typeof operation !== 'object') return () => {};
      constraintOperations.add(operation);
      renderConstraintHelpers();
      return () => {
        constraintOperations.delete(operation);
        renderConstraintHelpers();
      };
    },
  };
}
