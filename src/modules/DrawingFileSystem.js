export function isFileSystemAccessCancellation(error) {
  return error?.name === 'AbortError';
}

export function isFileSystemAccessBlocked(error) {
  return [
    'InvalidStateError',
    'NotAllowedError',
    'NotFoundError',
    'NoModificationAllowedError',
    'SecurityError',
  ].includes(error?.name);
}

export async function ensureFileHandleWritePermission(handle) {
  if (!handle) return false;
  const descriptor = { mode: 'readwrite' };
  if (typeof handle.queryPermission === 'function') {
    const permission = await handle.queryPermission(descriptor);
    if (permission === 'granted') return true;
    if (permission === 'denied') return false;
  }
  if (typeof handle.requestPermission === 'function') {
    return (await handle.requestPermission(descriptor)) === 'granted';
  }
  return true;
}

export async function writeTextToFileHandle(handle, content) {
  if (!handle?.createWritable) throw new TypeError('The selected file is not writable.');
  const writable = await handle.createWritable();
  try {
    await writable.write(content);
    await writable.close();
  } catch (error) {
    try {
      await writable.abort?.();
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
}

export async function exportTextFileWithPicker({
  createContent,
  description,
  download,
  extension,
  mimeType,
  pickerKey,
  showSaveFilePicker = globalThis.showSaveFilePicker?.bind(globalThis),
  suggestedName,
} = {}) {
  if (typeof createContent !== 'function' || typeof download !== 'function') {
    throw new Error('Export content and download callbacks are required.');
  }
  const suffix = String(extension || '').startsWith('.') ? String(extension) : `.${extension}`;
  const fileName = String(suggestedName || `Export${suffix}`);
  const downloadFallback = async () => {
    const content = await createContent();
    download(content, fileName, mimeType);
    return { status: 'saved', method: 'download', name: fileName, handle: null };
  };
  if (typeof showSaveFilePicker !== 'function') return downloadFallback();

  let handle;
  try {
    handle = await showSaveFilePicker({
      id: pickerKey || `paramagic-export-${suffix.slice(1)}`,
      suggestedName: fileName,
      types: [{
        description: description || `${suffix.slice(1).toUpperCase()} File`,
        accept: { [mimeType]: [suffix] },
      }],
    });
  } catch (error) {
    if (isFileSystemAccessCancellation(error)) return { status: 'cancelled' };
    if (isFileSystemAccessBlocked(error)) return downloadFallback();
    throw error;
  }

  const content = await createContent();
  try {
    await writeTextToFileHandle(handle, content);
  } catch (error) {
    if (isFileSystemAccessBlocked(error)) {
      download(content, fileName, mimeType);
      return { status: 'saved', method: 'download', name: fileName, handle: null };
    }
    throw error;
  }
  return { status: 'saved', method: 'file-system', name: handle.name || fileName, handle };
}

function normalizeSaveFormat(format) {
  const extension = String(format?.extension || '').trim();
  return {
    key: String(format?.key || '').trim().toLowerCase(),
    description: String(format?.description || '').trim(),
    extension: extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`,
    mimeType: String(format?.mimeType || 'application/octet-stream').trim(),
  };
}

function normalizedSaveFormats(formats = []) {
  const normalized = formats.map(normalizeSaveFormat)
    .filter(({ key, extension }) => key && extension !== '.');
  if (!normalized.length) throw new Error('At least one Save As format is required.');
  return normalized;
}

export function saveFormatForFileName(fileName, formats, defaultFormat) {
  const normalized = normalizedSaveFormats(formats);
  const lowerName = String(fileName || '').trim().toLowerCase();
  return normalized.find(({ extension }) => lowerName.endsWith(extension))
    || normalized.find(({ key }) => key === String(defaultFormat || '').toLowerCase())
    || normalized[0];
}

function saveAsFileName(baseName, format, formats) {
  const extensions = formats.map(({ extension }) => extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const withoutKnownExtension = String(baseName || '').trim()
    .replace(new RegExp(`(?:${extensions.join('|')})$`, 'i'), '')
    .trim();
  return `${withoutKnownExtension || 'Untitled Drawing'}${format.extension}`;
}

export async function saveFileAsWithPicker({
  formats,
  defaultFormat,
  suggestedBaseName = 'Untitled Drawing',
  pickerKey = 'paramagic-save-as',
  showSaveFilePicker = globalThis.showSaveFilePicker?.bind(globalThis),
  chooseFallbackTarget,
  createContent,
  download,
} = {}) {
  if (typeof createContent !== 'function' || typeof download !== 'function') {
    throw new Error('Save As content and download callbacks are required.');
  }
  const normalized = normalizedSaveFormats(formats);
  const initialFormat = saveFormatForFileName('', normalized, defaultFormat);
  const suggestedName = saveAsFileName(suggestedBaseName, initialFormat, normalized);

  const downloadFallback = async (target = null) => {
    const chosen = target || (typeof chooseFallbackTarget === 'function'
      ? await chooseFallbackTarget({
        suggestedBaseName,
        defaultFormat: initialFormat.key,
        formats: normalized.map((format) => ({ ...format })),
      })
      : { name: suggestedBaseName, format: initialFormat.key });
    if (!chosen) return { status: 'cancelled' };
    const format = normalized.find(({ key }) => key === String(chosen.format || '').toLowerCase()) || initialFormat;
    const name = saveAsFileName(chosen.name || suggestedBaseName, format, normalized);
    const content = await createContent(format.key, name);
    download(content, name, format.mimeType);
    return { status: 'saved', method: 'download', name, handle: null, format: format.key };
  };

  if (typeof showSaveFilePicker !== 'function') return downloadFallback();

  let handle;
  try {
    handle = await showSaveFilePicker({
      id: pickerKey,
      suggestedName,
      excludeAcceptAllOption: true,
      types: normalized.map((format) => ({
        description: format.description || `${format.key.toUpperCase()} File`,
        accept: { [format.mimeType]: [format.extension] },
      })),
    });
  } catch (error) {
    if (isFileSystemAccessCancellation(error)) return { status: 'cancelled' };
    if (isFileSystemAccessBlocked(error)) return downloadFallback();
    throw error;
  }

  const format = saveFormatForFileName(handle?.name, normalized, initialFormat.id);
  const name = handle?.name || saveAsFileName(suggestedBaseName, format, normalized);
  const content = await createContent(format.key, name);
  try {
    await writeTextToFileHandle(handle, content);
  } catch (error) {
    if (isFileSystemAccessBlocked(error)) {
      download(content, name, format.mimeType);
      return { status: 'saved', method: 'download', name, handle: null, format: format.key };
    }
    throw error;
  }
  return { status: 'saved', method: 'file-system', name, handle, format: format.key };
}

export function createDrawingFileController({
  getHandle,
  setHandle,
  showOpenFilePicker = globalThis.showOpenFilePicker?.bind(globalThis),
  showSaveFilePicker = globalThis.showSaveFilePicker?.bind(globalThis),
  normalizeName = (name) => String(name || '').trim(),
  openPickerOptions = () => ({}),
  pickerOptions = (name) => ({ suggestedName: name }),
  serialize,
  download,
  chooseFallbackName,
} = {}) {
  if (typeof getHandle !== 'function' || typeof setHandle !== 'function') {
    throw new Error('Drawing file handle accessors are required.');
  }
  if (typeof serialize !== 'function' || typeof download !== 'function') {
    throw new Error('Drawing serialization and download callbacks are required.');
  }

  const downloadDrawing = async (name, chooseName = false, clearHandle = false) => {
    const chosenName = chooseName && chooseFallbackName
      ? await chooseFallbackName(name)
      : name;
    const normalizedName = normalizeName(chosenName);
    if (!normalizedName) return { status: 'cancelled' };
    download(serialize(normalizedName), normalizedName);
    if (clearHandle) setHandle(null);
    return { status: 'saved', method: 'download', name: normalizedName, handle: null };
  };

  const saveAs = async (name) => {
    const normalizedName = normalizeName(name);
    if (typeof showSaveFilePicker !== 'function') return downloadDrawing(normalizedName, true, true);

    let handle;
    try {
      handle = await showSaveFilePicker(pickerOptions(normalizedName));
    } catch (error) {
      if (isFileSystemAccessCancellation(error)) return { status: 'cancelled' };
      if (isFileSystemAccessBlocked(error)) return downloadDrawing(normalizedName, true, true);
      throw error;
    }

    const handleName = normalizeName(handle?.name || normalizedName);
    try {
      await writeTextToFileHandle(handle, serialize(handleName));
    } catch (error) {
      if (isFileSystemAccessBlocked(error)) return downloadDrawing(handleName, false, true);
      throw error;
    }
    setHandle(handle);
    return { status: 'saved', method: 'file-system', name: handleName, handle };
  };

  const save = async (name) => {
    const handle = getHandle();
    if (!handle) return saveAs(name);
    const handleName = normalizeName(handle.name || name);
    try {
      if (!await ensureFileHandleWritePermission(handle)) return downloadDrawing(handleName);
      await writeTextToFileHandle(handle, serialize(handleName));
    } catch (error) {
      if (isFileSystemAccessBlocked(error)) return downloadDrawing(handleName);
      throw error;
    }
    return { status: 'saved', method: 'file-system', name: handleName, handle };
  };

  const open = async () => {
    if (typeof showOpenFilePicker !== 'function') return { status: 'fallback' };
    try {
      const [handle] = await showOpenFilePicker(openPickerOptions());
      if (!handle) return { status: 'cancelled' };
      return { status: 'opened', handle, file: await handle.getFile() };
    } catch (error) {
      if (isFileSystemAccessCancellation(error)) return { status: 'cancelled' };
      if (isFileSystemAccessBlocked(error)) return { status: 'fallback' };
      throw error;
    }
  };

  return { open, save, saveAs };
}
