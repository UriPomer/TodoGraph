import type { AllTasksItem } from '@todograph/shared';
import { useTaskStore } from '@/stores/useTaskStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';

export function CrossPageReady() {
  const activePageId = useTaskStore((s) => s.activePageId);
  const allTasks = useWorkspaceStore((s) => s.allTasks);
  const switchPage = useWorkspaceStore((s) => s.switchPage);

  const ready = allTasks.filter(
    (t) => t._pageId !== activePageId && t._ready && !t.parentId,
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
    <section className="mt-6">
      <h3 className="mb-1 flex items-baseline gap-2 px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
        <span>其他页面可做</span>
      </h3>
      {[...byPage.entries()].map(([pageId, { title, tasks }]) => (
        <div key={pageId} className="mb-2">
          <p className="px-2 py-0.5 text-[10px] text-muted-foreground/60">{title}</p>
          <ul className="flex flex-col">
            {tasks.map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => switchPage(pageId)}
                  className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-accent/50 transition-colors truncate"
                >
                  {t.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
