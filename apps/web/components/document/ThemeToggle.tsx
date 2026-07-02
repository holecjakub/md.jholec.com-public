"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

// Subscribe-less store: the server snapshot is always `false` (unmounted) and
// the client snapshot is always `true`. After hydration React reconciles the
// two, flipping `mounted` to true without ever calling setState in an effect.
const emptySubscribe = () => () => {};

/**
 * Light/dark toggle. Mount-guarded: until mounted we render a stable, inert
 * placeholder so server and first client paint match (no hydration mismatch).
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

  const isDark = resolvedTheme === "dark";
  const baseClasses = cn(
    "inline-flex size-12 items-center justify-center rounded-md text-foreground",
    "transition-colors hover:bg-secondary",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    className,
  );

  if (!mounted) {
    return (
      <span
        aria-hidden="true"
        className={baseClasses}
      >
        <Sun className="size-5" />
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className={baseClasses}
    >
      {isDark ? <Sun className="size-5" /> : <Moon className="size-5" />}
    </button>
  );
}
