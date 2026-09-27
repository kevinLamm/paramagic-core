import { createStackTreeIndex } from './StackArchitecture.js';

export function showStackDeletionDialog({ title, message, choices, signal }) {
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    const previousFocus = document.activeElement;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop stack-delete-backdrop';
    const dialog = document.createElement('div');
    dialog.className = 'modal stack-delete-modal';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'stackDeleteTitle');
    dialog.setAttribute('aria-describedby', 'stackDeleteMessage');
    const heading = document.createElement('h2'); heading.id = 'stackDeleteTitle'; heading.textContent = title;
    const description = document.createElement('p'); description.id = 'stackDeleteMessage'; description.textContent = message;
    const actions = document.createElement('div'); actions.className = 'stack-delete-actions';
    let finished = false;
    const finish = value => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', abort);
      backdrop.remove();
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve(value);
    };
    const abort = () => finish(null);
    for (const choice of [{ value: null, label: 'Cancel' }, ...choices]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = choice.label;
      if (choice.destructive) button.className = 'destructive';
      button.addEventListener('click', () => finish(choice.value)); actions.append(button);
    }
    backdrop.addEventListener('pointerdown', event => { if (event.target === backdrop) finish(null); });
    backdrop.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); finish(null); }
      if (event.key === 'Tab') {
        const buttons = [...actions.querySelectorAll('button')];
        const index = buttons.indexOf(document.activeElement);
        event.preventDefault(); buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
      }
    });
    dialog.append(heading, description, actions); backdrop.append(dialog); document.body.append(backdrop);
    signal?.addEventListener('abort', abort, { once: true });
    actions.querySelector('button').focus();
  });
}

export async function requestStackDeletion({ stackId, getStackState, removeStack, choose = showStackDeletionDialog, signal }) {
  const index = createStackTreeIndex(getStackState());
  const target = index.byId.get(stackId);
  if (!target?.removable || signal?.aborted) return false;
  let children = 'delete';
  if (index.children(stackId).length) {
    const destination = index.parent(stackId)?.name;
    children = await choose({
      title: `Child Stacks in “${target.name}”`,
      message: `Delete all child Stacks and their objects, or move the child Stacks ${destination ? `into “${destination}”` : 'to the drawing’s top level'} before deleting “${target.name}”? Moving keeps each child’s geometry and internal constraints together.`,
      choices: [{ value: 'move', label: 'Move children out' }, { value: 'delete', label: 'Delete children', destructive: true }], signal,
    });
  }
  if (!['move', 'delete'].includes(children) || signal?.aborted) return false;
  return removeStack(stackId, { children });
}
