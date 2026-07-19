import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/features/graph/GraphView', () => ({
  GraphView: ({ viewportScope }: { viewportScope: string }) => <div data-testid="graph" data-viewport-scope={viewportScope} />,
}));
vi.mock('@/features/tasks/ListView', () => ({
  ListView: () => <div data-testid="list" />,
}));
vi.mock('@/components/SplitPane', () => ({
  SplitPane: ({ left, right }: { left: ReactNode; right: ReactNode }) => <>{left}{right}</>,
}));

import { WorkspaceContent } from '../src/features/workspace/WorkspaceApp';

describe('responsive workspace content', () => {
  it('mounts exactly one graph on desktop', () => {
    const html = renderToStaticMarkup(
      <WorkspaceContent isDesktop tab="graph" onLogout={vi.fn()} />,
    );
    expect(html.match(/data-testid="graph"/g)).toHaveLength(1);
    expect(html).toContain('data-viewport-scope="desktop"');
  });

  it('mounts exactly one graph on the mobile graph tab', () => {
    const html = renderToStaticMarkup(
      <WorkspaceContent isDesktop={false} tab="graph" onLogout={vi.fn()} />,
    );
    expect(html.match(/data-testid="graph"/g)).toHaveLength(1);
    expect(html).toContain('data-viewport-scope="mobile"');
  });

  it('does not keep a hidden graph mounted on other mobile tabs', () => {
    const html = renderToStaticMarkup(
      <WorkspaceContent isDesktop={false} tab="list" onLogout={vi.fn()} />,
    );
    expect(html).not.toContain('data-testid="graph"');
  });

  it('renders only the task list when the active page has no dependency graph', () => {
    const desktop = renderToStaticMarkup(
      <WorkspaceContent isDesktop tab="graph" graphEnabled={false} onLogout={vi.fn()} />,
    );
    const mobile = renderToStaticMarkup(
      <WorkspaceContent isDesktop={false} tab="graph" graphEnabled={false} onLogout={vi.fn()} />,
    );

    expect(desktop).toContain('data-testid="list"');
    expect(desktop).not.toContain('data-testid="graph"');
    expect(desktop).toContain('workspace-mode-enter');
    expect(mobile).toContain('data-testid="list"');
    expect(mobile).not.toContain('data-testid="graph"');
  });
});
