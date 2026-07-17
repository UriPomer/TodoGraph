import { useEffect, useState, type ReactNode } from 'react';
import {
  Download, ListChecks, LogOut, MoreHorizontal, Network, Sparkles,
} from 'lucide-react';
import { api } from '@/api/client';
import { DialogContainer } from '@/components/ui/dialog-container';
import { Toaster } from '@/components/ui/toaster';
import { PageBar } from '@/components/PageBar';
import { SplitPane } from '@/components/SplitPane';
import { useAuth } from '@/features/auth/useAuth';
import { LoginPage } from '@/features/auth/LoginPage';
import { GraphView } from '@/features/graph/GraphView';
import { McpSetupButton, McpSetupDialog } from '@/features/mcp/McpSetupDialog';
import { SecurityButton, SecurityDialog } from '@/features/security/SecurityDialog';
import { ListView } from '@/features/tasks/ListView';
import { ThemeProvider } from '@/features/theme/ThemeProvider';
import { ThemeSwitcher } from '@/features/theme/ThemeSwitcher';
import { useDerived } from '@/hooks/useRecommendation';
import { cn } from '@/lib/utils';
import { useTaskStore } from '@/stores/useTaskStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';

type MobileTab = 'list' | 'graph' | 'more';

export function DesktopHeaderShell({ children }: { children: ReactNode }) {
  return <header data-desktop-header="true" className="hidden h-12 shrink-0 items-center gap-4 border-b border-border bg-card px-4 text-foreground lg:flex">{children}</header>;
}

interface HeaderProps { onTab: (tab: MobileTab) => void; user: { username: string }; onLogout: () => void; onOpenSecurity: () => void; onOpenMcp: () => void }

function Header({ onTab, user, onLogout, onOpenSecurity, onOpenMcp }: HeaderProps) {
  const { recommended } = useDerived();
  const jumpToRecommendation = () => {
    if (!recommended) return;
    onTab('list');
    window.setTimeout(() => document.querySelector(`[data-task-id="${recommended.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  };
  const exportMarkdown = async () => {
    try {
      await useTaskStore.getState().flush();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([await api.exportMarkdown()], { type: 'text/markdown' }));
      a.download = `TodoGraph-${new Date().toISOString().slice(0, 10)}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch { /* user can retry */ }
  };
  return (
    <DesktopHeaderShell>
      <div className="flex items-center gap-2 font-semibold"><span className="text-lg text-[#8b5cf6]">◈</span>TodoGraph</div>
      <button onClick={jumpToRecommendation} disabled={!recommended} className="ml-auto hidden max-w-[50vw] items-center gap-1.5 overflow-hidden rounded-md border border-border bg-background px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50 lg:flex">
        <Sparkles className="h-3.5 w-3.5 text-[hsl(var(--success))]" />
        <span className="text-muted-foreground">推荐：</span><span className="truncate font-medium text-[hsl(var(--success))]">{recommended?.title ?? '—'}</span>
      </button>
      <div className="ml-auto hidden items-center gap-2 lg:flex">
        <SecurityButton onClick={onOpenSecurity} />
        <McpSetupButton onClick={onOpenMcp} />
        <ThemeSwitcher />
        <button onClick={() => void exportMarkdown()} className="text-muted-foreground hover:text-foreground" title="导出 Markdown"><Download className="h-4 w-4" /></button>
        <span className="text-xs text-muted-foreground">{user.username}</span>
        <button onClick={onLogout} className="text-xs text-muted-foreground hover:text-foreground">退出</button>
      </div>
    </DesktopHeaderShell>
  );
}

export function MobileMoreHeader({ username }: { username: string }) {
  return (
    <header data-mobile-more-header="true" className="flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-2 lg:hidden">
      <div className="flex h-9 min-w-0 flex-1 items-center px-2.5">
        <span className="text-sm font-medium text-foreground">更多</span>
        <span className="ml-2 truncate text-xs text-muted-foreground">{username}</span>
      </div>
      <ThemeSwitcher />
    </header>
  );
}

export function MobileMorePanel({ onLogout }: { onLogout: () => void }) {
  return (
    <div data-mobile-surface="dark" className="h-full overflow-auto bg-[#151317]/60 px-5 text-[#e5e7eb] backdrop-blur-sm">
      <div className="mx-auto max-w-lg divide-y divide-white/10">
        <SecurityDialog open embedded />
        <McpSetupDialog open embedded />
        <button type="button" onClick={onLogout} className="flex w-full items-center gap-2 py-6 text-sm text-red-300 transition-colors active:text-red-200">
          <LogOut className="h-4 w-4" />退出登录
        </button>
      </div>
    </div>
  );
}

const navItems = [['list', ListChecks, '任务'], ['graph', Network, '依赖图'], ['more', MoreHorizontal, '更多']] as const;
export function MobileBottomNav({ tab, onTab }: { tab: MobileTab; onTab: (tab: MobileTab) => void }) {
  return (
    <nav data-mobile-chrome="dark" className="fixed bottom-0 left-0 right-0 z-40 flex border-t border-[#312d35] bg-[#17151a]/95 shadow-[0_-10px_30px_rgba(0,0,0,0.28)] backdrop-blur lg:hidden" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {navItems.map(([value, Icon, label]) => <button key={value} type="button" onClick={() => onTab(value)} className={cn('flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px]', tab === value ? 'text-[#20d1aa]' : 'text-[#8b8491]')} aria-label={label}><Icon className="h-5 w-5" />{label}</button>)}
    </nav>
  );
}

function useAppEffects(user: { id: string } | null) {
  useEffect(() => {
    if (!user) return;
    const unload = (event: BeforeUnloadEvent) => {
      const store = useTaskStore.getState();
      if (!store.hasPendingSave()) return;
      event.preventDefault(); event.returnValue = '';
      void store.flush().catch(() => {});
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [user]);
  useEffect(() => {
    if (!user) return;
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea') || target?.isContentEditable || !(event.metaKey || event.ctrlKey)) return;
      if (event.key === 'z' && !event.shiftKey) { event.preventDefault(); useTaskStore.getState().undo(); }
      else if (event.key === 'y' || (event.shiftKey && event.key === 'z')) { event.preventDefault(); useTaskStore.getState().redo(); }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [user]);
  useEffect(() => {
    let current: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const style = document.documentElement.style;
    const mouseover = (event: MouseEvent) => {
      const element = (event.target as HTMLElement).closest('[data-lens]') as HTMLElement | null;
      if (element && element !== current) {
        current = element;
        clearTimeout(timer);
        const rect = element.getBoundingClientRect();
        style.setProperty('--hole-x', `${rect.left + rect.width / 2}px`);
        style.setProperty('--hole-y', `${rect.top + rect.height / 2}px`);
        style.setProperty('--hole-r', '100px');
      } else if (!element) {
        current = null;
        timer = setTimeout(() => style.setProperty('--hole-x', '-500px'), 100);
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
    if (!user) return;
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
  }, [user]);
}

function useDesktopLayout() {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window === 'undefined' || !window.matchMedia
      ? true
      : window.matchMedia('(min-width: 1024px)').matches,
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia('(min-width: 1024px)');
    const update = () => setIsDesktop(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return isDesktop;
}

export function WorkspaceContent({
  isDesktop,
  tab,
  onLogout,
}: {
  isDesktop: boolean;
  tab: MobileTab;
  onLogout: () => void;
}) {
  if (isDesktop) {
    return (
      <div className="min-h-0 flex-1">
        <SplitPane storageKey="todograph.splitLeftWidth" defaultLeftWidth={360} minLeft={260} maxLeft={720} left={<ListView />} right={<GraphView viewportScope="desktop" />} />
      </div>
    );
  }
  return (
    <main data-mobile-tab={tab} className="mobile-frosted-bg min-h-0 flex-1" style={{ paddingBottom: 'calc(3rem + env(safe-area-inset-bottom))' }}>
      {tab === 'list' && <div className="h-full overflow-auto"><ListView /></div>}
      {tab === 'graph' && <div className="h-full"><GraphView viewportScope="mobile" /></div>}
      {tab === 'more' && <MobileMorePanel onLogout={onLogout} />}
    </main>
  );
}

export default function App() {
  const { user, loading, login, register, logout } = useAuth();
  const bootstrap = useWorkspaceStore((state) => state.bootstrap);
  const resetSession = useWorkspaceStore((state) => state.resetSession);
  const workspaceUserId = useWorkspaceStore((state) => state.sessionUserId);
  const loaded = useWorkspaceStore((state) => state.loaded);
  const [tab, setTab] = useState<MobileTab>('list');
  const [securityOpen, setSecurityOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const isDesktop = useDesktopLayout();
  const logoutSafely = async () => {
    try { await useTaskStore.getState().flush(); await logout(); } catch { /* save error is already shown */ }
  };
  useAppEffects(user);
  useEffect(() => {
    if (loading) return;
    if (!user) { if (workspaceUserId !== null) resetSession(); }
    else if (workspaceUserId !== user.id) void bootstrap(user.id);
  }, [bootstrap, loading, resetSession, user, workspaceUserId]);
  if (loading) return <LoadingState />;
  if (!user) return <LoginPage onLogin={login} onRegister={register} />;
  const ready = loaded && workspaceUserId === user.id;
  return (
    <ThemeProvider>
      <div className="flex h-full flex-col">
        <Header onTab={setTab} user={user} onLogout={() => void logoutSafely()} onOpenSecurity={() => setSecurityOpen(true)} onOpenMcp={() => setMcpOpen(true)} />
        <div className={tab === 'more' ? 'hidden lg:block' : undefined}><PageBar /></div>
        {tab === 'more' && <MobileMoreHeader username={user.username} />}
        {!ready
          ? <LoadingState />
          : <WorkspaceContent isDesktop={isDesktop} tab={tab} onLogout={() => void logoutSafely()} />}
        <Toaster /><DialogContainer />
        <SecurityDialog open={securityOpen} onClose={() => setSecurityOpen(false)} />
        <McpSetupDialog open={mcpOpen} onClose={() => setMcpOpen(false)} />
      </div>
      <MobileBottomNav tab={tab} onTab={setTab} />
    </ThemeProvider>
  );
}

function LoadingState() {
  return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">加载中...</div>;
}
