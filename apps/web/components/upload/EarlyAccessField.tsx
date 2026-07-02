"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { TestersOnlyPill } from "./TestersOnlyPill";
import type { GateError } from "./upload-machine";

interface EarlyAccessFieldProps {
  pending: boolean;
  error: GateError | null;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

const ERROR_COPY: Record<GateError, string> = {
  wrong: "That password is not right. Check it and try again.",
  "rate-limited": "Too many attempts. Please wait a moment and try again.",
  network: "Something went wrong. Please try again.",
};

/**
 * S1u — Early access unlock card.
 * Inline card (no modal); modeled on #05.
 * Gate-res: h2 "Early access" + TestersOnlyPill beside it.
 * Esc → onCancel. Enter submits. Wrong → clear + refocus + shake.
 */
export function EarlyAccessField({
  pending,
  error,
  onSubmit,
  onCancel,
}: EarlyAccessFieldProps) {
  const [password, setPassword] = useState("");
  const [shakeNonce, setShakeNonce] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputWrapperRef = useRef<HTMLDivElement>(null);
  const submittingRef = useRef(false);

  const inputId = useId();
  const errorId = useId();

  // When the error becomes "wrong", clear the field, refocus, and shake.
  const prevError = useRef<GateError | null>(null);
  useEffect(() => {
    if (error === "wrong" && prevError.current !== "wrong") {
      setPassword("");
      setShakeNonce((n) => n + 1);
      inputRef.current?.focus();
    }
    prevError.current = error;
  }, [error]);

  // Shake effect (same restart trick as Gate.tsx)
  useEffect(() => {
    if (!shakeNonce) return;
    const input = inputRef.current;
    const wrapper = inputWrapperRef.current;
    if (!input) return;

    input.classList.remove("is-shaking");
    void input.offsetWidth;
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

  // Esc → cancel
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submittingRef.current || pending) return;
    if (!password) return;
    submittingRef.current = true;
    onSubmit(password);
    // Reset the guard after a tick so React can re-render
    setTimeout(() => {
      submittingRef.current = false;
    }, 0);
  }

  const hasError = error !== null;

  return (
    <div className="mx-auto w-full max-w-sm rounded-xl border border-border bg-card p-6 text-card-foreground shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.12)]">
      <form
        onSubmit={handleSubmit}
        onKeyDown={handleKeyDown}
        noValidate
        className="flex flex-col gap-5"
      >
        {/* Heading row: h2 + Testers only pill */}
        <div className="flex flex-wrap items-center gap-2">
          <h2
            id="upload-heading"
            className="text-lg font-semibold text-foreground"
          >
            Early access
          </h2>
          <TestersOnlyPill />
        </div>

        {/* Helper — carries the early-access / testers-only context that the
            landing page deliberately leaves out. */}
        <p className="text-pretty text-sm text-muted-foreground">
          Upload is in early access — testers only for now. Enter the access
          password to continue. Your file is hosted for 30 days on jholec.com,
          then automatically deleted.
        </p>

        {/* Password field */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={inputId}
            className="text-sm font-medium text-foreground"
          >
            Access password
          </label>
          <div ref={inputWrapperRef}>
            <input
              ref={inputRef}
              id={inputId}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              required
              disabled={pending}
              aria-invalid={hasError || undefined}
              aria-describedby={hasError ? errorId : undefined}
              className={cn(
                "t-input",
                "min-h-12 w-full rounded-lg border border-input bg-background px-3.5 text-base text-foreground",
                "outline-none transition-[box-shadow,border-color] placeholder:text-muted-foreground",
                "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50",
                "disabled:opacity-60 aria-invalid:border-destructive",
              )}
            />
          </div>
          {hasError && error ? (
            <p id={errorId} role="alert" className="text-sm text-destructive">
              {ERROR_COPY[error]}
            </p>
          ) : null}
        </div>

        {/* Primary button — HTML disabled is acceptable here per gate-res B7 note */}
        <button
          type="submit"
          disabled={pending}
          className={cn(
            "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-base font-medium text-primary-foreground",
            "transition-[background-color,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            "disabled:cursor-not-allowed disabled:opacity-60",
            "[@media(hover:hover)]:hover:bg-primary/90",
          )}
        >
          {pending ? (
            <>
              <Loader2
                className="size-4 motion-safe:animate-spin"
                aria-hidden="true"
              />
              Checking…
            </>
          ) : (
            "Unlock upload"
          )}
        </button>

        {/* Quiet cancel link */}
        <button
          type="button"
          onClick={onCancel}
          className="text-center text-sm text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background [@media(hover:hover)]:hover:text-foreground"
        >
          Cancel
        </button>
      </form>
    </div>
  );
}
