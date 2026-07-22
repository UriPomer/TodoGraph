import { useMemo } from 'react';
import { ArrowRight } from 'lucide-react';
import type { AllTasksItem } from '@todograph/shared';
import { useTaskStore } from '@/stores/useTaskStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';

export function selectCrossPageReadyTasks(
  allTasks: AllTasksItem[],
  activePageId: string | null,
) {
  return allTasks.filter(
    (task) => task._pageId !== activePageId && task._ready && !task.parentId,
  );
}

export function CrossPageReady() {
  const activePageId = useTaskStore((s) => s.activePageId);
  const allTasks = useWorkspaceStore((s) => s.allTasks);
  const switchPage = useWorkspaceStore((s) => s.switchPage);

  const ready = useMemo(
    () => selectCrossPageReadyTasks(allTasks, activePageId),
    [allTasks, activePageId],
  );

  if (ready.length === 0) return null;

  const byPage = new Map<string, { title: string; tasks: AllTasksItem[] }>();
  for (const t of ready) {
    const entry = byPage.get(t._pageId);
    if (entry) {
      entry.tasks.push(t);
    } else {
      byPage.set(t._pageId, { title: t._pageTitle, tasks: [t] });
    }
  }

  return (
    <section className="pt-4 pb-8">
      <h3 className="mb-1 flex items-baseline gap-2 px-3 text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
        <span>其他页面可做</span>
      </h3>
      {[...byPage.entries()].map(([pageId, { title, tasks }]) => (
        <div key={pageId} className="mb-2">
          <p className="px-3 py-0.5 text-xs text-muted-foreground/60">{title}</p>
          <ul className="flex flex-col">
            {tasks.map((t) => (
              <li key={t.id} className="mb-0.5">
                <button
                  data-lens
                  onClick={() => switchPage(pageId)}
                  className="w-full flex items-center gap-2 text-left py-1.5 pr-2 rounded-xl lg:hover:bg-foreground/5 transition-colors duration-200"
                  style={{ paddingLeft: '12px' }}
                >
                  {/* 对齐 TaskItem.tsx 中 depth=0 的文本起始位置：spacer(10px) + dot(14px) + gap(8px) = 32px。
                      如果 TaskItem 的 status dot 或 spacer 尺寸改动，这里需同步。 */}
                  <span className="shrink-0 w-[10px]" />
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/55" />
                  <span className="flex-1 min-w-0 truncate text-sm">{t.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
