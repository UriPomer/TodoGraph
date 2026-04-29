import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  /** 左侧面板 */
  left: ReactNode;
  /** 右侧面板 */
  right: ReactNode;
  /** 初始左栏宽度（px） */
  defaultLeftWidth?: number;
  /** 左栏最小宽度（px） */
  minLeft?: number;
  /** 左栏最大宽度（px） */
  maxLeft?: number;
  /** localStorage 持久化的 key；不传则不持久化 */
  storageKey?: string;
  className?: string;
}

/**
 * 可拖动的左右分栏容器。
 * - 左栏固定宽度（可拖拽调整）
 * - 右栏自适应剩余空间（flex-1）
 * - 竖向的细拖柄在两栏之间：hover 变色，按住拖动
 * - 拖动期间给 <body> 加全局 col-resize 光标 + 禁用文字选择
 */
export function SplitPane({
  left,
  right,
  defaultLeftWidth = 360,
  minLeft = 240,
  maxLeft = 720,
  storageKey,
  className,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const [leftWidth, setLeftWidth] = useState<number>(() => {
    if (typeof window !== 'undefined' && storageKey) {
      const v = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(v) && v >= minLeft && v <= maxLeft) return v;
    }
    return defaultLeftWidth;
  });

  // 持久化
  useEffect(() => {
    if (storageKey) localStorage.setItem(storageKey, String(leftWidth));
  }, [leftWidth, storageKey]);

  // 拖动逻辑
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;

    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();

    // 全局 cursor + 禁选
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const next = ev.clientX - rect.left;
      setLeftWidth(Math.max(minLeft, Math.min(maxLeft, next)));
    };
    const onUp = () => {
      draggingRef.current = false;
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [minLeft, maxLeft]);

  // 双击拖柄重置为默认宽度
  const onDoubleClick = useCallback(() => {
    setLeftWidth(defaultLeftWidth);
  }, [defaultLeftWidth]);

  return (
    <div ref={containerRef} className={cn('flex h-full min-h-0 w-full', className)}>
      <div style={{ width: leftWidth }} className="shrink-0 min-w-0">
        {left}
      </div>

      {/* 拖柄：1px 可见分隔线 + 更宽的不可见命中区域（便于鼠标抓取） */}
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
        title="拖动调整左右宽度（双击重置）"
        className={cn(
          'relative w-px shrink-0 bg-border cursor-col-resize select-none',
          'transition-colors duration-150',
          'hover:bg-[hsl(var(--primary))] active:bg-[hsl(var(--primary))]',
        )}
      >
        {/* 透明增大可点击区域（±3px） */}
        <span className="absolute inset-y-0 -left-[3px] -right-[3px]" />
      </div>

      <div className="flex-1 min-w-0">{right}</div>
    </div>
  );
}
