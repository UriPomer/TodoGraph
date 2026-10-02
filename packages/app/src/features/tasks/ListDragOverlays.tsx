import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ListDropIntent } from './listDrag';

const LIST_MOVE_ANIMATION_MS = 220;

function findTaskRow(root: ParentNode, taskId: string) {
  return root.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"]`);
}

export function prepareTaskMoveAnimation(root: ParentNode | null, taskId: string) {
  if (!root || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};
  const before = findTaskRow(root, taskId)?.getBoundingClientRect();
  if (!before) return () => {};

  return () => requestAnimationFrame(() => {
    const row = findTaskRow(root, taskId);
    if (!row) return;
    const current = row.getBoundingClientRect();
    const deltaX = before.left - current.left;
    const deltaY = before.top - current.top;
    if (deltaX === 0 && deltaY === 0) return;
    row.animate(
      [
        { transform: `translate(${deltaX}px, ${deltaY}px)` },
        { transform: 'translate(0, 0)' },
      ],
      { duration: LIST_MOVE_ANIMATION_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  });
}

type IndicatorIntent = Extract<ListDropIntent, { kind: 'reorder' | 'reparent-reorder' | 'nest' }>;

export function DropIndicator({ intent }: { intent: IndicatorIntent }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const targetId = intent.kind === 'nest' ? intent.targetId : intent.anchorId;
    const target = findTaskRow(document, targetId);
    const indicator = ref.current;
    if (!indicator) return;
    if (!target) {
      indicator.style.display = 'none';
      return;
    }
    const rect = target.getBoundingClientRect();
    const nested = intent.kind === 'nest';
    const inset = nested ? 2 : 8;
    indicator.style.left = `${rect.left + inset}px`;
    indicator.style.top = `${nested ? rect.top + 2 : intent.position === 'before' ? rect.top - 2 : rect.bottom - 2}px`;
    indicator.style.width = `${Math.max(0, rect.width - inset * 2)}px`;
    indicator.style.height = nested ? `${Math.max(0, rect.height - 4)}px` : '4px';
    indicator.style.display = '';
  });

  return createPortal(
    <div
      ref={ref}
      data-list-drop-indicator={intent.kind}
      className={intent.kind === 'nest'
        ? 'fixed pointer-events-none z-[60] rounded-xl ring-2 ring-inset ring-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.12)] shadow-[0_0_12px_hsl(var(--primary)/0.45)]'
        : 'fixed pointer-events-none z-[60] rounded-full bg-[hsl(var(--primary))] shadow-[0_0_10px_hsl(var(--primary)/0.8)]'}
      style={{ display: 'none' }}
    />,
    document.body,
  );
}

export function UnparentIndicator({ taskId }: { taskId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const indicator = ref.current;
      if (indicator) {
        const rect = findTaskRow(document, taskId)?.getBoundingClientRect();
        if (rect) Object.assign(indicator.style, { left: `${rect.left + 12}px`, top: `${rect.top + 2}px`, height: `${rect.height - 4}px`, display: '' });
        else indicator.style.display = 'none';
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [taskId]);

  return (
    <div
      ref={ref}
      className="fixed pointer-events-none z-[60] w-[3px] rounded-sm bg-[hsl(var(--primary))] shadow-[0_0_8px_hsl(var(--primary)/0.6)]"
      style={{ display: 'none', animation: 'unparentPulse 0.9s ease-in-out infinite' }}
    />
  );
}
