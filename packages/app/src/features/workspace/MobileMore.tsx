import { useLayoutEffect, useRef, useState } from 'react';
import { ArchiveRestore, ArrowLeft, Bot, ChevronRight, LogOut, ShieldCheck, Smartphone, UserRound } from 'lucide-react';
import { AccountSecurityPanel } from '@/features/security/AccountSecurityPanel';
import { BackupPanel } from '@/features/security/BackupPanel';
import { McpSetupDialog } from '@/features/mcp/McpSetupDialog';
import { ThemeSwitcher } from '@/features/theme/ThemeSwitcher';
import { isNativeRuntime } from '@/platform/nativeSession';
import { isHapticsEnabled, setHapticsEnabled } from '@/platform/nativeInteractions';
import { cn } from '@/lib/utils';
import { ProBadge } from '@/features/product/ProDialog';
import { isLocalWorkspace } from '@/platform/workspaceRuntime';
import { SyncControl } from '@/sync/SyncControl';

export type MorePage = 'home' | 'security' | 'backups' | 'mcp';
const titles: Record<MorePage, string> = { home: '更多', security: '账号安全', backups: '备份与恢复', mcp: 'AI Agent 接入' };
const entries = [
  { page: 'security', icon: ShieldCheck, detail: '管理登录密码' },
  { page: 'backups', icon: ArchiveRestore, detail: '备份、导入导出与恢复' },
  { page: 'mcp', icon: Bot, detail: '连接你的 AI 助手' },
] as const;

export function MobileMoreHeader({ page, onBack }: { page: MorePage; onBack: () => void }) {
  const title = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { if (page !== 'home') title.current?.focus({ preventScroll: true }); }, [page]);
  return <header data-mobile-more-header="true" className="mobile-top-chrome settings-header flex items-center gap-2 px-4 md:hidden">
    {page !== 'home' && <button type="button" aria-label="返回设置" onClick={onBack} className="settings-back flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors duration-200 hover:bg-foreground/5"><ArrowLeft className="h-5 w-5" /></button>}
    <h2 ref={title} tabIndex={-1} className="min-w-0 flex-1 truncate text-lg font-semibold outline-none">{titles[page]}</h2>
    <ThemeSwitcher />
  </header>;
}

export function MobileMorePanel({ onLogout, username, page, onNavigate }: {
  onLogout: () => void; username?: string; page: MorePage; onNavigate: (page: MorePage) => void;
}) {
  const [haptics, setHaptics] = useState(isHapticsEnabled);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef<Partial<Record<MorePage, number>>>({});
  const previousPage = useRef(page);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = scrollPositions.current[page] ?? 0;
    if (page === 'home' && previousPage.current !== 'home') {
      element.querySelector<HTMLButtonElement>(`[data-more-link="${previousPage.current}"]`)?.focus({ preventScroll: true });
    }
    previousPage.current = page;
  }, [page]);
  const toggleHaptics = () => {
    const next = !haptics;
    setHaptics(next);
    setHapticsEnabled(next);
  };

  return <div key={page} ref={scrollRef} data-mobile-surface="theme-aware" data-more-page={page} className="settings-scroll h-full overflow-y-auto overscroll-contain text-card-foreground" onScroll={event => { scrollPositions.current[page] = event.currentTarget.scrollTop; }}>
    <div className={cn('settings-content mx-auto w-full max-w-lg px-4 pb-6 pt-3', page === 'home' && 'settings-home flex min-h-full flex-col')}>
      {page === 'security' && <><p className="settings-intro">保护你的账号，以及保存其中的任务。</p><AccountSecurityPanel username={username} embedded /></>}
      {page === 'backups' && <BackupPanel embedded />}
      {page === 'mcp' && <McpSetupDialog open embedded />}
      {page === 'home' && <>
        <div className="settings-account">
          <div aria-hidden="true" className="settings-account-avatar"><UserRound className="h-6 w-6" strokeWidth={1.6} /></div>
          <div className="min-w-0 flex-1">
            <p title={username} className="truncate text-[28px] font-semibold leading-tight tracking-tight">{username}</p>
            <span className="settings-account-status mt-1.5 block text-[13px] text-muted-foreground">{isLocalWorkspace() ? '仅本地' : '已登录'}</span>
            <div className="mt-3 flex items-center gap-2"><ProBadge /><SyncControl /></div>
          </div>
        </div>
        <section aria-label="工作区设置" className="settings-menu">
          {entries.filter(entry => !isLocalWorkspace() || entry.page === 'backups').map(entry => <SettingsEntry key={entry.page} entry={entry} onNavigate={onNavigate} />)}
          {isNativeRuntime() && <button type="button" role="switch" aria-checked={haptics} onClick={toggleHaptics} className="settings-entry w-full rounded-xl text-left transition-colors duration-200 hover:bg-foreground/5">
            <span className="settings-entry-symbol"><Smartphone className="settings-entry-icon" /></span><span className="flex-1 text-base font-medium">触觉反馈</span>
            <span aria-hidden="true" className={cn('relative h-6 w-11 rounded-full transition-colors', haptics ? 'bg-[hsl(var(--primary))]' : 'bg-muted')}><span className={cn('absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full shadow-sm transition-transform', haptics ? 'translate-x-6 bg-[hsl(var(--primary-foreground))]' : 'translate-x-1 bg-card')} /></span>
          </button>}
        </section>
        <footer className="mt-auto pt-8">
          <button type="button" onClick={onLogout} className="flex min-h-11 items-center gap-2.5 rounded-xl px-4 text-sm text-muted-foreground transition-colors duration-200 hover:bg-foreground/5 hover:text-destructive"><LogOut className="h-4 w-4" />退出登录</button>
        </footer>
      </>}
    </div>
  </div>;
}

function SettingsEntry({ entry, onNavigate }: { entry: typeof entries[number]; onNavigate: (page: MorePage) => void }) {
  return <button type="button" data-more-link={entry.page} aria-label={titles[entry.page]} onClick={() => onNavigate(entry.page)} className="settings-entry w-full rounded-xl text-left transition-colors duration-200 hover:bg-foreground/5">
    <span className="settings-entry-symbol"><entry.icon className="settings-entry-icon" /></span>
    <span className="min-w-0 flex-1"><span className="block text-base font-medium">{titles[entry.page]}</span><span className="mt-1 block text-[13px] font-normal text-muted-foreground">{entry.detail}</span></span>
    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
  </button>;
}
