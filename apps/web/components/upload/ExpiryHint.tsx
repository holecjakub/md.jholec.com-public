import { Clock } from "lucide-react";

/**
 * 30-day retention hint row.
 * Formats the server-returned expiresAt ISO string to a human-readable date.
 */
export function ExpiryHint({ expiresAt }: { expiresAt: string }) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  let dateLabel = "";
  try {
    dateLabel = formatter.format(new Date(expiresAt));
  } catch {
    dateLabel = "";
  }

  return (
    <div className="flex items-start gap-2 text-pretty text-sm text-muted-foreground">
      <Clock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>
        Hosted for 30 days on jholec.com, then automatically deleted. Download
        the source anytime from the owner link.
        {dateLabel ? (
          <>
            {" "}
            <span className="tabular-nums">Auto-deletes on {dateLabel}.</span>
          </>
        ) : null}
      </span>
    </div>
  );
}
