"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { haptic } from "@/lib/haptics";

/**
 * Reusable multiline composer: Enter submits, Shift+Enter inserts a newline,
 * IME compositions are respected (no submit mid-composition). Multilingual
 * input is fine — only the leading/trailing whitespace is trimmed for the empty
 * check, the body is sent verbatim.
 *
 * When `renderSendButton` is false the built-in send button is suppressed so
 * the parent can render it inline (e.g. in a shared footer row with emoji strip).
 * Use `onEmptyChange` to let the parent track empty state, and `submitRef` to
 * let the parent call submit() from an external button.
 */
export function CommentComposer({
  placeholder,
  submitLabel,
  onSubmit,
  autoFocus = false,
  compact = false,
  renderSendButton = true,
  onEmptyChange,
  submitRef: externalSubmitRef,
}: {
  placeholder: string;
  submitLabel: string;
  onSubmit: (body: string) => Promise<void>;
  autoFocus?: boolean;
  compact?: boolean;
  /** When true (default) the built-in round send button is rendered. */
  renderSendButton?: boolean;
  /**
   * Called when the empty state changes (true = empty, false = has content).
   * Allows the parent to reactively enable/disable an external send button.
   */
  onEmptyChange?: (isEmpty: boolean) => void;
  /**
   * Mutable ref the parent provides; this component keeps it up to date with
   * the current submit function so the parent can call submitRef.current?.()
   * from an external button.
   */
  submitRef?: React.MutableRefObject<(() => Promise<void>) | null>;
}) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const composingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus on mount WITHOUT scrolling. The native `autoFocus` attribute (and a plain
  // .focus()) scroll the focused field into view — when the selection composer floats
  // near the bottom of the viewport that yanked the whole page. `preventScroll: true`
  // keeps the page exactly where the user selected.
  useLayoutEffect(() => {
    if (autoFocus) textareaRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const submit = useCallback(async () => {
    const body = value.trim();
    if (body.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(value);
      haptic();
      setValue("");
      onEmptyChange?.(true);
    } finally {
      setSubmitting(false);
    }
  }, [value, submitting, onSubmit, onEmptyChange]);

  // Sync the latest submit closure into the external ref after every render
  // so the parent can call it from an external button without stale closures.
  useLayoutEffect(() => {
    if (externalSubmitRef) {
      externalSubmitRef.current = submit;
    }
  }, [externalSubmitRef, submit]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      const wasEmpty = value.trim().length === 0;
      const isNowEmpty = next.trim().length === 0;
      setValue(next);
      if (wasEmpty !== isNowEmpty) {
        onEmptyChange?.(isNowEmpty);
      }
    },
    [value, onEmptyChange],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey && !composingRef.current) {
        e.preventDefault();
        void submit();
      }
    },
    [submit],
  );

  const empty = value.trim().length === 0;

  return (
    <div className={cn("flex flex-col", compact ? "gap-1" : "gap-2")}>
      {/* Borderless auto-growing textarea — the popover frame is the container */}
      <textarea
        ref={textareaRef}
        value={value}
        placeholder={placeholder}
        onChange={handleChange}
        onKeyDown={onKeyDown}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        rows={1}
        className={cn(
          // 16px on mobile prevents iOS Safari's focus auto-zoom (which jerked the
          // viewport when opening a thread to reply); 14px from `md` up.
          "w-full resize-none bg-transparent text-base text-foreground placeholder:text-muted-foreground md:text-sm",
          "min-h-[1.75rem] field-sizing-content",
          "border-none outline-none focus:outline-none focus-visible:outline-none focus-visible:ring-0",
          compact ? "max-h-32" : "max-h-48",
        )}
        aria-label={placeholder}
      />
      {/* Built-in send button — only when renderSendButton=true */}
      {renderSendButton ? (
        <div className="flex items-center justify-end">
          <button
            type="button"
            aria-label={submitLabel}
            onClick={() => void submit()}
            disabled={empty || submitting}
            className={cn(
              // 28px visual circle; the ::before hit extender grows the touch
              // target to 44px (audit M12) without changing the row's layout.
              "relative inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-all before:absolute before:-inset-2",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              empty
                ? "cursor-default text-muted-foreground/40 pointer-events-none"
                : "bg-foreground text-background hover:bg-foreground/80 active:scale-[0.96]",
            )}
          >
            <ArrowUp aria-hidden className="size-4" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

CommentComposer.displayName = "CommentComposer";
