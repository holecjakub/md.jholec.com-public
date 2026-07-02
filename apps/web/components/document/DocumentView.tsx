"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { DocPayload } from "@/lib/document-api";
import { useComments } from "@/hooks/useComments";
import { ActionBar, type ViewMode } from "./ActionBar";
import { MarkdownPreview } from "./MarkdownPreview";
import { CodeView } from "./CodeView";
import { CommentsLayer } from "@/components/comments/CommentsLayer";
import { LoadingState } from "./states";

/** The rendered document experience once a session exists. */
export function DocumentView({ data }: { data: DocPayload }) {
  const [view, setView] = useState<ViewMode>("preview");
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${data.document.title} - md.jholec.com`;
    return () => {
      document.title = previousTitle;
    };
  }, [data.document.title]);

  // Preview ↔ Code transition: a soft SPRING fade. The incoming panel settles in
  // on a spring (opacity + a small blur lifting to 0); the outgoing one fades out
  // quickly so the swap stays snappy. We animate ONLY opacity + filter, never a
  // transform — CommentsLayer measures pin/highlight geometry via
  // getBoundingClientRect on the preview node, and opacity/blur are geometry-
  // neutral whereas a transform (scale/translate) would skew a mid-animation
  // measurement and drift the pins.
  const panelMotion = reduceMotion
    ? {}
    : {
        initial: { opacity: 0, filter: "blur(8px)" },
        animate: {
          opacity: 1,
          filter: "blur(0px)",
          transition: {
            type: "spring" as const,
            stiffness: 320,
            damping: 30,
            mass: 0.7,
            // opacity reads better on a quick ease than a long spring tail.
            opacity: { duration: 0.2, ease: [0.22, 0.61, 0.36, 1] as const },
          },
        },
        exit: {
          opacity: 0,
          filter: "blur(8px)",
          transition: { duration: 0.12, ease: [0.4, 0, 1, 1] as const },
        },
      };
  // The preview element (carries the [data-block-id] blocks) — anchoring +
  // pin geometry are measured against it. Held in state (not a ref) so the
  // CommentsLayer re-renders once the node is attached.
  const [previewEl, setPreviewEl] = useState<HTMLElement | null>(null);

  // Comment state lives here so the owner toolbar's thread count stays live
  // regardless of the current view, and there's a single realtime subscription.
  const comments = useComments(data.document.slug, data.documentId);

  // The viewer's own display name (for tinting the live-selection overlay in
  // their identity color). Resolved from the real participant record, not the
  // optimistic "You" — so the color matches the avatar everyone else sees. Stays
  // undefined for a participant who hasn't been provisioned yet (overlay then
  // falls back to accent).
  const currentUserName = data.participants.find(
    (p) => p.id === data.participantId,
  )?.name;

  // The markdown content normally opens with its own H1 (the visible title), and
  // the browser tab <title> comes from layout metadata. When the content has no
  // leading H1 we render an sr-only heading so the document still has an
  // accessible name — without ever visually duplicating an existing H1.
  const hasLeadingH1 = data.version.content.trimStart().startsWith("# ");

  return (
    <div className="flex min-h-full flex-1 flex-col">
      {/* The floating action bar is fixed-positioned; it ignores this flow. */}
      <ActionBar
        view={view}
        onViewChange={setView}
        role={data.role}
        slug={data.document.slug}
        participants={data.participants}
      />
      {/* md→lg right safe-area keeps the centered column + its -56px comment
          gutter clear of the fixed pill (right-3). Cleared again at xl. */}
      <main className="w-full flex-1 px-5 py-10 sm:px-4 sm:py-12 md:pr-16 lg:pr-12 xl:pr-0">
        {!hasLeadingH1 ? (
          <h1 className="sr-only">{data.document.title}</h1>
        ) : null}
        <AnimatePresence mode="wait" initial={false}>
          {view === "preview" ? (
            // The motion wrapper carries opacity/blur ONLY; the inner ref'd node
            // (measured by CommentsLayer) is never transformed, so pins stay
            // accurate once the swap settles.
            <motion.div
              key="preview"
              {...panelMotion}
              style={reduceMotion ? undefined : { willChange: "opacity, filter" }}
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
                  addComment={comments.addComment}
                  addReply={comments.addReply}
                  react={comments.react}
                  setStatus={comments.setStatus}
                />
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="code"
              {...panelMotion}
              style={reduceMotion ? undefined : { willChange: "opacity, filter" }}
            >
              {/* Comments are visible + actionable in the Code view too: anchored
                  quotes highlight inline and open the same thread popover. */}
              <CodeView
                content={data.version.content}
                comments={{
                  role: data.role,
                  threads: comments.threads,
                  onReply: comments.addReply,
                  onReact: comments.react,
                  onSetStatus: comments.setStatus,
                  onDelete: comments.removeComment,
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Keep the loader up until the comments' INITIAL fetch resolves, so the
          document is never revealed half-loaded (content first, then badges +
          underlines popping in a beat later). The preview renders underneath
          meanwhile, so anchoring is already computed when the overlay lifts. The
          overlay only covers the first load — realtime/mutation refetches don't
          re-raise `loading`. */}
      {/* LoadingState is itself a fixed full-viewport overlay (centered), so it
          sits at the exact same spot as the gate/checking loader — no jump. */}
      {comments.loading ? <LoadingState label="Loading document…" /> : null}
    </div>
  );
}

DocumentView.displayName = "DocumentView";
