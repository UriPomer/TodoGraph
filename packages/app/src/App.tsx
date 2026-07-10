import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Bot,
  ChevronRight,
  Download,
  FileDown,
  FileUp,
  Key,
  ListChecks,
  Lock,
  MoreHorizontal,
  Network,
  Shield,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Toaster } from '@/components/ui/toaster';
import { DialogContainer } from '@/components/ui/dialog-container';
import { PageBar } from '@/components/PageBar';
import { SplitPane } from '@/components/SplitPane';
import { ThemeProvider } from '@/features/theme/ThemeProvider';
import { ThemeSwitcher } from '@/features/theme/ThemeSwitcher';
import { McpSetupButton, McpSetupDialog } from '@/features/mcp/McpSetupDialog';
import { SecurityButton, SecurityDialog } from '@/features/security/SecurityDialog';
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
export const DESKTOP_HEADER_CLASS_NAME =
  'hidden h-12 shrink-0 items-center gap-4 border-b border-border bg-card px-4 text-foreground lg:flex';

function Header({
  onTab,
  user,
  onLogout,
}: {
  tab: MobileTab;
  onTab: (v: MobileTab) => void;
  user: { username: string };
  onLogout: () => void;
}) {
  const { recommended } = useDerived();
  return (
    <header
      data-desktop-header="true"
      className={DESKTOP_HEADER_CLASS_NAME}
    >
      <div className="flex items-center gap-2 font-semibold">
        <span className="text-[#8b5cf6] text-lg">◈</span>
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
          'ml-auto hidden lg:flex max-w-[50vw] items-center gap-1.5 overflow-hidden rounded-md border border-border bg-background px-3 py-1.5 text-xs',
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

      <div className="ml-auto hidden items-center gap-2 lg:flex">
        <SecurityButton />
        <McpSetupButton />
        <ThemeSwitcher />
        <button
          onClick={async () => {
            try {
              await useTaskStore.getState().flush();
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
      </div>
    </header>
  );
}

type MobileTab = 'list' | 'graph' | 'more';

interface MobileMorePanelProps {
  username: string;
  onOpenSecurity: () => void;
  onOpenMcp: () => void;
  onLogout: () => void;
}

function MoreRow({
  icon: Icon,
  label,
  value,
  danger,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  value?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-14 w-full items-center gap-3 border-b border-[#312d35] px-4 text-left last:border-b-0 active:bg-[#25212b]"
    >
      <Icon className="h-5 w-5 shrink-0 text-[#9ca3af]" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-[#e5e7eb]">{label}</span>
      {value && (
        <span className={cn('shrink-0 text-xs', danger ? 'text-red-300' : 'text-[#9ca3af]')}>
          {value}
        </span>
      )}
      <ChevronRight className="h-4 w-4 shrink-0 text-[#77717d]" />
    </button>
  );
}

function MoreSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 px-1 text-xs font-medium text-[#8b8491]">{title}</h2>
      <div className="overflow-hidden rounded-lg border border-[#312d35] bg-[#1b181f] shadow-[0_10px_30px_rgba(0,0,0,0.22)]">{children}</div>
    </section>
  );
}

export function MobileMorePanel({ username, onOpenSecurity, onOpenMcp, onLogout }: MobileMorePanelProps) {
  return (
    <div data-mobile-surface="dark" className="h-full overflow-auto bg-[#151317] px-4 py-4">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-[#f3f4f6]">更多</h1>
          <p className="mt-1 text-xs text-[#8b8491]">{username}</p>
        </div>
        <ThemeSwitcher />
      </div>

      <div className="space-y-5">
        <MoreSection title="安全">
          <MoreRow icon={Shield} label="账号安全" value="存在风险" danger onClick={onOpenSecurity} />
          <MoreRow icon={Lock} label="修改密码" onClick={onOpenSecurity} />
          <MoreRow icon={Key} label="会话管理" value="当前会话" onClick={onOpenSecurity} />
        </MoreSection>

        <MoreSection title="数据">
          <MoreRow icon={Download} label="数据备份" value="自动备份中" onClick={onOpenSecurity} />
          <MoreRow icon={FileDown} label="导出 JSON" onClick={onOpenSecurity} />
          <MoreRow icon={FileUp} label="导入 JSON" onClick={onOpenSecurity} />
        </MoreSection>

        <MoreSection title="集成与 AI">
          <MoreRow icon={Bot} label="AI 接入" value="已连接" onClick={onOpenMcp} />
          <MoreRow icon={Key} label="MCP Key" value="已配置" onClick={onOpenMcp} />
        </MoreSection>

        <MoreSection title="账号">
          <MoreRow icon={Shield} label="退出登录" onClick={onLogout} />
        </MoreSection>
      </div>
    </div>
  );
}

export function MobileBottomNav({ tab, onTab }: { tab: MobileTab; onTab: (tab: MobileTab) => void }) {
  const itemClass = (value: MobileTab) =>
    cn(
      'flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] transition-colors',
      tab === value ? 'text-[#20d1aa]' : 'text-[#8b8491]',
    );

  return (
    <div
      data-mobile-chrome="dark"
      className="lg:hidden fixed bottom-0 left-0 right-0 z-40 flex border-t border-[#312d35] bg-[#17151a]/95 shadow-[0_-10px_30px_rgba(0,0,0,0.28)] backdrop-blur"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <button type="button" onClick={() => onTab('list')} className={itemClass('list')} aria-label="任务">
        <ListChecks className="h-5 w-5" />
        任务
      </button>
      <button type="button" onClick={() => onTab('graph')} className={itemClass('graph')} aria-label="依赖图">
        <Network className="h-5 w-5" />
        依赖图
      </button>
      <button type="button" onClick={() => onTab('more')} className={itemClass('more')} aria-label="更多">
        <MoreHorizontal className="h-5 w-5" />
        更多
      </button>
    </div>
  );
}

export default function App() {
  const bootstrap = useWorkspaceStore((s) => s.bootstrap);
  const loaded = useWorkspaceStore((s) => s.loaded);
  const [tab, setTab] = useState<MobileTab>('list');
  const [securityOpen, setSecurityOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);

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

  // 全局 hover 水滴透镜：任何带 data-lens 的元素 hover 时，磨砂层挖洞露出锐利背景
  useEffect(() => {
    let current: HTMLElement | null = null;
    let hideTimer: ReturnType<typeof setTimeout>;
    const s = document.documentElement.style;

    const show = (el: HTMLElement) => {
      if (el === current) return;
      current = el;
      clearTimeout(hideTimer);
      const r = el.getBoundingClientRect();
      s.setProperty('--hole-x', (r.left + r.width / 2) + 'px');
      s.setProperty('--hole-y', (r.top + r.height / 2) + 'px');
      s.setProperty('--hole-r', '100px');
    };

    const hide = () => {
      current = null;
      // 延迟消失，防止在子元素间移动时闪烁
      hideTimer = setTimeout(() => {
        s.setProperty('--hole-x', '-500px');
      }, 100);
    };

    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest('[data-lens]') as HTMLElement | null;
      if (el) show(el);
      else hide();
    };

    document.addEventListener('mouseover', onOver, { passive: true });
    return () => {
      document.removeEventListener('mouseover', onOver);
      clearTimeout(hideTimer);
    };
  }, []);

  // 修复 iOS Safari sticky hover
  useEffect(() => {
    const noop = () => {};
    document.addEventListener('touchstart', noop, { passive: true });
    return () => document.removeEventListener('touchstart', noop);
  }, []);

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
        <div className={tab === 'more' ? 'hidden lg:block' : undefined}>
          <PageBar />
        </div>

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

            {/* ===== 窄屏：底部导航切换，主体保持当前产品的暗色图谱/列表风格 ===== */}
            <div className="mobile-frosted-bg lg:hidden flex-1 min-h-0" style={{ paddingBottom: 'calc(3rem + env(safe-area-inset-bottom))' }}>
              <Tabs value={tab} onValueChange={(value) => setTab(value as MobileTab)} className="h-full">
                <TabsContent value="list" className="h-full m-0 overflow-auto">
                  <ListView />
                </TabsContent>
                <TabsContent value="graph" className="h-full m-0">
                  <GraphView />
                </TabsContent>
                <TabsContent value="more" className="h-full m-0">
                  <MobileMorePanel
                    username={user.username}
                    onOpenSecurity={() => setSecurityOpen(true)}
                    onOpenMcp={() => setMcpOpen(true)}
                    onLogout={logout}
                  />
                </TabsContent>
              </Tabs>
            </div>
          </>
        )}

        <Toaster />
        <DialogContainer />
        <SecurityDialog open={securityOpen} onClose={() => setSecurityOpen(false)} />
        <McpSetupDialog open={mcpOpen} onClose={() => setMcpOpen(false)} />
      </div>
      <MobileBottomNav tab={tab} onTab={setTab} />
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
