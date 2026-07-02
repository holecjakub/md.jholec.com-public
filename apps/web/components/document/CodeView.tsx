"use client";

import { useMemo, useRef, useState } from "react";
import type { CommentThread } from "@/lib/comments-api";
import type { Role } from "@/lib/document-api";
import { cn } from "@/lib/utils";
import { ThreadPopover } from "@/components/comments/ThreadPopover";
import { CopyButton } from "./CopyButton";

interface CodeCommentHandlers {
  role: Role;
  threads: CommentThread[];
  onReply: (commentId: string, body: string) => Promise<void>;
  onReact: (commentId: string, emoji: string) => Promise<void>;
  onSetStatus: (commentId: string, status: "open" | "resolved") => Promise<void>;
  onDelete: (commentId: string) => Promise<void>;
}

interface Segment {
  text: string;
  threadId?: string;
  resolved?: boolean;
}

/**
 * Locate each thread's anchored quote in the RAW source and build a flat list of
 * text segments, marking the matched runs so they can render as clickable
 * highlights. Uses prefix+quote to disambiguate repeated text, falls back to the
 * bare quote, and drops overlaps (first match wins) so segments never collide.
 */
function buildSegments(content: string, threads: CommentThread[]): Segment[] {
  const ranges: { start: number; end: number; threadId: string; resolved: boolean }[] = [];
  for (const t of threads) {
    const { quote, prefix } = t.root.anchor;
    if (!quote) continue;
    let idx = prefix ? content.indexOf(prefix + quote) : -1;
    if (idx >= 0) idx += prefix.length;
    else idx = content.indexOf(quote);
    if (idx < 0) continue;
    ranges.push({
      start: idx,
      end: idx + quote.length,
      threadId: t.root.id,
      resolved: t.root.status === "resolved",
    });
  }
  ranges.sort((a, b) => a.start - b.start);

  const segments: Segment[] = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start < cursor) continue; // overlap — skip
    if (r.start > cursor) segments.push({ text: content.slice(cursor, r.start) });
    segments.push({
      text: content.slice(r.start, r.end),
      threadId: r.threadId,
      resolved: r.resolved,
    });
    cursor = r.end;
  }
  if (cursor < content.length) segments.push({ text: content.slice(cursor) });
  return segments;
}

/**
 * Raw Markdown source, read-only, monospace, with a copy button. When comment
 * handlers are supplied, anchored quotes are highlighted inline and open the same
 * thread popover used in the preview — so comments are visible and actionable in
 * the Code view too, not only in Preview.
 */
export function CodeView({
  content,
  comments,
}: {
  content: string;
  comments?: CodeCommentHandlers;
}) {
  const [active, setActive] = useState<{ threadId: string; rect: DOMRect } | null>(null);

  const segments = useMemo(
    () => (comments ? buildSegments(content, comments.threads) : [{ text: content }]),
    [content, comments],
  );

  const activeThreads = useMemo(
    () =>
      active && comments
        ? comments.threads.filter((t) => t.root.id === active.threadId)
        : [],
    [active, comments],
  );

  return (
    <div className="mx-auto w-full max-w-[72ch]">
      <div className="relative rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <span className="text-xs font-medium text-muted-foreground">
            Markdown source
          </span>
          <CopyButton value={content} />
        </div>
        <pre className="overflow-x-auto p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap break-words text-foreground">
          {comments
            ? segments.map((s, i) =>
                s.threadId ? (
                  <CodeHighlight
                    key={`${i}-${s.threadId}`}
                    text={s.text}
                    resolved={s.resolved ?? false}
                    onOpen={(rect) => setActive({ threadId: s.threadId!, rect })}
                  />
                ) : (
                  <span key={i}>{s.text}</span>
                ),
              )
            : content}
        </pre>
      </div>

      {comments ? (
        <ThreadPopover
          open={active !== null}
          threads={activeThreads}
          rect={active?.rect ?? null}
          role={comments.role}
          onClose={() => setActive(null)}
          onReply={comments.onReply}
          onReact={comments.onReact}
          onSetStatus={comments.onSetStatus}
          onDelete={comments.onDelete}
        />
      ) : null}
    </div>
  );
}

CodeView.displayName = "CodeView";

/** An anchored quote inside the raw source — a clickable underline that opens its thread. */
function CodeHighlight({
  text,
  resolved,
  onOpen,
}: {
  text: string;
  resolved: boolean;
  onOpen: (rect: DOMRect) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      type="button"
      data-code-comment
      aria-label={`Open comment on "${text.slice(0, 40)}"`}
      onClick={() => {
        const rect = ref.current?.getBoundingClientRect();
        if (rect) onOpen(rect);
      }}
      className={cn(
        "md-comment-highlight cursor-pointer bg-transparent p-0 font-mono text-left align-baseline",
        resolved && "opacity-70",
      )}
    >
      {text}
    </button>
  );
}

CodeHighlight.displayName = "CodeHighlight";
