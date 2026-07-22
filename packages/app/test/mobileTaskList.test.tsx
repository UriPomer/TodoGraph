import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it } from 'vitest';
import { ListView } from '../src/features/tasks/ListView';
import { TaskItem } from '../src/features/tasks/TaskItem';
import { ThemeProvider } from '../src/features/theme/ThemeProvider';
import { useTaskStore } from '../src/stores/useTaskStore';
import { useWorkspaceStore } from '../src/stores/useWorkspaceStore';

describe('mobile task list', () => {
  beforeEach(() => {
    useTaskStore.setState(useTaskStore.getInitialState(), true);
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
  });

  it('renders mobile task sections without rounded card blocks', () => {
    useTaskStore.setState({
      activePageId: 'p-1',
      loaded: true,
      nodes: [
        { id: 'done-1', title: '需求评审与确认', status: 'done' },
        { id: 'ready-1', title: '完善任务详情页交互', status: 'todo' },
        { id: 'blocked-1', title: '对接权限中心接口', status: 'todo' },
      ],
      edges: [
        { from: 'done-1', to: 'ready-1' },
        { from: 'ready-1', to: 'blocked-1' },
      ],
    });

    const html = renderToStaticMarkup(
      <ThemeProvider>
        <ListView />
      </ThemeProvider>,
    );

    expect(html).toContain('data-mobile-task-section="ready"');
    expect(html).toContain('data-mobile-task-section="blocked"');
    expect(html).toContain('data-mobile-task-section="done"');
    expect(html).toContain('mobile-list-glass');
    expect(html).not.toContain('data-mobile-task-focus="true"');
    expect(html).not.toContain('今日焦点');
    expect(html).not.toContain('max-lg:rounded-xl');
    expect(html).not.toContain('shadow-[0_8px_24px');
    expect(html).toContain('Ready');
    expect(html).toContain('Blocked');
    expect(html).toContain('Done');
    expect(html).toContain('可执行');
    const taskHtml = renderToStaticMarkup(
      <TaskItem task={{ id: 'mobile-task', title: '移动任务', status: 'todo' }} />,
    );
    const descriptionButton = taskHtml.match(/<button[^>]*data-task-action="description"[^>]*>/)?.[0];
    expect(descriptionButton).toBeDefined();
    expect(descriptionButton).not.toContain('max-lg:hidden');
    expect(descriptionButton).not.toMatch(/(?:^|\s)hover:/);
    expect(taskHtml).not.toContain('data-mobile-task-open="true"');
    expect(taskHtml).toMatch(/data-mobile-hidden-action="delete"[^>]*class="[^"]*max-lg:hidden/);
  });

  it('moves the split bar to the bottom when no other page has ready tasks', () => {
    useTaskStore.setState({ activePageId: 'p-1', loaded: true });

    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<ListView />, {
        createNodeMock: (element) => String(element.props.className).includes('mobile-list-glass')
          ? { getBoundingClientRect: () => ({ top: 0, height: 800 }) }
          : null,
      });
    });
    const scrollArea = () =>
      renderer.root.find(
        (node) => node.props.style?.overscrollBehaviorY === 'contain',
      );

    expect(scrollArea().props.className).toBe('min-h-0 flex-1 overflow-auto');
    expect(scrollArea().props.style.height).toBeUndefined();
    expect(renderer.root.findByProps({ 'data-list-split': 'bottom' })).toBeTruthy();

    act(() => {
      useWorkspaceStore.setState({
        allTasks: [
          {
            id: 'other-ready',
            title: '跨页任务',
            status: 'todo',
            _pageId: 'p-2',
            _pageTitle: '其他页面',
            _ready: true,
          },
        ],
      });
    });

    expect(scrollArea().props.className).toBe('overflow-auto');
    expect(scrollArea().props.style.height).toBe('65%');
    expect(renderer.root.findByProps({ 'data-list-split': 'adjustable' })).toBeTruthy();
    expect(JSON.stringify(renderer.toJSON())).toContain('其他页面可做');
    const split = renderer.root.findByProps({ 'data-list-split': 'adjustable' });
    expect(split.props.className).toContain('h-px');
    expect(split.props.className).toContain('lg:hover:bg-');
    expect(split.props.className).not.toMatch(/(?:^|\s)hover:/);

    let captured = false;
    const pointerTarget = {
      setPointerCapture: () => { captured = true; },
      hasPointerCapture: () => captured,
      releasePointerCapture: () => { captured = false; },
    };
    act(() => split.props.onPointerDown({
      pointerId: 1,
      clientY: 400,
      preventDefault: () => {},
      currentTarget: pointerTarget,
    }));
    const draggingSplit = renderer.root.findByProps({ 'data-list-split': 'adjustable' });
    expect(draggingSplit.props['data-list-split-dragging']).toBe('true');
    expect(draggingSplit.props.className).toContain('bg-[hsl(var(--primary))]');

    act(() => draggingSplit.props.onPointerCancel({ pointerId: 1, currentTarget: pointerTarget }));
    const releasedSplit = renderer.root.findByProps({ 'data-list-split': 'adjustable' });
    expect(releasedSplit.props['data-list-split-dragging']).toBeUndefined();
    expect(releasedSplit.props.className).toContain('bg-border/30');

    act(() => releasedSplit.props.onPointerDown({
      pointerId: 2,
      clientY: 400,
      preventDefault: () => {},
      currentTarget: pointerTarget,
    }));
    const recapturedSplit = renderer.root.findByProps({ 'data-list-split': 'adjustable' });
    expect(recapturedSplit.props['data-list-split-dragging']).toBe('true');

    act(() => recapturedSplit.props.onLostPointerCapture());
    const captureLostSplit = renderer.root.findByProps({ 'data-list-split': 'adjustable' });
    expect(captureLostSplit.props['data-list-split-dragging']).toBeUndefined();
    expect(captureLostSplit.props.className).toContain('bg-border/30');

    act(() => renderer.unmount());
  });

  it('collapses the done section by default and expands it from the heading', () => {
    useTaskStore.setState({
      activePageId: 'p-1',
      loaded: true,
      nodes: [{ id: 'done-1', title: '已完成任务', status: 'done' }],
    });

    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<ListView />);
    });

    const toggle = renderer.root.findByProps({ 'aria-label': '展开已完成任务' });
    expect(toggle.props['aria-expanded']).toBe(false);
    expect(renderer.root.findAllByProps({ 'data-task-id': 'done-1' })).toHaveLength(0);

    act(() => toggle.props.onClick());

    expect(renderer.root.findByProps({ 'aria-label': '折叠已完成任务' }).props['aria-expanded']).toBe(true);
    expect(renderer.root.findAllByProps({ 'data-task-id': 'done-1' })).toHaveLength(1);

    act(() => renderer.unmount());
  });
});
