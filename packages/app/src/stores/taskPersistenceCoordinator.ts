export interface TaskPersistenceCoordinator {
  schedule(): void;
  flush(): Promise<void>;
  cancel(): void;
  hasPending(): boolean;
}

interface Options {
  getActivePageId: () => string | null;
  persist: (pageId: string) => Promise<void>;
  onScheduled: () => void;
  shouldRetry: (error: unknown, pageId: string) => boolean;
  debounceMs?: number;
}

/** Owns debounce and single-flight save ordering; domain state remains in the store. */
export function createTaskPersistenceCoordinator(options: Options): TaskPersistenceCoordinator {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingPageId: string | null = null;
  let drain: Promise<void> | null = null;

  const saveOnce = async (): Promise<void> => {
    if (!pendingPageId) return;
    const pageId = pendingPageId;
    pendingPageId = null;
    if (options.getActivePageId() !== pageId) return;
    try {
      await options.persist(pageId);
    } catch (error) {
      if (options.shouldRetry(error, pageId)) pendingPageId = pageId;
      throw error;
    }
  };

  const drainSaves = (): Promise<void> => {
    if (drain) return drain;
    const current = (async () => {
      while (pendingPageId) await saveOnce();
    })();
    drain = current.finally(() => { drain = null; });
    return drain;
  };

  return {
    schedule() {
      const pageId = options.getActivePageId();
      if (!pageId) return;
      pendingPageId = pageId;
      options.onScheduled();
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void drainSaves().catch(() => {});
      }, options.debounceMs ?? 250);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (drain) await drain;
      if (pendingPageId) await drainSaves();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pendingPageId = null;
    },
    hasPending() {
      return timer !== null || pendingPageId !== null || drain !== null;
    },
  };
}
