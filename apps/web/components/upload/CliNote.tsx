import { Terminal } from "lucide-react";

/**
 * "Your agent can upload for you" CLI note.
 * Text-only for v1 (no link) per gate-res S3.
 * Readable by SR in normal DOM order.
 */
export function CliNote() {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-secondary/40 px-3 py-2.5">
      <Terminal
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <div>
        <p className="text-sm font-medium text-foreground">
          Your agent can upload for you.
        </p>
        <p className="mt-0.5 text-pretty text-sm text-muted-foreground">
          Already wired into a workflow? Add the{" "}
          <span className="font-mono">md</span> CLI and your agent can push
          Markdown straight to a share link — authenticate once with a personal
          access token.
        </p>
      </div>
    </div>
  );
}
