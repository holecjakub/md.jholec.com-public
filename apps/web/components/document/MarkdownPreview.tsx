"use client";

import { memo, useMemo, type ComponentPropsWithoutRef } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { common } from "lowlight";

import "@/app/markdown.css";

// react-markdown passes the original hast node alongside the React props for
// each rendered element. We use it to detect top-level (root-child) blocks so
// data-block-id is stamped only on those, matching Plan 04's anchoring needs.
type MdNode = {
  position?: { start?: { line?: number } };
};

interface RenderProps {
  node?: MdNode;
}

/**
 * Sanitize schema: extend the safe default (which already blocks <script>,
 * event handlers and javascript: URLs) to permit the className that
 * rehype-highlight emits on code blocks/spans (hljs token classes) — ONLY on
 * code/span/pre, not via the '*' wildcard, so arbitrary elements cannot carry
 * attacker-chosen classes (CSS-based spoofing/clickjacking surface).
 * data-block-id is applied via the React components map (below) — it is a React
 * prop, never passed through the HTML sanitizer — so it needs no allow-listing.
 */
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), "className"],
    span: [...(defaultSchema.attributes?.span ?? []), "className"],
    pre: [...(defaultSchema.attributes?.pre ?? []), "className"],
  },
};

/**
 * Explicit grammar subset for rehype-highlight (picked from lowlight's
 * `common` set, which the plugin already bundles, so this adds no weight).
 * `detect: false` disables highlight.js auto-detection, which otherwise runs
 * every registered grammar against every untagged fence — the single most
 * expensive step of rendering large docs. Untagged or unknown-language fences
 * simply render unhighlighted. Grammar aliases (js/jsx, ts/tsx, sh, py, yml,
 * md, html, patch, …) ship with each grammar, so tagged fences keep working.
 */
const highlightLanguages = {
  bash: common.bash,
  c: common.c,
  cpp: common.cpp,
  csharp: common.csharp,
  css: common.css,
  diff: common.diff,
  go: common.go,
  graphql: common.graphql,
  ini: common.ini,
  java: common.java,
  javascript: common.javascript,
  json: common.json,
  kotlin: common.kotlin,
  lua: common.lua,
  makefile: common.makefile,
  markdown: common.markdown,
  objectivec: common.objectivec,
  perl: common.perl,
  php: common.php,
  plaintext: common.plaintext,
  python: common.python,
  ruby: common.ruby,
  rust: common.rust,
  scss: common.scss,
  shell: common.shell,
  sql: common.sql,
  swift: common.swift,
  typescript: common.typescript,
  xml: common.xml,
  yaml: common.yaml,
};

// Highlight first (synchronous — react-markdown runs rehype with runSync), then
// sanitize LAST so nothing any plugin emits can smuggle script/handlers through.
const remarkPlugins = [remarkGfm];
const rehypePlugins = [
  [rehypeHighlight, { detect: false, languages: highlightLanguages }],
  [rehypeSanitize, sanitizeSchema],
] as const;

/**
 * Builds the react-markdown components map. A per-render counter assigns a
 * stable, sequential data-block-id (0,1,2,…) to each top-level block, top to
 * bottom. "Top-level" = a block whose hast node starts at column-ish root level;
 * we approximate by stamping known block tags and only counting the first
 * occurrence per source line, which keeps ids deterministic for the same content.
 */
function createComponents(): Components {
  let counter = 0;
  // Keyed by the hast node identity, so a block rendered once gets one stable id.
  // (rehype-sanitize strips node.position, so we cannot rely on source lines.)
  const ids = new Map<object, number>();

  const idFor = (node: MdNode | undefined): number => {
    if (!node) return counter++;
    const existing = ids.get(node);
    if (existing !== undefined) return existing;
    const id = counter++;
    ids.set(node, id);
    return id;
  };

  const block = <T extends keyof HTMLElementTagNameMap>(Tag: T) => {
    // Blocks join the tab order (WCAG 2.1.1): comment creation must not require
    // a pointer selection, so every commentable block is keyboard-focusable and
    // CommentsLayer reveals a "Comment on this block" affordance on focus. An
    // <hr> carries no text a quote anchor could relocate to, so it stays out of
    // the tab order.
    const focusable = Tag !== "hr";
    const Block = ({ node, ...props }: RenderProps & ComponentPropsWithoutRef<T>) => {
      const id = idFor(node);
      const Component = Tag as React.ElementType;
      return (
        <Component
          {...props}
          data-block-id={String(id)}
          tabIndex={focusable ? 0 : undefined}
        />
      );
    };
    Block.displayName = `Block(${Tag})`;
    return Block;
  };

  return {
    h1: block("h1"),
    h2: block("h2"),
    h3: block("h3"),
    h4: block("h4"),
    h5: block("h5"),
    h6: block("h6"),
    p: block("p"),
    ul: block("ul"),
    ol: block("ol"),
    blockquote: block("blockquote"),
    pre: block("pre"),
    table: block("table"),
    hr: block("hr"),
  };
}

/**
 * Memoized on `content` (a plain string), so parent state changes — comment
 * updates, selection, realtime events — never re-run react-markdown's parse
 * (~hundreds of ms on large docs). The `<Markdown>` element AND its components
 * map are built together in one useMemo keyed on `content`: each parse gets a
 * fresh components map (so its per-parse counter assigns block ids 0,1,2…
 * top-to-bottom deterministically), and the stable element identity lets React
 * bail out of re-rendering — and thus re-parsing — whenever this component
 * renders again without a content change.
 */
export const MarkdownPreview = memo(function MarkdownPreview({
  content,
}: {
  content: string;
}) {
  const rendered = useMemo(
    () => (
      <Markdown
        remarkPlugins={remarkPlugins}
        // The plugin tuple array is well-typed at the element level; the cast
        // bridges react-markdown's broad PluggableList type without `any`.
        rehypePlugins={rehypePlugins as unknown as Parameters<typeof Markdown>[0]["rehypePlugins"]}
        components={createComponents()}
      >
        {content}
      </Markdown>
    ),
    [content],
  );

  return <div className="md-prose w-full">{rendered}</div>;
});
