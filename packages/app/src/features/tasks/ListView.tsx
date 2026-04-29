import { useMemo } from 'react';
import { buildAdj } from '@todograph/core';
import { useTaskStore } from '@/stores/useTaskStore';
import { useDerived } from '@/hooks/useRecommendation';
import { TaskInput } from './TaskInput';
import { TaskItem } from './TaskItem';

/**
 * 极简列表视图（无外层卡片）：
 * - 三段分组：Ready / Blocked / Done
 * - 每一段只靠一个小标题区分，没有框
 * - 任务行本身也没有卡片边框（见 TaskItem）
 */
export function ListView() {
  const nodes = useTaskStore((s) => s.nodes);
  const { graph, readySet, recommended } = useDerived();

  const { readyArr, blockedArr, doneArr, depInfo } = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const { parents } = buildAdj(graph);
    const depInfoMap = new Map<
      string,
      { undone: number; total: number; parentTitles: string[] }
    >();
    for (const n of nodes) {
      const ps = [...(parents.get(n.id) ?? [])];
      if (ps.length === 0) continue;
      const parentTitles = ps.map((pid) => byId.get(pid)?.title ?? pid);
      const undone = ps.filter((pid) => byId.get(pid)?.status !== 'done').length;
      depInfoMap.set(n.id, { undone, total: ps.length, parentTitles });
    }

    const rank = (arr: typeof nodes) =>
      [...arr].sort((a, b) => {
        const aRec = a.id === recommended?.id ? 1 : 0;
        const bRec = b.id === recommended?.id ? 1 : 0;
        if (aRec !== bRec) return bRec - aRec;
        const aD = a.status === 'doing' ? 1 : 0;
        const bD = b.status === 'doing' ? 1 : 0;
        if (aD !== bD) return bD - aD;
        return (b.priority ?? 0) - (a.priority ?? 0);
      });

    const ready = rank(nodes.filter((n) => readySet.has(n.id)));
    const blocked = rank(nodes.filter((n) => n.status !== 'done' && !readySet.has(n.id)));
    const done = nodes.filter((n) => n.status === 'done');
    return { readyArr: ready, blockedArr: blocked, doneArr: done, depInfo: depInfoMap };
  }, [nodes, graph, readySet, recommended]);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto w-full max-w-md px-4 py-5">
        <TaskInput />

        <Section
          title="Ready"
          hint="可执行"
          items={readyArr}
          recommendedId={recommended?.id}
          depInfo={depInfo}
          empty="暂无可执行任务"
        />
        <Section
          title="Blocked"
          hint="有未完成的前置"
          items={blockedArr}
          recommendedId={recommended?.id}
          depInfo={depInfo}
        />
        <Section title="Done" items={doneArr} recommendedId={undefined} depInfo={depInfo} />
      </div>
    </div>
  );
}

interface SectionProps {
  title: string;
  hint?: string;
  items: ReturnType<typeof useTaskStore.getState>['nodes'];
  recommendedId: string | undefined;
  depInfo: Map<string, { undone: number; total: number; parentTitles: string[] }>;
  empty?: string;
}

function Section({ title, hint, items, recommendedId, depInfo, empty }: SectionProps) {
  return (
    <section className="mt-5 first:mt-6">
      <h3 className="mb-1 flex items-baseline gap-2 px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
        <span>{title}</span>
        {hint && <span className="text-[10px] normal-case tracking-normal opacity-70">{hint}</span>}
      </h3>
      {items.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground/50 italic">{empty ?? '空'}</p>
      ) : (
        <ul className="flex flex-col">
          {items.map((n) => (
            <TaskItem
              key={n.id}
              task={n}
              recommended={n.id === recommendedId}
              dependencyInfo={depInfo.get(n.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
