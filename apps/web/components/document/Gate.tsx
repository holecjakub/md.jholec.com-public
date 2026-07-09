"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { authenticate, redeemToken } from "@/lib/document-api";

interface GateProps {
  slug: string;
  /** True when an invite/owner token was found in the URL fragment. */
  hasFragmentToken: boolean;
  /**
   * True when the stashed token was an OWNER (#o=) link, false for a reviewer
   * invite (#t=). Drives the token-rejected copy so we never imply the password
   * fallback restores owner powers — the password only grants reviewer access.
   */
  tokenFromOwner: boolean;
  /** The stashed token (only meaningful when hasFragmentToken is true). */
  token: string | null;
  /** Called after a session is established so the parent can refetch the doc. */
  onAuthenticated: () => void;
  /** Called when an invite token is rejected so the parent can drop it. */
  onTokenInvalidated: () => void;
}

/**
 * The access gate. Token path: name only -> redeem. Manual path: name +
 * password -> auth. Adapted from inspiration 05 (centered card, "Welcome",
 * muted subhead, full-width primary button) onto our tokens, light + dark.
 */
export function Gate({
  slug,
  hasFragmentToken,
  tokenFromOwner,
  token,
  onAuthenticated,
  onTokenInvalidated,
}: GateProps) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Local view of "do we still have a usable token?" — flips to false if the
  // invite is rejected so the user can recover via the password.
  const [tokenUsable, setTokenUsable] = useState(hasFragmentToken);
  // Bumped on each wrong-password result so the password Field re-runs the
  // shake animation (the restart trick lives inside Field, on its own input).
  const [shakeNonce, setShakeNonce] = useState(0);

  const nameId = useId();
  const passwordId = useId();
  const errorId = useId();
  const submittingRef = useRef(false);

  const showPassword = !tokenUsable;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submittingRef.current) return; // Prevent double-submit.

    const trimmedName = name.trim();
    if (!trimmedName) {
      setErrorMessage("Please enter your name.");
      return;
    }
    if (showPassword && !password) {
      setErrorMessage("Please enter the document password.");
      return;
    }

    submittingRef.current = true;
    setPending(true);
    setErrorMessage(null);

    try {
      const result =
        tokenUsable && token
          ? await redeemToken(slug, token, trimmedName)
          : await authenticate(slug, password, trimmedName);

      if (result.ok) {
        onAuthenticated();
        return;
      }

      if (tokenUsable) {
        // Token rejected — fall back to the manual password path. The password
        // grants REVIEWER access only, so an OWNER link must not imply it
        // restores owner powers (M7). Branch the copy on the token kind.
        if (result.status === 401) {
          setErrorMessage(
            tokenFromOwner
              ? "This owner link is no longer valid. You can still enter the document password below to view it as a reviewer, but owner tools won't be available."
              : "This invite link is no longer valid. Enter the document password instead.",
          );
        } else if (result.status === 429) {
          setErrorMessage("Too many attempts. Please wait a moment and try again.");
        } else {
          setErrorMessage(result.errorMessage ?? "Something went wrong. Please try again.");
        }
        setTokenUsable(false);
        onTokenInvalidated();
        return;
      }

      // Manual path errors.
      if (result.status === 401) {
        setErrorMessage("Incorrect password.");
        setPassword("");
        setShakeNonce((n) => n + 1);
      } else if (result.status === 429) {
        setErrorMessage("Too many attempts. Please wait a moment and try again.");
      } else if (result.status === 404) {
        setErrorMessage("This document does not exist or has been removed.");
      } else {
        setErrorMessage(result.errorMessage ?? "Something went wrong. Please try again.");
      }
    } catch {
      setErrorMessage("Network error. Please check your connection and try again.");
    } finally {
      setPending(false);
      submittingRef.current = false;
    }
  }

  return (
    <main className="flex min-h-full flex-1 items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 text-card-foreground shadow-sm sm:p-8">
        {/*
          m2: this gate shows no document title, which reads phishing-adjacent
          ("enter your password" for an unnamed doc). The title is non-secret, so
          we'd like to show "You've been invited to review: {title}". There is no
          cheap PUBLIC lookup today — GET /api/d/[slug] requires an established
          session (it 401s here, which is exactly why we're at the gate). Adding a
          slug→title endpoint that answers UNAUTHENTICATED is a deliberate
          info-exposure decision (RLS + rate-limit) that belongs to the backend
          owner, so it's left as a TODO rather than half-built here.
        */}
        <div className="flex flex-col gap-2 text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            Welcome
          </h1>
          <p className="text-sm text-muted-foreground">
            {showPassword
              ? "Enter your name and the document password to continue."
              : "Enter your name to view this document."}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4" noValidate>
          <Field
            id={nameId}
            label="Name"
            value={name}
            onChange={setName}
            type="text"
            autoComplete="name"
            autoFocus
            maxLength={120}
            disabled={pending}
            invalid={Boolean(errorMessage) && !name.trim()}
            describedBy={errorMessage ? errorId : undefined}
          />

          {showPassword ? (
            <Field
              id={passwordId}
              label="Password"
              value={password}
              onChange={setPassword}
              type="password"
              autoComplete="current-password"
              disabled={pending}
              invalid={Boolean(errorMessage) && !password}
              describedBy={errorMessage ? errorId : undefined}
              shakeNonce={shakeNonce}
            />
          ) : null}

          {errorMessage ? (
            <p
              id={errorId}
              role="alert"
              aria-live="polite"
              className="text-sm text-destructive"
            >
              {errorMessage}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={pending}
            className={cn(
              "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground",
              "transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            )}
          >
            {pending ? (
              <>
                <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
                Verifying…
              </>
            ) : (
              "View document"
            )}
          </button>
        </form>
      </div>
    </main>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type,
  autoComplete,
  autoFocus,
  maxLength,
  disabled,
  invalid,
  describedBy,
  shakeNonce,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type: "text" | "password";
  autoComplete: string;
  autoFocus?: boolean;
  maxLength?: number;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  /** Bumped by the parent on a wrong-password result to (re)trigger the shake. */
  shakeNonce?: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // nonce 0 is the initial mount — nothing to shake yet.
    if (!shakeNonce) return;
    const input = inputRef.current;
    const wrapper = wrapperRef.current;
    if (!input) return;

    // Restart trick: drop the class, force a reflow, re-add it so the same
    // animation re-runs on a repeated wrong attempt.
    input.classList.remove("is-shaking");
    void input.offsetWidth; // force reflow
    input.classList.add("is-shaking");
    wrapper?.classList.add("is-error");

    const onEnd = () => input.classList.remove("is-shaking");
    input.addEventListener("animationend", onEnd, { once: true });

    // Auto-revert the error tint after a hold (matches --revert-hold).
    const revert = window.setTimeout(() => {
      wrapper?.classList.remove("is-error");
    }, 3000);

    return () => {
      input.removeEventListener("animationend", onEnd);
      window.clearTimeout(revert);
    };
  }, [shakeNonce]);

  return (
    <div ref={wrapperRef} className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <input
        ref={inputRef}
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        maxLength={maxLength}
        disabled={disabled}
        required
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={cn(
          "t-input",
          "min-h-12 w-full rounded-xl border border-input bg-background px-3.5 text-base text-foreground",
          "outline-none transition-[box-shadow,border-color] placeholder:text-muted-foreground",
          "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50",
          "disabled:opacity-60 aria-invalid:border-destructive",
        )}
      />
    </div>
  );
}
