let spreadsheetLibraryPromise = null;
let codepageLibraryPromise = null;

async function spreadsheetLibrary({ legacy = false } = {}) {
  spreadsheetLibraryPromise ||= import('xlsx');
  const library = await spreadsheetLibraryPromise;
  if (legacy) {
    codepageLibraryPromise ||= import('xlsx/dist/cpexcel.full.mjs');
    library.set_cptable(await codepageLibraryPromise);
  }
  return library;
}

export const PARAMETER_TABLE_FORMATS = Object.freeze({
  json: { extension: 'json', mimeType: 'application/json;charset=utf-8' },
  csv: { extension: 'csv', mimeType: 'text/csv;charset=utf-8' },
  xls: { extension: 'xls', mimeType: 'application/vnd.ms-excel' },
  xlsx: { extension: 'xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
});

const cellText = (value) => String(value ?? '').trim();

function typeLabel(entry) {
  if (entry?.kind === 'dimension') return 'Dimension';
  if (entry?.kind === 'control') return 'Control';
  return 'Parameter';
}

export function parameterTableExportRows(entries, { expressionForEntry = (entry) => entry?.expression ?? '' } = {}) {
  return [
    ['Name', 'Expression', 'Type'],
    ...Array.from(entries || []).map((entry) => [
      cellText(entry?.name),
      cellText(expressionForEntry(entry)),
      typeLabel(entry),
    ]),
  ];
}

export async function createParameterTableExport(entries, format, options = {}) {
  const normalizedFormat = String(format || '').toLowerCase();
  const specification = PARAMETER_TABLE_FORMATS[normalizedFormat];
  if (!specification) throw new Error(`Unsupported parameter table format: ${format}`);
  const rows = parameterTableExportRows(entries, options);
  if (normalizedFormat === 'json') {
    const content = rows.slice(1).map(([Name, Expression, Type]) => ({ Name, Expression, Type }));
    return {
      ...specification,
      blob: new Blob([JSON.stringify(content, null, 2)], { type: specification.mimeType }),
    };
  }

  const XLSX = await spreadsheetLibrary({ legacy: normalizedFormat === 'xls' });
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet['!cols'] = [{ wch: 28 }, { wch: 48 }, { wch: 14 }];
  if (normalizedFormat === 'csv') {
    return {
      ...specification,
      blob: new Blob([XLSX.utils.sheet_to_csv(worksheet)], { type: specification.mimeType }),
    };
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Parameters');
  const data = XLSX.write(workbook, {
    bookType: normalizedFormat,
    type: 'array',
    compression: normalizedFormat === 'xlsx',
  });
  return { ...specification, blob: new Blob([data], { type: specification.mimeType }) };
}

function rowsFromJsonCollection(collection) {
  if (!Array.isArray(collection)) return [];
  return collection.map((row) => {
    if (Array.isArray(row)) return row;
    if (!row || typeof row !== 'object') return [row, ''];
    const entries = Object.entries(row);
    const named = (key) => entries.find(([candidate]) => candidate.toLowerCase() === key)?.[1];
    const values = Object.values(row);
    return [named('name') ?? values[0] ?? '', named('expression') ?? values[1] ?? ''];
  });
}

function jsonWorkbook(value) {
  const sheetCollection = value?.sheets || value?.Sheets;
  if (Array.isArray(sheetCollection)) {
    const sheets = sheetCollection.map((sheet, index) => ({
      name: cellText(sheet?.name) || `Sheet${index + 1}`,
      rows: rowsFromJsonCollection(sheet?.rows || sheet?.data || []),
    }));
    return workbookReader(sheets);
  }
  if (sheetCollection && typeof sheetCollection === 'object') {
    return workbookReader(Object.entries(sheetCollection).map(([name, rows]) => ({
      name,
      rows: rowsFromJsonCollection(rows),
    })));
  }
  const collection = Array.isArray(value)
    ? value
    : value?.parameters || value?.Parameters || value?.rows || value?.data || [];
  return workbookReader([{ name: 'Parameters', rows: rowsFromJsonCollection(collection) }]);
}

function workbookReader(sheets) {
  const normalizedSheets = sheets.length ? sheets : [{ name: 'Parameters', rows: [] }];
  return {
    sheetNames: normalizedSheets.map(({ name }) => name),
    rowsForSheet: (name) => normalizedSheets.find((sheet) => sheet.name === name)?.rows || [],
  };
}

export async function readParameterTableFile(file) {
  const extension = String(file?.name || '').split('.').pop().toLowerCase();
  if (extension === 'json') return jsonWorkbook(JSON.parse(await file.text()));
  if (!['csv', 'xls', 'xlsx'].includes(extension)) throw new Error(`Unsupported parameter table file: ${file?.name || 'unknown'}`);

  const XLSX = await spreadsheetLibrary({ legacy: extension === 'xls' });
  const workbook = extension === 'csv'
    ? XLSX.read(await file.text(), { type: 'string', dense: true })
    : XLSX.read(await file.arrayBuffer(), { dense: true });
  return {
    sheetNames: [...workbook.SheetNames],
    rowsForSheet: (name) => XLSX.utils.sheet_to_json(workbook.Sheets[name], {
      header: 1,
      raw: false,
      defval: '',
    }),
  };
}

function headerCell(value) {
  const normalized = cellText(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
  return [
    'name',
    'parametername',
    'variablename',
    'expression',
    'parameterexpression',
    'valueexpression',
  ].includes(normalized);
}

export function normalizeImportedParameterRows(rawRows) {
  const rows = [];
  const skipped = { blank: 0, header: 0, duplicate: 0 };
  const names = new Set();
  Array.from(rawRows || []).forEach((source, index) => {
    const values = Array.isArray(source) ? source : Object.values(source || {});
    const name = cellText(values[0]);
    const expression = cellText(values[1]);
    if (!name && !expression) {
      skipped.blank += 1;
      return;
    }
    if (headerCell(name) || headerCell(expression)) {
      skipped.header += 1;
      return;
    }
    if (name && names.has(name)) {
      skipped.duplicate += 1;
      return;
    }
    if (name) names.add(name);
    rows.push({ name, expression, sourceRow: index + 1 });
  });
  return { rows, skipped };
}

function successfulUpdate(outcome) {
  return ['converged', 'unchanged'].includes(outcome?.result?.status);
}

export function replaceParametersFromRows({ solver, rows, scope = 'user' } = {}) {
  if (!solver) throw new Error('A solver is required to import Parameters.');
  const before = solver.parameters();
  const protectedEntries = before.filter((entry) => entry.kind === 'dimension' || entry.kind === 'control');
  const protectedByName = new Map(protectedEntries.map((entry) => [entry.name, entry]));
  before.filter((entry) => entry.kind !== 'dimension' && entry.kind !== 'control')
    .forEach((entry) => solver.removeParameter(entry.id));

  const importedIdsByRow = new Map();
  const summary = {
    inserted: 0,
    replaced: 0,
    skippedProtected: 0,
    skippedComputed: 0,
    skippedInvalid: 0,
  };

  const importedRows = Array.from(rows || []);
  importedRows.forEach(({ name = '', expression = '' }, index) => {
    const existing = protectedByName.get(name);
    if (existing) return;
    try {
      const created = solver.createParameter({ name, expression });
      importedIdsByRow.set(index, created.id);
      summary.inserted += 1;
    } catch {
      summary.skippedInvalid += 1;
    }
  });

  importedRows.forEach(({ name = '', expression = '' }, index) => {
    const existing = protectedByName.get(name);
    if (!existing) return;
    if (scope !== 'all') {
      summary.skippedProtected += 1;
      return;
    }
    if (existing.computed) {
      summary.skippedComputed += 1;
      importedIdsByRow.set(index, existing.id);
      return;
    }
    const outcome = solver.updateParameter(existing.id, { expression });
    if (!successfulUpdate(outcome)) {
      summary.skippedInvalid += 1;
      return;
    }
    importedIdsByRow.set(index, existing.id);
    summary.replaced += 1;
  });

  const importedIds = [...importedIdsByRow.entries()]
    .sort(([first], [second]) => first - second)
    .map(([, id]) => id);
  const imported = new Set(importedIds);
  const remainingIds = solver.parameters().map(({ id }) => id).filter((id) => !imported.has(id));
  [...importedIds, ...remainingIds].forEach((id) => solver.reorderParameter(id, null));
  return summary;
}
