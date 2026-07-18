import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupNode } from '@/features/graph/GroupNode';
import { useTaskStore } from '@/stores/useTaskStore';

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  useReactFlow: () => ({ screenToFlowPosition: (point: unknown) => point }),
}));
vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }));
const dialogMocks = vi.hoisted(() => ({ prompt: vi.fn() }));
vi.mock('@/components/ui/dialog-store', () => ({
  dialog: { prompt: dialogMocks.prompt },
}));

describe('mobile collapsed group controls', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {
      body: { style: { overflow: '' } },
      activeElement: null,
      getElementById: () => null,
    });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    useTaskStore.setState(useTaskStore.getInitialState(), true);
    useTaskStore.setState({
      nodes: [
        { id: 'parent', title: '父节点', status: 'todo' },
        { id: 'child', title: '子节点', status: 'todo', parentId: 'parent' },
      ],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('advances a visible child status without leaking click events', () => {
    const renderer = create(
      <GroupNode
        id="parent"
        selected={false}
        dragging={false}
        zIndex={0}
        isConnectable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        data={{
          title: '父节点',
          status: 'todo',
          childrenCount: 1,
          isHeightCollapsed: true,
          descendants: [
            { id: 'child', title: '子节点', status: 'todo', depth: 1, width: 180, height: 56 },
          ],
        }}
        type="group"
      />,
    );
    const statusButton = renderer.root.findByProps({ 'aria-label': '推进 子节点 状态' });
    const clickEvent = { stopPropagation: vi.fn() };
    act(() => statusButton.props.onClick(clickEvent));
    expect(clickEvent.stopPropagation).toHaveBeenCalledOnce();
    expect(useTaskStore.getState().nodes.find((node) => node.id === 'child')?.status).toBe('doing');

    const doubleClickEvent = { stopPropagation: vi.fn() };
    act(() => statusButton.props.onDoubleClick(doubleClickEvent));
    expect(doubleClickEvent.stopPropagation).toHaveBeenCalledOnce();
    act(() => renderer.unmount());
  });

  it('does not open an editor after repeated dialog status clicks and close', () => {
    const renderer = create(
      <GroupNode
        id="parent"
        selected={false}
        dragging={false}
        zIndex={0}
        isConnectable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        data={{
          title: '父节点', status: 'todo', childrenCount: 1, isHeightCollapsed: true,
          descendants: [
            { id: 'child', title: '子节点', status: 'todo', depth: 1, width: 180, height: 56 },
          ],
        }}
        type="group"
      />,
    );
    const expand = renderer.root.findAllByType('button').find(
      (button) => button.props.className?.includes('absolute left-2 right-2'),
    )!;
    act(() => expand.props.onClick({ stopPropagation: vi.fn(), currentTarget: { focus: vi.fn() } }));

    const statusButtons = renderer.root.findAllByProps({ 'aria-label': '推进 子节点 状态' });
    const dialogStatus = statusButtons[statusButtons.length - 1]!;
    for (let index = 0; index < 4; index++) {
      act(() => dialogStatus.props.onClick({ stopPropagation: vi.fn() }));
    }
    const backdrop = renderer.root.findByProps({ role: 'dialog' }).parent!;
    act(() => backdrop.props.onDoubleClick({ stopPropagation: vi.fn() }));
    act(() => renderer.root.findByProps({ 'aria-label': '关闭' }).props.onClick());

    expect(dialogMocks.prompt).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});
