"use client";

import { SpiralLoader } from "./SpiralLoader";

/**
 * Full-viewport centered loader. It pins to the viewport center (fixed inset-0)
 * so the spinner + label sit at exactly the same spot across every load phase —
 * the gate/checking screen and the in-document overlay — instead of jumping when
 * one swaps for the other.
 */
export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background px-6 text-center"
    >
      <SpiralLoader size={28} />
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}

/** Centered error message with an optional retry action. */
export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center"
    >
      <p className="max-w-md text-base text-foreground">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex min-h-12 items-center justify-center rounded-md border border-border bg-background px-5 text-sm font-medium text-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
