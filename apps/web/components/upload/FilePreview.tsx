"use client";

import { Check, FileText, X } from "lucide-react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { formatBytes } from "./file-validation";

interface FilePreviewProps {
  file: File;
  onRemove?: () => void;
  variant: "selected" | "success";
  reduce: boolean;
}

/**
 * File chip: icon tile, filename, size, Remove button.
 * In "success" variant: done-check badge, no Remove, layout FLIP to top-left.
 * Gate-res B5: min-h-12, dedicated 48×48 Remove slot.
 */
export function FilePreview({
  file,
  onRemove,
  variant,
  reduce,
}: FilePreviewProps) {
  const isSuccess = variant === "success";

  const chipVariants = {
    hidden: { opacity: 0, scale: 0.92 },
    reveal: {
      opacity: 1,
      scale: 1,
      transition: reduce
        ? { duration: 0 }
        : { duration: 0.32, ease: [0.2, 0, 0, 1] as [number, number, number, number] },
    },
  };

  const tileVariants = {
    hidden: { scale: 0.6 },
    reveal: {
      scale: 1,
      transition: reduce
        ? { duration: 0 }
        : {
            duration: 0.22,
            ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
          },
    },
  };

  return (
    <motion.div
      layout={!reduce}
      initial={false}
      variants={chipVariants}
      animate="reveal"
      transition={reduce ? { duration: 0 } : { duration: 0.32, ease: [0.2, 0, 0, 1] as [number, number, number, number] }}
      className={cn(
        "inline-flex min-h-12 max-w-full items-center gap-3 self-start rounded-lg border border-border bg-secondary/60 px-3 py-2.5",
        isSuccess && "self-start",
      )}
    >
      {/* Icon tile — "unwraps" on reveal */}
      <motion.span
        variants={tileVariants}
        className="relative flex size-9 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground"
        style={{ transformOrigin: "center" }}
        aria-hidden="true"
      >
        <FileText className="size-4" aria-hidden="true" />
        {isSuccess && (
          <span className="animate-badge-pop absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full bg-accent text-accent-foreground">
            <Check className="size-2.5" aria-hidden="true" />
          </span>
        )}
      </motion.span>

      {/* Filename */}
      <span
        className="min-w-0 flex-1 truncate font-mono text-sm text-foreground"
        title={file.name}
      >
        {file.name}
      </span>

      {/* Size */}
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        {formatBytes(file.size)}
      </span>

      {/* Remove button — dedicated 48×48 slot, hidden in success */}
      {!isSuccess && onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove file"
          className={cn(
            "inline-flex size-12 shrink-0 items-center justify-center rounded-full text-muted-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            "transition-colors [@media(hover:hover)]:hover:bg-background [@media(hover:hover)]:hover:text-foreground",
          )}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      ) : (
        /* Keep layout stable — placeholder only if no remove */
        !isSuccess && <span className="size-12 shrink-0" aria-hidden="true" />
      )}
    </motion.div>
  );
}
