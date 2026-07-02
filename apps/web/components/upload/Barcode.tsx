/**
 * Decorative barcode derived deterministically from a value (the document slug).
 * Adapted from the AnimatedTicket inspiration; re-tokenized (currentColor) and
 * marked aria-hidden — the slug is shown as readable mono text beneath it.
 */
function hashCode(s: string): number {
  return s.split("").reduce((a, b) => {
    const h = (a << 5) - a + b.charCodeAt(0);
    return h & h;
  }, 0);
}

function seededRandom(s: number): number {
  const x = Math.sin(s) * 10000;
  return x - Math.floor(x);
}

export function Barcode({ value }: { value: string }) {
  const seed = hashCode(value);
  const spacing = 1.5;
  const bars = Array.from({ length: 56 }).map((_, i) => ({
    width: seededRandom(seed + i) > 0.7 ? 2.5 : 1.5,
  }));
  const totalWidth =
    bars.reduce((acc, bar) => acc + bar.width + spacing, 0) - spacing;
  const svgWidth = 240;
  const svgHeight = 56;
  let currentX = (svgWidth - totalWidth) / 2;

  return (
    <div className="flex flex-col items-center gap-1.5">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={svgWidth}
        height={svgHeight}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        className="fill-current text-foreground"
        aria-hidden="true"
        focusable="false"
      >
        {bars.map((bar, i) => {
          const x = currentX;
          currentX += bar.width + spacing;
          return <rect key={i} x={x} y="8" width={bar.width} height="40" />;
        })}
      </svg>
      <p className="font-mono text-xs tracking-[0.3em] text-muted-foreground">
        {value}
      </p>
    </div>
  );
}
