/**
 * The small, AA-labelled emoji set used by both the selection quick-row and the
 * in-thread reaction row. Each carries an English aria-label.
 */
export interface EmojiOption {
  emoji: string;
  label: string;
}

export const EMOJI_OPTIONS: readonly EmojiOption[] = [
  { emoji: "👍", label: "Looks good" },
  { emoji: "❤️", label: "Love it" },
  { emoji: "🎉", label: "Celebrate" },
  { emoji: "😕", label: "Confused" },
] as const;
