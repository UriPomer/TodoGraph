import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-dom', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-dom')>(),
  createPortal: (children: unknown) => children,
}));

import { TaskItem } from '../src/features/tasks/TaskItem';
import { ListView, prepareTaskMoveAnimation } from '../src/features/tasks/ListView';
import { useTaskStore } from '../src/stores/useTaskStore';
import { useWorkspaceStore } from '../src/stores/useWorkspaceStore';
import { useToastStore } from '../src/components/ui/toaster-store';
import { useHistoryStore } from '../src/stores/useHistoryStore';
import { LIST_LONG_PRESS_MS } from '../src/features/tasks/gesturePolicy';

const task = { id: 'parent', title: '需要推进的父任务', status: 'todo' as const };
const POINTER_ID = 7;
const pointerDown = (row: unknown, clientX: number, clientY: number, pointerType = 'mouse') => {
  let captured = false;
  return {
    isPrimary: true,
    pointerType,
    button: 0,
    pointerId: POINTER_ID,
    clientX,
    clientY,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    target: { closest: () => null },
    currentTarget: {
      closest: () => row,
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      setPointerCapture: vi.fn(() => { captured = true; }),
      hasPointerCapture: vi.fn(() => captured),
      releasePointerCapture: vi.fn(() => { captured = false; }),
    },
  };
};
const pointerEvent = (down: ReturnType<typeof pointerDown>, clientX: number, clientY: number) => ({
  pointerId: POINTER_ID,
  pointerType: 'mouse',
  clientX,
  clientY,
  preventDefault: vi.fn(),
  currentTarget: down.currentTarget,
});
type TouchListener = (event: any) => void;
const touchPoint = (clientX: number, clientY: number, identifier = POINTER_ID) => ({ identifier, clientX, clientY });
const touchTarget = (titleElement?: HTMLElement, isLink = false) => ({
  closest: (selector: string) => {
    if (selector === '[data-task-title]') return titleElement ?? null;
    if (selector === 'a') return isLink ? {} : null;
    return null;
  },
});
const touchStart = (listeners: Map<string, TouchListener>, clientX: number, clientY: number, target = touchTarget()) => {
  const event = { target, touches: [touchPoint(clientX, clientY)] };
  act(() => listeners.get('touchstart')?.(event));
  return event;
};
const touchMove = (listeners: Map<string, TouchListener>, clientX: number, clientY: number) => {
  const event = { touches: [touchPoint(clientX, clientY)], cancelable: true, preventDefault: vi.fn() };
  act(() => listeners.get('touchmove')?.(event));
  return event;
};
const touchEnd = (listeners: Map<string, TouchListener>) => {
  const event = { touches: [], changedTouches: [touchPoint(0, 0)], cancelable: true, preventDefault: vi.fn() };
  act(() => listeners.get('touchend')?.(event));
  return event;
};
const touchCancel = (listeners: Map<string, TouchListener>) => {
  act(() => listeners.get('touchcancel')?.({ touches: [] }));
};
const taskRowNode = (listeners: Map<string, TouchListener>, rect: Record<string, number>, taskId = task.id) => ({
  style: {},
  getAttribute: (name: string) => name === 'data-task-id' ? taskId : null,
  getBoundingClientRect: () => rect,
  addEventListener: (type: string, listener: TouchListener) => listeners.set(type, listener),
  removeEventListener: (type: string) => listeners.delete(type),
});

describe('task list row interactions', () => {
  beforeEach(() => {
    useTaskStore.setState({ ...useTaskStore.getInitialState(), nodes: [task], loaded: true }, true);
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
    useToastStore.setState({ toasts: [] });
    useHistoryStore.getState().clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses the task body as a desktop drag surface without a visible handle', () => {
    const onDragStart = vi.fn();
    const renderer = create(<TaskItem task={task} onDragStart={onDragStart} />);
    const surface = renderer.root.findByProps({ 'data-task-drag-surface': 'true' });
    const rowElement = { getBoundingClientRect: vi.fn() };
    const event = pointerDown(rowElement, 40, 60);

    act(() => surface.props.onPointerDown(event));

    expect(surface.props.className).toContain('lg:cursor-grab');
    expect(renderer.root.findAllByProps({ title: '拖动任务' })).toHaveLength(0);
    expect(onDragStart).toHaveBeenCalledWith(expect.objectContaining({
      pointerId: POINTER_ID,
      sourceElement: rowElement,
      activateImmediately: false,
    }), task);
    renderer.unmount();
  });

  it('measures and animates only the moved task', () => {
    let moved = false;
    const animate = vi.fn();
    const untouchedRect = vi.fn(() => ({ left: 20, top: 200 }));
    const row = {
      getAttribute: () => task.id,
      getBoundingClientRect: () => ({ left: 20, top: moved ? 120 : 40 }),
      animate,
    };
    const untouched = {
      getAttribute: () => 'untouched',
      getBoundingClientRect: untouchedRect,
      animate: vi.fn(),
    };
    const root = { querySelectorAll: () => [row, untouched] };
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    const finishAnimation = prepareTaskMoveAnimation(root as unknown as ParentNode, task.id);
    moved = true;
    finishAnimation();

    expect(animate).toHaveBeenCalledWith(
      [
        { transform: 'translate(0px, -80px)' },
        { transform: 'translate(0, 0)' },
      ],
      { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
    expect(untouchedRect).not.toHaveBeenCalled();
  });

  it('lifts a touch task only after the long-press delay', () => {
    vi.useFakeTimers();
    const rowTouchListeners = new Map<string, TouchListener>();
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
      getSelection: () => ({ removeAllRanges: vi.fn() }),
    });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('document', {
      elementFromPoint: () => null,
      body: {},
      querySelector: () => null,
    });

    let originalRowCreated = false;
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<ListView />, {
        createNodeMock: (element) => {
          if (element.type === 'li' && !originalRowCreated) {
            originalRowCreated = true;
            return taskRowNode(rowTouchListeners, { left: 0, top: 0, bottom: 44, width: 320, height: 44 });
          }
          return null;
        },
      });
    });
    touchStart(rowTouchListeners, 20, 20);
    act(() => vi.advanceTimersByTime(LIST_LONG_PRESS_MS - 1));
    expect(renderer.root.findAllByProps({ className: 'fixed pointer-events-none z-50' })).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1));
    expect(renderer.root.findAllByProps({ className: 'fixed pointer-events-none z-50' })).toHaveLength(1);
    const firstMove = touchMove(rowTouchListeners, 26, 20);
    const movedGhost = renderer.root.findByProps({ className: 'fixed pointer-events-none z-50' });
    const movedGhostLeft = movedGhost.props.style.left;
    const movedGhostWidth = movedGhost.props.style.width;
    const draggingClassName = renderer.root
      .findAllByProps({ 'data-task-id': task.id })
      .find((item) => item.props.className.includes('opacity-25'))?.props.className;

    touchEnd(rowTouchListeners);
    expect(renderer.root.findAllByProps({ className: 'fixed pointer-events-none z-50' })).toHaveLength(0);
    touchStart(rowTouchListeners, 20, 20);
    act(() => vi.advanceTimersByTime(LIST_LONG_PRESS_MS));
    expect(renderer.root.findAllByProps({ className: 'fixed pointer-events-none z-50' })).toHaveLength(1);
    touchEnd(rowTouchListeners);
    renderer.unmount();

    expect(draggingClassName).toContain('lg:scale-[0.98]');
    expect(firstMove.preventDefault).toHaveBeenCalledOnce();
    expect(movedGhostLeft).toBe(0);
    expect(movedGhostWidth).toBe('100vw');
  });

  it('cancels pull-to-create when a long press becomes task dragging', () => {
    vi.useFakeTimers();
    const scrollTouchListeners = new Map<string, TouchListener>();
    const rowTouchListeners = new Map<string, TouchListener>();
    const contentStyle = { transform: 'translateY(0px)' };
    const scrollNode = {
      scrollTop: 0,
      addEventListener: (type: string, listener: TouchListener) => scrollTouchListeners.set(type, listener),
      removeEventListener: (type: string) => scrollTouchListeners.delete(type),
    };
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('document', {
      elementFromPoint: () => null,
      body: {},
      querySelector: () => null,
    });

    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(<ListView />, {
        createNodeMock: (element) => {
          if (element.type === 'li' && rowTouchListeners.size === 0) {
            return taskRowNode(rowTouchListeners, { left: 0, top: 20, bottom: 64, width: 320, height: 44 });
          }
          if (element.props.style?.overscrollBehaviorY === 'contain') return scrollNode;
          if (String(element.props.className).includes('will-change-transform w-full')) {
            return { style: contentStyle };
          }
          if (String(element.props.className).includes('will-change-[opacity]')) {
            return { style: { opacity: '0', transform: 'translateY(-20px)' } };
          }
          return { style: {} };
        },
      });
    });
    touchStart(rowTouchListeners, 100, 40);
    act(() => scrollTouchListeners.get('touchstart')?.({
      target: { closest: () => null },
      touches: [touchPoint(100, 40)],
    }));
    act(() => vi.advanceTimersByTime(LIST_LONG_PRESS_MS));
    const dragMove = touchMove(rowTouchListeners, 100, 120);
    const pullPreventDefault = vi.fn();
    act(() => scrollTouchListeners.get('touchmove')?.({ touches: [touchPoint(100, 120)], preventDefault: pullPreventDefault }));

    expect(contentStyle.transform).toBe('translateY(0px)');
    expect(dragMove.preventDefault).toHaveBeenCalledOnce();
    expect(pullPreventDefault).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('keeps the drag ghost aligned to the source row without scrolling', () => {
    vi.useFakeTimers();
    const rowTouchListeners = new Map<string, TouchListener>();
    const requestFrame = vi.fn();
    const rowElement = {
      getAttribute: (name: string) => (name === 'data-task-id' ? task.id : null),
      getBoundingClientRect: () => ({ left: 30, top: 60, bottom: 104, width: 320, height: 44 }),
    };
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
      getSelection: () => ({ removeAllRanges: vi.fn() }),
    });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('document', {
      elementFromPoint: () => null,
      body: {},
      querySelector: () => null,
    });

    let originalRowCreated = false;
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<ListView />, {
        createNodeMock: (element) => {
          if (element.type === 'li' && !originalRowCreated) {
            originalRowCreated = true;
            return taskRowNode(rowTouchListeners, rowElement.getBoundingClientRect());
          }
          return null;
        },
      });
    });
    touchStart(rowTouchListeners, 330, 82);
    act(() => vi.advanceTimersByTime(LIST_LONG_PRESS_MS));
    touchMove(rowTouchListeners, 340, 92);

    const ghost = renderer.root.findByProps({ className: 'fixed pointer-events-none z-50' });
    expect(ghost.props.style).toMatchObject({ left: 0, top: 70, width: '100vw' });
    expect(requestFrame).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('keeps a child under its parent when a drag ends on the original row', () => {
    const parent = { id: 'group', title: '父节点', status: 'todo' as const };
    const child = { ...task, parentId: parent.id };
    useTaskStore.setState({ nodes: [parent, child], listRevision: 1 });
    const listeners = new Map<string, (event?: any) => void>();
    const childElement = {
      getAttribute: (name: string) => (name === 'data-task-id' ? child.id : null),
      getBoundingClientRect: () => ({ left: 0, top: 80, bottom: 124, height: 44 }),
    };
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
      getSelection: () => ({ removeAllRanges: vi.fn() }),
    });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('document', {
      addEventListener: (type: string, listener: (event?: any) => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
      elementFromPoint: () => ({ closest: () => childElement }),
      querySelector: () => null,
    });

    const renderer = create(<ListView />);
    const row = renderer.root.findByProps({ 'data-task-id': child.id });
    const surface = row.findByProps({ 'data-task-drag-surface': 'true' });
    const down = pointerDown(childElement, 100, 100);
    act(() => surface.props.onPointerDown(down));
    act(() => surface.props.onPointerMove(pointerEvent(down, 100, 120)));
    act(() => surface.props.onPointerUp(pointerEvent(down, 100, 120)));

    expect(useTaskStore.getState().nodes.find((node) => node.id === child.id)?.parentId)
      .toBe(parent.id);
    renderer.unmount();
  });

  it('does not lock the first drag in auto-scroll at the top boundary', () => {
    const first = { id: 'first-drag', title: '首次拖动', status: 'todo' as const };
    useTaskStore.setState({ nodes: [first], listRevision: 1 });
    const animationFrames: FrameRequestCallback[] = [];
    let scrollTop = 0;
    const scrollNode = {
      get scrollTop() { return scrollTop; },
      set scrollTop(value: number) { scrollTop = Math.max(0, value); },
      getBoundingClientRect: () => ({ top: 100, bottom: 500 }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      querySelectorAll: () => [],
    };
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: true }),
      getSelection: () => ({ removeAllRanges: vi.fn() }),
    });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('document', {
      elementFromPoint: () => null,
      querySelector: () => null,
      body: {},
    });

    const renderer = create(<ListView />, {
      createNodeMock: (element) => element.props.style?.overscrollBehaviorY === 'contain'
        ? scrollNode
        : null,
    });
    const surface = renderer.root
      .findByProps({ 'data-task-id': first.id })
      .findByProps({ 'data-task-drag-surface': 'true' });
    const down = pointerDown({
      getBoundingClientRect: () => ({ left: 0, top: 100, width: 320, height: 44 }),
    }, 100, 130);

    act(() => surface.props.onPointerDown(down));
    act(() => surface.props.onPointerMove(pointerEvent(down, 100, 110)));
    expect(renderer.root.findAllByProps({ className: 'fixed pointer-events-none z-50' })).toHaveLength(1);
    expect(animationFrames).toHaveLength(1);

    act(() => animationFrames[0]!(0));
    expect(animationFrames).toHaveLength(1);
    expect(scrollTop).toBe(0);

    act(() => surface.props.onPointerUp(pointerEvent(down, 100, 110)));
    expect(renderer.root.findAllByProps({ className: 'fixed pointer-events-none z-50' })).toHaveLength(0);
    renderer.unmount();
  });

  it('reorders siblings from a row edge without nesting them', () => {
    const parent = { id: 'group', title: '父节点', status: 'todo' as const };
    const first = { id: 'first', title: '第一个', status: 'todo' as const, parentId: parent.id };
    const second = { id: 'second', title: '第二个', status: 'todo' as const, parentId: parent.id };
    useTaskStore.setState({ nodes: [parent, first, second], listRevision: 1 });
    const listeners = new Map<string, (event?: any) => void>();
    const animate = vi.fn();
    const movingRow = {
      getAttribute: (name: string) => (name === 'data-task-id' ? first.id : null),
      getBoundingClientRect: () => ({
        left: 0,
        top: useTaskStore.getState().nodes.findIndex((node) => node.id === first.id) * 44,
      }),
      animate,
    };
    const anchorRow = {
      getAttribute: (name: string) => (name === 'data-task-id' ? second.id : null),
      getBoundingClientRect: () => ({ left: 0, top: 44 }),
      animate: vi.fn(),
    };
    const scrollNode = {
      scrollTop: 0,
      querySelectorAll: () => [movingRow, anchorRow],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const secondElement = {
      getAttribute: (name: string) => (name === 'data-task-id' ? second.id : null),
      getBoundingClientRect: () => ({ left: 0, top: 120, bottom: 164, width: 320, height: 44 }),
    };
    const dropIndicatorStyle: Record<string, string> = {};
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
      getSelection: () => ({ removeAllRanges: vi.fn() }),
    });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('document', {
      addEventListener: (type: string, listener: (event?: any) => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
      elementFromPoint: () => ({ closest: () => secondElement }),
      querySelectorAll: () => [secondElement],
      querySelector: () => null,
      body: {},
    });

    const renderer = create(<ListView />, {
      createNodeMock: (element) => {
        if (element.props.style?.overscrollBehaviorY === 'contain') return scrollNode;
        if (String(element.props.className).includes('will-change-transform w-full')) {
          return { style: { transform: 'translateY(0px)' } };
        }
        if (String(element.props.className).includes('will-change-[opacity]')) {
          return { style: { opacity: '0', transform: 'translateY(-20px)' } };
        }
        if (element.props['data-list-drop-indicator']) return { style: dropIndicatorStyle };
        return { style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 600 }) };
      },
    });
    const row = renderer.root.findByProps({ 'data-task-id': first.id });
    const surface = row.findByProps({ 'data-task-drag-surface': 'true' });
    const down = pointerDown({
      getBoundingClientRect: () => ({ left: 0, top: 80 }),
    }, 100, 100);
    act(() => surface.props.onPointerDown(down));
    act(() => surface.props.onPointerMove(pointerEvent(down, 100, 121)));
    act(() => surface.props.onPointerMove(pointerEvent(down, 100, 160)));
    expect(renderer.root.findAllByProps({ 'data-reorder-indicator': 'after' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-list-drop-indicator': 'reorder' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-list-drop-hint': 'true' })).toHaveLength(0);
    expect(dropIndicatorStyle).toMatchObject({ display: '', left: '8px', top: '162px', width: '304px', height: '4px' });
    act(() => surface.props.onPointerUp(pointerEvent(down, 100, 160)));

    const nodes = useTaskStore.getState().nodes;
    expect(nodes.find((node) => node.id === first.id)?.parentId).toBe(parent.id);
    expect(nodes.indexOf(nodes.find((node) => node.id === first.id)!))
      .toBeGreaterThan(nodes.indexOf(nodes.find((node) => node.id === second.id)!));
    expect(animate).toHaveBeenCalledWith(
      [
        { transform: 'translate(0px, -44px)' },
        { transform: 'translate(0, 0)' },
      ],
      { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );

    expect(renderer.root.findAllByProps({ className: 'fixed pointer-events-none z-50' })).toHaveLength(0);
    const secondSurface = renderer.root
      .findByProps({ 'data-task-id': second.id })
      .findByProps({ 'data-task-drag-surface': 'true' });
    const secondDown = pointerDown(secondElement, 100, 140);
    act(() => secondSurface.props.onPointerDown(secondDown));
    act(() => secondSurface.props.onPointerMove(pointerEvent(secondDown, 100, 160)));
    expect(renderer.root.findAllByProps({ className: 'fixed pointer-events-none z-50' })).toHaveLength(1);
    act(() => secondSurface.props.onPointerUp(pointerEvent(secondDown, 100, 160)));
    expect(renderer.root.findAllByProps({ className: 'fixed pointer-events-none z-50' })).toHaveLength(0);
    renderer.unmount();
  });

  it('nests a positionless task as one undoable operation', () => {
    const child = { id: 'child', title: '子节点', status: 'todo' as const };
    const parent = { id: 'target', title: '目标父节点', status: 'todo' as const, x: 300, y: 200 };
    useTaskStore.setState({ nodes: [child, parent], listRevision: 1, viewportCenter: { x: 500, y: 300 } });
    const listeners = new Map<string, (event?: any) => void>();
    const targetElement = {
      getAttribute: (name: string) => (name === 'data-task-id' ? parent.id : null),
      getBoundingClientRect: () => ({ left: 0, top: 100, bottom: 144, width: 320, height: 44 }),
    };
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
      getSelection: () => ({ removeAllRanges: vi.fn() }),
    });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('document', {
      addEventListener: (type: string, listener: (event?: any) => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
      elementFromPoint: () => ({ closest: () => targetElement }),
      querySelectorAll: () => [targetElement],
      querySelector: () => null,
      body: {},
    });

    const renderer = create(<ListView />);
    const row = renderer.root.findByProps({ 'data-task-id': child.id });
    const surface = row.findByProps({ 'data-task-drag-surface': 'true' });
    const down = pointerDown({
      getBoundingClientRect: () => ({ left: 0, top: 20 }),
    }, 100, 40);
    act(() => surface.props.onPointerDown(down));
    act(() => surface.props.onPointerMove(pointerEvent(down, 100, 120)));
    act(() => surface.props.onPointerMove(pointerEvent(down, 100, 120)));
    act(() => surface.props.onPointerUp(pointerEvent(down, 100, 120)));

    expect(useTaskStore.getState().nodes.find((node) => node.id === child.id)?.parentId).toBe(parent.id);
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    act(() => useTaskStore.getState().undo());
    expect(useTaskStore.getState().nodes.find((node) => node.id === child.id)?.parentId).toBeUndefined();
    renderer.unmount();
  });

  it('reorders forward done rows and reverse ready rows in their visual direction', () => {
    const firstDone = { id: 'done-1', title: '先完成', status: 'done' as const };
    const secondDone = { id: 'done-2', title: '后完成', status: 'done' as const };
    useTaskStore.setState({ nodes: [firstDone, secondDone], listRevision: 1 });
    expect(useTaskStore.getState().reorderTask(secondDone.id, firstDone.id, 'before', 'forward')).toBe(true);
    expect(useTaskStore.getState().nodes.map(({ id }) => id)).toEqual([secondDone.id, firstDone.id]);

    const older = { id: 'older', title: '较早', status: 'todo' as const };
    const newer = { id: 'newer', title: '较新', status: 'todo' as const };
    useTaskStore.setState({ nodes: [older, newer], listRevision: 2 });
    expect(useTaskStore.getState().reorderTask(newer.id, older.id, 'after', 'reverse')).toBe(true);
    expect(useTaskStore.getState().nodes.map(({ id }) => id)).toEqual([newer.id, older.id]);
  });

  it('moves a third-level task up exactly one level after a deliberate left drag', () => {
    const grandparent = { id: 'root-group', title: '一级节点', status: 'todo' as const };
    const parent = { id: 'group', title: '二级节点', status: 'todo' as const, parentId: grandparent.id };
    const child = { ...task, parentId: parent.id };
    useTaskStore.setState({ nodes: [grandparent, parent, child], listRevision: 1 });
    const listeners = new Map<string, (event?: any) => void>();
    const childElement = {
      getAttribute: (name: string) => (name === 'data-task-id' ? child.id : null),
      getBoundingClientRect: () => ({ left: 0, top: 80, bottom: 124, height: 44 }),
    };
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
      getSelection: () => ({ removeAllRanges: vi.fn() }),
    });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('document', {
      addEventListener: (type: string, listener: (event?: any) => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
      elementFromPoint: () => ({ closest: () => childElement }),
      querySelector: () => null,
    });

    const renderer = create(<ListView />);
    const row = renderer.root.findByProps({ 'data-task-id': child.id });
    const surface = row.findByProps({ 'data-task-drag-surface': 'true' });
    const down = pointerDown(childElement, 100, 100);
    act(() => surface.props.onPointerDown(down));
    act(() => surface.props.onPointerMove(pointerEvent(down, 76, 100)));
    act(() => surface.props.onPointerMove(pointerEvent(down, 92, 70)));
    act(() => surface.props.onPointerUp(pointerEvent(down, 92, 70)));

    expect(useTaskStore.getState().nodes.find((node) => node.id === child.id)?.parentId)
      .toBe(grandparent.id);
    renderer.unmount();
  });

  it('keeps a touch unparent gesture while repositioning before release', () => {
    vi.useFakeTimers();
    const grandparent = { id: 'touch-root', title: '一级节点', status: 'todo' as const };
    const parent = { id: 'touch-parent', title: '二级节点', status: 'todo' as const, parentId: grandparent.id };
    const child = { id: 'touch-child', title: '三级节点', status: 'todo' as const, parentId: parent.id };
    useTaskStore.setState({ nodes: [grandparent, parent, child], listRevision: 1 });
    const rowTouchListeners = new Map<string, TouchListener>();
    const childElement = {
      getAttribute: (name: string) => name === 'data-task-id' ? child.id : null,
      getBoundingClientRect: () => ({ left: 0, top: 80, bottom: 124, width: 320, height: 44 }),
    };
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
      getSelection: () => ({ removeAllRanges: vi.fn() }),
    });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('document', {
      elementFromPoint: () => ({ closest: () => childElement }),
      querySelector: () => null,
      body: {},
    });

    let childRowCreated = false;
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<ListView />, {
        createNodeMock: (element) => {
          if (element.type === 'li' && element.props['data-task-id'] === child.id && !childRowCreated) {
            childRowCreated = true;
            return taskRowNode(rowTouchListeners, childElement.getBoundingClientRect(), child.id);
          }
          return null;
        },
      });
    });

    touchStart(rowTouchListeners, 100, 100);
    act(() => vi.advanceTimersByTime(LIST_LONG_PRESS_MS));
    touchMove(rowTouchListeners, 76, 100);
    touchMove(rowTouchListeners, 92, 70);
    touchEnd(rowTouchListeners);

    expect(useTaskStore.getState().nodes.find((node) => node.id === child.id)?.parentId)
      .toBe(grandparent.id);
    renderer.unmount();
  });

  it('drags a third-level task into a second-level sibling slot with a pointer', () => {
    const root = { id: 'slot-root', title: '一级节点', status: 'todo' as const, x: 100, y: 100 };
    const parent = { id: 'slot-parent', title: '原二级节点', status: 'todo' as const, parentId: root.id, x: 20, y: 40 };
    const child = { id: 'slot-child', title: '待移动三级节点', status: 'todo' as const, parentId: parent.id, x: 20, y: 40 };
    const target = { id: 'slot-target', title: '目标二级节点', status: 'todo' as const, parentId: root.id, x: 20, y: 160 };
    useTaskStore.setState({ nodes: [root, parent, child, target], listRevision: 1 });
    const targetElement = {
      getAttribute: (name: string) => name === 'data-task-id' ? target.id : null,
      getBoundingClientRect: () => ({ left: 0, top: 200, bottom: 244, width: 320, height: 44 }),
    };
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: true }),
      getSelection: () => ({ removeAllRanges: vi.fn() }),
    });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('document', {
      elementFromPoint: (_x: number, y: number) => y >= 200 ? { closest: () => targetElement } : null,
      querySelectorAll: () => [targetElement],
      querySelector: () => null,
      body: {},
    });

    const renderer = create(<ListView />);
    const surface = renderer.root
      .findByProps({ 'data-task-id': child.id })
      .findByProps({ 'data-task-drag-surface': 'true' });
    const down = pointerDown({
      getBoundingClientRect: () => ({ left: 0, top: 100, width: 320, height: 44 }),
    }, 160, 120);
    act(() => surface.props.onPointerDown(down));
    act(() => surface.props.onPointerMove(pointerEvent(down, 136, 160)));
    act(() => surface.props.onPointerMove(pointerEvent(down, 120, 202)));

    expect(renderer.root.findAllByProps({ 'data-list-drop-indicator': 'reparent-reorder' })).toHaveLength(1);
    act(() => surface.props.onPointerUp(pointerEvent(down, 120, 202)));

    const nodes = useTaskStore.getState().nodes;
    expect(nodes.find((node) => node.id === child.id)?.parentId).toBe(root.id);
    expect(nodes.filter((node) => node.parentId === root.id).map((node) => node.id))
      .toEqual([parent.id, child.id, target.id]);
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    renderer.unmount();
  });

  it('long-press drags a third-level task into a second-level sibling slot on touch', () => {
    vi.useFakeTimers();
    const root = { id: 'touch-slot-root', title: '一级节点', status: 'todo' as const, x: 100, y: 100 };
    const parent = { id: 'touch-slot-parent', title: '原二级节点', status: 'todo' as const, parentId: root.id, x: 20, y: 40 };
    const child = { id: 'touch-slot-child', title: '待移动三级节点', status: 'todo' as const, parentId: parent.id, x: 20, y: 40 };
    const target = { id: 'touch-slot-target', title: '目标二级节点', status: 'todo' as const, parentId: root.id, x: 20, y: 160 };
    useTaskStore.setState({ nodes: [root, parent, child, target], listRevision: 1 });
    const rowTouchListeners = new Map<string, TouchListener>();
    const targetElement = {
      getAttribute: (name: string) => name === 'data-task-id' ? target.id : null,
      getBoundingClientRect: () => ({ left: 0, top: 200, bottom: 244, width: 320, height: 44 }),
    };
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: true }),
      getSelection: () => ({ removeAllRanges: vi.fn() }),
    });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('document', {
      elementFromPoint: (_x: number, y: number) => y >= 200 ? { closest: () => targetElement } : null,
      querySelectorAll: () => [targetElement],
      querySelector: () => null,
      body: {},
    });

    let childRowCreated = false;
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<ListView />, {
        createNodeMock: (element) => {
          if (element.type !== 'li' || element.props['data-task-id'] !== child.id || childRowCreated) return null;
          childRowCreated = true;
          return taskRowNode(rowTouchListeners, { left: 0, top: 100, bottom: 144, width: 320, height: 44 }, child.id);
        },
      });
    });
    touchStart(rowTouchListeners, 160, 120);
    act(() => vi.advanceTimersByTime(LIST_LONG_PRESS_MS));
    touchMove(rowTouchListeners, 136, 160);
    touchMove(rowTouchListeners, 120, 202);

    expect(renderer.root.findAllByProps({ 'data-list-drop-indicator': 'reparent-reorder' })).toHaveLength(1);
    touchEnd(rowTouchListeners);

    const nodes = useTaskStore.getState().nodes;
    expect(nodes.find((node) => node.id === child.id)?.parentId).toBe(root.id);
    expect(nodes.filter((node) => node.parentId === root.id).map((node) => node.id))
      .toEqual([parent.id, child.id, target.id]);
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    renderer.unmount();
  });

  it('drags blank row space but excludes title and interactive controls', () => {
    const onDragStart = vi.fn();
    const renderer = create(<TaskItem task={task} onDragStart={onDragStart} />);
    const surface = renderer.root.findByProps({ 'data-task-drag-surface': 'true' });
    const rowElement = { getBoundingClientRect: vi.fn() };
    const excludedEvent = pointerDown(rowElement, 20, 20);
    excludedEvent.target.closest = () => ({});
    const blankSpaceEvent = pointerDown(rowElement, 20, 20);

    act(() => surface.props.onPointerDown(excludedEvent));
    expect(onDragStart).not.toHaveBeenCalled();
    act(() => surface.props.onPointerDown(blankSpaceEvent));
    expect(onDragStart).toHaveBeenCalledOnce();
    renderer.unmount();
  });

  it('releases desktop pointer capture so the same task can be dragged twice', () => {
    const onDragStart = vi.fn();
    const onDragMove = vi.fn();
    const onDragEnd = vi.fn();
    const renderer = create(
      <TaskItem task={task} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} />,
    );
    const surface = renderer.root.findByProps({ 'data-task-drag-surface': 'true' });
    const rowElement = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 44 }) };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const down = pointerDown(rowElement, 20, 20);
      act(() => surface.props.onPointerDown(down));
      act(() => surface.props.onPointerMove(pointerEvent(down, 20, 60)));
      act(() => surface.props.onPointerUp(pointerEvent(down, 20, 60)));
      expect(down.currentTarget.releasePointerCapture).toHaveBeenCalledWith(POINTER_ID);
    }

    expect(onDragStart).toHaveBeenCalledTimes(2);
    expect(onDragMove).toHaveBeenCalledTimes(2);
    expect(onDragEnd).toHaveBeenCalledTimes(2);
    renderer.unmount();
  });

  it('ends desktop dragging even when the browser already released pointer capture', () => {
    const onDragEnd = vi.fn();
    const renderer = create(<TaskItem task={task} onDragStart={vi.fn()} onDragEnd={onDragEnd} />);
    const surface = renderer.root.findByProps({ 'data-task-drag-surface': 'true' });
    const rowElement = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 44 }) };
    const down = pointerDown(rowElement, 20, 20);

    act(() => surface.props.onPointerDown(down));
    down.currentTarget.releasePointerCapture(POINTER_ID);
    act(() => surface.props.onPointerUp(pointerEvent(down, 20, 60)));

    expect(onDragEnd).toHaveBeenCalledWith(POINTER_ID);
    renderer.unmount();
  });

  it('double-clicks title into an underlined input with the caret at the click position', () => {
    const focus = vi.fn();
    const setSelectionRange = vi.fn();
    vi.stubGlobal('window', { getSelection: () => ({ removeAllRanges: vi.fn() }) });
    const renderer = create(<TaskItem task={task} />, {
      createNodeMock: (element) => element.type === 'input'
        ? { focus, setSelectionRange, value: task.title }
        : null,
    });
    const title = renderer.root.findByProps({ 'data-task-title': 'true' });
    const stopPropagation = vi.fn();

    act(() => title.props.onDoubleClick({
      preventDefault: vi.fn(),
      stopPropagation,
      clientX: 50,
      clientY: 20,
      currentTarget: {
        ownerDocument: {},
        contains: () => false,
        textContent: task.title,
        getBoundingClientRect: () => ({ left: 0, width: 100 }),
      },
    }));

    const input = renderer.root.findByType('input');
    expect(input.props.className).toContain('border-b');
    expect(focus).toHaveBeenCalledOnce();
    const expectedCaret = Math.round(task.title.length / 2);
    expect(setSelectionRange).toHaveBeenCalledWith(expectedCaret, expectedCaret);
    expect(stopPropagation).toHaveBeenCalledOnce();
    renderer.unmount();
  });

  it('double-taps a linked title on touch to edit before drag capture starts', () => {
    vi.useFakeTimers();
    const rowTouchListeners = new Map<string, TouchListener>();
    const onDragStart = vi.fn();
    vi.stubGlobal('window', { getSelection: () => ({ removeAllRanges: vi.fn() }) });
    const titleElement = {
      ownerDocument: {},
      contains: () => false,
      textContent: task.title,
      getBoundingClientRect: () => ({ left: 0, width: 100 }),
    } as unknown as HTMLElement;
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<TaskItem task={task} onDragStart={onDragStart} />, {
        createNodeMock: (element) => element.type === 'li'
          ? taskRowNode(rowTouchListeners, { left: 0, top: 0, bottom: 44, width: 320, height: 44 })
          : null,
      });
    });

    touchStart(rowTouchListeners, 50, 20, touchTarget(titleElement, true));
    touchEnd(rowTouchListeners);
    act(() => vi.advanceTimersByTime(100));
    touchStart(rowTouchListeners, 50, 20, touchTarget(titleElement, true));
    touchEnd(rowTouchListeners);

    expect(renderer.root.findAllByType('input')).toHaveLength(1);
    expect(onDragStart).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('long-presses the title to drag without entering edit mode', () => {
    vi.useFakeTimers();
    const rowTouchListeners = new Map<string, TouchListener>();
    const onDragStart = vi.fn();
    const titleElement = {
      ownerDocument: {},
      contains: () => false,
      textContent: task.title,
      getBoundingClientRect: () => ({ left: 0, width: 100 }),
    } as unknown as HTMLElement;
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<TaskItem task={task} onDragStart={onDragStart} />, {
        createNodeMock: (element) => element.type === 'li'
          ? taskRowNode(rowTouchListeners, { left: 0, top: 0, bottom: 44, width: 320, height: 44 })
          : null,
      });
    });

    touchStart(rowTouchListeners, 50, 20, touchTarget(titleElement));
    act(() => vi.advanceTimersByTime(LIST_LONG_PRESS_MS));

    expect(renderer.root.findAllByType('input')).toHaveLength(0);
    expect(onDragStart).toHaveBeenCalledOnce();
    expect(onDragStart.mock.calls[0]?.[0]).toMatchObject({ pointerType: 'touch', activateImmediately: true });
    renderer.unmount();
  });

  it('GEST-010 keeps the first long-press session alive when background refresh replaces the task object', () => {
    vi.useFakeTimers();
    const rowTouchListeners = new Map<string, TouchListener>();
    const onDragStart = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<TaskItem task={task} onDragStart={onDragStart} />, {
        createNodeMock: (element) => element.type === 'li'
          ? taskRowNode(rowTouchListeners, { left: 0, top: 0, bottom: 44, width: 320, height: 44 })
          : null,
      });
    });

    touchStart(rowTouchListeners, 50, 20);
    act(() => renderer.update(<TaskItem task={{ ...task }} onDragStart={onDragStart} />));
    act(() => vi.advanceTimersByTime(LIST_LONG_PRESS_MS));

    expect(onDragStart).toHaveBeenCalledOnce();
    touchEnd(rowTouchListeners);
    renderer.unmount();
  });

  it('treats movement before the long-press deadline as scrolling', () => {
    vi.useFakeTimers();
    const rowTouchListeners = new Map<string, TouchListener>();
    const onDragStart = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<TaskItem task={task} onDragStart={onDragStart} />, {
        createNodeMock: (element) => element.type === 'li'
          ? taskRowNode(rowTouchListeners, { left: 0, top: 0, bottom: 44, width: 320, height: 44 })
          : null,
      });
    });

    touchStart(rowTouchListeners, 50, 20);
    const move = touchMove(rowTouchListeners, 50, 32);
    act(() => vi.advanceTimersByTime(300));
    touchEnd(rowTouchListeners);

    expect(move.preventDefault).not.toHaveBeenCalled();
    expect(onDragStart).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('keeps movement after long press in drag mode instead of completing a swipe', () => {
    vi.useFakeTimers();
    const rowTouchListeners = new Map<string, TouchListener>();
    const onDragStart = vi.fn();
    const onDragMove = vi.fn();
    const onDragEnd = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <TaskItem task={task} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} />,
        {
          createNodeMock: (element) => element.type === 'li'
            ? taskRowNode(rowTouchListeners, { left: 0, top: 0, bottom: 44, width: 320, height: 44 })
            : null,
        },
      );
    });

    touchStart(rowTouchListeners, 0, 0);
    act(() => vi.advanceTimersByTime(LIST_LONG_PRESS_MS));
    const move = touchMove(rowTouchListeners, 120, 0);
    touchEnd(rowTouchListeners);
    act(() => vi.advanceTimersByTime(221));

    expect(move.preventDefault).toHaveBeenCalledOnce();
    expect(onDragStart).toHaveBeenCalledOnce();
    expect(onDragMove).toHaveBeenCalledWith({ pointerId: POINTER_ID, clientX: 120, clientY: 0 });
    expect(onDragEnd).toHaveBeenCalledWith(POINTER_ID);
    expect(useTaskStore.getState().nodes[0]?.status).toBe('todo');
    renderer.unmount();
  });

  it('can long-press and drag the same task twice', () => {
    vi.useFakeTimers();
    const rowTouchListeners = new Map<string, TouchListener>();
    const onDragStart = vi.fn();
    const onDragMove = vi.fn();
    const onDragEnd = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <TaskItem task={task} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} />,
        {
          createNodeMock: (element) => element.type === 'li'
            ? taskRowNode(rowTouchListeners, { left: 0, top: 0, bottom: 44, width: 320, height: 44 })
            : null,
        },
      );
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      touchStart(rowTouchListeners, 20, 20);
      act(() => vi.advanceTimersByTime(LIST_LONG_PRESS_MS));
      touchMove(rowTouchListeners, 20, 60);
      touchEnd(rowTouchListeners);
    }

    expect(onDragStart).toHaveBeenCalledTimes(2);
    expect(onDragMove).toHaveBeenCalledTimes(2);
    expect(onDragEnd).toHaveBeenCalledTimes(2);
    renderer.unmount();
  });

  it('cancels an active touch drag when another finger joins', () => {
    vi.useFakeTimers();
    const rowTouchListeners = new Map<string, TouchListener>();
    const onDragCancel = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <TaskItem task={task} onDragStart={vi.fn()} onDragCancel={onDragCancel} />,
        {
          createNodeMock: (element) => element.type === 'li'
            ? taskRowNode(rowTouchListeners, { left: 0, top: 0, bottom: 44, width: 320, height: 44 })
            : null,
        },
      );
    });

    touchStart(rowTouchListeners, 20, 20);
    act(() => vi.advanceTimersByTime(LIST_LONG_PRESS_MS));
    act(() => rowTouchListeners.get('touchstart')?.({
      target: touchTarget(),
      touches: [touchPoint(20, 20), touchPoint(30, 20, POINTER_ID + 1)],
    }));

    expect(onDragCancel).toHaveBeenCalledWith(POINTER_ID);
    touchCancel(rowTouchListeners);
    renderer.unmount();
  });

  it('closes the description on the second button press after blur saves it', () => {
    const renderer = create(<TaskItem task={task} />);
    const description = renderer.root.findByProps({ 'data-task-action': 'description' });
    const click = { stopPropagation: vi.fn() };

    act(() => description.props.onClick(click));
    const textarea = renderer.root.findByType('textarea');
    expect(textarea.props.rows).toBe(2);
    expect(textarea.props.className).toContain('text-base');
    expect(textarea.props.className).toContain('bg-transparent');
    expect(textarea.props.className).toContain('border-l-2');
    act(() => textarea.props.onChange({ target: { value: '补充说明' } }));
    act(() => textarea.props.onBlur());
    act(() => description.props.onClick(click));

    expect(renderer.root.findAllByType('textarea')).toHaveLength(0);
    expect(useTaskStore.getState().nodes[0]?.description).toBe('补充说明');
    renderer.unmount();
  });

  it('limits the edit gesture hit area to the rendered title text', () => {
    const renderer = create(<TaskItem task={task} />);
    const title = renderer.root.findByProps({ 'data-task-title': 'true' });
    const slot = renderer.root.findByProps({ 'data-task-title-slot': 'true' });

    expect(title.props.className).toContain('inline-block');
    expect(title.props.className).not.toContain('flex-1');
    expect(slot.props.className).toContain('flex-1');
    renderer.unmount();
  });

  it('opens a child input and creates the named child only after submit', () => {
    const onAddChild = vi.fn(() => true);
    const renderer = create(<TaskItem task={task} onAddChild={onAddChild} />);
    const add = renderer.root.findByProps({ title: '添加子任务' });

    act(() => add.props.onClick({ stopPropagation: vi.fn() }));
    expect(onAddChild).not.toHaveBeenCalled();
    const input = renderer.root.findByProps({ placeholder: '输入子任务名称…' });
    act(() => input.props.onChange({ target: { value: '明确命名的子任务' } }));
    act(() => input.props.onKeyDown({ key: 'Enter', preventDefault: vi.fn() }));

    expect(onAddChild).toHaveBeenCalledWith(task.id, '明确命名的子任务');
    renderer.unmount();
  });

  it('arbitrates direction before locking scroll and completes with an accessible right swipe', () => {
    vi.useFakeTimers();
    const rowTouchListeners = new Map<string, TouchListener>();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<TaskItem task={task} />, {
        createNodeMock: (element) => element.type === 'li'
          ? taskRowNode(rowTouchListeners, { left: 0, top: 0, bottom: 44, width: 320, height: 44 })
          : null,
      });
    });

    touchStart(rowTouchListeners, 0, 0);
    touchMove(rowTouchListeners, 55, 1);
    touchEnd(rowTouchListeners);
    act(() => vi.advanceTimersByTime(221));
    expect(useTaskStore.getState().nodes[0]?.status).toBe('todo');

    touchStart(rowTouchListeners, 0, 0);
    const undecidedMove = touchMove(rowTouchListeners, 9, 1);
    const committedMove = touchMove(rowTouchListeners, 78, 2);
    touchEnd(rowTouchListeners);
    act(() => vi.advanceTimersByTime(221));

    expect(undecidedMove.preventDefault).not.toHaveBeenCalled();
    expect(committedMove.preventDefault).toHaveBeenCalledOnce();
    expect(useTaskStore.getState().nodes[0]?.status).toBe('done');
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
      title: '已完成',
      description: task.title,
    });
    act(() => useTaskStore.getState().undo());
    expect(useTaskStore.getState().nodes[0]?.status).toBe('todo');
    renderer.unmount();
  });

  it('deletes with a deliberate left swipe and offers undo feedback', () => {
    vi.useFakeTimers();
    const rowTouchListeners = new Map<string, TouchListener>();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<TaskItem task={task} />, {
        createNodeMock: (element) => element.type === 'li'
          ? taskRowNode(rowTouchListeners, { left: 0, top: 0, bottom: 44, width: 320, height: 44 })
          : null,
      });
    });

    touchStart(rowTouchListeners, 160, 0);
    touchMove(rowTouchListeners, 82, 2);
    touchEnd(rowTouchListeners);
    act(() => vi.advanceTimersByTime(221));

    expect(useTaskStore.getState().nodes).toHaveLength(0);
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
      title: '已删除',
      description: task.title,
    });
    act(() => useTaskStore.getState().undo());
    expect(useTaskStore.getState().nodes[0]?.id).toBe(task.id);
    renderer.unmount();
  });

  it('keeps a parent unfinished when a child is still open', () => {
    vi.useFakeTimers();
    useTaskStore.setState({
      nodes: [task, { id: 'child', title: '未完成子任务', status: 'todo', parentId: task.id }],
    });
    const rowTouchListeners = new Map<string, TouchListener>();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<TaskItem task={task} />, {
        createNodeMock: (element) => element.type === 'li'
          ? taskRowNode(rowTouchListeners, { left: 0, top: 0, bottom: 44, width: 320, height: 44 })
          : null,
      });
    });

    touchStart(rowTouchListeners, 0, 0);
    touchMove(rowTouchListeners, 120, 0);
    touchEnd(rowTouchListeners);
    act(() => vi.advanceTimersByTime(221));

    expect(useTaskStore.getState().nodes.find((node) => node.id === task.id)?.status).toBe('todo');
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ title: '无法完成' });
    renderer.unmount();
  });
});
