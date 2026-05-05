import { useMemo, useState, useCallback } from 'react';
import { GripVertical, MoreHorizontal, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';

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
    const title = prompt('新页面名称:', fallbackTitle);
    if (title === null) return;
    const info = await createPage(title.trim() || fallbackTitle);
    if (info) await switchPage(info.id);
  };

  return (
    <div className="shrink-0 border-b border-border bg-card/65 backdrop-blur">
      <div className="flex items-center gap-2 overflow-x-auto px-3 py-2">
        {pages.map((page) => {
          const active = page.id === meta.activePageId;
          const disableDelete = pages.length <= 1;
          const isDragging = dragId === page.id;
          return (
            <div
              key={page.id}
              draggable
              onDragStart={(e) => handleDragStart(e, page.id)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, page.id)}
              onDragEnd={handleDragEnd}
              className={cn(
                'group flex shrink-0 items-center rounded-lg border transition-colors cursor-grab active:cursor-grabbing',
                isDragging && 'opacity-40',
                active
                  ? 'border-[hsl(var(--primary)/0.45)] bg-[hsl(var(--primary)/0.08)]'
                  : 'border-border bg-background/80 hover:bg-accent/50',
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
                    onSelect={() => {
                      const next = prompt('重命名页面:', page.title);
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
                    onSelect={() => {
                      if (!confirm(`删除页面 "${page.title}"?`)) return;
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
