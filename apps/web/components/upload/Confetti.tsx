"use client";

import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";

const COLORS = [
  "#0099ff",
  "#22c55e",
  "#eab308",
  "#8b5cf6",
  "#f97316",
  "#ef4444",
];

interface Piece {
  left: number;
  top: number;
  color: string;
  rotate: number;
  dur: number;
  delay: number;
}

/**
 * A brief, celebratory confetti burst rendered over the viewport.
 * Purely decorative: pointer-events-none, aria-hidden, and fully suppressed
 * under prefers-reduced-motion (renders nothing).
 *
 * The random layout is generated in an effect (never during render) so render
 * stays pure; the pieces are computed once on mount.
 *
 * Adapted from the AnimatedTicket inspiration (07-document-uploaded-ticket),
 * re-tokenized and gated for accessibility.
 */
export function Confetti({ pieces = 90 }: { pieces?: number }) {
  const reduce = useReducedMotion();
  const [bits, setBits] = useState<Piece[]>([]);

  useEffect(() => {
    if (reduce) return;
    // Defer to a frame so the setState is asynchronous (not a synchronous
    // cascading render) and Math.random never runs during render.
    const id = requestAnimationFrame(() => {
      setBits(
        Array.from({ length: pieces }, (_, i) => ({
          left: Math.random() * 100,
          top: -12 + Math.random() * 8,
          color: COLORS[i % COLORS.length] as string,
          rotate: Math.random() * 360,
          dur: 2.4 + Math.random() * 2.2,
          delay: Math.random() * 1.2,
        })),
      );
    });
    return () => cancelAnimationFrame(id);
  }, [reduce, pieces]);

  if (reduce || bits.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-0 z-50 overflow-hidden"
      aria-hidden="true"
    >
      <style>{`@keyframes md-confetti-fall{0%{transform:translateY(-12vh) rotate(0deg);opacity:1}100%{transform:translateY(112vh) rotate(720deg);opacity:0}}`}</style>
      {bits.map((b, i) => (
        <span
          key={i}
          className="absolute block h-3 w-1.5 rounded-[1px]"
          style={{
            left: `${b.left}%`,
            top: `${b.top}%`,
            backgroundColor: b.color,
            transform: `rotate(${b.rotate}deg)`,
            animation: `md-confetti-fall ${b.dur}s ${b.delay}s linear forwards`,
          }}
        />
      ))}
    </div>
  );
}
