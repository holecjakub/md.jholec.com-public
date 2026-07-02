"use client";

import { cn } from "@/lib/utils";
import { EMOJI_OPTIONS } from "./emoji";

/**
 * The shared emoji quick-row. In the selection composer each tap CREATES a
 * one-emoji comment; in a thread each tap toggles a reaction (the `active` set
 * reflects the viewer's own reactions).
 *
 * Visual footprint: 32px visible button with 44px tap area (via negative margin /
 * padding) so the touch target stays AA while the row looks tight. Each emoji is
 * kept on a single baseline with leading-none.
 */
export function EmojiRow({
  onSelect,
  active,
  disabled = false,
  hiddenEmojis,
}: {
  onSelect: (emoji: string) => void;
  active?: Set<string>;
  disabled?: boolean;
  /**
   * Emojis to hide from the quick-row (e.g. already shown as summary chips).
   * Hidden buttons are rendered as invisible placeholders to preserve row width.
   */
  hiddenEmojis?: Set<string>;
}) {
  return (
    <div role="group" aria-label="Quick reactions" className="flex items-center gap-0.5">
      {EMOJI_OPTIONS.map(({ emoji, label }) => {
        const isActive = active?.has(emoji) ?? false;
        const isHidden = hiddenEmojis?.has(emoji) ?? false;
        return (
          <button
            key={emoji}
            type="button"
            aria-label={label}
            aria-pressed={active ? isActive : undefined}
            disabled={disabled || isHidden}
            tabIndex={isHidden ? -1 : undefined}
            onClick={() => onSelect(emoji)}
            className={cn(
              // 44px touch target via padding; 32px visual via size-8
              "-m-1 inline-flex size-8 items-center justify-center rounded-full p-1 text-base leading-none transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              "hover:bg-muted/60 disabled:pointer-events-none",
              isActive &&
                "bg-accent/15 text-accent ring-1 ring-accent ring-offset-1 ring-offset-background hover:bg-accent/20",
              isHidden && "opacity-0 pointer-events-none",
            )}
          >
            <span aria-hidden className="leading-none">
              {emoji}
            </span>
          </button>
        );
      })}
    </div>
  );
}

EmojiRow.displayName = "EmojiRow";
