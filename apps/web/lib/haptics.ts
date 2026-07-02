"use client";

/**
 * App-wide haptics, backed by the `use-haptic` library (its hook owns the actual
 * Taptic trigger — the Safari `<input type="checkbox" switch>` mechanism). Because
 * that trigger is only available from a React hook, `HapticBridge` mounts once,
 * grabs it, and registers it here so any imperative handler (reacting, posting a
 * comment, copying a link…) can fire a tap via `haptic()` without each call site
 * needing the hook.
 *
 * Everything degrades to a silent no-op where unsupported (desktop, and iOS
 * versions where Apple has closed the programmatic-trigger path), so callers never
 * have to feature-detect.
 */
let triggerRef: (() => void) | null = null;

export function registerHaptic(trigger: (() => void) | null): void {
  triggerRef = trigger;
}

/** Fire a single light haptic tap if the platform supports it; otherwise no-op. */
export function haptic(): void {
  try {
    triggerRef?.();
  } catch {
    // Never let a missing/blocked haptic break an interaction.
  }
}
