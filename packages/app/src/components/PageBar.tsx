import { useMemo } from 'react';
import { MoreHorizontal, Plus } from 'lucide-react';
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

  const pages = useMemo(
    () => [...(meta?.pages ?? [])].sort((a, b) => a.order - b.order),
    [meta],
  );

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
          return (
            <div
              key={page.id}
              className={cn(
                'group flex shrink-0 items-center rounded-lg border transition-colors',
                active
                  ? 'border-[hsl(var(--primary)/0.45)] bg-[hsl(var(--primary)/0.08)]'
                  : 'border-border bg-background/80 hover:bg-accent/50',
              )}
            >
              <button
                type="button"
                className={cn(
                  'max-w-[180px] shrink-0 truncate px-3 py-1.5 text-sm',
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
