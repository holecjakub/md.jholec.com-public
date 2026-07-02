/**
 * "How it works" explainer section.
 * Static, server-safe, no client state needed.
 */

const POINTS = [
  "Reviewers annotate, they don't edit. Your Markdown stays the source of truth.",
  "Links are the keys. Anyone with the reviewer link can read and comment; the owner link is yours alone.",
  "Password optional. The document password is a backup way in for reviewers who don't have the link.",
  "Comments are anchored to the text and survive a reload.",
] as const;

export function HowItWorks() {
  return (
    <section
      aria-labelledby="how-it-works-heading"
      className="rounded-xl border border-border bg-secondary/40 p-6"
    >
      <h2
        id="how-it-works-heading"
        className="text-base font-semibold text-foreground"
      >
        How it works
      </h2>
      <ul className="mt-4 flex flex-col gap-3">
        {POINTS.map((point, index) => (
          <li key={index} className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background text-xs font-medium text-muted-foreground"
            >
              {index + 1}
            </span>
            <span className="text-pretty text-sm text-foreground">{point}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * AI agent read explainer — shown in the upload success card alongside CliNote.
 *
 * At upload time the owner only has the owner/reviewer links; the export token
 * is minted later in owner mode. Phrase the explainer accordingly.
 *
 * Caveat copy (brief §"User-facing caveat"): agent gets read-only access; a human
 * should stay in the loop for any action (OWASP LLM01 indirect injection note).
 */
export function AgentReadNote() {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-secondary/40 px-3 py-2.5">
      {/* Sparkles icon — decorative, aria-hidden */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      >
        <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
        <path d="M20 3v4" />
        <path d="M22 5h-4" />
        <path d="M4 17v2" />
        <path d="M5 18H3" />
      </svg>
      <div>
        <p className="text-sm font-medium text-foreground">
          Hand an AI agent a read-only link.
        </p>
        <p className="mt-0.5 text-pretty text-sm text-muted-foreground">
          Open your owner link to copy an AI agent read link — the agent can
          fetch the document content and comments in one call. The agent gets
          read-only access and cannot write, share, or manage the document. Keep
          a human in the loop for any follow-up action.
        </p>
      </div>
    </div>
  );
}
