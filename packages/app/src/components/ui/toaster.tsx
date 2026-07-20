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
          onOpenChange={(open) => {
            if (!open) dismiss(t.id);
          }}
        >
          <div className="flex flex-1 items-center justify-between gap-3">
            <div className="flex flex-col gap-1">
              <ToastTitle>{t.title}</ToastTitle>
              {t.description && <ToastDescription className="max-w-[min(56vw,24rem)] truncate" title={t.description}>{t.description}</ToastDescription>}
            </div>
            {t.action && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  t.action!.onClick();
                  dismiss(t.id);
                }}
                className="shrink-0 rounded-md bg-[hsl(var(--primary))]/15 px-3 py-1.5 text-xs font-semibold text-[hsl(var(--primary))] active:scale-95 transition-transform"
              >
                {t.action.label}
              </button>
            )}
          </div>
          <ToastClose />
        </Toast>
      ))}
      <ToastViewport />
    </ToastProvider>
  );
}
