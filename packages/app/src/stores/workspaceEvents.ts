import type { Meta } from '@todograph/shared';

const allTasksInvalidatedListeners = new Set<() => void>();
const workspaceMetaUpdatedListeners = new Set<(meta: Meta) => void>();

export function emitAllTasksInvalidated(): void {
  for (const listener of allTasksInvalidatedListeners) listener();
}

export function subscribeAllTasksInvalidated(listener: () => void): () => void {
  allTasksInvalidatedListeners.add(listener);
  return () => allTasksInvalidatedListeners.delete(listener);
}

export function emitWorkspaceMetaUpdated(meta: Meta): void {
  for (const listener of workspaceMetaUpdatedListeners) listener(meta);
}

export function subscribeWorkspaceMetaUpdated(listener: (meta: Meta) => void): () => void {
  workspaceMetaUpdatedListeners.add(listener);
  return () => workspaceMetaUpdatedListeners.delete(listener);
}
