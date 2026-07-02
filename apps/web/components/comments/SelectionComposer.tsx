"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { TextQuoteAnchor } from "@md/core";
import { cn } from "@/lib/utils";
import { useCoarsePointer } from "@/lib/use-coarse-pointer";
import { useKeyboardInset } from "@/lib/use-keyboard-inset";
import { CommentComposer } from "./CommentComposer";
import { EmojiRow } from "./EmojiRow";

/**
 * Live union rect of the persistent selection highlight (the spans
 * CommentsLayer paints over the commented text, kept visible after the textarea
 * steals native focus). Used as a LIVE anchor so the composer tracks the text's
 * real on-screen position through scrolls — the frozen capture-time rect went
 * stale the moment iOS auto-scrolled the page on focus, which is what threw the
 * popup (and its emoji footer) under the keyboard.
 */
function selectionHighlightRect(): DOMRect | null {
  if (typeof document === "undefined") return null;
  const spans = document.querySelectorAll<HTMLElement>("[data-selection-highlight]");
  if (spans.length === 0) return null;
  let top = Infinity;
  let left = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  spans.forEach((s) => {
    const r = s.getBoundingClientRect();
    top = Math.min(top, r.top);
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  });
  return new DOMRect(left, top, right - left, bottom - top);
}

/**
 * Inline composer that floats above the active text selection (ChatGPT/iOS
 * style). Anchored via a Base UI Popover positioned against a virtual element
 * whose rect is the selection's bounding box. Submitting text posts a comment;
 * tapping an emoji posts a one-emoji comment (the documented selection-emoji
 * model). Dismisses on outside-click / Esc (Base UI dismissable layer).
 *
 * Design (inspiration 01 + 03):
 * - rounded-2xl "unified field" — the popover frame IS the field, no inner border
 * - auto-growing borderless textarea (1–4 lines)
 * - single footer row: emoji quick-react strip (left) + round send button (right)
 *   so the widget reads as one integrated feedback block
 * - arrow below the popup points at the selected text
 *
 * Mobile keyboard handling — the whole point of the docking below:
 * - keyboard CLOSED: float by the selected text (anchored to the live highlight
 *   rect), placed below it (or flipped above) so the selected line is never
 *   covered, on desktop or mobile.
 * - keyboard OPEN (touch): dock the composer just above the keyboard so the emoji
 *   row + send button stay visible, mirroring the thread-detail reply that sits
 *   above the keyboard. The composer anchors to an invisible bar pinned at the
 *   keyboard's top edge, and we scroll the selected text up if the dock would
 *   cover it.
 */
export function SelectionComposer({
  open,
  rect,
  anchor,
  onClose,
  onSubmitText,
  onSubmitEmoji,
}: {
  open: boolean;
  rect: DOMRect | null;
  anchor: TextQuoteAnchor | null;
  onClose: () => void;
  onSubmitText: (anchor: TextQuoteAnchor, body: string) => Promise<void>;
  onSubmitEmoji: (anchor: TextQuoteAnchor, emoji: string) => Promise<void>;
}) {
  // submitRef: CommentComposer writes its current submit fn here each render.
  const submitRef = useRef<(() => Promise<void>) | null>(null);
  // isEmpty: CommentComposer notifies us when content changes so we can show
  // the send button in the active state. Starts true (field is empty on open).
  const [isEmpty, setIsEmpty] = useState(true);

  // On touch, the software keyboard overlays the bottom of the screen. Dock the
  // composer above it when it's up; float by the selection when it isn't.
  const isTouch = useCoarsePointer();
  const keyboardInset = useKeyboardInset(isTouch && open);
  const keyboardOpen = isTouch && keyboardInset > 0;

  // Invisible 1px bar pinned at the keyboard's top edge. Anchoring to a REAL
  // fixed element (not a hand-rolled rect) lets Floating UI do the visual-vs-
  // layout-viewport coordinate reconciliation that iOS needs.
  const [dockEl, setDockEl] = useState<HTMLDivElement | null>(null);

  // Keep the last non-null capture rect so the live anchor has a fallback before
  // the highlight spans mount.
  const lastRectRef = useRef<DOMRect | null>(rect);
  useEffect(() => {
    if (rect) lastRectRef.current = rect;
  }, [rect]);

  // Stable virtual anchor for the floating (keyboard-closed) state: reads the
  // LIVE highlight rect on every Floating UI measure so it follows the text.
  const textAnchor = useMemo(
    () => ({
      getBoundingClientRect: () =>
        selectionHighlightRect() ?? lastRectRef.current ?? new DOMRect(),
    }),
    [],
  );

  const popupRef = useRef<HTMLDivElement>(null);

  // When docked, the selected text may sit behind the dock/keyboard. Nudge the
  // page up so the highlighted line clears the composer's top edge. Best-effort:
  // re-runs as the keyboard settles (inset changes) and no-ops once clear.
  useEffect(() => {
    if (!keyboardOpen) return;
    const raf = requestAnimationFrame(() => {
      const popup = popupRef.current;
      const textRect = selectionHighlightRect();
      if (!popup || !textRect) return;
      const overlap = textRect.bottom - popup.getBoundingClientRect().top;
      if (overlap > -8) {
        window.scrollBy({ top: overlap + 16, left: 0, behavior: "smooth" });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [keyboardOpen, keyboardInset]);

  const anchorForState = keyboardOpen ? dockEl : textAnchor;

  return (
    <>
      {/* Dock target: a zero-height, full-width bar at the keyboard's top edge.
          Fixed elements sit in the layout viewport (which the keyboard does NOT
          shrink), so bottom = keyboard height lands it exactly on the keyboard's
          top edge. Always rendered so its ref is ready before the keyboard opens. */}
      <div
        ref={setDockEl}
        aria-hidden
        className="pointer-events-none fixed inset-x-0 z-40 h-0"
        style={{ bottom: keyboardInset }}
      />
      <PopoverPrimitive.Root
        open={open && anchor !== null && (keyboardOpen ? dockEl !== null : true)}
        onOpenChange={(next) => {
          if (!next) {
            onClose();
            setIsEmpty(true);
          }
        }}
      >
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Positioner
            anchor={anchorForState}
            side={keyboardOpen ? "top" : "bottom"}
            align="center"
            sideOffset={keyboardOpen ? 8 : 10}
            collisionPadding={{ top: 64, right: 12, bottom: 12, left: 12 }}
            className="isolate z-50"
          >
            <PopoverPrimitive.Popup
              ref={popupRef}
              initialFocus={false}
              className="relative flex w-[min(20rem,calc(100vw-1.5rem))] flex-col rounded-2xl bg-elevated p-3 text-sm text-foreground shadow-[0_8px_30px_rgba(0,0,0,0.12)] ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
              aria-label="Add a comment on the selected text"
            >
              {anchor ? (
                <>
                  {/* Page-coloured input field on the elevated surface — mirrors the
                      thread-detail reply box (grey container, black/white field). */}
                  <div className="rounded-lg border border-border bg-background px-3 py-2">
                    <CommentComposer
                      placeholder="Add a comment…"
                      submitLabel="Comment"
                      autoFocus
                      compact
                      renderSendButton={false}
                      submitRef={submitRef}
                      onEmptyChange={setIsEmpty}
                      onSubmit={async (body) => {
                        onClose();
                        setIsEmpty(true);
                        await onSubmitText(anchor, body);
                      }}
                    />
                  </div>
                  {/*
                   * Integrated footer row (inspiration 03-feedback):
                   * emoji quick-react (left) + round send button (right).
                   */}
                  <div className="mt-2 flex items-center justify-between">
                    <EmojiRow
                      onSelect={(emoji) => {
                        void (async () => {
                          onClose();
                          await onSubmitEmoji(anchor, emoji);
                        })();
                      }}
                    />
                    <button
                      type="button"
                      aria-label="Comment"
                      onClick={() => void submitRef.current?.()}
                      disabled={isEmpty}
                      className={cn(
                        "inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-all",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                        isEmpty
                          ? "cursor-default text-muted-foreground/30 pointer-events-none"
                          : "bg-foreground text-background hover:bg-foreground/80 active:scale-[0.96]",
                      )}
                    >
                      <ArrowUp aria-hidden className="size-4" />
                    </button>
                  </div>
                </>
              ) : null}
              {/*
               * Arrow points at the selected text only when floating beside it.
               * When docked above the keyboard the arrow would point at the
               * keyboard (meaningless), so it's suppressed.
               *
               * Base UI sets `position:absolute` + `left` via inline style to
               * center it; data-[side] is the actual rendered side. Rounded
               * diamond tip whose border is drawn only on the two OUTER (pointing)
               * edges, so the popup's outline continues unbroken around the tip.
               */}
              {keyboardOpen ? null : (
                <PopoverPrimitive.Arrow
                  className={cn(
                    "size-2.5 rotate-45 rounded-tl-[3px] bg-elevated border-foreground/10",
                    "data-[side=bottom]:top-[-4px] data-[side=bottom]:border-l data-[side=bottom]:border-t",
                    "data-[side=top]:bottom-[-4px] data-[side=top]:border-r data-[side=top]:border-b data-[side=top]:rounded-tl-none data-[side=top]:rounded-br-[3px]",
                    "data-[side=left]:right-[-4px] data-[side=left]:border-t data-[side=left]:border-r data-[side=left]:rounded-tl-none data-[side=left]:rounded-tr-[3px]",
                    "data-[side=right]:left-[-4px] data-[side=right]:border-b data-[side=right]:border-l data-[side=right]:rounded-tl-none data-[side=right]:rounded-bl-[3px]",
                  )}
                />
              )}
            </PopoverPrimitive.Popup>
          </PopoverPrimitive.Positioner>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    </>
  );
}

SelectionComposer.displayName = "SelectionComposer";
