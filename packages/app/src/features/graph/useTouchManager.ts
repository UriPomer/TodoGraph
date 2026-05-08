import { useEffect, useRef } from 'react';
import type { ReactFlowInstance } from '@xyflow/react';
import { LONG_PRESS_MS, LONG_PRESS_MOVE_PX } from './touchConfig';

interface UseTouchManagerOptions {
  containerRef: React.RefObject<HTMLDivElement | null>;
  rf: ReactFlowInstance | null;
  hasPendingCreate: () => boolean;
  onLongPressBlank: (flowX: number, flowY: number) => void;
  onCancelPendingCreate: () => void;
}

/**
 * 统一触控管理器。
 *
 * 通过原生 DOM 监听器（capture 阶段）管理空白处长按检测。
 * 不调用 preventDefault —— 单指平移/连线由 React Flow / CSS touch-action 处理。
 * 系统长按菜单由 CSS `touch-action: none` 阻止，不在此处暴力拦截。
 */
export function useTouchManager({
  containerRef,
  rf,
  hasPendingCreate,
  onLongPressBlank,
  onCancelPendingCreate,
}: UseTouchManagerOptions) {
  const rfRef = useRef(rf);
  rfRef.current = rf;
  const hasPendingCreateRef = useRef(hasPendingCreate);
  hasPendingCreateRef.current = hasPendingCreate;
  const onLongPressBlankRef = useRef(onLongPressBlank);
  onLongPressBlankRef.current = onLongPressBlank;
  const onCancelPendingCreateRef = useRef(onCancelPendingCreate);
  onCancelPendingCreateRef.current = onCancelPendingCreate;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let touchStart: { x: number; y: number; flowX: number; flowY: number } | null = null;
    let timer: number | null = null;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      touchStart = null;
    };

    const onTouchStart = (e: TouchEvent) => {
      // 多指 → 不干预
      if (e.touches.length !== 1) {
        clearTimer();
        return;
      }

      const touch = e.touches[0]!;
      const target = e.target as HTMLElement | null;

      // 点在 handle / node / 工具栏按钮 → 不干预
      if (target?.closest('.react-flow__node, .react-flow__handle, button, .react-flow__controls')) {
        return;
      }

      const rf = rfRef.current;
      if (!rf) return;

      const flow = rf.screenToFlowPosition({ x: touch.clientX, y: touch.clientY });
      touchStart = {
        x: touch.clientX,
        y: touch.clientY,
        flowX: flow.x - 90,
        flowY: flow.y - 28,
      };

      timer = window.setTimeout(() => {
        timer = null;
        const start = touchStart;
        if (!start) return;
        touchStart = null;

        if (hasPendingCreateRef.current()) {
          onCancelPendingCreateRef.current();
        } else {
          onLongPressBlankRef.current(start.flowX, start.flowY);
        }
      }, LONG_PRESS_MS);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!touchStart) return;
      const touch = e.touches[0];
      if (!touch) return;
      if (
        Math.abs(touch.clientX - touchStart.x) > LONG_PRESS_MOVE_PX ||
        Math.abs(touch.clientY - touchStart.y) > LONG_PRESS_MOVE_PX
      ) {
        clearTimer();
      }
    };

    const onTouchEnd = () => {
      clearTimer();
    };

    // capture 阶段：在 React Flow 之前拦截，但不 preventDefault
    el.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    el.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
    el.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });

    return () => {
      el.removeEventListener('touchstart', onTouchStart, { capture: true });
      el.removeEventListener('touchmove', onTouchMove, { capture: true });
      el.removeEventListener('touchend', onTouchEnd, { capture: true });
      clearTimer();
    };
  }, [containerRef]);
}
