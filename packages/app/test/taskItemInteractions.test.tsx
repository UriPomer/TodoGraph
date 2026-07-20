import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskItem } from '../src/features/tasks/TaskItem';
import { ListView } from '../src/features/tasks/ListView';
import { useTaskStore } from '../src/stores/useTaskStore';
import { useWorkspaceStore } from '../src/stores/useWorkspaceStore';
import { useToastStore } from '../src/components/ui/toaster-store';
import { useHistoryStore } from '../src/stores/useHistoryStore';

const task = { id: 'parent', title: '需要推进的父任务', status: 'todo' as const };
const POINTER_ID = 7;
const pointerDown = (row: unknown, clientX: number, clientY: number, pointerType = 'mouse') => ({
  isPrimary: true,
  pointerType,
  button: 0,
  pointerId: POINTER_ID,
  clientX,
  clientY,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  currentTarget: {
    closest: () => row,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: vi.fn(),
  },
});
const pointerEvent = (clientX: number, clientY: number) => ({
  pointerId: POINTER_ID,
  clientX,
  clientY,
  preventDefault: vi.fn(),
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

  it('provides a leading touch-friendly drag handle', () => {
    const onDragStart = vi.fn();
    const renderer = create(<TaskItem task={task} onDragStart={onDragStart} />);
    const handle = renderer.root.findByProps({ title: '拖动任务' });
    const event = { stopPropagation: vi.fn() };

    act(() => handle.props.onPointerDown(event));

    expect(handle.props.className).toContain('touch-none');
    expect(onDragStart).toHaveBeenCalledWith(event, task);
    renderer.unmount();
  });

  it('starts touch dragging from the handle only after movement crosses the threshold', () => {
    const listeners = new Map<string, (event?: unknown) => void>();
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
      getSelection: () => ({ removeAllRanges: vi.fn() }),
    });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('document', {
      addEventListener: (type: string, listener: (event?: unknown) => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
      elementFromPoint: () => null,
      querySelector: () => null,
    });

    const renderer = create(<ListView />);
    const row = renderer.root.findByProps({ 'data-task-id': task.id });
    const handle = row.findByProps({ title: '拖动任务' });
    act(() => handle.props.onPointerDown(pointerDown({
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    }, 20, 20, 'touch')));
    act(() => listeners.get('pointermove')?.(pointerEvent(26, 20)));
    const pressedClassName = renderer.root.findByProps({ 'data-task-id': task.id }).props.className;
    act(() => listeners.get('pointermove')?.(pointerEvent(29, 20)));
    const draggingClassName = renderer.root
      .findAllByProps({ 'data-task-id': task.id })
      .find((item) => item.props.className.includes('opacity-30'))?.props.className;

    act(() => listeners.get('pointerup')?.(pointerEvent(29, 20)));
    renderer.unmount();

    expect(pressedClassName).not.toContain('scale-[0.98]');
    expect(draggingClassName).toContain('scale-[0.98]');
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
    const handle = row.findByProps({ title: '拖动任务' });
    act(() => handle.props.onPointerDown(pointerDown(childElement, 100, 100)));
    act(() => listeners.get('pointermove')?.(pointerEvent(100, 120)));
    act(() => listeners.get('pointerup')?.(pointerEvent(100, 120)));

    expect(useTaskStore.getState().nodes.find((node) => node.id === child.id)?.parentId)
      .toBe(parent.id);
    renderer.unmount();
  });

  it('reorders siblings from a row edge without nesting them', () => {
    const parent = { id: 'group', title: '父节点', status: 'todo' as const };
    const first = { id: 'first', title: '第一个', status: 'todo' as const, parentId: parent.id };
    const second = { id: 'second', title: '第二个', status: 'todo' as const, parentId: parent.id };
    useTaskStore.setState({ nodes: [parent, first, second], listRevision: 1 });
    const listeners = new Map<string, (event?: any) => void>();
    const secondElement = {
      getAttribute: (name: string) => (name === 'data-task-id' ? second.id : null),
      getBoundingClientRect: () => ({ left: 0, top: 120, bottom: 164, height: 44 }),
    };
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
      getSelection: () => ({ removeAllRanges: vi.fn() }),
    });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('document', {
      addEventListener: (type: string, listener: (event?: any) => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
      elementFromPoint: () => ({ closest: () => secondElement }),
      querySelector: () => null,
    });

    const renderer = create(<ListView />);
    const row = renderer.root.findByProps({ 'data-task-id': first.id });
    const handle = row.findByProps({ title: '拖动任务' });
    act(() => handle.props.onPointerDown(pointerDown({
      getBoundingClientRect: () => ({ left: 0, top: 80 }),
    }, 100, 100)));
    act(() => listeners.get('pointermove')?.(pointerEvent(100, 121)));
    act(() => listeners.get('pointermove')?.(pointerEvent(100, 160)));
    expect(renderer.root.findAllByProps({ 'data-reorder-indicator': 'after' })).toHaveLength(1);
    act(() => listeners.get('pointerup')?.(pointerEvent(100, 160)));

    const nodes = useTaskStore.getState().nodes;
    expect(nodes.find((node) => node.id === first.id)?.parentId).toBe(parent.id);
    expect(nodes.indexOf(nodes.find((node) => node.id === first.id)!))
      .toBeGreaterThan(nodes.indexOf(nodes.find((node) => node.id === second.id)!));
    renderer.unmount();
  });

  it('nests a positionless task as one undoable operation', () => {
    const child = { id: 'child', title: '子节点', status: 'todo' as const };
    const parent = { id: 'target', title: '目标父节点', status: 'todo' as const, x: 300, y: 200 };
    useTaskStore.setState({ nodes: [child, parent], listRevision: 1, viewportCenter: { x: 500, y: 300 } });
    const listeners = new Map<string, (event?: any) => void>();
    const targetElement = {
      getAttribute: (name: string) => (name === 'data-task-id' ? parent.id : null),
      getBoundingClientRect: () => ({ left: 0, top: 100, bottom: 144, height: 44 }),
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
      querySelector: () => null,
    });

    const renderer = create(<ListView />);
    const row = renderer.root.findByProps({ 'data-task-id': child.id });
    const handle = row.findByProps({ title: '拖动任务' });
    act(() => handle.props.onPointerDown(pointerDown({
      getBoundingClientRect: () => ({ left: 0, top: 20 }),
    }, 100, 40)));
    act(() => listeners.get('pointermove')?.(pointerEvent(100, 120)));
    act(() => listeners.get('pointermove')?.(pointerEvent(100, 120)));
    act(() => listeners.get('pointerup')?.(pointerEvent(100, 120)));

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

  it('unparents a child only after a deliberate left drag', () => {
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
    const handle = row.findByProps({ title: '拖动任务' });
    act(() => handle.props.onPointerDown(pointerDown(childElement, 100, 100)));
    act(() => listeners.get('pointermove')?.(pointerEvent(40, 100)));
    act(() => listeners.get('pointermove')?.(pointerEvent(40, 100)));
    act(() => listeners.get('pointerup')?.(pointerEvent(40, 100)));

    expect(useTaskStore.getState().nodes.find((node) => node.id === child.id)?.parentId)
      .toBeUndefined();
    renderer.unmount();
  });

  it('does not attach dragging to the row body or editable title', () => {
    const onDragStart = vi.fn();
    const renderer = create(<TaskItem task={task} onDragStart={onDragStart} />);
    const row = renderer.root.findByProps({ 'data-task-id': task.id });
    const title = renderer.root.findByProps({ 'data-task-title': 'true' });

    expect(row.props.onPointerDown).toBeUndefined();
    expect(title.props.onPointerDown).toBeUndefined();
    expect(onDragStart).not.toHaveBeenCalled();
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

  it('requires a deliberate full swipe and includes the task name in undo feedback', () => {
    vi.useFakeTimers();
    const renderer = create(<TaskItem task={task} />);
    const row = renderer.root.findByProps({ 'data-task-id': task.id });
    const touch = (x: number, y = 0) => ({
      touches: [{ clientX: x, clientY: y }],
      preventDefault: vi.fn(),
    });

    act(() => row.props.onTouchStart(touch(0)));
    act(() => row.props.onTouchMove(touch(75)));
    act(() => row.props.onTouchEnd({ touches: [] }));
    act(() => vi.advanceTimersByTime(221));
    expect(useTaskStore.getState().nodes[0]?.status).toBe('todo');

    act(() => row.props.onTouchStart(touch(0)));
    act(() => row.props.onTouchMove(touch(120)));
    act(() => row.props.onTouchEnd({ touches: [] }));
    act(() => vi.advanceTimersByTime(221));

    expect(useTaskStore.getState().nodes[0]?.status).toBe('done');
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
      title: '已完成',
      description: task.title,
    });
    act(() => useTaskStore.getState().undo());
    expect(useTaskStore.getState().nodes[0]?.status).toBe('todo');
    renderer.unmount();
  });

  it('keeps a parent unfinished when a child is still open', () => {
    vi.useFakeTimers();
    useTaskStore.setState({
      nodes: [task, { id: 'child', title: '未完成子任务', status: 'todo', parentId: task.id }],
    });
    const renderer = create(<TaskItem task={task} />);
    const row = renderer.root.findByProps({ 'data-task-id': task.id });
    const touch = (x: number) => ({
      touches: [{ clientX: x, clientY: 0 }],
      preventDefault: vi.fn(),
    });

    act(() => row.props.onTouchStart(touch(0)));
    act(() => row.props.onTouchMove(touch(120)));
    act(() => row.props.onTouchEnd({ touches: [] }));
    act(() => vi.advanceTimersByTime(221));

    expect(useTaskStore.getState().nodes.find((node) => node.id === task.id)?.status).toBe('todo');
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ title: '无法完成' });
    renderer.unmount();
  });
});
