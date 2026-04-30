import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Toaster } from '@/components/ui/toaster';
import { SplitPane } from '@/components/SplitPane';
import { ThemeProvider } from '@/features/theme/ThemeProvider';
import { ThemeSwitcher } from '@/features/theme/ThemeSwitcher';
import { ListView } from '@/features/tasks/ListView';
import { GraphView } from '@/features/graph/GraphView';
import { useTaskStore } from '@/stores/useTaskStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import { useDerived } from '@/hooks/useRecommendation';
import { cn } from '@/lib/utils';

/**
 * 布局策略：
 * - 宽屏（>=1024px，Tailwind lg 断点）：左 List / 右 Graph 双栏并列，无需切换
 * - 窄屏：Header 上显示 Tabs，点击切换 List / Graph
 */
function Header({ tab, onTab }: { tab: string; onTab: (v: string) => void }) {
  const { recommended } = useDerived();
  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-border bg-card px-4">
      <div className="flex items-center gap-2 font-semibold">
        <span className="text-[hsl(var(--primary))] text-lg">◈</span>
        <span>TodoGraph</span>
      </div>

      {/* 窄屏才显示 Tabs 切换；宽屏双栏并列不需要 */}
      <div className="lg:hidden">
        <Tabs value={tab} onValueChange={onTab}>
          <TabsList>
            <TabsTrigger value="list">列表视图</TabsTrigger>
            <TabsTrigger value="graph">依赖图</TabsTrigger>
          </TabsList>
        </Tabs>
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
    </header>
  );
}

export default function App() {
  const bootstrap = useWorkspaceStore((s) => s.bootstrap);
  const loaded = useWorkspaceStore((s) => s.loaded);
  const [tab, setTab] = useState('list');

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // 页面卸载 / 刷新前强制 flush pending 保存 —— 避免 250ms 防抖窗口内丢数据
  useEffect(() => {
    const onBeforeUnload = () => {
      void useTaskStore.getState().flush();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // 全局快捷键：Cmd/Ctrl-Z 撤销、Cmd/Ctrl-Y 或 Cmd/Ctrl-Shift-Z 重做。
  // 输入框/文本域中时不劫持。
  useEffect(() => {
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
  }, []);

  return (
    <ThemeProvider>
      <div className="flex h-full flex-col">
        <Header tab={tab} onTab={setTab} />

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
            <div className="lg:hidden flex-1 min-h-0">
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
