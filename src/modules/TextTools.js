let textSerial = 0;

const clone = (value) => JSON.parse(JSON.stringify(value));
export const TEXT_PIXELS_PER_INCH = 96;
export const DEFAULT_TEXT_FONT_SIZE = 28;
export const TEXT_EDITOR_PADDING = 4;
export const TEXT_LINE_HEIGHT = 1.25;

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
  scaleWithZoom: true,
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

let lastTextDefaults = clone(initialTextDefaults);

function textId() {
  if (globalThis.crypto?.randomUUID) return `text-${globalThis.crypto.randomUUID()}`;
  textSerial += 1;
  return `text-${Date.now().toString(36)}-${textSerial}`;
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

export function normalizeTextEntity(input = {}) {
  const defaults = lastTextDefaults;
  const fontSize = finitePositive(input.fontSize, defaults.fontSize || DEFAULT_TEXT_FONT_SIZE);
  const textHeight = textHeightInMillimetres(
    input.textHeight === undefined && input.fontSize === undefined
      ? { textHeight: defaults.textHeight, fontSize }
      : { textHeight: input.textHeight, fontSize },
  );
  return {
    id: input.id || textId(),
    type: 'text',
    stackId: String(input.stackId || 'stack-default'),
    x: Number.isFinite(Number(input.x)) ? Number(input.x) : 0,
    y: Number.isFinite(Number(input.y)) ? Number(input.y) : 0,
    text: input.multiline === false ? singleLineText(input.text ?? 'Text') : String(input.text ?? 'Text'),
    fontName: String(input.fontName || defaults.fontName || 'Arial'),
    fontSize,
    textHeight,
    fontColor: /^#[0-9a-f]{6}$/i.test(input.fontColor || '') ? input.fontColor : defaults.fontColor,
    scaleWithZoom: input.scaleWithZoom === undefined ? defaults.scaleWithZoom !== false : Boolean(input.scaleWithZoom),
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
  return normalizeTextEntity(position);
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

export function rememberTextDefaults(entity) {
  const normalized = normalizeTextEntity(entity);
  lastTextDefaults = {
    fontName: normalized.fontName,
    fontSize: normalized.fontSize,
    textHeight: normalized.textHeight,
    fontColor: normalized.fontColor,
    scaleWithZoom: normalized.scaleWithZoom,
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
  getScale,
  getAppearance,
  getParameters,
  formatParameter,
  evaluateExpression = null,
  bindRecordEvents,
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

  const presentationEntity = (record) => ({
    ...record.entity,
    ...resolveTextProperties(record.entity),
  });

  function displayedText(record) {
    if (record === editingRecord) return record.entity.text;
    return resolveTextFields(record.entity.text, getParameters(), formatParameter, evaluateExpression);
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
    const scale = Math.max(0.0001, getScale());
    const scaleFactor = record === editingRecord || !entity.scaleWithZoom ? scale : 1;
    const effectiveFontSize = entity.fontSize / scaleFactor;
    const text = displayedText(record);
    const size = dimensions(record, text, effectiveFontSize);
    const appearance = getAppearance(record.entity);
    const borderWidth = appearance.strokeThickness / scaleFactor;
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

  function caretIndexFromPoint(record, clientX, clientY) {
    const entity = presentationEntity(record);
    const lines = entity.multiline ? String(record.editor.value || '').split('\n') : [singleLineText(record.editor.value || '')];
    const scale = Math.max(0.0001, getScale());
    const screenFontSize = record === editingRecord || !entity.scaleWithZoom ? entity.fontSize : entity.fontSize * scale;
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

  function beginEdit(record, { selectAll = false, caretPoint = null } = {}) {
    if (!record || record === editingRecord) return;
    if (editingRecord) finishEdit(editingRecord);
    requestHistoryCheckpoint('edit-text');
    editingRecord = record;
    editStartText = record.entity.text;
    record.editor.readOnly = false;
    record.editor.tabIndex = 0;
    record.editor.classList.add('editing');
    updateRecord(record);
    requestAnimationFrame(() => {
      if (editingRecord !== record) return;
      record.editor.focus({ preventScroll: true });
      if (caretPoint) {
        const caretIndex = caretIndexFromPoint(record, caretPoint.clientX, caretPoint.clientY);
        record.editor.setSelectionRange(caretIndex, caretIndex);
        return;
      }
      record.editor.setSelectionRange(selectAll ? 0 : record.editor.value.length, record.editor.value.length);
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

    bindRecordEvents(record);
    editor.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      beginEdit(record, { caretPoint: { clientX: event.clientX, clientY: event.clientY } });
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
    if (patch.scaleWithZoom !== undefined) applied.scaleWithZoom = Boolean(patch.scaleWithZoom);
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
      finishEdit();
    },
    updateRecord,
    updateProperties,
    isEditing(record) {
      return record === editingRecord;
    },
  };
}
