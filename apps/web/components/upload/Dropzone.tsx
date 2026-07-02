"use client";

import { useRef } from "react";
import { UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  validateFile,
  pickFirstMarkdown,
  type FileError,
} from "./file-validation";

interface DropzoneProps {
  onAccept: (file: File) => void;
  onReject: (e: FileError) => void;
  onDragState: (dragging: boolean) => void;
  state: "idle" | "drag" | "fileError";
  fileError: FileError | null;
}

const FILE_ERROR_COPY: Record<FileError, string> = {
  "wrong-type": "That's not a Markdown file. Drop a .md file to continue.",
  "too-large": "That file is too large. Markdown files up to 2 MB are supported.",
  empty: "That file looks empty. Pick a Markdown file with some content.",
};

/**
 * Dropzone component for drag/drop + file browse.
 * Gate-res B3+B4: container has NO role, NO tabindex.
 * The visible Browse files <button> is the single keyboard control.
 * <input type=file> is aria-hidden + tabIndex=-1.
 */
export function Dropzone({
  onAccept,
  onReject,
  onDragState,
  state,
  fileError,
}: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  function openPicker() {
    inputRef.current?.click();
  }

  function handleFile(file: File) {
    const err = validateFile(file);
    if (err) {
      onReject(err);
    } else {
      onAccept(file);
    }
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      handleFile(file);
    }
    // Reset so re-selecting the same file fires onChange again
    e.target.value = "";
  }

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    onDragState(true);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    onDragState(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    // Only leave if leaving the container itself (not a child)
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      onDragState(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    onDragState(false);
    const file = pickFirstMarkdown(e.dataTransfer.files);
    if (file) {
      handleFile(file);
    } else if (e.dataTransfer.files.length > 0) {
      onReject("wrong-type");
    }
  }

  const isDrag = state === "drag";
  const isError = state === "fileError";

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      // Whole-container pointer tap → open picker (touch convenience, no tab stop added)
      onClick={openPicker}
      className={cn(
        "group relative mx-auto flex w-full flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-border bg-card p-8 text-center",
        "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.12)]",
        "transition-[border-color,background-color,box-shadow] duration-[120ms]",
        isDrag && "border-solid border-accent bg-accent/5 dark:bg-accent/10",
        isError && "border-destructive",
        !isDrag && !isError && "[@media(hover:hover)]:hover:shadow-[0_2px_4px_rgba(0,0,0,0.05),0_16px_40px_-16px_rgba(0,0,0,0.18)]",
      )}
    >
      {/* Glyph */}
      <UploadCloud
        className={cn(
          "size-8 transition-transform duration-[120ms]",
          isDrag
            ? "scale-[1.08] text-accent motion-reduce:scale-100"
            : isError
              ? "text-destructive"
              : "text-muted-foreground",
        )}
        aria-hidden="true"
      />

      {/* Primary label — responsive: different text on small screens */}
      <p className="text-base font-medium text-foreground">
        {isDrag ? (
          "Drop to upload"
        ) : (
          <>
            <span className="sm:hidden">Add a Markdown file</span>
            <span className="hidden sm:inline">Drag your Markdown file here</span>
          </>
        )}
      </p>

      {/* Secondary row: "or" + Browse button — only shown when not dragging */}
      {!isDrag && (
        <div
          className="flex w-full flex-col items-center gap-2 sm:flex-row sm:justify-center"
          onClick={(e) => e.stopPropagation()} // prevent double-open from container onClick
        >
          <span className="text-sm text-muted-foreground">or</span>
          {/* The single labeled keyboard/touch control — gate-res B3+B4 */}
          <button
            type="button"
            onClick={openPicker}
            className={cn(
              "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 text-sm font-medium text-foreground",
              "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              "active:scale-[0.97] motion-reduce:active:scale-100",
              "[@media(hover:hover)]:hover:bg-secondary",
              "sm:w-auto",
            )}
          >
            Browse files
          </button>
        </div>
      )}

      {/* Hint / error — replaces hint on fileError */}
      {isError && fileError ? (
        <p role="alert" className="text-sm text-destructive">
          {FILE_ERROR_COPY[fileError]}
        </p>
      ) : (
        !isDrag && (
          <p className="text-sm text-muted-foreground">
            .md or .markdown, up to 2 MB
          </p>
        )
      )}

      {/* Visually hidden file input — aria-hidden + tabIndex=-1 (gate-res B3+B4) */}
      <input
        ref={inputRef}
        type="file"
        accept=".md,.markdown,text/markdown"
        onChange={handleInputChange}
        aria-hidden="true"
        tabIndex={-1}
        className="sr-only"
      />
    </div>
  );
}
