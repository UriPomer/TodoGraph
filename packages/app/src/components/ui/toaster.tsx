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
          className={t.action ? 'min-h-11 py-2 pl-3 pr-2' : undefined}
          onOpenChange={(open) => {
            if (!open) dismiss(t.id);
          }}
        >
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-0.5">
              <ToastTitle className="text-xs">{t.title}</ToastTitle>
              {t.description && <ToastDescription className="max-w-[min(56vw,24rem)] truncate text-xs" title={t.description}>{t.description}</ToastDescription>}
            </div>
            {t.action && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  t.action!.onClick();
                  dismiss(t.id);
                }}
                className="min-h-8 shrink-0 rounded-lg bg-[hsl(var(--primary))]/15 px-3 py-1 text-xs font-semibold text-[hsl(var(--primary))] active:scale-95 transition-transform"
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
