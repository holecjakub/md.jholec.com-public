"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { MessageSquareDashed } from "lucide-react";
import type { RelocateResult, RelocationCache } from "@/lib/anchor";
import type { CommentThreadDTO } from "@/lib/comments-api";
import { cn } from "@/lib/utils";
import { BlockBadge } from "./BlockBadge";
import { groupThreadsByBlock, type BlockGroup } from "./block-groups";

interface PlacedBadge {
  group: BlockGroup;
  top: number; // container-relative px — desktop gutter alignment (block top)
  blockBottom: number; // container-relative px — block end baseline (mobile anchor)
}

/** A non-orphaned relocation: carries the Range + block used for geometry. */
type LocatedAnchor = Extract<RelocateResult, { status: "exact" | "block" }>;

interface LocatedGroup {
  group: BlockGroup;
  result: LocatedAnchor;
}

const BADGE_HEIGHT = 36;
const BADGE_GAP = 8;

/**
 * Renders ONE testimonial-style badge per block that has comments, vertically
 * aligned to that block's top offset in the right gutter (desktop) / within the
 * reserved gutter (mobile). Replaces the old per-thread PinLayer.
 *
 * Threads are grouped by anchor.blockId; orphaned-anchor blocks (text removed)
 * are not gutter-placed — they collapse into a single top-bar "N on removed
 * text" control. Positions recompute on resize/content/thread change
 * (rAF-batched); colliding badges nudge downward. Anchors resolve through the
 * shared relocation cache (perf H5/H6): a thread change runs one full resolve
 * pass, while a pure resize only re-reads rects on the cached Ranges — resizing
 * never invalidates a text match.
 *
 * Hover/focus on a badge raises the block id to the parent (onHoverBlock),
 * which stamps data-emphasized on the block's underline(s) AND back on this
 * badge imperatively (perf H7 — no React re-render per hover). Clicking a
 * badge opens the block OVERVIEW (every thread on the paragraph); per-text
 * disambiguation lives on the underlines (each opens just its own thread).
 */
export function BadgeLayer({
  container,
  threads,
  cache,
  selectedBlockId,
  onOpenBlock,
  onHoverBlock,
  onOpenOrphans,
}: {
  container: HTMLElement | null;
  threads: CommentThreadDTO[];
  /** Shared relocation cache (perf H5), created per container by CommentsLayer. */
  cache: RelocationCache | null;
  selectedBlockId: string | null;
  onOpenBlock: (blockId: string, rect: DOMRect) => void;
  onHoverBlock: (blockId: string | null) => void;
  onOpenOrphans: (threadIds: string[], rect: DOMRect) => void;
}) {
  const [placed, setPlaced] = useState<PlacedBadge[]>([]);
  const [orphanIds, setOrphanIds] = useState<string[]>([]);
  const orphanRef = useRef<HTMLButtonElement>(null);
  const rafRef = useRef<number | null>(null);
  // True while the pending rAF must run a FULL pass (re-resolve anchors), not
  // just a geometry re-read. Full requests win over interleaved resize ticks.
  const wantFullRef = useRef(false);
  const threadsRef = useRef(threads);
  // Resolved geometry sources from the last full pass; a resize re-reads rects
  // on these instead of re-running relocation.
  const locatedRef = useRef<LocatedGroup[] | null>(null);

  const measure = useCallback(
    (full: boolean) => {
      if (!container || !cache) return;
      const currentThreads = threadsRef.current;

      let located = full ? null : locatedRef.current;
      // A cached block can be detached and an exact Range silently collapsed by
      // a highlight rewrap or content change between geometry ticks — any drift
      // falls back to a full resolve pass rather than measuring dead nodes.
      if (
        located &&
        located.some(
          (l) =>
            !l.result.block.isConnected ||
            (l.result.status === "exact" &&
              l.result.range.toString() !== l.group.threads[0]?.root.anchor.quote),
        )
      ) {
        located = null;
      }

      if (!located) {
        const groups = groupThreadsByBlock(currentThreads);
        const pass = cache.beginPass(new Set(currentThreads.map((t) => t.root.id)));
        const next: LocatedGroup[] = [];
        const orphans: string[] = [];
        for (const group of groups) {
          // Use the first thread's anchor to locate the block geometry.
          const first = group.threads[0];
          if (!first) continue;
          const result = pass.resolve(first.root.id, first.root.anchor);
          if (result.status === "orphaned") {
            orphans.push(...group.threads.map((t) => t.root.id));
            continue;
          }
          next.push({ group, result });
        }
        located = next;
        locatedRef.current = next;
        setOrphanIds((prev) => (sameStrings(prev, orphans) ? prev : orphans));
      }

      const containerRect = container.getBoundingClientRect();
      const placedNext: PlacedBadge[] = [];
      for (const { group, result } of located) {
        const rect = result.range.getBoundingClientRect();
        const blockRect = result.block.getBoundingClientRect();
        const rawTop = rect.height === 0 && rect.top === 0 ? blockRect.top : rect.top;
        const top = rawTop - containerRect.top + container.scrollTop;
        // Block end, container-relative. On mobile (no gutter) the badge anchors
        // below the block's last line so it can never overlap a long first line.
        const blockBottom = blockRect.bottom - containerRect.top + container.scrollTop;
        placedNext.push({ group, top, blockBottom });
      }

      placedNext.sort((a, b) => a.top - b.top);
      let lastBottom = -Infinity;
      for (const p of placedNext) {
        if (p.top < lastBottom + BADGE_GAP) p.top = lastBottom + BADGE_GAP;
        lastBottom = p.top + BADGE_HEIGHT;
      }

      // Skip the setState when nothing moved (the common resize/echo tick), so
      // pure geometry re-checks never re-render every badge — and badge DOM
      // writes can't re-trigger further measurement echoes.
      setPlaced((prev) => (samePlacement(prev, placedNext) ? prev : placedNext));
    },
    [container, cache],
  );

  const scheduleMeasure = useCallback(
    (full: boolean) => {
      if (full) wantFullRef.current = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const wantFull = wantFullRef.current;
        wantFullRef.current = false;
        measure(wantFull);
      });
    },
    [measure],
  );

  // Thread identity changes (and mount / container swap) → full resolve pass.
  useEffect(() => {
    threadsRef.current = threads;
    scheduleMeasure(true);
  }, [threads, scheduleMeasure]);

  // Pure geometry changes → rect re-reads on the cached Ranges only (perf H6).
  useEffect(() => {
    if (!container) return;
    const onGeometry = () => scheduleMeasure(false);
    const ro = new ResizeObserver(onGeometry);
    ro.observe(container);
    window.addEventListener("resize", onGeometry);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onGeometry);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [container, scheduleMeasure]);

  return (
    <>
      {orphanIds.length > 0 ? (
        <button
          ref={orphanRef}
          type="button"
          onClick={() => {
            const r = orphanRef.current?.getBoundingClientRect();
            if (r) onOpenOrphans(orphanIds, r);
          }}
          aria-label={`${orphanIds.length} comments on removed text`}
          className={cn(
            "absolute right-1 top-2 z-10 inline-flex h-9 items-center gap-1.5 rounded-full border border-dashed border-border bg-elevated px-3 text-xs text-muted-foreground shadow-sm md:right-auto md:left-full md:ml-3",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          )}
        >
          <MessageSquareDashed aria-hidden className="size-4" />
          <span className="tabular-nums">{orphanIds.length}</span>
        </button>
      ) : null}

      {placed.map((p) => (
        <PositionedBadge
          key={p.group.blockId}
          placed={p}
          selected={selectedBlockId === p.group.blockId}
          onOpen={onOpenBlock}
          onHoverChange={(hovered) =>
            onHoverBlock(hovered ? p.group.blockId : null)
          }
        />
      ))}
    </>
  );
}

BadgeLayer.displayName = "BadgeLayer";

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Group equality for the placement skip: same block and the SAME thread objects
 * (B-STATE keeps unchanged threads reference-stable, so reference equality here
 * means every derived field — participants, reactions, resolved — is identical).
 */
function sameGroup(a: BlockGroup, b: BlockGroup): boolean {
  if (a === b) return true;
  if (a.blockId !== b.blockId || a.threads.length !== b.threads.length) return false;
  for (let i = 0; i < a.threads.length; i++) {
    if (a.threads[i] !== b.threads[i]) return false;
  }
  return true;
}

function samePlacement(a: readonly PlacedBadge[], b: readonly PlacedBadge[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.top !== y.top || x.blockBottom !== y.blockBottom) return false;
    if (!sameGroup(x.group, y.group)) return false;
  }
  return true;
}

function PositionedBadge({
  placed,
  selected,
  onOpen,
  onHoverChange,
}: {
  placed: PlacedBadge;
  selected: boolean;
  onOpen: (blockId: string, rect: DOMRect) => void;
  onHoverChange: (hovered: boolean) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const { group, top, blockBottom } = placed;
  // Px-valued custom props consumed by the responsive `top-(--var)` utilities
  // (Tailwind v4 custom-property shorthand). Mobile anchors below the block end
  // (+ a small gap); desktop aligns to the block top. CSSProperties has no `--*`
  // index, so we widen the type via an intersection rather than `any`.
  const positionVars: CSSProperties & Record<"--badge-top" | "--badge-bottom", string> = {
    "--badge-top": `${top}px`,
    "--badge-bottom": `${blockBottom + 4}px`,
  };
  return (
    // Responsive positioning, mirroring the prose column geometry:
    // - mobile (< md): right-1, anchored to the BLOCK END (top-(--badge-bottom))
    //   on its own baseline below the last line, so it can never overlap a long
    //   first line / wrapped prose. A small gap lifts it off the text.
    // - desktop (≥ md): LEFT-anchored just outside the prose column (left-full +
    //   margin) so every badge's avatar stack begins at the same x — a clean
    //   avatar column down the gutter — and reactions/count flow rightward.
    //   Vertically aligned to the block TOP (top-(--badge-top)).
    <div
      className="absolute right-1 z-10 top-(--badge-bottom) md:right-auto md:left-full md:ml-3 md:top-(--badge-top)"
      style={positionVars}
    >
      <BlockBadge
        ref={ref}
        group={group}
        selected={selected}
        onHoverChange={onHoverChange}
        onOpen={() => {
          const r = ref.current?.getBoundingClientRect();
          if (r) onOpen(group.blockId, r);
        }}
      />
    </div>
  );
}

PositionedBadge.displayName = "PositionedBadge";
