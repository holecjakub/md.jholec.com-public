"use client";

import { cn } from "@/lib/utils";
import { useMountedKeys } from "@/lib/use-mounted-keys";
import { haptic } from "@/lib/haptics";
import type { ReactionGroup } from "@/lib/comments-api";
import { EMOJI_OPTIONS } from "./emoji";

/**
 * The in-thread reaction control. ONE row that merges what used to be a separate
 * count summary and a separate quick-react picker:
 *
 * - every palette emoji is a toggle; tapping it adds your reaction instantly (no
 *   confirm step) and tapping again removes it — the pressed state is the
 *   confirmation.
 * - an emoji that has reactions grows into a pill with its count on the right; an
 *   emoji with none stays a round "add" button. So a single glance shows both
 *   what's been reacted and what you can add.
 */
export function ReactionBar({
  reactions,
  onToggle,
  disabled = false,
}: {
  reactions: ReactionGroup[];
  onToggle: (emoji: string) => void;
  disabled?: boolean;
}) {
  const byEmoji = new Map(reactions.map((r) => [r.emoji, r]));
  // Pop an emoji only when it newly gains a count (a reaction just landed). We
  // feed the tracker only the emoji that currently HAVE a count, so emoji that
  // already had reactions when the bar first mounted are seeded as known and
  // never pop; an emoji going 0 -> positive is reported new exactly once.
  const newReactions = useMountedKeys(
    reactions.filter((r) => r.count > 0).map((r) => r.emoji),
  );
  return (
    <div role="group" aria-label="Reactions" className="flex flex-wrap items-center gap-1">
      {EMOJI_OPTIONS.map(({ emoji, label }) => {
        const group = byEmoji.get(emoji);
        const count = group?.count ?? 0;
        const mine = group?.mine ?? false;
        const hasCount = count > 0;
        const popReaction = hasCount && newReactions.has(emoji);
        return (
          <button
            key={emoji}
            type="button"
            aria-label={mine ? `Remove your ${label} reaction` : `React: ${label}`}
            aria-pressed={mine}
            disabled={disabled}
            onClick={() => {
              haptic();
              onToggle(emoji);
            }}
            className={cn(
              "inline-flex h-8 items-center justify-center rounded-full border text-sm leading-none transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              // Pill (emoji + count) when reacted; round add-button when empty.
              hasCount ? "gap-1 px-2.5" : "w-8 px-0",
              popReaction && "motion-safe:animate-badge-pop",
              mine
                ? "border-accent bg-accent/15 text-foreground ring-1 ring-accent hover:bg-accent/20"
                : "border-border text-muted-foreground hover:border-foreground/30 hover:bg-muted/50 hover:text-foreground",
              disabled && "pointer-events-none opacity-50",
            )}
          >
            <span aria-hidden className="leading-none">
              {emoji}
            </span>
            {hasCount ? (
              <span className="text-xs font-medium tabular-nums">{count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

ReactionBar.displayName = "ReactionBar";
