import { useEffect, useState } from 'react';
import { Download, Sparkles } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Toaster } from '@/components/ui/toaster';
import { PageBar } from '@/components/PageBar';
import { SplitPane } from '@/components/SplitPane';
import { ThemeProvider } from '@/features/theme/ThemeProvider';
import { ThemeSwitcher } from '@/features/theme/ThemeSwitcher';
import { ListView } from '@/features/tasks/ListView';
import { GraphView } from '@/features/graph/GraphView';
import { useTaskStore } from '@/stores/useTaskStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import { useDerived } from '@/hooks/useRecommendation';
import { api } from '@/api/client';
import { cn } from '@/lib/utils';
import { useAuth } from '@/features/auth/useAuth';
import { LoginPage } from '@/features/auth/LoginPage';

/**
 * 布局策略：
 * - 宽屏（>=1024px，Tailwind lg 断点）：左 List / 右 Graph 双栏并列，无需切换
 * - 窄屏：Header 上显示 Tabs，点击切换 List / Graph
 */
function Header({ tab, onTab, user, onLogout }: { tab: string; onTab: (v: string) => void; user: { username: string }; onLogout: () => void }) {
  const { recommended } = useDerived();
  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-border bg-card px-4">
      <div className="flex items-center gap-2 font-semibold">
        <span className="text-[hsl(var(--primary))] text-lg">◈</span>
        <span>TodoGraph</span>
      </div>

      <button
        onClick={() => {
          if (!recommended) return;
          // 窄屏下切到 list tab 才能看到；宽屏本身就能看到，切换无影响
          onTab('list');
          setTimeout(() => {
            const el = document.querySelector(`[data-task-id="${recommended.id}"]`);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 50);
        }}
        className={cn(
          'ml-auto flex max-w-[50vw] items-center gap-1.5 overflow-hidden rounded-md border border-border bg-background px-3 py-1.5 text-xs',
          'transition-[background-color,border-color,transform,box-shadow] duration-150 ease-out',
          'hover:bg-accent hover:border-muted-foreground/40 active:scale-[0.97]',
          !recommended && 'opacity-50 pointer-events-none',
        )}
        title={recommended ? '点击跳转' : ''}
      >
        <Sparkles className="h-3.5 w-3.5 text-[hsl(var(--success))]" />
        <span className="text-muted-foreground">推荐：</span>
        <span className="truncate font-medium text-[hsl(var(--success))]">
          {recommended?.title ?? '—'}
        </span>
      </button>

      <ThemeSwitcher />
      <button
        onClick={async () => {
          try {
            const md = await api.exportMarkdown();
            const blob = new Blob([md], { type: 'text/markdown' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `TodoGraph-${new Date().toISOString().slice(0, 10)}.md`;
            a.click();
            URL.revokeObjectURL(a.href);
          } catch { /* ignore */ }
        }}
        className="text-muted-foreground hover:text-foreground transition-colors"
        title="导出 Markdown"
      >
        <Download className="h-4 w-4" />
      </button>
      <span className="text-xs text-muted-foreground">{user.username}</span>
      <button onClick={onLogout} className="text-xs text-muted-foreground hover:text-foreground transition-colors">退出</button>
    </header>
  );
}

export default function App() {
  const bootstrap = useWorkspaceStore((s) => s.bootstrap);
  const loaded = useWorkspaceStore((s) => s.loaded);
  const [tab, setTab] = useState('list');

  // Auth gate: must check before any API calls to avoid 401 toasts on login page
  const { user, loading, login, register, logout } = useAuth();

  // ===== ALL hooks must be called before any conditional return (Rules of Hooks) =====

  useEffect(() => {
    if (!user) return;
    void bootstrap();
  }, [bootstrap, user]);

  // 页面卸载 / 刷新前强制 flush pending 保存 —— 避免 250ms 防抖窗口内丢数据
  useEffect(() => {
    if (!user) return;
    const onBeforeUnload = () => {
      void useTaskStore.getState().flush();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [user]);

  // 全局快捷键：Cmd/Ctrl-Z 撤销、Cmd/Ctrl-Y 或 Cmd/Ctrl-Shift-Z 重做。
  // 输入框/文本域中时不劫持。
  useEffect(() => {
    if (!user) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      const isText = tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable;
      if (isText) return;
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        useTaskStore.getState().undo();
      } else if (e.key === 'y' || (e.shiftKey && e.key === 'z')) {
        e.preventDefault();
        useTaskStore.getState().redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [user]);

  // 自动备份：每 60s 检查是否有新的 mutation，有则调用备份 API
  useEffect(() => {
    if (!user) return;
    const BACKUP_INTERVAL_MS = 60_000;
    const id = setInterval(() => {
      const store = useTaskStore.getState();
      if (!store.backupDirty || !store.activePageId) return;
      api.createBackup(store.activePageId).then(() => {
        store.markBackupDone();
      }).catch((err) => {
        console.warn('auto-backup failed', err);
      });
    }, BACKUP_INTERVAL_MS);
    return () => clearInterval(id);
  }, [user]);

  // ---- conditional returns after ALL hooks ----
  if (loading) return <LoadingState />;
  if (!user) return <LoginPage onLogin={login} onRegister={register} />;

  return (
    <ThemeProvider>
      <div className="flex h-full flex-col">
        <Header tab={tab} onTab={setTab} user={user} onLogout={logout} />
        <PageBar />

        {!loaded ? (
          <LoadingState />
        ) : (
          <>
            {/* ===== 宽屏：双栏并列，中间竖条可拖动调整宽度 ===== */}
            <div className="hidden lg:block flex-1 min-h-0">
              <SplitPane
                storageKey="todograph.splitLeftWidth"
                defaultLeftWidth={360}
                minLeft={260}
                maxLeft={720}
                left={<ListView />}
                right={<GraphView />}
              />
            </div>

            {/* ===== 窄屏：Tabs 切换 ===== */}
            <div className="lg:hidden flex-1 min-h-0 pb-12">
              <Tabs value={tab} onValueChange={setTab} className="h-full">
                <TabsContent value="list" className="h-full m-0 overflow-auto">
                  <ListView />
                </TabsContent>
                <TabsContent value="graph" className="h-full m-0">
                  <GraphView />
                </TabsContent>
              </Tabs>
            </div>
          </>
        )}

        <Toaster />
      </div>
      {/* Narrow-screen bottom nav bar */}
      <div className="lg:hidden fixed bottom-0 left-0 right-0 z-40 flex border-t border-border bg-card/95 backdrop-blur">
        <button
          onClick={() => setTab('list')}
          className={`flex-1 flex flex-col items-center gap-0.5 py-2 text-[11px] transition-colors ${tab === 'list' ? 'text-[hsl(var(--primary))]' : 'text-muted-foreground'}`}
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
          列表
        </button>
        <button
          onClick={() => setTab('graph')}
          className={`flex-1 flex flex-col items-center gap-0.5 py-2 text-[11px] transition-colors ${tab === 'graph' ? 'text-[hsl(var(--primary))]' : 'text-muted-foreground'}`}
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="6" cy="6" r="2" /><circle cx="18" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" /><line x1="8" y1="6" x2="16" y2="5" /><line x1="8" y1="6" x2="10" y2="12" /><line x1="16" y1="5" x2="14" y2="12" /><line x1="10" y1="12" x2="6" y2="18" /><line x1="14" y1="12" x2="18" y2="18" />
          </svg>
          依赖图
        </button>
      </div>
    </ThemeProvider>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
      加载中...
    </div>
  );
}
