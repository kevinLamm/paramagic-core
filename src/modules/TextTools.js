import { createUuid } from './IdentitySystem.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
export const TEXT_PIXELS_PER_INCH = 96;
export const DEFAULT_TEXT_FONT_SIZE = 28;
export const TEXT_EDITOR_PADDING = 4;
export const TEXT_LINE_HEIGHT = 1.25;
export const TEXT_FONT_NAMES = Object.freeze([
  'Arial',
  'Helvetica',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
  'Times New Roman',
  'Georgia',
  'Garamond',
  'Courier New',
  'Comic Sans MS',
  'Impact',
  'Lucida Console',
]);

export function textPropertiesMarkup() {
  return `<label class="property-row text-property-row" data-property-availability="canEditText" for="fontNameProperty" hidden><span>Font Name</span><select id="fontNameProperty" disabled>
    ${TEXT_FONT_NAMES.map((name) => `<option value="${name}">${name}</option>`).join('')}
  </select></label>
  <div class="property-row text-property-row text-font-property-row" data-property-availability="canEditText" hidden><span>Font</span><div class="property-inline text-font-controls"><label><span>Size</span><input id="fontSizeProperty" aria-label="Font Size" type="number" min="1" step="1" value="28" disabled /></label><label><span>Color</span><input id="fontColorProperty" aria-label="Font Color" type="color" value="#202020" disabled /></label></div></div>
  <label class="property-row text-property-row text-layout-property-row text-checkbox-row" data-property-availability="canEditText" for="multilineTextProperty" hidden><span>Multiline</span><input id="multilineTextProperty" type="checkbox" checked disabled /></label>
  <div class="property-row text-property-row text-layout-property-row" data-property-availability="canEditText" id="textAlignmentPropertyRow" hidden><span>Alignment</span><div class="text-alignment-options" role="group" aria-label="Text alignment">
    <button type="button" data-text-align="left" aria-label="Left alignment" title="Left alignment" aria-pressed="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 10h10M4 14h16M4 18h12"/></svg></button>
    <button type="button" data-text-align="center" aria-label="Center alignment" title="Center alignment" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 10h10M4 14h16M6 18h12"/></svg></button>
    <button type="button" data-text-align="right" aria-label="Right alignment" title="Right alignment" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M10 10h10M4 14h16M8 18h12"/></svg></button>
  </div></div>
  <div class="property-row text-property-row text-layout-property-row" data-property-availability="canEditText" id="textVerticalAlignmentPropertyRow" hidden><span>Text Alignment</span><div class="text-alignment-options" role="group" aria-label="Text vertical alignment">
    <button type="button" data-text-vertical-align="top" aria-label="Top text alignment" title="Top" aria-pressed="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16M7 9h10M7 13h10M7 17h10"/></svg></button>
    <button type="button" data-text-vertical-align="middle" aria-label="Middle text alignment" title="Middle" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h10M7 9h10M4 12h16M7 15h10M7 19h10"/></svg></button>
    <button type="button" data-text-vertical-align="bottom" aria-label="Bottom text alignment" title="Bottom" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10M7 11h10M7 15h10M4 19h16"/></svg></button>
  </div></div>`;
}

export function textHeightInMillimetres(entity = {}, fallbackFontSize = DEFAULT_TEXT_FONT_SIZE) {
  const explicitHeight = Number(entity.textHeight);
  if (Number.isFinite(explicitHeight) && explicitHeight > 0) return explicitHeight;
  const fontSize = Number(entity.fontSize);
  const legacyFontSize = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : fallbackFontSize;
  return legacyFontSize * 25.4 / TEXT_PIXELS_PER_INCH;
}

const initialTextDefaults = {
  fontName: 'Arial',
  fontSize: DEFAULT_TEXT_FONT_SIZE,
  textHeight: textHeightInMillimetres({ fontSize: DEFAULT_TEXT_FONT_SIZE }),
  fontColor: '#202020',
  multiline: true,
  textAlign: 'left',
  textVerticalAlign: 'top',
  appearance: {
    fillExpression: '#ffffff',
    fillColor: '#ffffff',
    fillOpacityExpression: '0',
    fillOpacity: 0,
    strokeThickness: 1.5,
    strokeOpacityExpression: '0',
    strokeOpacity: 0,
  },
};

const DEFAULT_TEXT_CLASS_OVERRIDES = Object.freeze(['fillOpacity', 'strokeOpacity']);

let lastTextDefaults = clone(initialTextDefaults);

function textId() {
  return createUuid();
}

function finitePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeTextAlign(value) {
  return ['left', 'center', 'right'].includes(value) ? value : 'left';
}

export function normalizeTextVerticalAlign(value) {
  return ['top', 'middle', 'bottom'].includes(value) ? value : 'top';
}

function singleLineText(value) {
  return String(value ?? '').replace(/\s*\n+\s*/g, ' ');
}

export function isTextEntity(entity) {
  return entity?.type === 'text';
}

export function isTextVisibilityRecord(record) {
  return record?.recordType === 'text' && isTextEntity(record.entity);
}

export function normalizeTextEntity(input = {}) {
  const defaults = lastTextDefaults;
  const normalizedInput = clone(input);
  delete normalizedInput.scaleWithZoom;
  const fontSize = finitePositive(input.fontSize, defaults.fontSize || DEFAULT_TEXT_FONT_SIZE);
  const textHeight = textHeightInMillimetres(
    input.textHeight === undefined && input.fontSize === undefined
      ? { textHeight: defaults.textHeight, fontSize }
      : { textHeight: input.textHeight, fontSize },
  );
  return {
    ...normalizedInput,
    id: input.id || textId(),
    type: 'text',
    stackId: input.stackId ? String(input.stackId) : null,
    x: Number.isFinite(Number(input.x)) ? Number(input.x) : 0,
    y: Number.isFinite(Number(input.y)) ? Number(input.y) : 0,
    text: input.multiline === false ? singleLineText(input.text ?? 'Text') : String(input.text ?? 'Text'),
    fontName: String(input.fontName || defaults.fontName || 'Arial'),
    fontSize,
    textHeight,
    fontColor: /^#[0-9a-f]{6}$/i.test(input.fontColor || '') ? input.fontColor : defaults.fontColor,
    multiline: input.multiline === undefined ? defaults.multiline !== false : Boolean(input.multiline),
    textAlign: normalizeTextAlign(input.textAlign ?? defaults.textAlign),
    textVerticalAlign: normalizeTextVerticalAlign(input.textVerticalAlign ?? defaults.textVerticalAlign),
    appearance: {
      ...clone(defaults.appearance),
      ...(input.appearance || {}),
    },
  };
}

export function createTextEntity(position = {}) {
  const entity = normalizeTextEntity(position);
  const requestedOverrides = Array.isArray(entity.classPropertyOverrides)
    ? entity.classPropertyOverrides
    : [];
  entity.classPropertyOverrides = [...new Set([
    ...requestedOverrides,
    ...DEFAULT_TEXT_CLASS_OVERRIDES,
  ])];
  return entity;
}

export function bindTextRecordInteractions(record, {
  canInteract = () => true,
  isEditing = () => false,
  beginEdit = () => {},
  onClearPropertyFeature = () => {},
  onSelect = () => {},
  onToggleSelection = () => {},
  onStartDrag = () => false,
  consumeSuppressedClick = () => false,
} = {}) {
  const target = record?.foreignObject;
  if (!target?.addEventListener) return () => {};

  const editAtPointer = (event) => {
    event.preventDefault?.();
    event.stopPropagation?.();
    consumeSuppressedClick();
    onSelect(record);
    beginEdit(record, {
      caretPoint: { clientX: event.clientX, clientY: event.clientY },
      interactionEvent: event,
    });
  };

  const handlePointerDown = (event) => {
    if (!canInteract(event, record)) return;
    event.stopPropagation?.();
    if (isEditing(record)) return;
    if (!(event.ctrlKey || event.metaKey)) onClearPropertyFeature();
    if (event.button !== 0 || event.ctrlKey || event.metaKey) return;

    if (event.detail > 1) return;
    onStartDrag(event, record);
  };

  const handleClick = (event) => {
    event.stopPropagation?.();
    if (event.detail >= 2) {
      consumeSuppressedClick();
      return;
    }
    if (consumeSuppressedClick() || !canInteract(event, record)) return;
    if (event.ctrlKey || event.metaKey) onToggleSelection(record);
    else onSelect(record);
  };

  const handleDoubleClick = (event) => {
    if (!canInteract(event, record)) return;
    editAtPointer(event);
  };
  target.addEventListener('pointerdown', handlePointerDown);
  target.addEventListener('click', handleClick);
  target.addEventListener('dblclick', handleDoubleClick);
  return () => {
    target.removeEventListener?.('pointerdown', handlePointerDown);
    target.removeEventListener?.('click', handleClick);
    target.removeEventListener?.('dblclick', handleDoubleClick);
  };
}

export function deferTextEditUntilPlacementClick({
  pointerEvent,
  eventTarget,
  onReady,
  schedule = (callback) => setTimeout(callback, 0),
} = {}) {
  if (pointerEvent?.type !== 'pointerdown' || !eventTarget?.addEventListener) {
    onReady?.();
    return () => {};
  }

  const pointerId = Number.isFinite(Number(pointerEvent.pointerId)) ? Number(pointerEvent.pointerId) : null;
  const placementX = Number(pointerEvent.clientX);
  const placementY = Number(pointerEvent.clientY);
  let cancelled = false;
  let listenersActive = true;

  const removeListeners = () => {
    if (!listenersActive) return;
    listenersActive = false;
    eventTarget.removeEventListener?.('click', handleClick, true);
    eventTarget.removeEventListener?.('pointercancel', handleCancel, true);
  };
  const ready = () => {
    removeListeners();
    schedule(() => {
      if (!cancelled) onReady?.();
    });
  };
  const handleClick = (event) => {
    if (event?.button !== undefined && event.button !== 0) return;
    if (
      Number.isFinite(placementX)
      && Number.isFinite(placementY)
      && Number.isFinite(Number(event?.clientX))
      && Number.isFinite(Number(event?.clientY))
      && Math.hypot(Number(event.clientX) - placementX, Number(event.clientY) - placementY) > 8
    ) return;
    ready();
  };
  const handleCancel = (event) => {
    if (pointerId !== null && Number(event?.pointerId) !== pointerId) return;
    ready();
  };

  eventTarget.addEventListener('click', handleClick, true);
  eventTarget.addEventListener('pointercancel', handleCancel, true);
  return () => {
    cancelled = true;
    removeListeners();
  };
}

export function resolveTextFields(
  source,
  parameters = [],
  formatValue = (entry) => String(entry.value ?? ''),
  evaluateExpression = null,
) {
  const byName = new Map(parameters.filter((entry) => entry?.name).map((entry) => [entry.name, entry]));
  return String(source ?? '').replace(/\[([^\]]+)\]/g, (field, rawExpression) => {
    const expression = rawExpression.trim();
    const entry = byName.get(expression);
    if (entry) return entry.error ? field : formatValue(entry);
    if (typeof evaluateExpression === 'function') {
      try {
        const value = evaluateExpression(expression);
        if (value !== undefined && value !== null && typeof value !== 'object') {
          return formatValue({ value, unit: null });
        }
      } catch {
        // Keep unresolved fields editable, matching the existing Text behavior.
      }
    }
    return field;
  });
}

export function drawingTextSvgLayout(entity = {}) {
  const fontSize = finitePositive(entity.fontSize, DEFAULT_TEXT_FONT_SIZE);
  const requestedBorderWidth = Number(entity.appearance?.strokeThickness);
  const borderWidth = Number.isFinite(requestedBorderWidth)
    ? Math.max(0, requestedBorderWidth)
    : initialTextDefaults.appearance.strokeThickness;
  const inset = TEXT_EDITOR_PADDING + borderWidth;
  const textAlign = normalizeTextAlign(entity.textAlign);
  const anchor = textAlign === 'center' ? 'middle' : textAlign === 'right' ? 'end' : 'start';
  const x = Number.isFinite(Number(entity.x)) ? Number(entity.x) : 0;
  const y = Number.isFinite(Number(entity.y)) ? Number(entity.y) : 0;
  const lines = entity.multiline === false
    ? [singleLineText(entity.text ?? '')]
    : String(entity.text ?? '').split(/\r\n?|\n/);
  const lineHeight = fontSize * TEXT_LINE_HEIGHT;
  const frameHeight = Math.max(
    fontSize * TEXT_LINE_HEIGHT + TEXT_EDITOR_PADDING * 2,
    lines.length * lineHeight + TEXT_EDITOR_PADDING * 2,
  );
  const verticalAlign = normalizeTextVerticalAlign(entity.textVerticalAlign);
  const frameY = y + (verticalAlign === 'middle' ? -frameHeight / 2 : verticalAlign === 'bottom' ? -frameHeight : 0);
  const contentX = textAlign === 'left' ? x + inset : textAlign === 'right' ? x - inset : x;
  const contentY = frameY + inset;
  return {
    anchor,
    frameY,
    frameHeight,
    contentX,
    contentY,
    fontSize,
    lineHeight,
    lines,
  };
}

function finiteNumber(value, fallback = 0) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : fallback;
}

export function drawingTextPresentationModel(foreignObject, editor, getStyle = null) {
  const computed = typeof getStyle === 'function' ? getStyle(editor) : null;
  const styleValue = (property, fallback = '') => (
    computed?.getPropertyValue?.(property)
    || editor?.style?.getPropertyValue?.(property)
    || editor?.style?.[property.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())]
    || fallback
  );
  const x = finiteNumber(foreignObject?.getAttribute?.('x'));
  const y = finiteNumber(foreignObject?.getAttribute?.('y'));
  const width = Math.max(0, finiteNumber(foreignObject?.getAttribute?.('width')));
  const height = Math.max(0, finiteNumber(foreignObject?.getAttribute?.('height')));
  const fontSize = Math.max(0.001, finiteNumber(styleValue('font-size'), DEFAULT_TEXT_FONT_SIZE));
  const borderWidth = Math.max(0, finiteNumber(styleValue('border-width')));
  const inset = TEXT_EDITOR_PADDING + borderWidth;
  const textAlign = normalizeTextAlign(styleValue('text-align', 'left'));
  const contentX = textAlign === 'center'
    ? x + width / 2
    : textAlign === 'right' ? x + width - inset : x + inset;
  const lineHeight = Math.max(fontSize, finiteNumber(styleValue('line-height'), fontSize * TEXT_LINE_HEIGHT));
  return {
    x,
    y,
    width,
    height,
    contentX,
    contentY: y + inset,
    lineHeight,
    lines: String(editor?.value ?? editor?.textContent ?? '').split(/\r\n?|\n/),
    fill: styleValue('color', '#202020'),
    fontFamily: styleValue('font-family', 'Arial'),
    fontSize,
    textAnchor: textAlign === 'center' ? 'middle' : textAlign === 'right' ? 'end' : 'start',
    background: styleValue('background-color', 'transparent'),
    borderColor: styleValue('border-color', 'transparent'),
    borderWidth,
  };
}

export function replaceDrawingTextForeignObjects(source, clone) {
  if (!source?.querySelectorAll || !clone?.querySelectorAll) return clone;
  const sourceBoxes = [...source.querySelectorAll('.text-foreign-object')];
  const cloneBoxes = [...clone.querySelectorAll('.text-foreign-object')];
  cloneBoxes.forEach((cloneBox, index) => {
    const sourceBox = sourceBoxes[index] || cloneBox;
    const editor = sourceBox.querySelector?.('.drawing-text-editor')
      || cloneBox.querySelector?.('.drawing-text-editor');
    const documentRef = cloneBox.ownerDocument || clone.ownerDocument;
    if (!editor || !documentRef?.createElementNS) {
      cloneBox.remove?.();
      return;
    }
    const model = drawingTextPresentationModel(
      sourceBox,
      editor,
      (node) => node.ownerDocument?.defaultView?.getComputedStyle?.(node),
    );
    const presentation = documentRef.createElementNS('http://www.w3.org/2000/svg', 'g');
    presentation.setAttribute('class', 'drawing-text-presentation');
    const frame = documentRef.createElementNS('http://www.w3.org/2000/svg', 'rect');
    frame.setAttribute('x', model.x);
    frame.setAttribute('y', model.y);
    frame.setAttribute('width', model.width);
    frame.setAttribute('height', model.height);
    frame.setAttribute('fill', model.background);
    frame.setAttribute('stroke', model.borderColor);
    frame.setAttribute('stroke-width', model.borderWidth);
    presentation.appendChild(frame);
    const text = documentRef.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('fill', model.fill);
    text.setAttribute('font-family', model.fontFamily);
    text.setAttribute('font-size', model.fontSize);
    text.setAttribute('text-anchor', model.textAnchor);
    text.setAttribute('dominant-baseline', 'text-before-edge');
    text.setAttribute('xml:space', 'preserve');
    model.lines.forEach((line, lineIndex) => {
      const span = documentRef.createElementNS('http://www.w3.org/2000/svg', 'tspan');
      span.setAttribute('x', model.contentX);
      span.setAttribute('y', model.contentY + lineIndex * model.lineHeight);
      span.textContent = line;
      text.appendChild(span);
    });
    presentation.appendChild(text);
    cloneBox.replaceWith(presentation);
  });
  return clone;
}

export function rememberTextDefaults(entity) {
  const normalized = normalizeTextEntity(entity);
  lastTextDefaults = {
    fontName: normalized.fontName,
    fontSize: normalized.fontSize,
    textHeight: normalized.textHeight,
    fontColor: normalized.fontColor,
    multiline: normalized.multiline,
    textAlign: normalized.textAlign,
    textVerticalAlign: normalized.textVerticalAlign,
    appearance: clone(normalized.appearance),
  };
}

function rgba(hex, opacity) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!match) return `rgba(255,255,255,${opacity})`;
  const value = Number.parseInt(match[1], 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${opacity})`;
}

export function createTextSystem({
  objectLayer,
  interactionSurface = null,
  getScale,
  getAppearance,
  getParameters,
  formatParameter,
  evaluateExpression = null,
  canInteract,
  onClearPropertyFeature,
  onSelect,
  onToggleSelection,
  onStartDrag,
  consumeSuppressedClick,
  updateRecordHandles,
  syncEntity = () => {},
  resolveTextProperties = (entity) => entity,
  applyTextPropertyOverrides = (entity, patch) => ({ ...entity, ...patch }),
  requestHistoryCheckpoint,
  onChange,
}) {
  const svgNs = 'http://www.w3.org/2000/svg';
  const htmlNs = 'http://www.w3.org/1999/xhtml';
  const measureCanvas = document.createElement('canvas');
  const measureContext = measureCanvas.getContext('2d');
  let editingRecord = null;
  let editStartText = '';
  let cancelPendingPlacementEdit = null;

  const presentationEntity = (record) => ({
    ...record.entity,
    ...resolveTextProperties(record.entity),
  });

  function displayedText(record) {
    if (record === editingRecord) return record.entity.text;
    return resolveTextFields(
      record.entity.text,
      getParameters(record.entity),
      formatParameter,
      (expression) => evaluateExpression?.(expression, record.entity),
    );
  }

  function dimensions(record, text, effectiveFontSize) {
    const entity = presentationEntity(record);
    const lines = entity.multiline ? String(text || ' ').split('\n') : [singleLineText(text || ' ')];
    measureContext.font = `${effectiveFontSize}px ${entity.fontName}`;
    const width = Math.max(24, ...lines.map((line) => measureContext.measureText(line || ' ').width)) + 10;
    return {
      width,
      height: Math.max(
        effectiveFontSize * TEXT_LINE_HEIGHT + TEXT_EDITOR_PADDING * 2,
        lines.length * effectiveFontSize * TEXT_LINE_HEIGHT + TEXT_EDITOR_PADDING * 2,
      ),
    };
  }

  function updateRecord(record) {
    const entity = presentationEntity(record);
    const effectiveFontSize = entity.fontSize;
    const text = displayedText(record);
    const size = dimensions(record, text, effectiveFontSize);
    const appearance = getAppearance(record.entity);
    const borderWidth = appearance.strokeThickness;
    const verticalAlign = normalizeTextVerticalAlign(entity.textVerticalAlign);
    const frameY = entity.y + (verticalAlign === 'middle' ? -size.height / 2 : verticalAlign === 'bottom' ? -size.height : 0);

    const alignedX = entity.x - (entity.textAlign === 'center' ? size.width / 2 : entity.textAlign === 'right' ? size.width : 0);
    record.selectionFrame.setAttribute('x', alignedX);
    record.selectionFrame.setAttribute('y', frameY);
    record.selectionFrame.setAttribute('width', size.width);
    record.selectionFrame.setAttribute('height', size.height);
    record.foreignObject.setAttribute('x', alignedX);
    record.foreignObject.setAttribute('y', frameY);
    record.foreignObject.setAttribute('width', size.width);
    record.foreignObject.setAttribute('height', size.height);
    record.editor.value = text;
    record.editor.style.fontFamily = entity.fontName;
    record.editor.style.fontSize = `${effectiveFontSize}px`;
    record.editor.style.lineHeight = String(TEXT_LINE_HEIGHT);
    record.editor.style.textAlign = entity.textAlign;
    record.editor.style.color = entity.fontColor;
    record.editor.style.background = rgba(appearance.fillColor, appearance.fillOpacity);
    record.editor.style.borderColor = rgba(appearance.strokeColor, appearance.strokeOpacity);
    record.editor.style.borderWidth = `${borderWidth}px`;
  }

  function finishEdit(record = editingRecord, { cancel = false } = {}) {
    if (!record || record !== editingRecord) return;
    if (cancel) record.entity.text = editStartText;
    else record.entity.text = record.editor.value;
    record.editor.readOnly = true;
    record.editor.tabIndex = -1;
    record.editor.classList.remove('editing');
    editingRecord = null;
    syncEntity(record.entity);
    updateRecord(record);
    onChange({ history: 'commit' });
  }

  interactionSurface?.addEventListener?.('pointerdown', (event) => {
    if (!event.target.closest?.('.drawing-text-editor.editing')) finishEdit();
  });

  function caretIndexFromPoint(record, clientX, clientY) {
    const entity = presentationEntity(record);
    const lines = entity.multiline ? String(record.editor.value || '').split('\n') : [singleLineText(record.editor.value || '')];
    const scale = Math.max(0.0001, getScale());
    const screenFontSize = entity.fontSize * scale;
    const rect = record.editor.getBoundingClientRect();
    const padding = TEXT_EDITOR_PADDING * scale;
    const lineHeight = screenFontSize * TEXT_LINE_HEIGHT;
    const lineIndex = Math.max(0, Math.min(lines.length - 1, Math.floor((clientY - rect.top - padding) / lineHeight)));
    const line = lines[lineIndex] || '';
    const targetX = Math.max(0, clientX - rect.left - padding);
    measureContext.font = `${screenFontSize}px ${entity.fontName}`;
    let column = line.length;
    for (let index = 0; index < line.length; index += 1) {
      const before = measureContext.measureText(line.slice(0, index)).width;
      const after = measureContext.measureText(line.slice(0, index + 1)).width;
      if (targetX < (before + after) / 2) {
        column = index;
        break;
      }
    }
    return lines.slice(0, lineIndex).reduce((total, value) => total + value.length + 1, 0) + column;
  }

  function activateEdit(record, { selectAll = false, caretPoint = null } = {}) {
    if (!record || record === editingRecord) return;
    if (editingRecord) finishEdit(editingRecord);
    requestHistoryCheckpoint('edit-text');
    editingRecord = record;
    editStartText = record.entity.text;
    record.editor.readOnly = false;
    record.editor.tabIndex = 0;
    record.editor.classList.add('editing');
    updateRecord(record);
    record.editor.focus({ preventScroll: true });
    if (caretPoint) {
      const caretIndex = caretIndexFromPoint(record, caretPoint.clientX, caretPoint.clientY);
      record.editor.setSelectionRange(caretIndex, caretIndex);
      return;
    }
    record.editor.setSelectionRange(selectAll ? 0 : record.editor.value.length, record.editor.value.length);
  }

  function beginEdit(record, {
    selectAll = false,
    caretPoint = null,
    placementPointerEvent = null,
    interactionEvent = null,
  } = {}) {
    cancelPendingPlacementEdit?.();
    cancelPendingPlacementEdit = null;

    const ownerDocument = record?.editor?.ownerDocument || document;
    const view = ownerDocument.defaultView;
    const schedule = typeof view?.requestAnimationFrame === 'function'
      ? (callback) => view.requestAnimationFrame(callback)
      : (callback) => setTimeout(callback, 0);
    if (placementPointerEvent?.type !== 'pointerdown') {
      if (!interactionEvent?.type) {
        activateEdit(record, { selectAll, caretPoint });
        return;
      }
      let cancelled = false;
      cancelPendingPlacementEdit = () => { cancelled = true; };
      schedule(() => {
        if (cancelled) return;
        cancelPendingPlacementEdit = null;
        activateEdit(record, { selectAll, caretPoint });
      });
      return;
    }

    cancelPendingPlacementEdit = deferTextEditUntilPlacementClick({
      pointerEvent: placementPointerEvent,
      eventTarget: ownerDocument,
      schedule,
      onReady: () => {
        cancelPendingPlacementEdit = null;
        activateEdit(record, { selectAll, caretPoint });
      },
    });
  }

  function createRecord(inputEntity) {
    const entity = normalizeTextEntity(inputEntity);
    const group = document.createElementNS(svgNs, 'g');
    group.setAttribute('class', 'canvas-record text-record');
    group.dataset.recordId = entity.id;
    group.dataset.entityType = 'text';

    const selectionFrame = document.createElementNS(svgNs, 'rect');
    selectionFrame.setAttribute('class', 'text-selection-frame');
    group.appendChild(selectionFrame);
    const foreignObject = document.createElementNS(svgNs, 'foreignObject');
    foreignObject.setAttribute('class', 'selectable-entity text-foreign-object');
    const editor = document.createElementNS(htmlNs, 'textarea');
    editor.setAttribute('xmlns', htmlNs);
    editor.className = 'drawing-text-editor';
    editor.readOnly = true;
    editor.tabIndex = -1;
    editor.setAttribute('aria-label', 'Drawing text');
    foreignObject.appendChild(editor);
    group.appendChild(foreignObject);
    const handleGroup = document.createElementNS(svgNs, 'g');
    handleGroup.setAttribute('class', 'handle-group');
    group.appendChild(handleGroup);
    objectLayer.appendChild(group);

    const record = {
      id: entity.id,
      recordType: 'text',
      entity,
      group,
      node: foreignObject,
      hitNode: foreignObject,
      selectionFrame,
      foreignObject,
      editor,
      handleGroup,
      handles: [],
    };

    bindTextRecordInteractions(record, {
      canInteract,
      isEditing: (candidate) => candidate === editingRecord,
      beginEdit,
      onClearPropertyFeature,
      onSelect,
      onToggleSelection,
      onStartDrag,
      consumeSuppressedClick,
    });
    editor.addEventListener('input', () => {
      if (record !== editingRecord) return;
      record.entity.text = presentationEntity(record).multiline ? editor.value : singleLineText(editor.value);
      if (editor.value !== record.entity.text) editor.value = record.entity.text;
      syncEntity(record.entity);
      updateRecord(record);
    });
    editor.addEventListener('blur', () => finishEdit(record));
    editor.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        finishEdit(record, { cancel: true });
      }
      if (!presentationEntity(record).multiline && event.key === 'Enter') {
        event.preventDefault();
        finishEdit(record);
      }
    });
    updateRecord(record);
    updateRecordHandles(record);
    return record;
  }

  function updateProperties(record, patch = {}) {
    const current = presentationEntity(record);
    const next = { ...record.entity };
    const applied = {};
    if (patch.fontName !== undefined) applied.fontName = String(patch.fontName || 'Arial');
    if (patch.fontSize !== undefined) {
      applied.fontSize = finitePositive(patch.fontSize, current.fontSize);
      if (patch.textHeight === undefined) {
        applied.textHeight = textHeightInMillimetres({ fontSize: applied.fontSize });
      }
    }
    if (patch.textHeight !== undefined) {
      applied.textHeight = finitePositive(patch.textHeight, textHeightInMillimetres(current));
    }
    if (patch.fontColor !== undefined && /^#[0-9a-f]{6}$/i.test(patch.fontColor)) applied.fontColor = patch.fontColor;
    if (patch.multiline !== undefined) {
      applied.multiline = Boolean(patch.multiline);
      if (!applied.multiline) next.text = singleLineText(next.text);
    }
    if (patch.textAlign !== undefined) applied.textAlign = normalizeTextAlign(patch.textAlign);
    if (patch.textVerticalAlign !== undefined) applied.textVerticalAlign = normalizeTextVerticalAlign(patch.textVerticalAlign);
    record.entity = applyTextPropertyOverrides(next, applied);
    syncEntity(record.entity);
    updateRecord(record);
    updateRecordHandles(record);
    rememberTextDefaults(presentationEntity(record));
  }

  return {
    createRecord,
    beginEdit,
    finishEdit,
    finishEditing() {
      cancelPendingPlacementEdit?.();
      cancelPendingPlacementEdit = null;
      finishEdit();
    },
    updateRecord,
    updateProperties,
    isEditing(record) {
      return record === editingRecord;
    },
  };
}
