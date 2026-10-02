import { useEffect, useRef, useState } from 'react';

const PULL_THRESHOLD = 80;
const PULL_MAX = 112;

export function usePullToCreateTask(isDragging: () => boolean) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pullRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [pullReady, setPullReady] = useState(false);
  const [focusTrigger, setFocusTrigger] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    const indicator = pullRef.current;
    const content = contentRef.current;
    if (!el || !indicator || !content) return;
    let pull: { touchId: number; startY: number; distance: number } | null = null;
    const finishPull = (commit = false) => {
      if (!pull) return;
      if (commit && pull.distance >= PULL_THRESHOLD) setFocusTrigger((value) => value + 1);
      pull = null;
      Object.assign(content.style, { transition: 'transform 0.2s ease-out', transform: 'translateY(0px)' });
      Object.assign(indicator.style, { transition: 'opacity 0.2s, transform 0.2s', opacity: '0', transform: 'translateY(-20px)' });
      setPullReady(false);
    };
    const cancelPull = () => finishPull();
    const onAdditionalTouch = (event: TouchEvent) => { if (event.touches.length !== 1) cancelPull(); };
    const onVisibilityChange = () => { if (document.hidden) cancelPull(); };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || el.scrollTop > 0 || isDragging()) return;
      const touch = event.touches[0]!;
      pull = { touchId: touch.identifier, startY: touch.clientY, distance: 0 };
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!pull) return;
      const touch = Array.from(event.touches).find((candidate) => candidate.identifier === pull!.touchId);
      if (!touch || isDragging() || el.scrollTop > 0) return cancelPull();
      const dy = touch.clientY - pull.startY;
      if (dy <= 0) return cancelPull();
      event.preventDefault();
      pull.distance = Math.min(dy * 0.45, PULL_MAX);
      Object.assign(content.style, { transition: 'none', transform: `translateY(${pull.distance}px)` });
      Object.assign(indicator.style, { transition: 'none', opacity: String(Math.min(1, pull.distance / PULL_THRESHOLD)), transform: `translateY(${pull.distance * 0.4}px)` });
      setPullReady(pull.distance >= PULL_THRESHOLD);
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (pull && Array.from(event.changedTouches).some((touch) => touch.identifier === pull!.touchId)) finishPull(true);
    };
    const listeners = new AbortController();
    const options = { signal: listeners.signal, passive: true };
    el.addEventListener('touchstart', onTouchStart, options);
    el.addEventListener('touchmove', onTouchMove, { ...options, passive: false });
    window.addEventListener('touchstart', onAdditionalTouch, { ...options, capture: true });
    window.addEventListener('touchend', onTouchEnd, options);
    window.addEventListener('touchcancel', cancelPull, options);
    window.addEventListener('blur', cancelPull, options);
    window.addEventListener('pagehide', cancelPull, options);
    document.addEventListener('visibilitychange', onVisibilityChange, options);
    return () => { listeners.abort(); cancelPull(); };
  }, [isDragging]);

  return { scrollRef, pullRef, contentRef, pullReady, focusTrigger };
}
