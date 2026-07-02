import { ExternalLink } from "lucide-react";

/**
 * GitHub brand mark. lucide-react v1 dropped brand glyphs, so the official
 * Octocat mark is inlined here (decorative — the link carries the accessible name).
 */
function GitHubMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 .5C5.73.5.5 5.74.5 12.02c0 5.1 3.29 9.42 7.86 10.95.58.11.79-.25.79-.56 0-.27-.01-1.16-.02-2.1-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.05.78 2.12 0 1.53-.01 2.77-.01 3.15 0 .31.21.68.8.56A11.53 11.53 0 0 0 23.5 12.02C23.5 5.74 18.27.5 12 .5Z" />
    </svg>
  );
}

/**
 * GitHub external-link button for the self-host card.
 * Opens in a new tab with noopener noreferrer.
 */
export function GitHubButton() {
  return (
    <a
      href="https://github.com/holecjakub/md.jholec.com"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="View md.jholec.com on GitHub (opens in a new tab)"
      className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-border bg-background px-5 text-sm font-medium text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.97] motion-reduce:active:scale-100 [@media(hover:hover)]:hover:bg-secondary sm:w-auto"
    >
      <GitHubMark className="size-4" />
      View on GitHub
      <ExternalLink className="size-3.5" aria-hidden="true" />
    </a>
  );
}
