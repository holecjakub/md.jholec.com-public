"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

// useLayoutEffect on the server warns; the new-key detection only ever matters
// after mount (initial load pops nothing), so falling back to useEffect on the
// server is safe and silences the warning.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

const EMPTY: ReadonlySet<string> = new Set();

/**
 * Given the stable keys rendered this pass, returns the subset that is NEWLY
 * appearing — empty on the first commit (initial load pops nothing) and,
 * thereafter, exactly the keys never seen before. Used to pop ONLY newly-added
 * items (a new participant avatar, a reaction that just landed) and never on
 * plain re-renders.
 *
 * The set is computed in a layout effect (refs are touched only there, never
 * during render — and it runs before paint, so a newly-flagged item gets its
 * one-shot enter animation on its first painted frame, no flash). A key is
 * reported new for the renders between the change that introduced it and the
 * next key change; the CSS animation is a one-shot, so a persistent class does
 * not replay on unrelated re-renders.
 */
export function useMountedKeys(keys: readonly string[]): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const [newKeys, setNewKeys] = useState<ReadonlySet<string>>(EMPTY);

  // Stable primitive dependency so the effect only runs when the key set
  // changes. Joined on a newline — a character that cannot appear in a
  // participant name or emoji, so distinct key sets never collide.
  const signature = keys.join("\n");

  useIsomorphicLayoutEffect(() => {
    if (seen.current === null) {
      // First commit: seed everything present as already-known; pop nothing.
      seen.current = new Set(keys);
      return;
    }
    const fresh = new Set<string>();
    for (const k of keys) {
      if (!seen.current.has(k)) {
        seen.current.add(k);
        fresh.add(k);
      }
    }
    setNewKeys((prev) => (fresh.size > 0 ? fresh : prev.size > 0 ? EMPTY : prev));
    // `keys` is captured via `signature`; re-running only on key-set change is
    // intentional (avoids re-popping on unrelated re-renders).
  }, [signature]);

  return newKeys;
}
