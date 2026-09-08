import { stackFrameFor } from './StackCoordinates.js';

export function createStackViewTool({ button, canvas }) {
  let pressed = false;
  let activeStackId;

  const stackRotation = (state) => {
    if (!state?.activeStackId) return 0;
    const rotation = Number(stackFrameFor(state, state.activeStackId).rotation) || 0;
    return Math.abs(Math.atan2(Math.sin(rotation), Math.cos(rotation))) > 1e-9 ? rotation : 0;
  };
  const setPressed = (value, state = canvas.getStackState()) => {
    const rotation = stackRotation(state);
    pressed = Boolean(value && state?.activeStackId && rotation);
    button.setAttribute('aria-pressed', String(pressed));
    canvas.rotateView(pressed ? -rotation : 0);
  };
  const toggle = () => setPressed(!pressed);
  const syncStack = (state, change = {}) => {
    const nextActiveStackId = state?.activeStackId || null;
    const activated = nextActiveStackId !== activeStackId
      || ['activation', 'restore', 'clear'].includes(change.reason);
    activeStackId = nextActiveStackId;
    if (!nextActiveStackId) setPressed(false, state);
    else if (activated) setPressed(Boolean(stackRotation(state)), state);
  };
  button.addEventListener('click', toggle);
  const unsubscribe = canvas.onStackChange(syncStack);
  return { dispose() { button.removeEventListener('click', toggle); unsubscribe?.(); } };
}
