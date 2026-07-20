import { useEffect, useState, type ReactNode } from 'react';
import { Download, ListChecks, LogOut, MoreHorizontal, Network, Sparkles } from 'lucide-react';
import { api } from '@/api/client';
import { DialogContainer } from '@/components/ui/dialog-container';
import { Toaster } from '@/components/ui/toaster';
import { PageBar } from '@/components/PageBar';
import { SplitPane } from '@/components/SplitPane';
import { GraphView } from '@/features/graph/GraphView';
import { McpSetupButton, McpSetupDialog } from '@/features/mcp/McpSetupDialog';
import { SecurityButton, SecurityDialog } from '@/features/security/SecurityDialog';
import { ListView } from '@/features/tasks/ListView';
import { ThemeSwitcher } from '@/features/theme/ThemeSwitcher';
import { useDerived } from '@/hooks/useRecommendation';
import { cn } from '@/lib/utils';
import { useTaskStore } from '@/stores/useTaskStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';

type MobileTab = 'list' | 'graph' | 'more';

export function DesktopHeaderShell({ children }: { children: ReactNode }) {
  return <header data-desktop-header="true" className="hidden h-12 shrink-0 items-center gap-4 border-b border-border bg-card px-4 text-foreground lg:flex">{children}</header>;
}

function Header({ onTab, user, onLogout, onOpenSecurity, onOpenMcp }: {
  onTab: (tab: MobileTab) => void;
  user: { username: string };
  onLogout: () => void;
  onOpenSecurity: () => void;
  onOpenMcp: () => void;
}) {
  const { recommended } = useDerived();
  const jumpToRecommendation = () => {
    if (!recommended) return;
    onTab('list');
    window.setTimeout(() => document.querySelector(`[data-task-id="${recommended.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  };
  const exportMarkdown = async () => {
    try {
      await useTaskStore.getState().flush();
      const anchor = document.createElement('a');
      anchor.href = URL.createObjectURL(new Blob([await api.exportMarkdown()], { type: 'text/markdown' }));
      anchor.download = `TodoGraph-${new Date().toISOString().slice(0, 10)}.md`;
      anchor.click();
      URL.revokeObjectURL(anchor.href);
    } catch { /* save error is already shown */ }
  };
  return (
    <DesktopHeaderShell>
      <div className="flex items-center gap-2 font-semibold"><span className="text-lg text-[#8b5cf6]">◈</span>TodoGraph</div>
      <button onClick={jumpToRecommendation} disabled={!recommended} className="ml-auto hidden max-w-[50vw] items-center gap-1.5 overflow-hidden rounded-md border border-border bg-background px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50 lg:flex">
        <Sparkles className="h-3.5 w-3.5 text-[hsl(var(--success))]" />
        <span className="text-muted-foreground">推荐：</span><span className="truncate font-medium text-[hsl(var(--success))]">{recommended?.title ?? '—'}</span>
      </button>
      <div className="ml-auto hidden items-center gap-2 lg:flex">
        <SecurityButton onClick={onOpenSecurity} /><McpSetupButton onClick={onOpenMcp} /><ThemeSwitcher />
        <button onClick={() => void exportMarkdown()} className="text-muted-foreground hover:text-foreground" title="导出 Markdown"><Download className="h-4 w-4" /></button>
        <span className="text-xs text-muted-foreground">{user.username}</span>
        <button onClick={onLogout} className="text-xs text-muted-foreground hover:text-foreground">退出</button>
      </div>
    </DesktopHeaderShell>
  );
}

export function MobileMoreHeader({ username }: { username: string }) {
  return <header data-mobile-more-header="true" className="flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-2 lg:hidden"><div className="flex h-9 min-w-0 flex-1 items-center px-2.5"><span className="text-sm font-medium text-foreground">更多</span><span className="ml-2 truncate text-xs text-muted-foreground">{username}</span></div><ThemeSwitcher /></header>;
}

export function MobileMorePanel({ onLogout, username }: { onLogout: () => void; username?: string }) {
  return <div data-mobile-surface="dark" className="h-full overflow-auto bg-[#151317]/60 px-5 text-[#e5e7eb] backdrop-blur-sm"><div className="mx-auto max-w-lg divide-y divide-white/10"><SecurityDialog open embedded username={username} /><McpSetupDialog open embedded /><button type="button" onClick={onLogout} className="flex w-full items-center gap-2 py-6 text-sm text-red-300 transition-colors active:text-red-200"><LogOut className="h-4 w-4" />退出登录</button></div></div>;
}

const navItems = [['list', ListChecks, '任务'], ['graph', Network, '依赖图'], ['more', MoreHorizontal, '更多']] as const;
export function MobileBottomNav({ tab, onTab, graphEnabled = true }: { tab: MobileTab; onTab: (tab: MobileTab) => void; graphEnabled?: boolean }) {
  return <nav data-mobile-chrome="dark" className="fixed bottom-0 left-0 right-0 z-40 flex border-t border-[#312d35] bg-[#17151a]/95 shadow-[0_-10px_30px_rgba(0,0,0,0.28)] backdrop-blur lg:hidden" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>{navItems.map(([value, Icon, label]) => { const disabled = value === 'graph' && !graphEnabled; return <button key={value} type="button" disabled={disabled} onClick={() => !disabled && onTab(value)} className={cn('flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px]', disabled ? 'text-[#5f5964]' : tab === value ? 'text-[#20d1aa]' : 'text-[#8b8491]')} aria-label={label}><Icon className="h-5 w-5" />{label}</button>; })}</nav>;
}

function useWorkspaceEffects() {
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      const store = useTaskStore.getState();
      if (!store.hasPendingSave()) return;
      event.preventDefault(); event.returnValue = '';
      void store.flush().catch(() => {});
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea') || target?.isContentEditable || !(event.metaKey || event.ctrlKey)) return;
      if (event.key === 'z' && !event.shiftKey) { event.preventDefault(); useTaskStore.getState().undo(); }
      else if (event.key === 'y' || (event.shiftKey && event.key === 'z')) { event.preventDefault(); useTaskStore.getState().redo(); }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);
  useEffect(() => {
    let current: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const style = document.documentElement.style;
    const mouseover = (event: MouseEvent) => {
      const element = (event.target as HTMLElement).closest('[data-lens]') as HTMLElement | null;
      if (element && element !== current) {
        current = element; clearTimeout(timer);
        const rect = element.getBoundingClientRect();
        style.setProperty('--hole-x', `${rect.left + rect.width / 2}px`);
        style.setProperty('--hole-y', `${rect.top + rect.height / 2}px`);
        style.setProperty('--hole-r', '100px');
      } else if (!element) {
        current = null; timer = setTimeout(() => style.setProperty('--hole-x', '-500px'), 100);
      }
    };
    document.addEventListener('mouseover', mouseover, { passive: true });
    return () => { document.removeEventListener('mouseover', mouseover); clearTimeout(timer); };
  }, []);
  useEffect(() => {
    const noop = () => {};
    document.addEventListener('touchstart', noop, { passive: true });
    return () => document.removeEventListener('touchstart', noop);
  }, []);
  useEffect(() => {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void (async () => {
        await useTaskStore.getState().flush();
        const store = useTaskStore.getState();
        if (!store.backupDirty || !store.activePageId) return;
        const { activePageId, backupRevision } = store;
        await api.createBackup(activePageId);
        useTaskStore.getState().markBackupDone(activePageId, backupRevision);
      })().catch(console.warn).finally(() => { running = false; });
    }, 60_000);
    return () => clearInterval(timer);
  }, []);
}

function useDesktopLayout() {
  const [isDesktop, setIsDesktop] = useState(() => typeof window === 'undefined' || !window.matchMedia ? true : window.matchMedia('(min-width: 1024px)').matches);
  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia('(min-width: 1024px)');
    const update = () => setIsDesktop(query.matches);
    update(); query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return isDesktop;
}

export function WorkspaceContent({ isDesktop, tab, onLogout, graphEnabled = true, username }: { isDesktop: boolean; tab: MobileTab; onLogout: () => void; graphEnabled?: boolean; username?: string }) {
  if (isDesktop) return <div className="min-h-0 flex-1"><div key={graphEnabled ? 'graph' : 'list'} className="workspace-mode-enter h-full">{graphEnabled ? <SplitPane storageKey="todograph.splitLeftWidth" defaultLeftWidth={360} minLeft={260} maxLeft={720} left={<ListView />} right={<GraphView viewportScope="desktop" />} /> : <ListView />}</div></div>;
  const visibleTab = !graphEnabled && tab === 'graph' ? 'list' : tab;
  return <main data-mobile-tab={visibleTab} className="mobile-frosted-bg min-h-0 flex-1" style={{ paddingBottom: 'calc(3rem + env(safe-area-inset-bottom))' }}><div key={visibleTab} className="workspace-mode-enter h-full">{visibleTab === 'list' && <div className="h-full overflow-auto"><ListView /></div>}{visibleTab === 'graph' && <div className="h-full"><GraphView viewportScope="mobile" /></div>}{visibleTab === 'more' && <MobileMorePanel onLogout={onLogout} username={username} />}</div></main>;
}

function LoadingState() {
  return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">加载中...</div>;
}

export default function WorkspaceApp({ user, logout }: {
  user: { id: string; username: string };
  logout: () => Promise<void>;
}) {
  const bootstrap = useWorkspaceStore((state) => state.bootstrap);
  const workspaceUserId = useWorkspaceStore((state) => state.sessionUserId);
  const loaded = useWorkspaceStore((state) => state.loaded);
  const meta = useWorkspaceStore((state) => state.meta);
  const [tab, setTab] = useState<MobileTab>('list');
  const [securityOpen, setSecurityOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const isDesktop = useDesktopLayout();
  const graphEnabled = meta?.pages.find((page) => page.id === meta.activePageId)?.kind !== 'hierarchy';
  useWorkspaceEffects();
  useEffect(() => {
    if (workspaceUserId !== user.id) void bootstrap(user.id);
  }, [bootstrap, user.id, workspaceUserId]);
  useEffect(() => {
    if (!graphEnabled && tab === 'graph') setTab('list');
  }, [graphEnabled, tab]);
  const logoutSafely = async () => {
    try { await useTaskStore.getState().flush(); await logout(); } catch { /* save error is already shown */ }
  };
  const ready = loaded && workspaceUserId === user.id;
  return <><div className="flex h-full flex-col"><Header onTab={setTab} user={user} onLogout={() => void logoutSafely()} onOpenSecurity={() => setSecurityOpen(true)} onOpenMcp={() => setMcpOpen(true)} /><div className={tab === 'more' ? 'hidden lg:block' : undefined}><PageBar onModeChange={() => setTab('list')} /></div>{tab === 'more' && <MobileMoreHeader username={user.username} />}{ready ? <WorkspaceContent isDesktop={isDesktop} tab={tab} graphEnabled={graphEnabled} username={user.username} onLogout={() => void logoutSafely()} /> : <LoadingState />}<Toaster /><DialogContainer /><SecurityDialog open={securityOpen} username={user.username} onClose={() => setSecurityOpen(false)} /><McpSetupDialog open={mcpOpen} onClose={() => setMcpOpen(false)} /></div><MobileBottomNav tab={tab} graphEnabled={graphEnabled} onTab={setTab} /></>;
}
