"use client";

import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface UploadConfirmButtonProps {
  phase: "idle" | "uploading" | "success";
  onActivate: () => void;
  describedById: string;
}

/**
 * Full-width morphing primary button: idle → spinner → check.
 * Gate-res B7: uses aria-disabled + aria-busy while uploading, NOT HTML disabled.
 * Stays focusable; click handler early-returns when aria-disabled.
 */
export function UploadConfirmButton({
  phase,
  onActivate,
  describedById,
}: UploadConfirmButtonProps) {
  const isBusy = phase === "uploading";

  function handleClick() {
    // Intercept activation when aria-disabled (gate-res B7)
    if (isBusy) return;
    onActivate();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (isBusy && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
    }
  }

  return (
    <button
      type="submit"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-disabled={isBusy || undefined}
      aria-busy={isBusy || undefined}
      aria-describedby={isBusy ? describedById : undefined}
      className={cn(
        "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg px-4 text-base font-medium",
        "transition-[background-color,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "active:scale-[0.97] motion-reduce:active:scale-100",
        "[@media(hover:hover)]:hover:bg-primary/90",
        isBusy
          ? "cursor-not-allowed bg-primary text-primary-foreground opacity-60"
          : "bg-primary text-primary-foreground",
      )}
    >
      {isBusy && (
        <Loader2
          className="size-4 motion-safe:animate-spin"
          aria-hidden="true"
        />
      )}
      <span>
        {isBusy ? "Creating your link…" : "Create share link"}
      </span>
    </button>
  );
}
