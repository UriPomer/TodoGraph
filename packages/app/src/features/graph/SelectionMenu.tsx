import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

export interface SelectionMenuAction {
  label: string;
  hint?: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface Props {
  x: number;
  y: number;
  actions: SelectionMenuAction[];
  onClose: () => void;
}

/**
 * 框选结束后弹出的上下文操作菜单（UE Blueprint 风格）。
 * - 屏幕坐标定位（相对于 GraphView 容器的 bounding rect）；
 * - 点击外部 / ESC 自动关闭；
 * - 内置若干语义化动作（归组 / 解除分组 / 删除）。
 */
export function SelectionMenu({ x, y, actions, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 捕获阶段监听：确保在 React Flow 内部事件处理之前拦截
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // 下一个 tick 再注册，避免首次 mouseup 就被当成外部点击
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', onDocClick, true); // capture phase
    }, 0);
    document.addEventListener('keydown', onKey, true); // capture phase for consistency
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', onDocClick, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  return (
    <>
      {/* 背景遮罩：兜底拦截所有落在菜单外的点击 */}
      <div className="fixed inset-0 z-[19]" onClick={onClose} aria-hidden="true" />
      <div
      ref={ref}
      className="absolute z-20 min-w-[180px] rounded-lg border border-border bg-card p-1 shadow-lg backdrop-blur"
      style={{ left: x, top: y }}
    >
      {actions.map((a, i) => (
        <button
          key={i}
          disabled={a.disabled}
          onClick={() => {
            if (a.disabled) return;
            a.onClick();
            onClose();
          }}
          className={cn(
            'flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-xs',
            'hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed',
            a.danger && 'text-destructive hover:bg-destructive/10',
          )}
        >
          <span>{a.label}</span>
          {a.hint && <span className="text-[10px] text-muted-foreground/70">{a.hint}</span>}
        </button>
      ))}
    </div>
    </>
  );
}
