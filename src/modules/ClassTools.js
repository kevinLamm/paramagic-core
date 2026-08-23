import { bindFloatingPanelDrag } from './CanvasUIControls.js';
import { DEFAULT_CLASS_ID } from './ClassSystem.js';
import { createImageCatalog, isImageFillReference } from './ImageSystem.js';
import { catalogImageStrokeSizePatch } from './ImageStrokeSystem.js';
import { bindDeferredColorPicker } from './GeometryAppearanceSystem.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const icons = {
  add: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l11-11-4-4L4 16v4zM13.5 6.5l4 4"/></svg>',
  duplicate: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11"/><path d="M5 16H4V4h12v1"/></svg>',
  remove: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V4h6v3m-8 0l1 13h8l1-13M10 10v7m4-7v7"/></svg>',
  image: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16"/><circle cx="9" cy="10" r="2"/><path d="M4 18l5-5 3 3 3-4 5 6"/></svg>',
};

function actionButton(action, label, icon, disabled = false) {
  return `<button type="button" class="class-list-action" data-class-${action} aria-label="${label}" title="${label}"${disabled ? ' disabled' : ''}>${icon}</button>`;
}

function colorValue(expression, fallback) {
  const value = String(expression ?? '').trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

export function classListPanelMarkup(state, selectedClassId = state.activeClassId) {
  const selected = state.classes.find(({ id }) => id === selectedClassId) || state.classes[0];
  return `<div class="class-list-panel-header">
      <h2>Classes</h2>
      <button type="button" class="panel-close-button class-list-close" aria-label="Close Classes" title="Close">&times;</button>
    </div>
    <div class="class-list-actions" aria-label="Class actions">
      ${actionButton('add', 'Add Class', icons.add)}
      ${actionButton('edit', 'Edit Class', icons.edit)}
      ${actionButton('duplicate', 'Duplicate Class', icons.duplicate, selected.duplicable === false)}
      ${actionButton('remove', 'Delete Class', icons.remove, selected.removable === false)}
    </div>
    <div class="class-list" role="listbox" aria-label="Classes">
      ${state.classes.map((item) => `<button type="button" role="option" class="class-list-item${item.id === selected.id ? ' selected' : ''}${item.id === state.activeClassId ? ' active' : ''}" data-class-item="${escapeHtml(item.id)}" aria-selected="${item.id === selected.id}" aria-label="${escapeHtml(item.name)}${item.id === state.activeClassId ? ', active' : ''}">${escapeHtml(item.name)}</button>`).join('')}
    </div>`;
}

export function classPropertiesModalMarkup(state, classId = state.activeClassId) {
  const selected = state.classes.find(({ id }) => id === classId) || state.classes[0];
  const properties = selected.properties || {};
  const fillIsImage = isImageFillReference(properties.fillExpression);
  const strokeIsImage = isImageFillReference(properties.strokeExpression);
  return `<div class="class-properties-panel-content" data-class-properties-id="${escapeHtml(selected.id)}">
    <div class="properties-panel-header">
      <h2 id="classPropertiesTitle">Class Properties</h2>
      <button type="button" class="panel-close-button class-properties-close" aria-label="Close Class Properties" title="Close">&times;</button>
    </div>
    <p class="properties-selection-status">${escapeHtml(selected.name)}</p>
    <label class="property-row"><span>Name</span><input name="name" value="${escapeHtml(selected.name)}" autocomplete="off" spellcheck="false"${selected.id === DEFAULT_CLASS_ID ? ' disabled title="Class X cannot be renamed"' : ''} /></label>
    <div class="property-row"><span>Fill Color</span><div class="property-inline property-color-controls"><input data-class-fill-color aria-label="Class fill color picker" type="color" value="${colorValue(properties.fillExpression, '#ffffff')}" /><button type="button" data-class-image-fill class="property-image-fill-button" aria-label="Choose class image fill" title="Choose image fill">${icons.image}</button><input name="fillExpression" aria-label="Class fill hex, expression, or image path" type="text" value="${escapeHtml(properties.fillExpression)}" spellcheck="false" /></div></div>
    <label class="property-row image-fill-property-row"${fillIsImage ? '' : ' hidden'}><span>Image Fill Mode</span><select name="fillImageMode"><option value="tile"${properties.fillImageMode === 'tile' || !properties.fillImageMode ? ' selected' : ''}>Tiled</option><option value="scale"${properties.fillImageMode === 'scale' ? ' selected' : ''}>Scale</option><option value="stretch"${properties.fillImageMode === 'stretch' ? ' selected' : ''}>Stretch</option></select></label>
    <label class="property-row image-fill-property-row"${fillIsImage ? '' : ' hidden'}><span>Image Fill Rotation Angle</span><input name="fillImageRotationAngle" type="number" step="1" value="${escapeHtml(properties.fillImageRotationAngle ?? 0)}" /></label>
    <label class="property-row image-fill-property-row image-fill-shift-property-row"${fillIsImage && (properties.fillImageMode || 'tile') === 'tile' ? '' : ' hidden'}><span>Tile Shift Left</span><input name="fillImageLeftExpression" type="text" value="${escapeHtml(properties.fillImageLeftExpression ?? '0')}" spellcheck="false" /></label>
    <label class="property-row image-fill-property-row image-fill-shift-property-row"${fillIsImage && (properties.fillImageMode || 'tile') === 'tile' ? '' : ' hidden'}><span>Tile Shift Top</span><input name="fillImageTopExpression" type="text" value="${escapeHtml(properties.fillImageTopExpression ?? '0')}" spellcheck="false" /></label>
    <div class="property-row"><span>Fill Opacity</span><div class="property-inline opacity-controls"><input data-class-fill-opacity-slider aria-label="Class fill opacity slider" type="range" min="0" max="100" step="1" value="${escapeHtml(properties.fillOpacityExpression)}" /><input name="fillOpacityExpression" aria-label="Class fill opacity expression" type="text" value="${escapeHtml(properties.fillOpacityExpression)}" spellcheck="false" /></div></div>
    <div class="property-row"><span>Stroke Color</span><div class="property-inline property-color-controls"><input data-class-stroke-color aria-label="Class stroke color picker" type="color" value="${colorValue(properties.strokeExpression, '#202020')}" /><button type="button" data-class-image-stroke class="property-image-fill-button" aria-label="Choose class image stroke" title="Choose image stroke">${icons.image}</button><input name="strokeExpression" aria-label="Class stroke hex, expression, or image path" type="text" value="${escapeHtml(properties.strokeExpression)}" spellcheck="false" /></div></div>
    <label class="property-row image-stroke-property-row"${strokeIsImage ? '' : ' hidden'}><span>Image Stroke Width</span><input name="strokeImageWidthExpression" type="text" value="${escapeHtml(properties.strokeImageWidthExpression ?? '')}" spellcheck="false" /></label>
    <label class="property-row image-stroke-property-row"${strokeIsImage ? '' : ' hidden'}><span>Image Stroke Height</span><input name="strokeImageHeightExpression" type="text" value="${escapeHtml(properties.strokeImageHeightExpression ?? '')}" spellcheck="false" /></label>
    <label class="property-row"><span>Stroke Thickness</span><input name="strokeThickness" type="number" min="0.1" max="40" step="0.1" value="${escapeHtml(properties.strokeThickness)}" /></label>
    <div class="property-row"><span>Stroke Opacity</span><div class="property-inline opacity-controls"><input data-class-stroke-opacity-slider aria-label="Class stroke opacity slider" type="range" min="0" max="100" step="1" value="${escapeHtml(properties.strokeOpacityExpression)}" /><input name="strokeOpacityExpression" aria-label="Class stroke opacity expression" type="text" value="${escapeHtml(properties.strokeOpacityExpression)}" spellcheck="false" /></div></div>
    <label class="property-row text-checkbox-row"><span>Visible</span><input data-class-visible type="checkbox"${String(properties.visibleExpression).trim().toUpperCase() === 'FALSE' ? '' : ' checked'} /></label>
    <label class="property-row"><span>Visible Expression</span><input name="visibleExpression" type="text" value="${escapeHtml(properties.visibleExpression)}" spellcheck="false" /></label>
    <label class="property-row"><span>Font Name</span><select name="fontName">${['Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Times New Roman', 'Georgia', 'Garamond', 'Courier New', 'Comic Sans MS', 'Impact', 'Lucida Console'].map((name) => `<option value="${name}"${properties.fontName === name ? ' selected' : ''}>${name}</option>`).join('')}</select></label>
    <label class="property-row"><span>Font Size</span><input name="fontSize" type="number" min="1" step="1" value="${escapeHtml(properties.fontSize)}" /></label>
    <label class="property-row"><span>Font Color</span><input name="fontColor" type="color" value="${colorValue(properties.fontColor, '#202020')}" /></label>
    <label class="property-row text-checkbox-row"><span>Scale with Zoom</span><input data-class-scale-with-zoom type="checkbox"${properties.scaleWithZoom === false ? '' : ' checked'} /></label>
    <label class="property-row text-checkbox-row"><span>Multiline</span><input data-class-multiline type="checkbox"${properties.multiline === false ? '' : ' checked'} /></label>
    <div class="property-row"><span>Alignment</span><div class="text-alignment-options" role="group" aria-label="Class text alignment">
      <button type="button" data-class-text-align="left" aria-label="Left alignment" title="Left alignment" aria-pressed="${properties.textAlign === 'left'}" class="${properties.textAlign === 'left' ? 'active' : ''}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 10h10M4 14h16M4 18h12"/></svg></button>
      <button type="button" data-class-text-align="center" aria-label="Center alignment" title="Center alignment" aria-pressed="${properties.textAlign === 'center'}" class="${properties.textAlign === 'center' ? 'active' : ''}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 10h10M4 14h16M6 18h12"/></svg></button>
      <button type="button" data-class-text-align="right" aria-label="Right alignment" title="Right alignment" aria-pressed="${properties.textAlign === 'right'}" class="${properties.textAlign === 'right' ? 'active' : ''}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M10 10h10M4 14h16M8 18h12"/></svg></button>
    </div></div>
    <div class="property-row"><span>Text Alignment</span><div class="text-alignment-options" role="group" aria-label="Class text vertical alignment">
      <button type="button" data-class-text-vertical-align="top" aria-label="Top text alignment" title="Top" aria-pressed="${properties.textVerticalAlign === 'top'}" class="${properties.textVerticalAlign === 'top' ? 'active' : ''}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16M7 9h10M7 13h10M7 17h10"/></svg></button>
      <button type="button" data-class-text-vertical-align="middle" aria-label="Middle text alignment" title="Middle" aria-pressed="${properties.textVerticalAlign === 'middle'}" class="${properties.textVerticalAlign === 'middle' ? 'active' : ''}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h10M7 9h10M4 12h16M7 15h10M7 19h10"/></svg></button>
      <button type="button" data-class-text-vertical-align="bottom" aria-label="Bottom text alignment" title="Bottom" aria-pressed="${properties.textVerticalAlign === 'bottom'}" class="${properties.textVerticalAlign === 'bottom' ? 'active' : ''}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10M7 11h10M7 15h10M4 19h16"/></svg></button>
    </div></div>
    <p class="class-properties-error" data-class-error role="alert" aria-live="polite"></p>
  </div>`;
}

export function createClassTools({
  button,
  select,
  selectAllButton,
  propertySelect,
  canvas,
  host = document.querySelector('.app-shell') || document.body,
  onError = () => {},
} = {}) {
  let state = canvas.getClassState();
  let selectedClassId = state.activeClassId;
  let selectionProperties = {};
  let propertiesBackdrop = null;

  const panel = document.createElement('section');
  panel.className = 'floating-panel class-list-panel';
  panel.id = 'classListPanel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Class List');
  host.appendChild(panel);

  const panelDragController = bindFloatingPanelDrag(panel, {
    ignoreSelector: 'button, input, select, textarea, label, .class-list',
  });

  function classDefinition(classId) {
    return state.classes.find(({ id }) => id === classId) || state.classes[0];
  }

  function setError(message = '') {
    const target = propertiesBackdrop?.querySelector('[data-class-error]');
    if (target) target.textContent = message;
    if (message) onError(message);
  }

  function populateSelect(target, { selectedId = null, mixed = false, disabled = false } = {}) {
    if (!target) return;
    const options = [];
    if (mixed) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Mixed';
      options.push(option);
    }
    state.classes.forEach((item) => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      options.push(option);
    });
    target.replaceChildren(...options);
    target.value = mixed ? '' : selectedId || DEFAULT_CLASS_ID;
    target.disabled = disabled;
  }

  function syncToolbar() {
    populateSelect(select, { selectedId: state.activeClassId });
    const active = classDefinition(state.activeClassId);
    if (select) {
      const context = document.createElement('canvas').getContext('2d');
      context.font = getComputedStyle(select).font;
      const widestName = Math.max(...state.classes.map(({ name }) => context.measureText(name).width));
      select.style.width = `${Math.max(88, Math.ceil(widestName) + 64)}px`;
    }
    select.title = `Active Class: ${active.name}`;
    select.setAttribute('aria-label', select.title);
    window.dispatchEvent(new Event('paramagic:toolbar-content-resize'));
  }

  function syncPropertySelect() {
    const enabled = selectionProperties.canEditClass === true;
    populateSelect(propertySelect, {
      selectedId: selectionProperties.selectedClassId,
      mixed: selectionProperties.mixedClass === true,
      disabled: !enabled,
    });
    if (!propertySelect) return;
    propertySelect.title = enabled
      ? selectionProperties.mixedClass ? 'Selected objects use mixed classes' : 'Class for selected geometry'
      : 'Select geometry to change its class';
  }

  function closeProperties() {
    propertiesBackdrop?.remove();
    propertiesBackdrop = null;
  }

  function renderList() {
    if (!state.classes.some(({ id }) => id === selectedClassId)) selectedClassId = state.activeClassId;
    panel.innerHTML = classListPanelMarkup(state, selectedClassId);
    panel.querySelector('.class-list-close').addEventListener('click', () => setVisible(false));
    panel.querySelectorAll('[data-class-item]').forEach((item) => item.addEventListener('click', () => {
      selectedClassId = item.dataset.classItem;
      renderList();
      panel.querySelector('[data-class-item].selected')?.focus();
    }));
    panel.querySelector('[data-class-edit]').addEventListener('click', () => openProperties(selectedClassId));
    panel.querySelector('[data-class-add]').addEventListener('click', () => {
      const result = canvas.addClass();
      if (!result.success) return onError(result.error);
      state = canvas.getClassState();
      selectedClassId = result.class.id;
      renderList();
      panel.querySelector('[data-class-item].selected')?.focus();
    });
    panel.querySelector('[data-class-duplicate]').addEventListener('click', () => {
      const result = canvas.duplicateClass(selectedClassId);
      if (!result.success) return onError(result.error);
      state = canvas.getClassState();
      selectedClassId = result.class.id;
      renderList();
      panel.querySelector('[data-class-item].selected')?.focus();
    });
    panel.querySelector('[data-class-remove]').addEventListener('click', () => {
      const result = canvas.removeClass(selectedClassId);
      if (!result.success) return onError(result.error);
      state = canvas.getClassState();
      selectedClassId = canvas.getActiveClassId();
      closeProperties();
      renderList();
    });
  }

  function commitInput(input, classId) {
    const result = input.name === 'name'
      ? canvas.renameClass(classId, input.value)
      : canvas.updateClassProperties(classId, {
        [input.name]: input.name === 'strokeThickness' || input.type === 'number'
          ? Number(input.value)
          : input.value,
      });
    if (!result.success) {
      input.setAttribute('aria-invalid', 'true');
      setError(result.error);
      return false;
    }
    input.removeAttribute('aria-invalid');
    setError('');
    state = canvas.getClassState();
    const status = propertiesBackdrop?.querySelector('.properties-selection-status');
    if (status) status.textContent = classDefinition(classId).name;
    renderList();
    return true;
  }

  function renderPropertiesModal() {
    if (!propertiesBackdrop) return;
    if (!state.classes.some(({ id }) => id === selectedClassId)) return closeProperties();
    const modal = propertiesBackdrop.querySelector('.class-properties-modal');
    modal.innerHTML = classPropertiesModalMarkup(state, selectedClassId);
    modal.querySelector('.class-properties-close').addEventListener('click', closeProperties);
    const content = modal.querySelector('[data-class-properties-id]');
    const classId = content.dataset.classPropertiesId;
    content.querySelectorAll('input[name], select[name]').forEach((input) => {
      input.addEventListener('change', () => commitInput(input, classId));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitInput(input, classId);
        }
      });
    });

    const fillExpression = content.querySelector('[name="fillExpression"]');
    const fillColor = content.querySelector('[data-class-fill-color]');
    bindDeferredColorPicker({
      picker: fillColor,
      expressionInput: fillExpression,
      onCommit: (value) => canvas.updateClassProperties(classId, { fillExpression: value }),
    });
    const fillOpacityExpression = content.querySelector('[name="fillOpacityExpression"]');
    content.querySelector('[data-class-fill-opacity-slider]').addEventListener('input', (event) => {
      fillOpacityExpression.value = event.currentTarget.value;
      canvas.updateClassProperties(classId, { fillOpacityExpression: event.currentTarget.value });
    });
    const strokeExpression = content.querySelector('[name="strokeExpression"]');
    const strokeColor = content.querySelector('[data-class-stroke-color]');
    bindDeferredColorPicker({
      picker: strokeColor,
      expressionInput: strokeExpression,
      onCommit: (value) => canvas.updateClassProperties(classId, { strokeExpression: value }),
    });
    const strokeOpacityExpression = content.querySelector('[name="strokeOpacityExpression"]');
    content.querySelector('[data-class-stroke-opacity-slider]').addEventListener('input', (event) => {
      strokeOpacityExpression.value = event.currentTarget.value;
      canvas.updateClassProperties(classId, { strokeOpacityExpression: event.currentTarget.value });
    });
    const visibleExpression = content.querySelector('[name="visibleExpression"]');
    content.querySelector('[data-class-visible]').addEventListener('change', (event) => {
      visibleExpression.value = event.currentTarget.checked ? 'TRUE' : 'FALSE';
      canvas.updateClassProperties(classId, { visibleExpression: visibleExpression.value });
    });
    content.querySelector('[data-class-scale-with-zoom]').addEventListener('change', (event) => {
      canvas.updateClassProperties(classId, { scaleWithZoom: event.currentTarget.checked });
    });
    content.querySelector('[data-class-multiline]').addEventListener('change', (event) => {
      canvas.updateClassProperties(classId, { multiline: event.currentTarget.checked });
    });
    content.querySelectorAll('[data-class-text-align]').forEach((button) => button.addEventListener('click', () => {
      canvas.updateClassProperties(classId, { textAlign: button.dataset.classTextAlign });
      state = canvas.getClassState();
      renderPropertiesModal();
    }));
    content.querySelectorAll('[data-class-text-vertical-align]').forEach((button) => button.addEventListener('click', () => {
      canvas.updateClassProperties(classId, { textVerticalAlign: button.dataset.classTextVerticalAlign });
      state = canvas.getClassState();
      renderPropertiesModal();
    }));

    createImageCatalog({
      button: content.querySelector('[data-class-image-fill]'),
      getDrawingUnit: () => canvas.getDrawingUnit?.() || 'in',
      formatLength: (value) => canvas.formatDrawingLength?.(value) ?? String(value),
      evaluateLength: (expression) => canvas.evaluateLengthExpression?.(expression) ?? Number(expression),
      onSelect: (reference, sizePatch = {}) => {
        canvas.updateClassProperties(classId, { fillExpression: reference, ...sizePatch });
        state = canvas.getClassState();
        renderPropertiesModal();
      },
      onError: (error) => onError(`Image catalog unavailable: ${error.message}`),
    });
    createImageCatalog({
      button: content.querySelector('[data-class-image-stroke]'),
      title: 'Image Stroke',
      sizeUsage: 'image strokes',
      getDrawingUnit: () => canvas.getDrawingUnit?.() || 'in',
      formatLength: (value) => canvas.formatDrawingLength?.(value) ?? String(value),
      evaluateLength: (expression) => canvas.evaluateLengthExpression?.(expression) ?? Number(expression),
      onSelect: (reference, sizePatch = {}) => {
        canvas.updateClassProperties(classId, {
          strokeExpression: reference,
          ...catalogImageStrokeSizePatch(sizePatch),
        });
        state = canvas.getClassState();
        renderPropertiesModal();
      },
      onError: (error) => onError(`Image catalog unavailable: ${error.message}`),
    });
  }

  function openProperties(classId) {
    selectedClassId = classId;
    renderList();
    closeProperties();
    propertiesBackdrop = document.createElement('div');
    propertiesBackdrop.className = 'modal-backdrop class-properties-backdrop';
    propertiesBackdrop.innerHTML = '<section class="modal class-properties-modal" role="dialog" aria-modal="true" aria-labelledby="classPropertiesTitle"></section>';
    document.body.appendChild(propertiesBackdrop);
    propertiesBackdrop.addEventListener('pointerdown', (event) => {
      if (event.target === propertiesBackdrop) closeProperties();
    });
    renderPropertiesModal();
    propertiesBackdrop.querySelector('input:not(:disabled)')?.focus();
  }

  function setVisible(visible) {
    panel.hidden = !visible;
    button?.classList.toggle('active', visible);
    button?.setAttribute('aria-pressed', String(visible));
    if (!visible) return;
    state = canvas.getClassState();
    selectedClassId = state.activeClassId;
    renderList();
    panelDragController.clamp();
    panel.querySelector('[data-class-item].selected')?.focus();
  }

  const onKeyDown = (event) => {
    if (event.key !== 'Escape') return;
    if (propertiesBackdrop) closeProperties();
    else if (!panel.hidden) setVisible(false);
  };

  button?.setAttribute('aria-controls', panel.id);
  button?.setAttribute('aria-pressed', 'false');
  button?.addEventListener('click', () => setVisible(panel.hidden));
  select?.addEventListener('change', () => {
    const result = canvas.setActiveClass(select.value);
    if (!result.success) onError(result.error);
  });
  selectAllButton?.addEventListener('click', () => canvas.selectClass(canvas.getActiveClassId()));
  propertySelect?.addEventListener('change', () => {
    if (!propertySelect.value) return;
    const result = canvas.setRecordClassIds(canvas.getSelectedRecordIds(), propertySelect.value);
    if (!result.success) onError(result.error);
  });
  document.addEventListener('keydown', onKeyDown);

  const stopClassSubscription = canvas.onClassChange((nextState, detail = {}) => {
    state = nextState;
    syncToolbar();
    syncPropertySelect();
    if (!panel.hidden) renderList();
    if (propertiesBackdrop && detail.reason === 'restore') renderPropertiesModal();
  });
  const stopSelectionSubscription = canvas.onSelectionChange((properties) => {
    selectionProperties = properties;
    syncPropertySelect();
  });
  syncToolbar();
  syncPropertySelect();

  return {
    open: () => setVisible(true),
    close: () => setVisible(false),
    openProperties,
    syncToolbar,
    destroy() {
      stopClassSubscription?.();
      stopSelectionSubscription?.();
      document.removeEventListener('keydown', onKeyDown);
      panelDragController.destroy();
      closeProperties();
      panel.remove();
    },
  };
}
