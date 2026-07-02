"use client";

import { useSyncExternalStore } from "react";

/**
 * Subscribe to a CSS media query. Implemented with useSyncExternalStore so it is
 * hydration-safe and lint-clean (no setState-in-effect): the server snapshot is
 * `false`, the client snapshot reads `matchMedia`.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
