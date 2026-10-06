import { flushSync } from 'react-dom';

type Direction = 'switch' | 'push' | 'pop';
let sequence = 0;
let active: { skipTransition: () => void } | undefined;

export function cancelWorkspaceTransition() {
  sequence += 1;
  active?.skipTransition();
  active = undefined;
  if (typeof document !== 'undefined') delete document.documentElement.dataset.workspaceMotion;
}

// Navigation owns the state update; motion only snapshots its visual boundary.
// No second live page is mounted, so outgoing forms cannot keep running effects.
export function transitionWorkspace(update: () => void, direction: Direction = 'switch') {
  cancelWorkspaceTransition();
  const current = sequence;
  const apply = () => { if (current === sequence) flushSync(update); };
  if (typeof document === 'undefined' || !window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    apply();
    return;
  }
  const root = document.documentElement;
  root.dataset.workspaceMotion = direction;
  const cleanup = () => {
    if (current !== sequence) return;
    delete root.dataset.workspaceMotion;
    active = undefined;
  };
  if (document.startViewTransition) {
    const transition = document.startViewTransition(apply);
    active = transition;
    void transition.finished.then(cleanup, cleanup);
  } else {
    apply();
    const screen = document.querySelector<HTMLElement>('[data-workspace-screen]');
    const offset = direction === 'pop' ? -18 : direction === 'push' ? 18 : 6;
    const animation = screen?.animate([{ opacity: 0.92, transform: `translateX(${offset}px)` }, { opacity: 1, transform: 'translateX(0)' }], { duration: 180, easing: 'cubic-bezier(.22,1,.36,1)' });
    if (!animation) { cleanup(); return; }
    active = { skipTransition: () => animation.cancel() };
    void animation.finished.then(cleanup, cleanup);
  }
}
