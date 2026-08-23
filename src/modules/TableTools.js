import { normalizeTextVerticalAlign, resolveTextFields } from './TextTools.js';
import { PARAMAGIC_CLIPBOARD_FORMAT, PARAMAGIC_CLIPBOARD_VERSION } from './DrawingClipboard.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

const DEFAULT_CELL = Object.freeze({
  text: '',
  fillColor: '#ffffff',
  fillOpacity: 1,
  strokeColor: '#202020',
  strokeOpacity: 1,
  strokeThickness: 1,
  fontName: 'Arial',
  fontSize: 14,
  fontColor: '#202020',
  textAlign: 'left',
  textVerticalAlign: 'top',
  multiline: false,
  rowSpan: 1,
  colSpan: 1,
});

const DEFAULT_APPEARANCE = Object.freeze({
  fillColor: '#ffffff',
  fillOpacity: 1,
  strokeColor: '#202020',
  strokeOpacity: 1,
  strokeThickness: 1,
  zIndex: null,
});

// Tables are rendered with eight visual rect handles in the canvas, but the
// solver's rect adapter is a four-point polygon. Keep table feature indices
// aligned with those four solver points.
const TABLE_CORNER_SOLVER_INDICES = [0, 1, 2, 3];

let tableSerial = 0;

const TABLE_TOOL_ICONS = {
  'Insert Row Below': '<rect x="4" y="5" width="16" height="10"/><path d="M4 10h16M12 17v5M9 20h6"/>',
  'Insert Column After': '<rect x="4" y="5" width="10" height="14"/><path d="M9 5v14M17 12h5M20 9v6"/>',
  Merge: '<path d="M5 5h5v5H5zM14 5h5v5h-5zM5 14h5v5H5zM14 14h5v5h-5z"/><path d="M10 12h4M12 10v4"/>',
  Unmerge: '<path d="M5 5h5v5H5zM14 5h5v5h-5zM5 14h5v5H5zM14 14h5v5h-5z"/><path d="M10 12h4M12 10v4M12 12l4 4"/>',
};

function tableId() {
  if (globalThis.crypto?.randomUUID) return `table-${globalThis.crypto.randomUUID()}`;
  tableSerial += 1;
  return `table-${Date.now().toString(36)}-${tableSerial}`;
}

function finite(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function positive(value, fallback, minimum = 1) {
  return Math.max(minimum, Math.abs(finite(value, fallback)));
}

function clampOpacity(value, fallback = 1) {
  return Math.min(1, Math.max(0, finite(value, fallback)));
}

function normalizeCell(input = {}, fallback = DEFAULT_CELL) {
  const source = input || {};
  return {
    ...fallback,
    ...source,
    text: String(source.text ?? fallback.text ?? ''),
    fillColor: String(source.fillColor || fallback.fillColor),
    fillOpacity: clampOpacity(source.fillOpacity, fallback.fillOpacity),
    strokeColor: String(source.strokeColor || fallback.strokeColor),
    strokeOpacity: clampOpacity(source.strokeOpacity, fallback.strokeOpacity),
    strokeThickness: positive(source.strokeThickness, fallback.strokeThickness, 0.1),
    fontName: String(source.fontName || fallback.fontName),
    fontSize: positive(source.fontSize, fallback.fontSize, 1),
    fontColor: String(source.fontColor || fallback.fontColor),
    textAlign: ['left', 'center', 'right'].includes(source.textAlign) ? source.textAlign : fallback.textAlign,
    textVerticalAlign: normalizeTextVerticalAlign(source.textVerticalAlign ?? fallback.textVerticalAlign),
    multiline: Boolean(source.multiline),
    rowSpan: Math.max(1, Math.floor(finite(source.rowSpan, 1))),
    colSpan: Math.max(1, Math.floor(finite(source.colSpan, 1))),
  };
}

export function normalizeTableEntity(input = {}) {
  const columns = Array.isArray(input.columns) && input.columns.length
    ? input.columns.map((column) => ({ width: positive(column?.width, 120, 24) }))
    : [{ width: 120 }, { width: 120 }, { width: 120 }];
  const rows = Array.isArray(input.rows) && input.rows.length
    ? input.rows.map((row) => ({ height: positive(row?.height, 32, 20) }))
    : [{ height: 32 }, { height: 32 }, { height: 32 }];
  const sourceCells = Array.isArray(input.cells) ? input.cells : [];
  const cells = rows.map((_, rowIndex) => columns.map((__, columnIndex) => normalizeCell(
    sourceCells[rowIndex]?.[columnIndex],
    { ...DEFAULT_CELL, ...(input.defaultCell || {}) },
  )));
  return {
    id: input.id || tableId(),
    type: 'table',
    stackId: String(input.stackId || 'stack-default'),
    x: finite(input.x, 0),
    y: finite(input.y, 0),
    columns,
    rows,
    cells,
    defaultCell: normalizeCell(input.defaultCell || {}, DEFAULT_CELL),
    appearance: {
      ...DEFAULT_APPEARANCE,
      ...(input.appearance || {}),
      fillColor: String(input.appearance?.fillColor || DEFAULT_APPEARANCE.fillColor),
      fillOpacity: clampOpacity(input.appearance?.fillOpacity, DEFAULT_APPEARANCE.fillOpacity),
      strokeColor: String(input.appearance?.strokeColor || DEFAULT_APPEARANCE.strokeColor),
      strokeOpacity: clampOpacity(input.appearance?.strokeOpacity, DEFAULT_APPEARANCE.strokeOpacity),
      strokeThickness: positive(input.appearance?.strokeThickness, DEFAULT_APPEARANCE.strokeThickness, 0.1),
      zIndex: input.appearance?.zIndex === null || input.appearance?.zIndex === undefined
        ? null
        : (Number.isFinite(Number(input.appearance.zIndex)) ? Number(input.appearance.zIndex) : null),
    },
    scaleWithZoom: true,
  };
}

export function tableDimensions(entity) {
  const table = normalizeTableEntity(entity);
  return {
    width: table.columns.reduce((total, column) => total + column.width, 0),
    height: table.rows.reduce((total, row) => total + row.height, 0),
  };
}

export function tableCornerPoints(entity) {
  const table = normalizeTableEntity(entity);
  const { width, height } = tableDimensions(table);
  return [[table.x, table.y], [table.x + width, table.y], [table.x + width, table.y + height], [table.x, table.y + height]];
}

export function tableConstraintEntity(entity) {
  const table = normalizeTableEntity(entity);
  const { width, height } = tableDimensions(table);
  return {
    id: table.id,
    type: 'table',
    x: table.x,
    y: table.y,
    width,
    height,
    appearance: { ...(table.appearance || {}) },
  };
}

export function tableSolverCornerIndex(cornerIndex) {
  return TABLE_CORNER_SOLVER_INDICES[Number(cornerIndex)] ?? Number(cornerIndex);
}

export function tableCornerIndexFromSolverIndex(index) {
  return TABLE_CORNER_SOLVER_INDICES.indexOf(Number(index));
}

export function isTableCellMerged(entity, row, column) {
  const cell = entity?.cells?.[row]?.[column];
  return Boolean(cell && ((cell.rowSpan || 1) > 1 || (cell.colSpan || 1) > 1 || cell.mergedInto));
}

export function applyTableConstraintEntity(entity, constraintEntity) {
  const table = normalizeTableEntity(entity);
  const current = tableDimensions(table);
  const width = Math.max(48, Math.abs(Number(constraintEntity?.width) || current.width));
  const height = Math.max(40, Math.abs(Number(constraintEntity?.height) || current.height));
  const scaleX = current.width ? width / current.width : 1;
  const scaleY = current.height ? height / current.height : 1;
  table.x = finite(constraintEntity?.x, table.x);
  table.y = finite(constraintEntity?.y, table.y);
  table.columns = table.columns.map((column) => ({ width: Math.max(24, column.width * scaleX) }));
  table.rows = table.rows.map((row) => ({ height: Math.max(20, row.height * scaleY) }));
  return table;
}

export function tableCellRects(entity) {
  const table = normalizeTableEntity(entity);
  const columns = [];
  const rows = [];
  let x = table.x;
  table.columns.forEach((column) => {
    columns.push({ x, width: column.width });
    x += column.width;
  });
  let y = table.y;
  table.rows.forEach((row) => {
    rows.push({ y, height: row.height });
    y += row.height;
  });
  const rects = [];
  table.cells.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
    if (cell.mergedInto) return;
    const rowSpan = Math.min(cell.rowSpan || 1, table.rows.length - rowIndex);
    const colSpan = Math.min(cell.colSpan || 1, table.columns.length - columnIndex);
    rects.push({
      row: rowIndex,
      column: columnIndex,
      cell,
      x: columns[columnIndex].x,
      y: rows[rowIndex].y,
      width: columns.slice(columnIndex, columnIndex + colSpan).reduce((total, item) => total + item.width, 0),
      height: rows.slice(rowIndex, rowIndex + rowSpan).reduce((total, item) => total + item.height, 0),
      rowSpan,
      colSpan,
    });
  }));
  return rects;
}

export function insertTableRow(entity, rowIndex = entity.rows.length - 1) {
  const table = normalizeTableEntity(entity);
  const index = Math.min(table.rows.length, Math.max(0, Number(rowIndex) + 1));
  table.rows.splice(index, 0, { height: 32 });
  table.cells.splice(index, 0, table.columns.map(() => normalizeCell(table.defaultCell)));
  return table;
}

export function insertTableColumn(entity, columnIndex = entity.columns.length - 1) {
  const table = normalizeTableEntity(entity);
  const index = Math.min(table.columns.length, Math.max(0, Number(columnIndex) + 1));
  table.columns.splice(index, 0, { width: 120 });
  table.cells.forEach((row) => row.splice(index, 0, normalizeCell(table.defaultCell)));
  return table;
}

export function deleteTableRows(entity, rowIndices = []) {
  const table = normalizeTableEntity(entity);
  const rowsToDelete = [...new Set(rowIndices.map(Number))]
    .filter((rowIndex) => Number.isInteger(rowIndex) && rowIndex >= 0 && rowIndex < table.rows.length)
    .sort((a, b) => a - b);
  if (!rowsToDelete.length || rowsToDelete.length >= table.rows.length) return table;
  // Normalize merged cells before removing a row so no remaining cell keeps
  // a stale rowSpan or mergedInto reference to the deleted row.
  const unmerged = unmergeTableCells(table, table.cells.flatMap((row, rowIndex) => row.map((_, columnIndex) => ({ row: rowIndex, column: columnIndex }))));
  const deleted = new Set(rowsToDelete);
  unmerged.rows = unmerged.rows.filter((_, rowIndex) => !deleted.has(rowIndex));
  unmerged.cells = unmerged.cells.filter((_, rowIndex) => !deleted.has(rowIndex));
  return normalizeTableEntity(unmerged);
}

export function mergeTableCells(entity, cells = []) {
  const table = normalizeTableEntity(entity);
  const points = cells
    .map((cell) => [Number(cell.row), Number(cell.column)])
    .filter(([row, column]) => row >= 0 && column >= 0 && row < table.rows.length && column < table.columns.length);
  if (points.length < 2) return table;
  const minRow = Math.min(...points.map(([row]) => row));
  const maxRow = Math.max(...points.map(([row]) => row));
  const minColumn = Math.min(...points.map(([, column]) => column));
  const maxColumn = Math.max(...points.map(([, column]) => column));
  const selected = new Set(points.map(([row, column]) => `${row}:${column}`));
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let column = minColumn; column <= maxColumn; column += 1) {
      if (!selected.has(`${row}:${column}`)) return table;
    }
  }
  const anchor = table.cells[minRow][minColumn];
  anchor.rowSpan = maxRow - minRow + 1;
  anchor.colSpan = maxColumn - minColumn + 1;
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let column = minColumn; column <= maxColumn; column += 1) {
      if (row === minRow && column === minColumn) continue;
      table.cells[row][column] = { ...table.cells[row][column], mergedInto: { row: minRow, column: minColumn } };
    }
  }
  return table;
}

export function unmergeTableCells(entity, cells = []) {
  const table = normalizeTableEntity(entity);
  const requested = cells.length ? cells : [{ row: 0, column: 0 }];
  requested.forEach(({ row, column }) => {
    const candidate = table.cells?.[row]?.[column];
    const anchor = candidate?.mergedInto || { row, column };
    const source = table.cells?.[anchor.row]?.[anchor.column];
    if (!source) return;
    const rowSpan = source.rowSpan || 1;
    const colSpan = source.colSpan || 1;
    source.rowSpan = 1;
    source.colSpan = 1;
    for (let rowIndex = anchor.row; rowIndex < anchor.row + rowSpan; rowIndex += 1) {
      for (let columnIndex = anchor.column; columnIndex < anchor.column + colSpan; columnIndex += 1) {
        if (rowIndex === anchor.row && columnIndex === anchor.column) continue;
        const restored = normalizeCell(table.cells[rowIndex][columnIndex]);
        delete restored.mergedInto;
        table.cells[rowIndex][columnIndex] = restored;
      }
    }
  });
  return table;
}

function svg(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
  return node;
}

function html(tag, attributes = {}) {
  const node = document.createElementNS(XHTML_NS, tag);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
  return node;
}

function escapeText(value) {
  return String(value ?? '').replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]);
}

function cellKey(row, column) { return `${row}:${column}`; }

function bindHoverState(node) {
  node.addEventListener('pointerover', () => node.classList.add('hovered'));
  node.addEventListener('pointerout', () => node.classList.remove('hovered'));
  return node;
}

export function tableCellTextSvgLayout(rect = {}, cell = {}) {
  const textAlign = ['left', 'center', 'right'].includes(cell.textAlign) ? cell.textAlign : 'left';
  const textVerticalAlign = normalizeTextVerticalAlign(cell.textVerticalAlign);
  const inset = 4;
  const x = textAlign === 'center'
    ? rect.x + rect.width / 2
    : textAlign === 'right' ? rect.x + rect.width - inset : rect.x + inset;
  const y = textVerticalAlign === 'middle'
    ? rect.y + rect.height / 2
    : textVerticalAlign === 'bottom' ? rect.y + rect.height - 3 : rect.y + inset;
  return {
    x,
    y,
    textAnchor: textAlign === 'center' ? 'middle' : textAlign === 'right' ? 'end' : 'start',
    dominantBaseline: textVerticalAlign === 'middle' ? 'middle' : textVerticalAlign === 'bottom' ? 'alphabetic' : 'hanging',
  };
}

function selectedCellList(record) {
  const selection = record.tableSelection;
  if (selection?.cells?.size) return [...selection.cells].map((key) => {
    const [row, column] = key.split(':').map(Number);
    return { row, column };
  });
  if (selection?.rows?.size) return [...selection.rows].flatMap((row) => record.entity.columns.map((_, column) => ({ row, column })));
  if (selection?.columns?.size) return [...selection.columns].flatMap((column) => record.entity.rows.map((_, row) => ({ row, column })));
  return [];
}

function selectedCellBounds(record, fallback = null) {
  const cells = selectedCellList(record);
  if (!cells.length && fallback) return { minRow: fallback.row, maxRow: fallback.row, minColumn: fallback.column, maxColumn: fallback.column };
  if (!cells.length) return null;
  return {
    minRow: Math.min(...cells.map(({ row }) => row)),
    maxRow: Math.max(...cells.map(({ row }) => row)),
    minColumn: Math.min(...cells.map(({ column }) => column)),
    maxColumn: Math.max(...cells.map(({ column }) => column)),
  };
}

function cellClipboardMatrix(record, fallback = null) {
  const bounds = selectedCellBounds(record, fallback);
  if (!bounds) return [];
  const rows = [];
  for (let row = bounds.minRow; row <= bounds.maxRow; row += 1) {
    const values = [];
    for (let column = bounds.minColumn; column <= bounds.maxColumn; column += 1) {
      values.push(String(record.entity.cells?.[row]?.[column]?.text ?? ''));
    }
    rows.push(values);
  }
  return rows;
}

export function tableCellClipboardText(record, fallback = null) {
  return cellClipboardMatrix(record, fallback).map((row) => row.join('\t')).join('\n');
}

function paramagicClipboardText(value) {
  const source = String(value ?? '');
  try {
    const parsed = JSON.parse(source);
    if (parsed?.format === PARAMAGIC_CLIPBOARD_FORMAT
      && Number(parsed.version) === PARAMAGIC_CLIPBOARD_VERSION) {
      const textEntities = parsed.drawing?.entities?.filter((entity) => entity?.type === 'text') || [];
      return {
        recognized: true,
        text: textEntities.length ? textEntities.map((entity) => String(entity.text ?? '')).join('\n') : null,
      };
    }
  } catch {
    // Plain text is the normal table-cell paste format.
  }
  return null;
}

export function tableCellClipboardValue(value) {
  const source = String(value ?? '');
  const packageText = paramagicClipboardText(source);
  return packageText?.recognized ? packageText.text : source;
}

function tableCellClipboardMatrix(value) {
  const packageText = paramagicClipboardText(value);
  if (packageText?.recognized) return packageText.text === null ? null : [[packageText.text]];
  const text = String(value ?? '');
  return String(text).split(/\r\n?|\n/).map((row) => row.split('\t'));
}

function valueSet(values) {
  const set = new Set(values);
  return set.size === 1 ? [...set][0] : null;
}

function propertyCells(record) {
  const selected = selectedCellList(record);
  return selected.length
    ? selected.map(({ row, column }) => record.entity.cells?.[row]?.[column]).filter(Boolean)
    : record.entity.cells.flat();
}

export function createTableSystem({
  objectLayer,
  handleLayer,
  previewLayer,
  screenToWorld,
  getScale = () => 1,
  getParameters = () => [],
  formatParameter = (entry) => String(entry.value ?? ''),
  evaluateExpression = null,
  iconFor = (name) => TABLE_TOOL_ICONS[name] || '',
  onSelect = () => {},
  onHandlePointerDown = () => {},
  onChange = () => {},
  requestHistoryCheckpoint = () => {},
  notifySelectionChange = () => {},
} = {}) {
  const records = new Set();
  let resizeDrag = null;
  let cellSelectionDrag = null;
  let editingCell = null;
  let previewNode = null;

  function resolveCellText(cell) {
    return resolveTextFields(cell?.text ?? '', getParameters(), formatParameter, evaluateExpression);
  }

  function displayedCellText(record, row, column, cell) {
    return editingCell?.record === record
      && editingCell.row === row
      && editingCell.column === column
      ? String(cell?.text ?? '')
      : resolveCellText(cell);
  }

  function clearPreview() {
    previewNode?.remove();
    previewNode = null;
  }

  function setPreview(input = {}) {
    clearPreview();
    if (!previewLayer) return;
    const table = normalizeTableEntity(input);
    const { width, height } = tableDimensions(table);
    previewNode = svg('g', { class: 'table-placement-preview', 'data-entity-type': 'table' });
    previewLayer.appendChild(previewNode);
    tableCellRects(table).forEach((rect) => {
      const cell = rect.cell;
      const background = svg('rect', {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        class: 'table-placement-preview-cell',
        fill: cell.fillColor,
        'fill-opacity': cell.fillOpacity,
        stroke: cell.strokeColor,
        'stroke-opacity': cell.strokeOpacity,
        'stroke-width': cell.strokeThickness,
      });
      previewNode.appendChild(background);
      const textLayout = tableCellTextSvgLayout(rect, cell);
      const text = svg('text', {
        x: textLayout.x,
        y: textLayout.y,
        class: 'table-placement-preview-text',
        fill: cell.fontColor,
        'font-family': cell.fontName,
        'font-size': cell.fontSize,
        'text-anchor': textLayout.textAnchor,
        'dominant-baseline': textLayout.dominantBaseline,
      });
      text.textContent = resolveCellText(cell);
      previewNode.appendChild(text);
    });
    previewNode.appendChild(svg('rect', {
      x: table.x,
      y: table.y,
      width,
      height,
      class: 'table-placement-preview-border',
      fill: 'none',
      stroke: table.appearance.strokeColor,
      'stroke-opacity': table.appearance.strokeOpacity,
      'stroke-width': table.appearance.strokeThickness,
    }));
  }

  function setSelection(record, { cells = [], rows = [], columns = [], anchorCell = undefined } = {}) {
    const previous = record.tableSelection;
    record.tableSelection = {
      cells: new Set(cells.map(({ row, column }) => cellKey(row, column))),
      rows: new Set(rows),
      columns: new Set(columns),
      anchorCell: anchorCell === undefined ? previous?.anchorCell || null : anchorCell,
    };
    syncSelectionPresentation(record);
    notifySelectionChange();
  }

  function selectTable(record) {
    setSelection(record);
    onSelect(record.id);
  }

  function deleteSelectedRows(record, { checkpoint = true, notify = true } = {}) {
    const rows = [...(record?.tableSelection?.rows || [])].sort((a, b) => a - b);
    if (!record || !rows.length || rows.length >= record.entity.rows.length) return false;
    if (checkpoint) requestHistoryCheckpoint('table-delete-row');
    record.entity = deleteTableRows(record.entity, rows);
    const nextRow = Math.min(rows[0], record.entity.rows.length - 1);
    setSelection(record, { rows: [nextRow], anchorCell: null });
    if (notify) onChange(record, { history: 'commit' });
    return true;
  }

  function selectCell(record, row, column, event) {
    const current = record.tableSelection || { cells: new Set(), rows: new Set(), columns: new Set() };
    const key = cellKey(row, column);
    let nextCells;
    let anchorCell = { row, column };
    if (event?.shiftKey && current.anchorCell) {
      const minRow = Math.min(current.anchorCell.row, row);
      const maxRow = Math.max(current.anchorCell.row, row);
      const minColumn = Math.min(current.anchorCell.column, column);
      const maxColumn = Math.max(current.anchorCell.column, column);
      nextCells = [];
      for (let rowIndex = minRow; rowIndex <= maxRow; rowIndex += 1) {
        for (let columnIndex = minColumn; columnIndex <= maxColumn; columnIndex += 1) {
          nextCells.push({ row: rowIndex, column: columnIndex });
        }
      }
      anchorCell = current.anchorCell;
    } else if (event?.ctrlKey || event?.metaKey) {
      nextCells = [...current.cells].map((selectedKey) => {
        const [existingRow, existingColumn] = selectedKey.split(':').map(Number);
        return { row: existingRow, column: existingColumn };
      });
      const existingIndex = nextCells.findIndex((item) => cellKey(item.row, item.column) === key);
      if (existingIndex >= 0) nextCells.splice(existingIndex, 1);
      else nextCells.push({ row, column });
    } else {
      nextCells = [{ row, column }];
    }
    setSelection(record, { cells: nextCells, anchorCell });
    onSelect(record.id);
    const editor = record.editors.get(key);
    editor?.focus();
    if (editor && event?.detail > 1) {
      editor.readOnly = false;
      editor.classList.add('editing');
      editor.setSelectionRange(editor.value.length, editor.value.length);
    }
  }

  function cellsBetween(start, end) {
    const cells = [];
    const minRow = Math.min(start.row, end.row);
    const maxRow = Math.max(start.row, end.row);
    const minColumn = Math.min(start.column, end.column);
    const maxColumn = Math.max(start.column, end.column);
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let column = minColumn; column <= maxColumn; column += 1) {
        cells.push({ row, column });
      }
    }
    return cells;
  }

  function beginCellSelectionDrag(record, row, column, event) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey) return;
    cellSelectionDrag = {
      record,
      anchor: { row, column },
      last: { row, column },
    };
  }

  function moveCellSelectionDrag(event) {
    if (!cellSelectionDrag) return;
    const { record, anchor, last } = cellSelectionDrag;
    const world = screenToWorld(event.clientX, event.clientY);
    const current = tableCellRects(record.entity).find((rect) => (
      world[0] >= rect.x
      && world[0] <= rect.x + rect.width
      && world[1] >= rect.y
      && world[1] <= rect.y + rect.height
    ));
    if (!current || (current.row === last.row && current.column === last.column)) return;
    cellSelectionDrag.last = { row: current.row, column: current.column };
    setSelection(record, { cells: cellsBetween(anchor, current), anchorCell: anchor });
    onSelect(record.id);
  }

  function finishCellSelectionDrag() {
    cellSelectionDrag = null;
  }

  function editCell(record, row, column, event) {
    selectCell(record, row, column, event);
    editingCell = { record, row, column };
    updateRecord(record);
    const editor = record.editors.get(cellKey(row, column));
    if (!editor) return;
    editor.readOnly = false;
    editor.classList.add('editing');
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }

  function commitCell(record, row, column, editor, { notify = true } = {}) {
    const cell = record.entity.cells?.[row]?.[column];
    if (!cell || cell.text === editor.value) return false;
    cell.text = editor.value;
    if (notify) {
      requestHistoryCheckpoint('table-cell-edit');
      onChange(record, { history: 'coalesce' });
    }
    return true;
  }

  function selectedCellClipboardText(record, row, column) {
    return tableCellClipboardText(record, { row, column });
  }

  function clearSelectedCellText(record, row, column) {
    const cells = selectedCellList(record);
    const targets = cells.length ? cells : [{ row, column }];
    let changed = false;
    targets.forEach(({ row: targetRow, column: targetColumn }) => {
      const cell = record.entity.cells?.[targetRow]?.[targetColumn];
      if (!cell || cell.text === '') return;
      cell.text = '';
      changed = true;
    });
    return changed;
  }

  function beginCellPasteEdit(record, row, column, editor) {
    if (editor.classList.contains('editing')) return;
    editingCell = { record, row, column };
    editor.value = String(record.entity.cells?.[row]?.[column]?.text ?? '');
    editor.readOnly = false;
    editor.classList.add('editing');
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }

  function pasteCellValue(record, row, column, editor, clipboardValue) {
    const matrix = tableCellClipboardMatrix(clipboardValue);
    if (!matrix) return false;
    const isSingleValue = matrix.length === 1 && matrix[0].length === 1;
    if (isSingleValue) {
      beginCellPasteEdit(record, row, column, editor);
      const start = Number.isInteger(editor.selectionStart) ? editor.selectionStart : editor.value.length;
      const end = Number.isInteger(editor.selectionEnd) ? editor.selectionEnd : start;
      editor.setRangeText(matrix[0][0], start, end, 'end');
      commitCell(record, row, column, editor, { notify: false });
      return true;
    }
    const changed = matrix.some((values, rowOffset) => values.some((value, columnOffset) => {
      const target = record.entity.cells?.[row + rowOffset]?.[column + columnOffset];
      if (!target || target.text === value) return false;
      target.text = value;
      return true;
    }));
    if (changed) updateRecord(record);
    return changed;
  }

  function tableRecordForClipboard(recordIds = []) {
    const selected = new Set(recordIds.map(String));
    return [...records].find((record) => selected.has(record.id) && selectedCellList(record).length) || null;
  }

  function copySelectedCells(recordIds = []) {
    const record = tableRecordForClipboard(recordIds);
    if (!record) return null;
    return { text: tableCellClipboardText(record), recordId: record.id };
  }

  function pasteSelectedCell(recordIds = [], clipboardValue = '') {
    const record = tableRecordForClipboard(recordIds);
    if (!record) return null;
    const matrix = tableCellClipboardMatrix(clipboardValue);
    if (!matrix) return { handled: true, changed: false, recordId: record.id };
    const selected = selectedCellList(record);
    const anchor = record.tableSelection?.anchorCell || selected[0];
    if (!anchor) return { handled: true, changed: false, recordId: record.id };
    const changed = matrix.some((values, rowOffset) => values.some((value, columnOffset) => {
      const target = record.entity.cells?.[anchor.row + rowOffset]?.[anchor.column + columnOffset];
      if (!target || target.text === value) return false;
      target.text = value;
      return true;
    }));
    if (changed) {
      requestHistoryCheckpoint('table-cell-paste');
      updateRecord(record);
      onChange(record, { history: 'commit' });
    }
    return { handled: true, changed, recordId: record.id };
  }

  function cutSelectedCells(recordIds = []) {
    const record = tableRecordForClipboard(recordIds);
    if (!record) return null;
    const text = tableCellClipboardText(record);
    const cells = selectedCellList(record);
    let changed = false;
    cells.forEach(({ row, column }) => {
      const cell = record.entity.cells?.[row]?.[column];
      if (!cell || cell.text === '') return;
      cell.text = '';
      changed = true;
    });
    if (changed) {
      requestHistoryCheckpoint('table-cell-cut');
      updateRecord(record);
      onChange(record, { history: 'commit' });
    }
    return { text, changed, recordId: record.id };
  }

  function selectedCellState(record) {
    const selection = record.tableSelection || { cells: new Set(), rows: new Set(), columns: new Set() };
    return { cells: selectedCellList(record), rows: selection.rows, columns: selection.columns };
  }

  function actionButton(record, label, iconName, handler, enabled) {
    const button = html('button', { type: 'button', class: 'image-toolbar-button canvas-overlay-button', title: label, 'aria-label': label });
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${iconFor(iconName || label)}</svg>`;
    button.disabled = !enabled;
    button.addEventListener('pointerdown', (event) => event.stopPropagation());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!button.disabled) handler();
    });
    return button;
  }

  function renderToolbar(record, width) {
    const { rows, columns, cells } = selectedCellState(record);
    record.toolbarContent.replaceChildren(
      actionButton(record, 'Insert Row Below', 'Insert Row Below', () => {
        requestHistoryCheckpoint('table-insert-row');
        record.entity = insertTableRow(record.entity, rows.size ? Math.max(...rows) : cells.at(-1)?.row ?? record.entity.rows.length - 1);
        updateRecord(record);
        setSelection(record, { rows: [rows.size ? Math.max(...rows) + 1 : record.entity.rows.length - 1] });
        onChange(record, { history: 'commit' });
      }, rows.size > 0),
      actionButton(record, 'Insert Column After', 'Insert Column After', () => {
        requestHistoryCheckpoint('table-insert-column');
        record.entity = insertTableColumn(record.entity, columns.size ? Math.max(...columns) : cells.at(-1)?.column ?? record.entity.columns.length - 1);
        updateRecord(record);
        setSelection(record, { columns: [columns.size ? Math.max(...columns) + 1 : record.entity.columns.length - 1] });
        onChange(record, { history: 'commit' });
      }, columns.size > 0),
      actionButton(record, 'Merge', 'Merge', () => {
        requestHistoryCheckpoint('table-merge');
        record.entity = mergeTableCells(record.entity, cells);
        updateRecord(record);
        onChange(record, { history: 'commit' });
      }, cells.length > 1),
      actionButton(record, 'Unmerge', 'Unmerge', () => {
        requestHistoryCheckpoint('table-unmerge');
        record.entity = unmergeTableCells(record.entity, cells);
        updateRecord(record);
        onChange(record, { history: 'commit' });
      }, cells.some(({ row, column }) => isTableCellMerged(record.entity, row, column))),
    );
  }

  function syncSelectionPresentation(record) {
    if (!record?.content) return;
    const selection = record.tableSelection || { cells: new Set(), rows: new Set(), columns: new Set() };
    const tableActive = record.group.classList.contains('selected');
    record.group.classList.toggle('table-overall-selected', tableActive && !(
      selection.cells.size || selection.rows.size || selection.columns.size
    ));
    record.content.querySelectorAll('.table-cell-background').forEach((node) => {
      const [row, column] = String(node.dataset.tableCell || '').split(':').map(Number);
      node.classList.toggle('selected', tableActive && (
        selection.cells.has(cellKey(row, column))
        || selection.rows.has(row)
        || selection.columns.has(column)
      ));
    });
    record.content.querySelectorAll('.table-column-selector').forEach((node) => {
      node.classList.toggle('selected', tableActive && selection.columns.has(Number(node.dataset.tableColumnSelect)));
    });
    record.content.querySelectorAll('.table-row-selector').forEach((node) => {
      node.classList.toggle('selected', tableActive && selection.rows.has(Number(node.dataset.tableRowSelect)));
    });
    renderToolbar(record, tableDimensions(record.entity).width);
  }

  function startResize(record, mode, index, event) {
    event.preventDefault();
    event.stopPropagation();
    onSelect(record.id);
    resizeDrag = { record, mode, index, start: screenToWorld(event.clientX, event.clientY), entity: normalizeTableEntity(record.entity) };
    requestHistoryCheckpoint(`table-resize-${mode}`);
  }

  function moveResize(event) {
    if (!resizeDrag) return;
    const { record, mode, index, start, entity } = resizeDrag;
    const world = screenToWorld(event.clientX, event.clientY);
    const deltaX = world[0] - start[0];
    const deltaY = world[1] - start[1];
    record.entity = normalizeTableEntity(entity);
    if (mode === 'column') record.entity.columns[index].width = Math.max(24, entity.columns[index].width + deltaX);
    if (mode === 'row') record.entity.rows[index].height = Math.max(20, entity.rows[index].height + deltaY);
    if (mode === 'corner') {
      const { width, height } = tableDimensions(entity);
      const nextWidth = Math.max(48, width + (index === 1 || index === 2 ? deltaX : -deltaX));
      const nextHeight = Math.max(40, height + (index >= 2 ? deltaY : -deltaY));
      const scaleX = nextWidth / width;
      const scaleY = nextHeight / height;
      record.entity.columns = entity.columns.map((column) => ({ width: Math.max(24, column.width * scaleX) }));
      record.entity.rows = entity.rows.map((row) => ({ height: Math.max(20, row.height * scaleY) }));
      if (index === 0) { record.entity.x = entity.x + deltaX; record.entity.y = entity.y + deltaY; }
      if (index === 1) record.entity.y = entity.y + deltaY;
      if (index === 3) record.entity.x = entity.x + deltaX;
    }
    updateRecord(record);
    onChange(record, { history: 'coalesce' });
  }

  function finishResize() {
    if (!resizeDrag) return;
    resizeDrag = null;
    onChange(null, { history: 'commit' });
  }

  document.addEventListener('pointermove', moveResize);
  document.addEventListener('pointerup', finishResize);
  document.addEventListener('pointermove', moveCellSelectionDrag);
  document.addEventListener('pointerup', finishCellSelectionDrag);

  function createRecord(input) {
    const entity = normalizeTableEntity(input);
    const group = svg('g', { class: 'canvas-record table-record', 'data-record-id': entity.id, 'data-entity-type': 'table' });
    const content = svg('g', { class: 'table-content' });
    const hitTarget = svg('rect', { class: 'table-hit-target selectable-entity hit-target', 'data-record-id': entity.id });
    const dragBorder = bindHoverState(svg('rect', { class: 'table-drag-border selectable-entity hit-target', 'data-record-id': entity.id }));
    const dragVisual = svg('rect', { class: 'table-drag-border-visual', 'pointer-events': 'none' });
    // Keep the whole-table target behind cell editors, cell selection targets,
    // row/column selectors, and resize boundaries. It still catches clicks in
    // otherwise empty table areas without stealing the table's inner controls.
    group.append(hitTarget, content, dragBorder, dragVisual);
    const handleGroup = svg('g', { class: 'handle-group table-handle-group', 'data-record-id': entity.id });
    const toolbar = svg('foreignObject', { class: 'image-context-toolbar table-context-toolbar' });
    const toolbarContent = html('div', { class: 'image-context-toolbar-content canvas-overlay-button' });
    toolbar.appendChild(toolbarContent);
    group.appendChild(toolbar);
    objectLayer.appendChild(group);
    handleLayer.appendChild(handleGroup);
    const record = {
      id: entity.id,
      recordType: 'table',
      entity,
      group,
      node: hitTarget,
      hitNode: hitTarget,
      dragBorder,
      dragVisual,
      handleGroup,
      content,
      handles: [],
      toolbar,
      toolbarContent,
      editors: new Map(),
      tableSelection: { cells: new Set(), rows: new Set(), columns: new Set(), anchorCell: null },
      updateNode() { updateRecord(record); },
      updateFromConstraint(constraintEntity) {
        record.entity = applyTableConstraintEntity(record.entity, constraintEntity);
        updateRecord(record);
        return true;
      },
      syncState(isSelected, _isHovered, featureToolActive = false) {
        record.toolbar.style.display = isSelected ? '' : 'none';
        record.handleGroup.classList.toggle('active', isSelected || featureToolActive);
        syncSelectionPresentation(record);
      },
      translateEntity(startEntity, delta) {
        record.entity.x = startEntity.x + delta[0];
        record.entity.y = startEntity.y + delta[1];
      },
      moveHandle(index, world, startEntity) {
        const corners = tableCornerPoints(startEntity);
        const opposite = corners[(index + 2) % 4];
        const left = Math.min(opposite[0], world[0]);
        const top = Math.min(opposite[1], world[1]);
        const width = Math.max(48, Math.abs(world[0] - opposite[0]));
        const height = Math.max(40, Math.abs(world[1] - opposite[1]));
        const oldSize = tableDimensions(startEntity);
        record.entity = normalizeTableEntity(startEntity);
        record.entity.x = left;
        record.entity.y = top;
        const scaleX = width / oldSize.width;
        const scaleY = height / oldSize.height;
        record.entity.columns = startEntity.columns.map((column) => ({ width: Math.max(24, column.width * scaleX) }));
        record.entity.rows = startEntity.rows.map((row) => ({ height: Math.max(20, row.height * scaleY) }));
        onChange(record, { history: 'coalesce' });
      },
      dispose() {
        record.editors.clear();
        if (editingCell?.record === record) editingCell = null;
      },
    };
    records.add(record);

    record.handles = [];
    updateRecord(record);
    return record;
  }

  function updateRecord(record) {
    if (!record?.entity || !record.content) record.content = record?.group?.querySelector('.table-content');
    if (!record?.content) return;
    const table = normalizeTableEntity(record.entity);
    record.entity = table;
    const { width, height } = tableDimensions(table);
    record.group.setAttribute('data-table-width', width);
    record.group.setAttribute('data-table-height', height);
    record.content.replaceChildren();
    record.editors.clear();
    tableCellRects(table).forEach((rect) => {
      const cellGroup = svg('g', { class: 'table-cell', 'data-table-cell': cellKey(rect.row, rect.column) });
      const selection = record.tableSelection || { cells: new Set(), rows: new Set(), columns: new Set() };
      const selected = record.group.classList.contains('selected')
        && (selection.cells.has(cellKey(rect.row, rect.column))
          || selection.rows.has(rect.row)
          || selection.columns.has(rect.column));
      const cell = rect.cell;
      cellGroup.style.setProperty('--original-stroke-width', `${cell.strokeThickness}px`);
      const background = svg('rect', {
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        class: `table-cell-background${selected ? ' selected' : ''}`,
        fill: cell.fillColor, 'fill-opacity': cell.fillOpacity,
        stroke: cell.strokeColor, 'stroke-opacity': cell.strokeOpacity, 'stroke-width': cell.strokeThickness,
        'data-table-cell': cellKey(rect.row, rect.column),
      });
      background.style.setProperty('--table-cell-stroke-color', cell.strokeColor);
      cellGroup.appendChild(background);
      const foreignObject = svg('foreignObject', { x: rect.x + 3, y: rect.y + 2, width: Math.max(1, rect.width - 6), height: Math.max(1, rect.height - 4), class: 'table-cell-editor-host' });
      const editor = html('textarea', { class: 'table-cell-editor', rows: 1, spellcheck: 'false', wrap: cell.multiline ? 'soft' : 'off' });
      const isEditing = editingCell?.record === record
        && editingCell.row === rect.row
        && editingCell.column === rect.column;
      editor.value = displayedCellText(record, rect.row, rect.column, cell);
      editor.readOnly = !isEditing;
      editor.classList.toggle('editing', isEditing);
      editor.style.fontFamily = cell.fontName;
      editor.style.fontSize = `${cell.fontSize}px`;
      editor.style.color = cell.fontColor;
      editor.style.textAlign = cell.textAlign;
      const cellLines = cell.multiline ? String(editor.value || ' ').split(/\r\n?|\n/) : [String(editor.value || ' ')];
      const cellLineHeight = cell.fontSize * 1.15;
      const cellContentHeight = Math.max(cellLineHeight, cellLines.length * cellLineHeight);
      const cellInnerHeight = Math.max(0, rect.height - 4);
      const cellVerticalAlign = normalizeTextVerticalAlign(cell.textVerticalAlign);
      const verticalPadding = cellVerticalAlign === 'middle'
        ? Math.max(2, (cellInnerHeight - cellContentHeight) / 2)
        : cellVerticalAlign === 'bottom' ? Math.max(2, cellInnerHeight - cellContentHeight) : 2;
      editor.style.padding = `${verticalPadding}px 3px 2px`;
      editor.style.whiteSpace = cell.multiline ? 'pre-wrap' : 'pre';
      editor.style.overflow = 'hidden';
      editor.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        selectCell(record, rect.row, rect.column, event);
        if (!editor.classList.contains('editing')) beginCellSelectionDrag(record, rect.row, rect.column, event);
      });
      editor.addEventListener('dblclick', (event) => { event.stopPropagation(); editCell(record, rect.row, rect.column, event); });
      editor.addEventListener('copy', (event) => {
        if (editor.classList.contains('editing')
          && Number(editor.selectionStart) !== Number(editor.selectionEnd)) return;
        event.clipboardData?.setData('text/plain', selectedCellClipboardText(record, rect.row, rect.column));
        event.preventDefault();
        event.stopPropagation();
      });
      editor.addEventListener('cut', (event) => {
        if (editor.classList.contains('editing')
          && Number(editor.selectionStart) !== Number(editor.selectionEnd)) return;
        event.clipboardData?.setData('text/plain', selectedCellClipboardText(record, rect.row, rect.column));
        event.preventDefault();
        event.stopPropagation();
        requestHistoryCheckpoint('table-cell-cut');
        const changed = clearSelectedCellText(record, rect.row, rect.column);
        if (changed) {
          editingCell = null;
          updateRecord(record);
          onChange(record, { history: 'commit' });
        }
      });
      editor.addEventListener('paste', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const clipboardValue = event.clipboardData?.getData('text/plain') || '';
        const matrix = tableCellClipboardMatrix(clipboardValue);
        // A ParaMagic package containing only shapes is intentionally ignored;
        // never expose its internal JSON as cell text.
        if (!matrix) return;
        requestHistoryCheckpoint('table-cell-paste');
        const changed = pasteCellValue(record, rect.row, rect.column, editor, clipboardValue);
        if (changed) onChange(record, { history: 'commit' });
      });
      // Keep the live editor mounted while the user types. Committing on
      // every input causes the canvas-wide change notification path to steal
      // focus from the textarea after the first character.
      editor.addEventListener('input', () => commitCell(record, rect.row, rect.column, editor, { notify: false }));
      editor.addEventListener('blur', () => {
        const changed = commitCell(record, rect.row, rect.column, editor, { notify: false });
        if (changed) {
          requestHistoryCheckpoint('table-cell-edit');
          onChange(record, { history: 'coalesce' });
        }
        if (editingCell?.record === record
          && editingCell.row === rect.row
          && editingCell.column === rect.column) editingCell = null;
        editor.readOnly = true;
        editor.classList.remove('editing');
        updateRecord(record);
      });
      editor.addEventListener('keydown', (event) => {
        // Cell editing owns the keyboard while the editor has focus. Without
        // this guard, the canvas shortcut handler can consume letters such as
        // C or B and end the edit immediately after the first keystroke.
        event.stopPropagation();
        if (editor.readOnly && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          editingCell = { record, row: rect.row, column: rect.column };
          editor.value = cell.text;
          editor.readOnly = false;
          editor.classList.add('editing');
          editor.value += event.key;
          commitCell(record, rect.row, rect.column, editor, { notify: false });
          editor.setSelectionRange(editor.value.length, editor.value.length);
        }
        if (!cell.multiline && event.key === 'Enter') { event.preventDefault(); editor.blur(); }
      });
      foreignObject.appendChild(editor);
      cellGroup.appendChild(foreignObject);
      cellGroup.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        selectCell(record, rect.row, rect.column, event);
        beginCellSelectionDrag(record, rect.row, rect.column, event);
      });
      cellGroup.addEventListener('click', (event) => { event.stopPropagation(); selectCell(record, rect.row, rect.column, event); });
      record.content.appendChild(cellGroup);
      record.editors.set(cellKey(rect.row, rect.column), editor);
    });
    table.columns.forEach((column, columnIndex) => {
      const x = table.x + table.columns.slice(0, columnIndex).reduce((total, item) => total + item.width, 0);
      const selectorSelected = record.group.classList.contains('selected') && record.tableSelection?.columns?.has(columnIndex);
      const selector = svg('rect', { x, y: table.y - 14 / getScale(), width: column.width, height: 12 / getScale(), class: `table-column-selector${selectorSelected ? ' selected' : ''}`, 'data-table-column-select': columnIndex });
      selector.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const current = record.tableSelection || { columns: new Set() };
        const additive = event.ctrlKey || event.metaKey;
        const nextColumns = additive ? new Set(current.columns) : new Set();
        if (additive && nextColumns.has(columnIndex)) nextColumns.delete(columnIndex);
        else nextColumns.add(columnIndex);
        setSelection(record, { columns: [...nextColumns], anchorCell: null });
        onSelect(record.id);
      });
      record.content.appendChild(selector);
      if (columnIndex < table.columns.length - 1) {
        const boundary = bindHoverState(svg('line', {
          x1: x + column.width, y1: table.y, x2: x + column.width, y2: table.y + height,
          class: 'table-resize-hit table-column-resize hit-target', 'data-table-column-resize': columnIndex,
        }));
        const visual = svg('line', {
          x1: x + column.width, y1: table.y, x2: x + column.width, y2: table.y + height,
          class: 'table-resize-visual table-column-resize-visual', 'pointer-events': 'none',
        });
        visual.style.setProperty('--original-stroke-width', `${table.appearance?.strokeThickness || 1.5}px`);
        boundary.addEventListener('pointerdown', (event) => startResize(record, 'column', columnIndex, event));
        record.content.append(boundary, visual);
      }
    });
    table.rows.forEach((row, rowIndex) => {
      const y = table.y + table.rows.slice(0, rowIndex).reduce((total, item) => total + item.height, 0);
      const selectorSelected = record.group.classList.contains('selected') && record.tableSelection?.rows?.has(rowIndex);
      const selector = svg('rect', { x: table.x - 14 / getScale(), y, width: 12 / getScale(), height: row.height, class: `table-row-selector${selectorSelected ? ' selected' : ''}`, 'data-table-row-select': rowIndex });
      selector.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const current = record.tableSelection || { rows: new Set() };
        const additive = event.ctrlKey || event.metaKey;
        const nextRows = additive ? new Set(current.rows) : new Set();
        if (additive && nextRows.has(rowIndex)) nextRows.delete(rowIndex);
        else nextRows.add(rowIndex);
        setSelection(record, { rows: [...nextRows], anchorCell: null });
        onSelect(record.id);
      });
      record.content.appendChild(selector);
      if (rowIndex < table.rows.length - 1) {
        const boundary = bindHoverState(svg('line', {
          x1: table.x, y1: y + row.height, x2: table.x + width, y2: y + row.height,
          class: 'table-resize-hit table-row-resize hit-target', 'data-table-row-resize': rowIndex,
        }));
        const visual = svg('line', {
          x1: table.x, y1: y + row.height, x2: table.x + width, y2: y + row.height,
          class: 'table-resize-visual table-row-resize-visual', 'pointer-events': 'none',
        });
        visual.style.setProperty('--original-stroke-width', `${table.appearance?.strokeThickness || 1.5}px`);
        boundary.addEventListener('pointerdown', (event) => startResize(record, 'row', rowIndex, event));
        record.content.append(boundary, visual);
      }
    });
    const hit = record.hitNode;
    hit.setAttribute('x', table.x); hit.setAttribute('y', table.y); hit.setAttribute('width', width); hit.setAttribute('height', height);
    hit.style.pointerEvents = 'none';
    record.dragBorder.setAttribute('x', table.x);
    record.dragBorder.setAttribute('y', table.y);
    record.dragBorder.setAttribute('width', width);
    record.dragBorder.setAttribute('height', height);
    record.dragVisual.setAttribute('x', table.x);
    record.dragVisual.setAttribute('y', table.y);
    record.dragVisual.setAttribute('width', width);
    record.dragVisual.setAttribute('height', height);
    record.dragVisual.style.setProperty('--original-stroke-width', `${table.appearance?.strokeThickness || 1.5}px`);
    record.handles.forEach((handle) => handle.remove());
    record.handles = tableCornerPoints(table).map(([cx, cy], index) => {
      const handle = svg('circle', { cx, cy, r: 6 / getScale(), class: 'point-handle table-corner-handle', 'data-handle-index': index, 'data-table-corner': index });
      handle.addEventListener('pointerdown', (event) => onHandlePointerDown(event, record, index));
      record.handleGroup.appendChild(handle);
      return handle;
    });
    const scale = Math.max(0.0001, getScale());
    record.toolbar.setAttribute('x', table.x);
    record.toolbar.setAttribute('y', (table.y - 48 / scale));
    record.toolbar.setAttribute('width', 190 / scale);
    record.toolbar.setAttribute('height', 42 / scale);
    record.toolbarContent.style.transform = `scale(${1 / scale})`;
    record.toolbarContent.style.transformOrigin = '0 0';
    record.toolbarContent.style.width = '190px';
    record.toolbarContent.style.height = '34px';
    record.toolbar.style.display = record.group.classList.contains('selected') ? '' : 'none';
    renderToolbar(record, width);
  }

  function setSelectedAppearance(recordIds, patch = {}) {
    const targets = [...records].filter((record) => recordIds.has(record.id));
    if (!targets.length) return { handled: false, success: false };
    targets.forEach((record) => {
      const cells = propertyCells(record);
      cells.forEach((cell) => {
        if (patch.fillExpression !== undefined || patch.fillColor !== undefined) cell.fillColor = String(patch.fillExpression ?? patch.fillColor);
        if (patch.fillOpacityExpression !== undefined) cell.fillOpacity = clampOpacity(Number(patch.fillOpacityExpression) / 100, cell.fillOpacity);
        if (patch.strokeThickness !== undefined) cell.strokeThickness = positive(patch.strokeThickness, cell.strokeThickness, 0.1);
        if (patch.strokeColor !== undefined) cell.strokeColor = String(patch.strokeColor);
        if (patch.strokeOpacityExpression !== undefined) cell.strokeOpacity = clampOpacity(Number(patch.strokeOpacityExpression) / 100, cell.strokeOpacity);
      });
      updateRecord(record);
    });
    onChange(null, { history: 'coalesce' });
    return { handled: true, success: true };
  }

  function beginEdit(record) {
    if (!record) return false;
    const first = { row: 0, column: 0 };
    setSelection(record, { cells: [first] });
    editCell(record, first.row, first.column, {});
    return true;
  }

  function setSelectedTextProperties(recordIds, patch = {}) {
    const targets = [...records].filter((record) => recordIds.has(record.id));
    if (!targets.length) return false;
    targets.forEach((record) => {
      propertyCells(record).forEach((cell) => {
        if (patch.fontName !== undefined) cell.fontName = String(patch.fontName);
        if (patch.fontSize !== undefined) cell.fontSize = positive(patch.fontSize, cell.fontSize, 1);
        if (patch.fontColor !== undefined) cell.fontColor = String(patch.fontColor);
        if (patch.textAlign !== undefined) cell.textAlign = ['left', 'center', 'right'].includes(patch.textAlign) ? patch.textAlign : cell.textAlign;
        if (patch.textVerticalAlign !== undefined) cell.textVerticalAlign = normalizeTextVerticalAlign(patch.textVerticalAlign);
        if (patch.multiline !== undefined) cell.multiline = Boolean(patch.multiline);
      });
      updateRecord(record);
    });
    onChange(null, { history: 'coalesce' });
    return true;
  }

  function selectionProperties(recordIds) {
    const targets = [...records].filter((record) => recordIds.has(record.id));
    if (!targets.length) return null;
    const cells = targets.flatMap(propertyCells);
    const appearance = targets.map((record) => record.entity.appearance || DEFAULT_APPEARANCE);
    return {
      tableCount: targets.length,
      tableCellCount: cells.length,
      tableRowCount: new Set(targets.flatMap((record) => [...(record.tableSelection?.rows || [])])).size,
      tableColumnCount: new Set(targets.flatMap((record) => [...(record.tableSelection?.columns || [])])).size,
      supportedCount: targets.length,
      ids: targets.map((record) => record.id),
      canEditFill: true,
      canEditImageFill: false,
      canEditOpacity: true,
      canEditStroke: true,
      canEditConstruction: false,
      canEditText: true,
      canEditScaleWithZoom: false,
      canEditImageFillSettings: false,
      fillColor: valueSet(cells.map((cell) => cell.fillColor)) || appearance[0].fillColor,
      fillExpression: valueSet(cells.map((cell) => cell.fillColor)) || appearance[0].fillColor,
      fillOpacity: valueSet(cells.map((cell) => cell.fillOpacity)) ?? appearance[0].fillOpacity,
      fillOpacityExpression: String(Math.round((valueSet(cells.map((cell) => cell.fillOpacity)) ?? appearance[0].fillOpacity) * 100)),
      strokeThickness: valueSet(cells.map((cell) => cell.strokeThickness)) ?? appearance[0].strokeThickness,
      strokeColor: valueSet(cells.map((cell) => cell.strokeColor)) || appearance[0].strokeColor,
      strokeOpacity: valueSet(cells.map((cell) => cell.strokeOpacity)) ?? appearance[0].strokeOpacity,
      strokeOpacityExpression: String(Math.round((valueSet(cells.map((cell) => cell.strokeOpacity)) ?? appearance[0].strokeOpacity) * 100)),
      fontName: valueSet(cells.map((cell) => cell.fontName)),
      fontSize: valueSet(cells.map((cell) => cell.fontSize)),
      fontColor: valueSet(cells.map((cell) => cell.fontColor)),
      textAlign: valueSet(cells.map((cell) => cell.textAlign)),
      textVerticalAlign: valueSet(cells.map((cell) => cell.textVerticalAlign)),
      multiline: valueSet(cells.map((cell) => cell.multiline)),
      scaleWithZoom: true,
      mixedFill: new Set(cells.map((cell) => cell.fillColor)).size > 1,
      mixedFillOpacity: new Set(cells.map((cell) => cell.fillOpacity)).size > 1,
      mixedStroke: new Set(cells.map((cell) => cell.strokeThickness)).size > 1,
      mixedStrokeOpacity: new Set(cells.map((cell) => cell.strokeOpacity)).size > 1,
    };
  }

  function featureFromEvent(event, record) {
    if (!record || event.target.classList?.contains('table-corner-handle') === false && !event.target.classList?.contains('point-handle')) return null;
    const index = Number(event.target.dataset.handleIndex ?? event.target.dataset.tableCorner);
    const point = tableCornerPoints(record.entity)[index];
    return point ? { kind: 'point', recordId: record.id, entityType: 'table', index: tableSolverCornerIndex(index), point: [...point], node: event.target } : null;
  }

  return {
    createRecord,
    beginEdit,
    updateRecord,
    setSelectedAppearance,
    setSelectedTextProperties,
    deleteSelectedRows,
    selectionProperties,
    featureFromEvent,
    copySelectedCells,
    pasteSelectedCell,
    cutSelectedCells,
    setPreview,
    clearPreview,
    cornerPoints: tableCornerPoints,
    constraintEntity: tableConstraintEntity,
    applyConstraintEntity: applyTableConstraintEntity,
    records,
  };
}
