"use client";

import type { ReactNode } from "react";
import {
  MessageSquarePlus,
  MousePointerClick,
  Reply,
  Sparkles,
  Underline,
  X,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Button } from "@/components/ui/button";

/**
 * A friendly, scannable how-to for a non-technical reviewer. The Help affordance
 * lives in the floating ActionBar; this component owns the *surface*:
 * - `variant="popover"` (desktop): a Base UI Popover anchored to the LEFT of the
 *   Help button, consistent with the pill's left tooltips.
 * - `variant="sheet"` (mobile): a Base UI Dialog re-positioned as a bottom sheet.
 *
 * Both surfaces share the same `HelpContent` body. The trigger is supplied by the
 * caller (the ActionBar's Help button) via the `trigger` render prop so the
 * popover has an anchor and the dialog has an accessible opener. Open state is
 * controlled by the caller so Esc/close return focus to the trigger (handled by
 * the primitives) and the ActionBar can coordinate the mobile cluster.
 */
export function HelpPanel({
  open,
  onOpenChange,
  variant,
  trigger,
  isOwner = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant: "popover" | "sheet";
  /** Optional: when omitted the surface is purely controlled (the caller hosts
   *  its own opener elsewhere — e.g. the mobile cluster's Help button). */
  trigger?: ReactNode;
  /** Owners get an extra "AI agent read link" section (the feature is owner-only). */
  isOwner?: boolean;
}) {
  if (variant === "sheet") {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        {trigger ? <DialogTrigger render={trigger as React.ReactElement} /> : null}
        <DialogPortal>
          <DialogOverlay />
          <DialogPrimitive.Popup
            data-slot="help-sheet"
            aria-label="How to leave feedback"
            className="help-sheet fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col gap-3 overflow-y-auto overscroll-contain rounded-t-2xl bg-popover p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none"
          >
            <DialogHeader>
              <DialogTitle>How to leave feedback</DialogTitle>
              <DialogDescription>
                No account needed — just your name.
              </DialogDescription>
            </DialogHeader>
            <HelpBody isOwner={isOwner} />
            <DialogPrimitive.Close
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="absolute top-3 right-3"
                />
              }
            >
              <X aria-hidden />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </DialogPrimitive.Popup>
        </DialogPortal>
      </Dialog>
    );
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={trigger as React.ReactElement} />
      <PopoverContent
        side="left"
        align="center"
        sideOffset={12}
        className="w-80 gap-3"
        aria-label="How to leave feedback"
      >
        <PopoverHeader>
          <PopoverTitle className="text-sm">How to leave feedback</PopoverTitle>
          <PopoverDescription className="text-xs">
            No account needed — just your name.
          </PopoverDescription>
        </PopoverHeader>
        <HelpBody isOwner={isOwner} />
      </PopoverContent>
    </Popover>
  );
}

HelpPanel.displayName = "HelpPanel";

/** The shared body: a scannable step list + a calm reassurance block. Owners also
 *  get an "AI agent read link" section explaining the owner-only ✨ control. */
function HelpBody({ isOwner = false }: { isOwner?: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-2.5">
        <HelpStep icon={<MousePointerClick aria-hidden className="size-4" />}>
          <strong className="font-medium text-foreground">Select any text</strong> to
          comment on it.
        </HelpStep>
        <HelpStep icon={<MessageSquarePlus aria-hidden className="size-4" />}>
          <strong className="font-medium text-foreground">Type a comment</strong> — or tap
          an emoji to react.
        </HelpStep>
        <HelpStep icon={<Underline aria-hidden className="size-4" />}>
          Your feedback shows as a{" "}
          <strong className="font-medium text-foreground">soft underline + a margin badge</strong>.
          Hover a stack of avatars to find the right one.
        </HelpStep>
        <HelpStep icon={<Reply aria-hidden className="size-4" />}>
          <strong className="font-medium text-foreground">Click a badge or underline</strong>{" "}
          to open the thread or reply.
        </HelpStep>
      </ol>

      <div className="flex flex-col gap-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
        <p>
          <strong className="font-medium text-foreground">The document owner sees your feedback instantly.</strong>
        </p>
        <p>
          <strong className="font-medium text-foreground">Nothing to save</strong> — it&apos;s live.
        </p>
        <p>
          <strong className="font-medium text-foreground">No account needed</strong> — just your name.
        </p>
      </div>

      {isOwner ? (
        <div className="flex items-start gap-2.5 rounded-lg bg-secondary/40 p-3 text-xs text-muted-foreground">
          <Sparkles aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-foreground">Hand an AI agent a read-only link.</p>
            <p className="text-pretty">
              Use{" "}
              <strong className="font-medium text-foreground">Copy AI agent read link</strong>{" "}
              (the sparkle button) to give an AI agent a link that fetches the document and
              comments in one call. The agent gets read-only access and cannot write, share,
              or manage the document. Keep a human in the loop for any follow-up.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

HelpBody.displayName = "HelpBody";

function HelpStep({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-sm text-muted-foreground">
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <span className="leading-snug">{children}</span>
    </li>
  );
}

HelpStep.displayName = "HelpStep";
