"use client";

import { motion, useReducedMotion } from "motion/react";
import {
  Check,
  Download,
  FileText,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Users,
} from "lucide-react";
import type { CreateResult } from "@/lib/upload-api";
import { formatBytes } from "./file-validation";
import { CopyableLink } from "./CopyableLink";
import { ExpiryHint } from "./ExpiryHint";
import { AgentReadNote, HowItWorks } from "./HowItWorks";
import { CliNote } from "./CliNote";
import { Confetti } from "./Confetti";
import { Barcode } from "./Barcode";

interface LinkRevealProps {
  result: CreateResult;
  file: File;
  reduce: boolean;
  headingId: string;
  onCopied: (which: "owner" | "reviewer") => void;
  onReset: () => void;
}

function DashedLine() {
  return (
    <div className="border-t-2 border-dashed border-border" aria-hidden="true" />
  );
}

/**
 * A ticket "tear" line: a thick dashed rule spanning the card, with a
 * background-colored cut-out notch straddling each edge (exactly like the
 * AnimatedTicket inspiration — bg-background circles half-outside the card, no
 * border; the card's shadow makes the bite read even when card ≈ background).
 */
function TearLine() {
  return (
    <div className="relative h-0" aria-hidden="true">
      <span className="absolute -left-3 top-0 size-6 -translate-y-1/2 rounded-full bg-background" />
      <span className="absolute -right-3 top-0 size-6 -translate-y-1/2 rounded-full bg-background" />
      <div className="mx-6 border-t-2 border-dashed border-border sm:mx-8" />
    </div>
  );
}

/**
 * The owner link has no backend recovery — no accounts, no email reset. If the
 * reader closes this tab without saving it, it's gone. This surfaces that
 * plainly and offers a one-tap "save" that downloads a tiny .txt containing the
 * link, so a non-technical reader has a concrete way to keep it (Files/Downloads)
 * beyond copying to a clipboard they might overwrite.
 */
function SaveOwnerLink({ url, slug }: { url: string; slug: string }) {
  function handleSave() {
    const body = `md.jholec.com owner link — keep this private.\nThere are no accounts, so this link cannot be recovered if lost.\n\n${url}\n`;
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `owner-link-${slug}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick so the download has started reading the blob.
    setTimeout(() => URL.revokeObjectURL(href), 0);
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-red-500/20 bg-red-500/[0.04] p-3 dark:border-red-500/20 dark:bg-red-500/[0.06] sm:flex-row sm:items-center sm:justify-between">
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <TriangleAlert
          className="mt-0.5 size-4 shrink-0 text-red-500/90 dark:text-red-400/90"
          aria-hidden="true"
        />
        <span>
          <span className="font-medium text-foreground">Save this link.</span>{" "}
          There are no accounts, so it can&apos;t be recovered if you lose it.
        </span>
      </p>
      <button
        type="button"
        onClick={handleSave}
        className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 self-start rounded-lg border border-border bg-background px-3.5 text-sm font-medium text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.97] motion-reduce:active:scale-100 sm:self-auto [@media(hover:hover)]:hover:bg-secondary"
      >
        <Download className="size-4" aria-hidden="true" />
        Save link
      </button>
    </div>
  );
}

/**
 * Success step — a ticket-style "receipt" card that slides up from below with a
 * confetti burst, then stacks the document details and links.
 * Adapted from the AnimatedTicket inspiration (07-document-uploaded-ticket),
 * re-tokenized for light/dark and made accessible.
 *
 * a11y contract (gate-res): owner link is FIRST in DOM order; the success <h2>
 * (headingId, tabindex=-1) is the focus destination UploadPanel moves to on the
 * 201 — not an animation callback. Confetti + slide are suppressed under
 * prefers-reduced-motion. Copy buttons keep distinct accessible names.
 */
export function LinkReveal({
  result,
  file,
  reduce,
  headingId,
  onCopied,
  onReset,
}: LinkRevealProps) {
  const systemReduce = useReducedMotion();
  const shouldReduce = reduce || !!systemReduce;

  const ease = [0.16, 1, 0.3, 1] as const;
  const cardInitial = shouldReduce
    ? { opacity: 0 }
    : { opacity: 0, y: 56, scale: 0.98 };
  const cardTransition = shouldReduce
    ? { duration: 0 }
    : { duration: 0.55, ease };

  const checkInitial = shouldReduce ? { opacity: 1 } : { scale: 0, opacity: 0 };
  const checkTransition = shouldReduce
    ? { duration: 0 }
    : { duration: 0.45, ease, delay: 0.28 };

  return (
    <>
      <Confetti />

      <motion.div
        initial={cardInitial}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={cardTransition}
        className="relative mx-auto w-full max-w-lg rounded-2xl bg-card text-card-foreground shadow-[0_4px_12px_rgba(0,0,0,0.08),0_32px_64px_-24px_rgba(0,0,0,0.4)]"
      >
        {/* Header */}
        <div className="flex flex-col items-center gap-3 px-6 pb-6 pt-8 text-center sm:px-8">
          <motion.span
            initial={checkInitial}
            animate={{ scale: 1, opacity: 1 }}
            transition={checkTransition}
            className="inline-flex size-14 items-center justify-center rounded-full bg-accent/10 text-[--accent-strong]"
          >
            <Check className="size-7" aria-hidden="true" />
          </motion.span>
          <h2
            id={headingId}
            tabIndex={-1}
            className="text-xl font-semibold tracking-tight text-foreground outline-none"
          >
            Your document is live.
          </h2>
          <p className="text-sm text-muted-foreground">
            Copy your links below. Keep the owner link private.
          </p>
        </div>

        {/* Ticket tear line with side notches */}
        <TearLine />

        {/* Body */}
        <div className="flex flex-col gap-6 px-6 py-7 sm:px-8">
          {/* File row */}
          <div className="flex items-center gap-3">
            <span
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-foreground"
              aria-hidden="true"
            >
              <FileText className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {file.name}
              </p>
              <p className="text-xs tabular-nums text-muted-foreground">
                {formatBytes(file.size)}
              </p>
            </div>
          </div>

          <DashedLine />

          {/* Reviewer link — first (the one you share), subtle green accent */}
          <CopyableLink
            url={result.shareUrl}
            label="Reviewer link"
            tag="share this"
            description="Send this to reviewers. They enter a name, read the document, and leave inline comments."
            ariaLabelField="Reviewer link URL"
            ariaLabelCopy="Copy reviewer link"
            onCopied={() => onCopied("reviewer")}
            icon={<Users className="size-4" />}
            accent="green"
          />

          {/* Owner link — second (keep private), subtle red accent */}
          <div className="flex flex-col gap-2">
            <CopyableLink
              url={result.ownerUrl}
              label="Owner link"
              tag="keep this private"
              description="Opens the document with owner tools: download the source, resolve comments, and manage access."
              ariaLabelField="Owner link URL"
              ariaLabelCopy="Copy owner link"
              onCopied={() => onCopied("owner")}
              icon={<ShieldCheck className="size-4" />}
              accent="red"
            />
            {/* M6: this is the ONLY copy of the owner link — there are no
                accounts, so if the reader loses it there is no recovery path.
                Say so explicitly and give a one-tap save affordance. */}
            <SaveOwnerLink url={result.ownerUrl} slug={result.slug} />
          </div>

          {/* AI agent link — third (read-only export), violet accent */}
          <CopyableLink
            url={result.agentUrl}
            label="AI agent link"
            tag="read-only"
            description="Paste this into an AI agent (ChatGPT, etc.) — fetching it returns the document + comments as text. Read-only: it can't edit, share, or manage."
            ariaLabelField="AI agent link URL"
            ariaLabelCopy="Copy AI agent link"
            onCopied={() => {}}
            icon={<Sparkles className="size-4" />}
            accent="violet"
          />

          <DashedLine />

          <ExpiryHint expiresAt={result.expiresAt} />
          <HowItWorks />
          <CliNote />
          <AgentReadNote />
        </div>

        {/* Footer: barcode tear-off + reset */}
        <TearLine />
        <div className="flex flex-col items-center gap-5 px-6 pb-8 pt-7 sm:px-8">
          <Barcode value={result.slug} />
          <button
            type="button"
            onClick={onReset}
            className="text-sm text-muted-foreground underline-offset-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background [@media(hover:hover)]:hover:text-foreground [@media(hover:hover)]:hover:underline"
          >
            Upload another file
          </button>
        </div>
      </motion.div>
    </>
  );
}
