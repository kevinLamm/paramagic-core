let expressionLookupSequence = 0;

const operatorBoundary = /[\n\r()+\-*/^!,<>=&|]/;

export function normalizeExpressionLookupOptions(entries = []) {
  const options = [];
  const seen = new Set();
  entries.forEach((entry) => {
    const value = String(typeof entry === 'string' ? entry : entry?.name ?? entry?.value ?? '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    options.push({
      value,
      label: String(typeof entry === 'string' ? entry : entry?.label || value),
    });
  });
  return options;
}

export function expressionLookupRange(value, selectionStart, selectionEnd = selectionStart) {
  const source = String(value ?? '');
  const start = Math.max(0, Math.min(source.length, Number(selectionStart) || 0));
  const end = Math.max(start, Math.min(source.length, Number(selectionEnd) || start));
  if (end > start) return { start, end, query: source.slice(start, end) };

  let rangeStart = start;
  while (rangeStart > 0 && !operatorBoundary.test(source[rangeStart - 1])) rangeStart -= 1;
  while (rangeStart < start && /\s/.test(source[rangeStart])) rangeStart += 1;
  return { start: rangeStart, end, query: source.slice(rangeStart, start) };
}

export function expressionLookupMatches(entries, query = '', limit = 50) {
  const options = normalizeExpressionLookupOptions(entries);
  const needle = String(query).trim().toLocaleLowerCase();
  const matches = needle
    ? options.filter(({ value, label }) => (
      value.toLocaleLowerCase().startsWith(needle)
      || label.toLocaleLowerCase().startsWith(needle)
    ))
    : options;
  return matches.slice(0, Math.max(1, Number(limit) || 50));
}

export function insertExpressionLookupValue(value, selectionStart, selectionEnd, replacement) {
  const source = String(value ?? '');
  const range = expressionLookupRange(source, selectionStart, selectionEnd);
  const inserted = String(replacement ?? '');
  const nextValue = `${source.slice(0, range.start)}${inserted}${source.slice(range.end)}`;
  const caret = range.start + inserted.length;
  return { value: nextValue, selectionStart: caret, selectionEnd: caret };
}

export function expressionBoxLookupMarkup({
  id = `expressionBoxLookup${++expressionLookupSequence}`,
} = {}) {
  return `<ul class="expression-box-lookup-list" id="${id}" data-expression-lookup-list role="listbox" hidden></ul>`;
}

export function expressionLookupKeyAction({
  key,
  shiftKey = false,
  listOpen = false,
  activeIndex = -1,
} = {}) {
  if (key === 'ArrowDown') return 'next';
  if (key === 'ArrowUp') return 'previous';
  if ((key === 'Enter' || key === 'Tab') && !shiftKey && listOpen && activeIndex >= 0) return 'choose';
  if ((key === 'Enter' || key === 'Tab') && listOpen) return 'close';
  if (key === 'Escape' && listOpen) return 'dismiss';
  return null;
}

export function replaceExpressionLookupOptions(target, entries = []) {
  const options = normalizeExpressionLookupOptions(entries);
  if (!target) return options;
  const documentRef = target.ownerDocument || document;
  target.replaceChildren(...options.map(({ value, label }) => {
    const option = documentRef.createElement('option');
    option.value = value;
    option.label = label;
    return option;
  }));
  return options;
}

export function createExpressionBoxLookup({
  field,
  listbox,
  maxResults = 50,
  getOptions,
  onInsert = () => {},
} = {}) {
  if (!field || !listbox) {
    return {
      close() {},
      destroy() {},
      open() { return false; },
      setOptions() {},
    };
  }

  let options = [];
  let visibleOptions = [];
  let activeIndex = -1;
  let showingAll = false;

  const documentRef = listbox.ownerDocument || document;
  const ownsListbox = listbox.parentElement !== documentRef.body;
  if (ownsListbox) documentRef.body.append(listbox);

  const positionListbox = () => {
    const bounds = field.getBoundingClientRect();
    const viewportWidth = documentRef.defaultView?.innerWidth || 0;
    const viewportHeight = documentRef.defaultView?.innerHeight || 0;
    const spaceBelow = viewportHeight - bounds.bottom;
    const left = Math.max(4, Math.min(bounds.left, viewportWidth - 4));
    const availableWidth = Math.max(0, viewportWidth - left - 4);
    listbox.style.left = `${left}px`;
    listbox.style.width = 'max-content';
    listbox.style.minWidth = `${Math.min(bounds.width, availableWidth)}px`;
    listbox.style.maxWidth = `${availableWidth}px`;
    const below = spaceBelow >= 250 || bounds.top < spaceBelow;
    listbox.style.maxHeight = `${Math.max(0, Math.min(240, (below ? spaceBelow : bounds.top) - 8))}px`;
    if (below) {
      listbox.style.top = `${bounds.bottom + 1}px`;
      listbox.style.bottom = '';
    } else {
      listbox.style.top = '';
      listbox.style.bottom = `${viewportHeight - bounds.top + 1}px`;
    }
  };

  const expanded = (value) => {
    field.setAttribute('aria-expanded', String(value));
  };

  const close = () => {
    listbox.hidden = true;
    listbox.replaceChildren();
    visibleOptions = [];
    activeIndex = -1;
    showingAll = false;
    field.removeAttribute('aria-activedescendant');
    expanded(false);
  };

  const setActiveIndex = (index) => {
    if (!visibleOptions.length) return;
    activeIndex = (index + visibleOptions.length) % visibleOptions.length;
    [...listbox.children].forEach((node, optionIndex) => {
      const active = optionIndex === activeIndex;
      node.classList.toggle('active', active);
      node.setAttribute('aria-selected', String(active));
      if (active) {
        field.setAttribute('aria-activedescendant', node.id);
        node.scrollIntoView?.({ block: 'nearest' });
      }
    });
  };

  const choose = (index = activeIndex) => {
    const option = visibleOptions[index];
    if (!option) return false;
    const insertion = insertExpressionLookupValue(
      field.value,
      field.selectionStart,
      field.selectionEnd,
      option.value,
    );
    field.value = insertion.value;
    field.setSelectionRange?.(insertion.selectionStart, insertion.selectionEnd);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    close();
    field.focus();
    onInsert(option);
    return true;
  };

  const render = ({ all = false } = {}) => {
    if (field.disabled || field.readOnly) return false;
    if (getOptions) options = normalizeExpressionLookupOptions(getOptions());
    activeIndex = -1;
    field.removeAttribute('aria-activedescendant');
    showingAll = all;
    const range = expressionLookupRange(field.value, field.selectionStart, field.selectionEnd);
    visibleOptions = expressionLookupMatches(options, all ? '' : range.query, maxResults);
    if (!visibleOptions.length) {
      close();
      return false;
    }
    const baseId = listbox.id || `expressionBoxLookup${++expressionLookupSequence}`;
    if (!listbox.id) listbox.id = baseId;
    listbox.replaceChildren(...visibleOptions.map(({ value, label }, index) => {
      const option = documentRef.createElement('li');
      option.className = 'expression-box-lookup-option';
      option.id = `${baseId}Option${index}`;
      option.dataset.expressionLookupIndex = String(index);
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.tabIndex = -1;
      const content = documentRef.createElement('span');
      content.className = 'expression-box-lookup-content';
      const valueNode = documentRef.createElement('span');
      valueNode.className = 'expression-box-lookup-title';
      valueNode.textContent = value;
      content.append(valueNode);
      if (label !== value) {
        const labelNode = documentRef.createElement('span');
        labelNode.className = 'expression-box-lookup-label';
        labelNode.textContent = label;
        content.append(labelNode);
      }
      option.append(content);
      return option;
    }));
    positionListbox();
    listbox.hidden = false;
    expanded(true);
    return true;
  };

  const open = ({ all = true } = {}) => render({ all });
  const setOptions = (entries = []) => {
    options = normalizeExpressionLookupOptions(entries);
    if (!listbox.hidden) render({ all: showingAll });
  };

  const handleInput = () => {
    const range = expressionLookupRange(field.value, field.selectionStart, field.selectionEnd);
    if (!range.query.trim()) {
      close();
      return;
    }
    render({ all: false });
  };
  const handleKeyDown = (event) => {
    const action = expressionLookupKeyAction({
      key: event.key,
      shiftKey: event.shiftKey,
      listOpen: !listbox.hidden,
      activeIndex,
    });
    if (action === 'next' || action === 'previous') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (listbox.hidden) {
        if (open({ all: false }) || open({ all: true })) {
          setActiveIndex(action === 'next' ? 0 : visibleOptions.length - 1);
        }
      } else if (activeIndex < 0) {
        setActiveIndex(action === 'next' ? 0 : visibleOptions.length - 1);
      } else {
        setActiveIndex(activeIndex + (action === 'next' ? 1 : -1));
      }
      return;
    }
    if (action === 'choose') {
      event.preventDefault();
      event.stopImmediatePropagation();
      choose();
      return;
    }
    if (action === 'close') {
      close();
      return;
    }
    if (action === 'dismiss') {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    }
  };
  const handleListPointerDown = (event) => {
    const option = event.target.closest?.('[data-expression-lookup-index]');
    if (!option) return;
    event.preventDefault();
    event.stopPropagation();
    choose(Number(option.dataset.expressionLookupIndex));
  };
  const handleBlur = () => queueMicrotask(() => {
    const active = listbox.ownerDocument?.activeElement;
    if (active !== field && !listbox.contains(active)) close();
  });

  field.setAttribute('aria-autocomplete', 'list');
  field.setAttribute('aria-controls', listbox.id);
  field.setAttribute('aria-expanded', 'false');
  field.addEventListener('input', handleInput);
  // Choose a suggestion before tool-owned Enter handlers can commit or blur.
  field.addEventListener('keydown', handleKeyDown, true);
  field.addEventListener('blur', handleBlur);
  const handleClick = () => open({ all: !field.value.trim() });
  field.addEventListener('click', handleClick);
  const handleViewportChange = (event) => {
    if (listbox.hidden || listbox.contains(event.target)) return;
    close();
  };
  documentRef.addEventListener('scroll', handleViewportChange, true);
  documentRef.defaultView?.addEventListener('resize', handleViewportChange);
  listbox.addEventListener('pointerdown', handleListPointerDown);

  return {
    close,
    destroy() {
      close();
      field.removeEventListener('input', handleInput);
      field.removeEventListener('keydown', handleKeyDown, true);
      field.removeEventListener('blur', handleBlur);
      field.removeEventListener('click', handleClick);
      documentRef.removeEventListener('scroll', handleViewportChange, true);
      documentRef.defaultView?.removeEventListener('resize', handleViewportChange);
      listbox.removeEventListener('pointerdown', handleListPointerDown);
      if (ownsListbox) listbox.remove();
    },
    open,
    setOptions,
  };
}

// Inputs retain their tool-owned datalists as live option sources, while both
// single-line and multiline editors render through the same popup component.
export function bindExpressionBoxInputs(root) {
  const documentRef = root.ownerDocument || root;
  let activeField = null;
  let lookup = null;
  const release = () => {
    lookup?.destroy();
    activeField = null;
    lookup = null;
  };
  const handleFocus = (event) => {
    const field = event.target.closest?.('input[data-expression-source]');
    if (field === activeField) return;
    release();
    if (!field || field.disabled || field.readOnly) return;
    activeField = field;
    const listbox = documentRef.createElement('ul');
    listbox.className = 'expression-box-lookup-list';
    listbox.id = `expressionBoxLookup${++expressionLookupSequence}`;
    listbox.dataset.expressionLookupList = '';
    listbox.setAttribute('role', 'listbox');
    listbox.hidden = true;
    lookup = createExpressionBoxLookup({
      field,
      listbox,
      getOptions: () => [...(documentRef.getElementById(field.dataset.expressionSource)?.options || [])]
        .filter((option) => !option.disabled)
        .map((option) => ({ value: option.value, label: option.label })),
      onInsert: () => field.dispatchEvent(new Event('change', { bubbles: true })),
    });
  };
  const handleFocusOut = () => queueMicrotask(() => {
    if (activeField && documentRef.activeElement !== activeField) release();
  });
  root.addEventListener('focusin', handleFocus);
  root.addEventListener('focusout', handleFocusOut);
  return () => {
    release();
    root.removeEventListener('focusin', handleFocus);
    root.removeEventListener('focusout', handleFocusOut);
  };
}
