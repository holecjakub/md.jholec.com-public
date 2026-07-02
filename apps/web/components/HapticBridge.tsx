"use client";

import { useEffect } from "react";
import { useHaptic } from "use-haptic";
import { registerHaptic } from "@/lib/haptics";

/**
 * Mounts once (in Providers) to expose the `use-haptic` trigger to the imperative
 * `haptic()` helper. Renders nothing.
 */
export function HapticBridge() {
  const { triggerHaptic } = useHaptic();
  useEffect(() => {
    registerHaptic(triggerHaptic);

    // On iOS the library fires haptics by `.click()`-ing a hidden <label> on
    // <body> (the only way to pulse the Taptic engine from JS). That synthetic
    // click bubbles to the document and dismiss-on-outside popovers (Base UI)
    // read it as an outside interaction — so reacting inside the thread popover
    // would slam it shut. Swallow clicks that originate from the haptic helper in
    // the capture phase, before any popover dismissal logic can see them.
    const swallowHapticClick = (e: MouseEvent) => {
      const target = e.target as (HTMLElement & { htmlFor?: string }) | null;
      if (
        target &&
        (target.id === "haptic-switch" || target.htmlFor === "haptic-switch")
      ) {
        e.stopImmediatePropagation();
      }
    };
    document.addEventListener("click", swallowHapticClick, true);

    return () => {
      registerHaptic(null);
      document.removeEventListener("click", swallowHapticClick, true);
    };
  }, [triggerHaptic]);
  return null;
}

HapticBridge.displayName = "HapticBridge";
