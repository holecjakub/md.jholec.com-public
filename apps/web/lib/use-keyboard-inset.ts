"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Height (px) the on-screen keyboard currently overlays at the bottom of the
 * layout viewport, or 0 when no software keyboard is up.
 *
 * iOS Safari (and Android Chrome) overlay the keyboard over the page: the
 * LAYOUT viewport keeps its full height while the VISUAL viewport shrinks to the
 * area above the keyboard. So the keyboard's height is the gap between the layout
 * viewport's bottom and the visual viewport's visible bottom:
 *
 *     keyboard = window.innerHeight − visualViewport.height − visualViewport.offsetTop
 *
 * Anything under ~80px is treated as zero so URL-bar / toolbar jitter (which also
 * nudges the visual viewport) never reads as "keyboard open".
 *
 * `enabled` gates it to touch devices — a desktop window resize must never be
 * mistaken for a keyboard. Implemented with useSyncExternalStore (like
 * useMediaQuery) so it is hydration-safe and free of setState-in-effect: the
 * server snapshot is 0, the client snapshot reads visualViewport, and it tracks
 * the keyboard animating open/closed via visualViewport resize + scroll.
 */
export function useKeyboardInset(enabled = true): number {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!enabled || typeof window === "undefined" || !window.visualViewport) {
        return () => {};
      }
      const vv = window.visualViewport;
      vv.addEventListener("resize", onChange);
      vv.addEventListener("scroll", onChange);
      return () => {
        vv.removeEventListener("resize", onChange);
        vv.removeEventListener("scroll", onChange);
      };
    },
    [enabled],
  );

  const getSnapshot = useCallback(() => {
    if (!enabled || typeof window === "undefined" || !window.visualViewport) return 0;
    const vv = window.visualViewport;
    const overlap = window.innerHeight - vv.height - vv.offsetTop;
    return overlap < 80 ? 0 : Math.round(overlap);
  }, [enabled]);

  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}
