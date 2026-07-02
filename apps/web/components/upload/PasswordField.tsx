"use client";

import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";

interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  helper?: string;
  error?: string | null;
  describedById?: string;
  /** Bumped by the parent on a wrong-password result to (re)trigger the shake. */
  shakeNonce?: number;
}

/**
 * Labelled password input with show/hide toggle.
 * Reuses the t-input + shake mechanism from Gate.tsx's Field component.
 * Gate-res B2: toggle with aria-pressed, aria-label, ≥48px target.
 */
export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  helper,
  error,
  describedById,
  shakeNonce,
}: PasswordFieldProps) {
  const [shown, setShown] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Gate-res B2: shake on nonce bump (same restart trick as Gate.tsx Field)
  useEffect(() => {
    if (!shakeNonce) return;
    const input = inputRef.current;
    const wrapper = wrapperRef.current;
    if (!input) return;

    input.classList.remove("is-shaking");
    void input.offsetWidth; // force reflow to restart animation
    input.classList.add("is-shaking");
    wrapper?.classList.add("is-error");

    const onEnd = () => input.classList.remove("is-shaking");
    input.addEventListener("animationend", onEnd, { once: true });

    const revert = window.setTimeout(() => {
      wrapper?.classList.remove("is-error");
    }, 3000);

    return () => {
      input.removeEventListener("animationend", onEnd);
      window.clearTimeout(revert);
    };
  }, [shakeNonce]);

  const helperId = describedById ?? `${id}-helper`;
  const errorId = `${id}-error`;
  const hasError = Boolean(error);

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <div
        ref={wrapperRef}
        className={cn("relative flex items-center", hasError && "is-error")}
      >
        <input
          ref={inputRef}
          id={id}
          type={shown ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          required
          aria-invalid={hasError || undefined}
          aria-describedby={
            [hasError ? errorId : null, helper && !hasError ? helperId : null]
              .filter(Boolean)
              .join(" ") || undefined
          }
          className={cn(
            "t-input",
            "min-h-12 w-full rounded-lg border border-input bg-background px-3.5 pr-12 text-base text-foreground",
            "outline-none transition-[box-shadow,border-color] placeholder:text-muted-foreground",
            "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50",
            "aria-invalid:border-destructive",
          )}
        />
        {/* Show/hide toggle — gate-res B2: aria-pressed, aria-label, ≥48px */}
        <button
          type="button"
          aria-pressed={shown}
          aria-label={shown ? "Hide password" : "Show password"}
          onClick={() => setShown((s) => !s)}
          className="absolute right-0 flex size-12 items-center justify-center rounded-lg text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background [@media(hover:hover)]:hover:text-foreground"
        >
          {shown ? (
            <EyeOff className="size-4" aria-hidden="true" />
          ) : (
            <Eye className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>
      {hasError && error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : helper ? (
        <p id={helperId} className="text-sm text-muted-foreground">
          {helper}
        </p>
      ) : null}
    </div>
  );
}
