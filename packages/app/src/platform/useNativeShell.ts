import { useEffect, useRef, useState } from 'react';
import { App } from '@capacitor/app';
import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';

function revealFocusedEditor(): void {
  requestAnimationFrame(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active?.matches('input, textarea, [contenteditable="true"]')) {
      active.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    }
  });
}

export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const viewport = window.visualViewport;
    const updateWebViewport = () => {
      if (!viewport || Capacitor.isNativePlatform()) return;
      const height = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      setVisible(height > 120);
      if (height > 120) revealFocusedEditor();
    };
    viewport?.addEventListener('resize', updateWebViewport);
    viewport?.addEventListener('scroll', updateWebViewport);
    updateWebViewport();

    let cancelled = false;
    const handles: Array<{ remove: () => Promise<void> }> = [];
    if (Capacitor.isNativePlatform()) {
      void Promise.all([
        Keyboard.addListener('keyboardWillShow', () => {
          setVisible(true);
          revealFocusedEditor();
        }),
        Keyboard.addListener('keyboardWillHide', () => {
          setVisible(false);
        }),
      ]).then((next) => {
        if (cancelled) void Promise.all(next.map((handle) => handle.remove()));
        else handles.push(...next);
      }).catch(() => undefined);
    }
    return () => {
      cancelled = true;
      viewport?.removeEventListener('resize', updateWebViewport);
      viewport?.removeEventListener('scroll', updateWebViewport);
      void Promise.all(handles.map((handle) => handle.remove()));
    };
  }, []);

  return visible;
}

export function useNativeSystemBars(): void {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const sync = () => {
      const lightTheme = document.documentElement.dataset.theme?.includes('light') ?? false;
      void SystemBars.setStyle({ style: lightTheme ? SystemBarsStyle.Light : SystemBarsStyle.Dark })
        .catch(() => undefined);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
}

export function useNativeBackButton(handleNavigationBack: () => boolean): void {
  const handlerRef = useRef(handleNavigationBack);
  handlerRef.current = handleNavigationBack;

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelled = false;
    let handle: { remove: () => Promise<void> } | null = null;
    void App.addListener('backButton', () => {
      const active = document.activeElement as HTMLElement | null;
      if (active?.matches('input, textarea, [contenteditable="true"]')) {
        active.blur();
        void Keyboard.hide().catch(() => undefined);
        return;
      }
      if (!handlerRef.current()) void App.minimizeApp().catch(() => undefined);
    }).then((next) => {
      if (cancelled) void next.remove();
      else handle = next;
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      if (handle) void handle.remove();
    };
  }, []);
}
