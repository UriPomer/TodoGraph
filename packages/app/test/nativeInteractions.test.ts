import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  native: true,
  impact: vi.fn(async () => undefined),
  notification: vi.fn(async () => undefined),
  selectionStart: vi.fn(async () => undefined),
  selectionChanged: vi.fn(async () => undefined),
  selectionEnd: vi.fn(async () => undefined),
}));

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => mocks.native } }));
vi.mock('@capacitor/haptics', () => ({
  Haptics: {
    impact: mocks.impact,
    notification: mocks.notification,
    selectionStart: mocks.selectionStart,
    selectionChanged: mocks.selectionChanged,
    selectionEnd: mocks.selectionEnd,
  },
  ImpactStyle: { Light: 'LIGHT', Medium: 'MEDIUM' },
  NotificationType: { Warning: 'WARNING' },
}));

import { nativeFeedback, resetNativeFeedbackForTests, setHapticsEnabled } from '@/platform/nativeInteractions';

describe('native interaction feedback', () => {
  beforeEach(() => {
    mocks.native = true;
    mocks.impact.mockClear();
    mocks.notification.mockClear();
    mocks.selectionStart.mockClear();
    mocks.selectionChanged.mockClear();
    mocks.selectionEnd.mockClear();
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    resetNativeFeedbackForTests();
  });

  it('emits one lift and deduplicates stable drop targets', async () => {
    nativeFeedback.dragLift('touch');
    nativeFeedback.dropTargetChanged('nest:a');
    nativeFeedback.dropTargetChanged('nest:a');
    nativeFeedback.dropTargetChanged('reorder:b:after');
    await vi.waitFor(() => expect(mocks.selectionStart).toHaveBeenCalledTimes(1));
    expect(mocks.impact).toHaveBeenCalledTimes(1);
    expect(mocks.selectionChanged).toHaveBeenCalledTimes(2);
  });

  it('does not provide native feedback for web or mouse input', async () => {
    mocks.native = false;
    nativeFeedback.dragLift('touch');
    nativeFeedback.dragLift('mouse');
    nativeFeedback.dropSuccess();
    await Promise.resolve();
    expect(mocks.impact).not.toHaveBeenCalled();
    expect(mocks.selectionStart).not.toHaveBeenCalled();
  });

  it('honors the device-level haptics preference', async () => {
    setHapticsEnabled(false);
    nativeFeedback.dragLift('touch');
    nativeFeedback.dropInvalid();
    await Promise.resolve();
    expect(mocks.impact).not.toHaveBeenCalled();
    expect(mocks.notification).not.toHaveBeenCalled();
  });
});
