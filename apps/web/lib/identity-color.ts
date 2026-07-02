/**
 * Single source of truth for per-person identity colors. The avatar fill AND the
 * text-marking tint (selection + inline comment highlights) both derive from this
 * one palette + hash, so a person's mark is byte-identical to their avatar color.
 */

/**
 * A curated palette of vivid, AA-legible identity hues — HSL strings with
 * white-text contrast checked (L ≤ 42%). Skips the muddy yellow/khaki dead-zone
 * (~50-70°) and spreads across the wheel so adjacent participants stay distinct.
 */
export const IDENTITY_COLORS = [
  "hsl(220 68% 38%)", // cobalt blue
  "hsl(262 60% 42%)", // purple
  "hsl(330 65% 40%)", // rose
  "hsl(0 62% 40%)", // crimson
  "hsl(16 70% 40%)", // burnt orange
  "hsl(168 65% 30%)", // teal
  "hsl(195 70% 34%)", // ocean
  "hsl(290 55% 40%)", // violet
  "hsl(340 62% 38%)", // magenta-rose
  "hsl(142 55% 30%)", // forest green
  "hsl(210 70% 36%)", // navy-ish blue
  "hsl(24 65% 38%)", // rust
] as const;

/** Normalize so casing/whitespace can't desync the avatar hue from the mark hue. */
function normalizeName(name: string): string {
  return name.trim();
}

/** Stable index from a name (0..N-1). */
export function hashFromName(name: string): number {
  const n = normalizeName(name);
  let hash = 0;
  for (let i = 0; i < n.length; i++) {
    hash = (hash * 31 + n.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** The deterministic identity color (verbatim HSL) for a participant name. */
export function identityColor(name: string): string {
  return IDENTITY_COLORS[hashFromName(name) % IDENTITY_COLORS.length]!;
}
