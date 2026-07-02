import { ThemeToggle } from "@/components/document/ThemeToggle";
import { UploadPanel } from "@/components/upload/UploadPanel";
import { SelfHostCard } from "@/components/upload/SelfHostCard";

export default function Home() {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex h-14 items-center justify-between px-6">
        <span className="font-mono text-sm font-medium tracking-tight text-foreground">
          md.jholec.com
        </span>
        <ThemeToggle className="size-10" />
      </header>

      <main className="flex flex-1 flex-col items-center px-6 py-16">
        {/* Hero — simple, centered. text-center scoped to this wrapper only. */}
        <div className="flex w-full max-w-xl flex-col items-center gap-6 text-center">
          <h1 className="text-balance text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            Markdown, shared for feedback.
          </h1>
          <p className="text-balance text-lg leading-relaxed text-muted-foreground">
            Host a Markdown file, share a link, and collect Figma-style inline
            feedback — no install required.
          </p>
          <p className="text-sm text-muted-foreground">
            Documents open at{" "}
            <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[0.8125rem] text-foreground">
              /d/&lt;slug&gt;
            </code>
          </p>
        </div>

        {/* Primary action: the upload module sits right under the hero. */}
        <div className="mt-12 flex w-full flex-col items-center">
          <UploadPanel />
        </div>

        {/* Self-host: a quiet hint pushed to the end of the page. */}
        <div className="mt-auto w-full pt-20">
          <SelfHostCard />
        </div>
      </main>

      <footer className="px-6 py-6 text-center text-xs text-muted-foreground">
        md.jholec.com
      </footer>
    </div>
  );
}
