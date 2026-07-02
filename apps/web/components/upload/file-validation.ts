/**
 * Pure file-validation utilities for the upload feature.
 * No React, no DOM imports — unit-testable in isolation.
 */

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB

export type FileError = "wrong-type" | "too-large" | "empty";

/** The set of extensions we accept (lowercase). */
const VALID_EXTENSIONS = new Set([".md", ".markdown"]);

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return "";
  return filename.slice(dot).toLowerCase();
}

/**
 * Validate a single file for upload.
 * Order: type check → empty (0-byte) → size.
 * Returns a FileError discriminant or null on success.
 */
export function validateFile(file: File): FileError | null {
  if (!VALID_EXTENSIONS.has(getExtension(file.name))) {
    return "wrong-type";
  }
  if (file.size === 0) {
    return "empty";
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return "too-large";
  }
  return null;
}

/**
 * Derive a document title from a filename.
 * Strips the last .md / .markdown extension, trims, caps at 300 chars.
 * Falls back to "Untitled document" if the result is empty.
 */
export function deriveTitle(filename: string): string {
  const ext = getExtension(filename);
  let base = filename;
  if (VALID_EXTENSIONS.has(ext)) {
    base = filename.slice(0, filename.length - ext.length);
  }
  const trimmed = base.trim().slice(0, 300);
  return trimmed || "Untitled document";
}

/**
 * Format a byte count to a human-readable string.
 * Uses fixed KB/MB so the output is tabular-nums-friendly.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * From a FileList (multi-drop), return the first .md / .markdown file,
 * or null if none qualifies.
 */
export function pickFirstMarkdown(files: FileList): File | null {
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (file && VALID_EXTENSIONS.has(getExtension(file.name))) {
      return file;
    }
  }
  return null;
}
