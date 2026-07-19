import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { TaskStatus } from '@todograph/shared';
import { cn } from '@/lib/utils';
import { TaskStatusButton } from './TaskStatusButton';

export interface GroupDescendant {
  id: string;
  title: string;
  status: TaskStatus;
  description?: string;
  depth: number;
  width: number;
  height: number;
}

interface Props {
  title: string;
  descendants: GroupDescendant[];
  returnFocus: HTMLButtonElement | null;
  onToggleStatus: (id: string) => void;
  onClose: () => void;
}

function statusLabel(status: TaskStatus): string {
  if (status === 'done') return '已完成';
  if (status === 'doing') return '进行中';
  return '待处理';
}

export function GroupContentsDialog({ title, descendants, returnFocus, onToggleStatus, onClose }: Props) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    const appRoot = document.getElementById('root');
    const wasAppRootInert = appRoot?.inert ?? false;
    const previousOverflow = document.body.style.overflow;
    if (appRoot) appRoot.inert = true;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [
        ...dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (appRoot) appRoot.inert = wasAppRootInert;
      document.body.style.overflow = previousOverflow;
      returnFocus?.focus();
    };
  }, [onClose, returnFocus]);

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[85dvh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
      >
        <header className="flex items-center gap-3 border-b border-border px-4 py-3 sm:px-5 sm:py-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-base font-semibold">
              {title}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">内部 {descendants.length} 个节点</p>
          </div>
          <button
            type="button"
            ref={closeRef}
            aria-label="关闭"
            className="flex h-11 w-11 items-center justify-center rounded-xl transition-colors duration-200 hover:bg-foreground/5"
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </button>
        </header>
        <div className="touch-pan-y overflow-y-auto overscroll-contain p-4 sm:p-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {descendants.map((child) => (
              <article
                key={child.id}
                className="rounded-xl border border-border bg-background/60 p-3"
              >
                <div className="flex items-start gap-2.5">
                  <TaskStatusButton
                    status={child.status}
                    touchTarget
                    aria-label={`推进 ${child.title} 状态`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleStatus(child.id);
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <h3
                      className={cn(
                        'break-words text-sm font-medium',
                        child.status === 'done' && 'line-through text-muted-foreground',
                      )}
                    >
                      {child.title}
                    </h3>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {statusLabel(child.status)}
                      {child.depth > 1 ? ` · 第 ${child.depth} 层` : ''}
                    </p>
                    {child.description && (
                      <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">
                        {child.description}
                      </p>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
