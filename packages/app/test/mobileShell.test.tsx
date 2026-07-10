import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_HEADER_CLASS_NAME,
  MobileBottomNav,
  MobileMorePanel,
} from '../src/App';
import { ThemeProvider } from '../src/features/theme/ThemeProvider';

describe('mobile shell', () => {
  it('hides the TodoGraph header below the desktop breakpoint', () => {
    expect(DESKTOP_HEADER_CLASS_NAME.split(' ')).toContain('hidden');
    expect(DESKTOP_HEADER_CLASS_NAME.split(' ')).toContain('lg:flex');
  });

  it('renders the three bottom tabs from the mobile mockup', () => {
    const html = renderToStaticMarkup(
      <MobileBottomNav tab="more" onTab={vi.fn()} />,
    );

    expect(html).toContain('任务');
    expect(html).toContain('依赖图');
    expect(html).toContain('更多');
    expect(html).toContain('aria-label="更多"');
  });

  it('puts security and MCP entry points under the mobile more page', () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MobileMorePanel
          username="codex"
          onOpenSecurity={vi.fn()}
          onOpenMcp={vi.fn()}
          onLogout={vi.fn()}
        />
      </ThemeProvider>,
    );

    expect(html).toContain('更多');
    expect(html).toContain('账号安全');
    expect(html).toContain('修改密码');
    expect(html).toContain('会话管理');
    expect(html).toContain('数据备份');
    expect(html).toContain('导出 JSON');
    expect(html).toContain('导入 JSON');
    expect(html).toContain('AI 接入');
    expect(html).toContain('MCP Key');
  });

  it('uses the dark product surface for mobile chrome', () => {
    const navHtml = renderToStaticMarkup(
      <MobileBottomNav tab="graph" onTab={vi.fn()} />,
    );
    const moreHtml = renderToStaticMarkup(
      <ThemeProvider>
        <MobileMorePanel
          username="codex"
          onOpenSecurity={vi.fn()}
          onOpenMcp={vi.fn()}
          onLogout={vi.fn()}
        />
      </ThemeProvider>,
    );

    expect(navHtml).toContain('data-mobile-chrome="dark"');
    expect(navHtml).toContain('bg-[#17151a]');
    expect(moreHtml).toContain('data-mobile-surface="dark"');
    expect(moreHtml).toContain('bg-[#151317]');
  });
});
