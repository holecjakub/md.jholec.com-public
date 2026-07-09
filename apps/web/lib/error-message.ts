/**
 * Shared client-side helper for reading an API error message out of an unknown
 * JSON body. The server error contract is uniform: `{ error: string }`. Every
 * client fetch wrapper narrows the same shape, so the logic lives here once.
 *
 * Client-only: this must not pull in `next/server` (unlike `./http`), so it
 * stays a standalone module the browser bundles freely.
 */

interface ErrorBody {
  error: string;
}

/** Narrow an unknown JSON body to the API error shape, falling back on mismatch. */
export function readErrorMessage(body: unknown, fallback: string): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as ErrorBody).error === "string"
  ) {
    return (body as ErrorBody).error;
  }
  return fallback;
}
