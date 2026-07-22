import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

const HAPTICS_KEY = 'todograph.nativeHapticsEnabled';
let selectionActive = false;
let lastIntentKey: string | null = null;
let feedbackQueue = Promise.resolve();

export function isHapticsEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem(HAPTICS_KEY) !== 'false';
}

export function setHapticsEnabled(enabled: boolean): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(HAPTICS_KEY, String(enabled));
  if (!enabled) void endSelection(true);
}

async function safely(call: () => Promise<void>, force = false): Promise<void> {
  if (!Capacitor.isNativePlatform() || (!force && !isHapticsEnabled())) return;
  feedbackQueue = feedbackQueue.then(call).catch(() => undefined);
  await feedbackQueue;
}

async function endSelection(force = false): Promise<void> {
  lastIntentKey = null;
  if (!selectionActive) return;
  selectionActive = false;
  await safely(() => Haptics.selectionEnd(), force);
}

export const nativeFeedback = {
  dragLift(pointerType: string): void {
    if (
      pointerType !== 'touch'
      || selectionActive
      || !Capacitor.isNativePlatform()
      || !isHapticsEnabled()
    ) return;
    selectionActive = true;
    lastIntentKey = null;
    void safely(async () => {
      await Haptics.impact({ style: ImpactStyle.Light });
      await Haptics.selectionStart();
    });
  },
  dropTargetChanged(intentKey: string | null): void {
    if (!selectionActive || !intentKey || intentKey === lastIntentKey) return;
    lastIntentKey = intentKey;
    void safely(() => Haptics.selectionChanged());
  },
  dropSuccess(): void {
    void endSelection().then(() => safely(() => Haptics.impact({ style: ImpactStyle.Medium })));
  },
  dropInvalid(): void {
    void endSelection().then(() => safely(() => Haptics.notification({ type: NotificationType.Warning })));
  },
  dragCancel(): void {
    void endSelection();
  },
};

export function resetNativeFeedbackForTests(): void {
  selectionActive = false;
  lastIntentKey = null;
  feedbackQueue = Promise.resolve();
}
