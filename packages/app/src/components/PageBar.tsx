import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, GripVertical, ListTree, MoreHorizontal, Network, Plus, SquareStack } from 'lucide-react';
import { MAX_PAGE_TITLE_LENGTH, SYSTEM_HIERARCHY_PAGE_ID, type PageInfo } from '@todograph/shared';
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

export function WorkspaceModeButton({
  isListMode,
  disabled = false,
  onToggle,
}: {
  isListMode: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const label = isListMode ? '切换到依赖图模式' : '切换到纯清单模式';
  return (
    <button
      type="button"
      data-workspace-mode-toggle="true"
      data-mode={isListMode ? 'list' : 'graph'}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'relative h-9 w-9 shrink-0 overflow-hidden rounded-lg border',
        'transition-[background-color,border-color,color,transform,box-shadow] duration-200 active:scale-95 disabled:opacity-40',
        isListMode
          ? 'border-[hsl(var(--success)/0.55)] bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success))] shadow-[0_0_12px_hsl(var(--success)/0.1)]'
          : 'border-[hsl(var(--primary)/0.45)] bg-[hsl(var(--primary)/0.1)] text-[hsl(var(--primary))]',
      )}
    >
      <ListTree className={cn(
        'absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 transition-all duration-200',
        isListMode ? 'rotate-0 scale-100 opacity-100' : '-rotate-90 scale-50 opacity-0',
      )} />
      <Network className={cn(
        'absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 transition-all duration-200',
        isListMode ? 'rotate-90 scale-50 opacity-0' : 'rotate-0 scale-100 opacity-100',
      )} />
    </button>
  );
}

export function MobilePageSelectorView({
  pages,
  activePageId,
  onSwitchPage,
  onCreatePage,
  isListMode,
  onToggleMode,
}: {
  pages: PageInfo[];
  activePageId: string;
  onSwitchPage: (pageId: string) => void;
  onCreatePage: () => void;
  isListMode: boolean;
  onToggleMode: () => void;
}) {
  const orderedPages = useMemo(
    () => [...pages]
      .filter((page) => page.id !== SYSTEM_HIERARCHY_PAGE_ID)
      .sort((a, b) => a.order - b.order),
    [pages],
  );
  const activePage = orderedPages.find((page) => page.id === activePageId);

  return (
    <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2 lg:hidden">
      <div data-mobile-page-controls="true" className="flex min-w-0 items-center gap-2">
        <WorkspaceModeButton isListMode={isListMode} onToggle={onToggleMode} />
        <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="选择页面"
            data-mobile-page-trigger="true"
            data-selector-mode={isListMode ? 'list' : 'graph'}
            className={cn(
              'group inline-flex h-9 min-w-0 max-w-[calc(100%-2.75rem)] items-center gap-2 rounded-lg border px-2.5 text-left',
              'shadow-sm',
              'transition-[background-color,border-color,box-shadow,transform] duration-150 ease-out',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              isListMode
                ? 'border-[hsl(var(--success)/0.55)] bg-[hsl(var(--success)/0.12)] hover:bg-[hsl(var(--success)/0.16)] active:scale-[0.98]'
                : 'border-border bg-background hover:border-[hsl(var(--primary)/0.42)] hover:bg-accent/45 active:scale-[0.98]',
            )}
          >
            <span className={cn(
              'flex h-5 w-5 shrink-0 items-center justify-center rounded-md',
              isListMode
                ? 'bg-[hsl(var(--success)/0.14)] text-[hsl(var(--success))]'
                : 'bg-[hsl(var(--primary)/0.1)] text-[hsl(var(--primary))]',
            )}>
              {isListMode ? <ListTree className="h-3.5 w-3.5" /> : <SquareStack className="h-3.5 w-3.5" />}
            </span>
            <span className={cn(
              'min-w-0 truncate text-sm font-medium',
              isListMode ? 'text-[hsl(var(--success))]' : 'text-foreground',
            )}>
              {isListMode ? '仅清单' : activePage?.title ?? '选择页面'}
            </span>
            <ChevronDown className={cn(
              'h-3.5 w-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180',
              isListMode ? 'text-[hsl(var(--success)/0.75)]' : 'text-muted-foreground',
            )} />
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
      </div>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="ml-auto h-9 w-9 shrink-0 rounded-lg"
        onClick={onCreatePage}
        aria-label="新建页面"
        title="新建页面"
      >
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  );
}

export function PageBar({ onModeChange }: { onModeChange?: (mode: 'list' | 'graph') => void }) {
  const meta = useWorkspaceStore((s) => s.meta);
  const switchPage = useWorkspaceStore((s) => s.switchPage);
  const createPage = useWorkspaceStore((s) => s.createPage);
  const renamePage = useWorkspaceStore((s) => s.renamePage);
  const deletePage = useWorkspaceStore((s) => s.deletePage);
  const reorderPages = useWorkspaceStore((s) => s.reorderPages);

  const [dragId, setDragId] = useState<string | null>(null);
  const lastGraphPageIdRef = useRef<string | null>(null);

  const pages = useMemo(
    () => [...(meta?.pages ?? [])]
      .filter((page) => page.id !== SYSTEM_HIERARCHY_PAGE_ID)
      .sort((a, b) => a.order - b.order),
    [meta],
  );
  const systemPage = meta?.pages.find((page) => page.id === SYSTEM_HIERARCHY_PAGE_ID);
  const isListMode = meta?.activePageId === SYSTEM_HIERARCHY_PAGE_ID;

  useEffect(() => {
    if (meta?.activePageId && meta.activePageId !== SYSTEM_HIERARCHY_PAGE_ID) {
      lastGraphPageIdRef.current = meta.activePageId;
    }
  }, [meta?.activePageId]);

  const handleToggleMode = useCallback(() => {
    if (!meta || !systemPage) return;
    if (!isListMode) {
      void switchPage(systemPage.id);
      onModeChange?.('list');
      return;
    }
    const target = pages.find((page) => page.id === lastGraphPageIdRef.current) ?? pages[0];
    if (target) {
      void switchPage(target.id);
      onModeChange?.('graph');
    }
  }, [isListMode, meta, onModeChange, pages, switchPage, systemPage]);

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
      void reorderPages([
        ...(systemPage ? [systemPage.id] : []),
        ...ordered.map((p) => p.id),
      ]);
    },
    [dragId, pages, reorderPages, systemPage],
  );

  const handleDragEnd = useCallback(() => {
    setDragId(null);
  }, []);

  if (!meta) return null;

  const handleCreatePage = async () => {
    const fallbackTitle = `页面 ${pages.length + 1}`;
    const title = await dialog.prompt('新页面名称', {
      defaultValue: fallbackTitle,
      placeholder: '输入页面名称',
      maxLength: MAX_PAGE_TITLE_LENGTH,
    });
    if (title === null) return;
    const info = await createPage(title.trim() || fallbackTitle);
    if (info) await switchPage(info.id);
  };

  return (
    <div className="shrink-0 border-b border-border bg-card">
      <MobilePageSelectorView
        pages={pages}
        activePageId={meta.activePageId}
        onSwitchPage={(pageId) => {
          void switchPage(pageId);
          onModeChange?.('graph');
        }}
        onCreatePage={() => void handleCreatePage()}
        isListMode={isListMode}
        onToggleMode={handleToggleMode}
      />

      <div className="hidden items-center gap-2 overflow-x-auto px-3 py-2 lg:flex">
        <WorkspaceModeButton
          isListMode={isListMode}
          disabled={!systemPage || (isListMode && pages.length === 0)}
          onToggle={handleToggleMode}
        />
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
                'group flex shrink-0 items-center rounded-xl border transition-colors duration-200 select-none',
                'cursor-grab active:cursor-grabbing',
                isDragging && 'opacity-40',
                active
                  ? 'border-[hsl(var(--primary)/0.45)] bg-[hsl(var(--primary)/0.08)]'
                  : 'border-border bg-background/80 hover:bg-foreground/5',
              )}
            >
              <span className="pl-1.5 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground/70">
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
                      const next = await dialog.prompt('重命名页面', {
                        defaultValue: page.title,
                        placeholder: '输入新名称',
                        maxLength: MAX_PAGE_TITLE_LENGTH,
                      });
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
