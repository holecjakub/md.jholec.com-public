"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { TextQuoteAnchor } from "@md/core";
import type { DocPayload } from "@/lib/document-api";
import { useComments } from "@/hooks/useComments";
import { useAnnouncer } from "@/components/ui/live-region";
import { cn } from "@/lib/utils";
import { ActionBar, type ViewMode } from "./ActionBar";
import { MarkdownPreview } from "./MarkdownPreview";
import { CodeView } from "./CodeView";
import { CommentsLayer } from "@/components/comments/CommentsLayer";

// Preview ↔ Code transition: a soft crossfade (opacity + a small blur lifting
// to 0). Both panels stay MOUNTED across toggles — unmounting the preview
// forced a full react-markdown re-parse (a 1.5–3s freeze on large docs /
// mobile), so the swap only flips these classes. `visibility` is listed as a
// transition property so it flips discretely at the fade edges (stays visible
// while fading out, shows immediately when fading in). We animate ONLY
// opacity + filter, never a transform — CommentsLayer measures pin/highlight
// geometry via getBoundingClientRect on the preview node, and opacity/blur are
// geometry-neutral whereas a transform (scale/translate) would skew a
// mid-animation measurement and drift the pins. The hidden panel is absolutely
// positioned so the flow height always follows the active panel, and is inert
// + aria-hidden so it cannot be read, focused, or clicked.
const panelBase =
  "transition-[opacity,filter,visibility] duration-200 ease-out motion-reduce:transition-none";
const panelShown = "visible opacity-100 blur-none";
const panelHidden = "invisible absolute inset-x-0 top-0 opacity-0 blur-sm";

// localStorage key for the one-time select-to-comment hint (audit M8): the
// selection affordance is otherwise invisible on first load. Per-browser, not
// per-document — once a reader has seen (or used) commenting anywhere, the
// hint has done its job.
const COMMENT_HINT_KEY = "md:comment-hint-dismissed";

/** The rendered document experience once a session exists. */
export function DocumentView({ data }: { data: DocPayload }) {
  const [view, setView] = useState<ViewMode>("preview");
  // The Code panel mounts on its FIRST visit and then stays mounted forever
  // (hidden, not unmounted), so later toggles are pure class flips in both
  // directions. Deferring the first mount keeps the initial render free of the
  // duplicate raw-source DOM for readers who never open the Code view.
  const [codeMounted, setCodeMounted] = useState(false);
  const handleViewChange = useCallback((v: ViewMode) => {
    setView(v);
    if (v === "code") setCodeMounted(true);
  }, []);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${data.document.title} - md.jholec.com`;
    return () => {
      document.title = previousTitle;
    };
  }, [data.document.title]);

  // The preview element (carries the [data-block-id] blocks) — anchoring +
  // pin geometry are measured against it. Held in state (not a ref) so the
  // CommentsLayer re-renders once the node is attached.
  const [previewEl, setPreviewEl] = useState<HTMLElement | null>(null);

  // Comment state lives here so the owner toolbar's thread count stays live
  // regardless of the current view, and there's a single realtime subscription.
  // Seeded from the document payload (perf H1): the list is available on first
  // render with no second round trip, so pins/underlines hydrate with the doc.
  const comments = useComments(data.document.slug, data.documentId, data.comments);

  // Single polite live region (audit M11, WCAG 4.1.3): announces the viewer's
  // own successful comment post, throttled realtime comment arrivals, and — via
  // the ActionBar copy buttons that consume this same context — "Link copied".
  // The region node is rendered once at the bottom of the tree.
  const { announce, region: liveRegion, Provider: AnnounceProvider } = useAnnouncer();

  // Open-thread count for the owner toolbar badge (audit m3), kept live off the
  // comments state regardless of the current view. A thread is "open" when its
  // root comment is unresolved.
  const openThreadCount = useMemo(
    () =>
      comments.threads.reduce(
        (n, t) => (t.root.status === "open" ? n + 1 : n),
        0,
      ),
    [comments.threads],
  );

  // The viewer's own display name (for tinting the live-selection overlay in
  // their identity color). Resolved from the real participant record, not the
  // optimistic "You" — so the color matches the avatar everyone else sees. Stays
  // undefined for a participant who hasn't been provisioned yet (overlay then
  // falls back to accent).
  const currentUserName = data.participants.find(
    (p) => p.id === data.participantId,
  )?.name;

  // First-visit select-to-comment hint (audit M8). Resolved on the client after
  // hydration (SSR and the first client render agree on "hidden"), deferred a
  // tick so the reveal is not a synchronous setState inside the effect body;
  // shows only until dismissed or until the reader posts their first comment.
  const [hintVisible, setHintVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        if (!window.localStorage.getItem(COMMENT_HINT_KEY)) setHintVisible(true);
      } catch {
        // Storage unavailable (private mode/quota) — keep the hint hidden
        // rather than nag on every visit with no way to persist the dismissal.
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const dismissHint = useCallback(() => {
    setHintVisible(false);
    try {
      window.localStorage.setItem(COMMENT_HINT_KEY, "1");
    } catch {
      // Best-effort persistence; the hint stays hidden for this session.
    }
  }, []);

  // Realtime-arrival announcements (audit M11) diff the comment id set on every
  // change. A row the viewer inserts themselves must NOT be announced as an
  // arrival — `outstandingSelfInsertsRef` marks self optimistic inserts so the
  // diff effect consumes them instead of counting them as external.
  const knownCommentIdsRef = useRef<Set<string>>(
    new Set(data.comments.map((c) => c.id)),
  );
  const outstandingSelfInsertsRef = useRef(0);
  const pendingArrivalsRef = useRef(0);
  const arrivalTimerRef = useRef<number | null>(null);

  // The hint auto-hides for good the moment the reader posts a first comment —
  // it has served its purpose. Wraps the mutation so CommentsLayer stays
  // agnostic of the hint; the posted id passes through for the Undo toast. Also
  // announces the viewer's own successful post to the live region (M11) and
  // suppresses the matching arrival announcement (see refs above).
  const { addComment } = comments;
  const addCommentAndDismissHint = useCallback(
    async (anchor: TextQuoteAnchor, body: string, authorName?: string) => {
      // Reserve one self-insert slot BEFORE the optimistic insert lands so the
      // diff effect (which may run on the very next commit) consumes it.
      outstandingSelfInsertsRef.current += 1;
      const id = await addComment(anchor, body, authorName);
      if (id) {
        dismissHint();
        announce("Comment posted.");
      } else {
        // Post failed → the optimistic row was rolled back. Release the slot so
        // it can't swallow a later genuine arrival. (If the insert effect already
        // consumed it, this clamps at zero.)
        outstandingSelfInsertsRef.current = Math.max(
          0,
          outstandingSelfInsertsRef.current - 1,
        );
      }
      return id;
    },
    [addComment, dismissHint, announce],
  );

  // Announce comment arrivals from OTHER clients, throttled (M11). Diffs the id
  // set against the last render; self inserts are excluded via the outstanding
  // slots. Leading-edge announce + a trailing flush coalesces a burst into one
  // polite message roughly every 1.5s so a reader isn't machine-gunned.
  useEffect(() => {
    const known = knownCommentIdsRef.current;
    const next = new Set<string>();
    let external = 0;
    for (const c of comments.comments) {
      next.add(c.id);
      if (known.has(c.id)) continue;
      if (outstandingSelfInsertsRef.current > 0) {
        outstandingSelfInsertsRef.current -= 1;
      } else {
        external += 1;
      }
    }
    knownCommentIdsRef.current = next;
    if (external <= 0) return;

    pendingArrivalsRef.current += external;
    const flush = () => {
      const n = pendingArrivalsRef.current;
      if (n <= 0) return;
      pendingArrivalsRef.current = 0;
      announce(n === 1 ? "New comment added." : `${n} new comments added.`);
    };
    if (arrivalTimerRef.current === null) {
      flush();
      arrivalTimerRef.current = window.setTimeout(() => {
        arrivalTimerRef.current = null;
        flush();
      }, 1500);
    }
  }, [comments.comments, announce]);

  useEffect(
    () => () => {
      if (arrivalTimerRef.current !== null) {
        window.clearTimeout(arrivalTimerRef.current);
      }
    },
    [],
  );

  // Stable comments prop for the (memoized) CodeView: only a real threads/
  // handler change produces a new object, so the potentially huge <pre> does
  // not re-reconcile on every unrelated comment event (perf L2).
  const codeComments = useMemo(
    () => ({
      role: data.role,
      threads: comments.threads,
      onReply: comments.addReply,
      onReact: comments.react,
      onSetStatus: comments.setStatus,
      onDelete: comments.removeComment,
    }),
    [
      data.role,
      comments.threads,
      comments.addReply,
      comments.react,
      comments.setStatus,
      comments.removeComment,
    ],
  );

  // The markdown content normally opens with its own H1 (the visible title), and
  // the browser tab <title> comes from layout metadata. When the content has no
  // leading H1 we render an sr-only heading so the document still has an
  // accessible name — without ever visually duplicating an existing H1.
  const hasLeadingH1 = data.version.content.trimStart().startsWith("# ");

  const previewActive = view === "preview";

  return (
    <AnnounceProvider>
    <div className="flex min-h-full flex-1 flex-col">
      {/* The floating action bar is fixed-positioned; it ignores this flow. */}
      <ActionBar
        view={view}
        onViewChange={handleViewChange}
        role={data.role}
        slug={data.document.slug}
        participants={data.participants}
        openThreadCount={openThreadCount}
      />
      {/* md→lg right safe-area keeps the centered column + its -56px comment
          gutter clear of the fixed pill (right-3). Cleared again at xl. */}
      <main className="w-full flex-1 px-5 py-10 sm:px-4 sm:py-12 md:pr-16 lg:pr-12 xl:pr-0">
        {!hasLeadingH1 ? (
          <h1 className="sr-only">{data.document.title}</h1>
        ) : null}
        {/* Comments failed to load (or a background refetch failed): the doc is
            still readable, so surface a quiet inline notice with a retry instead
            of rendering zero badges with no explanation (audit 3.9). Clears
            itself on the next successful (re)fetch. */}
        {comments.error ? (
          <div
            role="alert"
            className="mx-auto mb-6 flex w-full max-w-[72ch] items-center justify-between gap-3 rounded-md border border-border bg-secondary/50 px-4 py-2.5"
          >
            <p className="text-sm text-muted-foreground">
              Comments couldn’t be loaded.
            </p>
            <button
              type="button"
              onClick={() => void comments.refetch()}
              className="inline-flex min-h-8 shrink-0 items-center justify-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Retry
            </button>
          </div>
        ) : null}
        {/* First-visit hint (audit M8): select-to-comment has no visible
            affordance of its own, so tell first-time readers it exists. Shown
            near the top of the preview only, dismissible, and auto-hidden for
            good after the reader's first comment. Entry animation is gated on
            motion-safe so reduced-motion users get an instant appearance. */}
        {previewActive && hintVisible ? (
          <div
            data-testid="comment-hint"
            className="mx-auto mb-6 flex w-full max-w-[72ch] items-center justify-between gap-3 rounded-md border border-border bg-secondary/50 px-4 py-2.5 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1"
          >
            <p className="text-sm text-muted-foreground">
              <strong className="font-medium text-foreground">Select any text</strong> to
              leave a comment — no account needed.
            </p>
            <button
              type="button"
              aria-label="Dismiss hint"
              onClick={dismissHint}
              className="relative shrink-0 rounded-md p-1 text-muted-foreground transition-colors before:absolute before:-inset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <X aria-hidden className="size-4" />
            </button>
          </div>
        ) : null}
        {/* Positioning context for the hidden (absolute) panel, inside the
            main padding so both panels share the same box. */}
        <div className="relative">
          <div
            inert={!previewActive}
            aria-hidden={!previewActive}
            className={cn(panelBase, previewActive ? panelShown : panelHidden)}
          >
            {/* On mobile the column fills the viewport width; pr-14 (56px)
                reserves a right gutter so pins don't overlap prose. On desktop
                (md+) the natural margin outside the 72ch column handles it. */}
            <div
              className="relative mx-auto w-full max-w-[72ch] overflow-visible pr-14 md:pr-0"
              ref={setPreviewEl}
            >
              <MarkdownPreview content={data.version.content} />
              <CommentsLayer
                role={data.role}
                container={previewEl}
                threads={comments.threads}
                currentUserName={currentUserName}
                addComment={addCommentAndDismissHint}
                addReply={comments.addReply}
                react={comments.react}
                setStatus={comments.setStatus}
                removeComment={comments.removeComment}
              />
            </div>
          </div>
          {codeMounted ? (
            <div
              inert={previewActive}
              aria-hidden={previewActive}
              className={cn(panelBase, previewActive ? panelHidden : panelShown)}
            >
              {/* Comments are visible + actionable in the Code view too: anchored
                  quotes highlight inline and open the same thread popover. */}
              <CodeView content={data.version.content} comments={codeComments} />
            </div>
          ) : null}
        </div>
      </main>
      {liveRegion}
    </div>
    </AnnounceProvider>
  );
}

DocumentView.displayName = "DocumentView";
