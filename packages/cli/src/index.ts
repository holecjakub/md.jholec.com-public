#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { ApiError, createApi, createClient, type Api } from "@md/core";
import {
  configPaths,
  loadConfig as loadConfigFile,
  mapPushError,
  resolveAnonToken,
  resolveAuthToken,
  resolveBaseUrl as resolveBaseUrlFor,
  saveConfig as saveConfigFile,
  type Config,
} from "./config";

const { dir: CONFIG_DIR, file: CONFIG_FILE } = configPaths();

function loadConfig(): Config {
  return loadConfigFile(CONFIG_FILE);
}

function saveConfig(cfg: Config): void {
  saveConfigFile(CONFIG_DIR, CONFIG_FILE, cfg);
}

function resolveBaseUrl(): string {
  return resolveBaseUrlFor(process.env, loadConfig());
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * Read a secret from the controlling terminal with echo disabled, so it never
 * lands in the shell history or in `ps` output (security review M5). Falls back
 * to failing loudly when there is no TTY to prompt on.
 */
function promptSecret(label: string): Promise<string> {
  return new Promise((resolve) => {
    const input = process.stdin;
    const output = process.stderr;
    output.write(`${label}: `);
    input.setRawMode?.(true);
    input.resume();
    input.setEncoding("utf8");
    let value = "";
    const ENTER_LF = 0x0a; // \n
    const ENTER_CR = 0x0d; // \r
    const EOT = 0x04; // Ctrl-D
    const ETX = 0x03; // Ctrl-C
    const BACKSPACE = 0x08; // \b
    const DELETE = 0x7f;
    const finish = (): void => {
      input.setRawMode?.(false);
      input.pause();
      input.removeListener("data", onData);
      output.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        const code = ch.codePointAt(0) ?? 0;
        if (code === ENTER_LF || code === ENTER_CR || code === EOT) {
          finish();
          resolve(value);
          return;
        }
        if (code === ETX) {
          finish();
          process.exit(130);
          return;
        }
        if (code === BACKSPACE || code === DELETE) {
          value = value.slice(0, -1);
          continue;
        }
        // Ignore other control characters; keep printable input (incl. non-ASCII).
        if (code >= 0x20) value += ch;
      }
    };
    input.on("data", onData);
  });
}

/**
 * Resolve a secret from (in order): the explicit flag, an environment variable,
 * or a no-echo TTY prompt. Explicit flags remain a documented escape hatch, but
 * are no longer required so secrets need not appear in argv.
 */
async function resolveSecret(flag: string | undefined, envVar: string, label: string): Promise<string> {
  if (flag !== undefined && flag !== "") return flag;
  const fromEnv = process.env[envVar];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (process.stdin.isTTY !== true) {
    fail(`Missing ${label}. Provide it via the ${envVar} environment variable or an interactive terminal (avoid passing it as a flag).`);
  }
  return promptSecret(label);
}

/** Authenticated API (PAT required). */
function api(): Api {
  const token = resolveAuthToken(process.env, loadConfig());
  if (!token) {
    fail("Not authenticated. Run `md auth login --token <pat>` or set MD_TOKEN.");
  }
  return createApi(createClient({ baseUrl: resolveBaseUrl(), token }));
}

/** Anonymous API (for endpoints that don't require auth, e.g. document creation). */
function anonApi(): Api {
  const token = resolveAnonToken(process.env, loadConfig());
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
  .option(
    "--token <pat>",
    "personal access token (escape hatch — prefer the MD_TOKEN env var or the interactive prompt, since flags are visible in `ps` and shell history)",
  )
  .option("--api <url>", "API base URL")
  .action(async (opts: { token?: string; api?: string }) => {
    const token = await resolveSecret(opts.token, "MD_TOKEN", "Personal access token");
    const cfg = loadConfig();
    cfg.token = token;
    if (opts.api) cfg.apiUrl = opts.api;
    saveConfig(cfg);
    console.log(`Saved credentials to ${CONFIG_FILE}`);
  });

auth
  .command("unlock")
  .description("Unlock the early-access gate so `md new` can create documents")
  .option(
    "--password <password>",
    "early-access password (escape hatch — prefer the MD_EARLY_ACCESS_PASSWORD env var or the interactive prompt)",
  )
  .option("--api <url>", "API base URL")
  .action(async (opts: { password?: string; api?: string }) => {
    const cfg = loadConfig();
    if (opts.api) {
      cfg.apiUrl = opts.api;
      saveConfig(cfg); // persist first so resolveBaseUrl() picks it up for the call below
    }
    const password = await resolveSecret(
      opts.password,
      "MD_EARLY_ACCESS_PASSWORD",
      "Early-access password",
    );
    const grant = await run(() => anonApi().unlockEarlyAccess(password));
    cfg.earlyAccessGrant = grant;
    saveConfig(cfg);
    console.log("Early-access unlocked. You can now run `md new`.");
  });

program
  .command("new <file>")
  .description("Create a hosted document from a local .md file")
  .requiredOption("--title <title>", "document title")
  .option(
    "--password <password>",
    "document password for reviewers (escape hatch — prefer the MD_DOC_PASSWORD env var or the interactive prompt)",
  )
  .option("--json", "output JSON")
  .action(async (file: string, opts: { title: string; password?: string; json?: boolean }) => {
    const content = readFileSync(file, "utf8");
    const password = await resolveSecret(opts.password, "MD_DOC_PASSWORD", "Document password");
    const cfg = loadConfig();
    let res;
    try {
      res = await anonApi().pushDocument(
        { title: opts.title, content, password },
        cfg.earlyAccessGrant,
      );
    } catch (e) {
      fail(mapPushError(e));
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
    // Owner authority required: the stored PAT must carry docs:write AND the
    // "tokens:mint" owner scope for this document (security review M1) — i.e. a
    // token minted with those scopes from the owner session in the browser.
    const res = await run(() => api().mintAgentLink(slug));
    out(
      `AI agent read link (read-only · single-doc · expires ${res.expiresAt} · revocable via \`md revoke\`):\n  ${res.url}`,
      res,
      opts.json ?? false,
    );
  });

// ── R1: credential revocation ───────────────────────────────────────────────
program
  .command("revoke <slug>")
  .description("Revoke credentials for a document you own (invite links, PATs, agent links)")
  .option("--invites", "revoke only reusable invite share links")
  .option("--tokens", "revoke only personal access tokens and agent read links")
  .option("--json", "output JSON")
  .action(async (slug: string, opts: { invites?: boolean; tokens?: boolean; json?: boolean }) => {
    // Default (no flag): revoke both invites and tokens.
    const doInvites = opts.invites || !opts.tokens;
    const doTokens = opts.tokens || !opts.invites;
    const result: { invitesRevoked?: number; tokensRevoked?: number } = {};
    const lines: string[] = [];
    // Invites first: revoking tokens kills the very PAT this CLI is authenticating
    // with (it is bound to the same document), so it must be the last call.
    if (doInvites) {
      const r = await run(() => api().revokeInvites(slug));
      result.invitesRevoked = r.revoked;
      lines.push(`Revoked ${r.revoked} invite link(s).`);
    }
    if (doTokens) {
      const r = await run(() => api().revokeTokens(slug));
      result.tokensRevoked = r.revoked;
      lines.push(
        `Revoked ${r.revoked} access token(s) — including the PAT this CLI was using for ${slug}.`,
      );
    }
    out(lines.join("\n"), result, opts.json ?? false);
  });
// ── end R1 ──────────────────────────────────────────────────────────────────

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
