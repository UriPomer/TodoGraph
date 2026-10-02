import { AlertTriangle, Info, Undo2 } from 'lucide-react';
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from './toast';
import { useToastStore } from './toaster-store';

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  return (
    <ToastProvider swipeDirection="right">
      {toasts.map((t) => (
        <Toast
          key={t.id}
          duration={5000}
          variant={t.variant}
          className={t.action ? 'min-h-11 px-2.5 py-2' : 'pr-8'}
          onOpenChange={(open) => {
            if (!open) dismiss(t.id);
          }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--primary)/0.1)] text-[hsl(var(--primary))]" aria-hidden="true">
              {t.action ? <Undo2 className="h-4 w-4" /> : t.variant === 'destructive' ? <AlertTriangle className="h-4 w-4 text-destructive" /> : <Info className="h-4 w-4" />}
            </span>
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
              <ToastTitle className="shrink-0 max-w-[40%] truncate text-sm leading-5">{t.title}</ToastTitle>
              {t.description && <ToastDescription className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={t.description}>{t.description}</ToastDescription>}
            </div>
            {t.action && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  t.action!.onClick();
                  dismiss(t.id);
                }}
                className="inline-flex min-h-8 shrink-0 items-center rounded-xl border border-[hsl(var(--primary)/0.22)] bg-[hsl(var(--primary)/0.1)] px-3 py-1 text-xs font-semibold text-[hsl(var(--primary))] transition-[background-color,transform] hover:bg-[hsl(var(--primary)/0.16)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                {t.action.label}
              </button>
            )}
          </div>
          {!t.action && <ToastClose />}
        </Toast>
      ))}
      <ToastViewport />
    </ToastProvider>
  );
}
