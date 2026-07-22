import { create } from 'zustand';

export interface ConfirmOptions {
  title: string;
  description?: string;
  danger?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface PromptOptions {
  title: string;
  defaultValue?: string;
  placeholder?: string;
  maxLength?: number;
  confirmLabel?: string;
  cancelLabel?: string;
}

type DialogItem =
  | { type: 'confirm'; id: string; resolve: (v: boolean) => void } & ConfirmOptions
  | { type: 'prompt'; id: string; resolve: (v: string | null) => void } & PromptOptions;

interface DialogStore {
  dialogs: DialogItem[];
  enqueue: (d: DialogItem) => void;
  dequeue: (id: string) => void;
  dismissCurrent: () => boolean;
}

export const useDialogStore = create<DialogStore>((set) => ({
  dialogs: [],
  enqueue: (d) => set((s) => ({ dialogs: [...s.dialogs, d] })),
  dequeue: (id) => set((s) => ({ dialogs: s.dialogs.filter((d) => d.id !== id) })),
  dismissCurrent: () => {
    const current = useDialogStore.getState().dialogs[0];
    if (!current) return false;
    if (current.type === 'confirm') current.resolve(false);
    else current.resolve(null);
    set((state) => ({ dialogs: state.dialogs.filter((dialog) => dialog.id !== current.id) }));
    return true;
  },
}));

/** 命令式 API：任意位置调用，返回 Promise */
export const dialog = {
  confirm: (title: string, options?: Omit<ConfirmOptions, 'title'>): Promise<boolean> => {
    return new Promise((resolve) => {
      useDialogStore.getState().enqueue({
        type: 'confirm',
        id: Math.random().toString(36).slice(2),
        title,
        ...options,
        resolve,
      });
    });
  },
  prompt: (title: string, options?: Omit<PromptOptions, 'title'>): Promise<string | null> => {
    return new Promise((resolve) => {
      useDialogStore.getState().enqueue({
        type: 'prompt',
        id: Math.random().toString(36).slice(2),
        title,
        ...options,
        resolve,
      });
    });
  },
};
