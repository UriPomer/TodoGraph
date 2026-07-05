import { useMemo, useState, useCallback } from 'react';
import { Check, ChevronDown, GripVertical, MoreHorizontal, Plus, SquareStack } from 'lucide-react';
import type { PageInfo } from '@todograph/shared';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import { dialog } from '@/components/ui/dialog-store';

export function MobilePageSelectorView({
  pages,
  activePageId,
  onSwitchPage,
  onCreatePage,
}: {
  pages: PageInfo[];
  activePageId: string;
  onSwitchPage: (pageId: string) => void;
  onCreatePage: () => void;
}) {
  const orderedPages = useMemo(
    () => [...pages].sort((a, b) => a.order - b.order),
    [pages],
  );
  const activePage = orderedPages.find((page) => page.id === activePageId) ?? orderedPages[0];

  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 lg:hidden">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="选择页面"
            data-mobile-page-trigger="true"
            className={cn(
              'group inline-flex h-9 max-w-[calc(100%-2.75rem)] items-center gap-2 rounded-lg border px-2.5 text-left',
              'border-[hsl(var(--primary)/0.22)] bg-background shadow-sm',
              'transition-[background-color,border-color,box-shadow,transform] duration-150 ease-out',
              'hover:border-[hsl(var(--primary)/0.42)] hover:bg-accent/45 active:scale-[0.98]',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            )}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--primary)/0.1)] text-[hsl(var(--primary))]">
              <SquareStack className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 truncate text-sm font-medium text-foreground">
              {activePage?.title ?? '选择页面'}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[min(18rem,calc(100vw-1.5rem))] rounded-lg p-1.5">
          {orderedPages.map((page) => {
            const active = page.id === activePage?.id;
            return (
              <DropdownMenuItem
                key={page.id}
                onSelect={() => onSwitchPage(page.id)}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2.5 py-2 text-sm',
                  active && 'bg-[hsl(var(--primary)/0.08)] text-foreground',
                )}
              >
                <span
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border',
                    active
                      ? 'border-[hsl(var(--primary)/0.35)] bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))]'
                      : 'border-border bg-background text-muted-foreground',
                  )}
                >
                  {active ? <Check className="h-3.5 w-3.5" /> : <SquareStack className="h-3.5 w-3.5" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{page.title}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-9 w-9 shrink-0 rounded-lg"
        onClick={onCreatePage}
        aria-label="新建页面"
        title="新建页面"
      >
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  );
}

export function PageBar() {
  const meta = useWorkspaceStore((s) => s.meta);
  const switchPage = useWorkspaceStore((s) => s.switchPage);
  const createPage = useWorkspaceStore((s) => s.createPage);
  const renamePage = useWorkspaceStore((s) => s.renamePage);
  const deletePage = useWorkspaceStore((s) => s.deletePage);
  const reorderPages = useWorkspaceStore((s) => s.reorderPages);

  const [dragId, setDragId] = useState<string | null>(null);

  const pages = useMemo(
    () => [...(meta?.pages ?? [])].sort((a, b) => a.order - b.order),
    [meta],
  );

  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, targetId: string) => {
      e.preventDefault();
      setDragId(null);
      if (!dragId || dragId === targetId) return;
      const ordered = [...pages];
      const fromIdx = ordered.findIndex((p) => p.id === dragId);
      const toIdx = ordered.findIndex((p) => p.id === targetId);
      if (fromIdx < 0 || toIdx < 0) return;
      const [moved] = ordered.splice(fromIdx, 1);
      ordered.splice(toIdx, 0, moved!);
      void reorderPages(ordered.map((p) => p.id));
    },
    [dragId, pages, reorderPages],
  );

  const handleDragEnd = useCallback(() => {
    setDragId(null);
  }, []);

  if (!meta || pages.length === 0) return null;

  const handleCreatePage = async () => {
    const fallbackTitle = `页面 ${pages.length + 1}`;
    const title = await dialog.prompt('新页面名称', { defaultValue: fallbackTitle, placeholder: '输入页面名称' });
    if (title === null) return;
    const info = await createPage(title.trim() || fallbackTitle);
    if (info) await switchPage(info.id);
  };

  return (
    <div className="shrink-0 border-b border-border bg-card/65 backdrop-blur">
      <MobilePageSelectorView
        pages={pages}
        activePageId={meta.activePageId}
        onSwitchPage={(pageId) => void switchPage(pageId)}
        onCreatePage={() => void handleCreatePage()}
      />

      <div className="hidden items-center gap-2 overflow-x-auto px-3 py-2 lg:flex">
        {pages.map((page) => {
          const active = page.id === meta.activePageId;
          const disableDelete = pages.length <= 1;
          const isDragging = dragId === page.id;
          return (
            <div
              key={page.id}
              data-lens
              draggable
              onDragStart={(e) => handleDragStart(e, page.id)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, page.id)}
              onDragEnd={handleDragEnd}
              className={cn(
                'group flex shrink-0 items-center rounded-xl border transition-colors duration-200 cursor-grab active:cursor-grabbing select-none',
                isDragging && 'opacity-40',
                active
                  ? 'border-[hsl(var(--primary)/0.45)] bg-[hsl(var(--primary)/0.08)]'
                  : 'border-border bg-background/80 hover:bg-foreground/5',
              )}
            >
              <span className="pl-1.5 text-muted-foreground/40 group-hover:text-muted-foreground/70 transition-colors">
                <GripVertical className="h-3.5 w-3.5" />
              </span>

              <button
                type="button"
                className={cn(
                  'max-w-[180px] shrink-0 truncate px-2 py-1.5 text-sm',
                  active ? 'text-foreground' : 'text-muted-foreground',
                )}
                onClick={() => void switchPage(page.id)}
                title={page.title}
              >
                {page.title}
              </button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'mr-1 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors',
                      'hover:bg-accent hover:text-accent-foreground',
                      active ? 'opacity-100' : 'opacity-60 group-hover:opacity-100',
                    )}
                    aria-label={`页面 ${page.title} 更多操作`}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem
                    onSelect={async () => {
                      const next = await dialog.prompt('重命名页面', { defaultValue: page.title, placeholder: '输入新名称' });
                      if (next === null) return;
                      const title = next.trim();
                      if (!title || title === page.title) return;
                      void renamePage(page.id, title);
                    }}
                  >
                    重命名
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={disableDelete}
                    className="text-destructive focus:text-destructive"
                    onSelect={async () => {
                      const ok = await dialog.confirm(`删除页面「${page.title}」`, { danger: true });
                      if (!ok) return;
                      void deletePage(page.id);
                    }}
                  >
                    删除
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 gap-1 rounded-lg"
          onClick={() => void handleCreatePage()}
        >
          <Plus className="h-3.5 w-3.5" />
          新页面
        </Button>
      </div>
    </div>
  );
}
