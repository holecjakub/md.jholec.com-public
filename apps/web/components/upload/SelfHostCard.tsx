import { GitHubButton } from "./GitHubButton";

/**
 * Self-host card — the full hint, kept at the very bottom of the page.
 * For people who'd rather not have us host their files: run it themselves.
 */
export function SelfHostCard({ className }: { className?: string }) {
  return (
    <section
      aria-labelledby="selfhost-heading"
      className={`mx-auto w-full max-w-2xl rounded-xl border border-border bg-secondary/40 p-6 ${className ?? ""}`}
    >
      <h2
        id="selfhost-heading"
        className="text-base font-semibold text-foreground"
      >
        Prefer to host it yourself?
      </h2>
      <p className="mt-2 text-pretty text-sm text-muted-foreground">
        Don&apos;t want us hosting your files? md.jholec.com is open source. Run
        it on your own cluster with self-hosted Supabase — your documents never
        leave your infrastructure.
      </p>
      <div className="mt-4">
        <GitHubButton />
      </div>
    </section>
  );
}
