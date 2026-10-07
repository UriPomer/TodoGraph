import { create } from 'zustand';
import { readDeviceRecord, writeDeviceRecord } from '@/local/deviceDatabase';
import { useProductStore } from '@/features/product/entitlements';

export interface Appearance { image: Blob | null; opacity: number; blur: number; customized: boolean }
const defaults = (): Appearance => ({ image: null, opacity: 65, blur: 18, customized: false });
type StoredAppearance = Omit<Appearance, 'image'> & { image: string | null };
function encodeImage(image: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('无法读取背景图片')); reader.readAsDataURL(image);
  });
}
function decodeImage(image: string): Blob {
  if (!image.startsWith('data:image/jpeg;base64,')) throw new Error('本地背景图片格式无效');
  const bytes = Uint8Array.from(atob(image.slice(image.indexOf(',') + 1)), character => character.charCodeAt(0));
  return new Blob([bytes], { type: 'image/jpeg' });
}
let generation = 0;
let objectUrl: string | undefined;
interface AppearanceState { owner: string | null; value: Appearance; error: string | null; load: (owner: string) => Promise<void>; save: (value: Appearance) => Promise<void> }

function paint(value: Appearance, pro: boolean) {
  const root = document.documentElement;
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = undefined; }
  root.toggleAttribute('data-appearance-custom', pro && value.customized);
  if (pro && value.customized) {
    root.style.setProperty('--custom-material-alpha', String(value.opacity / 100));
    root.style.setProperty('--custom-blur', `${value.blur}px`);
  } else {
    root.style.removeProperty('--custom-material-alpha'); root.style.removeProperty('--custom-blur');
  }
  if (pro && value.image) objectUrl = URL.createObjectURL(value.image);
  window.dispatchEvent(new CustomEvent('todograph-wallpaper', { detail: { url: objectUrl ?? null } }));
}

export const useAppearanceStore = create<AppearanceState>((set, get) => ({
  owner: null, value: defaults(), error: null,
  load: async owner => {
    const request = ++generation;
    set({ owner, value: defaults(), error: null }); paint(defaults(), false);
    try {
      const stored = await readDeviceRecord<StoredAppearance>(`appearance:${owner}`, () => ({ ...defaults(), image: null }));
      const value: Appearance = { ...stored, image: stored.image ? decodeImage(stored.image) : null };
      if (request !== generation) return;
      if (!Number.isFinite(value.opacity) || value.opacity < 20 || value.opacity > 95 || !Number.isFinite(value.blur) || value.blur < 0 || value.blur > 36) throw new Error('外观设置无效，请重设');
      set({ value }); paint(value, useProductStore.getState().entitlements.plan === 'pro');
    } catch (error) { if (request === generation) set({ error: (error as Error).message }); }
  },
  save: async value => {
    const owner = get().owner; const request = generation;
    if (!owner || useProductStore.getState().entitlements.plan !== 'pro') throw new Error('自定义外观需要 Pro');
    const stored: StoredAppearance = { ...value, image: value.image ? await encodeImage(value.image) : null };
    await writeDeviceRecord(`appearance:${owner}`, stored);
    if (request !== generation) return;
    set({ value, error: null }); paint(value, true);
  },
}));
useProductStore.subscribe((state, previous) => {
  if (state.entitlements.plan !== previous.entitlements.plan) paint(useAppearanceStore.getState().value, state.entitlements.plan === 'pro');
});

export async function prepareWallpaper(file: File): Promise<Blob> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) throw new Error('请选择不超过 8 MB 的 PNG、JPEG 或 WebP 图片');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url; await image.decode();
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error('图片尺寸过大或无法读取');
    const scale = Math.min(1, 1920 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d'); if (!context) throw new Error('无法处理图片');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法保存图片')), 'image/jpeg', .9));
  } finally { URL.revokeObjectURL(url); }
}
