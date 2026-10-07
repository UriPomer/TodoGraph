import { canEditProductPage } from '@todograph/shared';
import { useProductStore } from './entitlements';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import { toast } from '@/components/ui/toaster-store';

export function isProductPageEditable(pageId: string | null): boolean {
  const meta = useWorkspaceStore.getState().meta;
  return !meta || !pageId || canEditProductPage(meta, pageId, useProductStore.getState().entitlements.plan);
}

const falseResults = new Set(['toggleStatus', 'completeTask', 'addEdge', 'setParent', 'reorderTask', 'moveTaskToSibling', 'ascendOneLevel', 'undo', 'redo']);
const nullResults = new Set(['addTask', 'insertBetween', 'groupTasks']);
/** The store owns this gate, so keyboard commands and gestures cannot bypass read-only pages. */
export function guardTaskActions<T extends object>(actions: T, pageId: () => string | null): T {
  return Object.fromEntries(Object.entries(actions).map(([name, action]) => [name, (...args: unknown[]) => {
    if (isProductPageEditable(pageId())) return (action as (...args: unknown[]) => unknown)(...args);
    if (name !== 'syncMeasuredSizes') toast.info('此页面只读', '可设为免费可编辑页面，或使用 Pro');
    return falseResults.has(name) ? false : nullResults.has(name) ? null : undefined;
  }])) as T;
}
