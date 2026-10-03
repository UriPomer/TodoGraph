import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { Task } from '@todograph/shared';
import { toast } from '@/components/ui/toaster-store';
import { useTaskStore } from '@/stores/useTaskStore';
import { LIST_DOUBLE_TAP_MS, LIST_LONG_PRESS_MS, LIST_SWIPE_COMMIT_PX, LIST_SWIPE_START_PX, LIST_TAP_SLOP_PX } from './gesturePolicy';

export interface TaskDragPoint {
  pointerId: number;
  clientX: number;
  clientY: number;
}

export interface TaskDragStart extends TaskDragPoint {
  pointerType: string;
  sourceElement: HTMLElement;
  activateImmediately: boolean;
}

interface Options {
  task: Task;
  rowRef: RefObject<HTMLLIElement>;
  beginTitleEditing: (element: HTMLElement, clientX: number, clientY: number) => void;
  toggleStatus: (taskId: string) => boolean;
  completeTask: (taskId: string) => boolean;
  deleteTask: (taskId: string) => void;
  onDragStart?: (event: TaskDragStart, task: Task) => void;
  onDragMove?: (event: TaskDragPoint) => void;
  onDragEnd?: (pointerId: number) => void;
  onDragCancel?: (pointerId: number) => void;
}

type MobileGesture =
  | { kind: 'idle' }
  | { kind: 'pending'; touchId: number; startX: number; startY: number; lastX: number; lastY: number; titleElement: HTMLElement | null }
  | { kind: 'scrolling'; touchId: number }
  | { kind: 'swiping'; touchId: number; startX: number; offset: number }
  | { kind: 'dragging'; touchId: number };

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function useTaskItemGestures(options: Options) {
  const { rowRef } = options;
  const swipeLayerRef = useRef<HTMLDivElement>(null);
  const progressHintRef = useRef<HTMLDivElement>(null);
  const deleteHintRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef(options);
  actionsRef.current = options;

  useBrowserLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    let gesture: MobileGesture = { kind: 'idle' };
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let lastTitleTap: number | null = null;
    let terminalListeners: AbortController | null = null;
    const cancelLongPress = () => {
      if (longPressTimer) clearTimeout(longPressTimer);
      longPressTimer = null;
    };
    const cancelSwipeDOM = () => {
      const layer = swipeLayerRef.current;
      if (layer) Object.assign(layer.style, { transition: 'transform 0.2s ease-out', transform: 'translateX(0px)' });
      for (const hint of [progressHintRef.current, deleteHintRef.current]) {
        if (!hint) continue;
        hint.style.opacity = '0';
        hint.dataset.active = 'false';
        hint.dataset.armed = 'false';
      }
    };
    const renderSwipe = (dx: number) => {
      const magnitude = Math.abs(dx);
      const resisted = magnitude > 88 ? 88 + (magnitude - 88) * 0.3 : magnitude;
      const offset = Math.sign(dx) * resisted;
      if (swipeLayerRef.current) swipeLayerRef.current.style.transform = `translateX(${offset}px)`;
      const armed = resisted >= LIST_SWIPE_COMMIT_PX;
      const opacity = Math.min(1, Math.max(0, (resisted - LIST_SWIPE_START_PX) / 44));
      for (const [hint, visible] of [[progressHintRef.current, dx > 0 && actionsRef.current.task.status !== 'done'], [deleteHintRef.current, dx < 0]] as const) {
        if (!hint) continue;
        hint.style.opacity = String(visible ? opacity : 0);
        hint.dataset.active = String(visible);
        hint.dataset.armed = String(armed && visible);
      }
      return offset;
    };
    const finishSwipe = (offset: number) => {
      cancelSwipeDOM();
      const { task, toggleStatus, completeTask, deleteTask } = actionsRef.current;
      if (offset >= LIST_SWIPE_COMMIT_PX) {
        if (task.status === 'done') return;
        const starting = task.status === 'todo';
        if (starting ? toggleStatus(task.id) : completeTask(task.id)) {
          toast.action(starting ? '已开始' : '已完成', '撤销', () => useTaskStore.getState().undo(), task.title);
        }
        else toast.info('无法完成', '该任务下还有未完成的子任务');
      } else if (offset <= -LIST_SWIPE_COMMIT_PX) {
        deleteTask(task.id);
        toast.action('已删除', '撤销', () => useTaskStore.getState().undo(), task.title);
      }
    };
    const resetGesture = () => {
      cancelLongPress();
      row.removeAttribute('data-pressed');
      gesture = { kind: 'idle' };
      terminalListeners?.abort();
      terminalListeners = null;
    };
    const cancelGesture = () => {
      if (gesture.kind === 'dragging') actionsRef.current.onDragCancel?.(gesture.touchId);
      lastTitleTap = null;
      cancelSwipeDOM();
      resetGesture();
    };
    const onVisibilityChange = () => { if (document.hidden) cancelGesture(); };
    const onAdditionalTouch = (event: TouchEvent) => { if (event.touches.length > 1) cancelGesture(); };
    const touchById = (touches: TouchList, touchId: number) =>
      Array.from(touches).find((touch) => touch.identifier === touchId);
    const onTouchEnd = (event: TouchEvent) => {
      const current = gesture;
      if (current.kind === 'idle' || !touchById(event.changedTouches, current.touchId)) return;
      cancelLongPress();
      if (current.kind === 'dragging') {
        if (event.cancelable) event.preventDefault();
        actionsRef.current.onDragEnd?.(current.touchId);
      } else if (current.kind === 'swiping') {
        finishSwipe(current.offset);
      } else if (current.kind === 'pending' && current.titleElement
        && Math.hypot(current.lastX - current.startX, current.lastY - current.startY) <= LIST_TAP_SLOP_PX) {
        const now = Date.now();
        if (lastTitleTap !== null && now - lastTitleTap <= LIST_DOUBLE_TAP_MS) {
          lastTitleTap = null;
          actionsRef.current.beginTitleEditing(current.titleElement, current.lastX, current.lastY);
        } else {
          lastTitleTap = now;
        }
      }
      resetGesture();
    };
    const onTouchCancel = (event: TouchEvent) => {
      if (gesture.kind !== 'idle' && touchById(event.changedTouches, gesture.touchId)) cancelGesture();
    };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return cancelGesture();
      const target = event.target as HTMLElement;
      if (target.closest('button, input, textarea, a, [data-task-description-view]')) return;
      const touch = event.touches[0]!;
      gesture = {
        kind: 'pending', touchId: touch.identifier,
        startX: touch.clientX, startY: touch.clientY, lastX: touch.clientX, lastY: touch.clientY,
        titleElement: target.closest('[data-task-title]'),
      };
      row.dataset.pressed = 'true';
      terminalListeners?.abort();
      terminalListeners = new AbortController();
      const capture = { capture: true, signal: terminalListeners.signal };
      window.addEventListener('touchend', onTouchEnd, { ...capture, passive: false });
      window.addEventListener('touchcancel', onTouchCancel, capture);
      window.addEventListener('touchstart', onAdditionalTouch, { ...capture, passive: true });
      window.addEventListener('blur', cancelGesture, capture);
      window.addEventListener('pagehide', cancelGesture, capture);
      document.addEventListener('visibilitychange', onVisibilityChange, capture);
      if (!actionsRef.current.onDragStart) return;
      longPressTimer = setTimeout(() => {
        if (gesture.kind !== 'pending' || gesture.touchId !== touch.identifier) return;
        const current = gesture;
        longPressTimer = null;
        row.removeAttribute('data-pressed');
        cancelSwipeDOM();
        gesture = { kind: 'dragging', touchId: current.touchId };
        actionsRef.current.onDragStart?.({
          pointerId: current.touchId, pointerType: 'touch',
          clientX: current.lastX, clientY: current.lastY, sourceElement: row, activateImmediately: true,
        }, actionsRef.current.task);
      }, LIST_LONG_PRESS_MS);
    };
    const onTouchMove = (event: TouchEvent) => {
      const current = gesture;
      if (current.kind === 'idle') return;
      const touch = touchById(event.touches, current.touchId);
      if (!touch) return;
      if (current.kind === 'dragging') {
        event.preventDefault();
        actionsRef.current.onDragMove?.({ pointerId: current.touchId, clientX: touch.clientX, clientY: touch.clientY });
        return;
      }
      if (current.kind === 'swiping') {
        event.preventDefault();
        gesture = { ...current, offset: renderSwipe(touch.clientX - current.startX) };
        return;
      }
      if (current.kind === 'scrolling') return;
      const dx = touch.clientX - current.startX;
      const dy = touch.clientY - current.startY;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      if (Math.hypot(dx, dy) > LIST_TAP_SLOP_PX) {
        row.removeAttribute('data-pressed');
        cancelLongPress();
        lastTitleTap = null;
      }
      if (absX >= LIST_SWIPE_START_PX && absX > absY * 1.1) {
        if (swipeLayerRef.current) swipeLayerRef.current.style.transition = 'none';
        gesture = { kind: 'swiping', touchId: current.touchId, startX: current.startX, offset: renderSwipe(dx) };
        event.preventDefault();
        return;
      }
      if (absY >= LIST_SWIPE_START_PX && absY > absX * 1.1) {
        gesture = { kind: 'scrolling', touchId: current.touchId };
        return;
      }
      gesture = { ...current, lastX: touch.clientX, lastY: touch.clientY };
    };
    row.addEventListener('touchstart', onTouchStart, { passive: true });
    row.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      cancelGesture();
      row.removeEventListener('touchstart', onTouchStart);
      row.removeEventListener('touchmove', onTouchMove);
    };
  }, [rowRef]);

  return { swipeLayerRef, progressHintRef, deleteHintRef };
}
