#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { ApiError, createApi, createClient, type Api } from "@md/core";

const CONFIG_DIR = join(homedir(), ".config", "md");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const DEFAULT_API_URL = "https://md.jholec.com/api";

interface Config {
  token?: string;
  apiUrl?: string;
  /** Early-access gate grant (from `md auth unlock`) — sent as the gate cookie on `md new`. */
  earlyAccessGrant?: string;
}

function loadConfig(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Config;
  } catch {
    return {};
  }
}

function saveConfig(cfg: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

function resolveBaseUrl(): string {
  return process.env.MD_API_URL ?? loadConfig().apiUrl ?? DEFAULT_API_URL;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Authenticated API (PAT required). */
function api(): Api {
  const token = process.env.MD_TOKEN ?? loadConfig().token;
  if (!token) {
    fail("Not authenticated. Run `md auth login --token <pat>` or set MD_TOKEN.");
  }
  return createApi(createClient({ baseUrl: resolveBaseUrl(), token }));
}

/** Anonymous API (for endpoints that don't require auth, e.g. document creation). */
function anonApi(): Api {
  const token = process.env.MD_TOKEN ?? loadConfig().token ?? "none";
  return createApi(createClient({ baseUrl: resolveBaseUrl(), token }));
}

const isTty = process.stdout.isTTY === true;

function out(human: string, data: unknown, json: boolean): void {
  if (json || !isTty) console.log(JSON.stringify(data, null, 2));
  else console.log(human);
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError) fail(`Error ${e.status}: ${e.message}`);
    fail(e instanceof Error ? e.message : String(e));
  }
}

const program = new Command();
program
  .name("md")
  .description("md.jholec.com — host, edit, and review markdown from the CLI")
  .version("0.1.0");

const auth = program.command("auth").description("Manage credentials");
auth
  .command("login")
  .description("Store a Personal Access Token")
  .requiredOption("--token <pat>", "personal access token")
  .option("--api <url>", "API base URL")
  .action((opts: { token: string; api?: string }) => {
    const cfg = loadConfig();
    cfg.token = opts.token;
    if (opts.api) cfg.apiUrl = opts.api;
    saveConfig(cfg);
    console.log(`Saved credentials to ${CONFIG_FILE}`);
  });

auth
  .command("unlock")
  .description("Unlock the early-access gate so `md new` can create documents")
  .requiredOption("--password <password>", "early-access password")
  .option("--api <url>", "API base URL")
  .action(async (opts: { password: string; api?: string }) => {
    const cfg = loadConfig();
    if (opts.api) {
      cfg.apiUrl = opts.api;
      saveConfig(cfg); // persist first so resolveBaseUrl() picks it up for the call below
    }
    const grant = await run(() => anonApi().unlockEarlyAccess(opts.password));
    cfg.earlyAccessGrant = grant;
    saveConfig(cfg);
    console.log("Early-access unlocked. You can now run `md new`.");
  });

program
  .command("new <file>")
  .description("Create a hosted document from a local .md file")
  .requiredOption("--title <title>", "document title")
  .requiredOption("--password <password>", "document password for reviewers")
  .option("--json", "output JSON")
  .action(async (file: string, opts: { title: string; password: string; json?: boolean }) => {
    const content = readFileSync(file, "utf8");
    const cfg = loadConfig();
    let res;
    try {
      res = await anonApi().pushDocument(
        { title: opts.title, content, password: opts.password },
        cfg.earlyAccessGrant,
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        fail("Upload is locked. Run `md auth unlock --password <password>` first.");
      }
      if (e instanceof ApiError) fail(`Error ${e.status}: ${e.message}`);
      fail(e instanceof Error ? e.message : String(e));
    }
    out(
      `Created.\n  slug:    ${res.slug}\n  share:   ${res.shareUrl}\n  owner:   ${res.ownerUrl}\n  agent:   ${res.agentUrl}\n  expires: ${res.expiresAt}`,
      res,
      opts.json ?? false,
    );
  });

program
  .command("pull <slug>")
  .description("Download the current version of a document")
  .option("-o, --out <file>", "write to a file instead of stdout")
  .option(
    "--comments",
    "include the document's comments as an embedded appendix (owner only)",
  )
  .action(async (slug: string, opts: { out?: string; comments?: boolean }) => {
    if (opts.comments) {
      // The /download endpoint embeds comments+reactions as an HTML-comment
      // appendix (md.jholec.com/comments) — invisible in any renderer, parseable
      // back via @md/core parseComments.
      const content = await run(() => api().downloadDocument(slug));
      if (opts.out) {
        writeFileSync(opts.out, content);
        console.error(`Wrote ${slug} (with comments) → ${opts.out}`);
      } else {
        process.stdout.write(content);
      }
      return;
    }
    const doc = await run(() => api().pullDocument(slug));
    if (opts.out) {
      writeFileSync(opts.out, doc.content);
      console.error(`Wrote ${slug} v${doc.versionNo} → ${opts.out}`);
    } else {
      process.stdout.write(doc.content);
    }
  });

program
  .command("push <slug> <file>")
  .description("Upload a local .md file as a new version (edit)")
  .option("--title <title>", "also update the title")
  .option("--json", "output JSON")
  .action(async (slug: string, file: string, opts: { title?: string; json?: boolean }) => {
    const content = readFileSync(file, "utf8");
    const res = await run(() => api().pushVersion(slug, content, opts.title));
    out(`Pushed ${slug} → v${res.versionNo}`, res, opts.json ?? false);
  });

program
  .command("comments <slug>")
  .description("List comments/threads on a document")
  .option("--open", "only open comments")
  .option("--json", "output JSON")
  .action(async (slug: string, opts: { open?: boolean; json?: boolean }) => {
    const comments = await run(() => api().listComments(slug, { open: opts.open }));
    if (opts.json || !isTty) {
      console.log(JSON.stringify(comments, null, 2));
      return;
    }
    if (comments.length === 0) {
      console.log("No comments.");
      return;
    }
    for (const c of comments) {
      const kind = c.parentId ? "  ↳ reply" : `• ${c.status}`;
      console.log(`${kind} [${c.id.slice(0, 8)}] ${c.body}`);
    }
  });

program
  .command("reply <slug> <commentId> <body>")
  .description("Reply to a comment")
  .option("--json", "output JSON")
  .action(async (slug: string, commentId: string, body: string, opts: { json?: boolean }) => {
    const c = await run(() => api().reply(slug, commentId, body));
    out(`Replied [${c.id.slice(0, 8)}]`, c, opts.json ?? false);
  });

program
  .command("react <slug> <commentId> <emoji>")
  .description("Add an emoji reaction to a comment")
  .option("--json", "output JSON")
  .action(async (slug: string, commentId: string, emoji: string, opts: { json?: boolean }) => {
    const r = await run(() => api().react(slug, commentId, emoji));
    out(`Reacted ${emoji}`, r, opts.json ?? false);
  });

program
  .command("agent-link <slug>")
  .description("Mint a read-only AI-agent read link for a document you own")
  .option("--json", "output JSON")
  .action(async (slug: string, opts: { json?: boolean }) => {
    // Owner auth required: the stored PAT must carry owner (docs:write) access for
    // this document — i.e. a token minted from the owner session in the browser.
    const res = await run(() => api().mintAgentLink(slug));
    out(
      `AI agent read link (read-only · single-doc · 30-day · revocable):\n  ${res.url}`,
      res,
      opts.json ?? false,
    );
  });

program
  .command("resolve <slug> <commentId>")
  .description("Resolve a comment thread (owner only)")
  .option("--json", "output JSON")
  .action(async (slug: string, commentId: string, opts: { json?: boolean }) => {
    const r = await run(() => api().setCommentStatus(slug, commentId, "resolved"));
    out(`Resolved [${r.id.slice(0, 8)}]`, r, opts.json ?? false);
  });

program
  .command("reopen <slug> <commentId>")
  .description("Reopen a resolved comment thread (owner only)")
  .option("--json", "output JSON")
  .action(async (slug: string, commentId: string, opts: { json?: boolean }) => {
    const r = await run(() => api().setCommentStatus(slug, commentId, "open"));
    out(`Reopened [${r.id.slice(0, 8)}]`, r, opts.json ?? false);
  });

await program.parseAsync(process.argv);
