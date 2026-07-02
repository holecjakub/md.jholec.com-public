"use client";

import { forwardRef } from "react";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/lib/use-media-query";
import { Avatar } from "./Avatar";
import { useMountedKeys } from "@/lib/use-mounted-keys";
import type { BlockGroup } from "./block-groups";

// The badge sits in a narrow right gutter; on small screens it must stay slim so
// it never bleeds into the prose. Fewer avatars + fewer summary emoji on mobile.
const MAX_AVATARS_DESKTOP = 3;
const MAX_AVATARS_MOBILE = 2;
const MAX_EMOJI_DESKTOP = 3;
const MAX_EMOJI_MOBILE = 1;

/**
 * A compact "testimonial" badge representing all comments on one block: an
 * overlapping stack of up to 3 commenter avatars (then +N) and, when any
 * reactions exist, a summary chip of the distinct emoji used on the block with a
 * small total count. Real <button>, keyboard-operable, ≥44px target.
 *
 * It is a QUIET, non-expanding indicator: hover/focus emphasises the block's
 * underline(s) via the shared hovered state in CommentsLayer, and a click opens
 * the block OVERVIEW popover (every thread on the paragraph) — the "everything on
 * this paragraph" affordance. Per-text disambiguation lives on the inline
 * underlines themselves (clicking a sentence's underline opens just that comment),
 * so the badge never fans out. Multi-thread blocks add a faint count pip so the
 * reader knows the overview holds more than one thread. Resolved blocks render
 * muted.
 */
export const BlockBadge = forwardRef<
  HTMLButtonElement,
  {
    group: BlockGroup;
    selected: boolean;
    /** Block-level emphasis (badge ↔ all-underlines hint). */
    emphasized: boolean;
    /** Open the block overview popover (all threads on the block). */
    onOpen: () => void;
    /** Block-level hover (lights every underline on the block). */
    onHoverChange: (hovered: boolean) => void;
    className?: string;
  }
>(function BlockBadge(
  { group, selected, emphasized, onOpen, onHoverChange, className },
  ref,
) {
  const { participants, reactions, resolved, threads } = group;
  // `sm` = 640px (Tailwind). Below it, cap to 2 avatars + 1 emoji so the badge
  // stays narrow on phones and never overlaps the document text.
  const isWide = useMediaQuery("(min-width: 640px)");
  const maxAvatars = isWide ? MAX_AVATARS_DESKTOP : MAX_AVATARS_MOBILE;
  const extra = participants.length - maxAvatars;
  const shownAvatars = participants.slice(0, maxAvatars);
  const totalReactions = reactions.reduce((sum, r) => sum + r.count, 0);
  const distinctEmoji = reactions.slice(0, isWide ? MAX_EMOJI_DESKTOP : MAX_EMOJI_MOBILE);

  // Pop only avatars / summary emoji that appear AFTER this badge first mounted
  // (a new commenter, a reaction that just landed) — never the set present on
  // initial load.
  const newAvatars = useMountedKeys(shownAvatars);
  const newEmoji = useMountedKeys(distinctEmoji.map((r) => r.emoji));

  const threadCount = threads.length;
  const multi = threadCount > 1;
  const peopleLabel =
    participants.length === 1 ? participants[0] : `${participants.length} people`;
  const label = `${threadCount} ${threadCount === 1 ? "comment thread" : "comment threads"} from ${peopleLabel}${
    totalReactions > 0 ? `, ${totalReactions} reactions` : ""
  }`;

  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
      onFocus={() => onHoverChange(true)}
      onBlur={() => onHoverChange(false)}
      aria-label={label}
      data-resolved={resolved || undefined}
      data-emphasized={emphasized || undefined}
      className={cn(
        // A quiet elevated pill. The flex gap collapses to nothing when avatars
        // are the only child, so an avatar-only badge carries no dangling empty
        // space on its right edge.
        "group inline-flex h-9 min-h-9 items-center gap-1.5 rounded-full border bg-elevated py-1 pl-1 pr-2.5 shadow-sm transition-all",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        // Direct hover feedback (independent of the badge↔underline emphasis
        // round-trip) so the badge reacts even when it carries no reactions.
        "hover:border-accent/60 hover:shadow-md",
        selected || emphasized ? "border-accent ring-1 ring-accent" : "border-border",
        resolved && "opacity-55",
        className,
      )}
    >
      <AvatarStack
        shownAvatars={shownAvatars}
        extra={extra}
        isNew={(name) => newAvatars.has(name)}
      />
      {totalReactions > 0 ? (
        <ReactionChip
          distinctEmoji={distinctEmoji}
          total={totalReactions}
          isNew={(emoji) => newEmoji.has(emoji)}
        />
      ) : null}
      {/* Multi-thread hint: a legible outlined count telling the reader the
          overview holds more than one thread (the underlines open them
          individually). Bordered + foreground text so it never reads as the
          blank grey dot a filled muted pill produced. */}
      {multi ? (
        <span
          aria-hidden
          className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-border px-1 text-[0.65rem] font-medium tabular-nums text-foreground/70"
        >
          {threadCount}
        </span>
      ) : null}
    </button>
  );
});

BlockBadge.displayName = "BlockBadge";

function AvatarStack({
  shownAvatars,
  extra,
  isNew,
}: {
  shownAvatars: string[];
  extra: number;
  isNew: (key: string) => boolean;
}) {
  return (
    // -space-x-1.5 (gentler than -2) keeps the overlap readable so the first
    // avatar's initials aren't clipped behind the second. Rings match the
    // elevated badge surface so each avatar reads as cut out of the pill.
    <span className="flex shrink-0 items-center -space-x-1.5">
      {shownAvatars.map((name) => (
        <Avatar
          key={name}
          name={name}
          size="sm"
          animateIn={isNew(name)}
          className="size-6 text-[0.6rem] ring-2 ring-elevated"
        />
      ))}
      {extra > 0 ? (
        // SOLID (opaque) grey fill with the page background as the text color, so
        // the "+N" reads with strong contrast in both themes — not a faint
        // translucent tint. (bg-muted-foreground is a mid-grey in both themes;
        // text-background is white on light / near-black on dark.)
        <span className="z-10 inline-flex size-6 items-center justify-center rounded-full bg-muted-foreground text-[0.6rem] font-semibold text-background ring-2 ring-elevated tabular-nums">
          +{extra}
        </span>
      ) : null}
    </span>
  );
}

AvatarStack.displayName = "AvatarStack";

function ReactionChip({
  distinctEmoji,
  total,
  isNew,
}: {
  distinctEmoji: { emoji: string; count: number }[];
  total: number;
  isNew: (key: string) => boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-xs leading-none">
      {/* An even gap reads cleaner than the old overlap, which smeared the
          emoji into one another. */}
      <span aria-hidden className="inline-flex items-center gap-0.5">
        {distinctEmoji.map((r) => (
          <span
            key={r.emoji}
            className={cn(
              "inline-block leading-none",
              isNew(r.emoji) && "motion-safe:animate-badge-pop",
            )}
          >
            {r.emoji}
          </span>
        ))}
      </span>
      <span className="font-medium tabular-nums text-muted-foreground">{total}</span>
    </span>
  );
}

ReactionChip.displayName = "ReactionChip";
