import { create } from 'zustand';

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  variant?: 'default' | 'destructive';
}

interface ToastStore {
  toasts: ToastItem[];
  show: (t: Omit<ToastItem, 'id'>) => void;
  dismiss: (id: string) => void;
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  show: (t) => {
    const id = Math.random().toString(36).slice(2);
    set((s) => ({ toasts: [...s.toasts, { id, ...t }] }));
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** 快捷入口：任意非 React 环境也能调用 */
export const toast = {
  info: (title: string, description?: string) => useToastStore.getState().show({ title, description }),
  error: (title: string, description?: string) =>
    useToastStore.getState().show({ title, description, variant: 'destructive' }),
};
