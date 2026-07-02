"use client";

import { useEffect, useState } from "react";

/**
 * True when the primary pointer is coarse and cannot hover (touch devices).
 * Drives the comment fan-out's two-stage tap (locate → open) vs the mouse's
 * hover-locates / click-opens behaviour. SSR-safe: starts false, resolves on
 * mount, and tracks changes (e.g. a hybrid device docking/undocking).
 */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(hover: none) and (pointer: coarse)");
    const update = () => setCoarse(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  return coarse;
}
