import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/features/graph/GraphView', () => ({
  GraphView: () => <div data-testid="graph" />,
}));
vi.mock('@/features/tasks/ListView', () => ({
  ListView: () => <div data-testid="list" />,
}));
vi.mock('@/components/SplitPane', () => ({
  SplitPane: ({ left, right }: { left: ReactNode; right: ReactNode }) => <>{left}{right}</>,
}));

import { WorkspaceContent } from '../src/App';

describe('responsive workspace content', () => {
  it('mounts exactly one graph on desktop', () => {
    const html = renderToStaticMarkup(
      <WorkspaceContent isDesktop tab="graph" onLogout={vi.fn()} />,
    );
    expect(html.match(/data-testid="graph"/g)).toHaveLength(1);
  });

  it('mounts exactly one graph on the mobile graph tab', () => {
    const html = renderToStaticMarkup(
      <WorkspaceContent isDesktop={false} tab="graph" onLogout={vi.fn()} />,
    );
    expect(html.match(/data-testid="graph"/g)).toHaveLength(1);
  });

  it('does not keep a hidden graph mounted on other mobile tabs', () => {
    const html = renderToStaticMarkup(
      <WorkspaceContent isDesktop={false} tab="list" onLogout={vi.fn()} />,
    );
    expect(html).not.toContain('data-testid="graph"');
  });
});
