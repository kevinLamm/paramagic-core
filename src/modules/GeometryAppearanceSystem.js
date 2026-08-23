import { resolveOpacityExpression } from './AppearanceExpressions.js';
import {
  closedImageFillSelection,
  imageAppearance,
  imageFillSelectionProperties,
  resolveGeometryFillAppearance,
  updateFillAppearance,
} from './ImageSystem.js';
import {
  imageStrokeSelectionProperties,
  resolveGeometryStrokeAppearance,
  updateStrokeAppearance,
} from './ImageStrokeSystem.js';

export const DEFAULT_STROKE_COLOR = '#202020';

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function normalizeStrokeColor(value, fallback = DEFAULT_STROKE_COLOR) {
  const source = String(value || '').trim();
  return HEX_COLOR.test(source) ? source.toLowerCase() : fallback;
}

export function bindDeferredColorPicker({ picker, expressionInput, onCommit = () => {} } = {}) {
  if (!picker) return () => {};
  const syncExpression = () => {
    if (expressionInput) expressionInput.value = picker.value;
  };
  const commit = () => {
    syncExpression();
    onCommit(picker.value);
  };
  picker.addEventListener('input', syncExpression);
  picker.addEventListener('change', commit);
  return () => {
    picker.removeEventListener('input', syncExpression);
    picker.removeEventListener('change', commit);
  };
}

export function createGeometryAppearanceSystem({
  records,
  selectedIds,
  solver,
  imageFillSystem,
  imageStrokeSystem,
  isClosedGeometry = () => false,
  isSubtractableEntity = () => false,
  getSubtractSystem = () => null,
  getSelectedSegment = () => null,
  getPropertyFeature = () => null,
  getClosedCycles = () => [],
  getFilletSystem = () => null,
  getTextTools = () => null,
  getImageTools = () => null,
  rememberTextDefaults = () => {},
  resolveEntityAppearance = (entity) => entity?.appearance || {},
  applyEntityAppearanceOverrides = (entity, appearance) => ({ ...entity, appearance }),
  renderClosedRegions = () => {},
  syncGeometryStacking = () => {},
  notifyObjectChange = () => {},
} = {}) {
  function appearance(entity = {}) {
    const sourceAppearance = resolveEntityAppearance(entity) || {};
    const rawZIndex = sourceAppearance.zIndex;
    const zIndex = Number(rawZIndex);
    const strokeThickness = Number(sourceAppearance.strokeThickness);
    const fillExpression = String(sourceAppearance.fillExpression ?? sourceAppearance.fillColor ?? '#ffffff');
    const fillOpacityExpression = String(sourceAppearance.fillOpacityExpression ?? ((sourceAppearance.fillOpacity ?? 1) * 100));
    const strokeOpacityExpression = String(sourceAppearance.strokeOpacityExpression ?? ((sourceAppearance.strokeOpacity ?? 1) * 100));
    const resolvedFill = resolveGeometryFillAppearance(
      sourceAppearance,
      (expression) => solver.evaluateParameterExpression(expression),
      (expression) => solver.evaluateDrawingLengthExpression(expression),
    );
    const resolvedStroke = resolveGeometryStrokeAppearance(
      sourceAppearance,
      (expression) => solver.evaluateParameterExpression(expression),
      (expression) => solver.evaluateDrawingLengthExpression(expression),
    );
    let fillOpacity = Number.isFinite(Number(sourceAppearance.fillOpacity)) ? Number(sourceAppearance.fillOpacity) : 1;
    let strokeOpacity = Number.isFinite(Number(sourceAppearance.strokeOpacity)) ? Number(sourceAppearance.strokeOpacity) : 1;
    let fillOpacityError = null;
    let strokeOpacityError = null;
    try { fillOpacity = resolveOpacityExpression(fillOpacityExpression, (expression) => solver.evaluateParameterExpression(expression)); } catch (error) { fillOpacityError = error.message; }
    try { strokeOpacity = resolveOpacityExpression(strokeOpacityExpression, (expression) => solver.evaluateParameterExpression(expression)); } catch (error) { strokeOpacityError = error.message; }
    return {
      fillExpression,
      fillType: resolvedFill.fillType,
      fillImageReference: resolvedFill.fillImageReference,
      fillImageMode: resolvedFill.fillImageMode,
      fillImageRotationAngle: resolvedFill.fillImageRotationAngle,
      fillImageScaleExpression: resolvedFill.fillImageScaleExpression,
      fillImageScale: resolvedFill.fillImageScale,
      fillImageAspectRatio: resolvedFill.fillImageAspectRatio,
      fillImagePixelWidth: resolvedFill.fillImagePixelWidth,
      fillImagePixelHeight: resolvedFill.fillImagePixelHeight,
      fillImageWidthExpression: resolvedFill.fillImageWidthExpression,
      fillImageHeightExpression: resolvedFill.fillImageHeightExpression,
      fillImageWidth: resolvedFill.fillImageWidth,
      fillImageHeight: resolvedFill.fillImageHeight,
      fillImageLeftExpression: resolvedFill.fillImageLeftExpression,
      fillImageTopExpression: resolvedFill.fillImageTopExpression,
      fillImageLeft: resolvedFill.fillImageLeft,
      fillImageTop: resolvedFill.fillImageTop,
      imageScaleError: resolvedFill.imageScaleError,
      imageWidthError: resolvedFill.imageWidthError,
      imageHeightError: resolvedFill.imageHeightError,
      imageLeftError: resolvedFill.imageLeftError,
      imageTopError: resolvedFill.imageTopError,
      fillColor: resolvedFill.fillColor,
      strokeExpression: resolvedStroke.strokeExpression,
      strokeType: resolvedStroke.strokeType,
      strokeImageReference: resolvedStroke.strokeImageReference,
      strokeImageAspectRatio: resolvedStroke.strokeImageAspectRatio,
      strokeImagePixelWidth: resolvedStroke.strokeImagePixelWidth,
      strokeImagePixelHeight: resolvedStroke.strokeImagePixelHeight,
      strokeImageWidthExpression: resolvedStroke.strokeImageWidthExpression,
      strokeImageHeightExpression: resolvedStroke.strokeImageHeightExpression,
      strokeImageWidth: resolvedStroke.strokeImageWidth,
      strokeImageHeight: resolvedStroke.strokeImageHeight,
      strokeColor: normalizeStrokeColor(resolvedStroke.strokeColor),
      fillOpacityExpression,
      fillOpacity: Math.min(1, Math.max(0, fillOpacity)),
      strokeOpacityExpression,
      strokeOpacity: Math.min(1, Math.max(0, strokeOpacity)),
      strokeThickness: Number.isFinite(strokeThickness) && strokeThickness > 0 ? strokeThickness : 1.5,
      zIndex: rawZIndex !== null && rawZIndex !== undefined && Number.isFinite(zIndex) ? zIndex : null,
      errors: {
        fill: resolvedFill.error,
        imageScale: resolvedFill.imageScaleError,
        imageWidth: resolvedFill.imageWidthError,
        imageHeight: resolvedFill.imageHeightError,
        imageLeft: resolvedFill.imageLeftError,
        imageTop: resolvedFill.imageTopError,
        imageRotation: resolvedFill.imageRotationError,
        fillOpacity: fillOpacityError,
        strokeOpacity: strokeOpacityError,
        stroke: resolvedStroke.error,
        imageStrokeWidth: resolvedStroke.imageStrokeWidthError,
        imageStrokeHeight: resolvedStroke.imageStrokeHeightError,
      },
    };
  }

  function featureTarget() {
    const selectedSegment = getSelectedSegment();
    if (selectedSegment?.recordId) return selectedSegment;
    const propertyFeature = getPropertyFeature();
    if (propertyFeature?.recordId) return propertyFeature;
    return null;
  }

  function selectedGeometryRecords() {
    return records.filter((record) => (
      selectedIds.has(record.id)
      && ['geometry', 'fillet'].includes(record.recordType)
      && !record.entity.construction
    ));
  }

  function selectedTextRecords() {
    return records.filter((record) => selectedIds.has(record.id) && record.recordType === 'text');
  }

  function strokeTargetRecords() {
    const target = featureTarget();
    if (target?.recordId) {
      const record = records.find((candidate) => candidate.id === target.recordId);
      if (record && ['geometry', 'fillet'].includes(record.recordType) && !record.entity.construction) return [record];
    }
    return [...selectedGeometryRecords(), ...selectedTextRecords()];
  }

  function selectionProperties() {
    const selectedGeometry = selectedGeometryRecords();
    const selectedImages = records.filter((record) => (
      selectedIds.has(record.id)
      && record.recordType === 'image'
      && !record.entity.construction
    ));
    const selectedTexts = selectedTextRecords();
    const fillRecords = [...selectedGeometry, ...selectedTexts];
    const strokeRecords = strokeTargetRecords();
    const fillAppearances = fillRecords.map((record) => appearance(record.entity));
    const strokeAppearances = strokeRecords.map((record) => appearance(record.entity));
    const imageAppearances = selectedImages.map((record) => imageAppearance(
      record.entity,
      (expression) => solver.evaluateParameterExpression(expression),
    ));
    const opacityAppearances = [...fillAppearances, ...imageAppearances];
    const fillColors = new Set(fillAppearances.map(({ fillColor }) => fillColor.toLowerCase()));
    const fillExpressions = new Set(fillAppearances.map(({ fillExpression }) => fillExpression));
    const fillOpacityExpressions = new Set(opacityAppearances.map(({ fillOpacityExpression }) => fillOpacityExpression));
    const fillOpacities = new Set(opacityAppearances.map(({ fillOpacity }) => fillOpacity));
    const strokeColors = new Set(strokeAppearances.map(({ strokeColor }) => strokeColor));
    const strokeExpressions = new Set(strokeAppearances.map(({ strokeExpression }) => strokeExpression));
    const strokeOpacityExpressions = new Set(strokeAppearances.map(({ strokeOpacityExpression }) => strokeOpacityExpression));
    const strokeOpacities = new Set(strokeAppearances.map(({ strokeOpacity }) => strokeOpacity));
    const strokeThicknesses = new Set(strokeAppearances.map(({ strokeThickness }) => strokeThickness));
    const imageFillSelection = closedImageFillSelection(records, selectedIds, getClosedCycles());
    const imageFillProperties = imageFillSelectionProperties(fillAppearances, imageFillSelection.canEditImageFill);
    const imageStrokeProperties = imageStrokeSelectionProperties(
      strokeAppearances,
      strokeRecords.length > 0 && strokeRecords.every((record) => ['geometry', 'fillet'].includes(record.recordType)),
    );
    return {
      fillColor: fillColors.size === 1 ? fillAppearances[0].fillColor : null,
      fillExpression: fillExpressions.size === 1 ? fillAppearances[0].fillExpression : null,
      fillOpacityExpression: fillOpacityExpressions.size === 1 ? opacityAppearances[0].fillOpacityExpression : null,
      fillOpacity: fillOpacities.size === 1 ? opacityAppearances[0].fillOpacity : null,
      strokeColor: strokeColors.size === 1 ? strokeAppearances[0].strokeColor : null,
      strokeExpression: strokeExpressions.size === 1 ? strokeAppearances[0].strokeExpression : null,
      strokeOpacityExpression: strokeOpacityExpressions.size === 1 ? strokeAppearances[0].strokeOpacityExpression : null,
      strokeOpacity: strokeOpacities.size === 1 ? strokeAppearances[0].strokeOpacity : null,
      strokeThickness: strokeThicknesses.size === 1 ? strokeAppearances[0].strokeThickness : null,
      canEditFill: fillRecords.length > 0,
      canEditImageFill: imageFillSelection.canEditImageFill,
      ...imageFillProperties,
      ...imageStrokeProperties,
      canEditStroke: strokeRecords.length > 0,
      canEditOpacity: fillRecords.length + selectedImages.length > 0,
      errors: {
        fill: fillAppearances.find(({ errors }) => errors.fill)?.errors.fill || null,
        imageLeft: imageFillProperties.imageLeftError,
        imageTop: imageFillProperties.imageTopError,
        imageRotation: imageFillProperties.imageRotationError,
        fillOpacity: fillAppearances.find(({ errors }) => errors.fillOpacity)?.errors.fillOpacity
          || imageAppearances.find(({ error }) => error)?.error
          || null,
        strokeOpacity: strokeAppearances.find(({ errors }) => errors.strokeOpacity)?.errors.strokeOpacity || null,
        stroke: strokeAppearances.find(({ errors }) => errors.stroke)?.errors.stroke || null,
        imageStrokeWidth: imageStrokeProperties.imageStrokeWidthError,
        imageStrokeHeight: imageStrokeProperties.imageStrokeHeightError,
      },
      mixedFill: fillExpressions.size > 1,
      mixedFillOpacity: fillOpacityExpressions.size > 1,
      mixedStrokeColor: strokeColors.size > 1,
      mixedStrokeExpression: strokeExpressions.size > 1,
      mixedStrokeOpacity: strokeOpacityExpressions.size > 1,
      mixedStroke: strokeThicknesses.size > 1,
    };
  }

  function apply(record) {
    if (!record?.node) return;
    if (record.entity.construction) {
      imageStrokeSystem?.clear(record);
      record.node.style.setProperty('--original-stroke-width', '1px');
      ['stroke', 'stroke-width', 'stroke-opacity', 'fill', 'fill-opacity'].forEach((attribute) => record.node.removeAttribute(attribute));
      ['stroke', 'strokeWidth', 'strokeOpacity', 'fill', 'fillOpacity'].forEach((property) => { record.node.style[property] = ''; });
      record.node.style.removeProperty('--entity-fill');
      return;
    }
    const resolved = appearance(record.entity);
    record.node.style.setProperty('--original-stroke-width', `${resolved.strokeThickness}px`);
    const closed = isClosedGeometry(record.entity);
    const fillPaint = closed ? imageFillSystem.paintFor(record.entity, resolved) : resolved.fillColor;
    const subtractSystem = getSubtractSystem();
    const subtractActive = isSubtractableEntity(record.entity) && subtractSystem?.isCutterRecord(record.id);
    const materialEmpty = subtractSystem?.planFor(record.id)?.materialEmpty === true;
    const suppressFill = closed && (subtractActive || materialEmpty);
    const imageStrokeActive = imageStrokeSystem?.render(
      record,
      resolved,
      () => apply(record),
    ) === true;
    const strokePaint = imageStrokeActive ? 'transparent' : resolved.strokeColor;
    record.node.setAttribute('stroke', strokePaint);
    record.node.setAttribute('stroke-width', resolved.strokeThickness);
    record.node.setAttribute('stroke-opacity', resolved.strokeOpacity);
    record.node.style.stroke = strokePaint;
    record.node.style.strokeWidth = `${resolved.strokeThickness}px`;
    record.node.style.strokeOpacity = String(resolved.strokeOpacity);
    if (closed) {
      record.node.style.setProperty('--entity-fill', fillPaint);
      record.node.setAttribute('fill', suppressFill ? 'none' : fillPaint);
      record.node.setAttribute('fill-opacity', suppressFill ? 0 : resolved.fillOpacity);
      record.node.style.setProperty('fill', suppressFill ? 'none' : fillPaint, 'important');
      record.node.style.fillOpacity = String(suppressFill ? 0 : resolved.fillOpacity);
    }
  }

  function resolvedBoundaryAppearance(entity = {}, { polygon, boundaryId } = {}) {
    const resolved = appearance(entity);
    const fillPaint = imageFillSystem?.paintFor?.(
      entity,
      resolved,
      { polygon },
      boundaryId ? `resolved-boundary:${boundaryId}` : undefined,
    ) ?? resolved.fillColor;
    return {
      ...resolved,
      fillPaint,
      boundaryStroke: 'none',
      boundaryStrokeWidth: 0,
      boundaryStrokeOpacity: 0,
    };
  }

  function setSelectedAppearance(patch = {}) {
    const selectedGeometry = selectedGeometryRecords();
    const selectedTexts = selectedTextRecords();
    const selectedAppearanceRecords = [...selectedGeometry, ...selectedTexts];
    const selectedImages = records.filter((record) => (
      selectedIds.has(record.id)
      && record.recordType === 'image'
      && !record.entity.construction
    ));
    const strokeTargets = new Set(strokeTargetRecords().map((record) => record.id));
    if (!selectedAppearanceRecords.length && !selectedImages.length) return { success: false, error: 'No editable object selected.' };
    const fillExpression = patch.fillExpression ?? patch.fillColor;
    const resolvedFill = fillExpression !== undefined
      ? resolveGeometryFillAppearance(
        { fillExpression },
        (expression) => solver.evaluateParameterExpression(expression),
        (expression) => solver.evaluateDrawingLengthExpression(expression),
      )
      : null;
    if (resolvedFill?.fillType === 'image') {
      const eligibility = closedImageFillSelection(records, selectedIds, getClosedCycles());
      if (!eligibility.canEditImageFill) return { success: false, error: 'Image fills can only be applied to complete closed objects.' };
    }
    const requestedStrokeColor = patch.strokeColor === undefined ? null : String(patch.strokeColor).trim();
    const strokeColor = requestedStrokeColor !== null && HEX_COLOR.test(requestedStrokeColor)
      ? requestedStrokeColor.toLowerCase()
      : null;
    const strokeOpacityExpression = patch.strokeOpacityExpression;
    const strokeExpression = patch.strokeExpression ?? patch.strokeColor;
    const fillOpacityExpression = patch.fillOpacityExpression;
    const requestedStroke = Number(patch.strokeThickness);
    const strokeThickness = Number.isFinite(requestedStroke) ? Math.min(40, Math.max(0.1, requestedStroke)) : null;
    const errors = [];
    const updates = selectedAppearanceRecords.map((record) => {
      const current = appearance(record.entity);
      const next = {
        ...(record.entity.appearance || {}),
        fillColor: current.fillColor,
        fillOpacity: current.fillOpacity,
        strokeColor: current.strokeColor,
        strokeOpacity: current.strokeOpacity,
        strokeThickness: current.strokeThickness,
      };
      if (fillExpression !== undefined
          || patch.fillImageMode !== undefined
          || patch.fillImageRotationAngle !== undefined
          || patch.fillImageScaleExpression !== undefined
          || patch.fillImageWidthExpression !== undefined
          || patch.fillImageHeightExpression !== undefined
          || patch.fillImageLeftExpression !== undefined
          || patch.fillImageTopExpression !== undefined) {
        const resolved = updateFillAppearance(
          next,
          {
            ...(fillExpression !== undefined ? { fillExpression } : {}),
            ...(patch.fillImageMode !== undefined ? { fillImageMode: patch.fillImageMode } : {}),
            ...(patch.fillImageRotationAngle !== undefined ? { fillImageRotationAngle: patch.fillImageRotationAngle } : {}),
            ...(patch.fillImageScaleExpression !== undefined ? { fillImageScaleExpression: patch.fillImageScaleExpression } : {}),
            ...(patch.fillImageWidthExpression !== undefined ? { fillImageWidthExpression: patch.fillImageWidthExpression } : {}),
            ...(patch.fillImageHeightExpression !== undefined ? { fillImageHeightExpression: patch.fillImageHeightExpression } : {}),
            ...(patch.fillImageLeftExpression !== undefined ? { fillImageLeftExpression: patch.fillImageLeftExpression } : {}),
            ...(patch.fillImageTopExpression !== undefined ? { fillImageTopExpression: patch.fillImageTopExpression } : {}),
          },
          (expression) => solver.evaluateParameterExpression(expression),
          (expression) => solver.evaluateDrawingLengthExpression(expression),
        );
        Object.assign(next, resolved.appearance);
        if (resolved.error) errors.push(resolved.error);
      }
      if (fillOpacityExpression !== undefined) {
        next.fillOpacityExpression = String(fillOpacityExpression);
        try { next.fillOpacity = resolveOpacityExpression(fillOpacityExpression, (expression) => solver.evaluateParameterExpression(expression)); } catch (error) { errors.push(error.message); }
      }
      if (strokeTargets.has(record.id)) {
        if (strokeExpression !== undefined
          || patch.strokeImageWidthExpression !== undefined
          || patch.strokeImageHeightExpression !== undefined) {
          const resolved = updateStrokeAppearance(
            next,
            {
              ...(strokeExpression !== undefined ? { strokeExpression } : {}),
              ...(patch.strokeImageWidthExpression !== undefined
                ? { strokeImageWidthExpression: patch.strokeImageWidthExpression }
                : {}),
              ...(patch.strokeImageHeightExpression !== undefined
                ? { strokeImageHeightExpression: patch.strokeImageHeightExpression }
                : {}),
            },
            (expression) => solver.evaluateParameterExpression(expression),
            (expression) => solver.evaluateDrawingLengthExpression(expression),
          );
          Object.assign(next, resolved.appearance);
          if (resolved.error) errors.push(resolved.error);
        } else if (strokeColor !== null) next.strokeColor = strokeColor;
        if (strokeThickness !== null) next.strokeThickness = strokeThickness;
        if (strokeOpacityExpression !== undefined) {
          next.strokeOpacityExpression = String(strokeOpacityExpression);
          try { next.strokeOpacity = resolveOpacityExpression(strokeOpacityExpression, (expression) => solver.evaluateParameterExpression(expression)); } catch (error) { errors.push(error.message); }
        }
      }
      return { id: record.id, appearance: next, patch };
    });
    const geometryUpdates = updates.filter(({ id }) => (
      records.find((record) => record.id === id)?.recordType === 'geometry'
    ));
    const changed = typeof solver.updateEntity === 'function'
      ? geometryUpdates.map(({ id, appearance: next, patch: sourcePatch }) => {
        const record = records.find((candidate) => candidate.id === id);
        return solver.updateEntity(applyEntityAppearanceOverrides(record.entity, next, sourcePatch));
      })
      : solver.updateEntityAppearances(geometryUpdates);
    changed.forEach((entity) => {
      const record = records.find((candidate) => candidate.id === entity.id);
      if (!record) return;
      record.entity = clone(entity);
      apply(record);
    });
    const filletSystem = getFilletSystem();
    const textTools = getTextTools();
    updates.forEach(({ id, appearance: next, patch: sourcePatch }) => {
      const record = records.find((candidate) => candidate.id === id && candidate.recordType === 'fillet');
      if (!record) return;
      record.entity = clone(applyEntityAppearanceOverrides(record.entity, next, sourcePatch));
      filletSystem?.updateRecord(record);
    });
    updates.forEach(({ id, appearance: next, patch: sourcePatch }) => {
      const record = records.find((candidate) => candidate.id === id && candidate.recordType === 'text');
      if (!record) return;
      record.entity = clone(applyEntityAppearanceOverrides(record.entity, next, sourcePatch));
      solver.updateEntity(record.entity);
      textTools?.updateRecord(record);
      rememberTextDefaults(record.entity);
    });
    if (fillOpacityExpression !== undefined) selectedImages.forEach((record) => getImageTools()?.setAppearance(record, { fillOpacityExpression }));
    renderClosedRegions();
    getSubtractSystem()?.refreshPresentation();
    syncGeometryStacking();
    notifyObjectChange();
    return { success: errors.length === 0, error: errors[0] || null };
  }

  return {
    appearance,
    apply,
    resolvedBoundaryAppearance,
    selectionProperties,
    setSelectedAppearance,
  };
}
