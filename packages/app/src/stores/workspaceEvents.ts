const allTasksInvalidatedListeners = new Set<() => void>();

export function emitAllTasksInvalidated(): void {
  for (const listener of allTasksInvalidatedListeners) listener();
}

export function subscribeAllTasksInvalidated(listener: () => void): () => void {
  allTasksInvalidatedListeners.add(listener);
  return () => allTasksInvalidatedListeners.delete(listener);
}
