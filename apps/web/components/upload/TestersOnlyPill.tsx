import { FlaskConical } from "lucide-react";

/**
 * Static "Testers only" pill.
 * SR-readable in both Locked and Unlock states (never aria-hidden).
 */
export function TestersOnlyPill() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-1 text-xs font-medium text-muted-foreground">
      <FlaskConical className="size-3" aria-hidden="true" />
      Testers only
    </span>
  );
}
