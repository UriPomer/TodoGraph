import { create } from 'zustand';

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  variant?: 'default' | 'destructive';
  /** 撤销/操作按钮文案，传入后 toast 右侧会渲染按钮 */
  action?: { label: string; onClick: () => void };
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
    // 5 秒后自动消失
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((toast) => toast.id !== id) }));
    }, 5000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** 快捷入口：任意非 React 环境也能调用 */
export const toast = {
  info: (title: string, description?: string) => useToastStore.getState().show({ title, description }),
  error: (title: string, description?: string) =>
    useToastStore.getState().show({ title, description, variant: 'destructive' }),
  /** 操作 toast：带撤销按钮，4 秒后自动消失 */
  action: (title: string, actionLabel: string, onAction: () => void, description?: string) =>
    useToastStore.getState().show({ title, description, action: { label: actionLabel, onClick: onAction } }),
};
