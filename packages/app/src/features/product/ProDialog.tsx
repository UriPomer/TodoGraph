import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Crown, X } from 'lucide-react';
import { useProductStore } from './entitlements';
import { ApplePurchases, applePurchasesAvailable } from '@/platform/applePurchases';
import { isLocalWorkspace } from '@/platform/workspaceRuntime';

export function ProBadge() {
  const plan = useProductStore(state => state.entitlements.plan);
  const open = useProductStore(state => state.openPro);
  return <button type="button" onClick={open} aria-label={plan === 'pro' ? 'TodoGraph Pro' : '升级 TodoGraph Pro'} className="inline-flex items-center gap-1 rounded-xl border border-border px-2 py-1 text-xs font-medium transition-colors duration-200 hover:bg-foreground/5"><Crown className="h-3.5 w-3.5 text-primary" />{plan === 'pro' ? 'Pro' : '免费版'}</button>;
}

export function ProDialog() {
  const { proDialogOpen: open, closePro, refresh, entitlements, error: entitlementError } = useProductStore();
  const panel = useRef<HTMLDivElement>(null);
  const [products, setProducts] = useState<Array<{ id: string; displayName: string; displayPrice: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    setError(null); setProducts([]);
    let disposed = false;
    if (applePurchasesAvailable() && isLocalWorkspace()) {
      void ApplePurchases.products().then(result => { if (!disposed) setProducts(result.products); }).catch(error => { if (!disposed) setError(String(error.message)); });
    }
    return () => { disposed = true; };
  }, [open]);
  if (!open) return null;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await action(); await refresh(); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return createPortal(<div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
    <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => !busy && closePro()} />
    <div ref={panel} role="dialog" aria-modal="true" aria-label="TodoGraph Pro" tabIndex={-1} onKeyDown={event => {
      if (event.key === 'Escape' && !busy) closePro();
      if (event.key === 'Tab') {
        const controls = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input');
        const first = controls?.[0]; const last = controls?.[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }} className="relative max-h-full w-full max-w-md overflow-auto rounded-xl border border-border bg-card p-6 text-card-foreground shadow-2xl outline-none">
      <button type="button" disabled={busy} onClick={closePro} aria-label="关闭 Pro" className="absolute right-3 top-3 rounded-xl p-2 hover:bg-foreground/5"><X className="h-4 w-4" /></button>
      <Crown className="mb-3 h-7 w-7 text-primary" /><h2 className="text-xl font-semibold">TodoGraph Pro</h2>
      <p className="mt-2 text-sm text-muted-foreground">更多页面，更自由的工作空间。</p>
      <ul className="my-5 space-y-3 text-sm"><li>多个页面，各自支持列表和依赖图</li><li>自选背景图片、材质透明度和模糊强度</li><li>iCloud 跨设备同步</li></ul>
      <p className="mb-4 text-xs text-muted-foreground">免费版保留一个清单和一个页面，本地保存无需登录。</p>
      {entitlements.plan === 'pro' && <p className="mb-3 text-sm text-primary">当前已解锁 Pro</p>}
      {products.map(product => <button key={product.id} disabled={busy} onClick={() => void run(async () => {
        const result = await ApplePurchases.purchase({ productId: product.id });
        if (result.status === 'pending') setError('购买待批准；批准后会自动更新权益');
      })} className="mb-2 w-full rounded-xl bg-primary px-4 py-3 text-sm text-primary-foreground">{product.displayName} · {product.displayPrice}</button>)}
      {!products.length && <p className="rounded-xl bg-muted p-3 text-sm">购买尚未配置</p>}
      {applePurchasesAvailable() && isLocalWorkspace() && <button disabled={busy} onClick={() => void run(() => ApplePurchases.restore())} className="mt-3 w-full rounded-xl border px-4 py-2 text-sm">恢复购买</button>}
      {(error || entitlementError) && <p role="alert" className="mt-3 text-sm text-destructive">{error ?? entitlementError}</p>}
    </div>
  </div>, document.body);
}
