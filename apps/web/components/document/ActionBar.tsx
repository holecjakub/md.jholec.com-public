"use client";

import {
  memo,
  useCallback,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTheme } from "next-themes";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Check,
  ClipboardCopy,
  Code2,
  Download,
  Eye,
  HelpCircle,
  KeyRound,
  Link2,
  MessageSquare,
  Moon,
  Plus,
  Sparkles,
  Sun,
  Users,
  X,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Avatar } from "@/components/comments/Avatar";
import {
  createAgentLink,
  createShareLink,
  fetchDocumentMarkdown,
  revokeShareLinks,
} from "@/lib/comments-api";
import { useAnnounce } from "@/components/ui/live-region";
import type { ParticipantSummary, Role } from "@/lib/document-api";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/lib/use-media-query";
import { haptic } from "@/lib/haptics";
import { HelpPanel } from "./HelpPanel";

export type ViewMode = "preview" | "code";

// Mount guard identical to ThemeToggle: a subscribe-less external store whose
// server snapshot is `false` and client snapshot is `true`. Avoids any
// setState-in-effect for the theme/hydration boundary.
const emptySubscribe = () => () => {};
function useMounted(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

/**
 * The floating document action bar.
 *
 * Desktop (≥ md / fine pointer): a vertical rounded-full pill fixed to the right
 * edge of the viewport, vertically centered, with labels shown as tooltips to the
 * LEFT of the pill. Order for an owner:
 *   [Preview][Code] — sep — [Download][Share][Participants] — sep — [Theme][Help].
 * Reviewers see [Preview][Code] — sep — [Theme][Help].
 *
 * Mobile (< md): a compact bottom-right FAB that expands into a vertical stack of
 * labelled action pills (no hover on touch, so labels are visible). The desktop
 * pill is `hidden md:flex`; the mobile cluster is `md:hidden`.
 *
 * All chrome lives here — there is no top bar. The document's own H1 is the title.
 *
 * Memoized: every prop is referentially stable across comment/realtime state
 * changes in DocumentView (view + a stable callback + payload fields), so the
 * whole bar — tooltips, popovers, both surfaces — skips re-rendering on every
 * comment event and only re-renders on an actual view flip.
 */
export const ActionBar = memo(function ActionBar({
  view,
  onViewChange,
  role,
  slug,
  participants,
  openThreadCount,
}: {
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  role: Role;
  slug: string;
  participants: ParticipantSummary[];
  /** Count of unresolved comment threads — feeds the owner toolbar badge (m3). */
  openThreadCount: number;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  // Help open-state is shared, but the two surfaces (desktop popover, mobile
  // sheet) both render via portals — so without viewport gating the desktop
  // popover would leak onto mobile (the pill is only CSS-hidden, its portal is
  // not). Route the open flag to whichever surface matches the current viewport.
  const isDesktop = useMediaQuery("(min-width: 768px)");

  return (
    <>
      <DesktopPill
        view={view}
        onViewChange={onViewChange}
        role={role}
        slug={slug}
        participants={participants}
        openThreadCount={openThreadCount}
        helpOpen={helpOpen && isDesktop}
        onHelpOpenChange={setHelpOpen}
      />
      <MobileCluster
        view={view}
        onViewChange={onViewChange}
        role={role}
        slug={slug}
        participants={participants}
        openThreadCount={openThreadCount}
        helpOpen={helpOpen && !isDesktop}
        onHelpOpenChange={setHelpOpen}
      />
    </>
  );
});

ActionBar.displayName = "ActionBar";

/* ------------------------------------------------------------------ */
/* Desktop                                                            */
/* ------------------------------------------------------------------ */

function DesktopPill({
  view,
  onViewChange,
  role,
  slug,
  participants,
  openThreadCount,
  helpOpen,
  onHelpOpenChange,
}: {
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  role: Role;
  slug: string;
  participants: ParticipantSummary[];
  openThreadCount: number;
  helpOpen: boolean;
  onHelpOpenChange: (open: boolean) => void;
}) {
  return (
    <TooltipProvider delay={150}>
      <nav
        aria-label="Document actions"
        className={cn(
          "fixed right-3 top-1/2 z-30 hidden -translate-y-1/2 md:flex",
          // `bg-elevated` is a light grey on the light theme and a near-black
          // grey on dark — the design-system floating-surface color, so the pill
          // separates from the page background in both themes.
          "flex-col items-center gap-1 rounded-full border border-border bg-elevated p-1.5",
          // M15: consume the theme-aware --shadow-pill token (deeper recipe + top
          // inset highlight on dark) instead of a hardcoded pure-black shadow.
          "shadow-pill",
        )}
      >
        {/* View toggle */}
        <PillToggleButton
          label="Preview"
          selected={view === "preview"}
          onClick={() => onViewChange("preview")}
        >
          <Eye aria-hidden className="size-[18px]" />
        </PillToggleButton>
        <PillToggleButton
          label="Code"
          selected={view === "code"}
          onClick={() => onViewChange("code")}
        >
          <Code2 aria-hidden className="size-[18px]" />
        </PillToggleButton>

        {role === "owner" ? (
          <>
            <PillSeparator />
            <DesktopThreadCount count={openThreadCount} />
            <DesktopDownloadButton slug={slug} />
            <DesktopCopyDocumentButton slug={slug} />
            <PillSeparator />
            <DesktopCopyShareButton slug={slug} />
            <DesktopRevokeShareButton slug={slug} />
            <DesktopCopyAgentLinkButton slug={slug} />
            <DesktopParticipantsButton participants={participants} />
          </>
        ) : null}

        <PillSeparator />

        <DesktopThemeButton />
        <DesktopHelpButton
          open={helpOpen}
          onOpenChange={onHelpOpenChange}
          isOwner={role === "owner"}
        />
      </nav>
    </TooltipProvider>
  );
}

DesktopPill.displayName = "DesktopPill";

function PillSeparator() {
  // bg-foreground/20 gives a clearly visible rule on both surfaces:
  // light: rgba(10,10,10,0.20) ≈ #cecece on #f4f4f5 elevated  — perceptibly darker
  // dark:  rgba(235,235,235,0.20) ≈ a soft grey on #18181a elevated — perceptibly lighter
  // Width 6 (24 px) + vertical margin gives the rule enough mass to read as a real divider.
  return <span aria-hidden className="mx-auto my-1 h-px w-6 bg-foreground/20" />;
}

PillSeparator.displayName = "PillSeparator";

/**
 * Group separator for the mobile expanded cluster. A thin horizontal rule with
 * the same bg-foreground/20 token as the desktop PillSeparator so both surfaces
 * look consistent. The rule spans 40 px (w-10) and is not animated — it mounts
 * with the cluster container via AnimatePresence.
 */
function MobileGroupGap() {
  // No visible line on mobile — groups are separated purely by space. The cluster
  // uses a small intra-group gap; this invisible spacer adds extra height between
  // groups so the bigger gap reads as the separation. (Desktop keeps PillSeparator.)
  return <span aria-hidden data-mobile-group-gap className="h-3" />;
}

MobileGroupGap.displayName = "MobileGroupGap";

const pillButtonBase = cn(
  "inline-flex size-9 items-center justify-center rounded-full text-foreground transition-colors",
  "hover:bg-secondary",
  // M12 (WCAG 2.5.5): the visible control is 36px but a centered transparent
  // ::before extends the hit target to 44px without changing the visuals. The
  // pill's 4px inter-button gap means adjacent extenders just meet.
  "relative before:absolute before:left-1/2 before:top-1/2 before:size-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
);

/** A plain icon button in the pill, wrapped in a left-side tooltip. */
function PillIconButton({
  label,
  onClick,
  children,
  ...rest
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick">) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className={pillButtonBase}
            {...rest}
          >
            {children}
          </button>
        }
      />
      <TooltipContent side="left" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

PillIconButton.displayName = "PillIconButton";

/**
 * A view-toggle button: clearly communicates which view is active.
 *
 * ACTIVE  — bg-primary / text-primary-foreground: full-contrast filled chip
 *           (black+white on light, white+black on dark) so the active view is
 *           immediately obvious at a glance.
 * INACTIVE — text-muted-foreground + hover:bg-secondary/hover:text-foreground:
 *            clearly tappable with a visible hover affordance; not near-invisible.
 *
 * aria-pressed is set on both states for screen-reader and assistive-tech
 * consumers. Focus ring inherited from pillButtonBase.
 */
function PillToggleButton({
  label,
  selected,
  onClick,
  children,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={selected}
            onClick={onClick}
            className={cn(
              pillButtonBase,
              selected
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            {children}
          </button>
        }
      />
      <TooltipContent side="left" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

PillToggleButton.displayName = "PillToggleButton";

function DesktopThemeButton() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useMounted();
  const isDark = resolvedTheme === "dark";

  if (!mounted) {
    // Inert, stable placeholder so SSR and first client paint match.
    return (
      <span aria-hidden className={pillButtonBase}>
        <Sun className="size-[18px]" />
      </span>
    );
  }

  const label = isDark ? "Switch to light mode" : "Switch to dark mode";
  return (
    <PillIconButton label={label} onClick={() => setTheme(isDark ? "light" : "dark")}>
      {isDark ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
    </PillIconButton>
  );
}

DesktopThemeButton.displayName = "DesktopThemeButton";

function DesktopDownloadButton({ slug }: { slug: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={`/api/d/${encodeURIComponent(slug)}/download`}
            download
            aria-label="Download Markdown"
            className={pillButtonBase}
          >
            <Download aria-hidden className="size-[18px]" />
          </a>
        }
      />
      <TooltipContent side="left" sideOffset={8}>
        Download .md
      </TooltipContent>
    </Tooltip>
  );
}

DesktopDownloadButton.displayName = "DesktopDownloadButton";

/** Shared copy-share flow (idle → copied → idle) used by both surfaces. */
function useCopyShare(slug: string) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const announce = useAnnounce();
  const copy = useCallback(async () => {
    try {
      const url = await createShareLink(slug);
      await navigator.clipboard.writeText(url);
      haptic();
      setState("copied");
      announce("Link copied.");
    } catch {
      setState("error");
      announce("Couldn’t copy the link.");
    }
    window.setTimeout(() => setState("idle"), 2000);
  }, [slug, announce]);
  return { state, copy };
}

/**
 * Mints a read-only export PAT and copies the agent capability URL
 * (`…/d/<slug>#x=<token>`) to the clipboard. Same idle→copied→error cycle as
 * useCopyShare. Owner-only — call only from owner surfaces.
 */
function useCopyAgentLink(slug: string) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const announce = useAnnounce();
  const copy = useCallback(async () => {
    try {
      const url = await createAgentLink(slug);
      await navigator.clipboard.writeText(url);
      haptic();
      setState("copied");
      announce("Link copied.");
    } catch {
      setState("error");
      announce("Couldn’t copy the link.");
    }
    window.setTimeout(() => setState("idle"), 2000);
  }, [slug, announce]);
  return { state, copy };
}

/**
 * Fetches the document's full Markdown (including embedded comments) via the
 * same endpoint as the Download button, then writes the raw text to the
 * clipboard. Same idle→copied→error cycle as useCopyShare.
 */
function useCopyDocument(slug: string) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const announce = useAnnounce();
  const copy = useCallback(async () => {
    try {
      const markdown = await fetchDocumentMarkdown(slug);
      await navigator.clipboard.writeText(markdown);
      haptic();
      setState("copied");
      announce("Document copied.");
    } catch {
      setState("error");
      announce("Couldn’t copy the document.");
    }
    window.setTimeout(() => setState("idle"), 2000);
  }, [slug, announce]);
  return { state, copy };
}

/**
 * Revoke every live reusable reviewer link (audit M5) and mint a fresh one,
 * copying it to the clipboard. Backend-ready: DELETE /share stamps `revoked_at`
 * on all live invite tokens, then POST /share mints a new reusable link. Owner
 * authority only. States: idle → working → done | error → idle. Announces the
 * outcome to the live region so it is reachable without the confirm popover.
 */
function useRevokeReviewerLink(slug: string) {
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const announce = useAnnounce();
  const run = useCallback(async (): Promise<boolean> => {
    setState("working");
    try {
      await revokeShareLinks(slug);
      const url = await createShareLink(slug);
      // Clipboard write is BEST-EFFORT: WebKit/Safari rejects writeText once the
      // click's transient-activation window has lapsed (it has, after the two
      // awaited fetches above), so a clipboard failure must NOT report a
      // server-side-successful revoke+regenerate as failed. Track it separately.
      let copied = true;
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        copied = false;
      }
      haptic();
      setState("done");
      announce(
        copied
          ? "Reviewer link revoked. A fresh link was copied to your clipboard."
          : "Reviewer link revoked. Use “Copy reviewer link” to copy the fresh link.",
      );
      return true;
    } catch {
      setState("error");
      announce("Couldn’t revoke the reviewer link. Please try again.");
      return false;
    }
  }, [slug, announce]);
  return { state, run };
}

function DesktopCopyDocumentButton({ slug }: { slug: string }) {
  const { state, copy } = useCopyDocument(slug);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Copy document (Markdown + comments)"
            onClick={() => void copy()}
            className={pillButtonBase}
          >
            {state === "copied" ? (
              <Check aria-hidden className="size-[18px]" />
            ) : (
              <ClipboardCopy aria-hidden className="size-[18px]" />
            )}
          </button>
        }
      />
      <TooltipContent side="left" sideOffset={8}>
        {state === "copied"
          ? "Copied"
          : state === "error"
            ? "Failed"
            : "Copy document"}
      </TooltipContent>
    </Tooltip>
  );
}

DesktopCopyDocumentButton.displayName = "DesktopCopyDocumentButton";

function DesktopCopyShareButton({ slug }: { slug: string }) {
  const { state, copy } = useCopyShare(slug);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Copy reviewer link"
            onClick={() => void copy()}
            className={pillButtonBase}
          >
            {state === "copied" ? (
              <Check aria-hidden className="size-[18px]" />
            ) : (
              <Link2 aria-hidden className="size-[18px]" />
            )}
          </button>
        }
      />
      <TooltipContent side="left" sideOffset={8}>
        {state === "copied" ? "Copied" : state === "error" ? "Failed" : "Copy reviewer link"}
      </TooltipContent>
    </Tooltip>
  );
}

DesktopCopyShareButton.displayName = "DesktopCopyShareButton";

/**
 * Open-thread count badge (audit m3). A non-interactive status indicator on the
 * owner toolbar showing how many comment threads are still unresolved, fed live
 * from comments.threads. Hidden at zero to avoid a meaningless "0" chip.
 */
function DesktopThreadCount({ count }: { count: number }) {
  if (count <= 0) return null;
  const label = `${count} open ${count === 1 ? "thread" : "threads"}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="status"
            aria-label={label}
            // Non-interactive: keep the 36px span hoverable for the tooltip but
            // stop its 44px hit-extender from swallowing clicks meant for the
            // adjacent action buttons.
            className={cn(pillButtonBase, "cursor-default before:pointer-events-none")}
          >
            <span aria-hidden className="relative inline-flex items-center justify-center">
              <MessageSquare className="size-[18px]" />
              <span className="absolute -right-2 -top-2 inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.625rem] font-semibold leading-4 text-primary-foreground tabular-nums">
                {count > 99 ? "99+" : count}
              </span>
            </span>
          </span>
        }
      />
      <TooltipContent side="left" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

DesktopThreadCount.displayName = "DesktopThreadCount";

/**
 * Confirm body shared by the desktop + mobile revoke popovers (audit M5).
 * Confirm-before-destroy: spells out that current reviewer links stop working,
 * then runs revoke → regenerate → copy. `onClose` collapses the popover once the
 * fresh link has been copied.
 */
function RevokeReviewerLinkConfirm({
  slug,
  onClose,
}: {
  slug: string;
  onClose: () => void;
}) {
  const { state, run } = useRevokeReviewerLink(slug);
  const confirmLabel =
    state === "working"
      ? "Revoking…"
      : state === "done"
        ? "Done — link copied"
        : state === "error"
          ? "Failed — try again"
          : "Revoke & regenerate";
  return (
    <>
      <PopoverHeader>
        <PopoverTitle>Revoke reviewer link?</PopoverTitle>
      </PopoverHeader>
      <p className="text-xs text-muted-foreground">
        Everyone using the current reviewer link loses access immediately. A fresh
        link is generated and copied to your clipboard.
      </p>
      <div className="mt-1 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex min-h-9 items-center justify-center rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            void run().then((ok) => {
              // Close ONLY on success; keep the popover open on error so the user
              // can read the failure and retry. `run()` swallows its own errors
              // and resolves to false on failure, so gate the close on the result.
              if (ok) window.setTimeout(onClose, 600);
            });
          }}
          disabled={state === "working"}
          className="inline-flex min-h-9 items-center justify-center rounded-md bg-destructive px-3 text-sm font-medium text-white transition-colors hover:bg-destructive/90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {confirmLabel}
        </button>
      </div>
    </>
  );
}

RevokeReviewerLinkConfirm.displayName = "RevokeReviewerLinkConfirm";

function DesktopRevokeShareButton({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label="Revoke & regenerate reviewer link"
                  className={pillButtonBase}
                >
                  <KeyRound aria-hidden className="size-[18px]" />
                </button>
              }
            />
          }
        />
        <TooltipContent side="left" sideOffset={8}>
          Revoke &amp; regenerate reviewer link
        </TooltipContent>
      </Tooltip>
      <PopoverContent side="left" align="center" sideOffset={12} className="w-72">
        <RevokeReviewerLinkConfirm slug={slug} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

DesktopRevokeShareButton.displayName = "DesktopRevokeShareButton";

function DesktopCopyAgentLinkButton({ slug }: { slug: string }) {
  const { state, copy } = useCopyAgentLink(slug);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Copy AI agent read link"
            onClick={() => void copy()}
            className={pillButtonBase}
          >
            {state === "copied" ? (
              <Check aria-hidden className="size-[18px]" />
            ) : (
              <Sparkles aria-hidden className="size-[18px]" />
            )}
          </button>
        }
      />
      <TooltipContent side="left" sideOffset={8}>
        {state === "copied"
          ? "Copied"
          : state === "error"
            ? "Failed"
            : "Copy AI agent read link"}
      </TooltipContent>
    </Tooltip>
  );
}

DesktopCopyAgentLinkButton.displayName = "DesktopCopyAgentLinkButton";

function DesktopParticipantsButton({
  participants,
}: {
  participants: ParticipantSummary[];
}) {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label={`Participants (${participants.length})`}
                  className={pillButtonBase}
                >
                  <Users aria-hidden className="size-[18px]" />
                </button>
              }
            />
          }
        />
        <TooltipContent side="left" sideOffset={8}>
          Participants
        </TooltipContent>
      </Tooltip>
      <PopoverContent side="left" align="center" sideOffset={12} className="w-64">
        <ParticipantsRoster participants={participants} />
      </PopoverContent>
    </Popover>
  );
}

DesktopParticipantsButton.displayName = "DesktopParticipantsButton";

function ParticipantsRoster({ participants }: { participants: ParticipantSummary[] }) {
  return (
    <>
      <PopoverHeader>
        <PopoverTitle>Participants</PopoverTitle>
      </PopoverHeader>
      {participants.length === 0 ? (
        <p className="text-xs text-muted-foreground">No participants yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {participants.map((p) => (
            <li key={p.id} className="flex items-center gap-2">
              <Avatar name={p.name} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
              {p.role === "owner" ? (
                <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">
                  Owner
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

ParticipantsRoster.displayName = "ParticipantsRoster";

function DesktopHelpButton({
  open,
  onOpenChange,
  isOwner,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isOwner: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex">
            <HelpPanel
              open={open}
              onOpenChange={onOpenChange}
              variant="popover"
              isOwner={isOwner}
              trigger={
                <button type="button" aria-label="Help" className={pillButtonBase}>
                  <HelpCircle aria-hidden className="size-[18px]" />
                </button>
              }
            />
          </span>
        }
      />
      <TooltipContent side="left" sideOffset={8}>
        Help
      </TooltipContent>
    </Tooltip>
  );
}

DesktopHelpButton.displayName = "DesktopHelpButton";

/* ------------------------------------------------------------------ */
/* Mobile                                                             */
/* ------------------------------------------------------------------ */

function MobileCluster({
  view,
  onViewChange,
  role,
  slug,
  participants,
  openThreadCount,
  helpOpen,
  onHelpOpenChange,
}: {
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  role: Role;
  slug: string;
  participants: ParticipantSummary[];
  openThreadCount: number;
  helpOpen: boolean;
  onHelpOpenChange: (open: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const reduceMotion = useReducedMotion();

  const close = useCallback(() => setExpanded(false), []);

  // Switch view + collapse: on mobile the cluster overlays the document, so after
  // flipping Preview↔Code we close it so the result is immediately visible.
  const pickView = useCallback(
    (v: ViewMode) => {
      onViewChange(v);
      close();
    },
    [onViewChange, close],
  );

  const handleHelpOpenChange = useCallback(
    (open: boolean) => {
      onHelpOpenChange(open);
      if (open) close();
    },
    [onHelpOpenChange, close],
  );

  return (
    <div className="md:hidden">
      {/* Scrim: tap outside to collapse. Non-modal, transparent. */}
      {expanded ? (
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          onClick={close}
          className="fixed inset-0 z-20"
        />
      ) : null}

      <div className="fixed bottom-4 right-4 z-30 flex flex-col items-end gap-2">
        <AnimatePresence>
          {expanded ? (
            <motion.div
              key="cluster"
              // Small INTRA-group gap; MobileGroupGap spacers add the larger
              // BETWEEN-group separation (no divider lines on mobile).
              className="flex flex-col items-end gap-1.5"
              initial={reduceMotion ? false : "hidden"}
              animate="visible"
              exit={reduceMotion ? undefined : "hidden"}
              variants={{
                visible: { transition: { staggerChildren: 0.03 } },
                hidden: { transition: { staggerChildren: 0.02, staggerDirection: -1 } },
              }}
            >
              {/*
               * Visually (top → bottom on screen, since the cluster grows upward
               * from the FAB below):
               *
               * Owner:    [Help, Theme] │ [Participants, AI agent, Share] │ [Copy doc, Download] │ [Code, Preview]
               * Reviewer: [Help, Theme] │ [Code, Preview]
               *
               * The Help button only OPENS the sheet (and collapses the cluster);
               * the sheet surface itself is hosted below, outside this collapsing
               * cluster, so it survives the collapse.
               *
               * DOM order = screen top-to-bottom (flex-col, cluster sits above FAB).
               */}

              {/* Group 1 (top): [Theme, Help] */}
              <MobilePillItem
                label="Help"
                onClick={() => handleHelpOpenChange(true)}
                reduceMotion={reduceMotion}
              >
                <HelpCircle aria-hidden className="size-5" />
              </MobilePillItem>
              <MobileThemeItem reduceMotion={reduceMotion} />

              {role === "owner" ? (
                <>
                  {/* Group gap: between [Theme, Help] and the owner groups */}
                  <MobileGroupGap />

                  {/* Open-thread count status (audit m3) — sits at the top of the
                      owner section; hidden at zero. */}
                  <MobileThreadCount count={openThreadCount} reduceMotion={reduceMotion} />

                  {/* Group 2: [Copy reviewer link, Revoke link, Copy AI agent link, Participants] */}
                  <MobileParticipantsItem
                    participants={participants}
                    reduceMotion={reduceMotion}
                  />
                  <MobileAgentLinkItem slug={slug} reduceMotion={reduceMotion} />
                  <MobileRevokeItem slug={slug} reduceMotion={reduceMotion} />
                  <MobileShareItem slug={slug} reduceMotion={reduceMotion} />

                  {/* Group gap: between the link group and [Download, Copy doc] */}
                  <MobileGroupGap />

                  {/* Group 3: [Download, Copy document] */}
                  <MobileCopyDocumentItem slug={slug} reduceMotion={reduceMotion} />
                  <MobileDownloadItem slug={slug} reduceMotion={reduceMotion} />
                </>
              ) : null}

              {/* Group gap: between owner groups (or [Theme, Help]) and the view toggle */}
              <MobileGroupGap />

              {/* Group 4 (bottom): Preview↔Code segmented toggle (like desktop).
                  Picking a view also collapses the cluster (pickView) so the result
                  isn't hidden behind the overlay menu. */}
              <MobileViewToggle
                view={view}
                onViewChange={pickView}
                reduceMotion={reduceMotion}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>

        <button
          type="button"
          aria-label="Document actions"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            "inline-flex size-14 items-center justify-center rounded-full border border-border bg-elevated text-foreground shadow-pill",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          )}
        >
          <span className="t-icon-swap" data-state={expanded ? "b" : "a"} aria-hidden>
            <span className="t-icon" data-icon="a">
              <Plus className="size-6" />
            </span>
            <span className="t-icon" data-icon="b">
              <X className="size-6" />
            </span>
          </span>
        </button>
      </div>

      {/* Help sheet, hosted at the cluster root (NOT inside the collapsing
          cluster above) so it stays mounted and visible after the cluster
          collapses on open. Controlled by the shared helpOpen flag. */}
      <HelpPanel
        variant="sheet"
        open={helpOpen}
        onOpenChange={onHelpOpenChange}
        isOwner={role === "owner"}
      />
    </div>
  );
}

MobileCluster.displayName = "MobileCluster";

const mobileItemMotion = (reduceMotion: boolean | null) =>
  reduceMotion
    ? {}
    : {
        variants: {
          hidden: { opacity: 0, y: 8 },
          visible: { opacity: 1, y: 0 },
        },
      };

const mobileItemBase = cn(
  // h-11 = 44px touch target (M12). shadow-pill = theme-aware elevation (M15).
  "inline-flex h-11 items-center gap-2 rounded-full border border-border bg-elevated pl-3 pr-4 text-sm text-foreground shadow-pill",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
);

/**
 * Mobile Preview↔Code segmented toggle — the mobile counterpart of the desktop
 * PillToggleButton pair. A single right-aligned pill split into two segments
 * (matching the menu's pill language) instead of two stacked menu rows, so view
 * switching reads as a switch. Toggling does NOT collapse the cluster (like the
 * desktop toggle, it just flips the view).
 */
function MobileViewToggle({
  view,
  onViewChange,
  reduceMotion,
}: {
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  reduceMotion: boolean | null;
}) {
  return (
    <motion.div
      role="group"
      aria-label="View"
      className="inline-flex items-center gap-1 rounded-full border border-border bg-elevated p-1 shadow-pill"
      {...mobileItemMotion(reduceMotion)}
    >
      <MobileViewSegment
        label="Preview"
        selected={view === "preview"}
        onClick={() => onViewChange("preview")}
      >
        <Eye aria-hidden className="size-5" />
      </MobileViewSegment>
      <MobileViewSegment
        label="Code"
        selected={view === "code"}
        onClick={() => onViewChange("code")}
      >
        <Code2 aria-hidden className="size-5" />
      </MobileViewSegment>
    </motion.div>
  );
}

MobileViewToggle.displayName = "MobileViewToggle";

function MobileViewSegment({
  label,
  selected,
  onClick,
  children,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        // h-11 keeps each segment a ≥44px touch target (Apple HIG / WCAG 2.5.5).
        "inline-flex h-11 items-center gap-1.5 rounded-full px-3.5 text-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        selected ? "bg-primary text-primary-foreground" : "text-muted-foreground",
      )}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

MobileViewSegment.displayName = "MobileViewSegment";

/** A labelled action pill in the mobile cluster (icon + visible text). */
function MobilePillItem({
  label,
  selected,
  onClick,
  children,
  reduceMotion,
}: {
  label: string;
  selected?: boolean;
  onClick: () => void;
  children: ReactNode;
  reduceMotion: boolean | null;
}) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        mobileItemBase,
        // Active state uses bg-primary/text-primary-foreground for clear filled
        // contrast (black+white on light, white+dark on dark) matching the
        // desktop PillToggleButton active styling.
        selected ? "bg-primary text-primary-foreground border-primary" : undefined,
      )}
      {...mobileItemMotion(reduceMotion)}
    >
      {children}
      <span>{label}</span>
    </motion.button>
  );
}

MobilePillItem.displayName = "MobilePillItem";

function MobileThemeItem({ reduceMotion }: { reduceMotion: boolean | null }) {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useMounted();
  const isDark = mounted && resolvedTheme === "dark";
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";
  return (
    <motion.button
      type="button"
      aria-label={label}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className={mobileItemBase}
      {...mobileItemMotion(reduceMotion)}
    >
      {isDark ? <Sun aria-hidden className="size-5" /> : <Moon aria-hidden className="size-5" />}
      <span>{isDark ? "Light mode" : "Dark mode"}</span>
    </motion.button>
  );
}

MobileThemeItem.displayName = "MobileThemeItem";

function MobileDownloadItem({
  slug,
  reduceMotion,
}: {
  slug: string;
  reduceMotion: boolean | null;
}) {
  return (
    <motion.a
      href={`/api/d/${encodeURIComponent(slug)}/download`}
      download
      aria-label="Download Markdown"
      className={mobileItemBase}
      {...mobileItemMotion(reduceMotion)}
    >
      <Download aria-hidden className="size-5" />
      <span>Download .md</span>
    </motion.a>
  );
}

MobileDownloadItem.displayName = "MobileDownloadItem";

function MobileShareItem({
  slug,
  reduceMotion,
}: {
  slug: string;
  reduceMotion: boolean | null;
}) {
  const { state, copy } = useCopyShare(slug);
  return (
    <motion.button
      type="button"
      aria-label="Copy reviewer link"
      onClick={() => void copy()}
      className={mobileItemBase}
      {...mobileItemMotion(reduceMotion)}
    >
      {state === "copied" ? (
        <Check aria-hidden className="size-5" />
      ) : (
        <Link2 aria-hidden className="size-5" />
      )}
      <span>{state === "copied" ? "Copied" : "Copy reviewer link"}</span>
    </motion.button>
  );
}

MobileShareItem.displayName = "MobileShareItem";

function MobileCopyDocumentItem({
  slug,
  reduceMotion,
}: {
  slug: string;
  reduceMotion: boolean | null;
}) {
  const { state, copy } = useCopyDocument(slug);
  return (
    <motion.button
      type="button"
      aria-label="Copy document (Markdown + comments)"
      onClick={() => void copy()}
      className={mobileItemBase}
      {...mobileItemMotion(reduceMotion)}
    >
      {state === "copied" ? (
        <Check aria-hidden className="size-5" />
      ) : (
        <ClipboardCopy aria-hidden className="size-5" />
      )}
      <span>{state === "copied" ? "Copied" : "Copy document"}</span>
    </motion.button>
  );
}

MobileCopyDocumentItem.displayName = "MobileCopyDocumentItem";

function MobileAgentLinkItem({
  slug,
  reduceMotion,
}: {
  slug: string;
  reduceMotion: boolean | null;
}) {
  const { state, copy } = useCopyAgentLink(slug);
  return (
    <motion.button
      type="button"
      aria-label="Copy AI agent read link"
      onClick={() => void copy()}
      className={mobileItemBase}
      {...mobileItemMotion(reduceMotion)}
    >
      {state === "copied" ? (
        <Check aria-hidden className="size-5" />
      ) : (
        <Sparkles aria-hidden className="size-5" />
      )}
      <span>{state === "copied" ? "Copied" : "AI agent read link"}</span>
    </motion.button>
  );
}

MobileAgentLinkItem.displayName = "MobileAgentLinkItem";

function MobileParticipantsItem({
  participants,
  reduceMotion,
}: {
  participants: ParticipantSummary[];
  reduceMotion: boolean | null;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <motion.button
            type="button"
            aria-label={`Participants (${participants.length})`}
            className={mobileItemBase}
            {...mobileItemMotion(reduceMotion)}
          >
            <Users aria-hidden className="size-5" />
            <span>Participants</span>
          </motion.button>
        }
      />
      <PopoverContent side="top" align="end" sideOffset={8} className="w-64">
        <ParticipantsRoster participants={participants} />
      </PopoverContent>
    </Popover>
  );
}

MobileParticipantsItem.displayName = "MobileParticipantsItem";

/**
 * Open-thread count status in the mobile cluster (audit m3). Non-interactive
 * (role="status"), hidden at zero. Uses the same pill language as the action
 * items but is a div, not a button.
 */
function MobileThreadCount({
  count,
  reduceMotion,
}: {
  count: number;
  reduceMotion: boolean | null;
}) {
  if (count <= 0) return null;
  const label = `${count} open ${count === 1 ? "thread" : "threads"}`;
  return (
    <motion.div
      role="status"
      aria-label={label}
      className={cn(mobileItemBase, "text-muted-foreground")}
      {...mobileItemMotion(reduceMotion)}
    >
      <MessageSquare aria-hidden className="size-5" />
      <span>{label}</span>
    </motion.div>
  );
}

MobileThreadCount.displayName = "MobileThreadCount";

/**
 * Revoke & regenerate reviewer link in the mobile cluster (audit M5). Opens a
 * confirm popover (confirm-before-destroy) that runs revoke → regenerate → copy.
 */
function MobileRevokeItem({
  slug,
  reduceMotion,
}: {
  slug: string;
  reduceMotion: boolean | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <motion.button
            type="button"
            aria-label="Revoke & regenerate reviewer link"
            className={mobileItemBase}
            {...mobileItemMotion(reduceMotion)}
          >
            <KeyRound aria-hidden className="size-5" />
            <span>Revoke link</span>
          </motion.button>
        }
      />
      <PopoverContent side="top" align="end" sideOffset={8} className="w-72">
        <RevokeReviewerLinkConfirm slug={slug} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

MobileRevokeItem.displayName = "MobileRevokeItem";
