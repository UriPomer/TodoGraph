import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Download, ListChecks, MoreHorizontal, Network, Sparkles } from 'lucide-react';
import { api } from '@/api/client';
import { DialogContainer } from '@/components/ui/dialog-container';
import { Toaster } from '@/components/ui/toaster';
import { PageBar } from '@/components/PageBar';
import { SplitPane } from '@/components/SplitPane';
import { GraphView } from '@/features/graph/GraphView';
import { McpSetupButton, McpSetupDialog } from '@/features/mcp/McpSetupDialog';
import { SecurityButton, SecurityDialog } from '@/features/security/SecurityDialog';
import { MobileMoreHeader, MobileMorePanel, type MorePage } from './MobileMore';
import { cancelWorkspaceTransition, transitionWorkspace } from './workspaceTransition';
import { ListView } from '@/features/tasks/ListView';
import { ThemeSwitcher } from '@/features/theme/ThemeSwitcher';
import { useDerived } from '@/hooks/useRecommendation';
import { cn } from '@/lib/utils';
import { useTaskStore } from '@/stores/useTaskStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import { useDialogStore } from '@/components/ui/dialog-store';
import { useKeyboardVisible, useNativeBackButton, useNativeSystemBars } from '@/platform/useNativeShell';
import { ProBadge, ProDialog } from '@/features/product/ProDialog';
import { useProductStore } from '@/features/product/entitlements';
import { isLocalWorkspace } from '@/platform/workspaceRuntime';
import { canEditProductPage } from '@todograph/shared';
import { useAppearanceStore } from '@/features/theme/appearance';
import { SyncControl, SyncLifecycle } from '@/sync/SyncControl';

type MobileTab = 'list' | 'graph' | 'more';

export function takePreviousMobileTab(history: MobileTab[], graphEnabled: boolean): MobileTab | undefined {
  let previous = history.pop();
  while (previous === 'graph' && !graphEnabled) previous = history.pop();
  return previous;
}

export function DesktopHeaderShell({ children }: { children: ReactNode }) {
  return <header data-desktop-header="true" className="hidden h-12 shrink-0 items-center gap-4 border-b border-border bg-card px-4 text-foreground md:flex">{children}</header>;
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
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <ProBadge /><SyncControl />
        <SecurityButton onClick={onOpenSecurity} />{!isLocalWorkspace() && <McpSetupButton onClick={onOpenMcp} />}<ThemeSwitcher />
        <button onClick={() => void exportMarkdown()} className="text-muted-foreground hover:text-foreground" title="导出 Markdown"><Download className="h-4 w-4" /></button>
        <span className="text-xs text-muted-foreground">{user.username}</span>
        <button onClick={onLogout} className="text-xs text-muted-foreground hover:text-foreground">{isLocalWorkspace() ? '切换工作区' : '退出'}</button>
      </div>
    </DesktopHeaderShell>
  );
}

const navItems = [['list', ListChecks, '任务'], ['graph', Network, '依赖图'], ['more', MoreHorizontal, '更多']] as const;
export function MobileBottomNav({ tab, onTab, graphEnabled = true, hidden = false }: { tab: MobileTab; onTab: (tab: MobileTab) => void; graphEnabled?: boolean; hidden?: boolean }) {
  if (hidden) return null;
  return (
    <nav data-mobile-chrome="theme-aware" className="relative z-40 flex border-t border-border/60 bg-card/90 shadow-[0_-8px_24px_hsl(var(--background)/0.16)] backdrop-blur-xl md:hidden" style={{ paddingBottom: 'var(--mobile-bottom-space)' }}>
      {navItems.map(([value, Icon, label]) => {
        const disabled = value === 'graph' && !graphEnabled;
        return <button key={value} type="button" disabled={disabled} onClick={() => !disabled && onTab(value)} className={cn('flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] transition-colors', disabled ? 'text-muted-foreground/45' : tab === value ? 'text-[hsl(var(--primary))]' : 'text-muted-foreground')} aria-label={label}><Icon className="h-5 w-5" />{label}</button>;
      })}
    </nav>
  );
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
    const clearSelection = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.button !== 0 || event.shiftKey) return;
      window.getSelection()?.removeAllRanges();
    };
    document.addEventListener('pointerdown', clearSelection, true);
    return () => document.removeEventListener('pointerdown', clearSelection, true);
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
  const [isDesktop, setIsDesktop] = useState(() => typeof window === 'undefined' || !window.matchMedia ? true : window.matchMedia('(min-width: 768px)').matches);
  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia('(min-width: 768px)');
    const update = () => setIsDesktop(query.matches);
    update(); query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return isDesktop;
}

export function WorkspaceContent({ isDesktop, tab, onLogout, graphEnabled = true, username, morePage = 'home', onNavigateMore }: { isDesktop: boolean; tab: MobileTab; onLogout: () => void; graphEnabled?: boolean; username?: string; morePage?: MorePage; onNavigateMore: (page: MorePage) => void }) {
  const visibleTab = !graphEnabled && tab === 'graph' ? 'list' : tab;
  if (isDesktop) return <div className="min-h-0 flex-1"><div key={graphEnabled ? 'page' : 'checklist'} className="workspace-mode-enter h-full">{graphEnabled ? <SplitPane storageKey="todograph.splitLeftWidth" defaultLeftWidth={360} minLeft={260} maxLeft={720} left={<ListView />} right={<GraphView viewportScope="desktop" />} /> : <ListView />}</div></div>;
  return <main data-mobile-tab={visibleTab} className="mobile-frosted-bg min-h-0 flex-1"><div key={visibleTab} className="h-full">{visibleTab === 'list' && <div className="h-full overflow-auto"><ListView /></div>}{visibleTab === 'graph' && <div className="h-full"><GraphView viewportScope="mobile" /></div>}{visibleTab === 'more' && <MobileMorePanel onLogout={onLogout} username={username} page={morePage} onNavigate={onNavigateMore} />}</div></main>;
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
  const plan = useProductStore(state => state.entitlements.plan);
  const readOnly = meta ? !canEditProductPage(meta, meta.activePageId, plan) : false;
  const [tab, setTab] = useState<MobileTab>('list');
  const tabHistory = useRef<MobileTab[]>([]);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [morePage, setMorePage] = useState<MorePage>('home');
  const isDesktop = useDesktopLayout();
  const keyboardVisible = useKeyboardVisible();
  const graphEnabled = meta?.pages.find((page) => page.id === meta.activePageId)?.kind !== 'hierarchy';
  useWorkspaceEffects();
  useNativeSystemBars();
  useEffect(() => cancelWorkspaceTransition, []);
  const changeTab = useCallback((next: MobileTab) => {
    transitionWorkspace(() => {
      setMorePage('home');
      setTab(current => {
        if (current === next) return current;
        tabHistory.current.push(current);
        return next;
      });
    });
  }, []);
  const navigateMore = useCallback((next: MorePage) => {
    transitionWorkspace(() => setMorePage(next), next === 'home' ? 'pop' : 'push');
  }, []);
  useNativeBackButton(() => {
    if (securityOpen) { setSecurityOpen(false); return true; }
    if (mcpOpen) { setMcpOpen(false); return true; }
    if (useDialogStore.getState().dismissCurrent()) return true;
    if (tab === 'more' && morePage !== 'home') { navigateMore('home'); return true; }
    const previous = takePreviousMobileTab(tabHistory.current, graphEnabled);
    if (previous) { transitionWorkspace(() => { setMorePage('home'); setTab(previous); }); return true; }
    if (tab !== 'list') { changeTab('list'); return true; }
    return false;
  });
  useEffect(() => {
    if (workspaceUserId !== user.id) void (async () => { await useProductStore.getState().refresh(); await bootstrap(user.id); })();
  }, [bootstrap, user.id, workspaceUserId]);
  useEffect(() => { void useAppearanceStore.getState().load(user.id); }, [user.id]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') void useProductStore.getState().refresh(); };
    document.addEventListener('visibilitychange', refresh);
    const timer = setInterval(refresh, 60_000);
    return () => { document.removeEventListener('visibilitychange', refresh); clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!graphEnabled) {
      tabHistory.current = tabHistory.current.filter((entry) => entry !== 'graph');
      if (tab === 'graph') setTab('list');
    }
  }, [graphEnabled, tab]);
  const logoutSafely = async () => {
    try { await useTaskStore.getState().flush(); await logout(); } catch { /* save error is already shown */ }
  };
  const ready = loaded && workspaceUserId === user.id;
  return <div className="mobile-workspace-shell flex h-full flex-col">
    <Header onTab={changeTab} user={user} onLogout={() => void logoutSafely()} onOpenSecurity={() => setSecurityOpen(true)} onOpenMcp={() => setMcpOpen(true)} />
    <div data-workspace-screen className="flex min-h-0 flex-1 flex-col">
      <div className={tab === 'more' ? 'hidden md:block' : undefined}>
        <PageBar mode={isDesktop && graphEnabled ? 'graph' : tab === 'graph' ? 'graph' : 'list'} onModeChange={changeTab} />
      </div>
      {!isDesktop && tab === 'more' && <MobileMoreHeader page={morePage} onBack={() => navigateMore('home')} />}
      {readOnly && <div role="status" className="flex items-center gap-3 border-b border-border bg-card px-4 py-2 text-xs"><span className="flex-1">此页面只读，数据仍可查看和导出</span><button type="button" onClick={() => {
        if (!meta) return;
        void useWorkspaceStore.getState().reorderPages([meta.pages.find(page => page.kind === 'hierarchy')!.id, meta.activePageId, ...meta.pages.filter(page => page.kind !== 'hierarchy' && page.id !== meta.activePageId).map(page => page.id)]);
      }} className="rounded-xl px-2 py-1 hover:bg-foreground/5">设为免费可编辑页面</button><button type="button" onClick={useProductStore.getState().openPro} className="text-primary">解锁 Pro</button></div>}
      {ready ? <WorkspaceContent isDesktop={isDesktop} tab={tab} graphEnabled={graphEnabled} username={user.username} onLogout={() => void logoutSafely()} morePage={morePage} onNavigateMore={navigateMore} /> : <LoadingState />}
    </div>
    {/* The footer owns its height; feedback anchors above it, even when hidden. */}
    <div className="relative shrink-0">
      <MobileBottomNav tab={tab} graphEnabled={graphEnabled} onTab={changeTab} hidden={keyboardVisible} />
      <Toaster />
    </div>
    <DialogContainer />
    <ProDialog />
    <SyncLifecycle />
    <SecurityDialog open={securityOpen} username={user.username} onClose={() => setSecurityOpen(false)} />
    <McpSetupDialog open={mcpOpen} onClose={() => setMcpOpen(false)} />
  </div>;
}
