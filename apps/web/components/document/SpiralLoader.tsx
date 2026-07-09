import { cn } from "@/lib/utils";

export type SpiralLoaderProps = {
  size?: number;
  className?: string;
};

/**
 * Pure CSS/SVG spinner: a track ring plus a rotating stroke arc, animated with
 * Tailwind's `animate-spin` keyframes. Replaces the previous Lottie spiral —
 * lottie-web cost ~76KB gz of JS to animate a 16–28px glyph, and had to wait
 * for hydration to render at all. This version is ~0KB JS, draws with
 * `currentColor` (so it follows the theme with no dark-mode observer), and
 * renders during SSR so the loading shell paints at first byte, before any
 * JavaScript executes.
 *
 * Reduced motion (M17): a continuous rotation is a vestibular trigger, so under
 * prefers-reduced-motion we drop the spin. But a fully frozen spinner reads as a
 * hang, so we substitute a gentle opacity pulse (`animate-pulse`) — no movement,
 * still clearly "working". This is CSS-only via motion-safe/motion-reduce
 * variants, so it needs no JS media-query observer and stays correct in SSR.
 */
export function SpiralLoader({ size = 16, className }: SpiralLoaderProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      aria-hidden
      className={cn(
        "shrink-0 text-foreground motion-safe:animate-spin motion-reduce:animate-pulse",
        className,
      )}
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2.5"
      />
      <path
        d="M22 12a10 10 0 0 0-10-10"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

SpiralLoader.displayName = "SpiralLoader";
