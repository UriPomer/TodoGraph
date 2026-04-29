import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Tailwind class 合并工具（shadcn 约定） */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 简单防抖 */
export function debounce<F extends (...args: never[]) => void>(fn: F, delay: number): F {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: Parameters<F>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  }) as F;
}

/** 唯一 ID */
export function uid(prefix = 't'): string {
  return prefix + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}
