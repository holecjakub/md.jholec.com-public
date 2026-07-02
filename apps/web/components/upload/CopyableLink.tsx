"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

interface CopyableLinkProps {
  url: string;
  label: string;
  tag?: string;
  description: string;
  ariaLabelField: string;
  ariaLabelCopy: string;
  onCopied: () => void;
  /** Decorative leading glyph that distinguishes owner vs reviewer at a glance. */
  icon?: ReactNode;
  /** Subtle semantic tint to tell the links apart: owner=red, reviewer=green, agent=violet. */
  accent?: "red" | "green" | "violet";
}

// Subtle semantic tint, applied to the ICON tile only (pills stay neutral grey).
const ACCENT_TILE: Record<"red" | "green" | "violet", string> = {
  red: "bg-red-500/[0.08] text-red-500/90 dark:bg-red-500/10 dark:text-red-400/90",
  green:
    "bg-emerald-500/[0.08] text-emerald-600/90 dark:bg-emerald-500/10 dark:text-emerald-400/90",
  violet:
    "bg-violet-500/[0.08] text-violet-600/90 dark:bg-violet-500/10 dark:text-violet-400/90",
};

/**
 * Labelled read-only URL input + copy button.
 * Gate-res B6: explicit aria-label on the input, single-line scrollable, no title-only.
 * Gate-res N3: distinct aria-label per copy button instance.
 * Clipboard fallback: selects field text, announces "Press Ctrl/Cmd-C to copy".
 */
export function CopyableLink({
  url,
  label,
  tag,
  description,
  ariaLabelField,
  ariaLabelCopy,
  onCopied,
  icon,
  accent,
}: CopyableLinkProps) {
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  async function handleCopy() {
    const input = inputRef.current;
    if (!input) return;

    // Try clipboard API
    if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setFallback(false);
        onCopied();
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setCopied(false), 1500);
        return;
      } catch {
        // Fall through to manual selection fallback
      }
    }

    // Fallback: select text
    input.select();
    setFallback(true);
    setCopied(false);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setFallback(false);
    }, 3000);
  }

  const iconState = copied ? "b" : "a";

  return (
    <div className="flex flex-col gap-2">
      {/* Label row */}
      <div className="flex flex-wrap items-center gap-2">
        {icon && (
          <span
            aria-hidden="true"
            className={cn(
              "inline-flex size-7 shrink-0 items-center justify-center rounded-md",
              accent ? ACCENT_TILE[accent] : "bg-secondary text-foreground",
            )}
          >
            {icon}
          </span>
        )}
        <span className="text-sm font-medium text-foreground">{label}</span>
        {tag && (
          <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
            {tag}
          </span>
        )}
      </div>

      {/* Description */}
      <p className="text-sm text-muted-foreground">{description}</p>

      {/* URL field + copy button */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {/* Gate-res B6: aria-label, single-line scrollable */}
        <input
          ref={inputRef}
          type="text"
          readOnly
          value={url}
          aria-label={ariaLabelField}
          title={url}
          className={cn(
            "min-h-12 flex-1 rounded-lg border border-input bg-secondary/40 px-3 font-mono text-sm text-foreground",
            "min-w-0 overflow-x-auto outline-none",
            "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50",
          )}
          style={{ whiteSpace: "nowrap" }}
        />

        {/* Copy button — gate-res N3: distinct aria-label */}
        <button
          type="button"
          onClick={handleCopy}
          aria-label={ariaLabelCopy}
          className={cn(
            "inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 text-sm font-medium text-foreground",
            "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            "active:scale-[0.97] motion-reduce:active:scale-100",
            "[@media(hover:hover)]:hover:bg-secondary",
            copied && "text-accent",
          )}
        >
          {/* Icon swap */}
          <span className="t-icon-swap" data-state={iconState} aria-hidden="true">
            <span className="t-icon" data-icon="a">
              <Copy className="size-4" />
            </span>
            <span className="t-icon" data-icon="b">
              <Check className="size-4" />
            </span>
          </span>
          <span>{copied ? "Copied" : fallback ? "Press Ctrl/Cmd-C to copy" : "Copy"}</span>
        </button>
      </div>

      {/* Fallback SR announcement */}
      {fallback && (
        <p role="status" className="sr-only">
          Press Ctrl/Cmd-C to copy
        </p>
      )}
    </div>
  );
}
