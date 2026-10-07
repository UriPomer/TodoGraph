import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { prepareWallpaper, useAppearanceStore, type Appearance } from './appearance';
import { useProductStore } from '@/features/product/entitlements';

export function AppearanceDialog({ onClose }: { onClose: () => void }) {
  const value = useAppearanceStore(state => state.value);
  const pro = useProductStore(state => state.entitlements.plan === 'pro');
  const [draft, setDraft] = useState<Appearance>(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileGeneration = useRef(0);
  const apply = async () => {
    if (!pro) { onClose(); useProductStore.getState().openPro(); return; }
    setBusy(true); setError(null);
    try { await useAppearanceStore.getState().save({ ...draft, customized: true }); onClose(); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return createPortal(<div className="fixed inset-0 z-[220] flex items-center justify-center p-4" onKeyDown={event => { if (event.key === 'Escape' && !busy) onClose(); }}>
    <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => !busy && onClose()} />
    <div role="dialog" aria-modal="true" aria-label="自定义外观" className="relative max-h-full w-full max-w-md overflow-auto rounded-xl border border-border bg-card p-5 text-card-foreground shadow-2xl">
      <header className="mb-5 flex items-center justify-between"><h2 className="font-semibold">自定义外观 <span className="text-xs text-primary">Pro</span></h2><button disabled={busy} aria-label="关闭自定义外观" onClick={onClose} className="rounded-xl p-2 hover:bg-foreground/5"><X className="h-4 w-4" /></button></header>
      <div className="space-y-5">
        <label className="block text-sm">背景图片<input autoFocus aria-label="背景图片" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} className="mt-2 block w-full text-sm" onChange={event => {
          const file = event.target.files?.[0]; if (!file) return;
          const request = ++fileGeneration.current; setBusy(true); setError(null);
          void prepareWallpaper(file).then(image => { if (request === fileGeneration.current) setDraft(current => ({ ...current, image })); }).catch(error => { if (request === fileGeneration.current) setError(error.message); }).finally(() => { if (request === fileGeneration.current) setBusy(false); });
        }} /></label>
        <p className="text-xs text-muted-foreground">PNG、JPEG 或 WebP，最大 8 MB。图片保存在本机。</p>
        {draft.image && <button disabled={busy} onClick={() => setDraft(current => ({ ...current, image: null }))} className="rounded-xl border px-3 py-2 text-xs">使用内置背景</button>}
        <label className="block text-sm">材质不透明度 <span className="float-right text-muted-foreground">{draft.opacity}%</span><input aria-label="材质不透明度" type="range" min="20" max="95" value={draft.opacity} disabled={busy} onChange={event => setDraft(current => ({ ...current, opacity: Number(event.target.value) }))} className="mt-3 w-full accent-[hsl(var(--primary))]" /></label>
        <label className="block text-sm">模糊强度 <span className="float-right text-muted-foreground">{draft.blur}px</span><input aria-label="模糊强度" type="range" min="0" max="36" value={draft.blur} disabled={busy} onChange={event => setDraft(current => ({ ...current, blur: Number(event.target.value) }))} className="mt-3 w-full accent-[hsl(var(--primary))]" /></label>
        <p className="text-xs text-muted-foreground">只调整玻璃主题材质，文字和按钮保持清晰。外观设置按设备保存。</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2"><button disabled={busy} onClick={() => void apply()} className="flex-1 rounded-xl bg-primary px-4 py-3 text-sm text-primary-foreground">{pro ? '应用外观' : '解锁 Pro'}</button><button disabled={busy || !pro} onClick={() => {
          setBusy(true); void useAppearanceStore.getState().save({ image: null, opacity: 65, blur: 18, customized: false }).then(onClose).catch(error => setError(error.message)).finally(() => setBusy(false));
        }} className="rounded-xl border px-3 py-3 text-sm">恢复默认</button></div>
      </div>
    </div>
  </div>, document.body);
}
