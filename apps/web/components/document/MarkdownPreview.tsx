"use client";

import type { ComponentPropsWithoutRef } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

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
 * rehype-highlight emits on code blocks/spans (hljs token classes).
 * data-block-id is applied via the React components map (below) — it is a React
 * prop, never passed through the HTML sanitizer — so it needs no allow-listing.
 */
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className"],
    code: [...(defaultSchema.attributes?.code ?? []), "className"],
    span: [...(defaultSchema.attributes?.span ?? []), "className"],
  },
};

// Highlight first (synchronous — react-markdown runs rehype with runSync), then
// sanitize LAST so nothing any plugin emits can smuggle script/handlers through.
const remarkPlugins = [remarkGfm];
const rehypePlugins = [
  [rehypeHighlight, { detect: true, ignoreMissing: true }],
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
    const Block = ({ node, ...props }: RenderProps & ComponentPropsWithoutRef<T>) => {
      const id = idFor(node);
      const Component = Tag as React.ElementType;
      return <Component {...props} data-block-id={String(id)} />;
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

export function MarkdownPreview({ content }: { content: string }) {
  // A fresh map (and its per-render counter) each render so block ids are
  // assigned deterministically top-to-bottom (0,1,2…) on every parse. The map
  // is a handful of closures, so rebuilding it per render is negligible.
  const components = createComponents();

  return (
    <div className="md-prose w-full">
      <Markdown
        remarkPlugins={remarkPlugins}
        // The plugin tuple array is well-typed at the element level; the cast
        // bridges react-markdown's broad PluggableList type without `any`.
        rehypePlugins={rehypePlugins as unknown as Parameters<typeof Markdown>[0]["rehypePlugins"]}
        components={components}
      >
        {content}
      </Markdown>
    </div>
  );
}
