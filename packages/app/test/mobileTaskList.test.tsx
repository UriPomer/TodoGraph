import { renderToStaticMarkup } from 'react-dom/server';
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
});
