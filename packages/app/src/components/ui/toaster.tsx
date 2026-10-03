import { AlertTriangle, Check, Info, Undo2 } from 'lucide-react';
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
          data-action={t.action ? 'true' : undefined}
          className={t.action ? 'toast-glass--action' : 'pr-8'}
          onOpenChange={(open) => {
            if (!open) dismiss(t.id);
          }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <span className="toast-glass__icon" aria-hidden="true">
              {t.action ? <Check className="h-4 w-4" /> : t.variant === 'destructive' ? <AlertTriangle className="h-4 w-4 text-destructive" /> : <Info className="h-4 w-4" />}
            </span>
            <div className="min-w-0 flex-1 overflow-hidden">
              <ToastTitle className="truncate text-[13px] leading-5">{t.title}</ToastTitle>
              {t.description && <ToastDescription className="truncate text-[11px] leading-4 text-foreground/70" title={t.description}>{t.description}</ToastDescription>}
            </div>
            {t.action && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  t.action!.onClick();
                  dismiss(t.id);
                }}
                className="toast-glass__action"
              >
                <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
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
