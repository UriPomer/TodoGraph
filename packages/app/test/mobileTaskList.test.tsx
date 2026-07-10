import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it } from 'vitest';
import { ListView } from '../src/features/tasks/ListView';
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
  });

  it('moves the split bar to the bottom when no other page has ready tasks', () => {
    useTaskStore.setState({ activePageId: 'p-1', loaded: true });

    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<ListView />);
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

    act(() => renderer.unmount());
  });
});
