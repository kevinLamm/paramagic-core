import {
  createParameterTableExport,
  normalizeImportedParameterRows,
  readParameterTableFile,
  replaceParametersFromRows,
} from './ParameterTableIO.js';

const PARAMETER_TABLE_GROUPS = [
  { key: 'parameter', label: 'Parameters' },
  { key: 'dimension', label: 'Dimensions' },
  { key: 'control', label: 'Controls' },
];

export function parameterTableGroupKey(entry) {
  if (entry?.kind === 'dimension') return 'dimension';
  if (entry?.kind === 'control') return 'control';
  return 'parameter';
}

export function parameterTableSections(entries, { separated = false } = {}) {
  const orderedEntries = Array.from(entries || []);
  if (!separated) return [{ key: 'all', label: null, entries: orderedEntries }];
  return PARAMETER_TABLE_GROUPS.map((group) => ({
    ...group,
    entries: orderedEntries.filter((entry) => parameterTableGroupKey(entry) === group.key),
  }));
}

function sectionHeadingMarkup(section) {
  return `<tr class="parameter-section-row" data-parameter-section="${section.key}"><th colspan="2" scope="rowgroup">${section.label}</th></tr>`;
}

export function parameterTableBodyMarkup(entries, {
  separated = false,
  rowMarkup,
  draftMarkup,
} = {}) {
  const sections = parameterTableSections(entries, { separated });
  if (!separated) return `${sections[0].entries.map(rowMarkup).join('')}${draftMarkup()}`;
  return sections.map((section) => {
    const draft = section.key === 'parameter' ? draftMarkup() : '';
    return `${sectionHeadingMarkup(section)}${section.entries.map(rowMarkup).join('')}${draft}`;
  }).join('');
}

const actionIcon = (paths) => `<span class="parameters-action-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">${paths}</svg></span>`;

export function parametersPanelHeaderActionsMarkup() {
  return `<div class="parameters-heading-actions" role="toolbar" aria-label="Parameter table actions">
    <button type="button" class="parameters-action-button parameters-table-view-toggle" aria-label="Group by type" aria-pressed="false" title="Group by type">${actionIcon('<path d="M5 4v16M5 7h3M5 12h3M5 17h3"/><path d="M10 5h10M10 9h7M10 12h10M10 16h7M10 19h10"/>')}</button>
    <button type="button" class="parameters-action-button parameters-import-button" aria-label="Import parameter table" title="Import parameter table">${actionIcon('<path d="M12 3v11M8 10l4 4 4-4"/><path d="M5 17v3h14v-3M5 6h4M15 6h4"/>')}</button>
    <div class="parameters-export-control">
      <button type="button" class="parameters-action-button parameters-export-button" aria-label="Export parameter table" title="Export parameter table" aria-haspopup="menu" aria-expanded="false">${actionIcon('<path d="M12 15V4M8 8l4-4 4 4"/><path d="M5 18v3h14v-3M5 15h4M15 15h4"/>')}</button>
      <div class="parameters-export-menu" role="menu" hidden>
        <button type="button" role="menuitem" data-parameter-export-format="json">JSON</button>
        <button type="button" role="menuitem" data-parameter-export-format="csv">CSV</button>
        <button type="button" role="menuitem" data-parameter-export-format="xls">XLS</button>
        <button type="button" role="menuitem" data-parameter-export-format="xlsx">XLSX</button>
      </div>
    </div>
    <button type="button" class="parameters-action-button parameters-help-button" aria-label="Expression help" title="Expression help">${actionIcon('<circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.4 2.4 0 1 1 3.6 2.1c-.9.5-1.4 1-1.4 2.2M12 17h.01"/>')}</button>
    <input class="parameters-import-input" type="file" accept=".json,.csv,.xls,.xlsx,application/json,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden />
  </div>`;
}

export function createParameterTableViewToggle({ button, onChange } = {}) {
  if (!button) throw new Error('Parameter table view toggle button is required.');
  let separated = false;

  const updateButton = () => {
    button.setAttribute('aria-pressed', String(separated));
    button.title = separated ? 'Show the full user-sorted list' : 'Group by type';
  };

  button.addEventListener('click', () => {
    separated = !separated;
    updateButton();
    onChange?.(separated);
  });
  updateButton();

  return {
    isSeparated: () => separated,
    canReorder: (movingEntry, targetEntry) => !separated
      || parameterTableGroupKey(movingEntry) === parameterTableGroupKey(targetEntry),
  };
}

export function createParameterExportMenuController({ button, menu, root } = {}) {
  if (!button) throw new Error('Parameter export button is required.');
  if (!menu) throw new Error('Parameter export menu is required.');

  const isOpen = () => button.getAttribute('aria-expanded') === 'true';
  const setOpen = (open) => {
    const nextOpen = Boolean(open);
    menu.hidden = !nextOpen;
    button.setAttribute('aria-expanded', String(nextOpen));
  };

  button.addEventListener('pointerdown', (event) => event.stopPropagation());
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    setOpen(!isOpen());
  });
  root?.addEventListener('pointerdown', (event) => {
    const path = event.composedPath?.() || [];
    const insideExportControl = path.includes(button)
      || path.includes(menu)
      || Boolean(event.target?.closest?.('.parameters-export-control'));
    if (!insideExportControl) setOpen(false);
  });
  setOpen(false);

  return { isOpen, setOpen };
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

export function controlLabelForParameter(entry, controlItems = []) {
  if (entry?.kind !== 'control') return '';
  const control = Array.from(controlItems || []).find((item) => (
    (item?.parameterId && item.parameterId === entry.id)
    || (item?.parameterName && item.parameterName === entry.name)
  ));
  return String(control?.label ?? '').trim();
}

export function parameterNameEditorMarkup(entry, { controlItems = [] } = {}) {
  const controlLabel = controlLabelForParameter(entry, controlItems);
  return `<div class="parameter-name-editor">
    <input class="parameter-name" aria-label="Parameter name" value="${escapeHtml(entry?.name)}" />
    ${controlLabel ? `<span class="parameter-control-label-ghost" aria-label="Control label: ${escapeHtml(controlLabel)}">${escapeHtml(controlLabel)}</span>` : ''}
  </div>`;
}

export function chooseParameterImportOptions({ fileName = '', sheetNames = [] } = {}) {
  const names = sheetNames.length ? sheetNames : ['Parameters'];
  return new Promise((resolve) => {
    document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop parameter-import-options-backdrop">
      <div class="modal parameter-import-options-modal" role="dialog" aria-modal="true" aria-labelledby="parameterImportOptionsTitle">
        <h2 id="parameterImportOptionsTitle">Import Parameter Table</h2>
        <p>${escapeHtml(fileName)}</p>
        ${names.length > 1 ? `<label class="parameter-import-sheet-label">Sheet<select class="parameter-import-sheet">${names.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')}</select></label>` : ''}
        <fieldset class="parameter-import-scope">
          <legend>Insertion option</legend>
          <label><input type="radio" name="parameter-import-scope" value="all" /> <span>Insert and Replace ALL Existing Parameters</span></label>
          <label><input type="radio" name="parameter-import-scope" value="user" checked /> <span>Insert and Replace User Parameters</span></label>
        </fieldset>
        <div class="parameter-import-option-actions">
          <button type="button" class="parameter-import-cancel">Cancel</button>
          <button type="button" class="parameter-import-confirm">Insert</button>
        </div>
      </div>
    </div>`);
    const backdrop = document.querySelector('.parameter-import-options-backdrop');
    const finish = (value) => {
      backdrop.remove();
      resolve(value);
    };
    backdrop.querySelector('.parameter-import-cancel').addEventListener('click', () => finish(null));
    backdrop.querySelector('.parameter-import-confirm').addEventListener('click', () => finish({
      sheetName: backdrop.querySelector('.parameter-import-sheet')?.value || names[0],
      scope: backdrop.querySelector('input[name="parameter-import-scope"]:checked')?.value || 'user',
    }));
    backdrop.addEventListener('pointerdown', (event) => { if (event.target === backdrop) finish(null); });
    backdrop.querySelector('.parameter-import-confirm').focus();
  });
}

function safeParameterTableName(name, extension) {
  const base = String(name || 'Parameters').replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*]+/g, '-').trim() || 'Parameters';
  return `${base}-Parameters.${extension}`;
}

function downloadParameterTable(file, drawingName) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(file.blob);
  link.href = url;
  link.download = safeParameterTableName(drawingName, file.extension);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function importSummaryText(summary, skipped) {
  const ignored = Object.values(skipped).reduce((total, count) => total + count, 0)
    + summary.skippedProtected + summary.skippedComputed + summary.skippedInvalid;
  return `Inserted ${summary.inserted} row${summary.inserted === 1 ? '' : 's'} and replaced ${summary.replaced} existing parameter${summary.replaced === 1 ? '' : 's'}${ignored ? `; skipped ${ignored} row${ignored === 1 ? '' : 's'}` : ''}.`;
}

export function createParametersPanelController({
  root,
  solver,
  canvas,
  closeButton,
  drawingName = '',
  expressionForEntry,
  onViewChange,
  onHelp,
  onRender,
} = {}) {
  const actions = root?.querySelector('.parameters-heading-actions');
  if (!actions) throw new Error('Parameters Panel action toolbar is required.');
  if (closeButton) {
    closeButton.classList.add('parameters-action-button');
    closeButton.innerHTML = actionIcon('<path d="M6 6l12 12M18 6 6 18"/>');
    actions.append(closeButton);
  }
  const status = root.querySelector('.parameters-import-status');
  const setStatus = (message, error = false) => {
    if (!status) return;
    status.hidden = !message;
    status.textContent = message;
    status.classList.toggle('error', error);
  };
  const tableView = createParameterTableViewToggle({
    button: actions.querySelector('.parameters-table-view-toggle'),
    onChange: onViewChange,
  });
  actions.querySelector('.parameters-help-button').addEventListener('click', () => onHelp?.());

  const exportButton = actions.querySelector('.parameters-export-button');
  const exportMenu = actions.querySelector('.parameters-export-menu');
  const exportMenuController = createParameterExportMenuController({
    button: exportButton,
    menu: exportMenu,
    root,
  });
  exportMenu.querySelectorAll('[data-parameter-export-format]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        downloadParameterTable(await createParameterTableExport(solver.parameters(), button.dataset.parameterExportFormat, {
          expressionForEntry,
        }), drawingName);
        setStatus(`Exported all Parameters, Dimensions, and Controls as ${button.dataset.parameterExportFormat.toUpperCase()}.`);
      } catch (error) {
        setStatus(error.message || 'The parameter table could not be exported.', true);
      }
      exportMenuController.setOpen(false);
    });
  });

  const importInput = actions.querySelector('.parameters-import-input');
  actions.querySelector('.parameters-import-button').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const [file] = importInput.files || [];
    importInput.value = '';
    if (!file) return;
    try {
      const workbook = await readParameterTableFile(file);
      const options = await chooseParameterImportOptions({ fileName: file.name, sheetNames: workbook.sheetNames });
      if (!options) return;
      const normalized = normalizeImportedParameterRows(workbook.rowsForSheet(options.sheetName));
      const summary = replaceParametersFromRows({ solver, rows: normalized.rows, scope: options.scope });
      canvas?.notifyObjectChange?.();
      onRender?.();
      setStatus(importSummaryText(summary, normalized.skipped));
    } catch (error) {
      setStatus(error.message || 'The parameter table could not be imported.', true);
    }
  });

  return { ...tableView, setStatus };
}
