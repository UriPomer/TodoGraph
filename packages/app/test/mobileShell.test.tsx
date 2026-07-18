import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  DesktopHeaderShell,
  MobileBottomNav,
  MobileMoreHeader,
  MobileMorePanel,
} from '../src/features/workspace/WorkspaceApp';
import { ThemeProvider } from '../src/features/theme/ThemeProvider';

describe('mobile shell', () => {
  it('hides the TodoGraph header below the desktop breakpoint', () => {
    const html = renderToStaticMarkup(<DesktopHeaderShell>TodoGraph</DesktopHeaderShell>);
    expect(html).toContain('data-desktop-header="true"');
    expect(html).toMatch(/<header[^>]*class="[^"]*hidden[^"]*lg:flex[^"]*"/);
  });

  it('renders the three bottom tabs from the mobile mockup', () => {
    const html = renderToStaticMarkup(<MobileBottomNav tab="more" onTab={vi.fn()} />);
    expect(html).toContain('任务');
    expect(html).toContain('依赖图');
    expect(html).toContain('更多');
    expect(html).toContain('aria-label="更多"');
  });

  it('puts account, data, and MCP controls directly on the more page', () => {
    const html = renderToStaticMarkup(
      <ThemeProvider><MobileMorePanel onLogout={vi.fn()} /></ThemeProvider>,
    );
    expect(html).toContain('账号与数据');
    expect(html).toContain('修改密码');
    expect(html).not.toContain('会话管理');
    expect(html).toContain('当前页备份');
    expect(html).toContain('导出 JSON');
    expect(html).toContain('导入 JSON');
    expect(html).toContain('AI Agent 接入');
    expect(html).toContain('生成新 Key');
    expect(html).not.toContain('shadow-[0_10px_30px');
  });

  it('matches the page selector chrome and shows the username in the more header', () => {
    const html = renderToStaticMarkup(
      <ThemeProvider><MobileMoreHeader username="codex" /></ThemeProvider>,
    );
    expect(html).toContain('data-mobile-more-header="true"');
    expect(html).toContain('border-b border-border bg-card px-3 py-2');
    expect(html).toContain('更多');
    expect(html).toContain('codex');
  });

  it('uses the dark product surface for mobile chrome', () => {
    const navHtml = renderToStaticMarkup(<MobileBottomNav tab="graph" onTab={vi.fn()} />);
    const moreHtml = renderToStaticMarkup(
      <ThemeProvider><MobileMorePanel onLogout={vi.fn()} /></ThemeProvider>,
    );
    expect(navHtml).toContain('data-mobile-chrome="dark"');
    expect(navHtml).toContain('bg-[#17151a]');
    expect(moreHtml).toContain('data-mobile-surface="dark"');
    expect(moreHtml).toContain('bg-[#151317]/60');
    expect(moreHtml).toContain('backdrop-blur-sm');
  });
});
