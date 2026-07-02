"use client";

import {
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import { Upload } from "lucide-react";
import { postEarlyAccess, createDocument } from "@/lib/upload-api";
import type { CreateResult } from "@/lib/upload-api";
import { reducer, initialState } from "./upload-machine";
import type { FileError, GateError } from "./upload-machine";
import { EarlyAccessField } from "./EarlyAccessField";
import { Dropzone } from "./Dropzone";
import { ConfirmForm } from "./ConfirmForm";
import { LinkReveal } from "./LinkReveal";

/**
 * UploadPanel — stateful container for the entire upload module.
 * Owns the reducer, both fetches, all focus moves, and the two live-region nodes.
 *
 * IMPORTANT: Focus moves are driven by state transitions in useEffect,
 * NOT by animation onComplete callbacks (gate-res B1/S6).
 *
 * Architecture note: we use a fixed max-w-2xl throughout (02-ui §11.3 says
 * this is acceptable and simpler) to avoid the width animation edge case.
 */
export function UploadPanel() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [politeMessage, setPoliteMessage] = useState("");
  const [alertMessage, setAlertMessage] = useState("");
  const [uploadErrorMessage, setUploadErrorMessage] = useState<string | null>(
    null,
  );

  const systemReduce = useReducedMotion();
  const reduce = !!systemReduce;

  // IDs for stable live regions
  const politeRegionId = useId();
  const successHeadingId = useId();

  // ─── Refs for focus management (gate-res §4.7) ──────────────────────────
  const lockedButtonRef = useRef<HTMLButtonElement>(null);
  const browseButtonRef = useRef<HTMLButtonElement>(null);
  const successHeadingRef = useRef<HTMLHeadingElement>(null);
  const uploadErrorRef = useRef<HTMLParagraphElement>(null);
  const titleFieldRef = useRef<HTMLInputElement>(null);

  // The EarlyAccess input and EarlyAccess container share a ref via DOM query
  const earlyAccessContainerRef = useRef<HTMLDivElement>(null);
  const dropzoneContainerRef = useRef<HTMLDivElement>(null);
  const confirmContainerRef = useRef<HTMLDivElement>(null);
  const successContainerRef = useRef<HTMLDivElement>(null);

  // Track previous status to decide which ref to focus
  const prevStatus = useRef(state.view.status);

  // ─── Focus management effect (gate-res §4.7, S5, S6) ────────────────────
  useEffect(() => {
    const status = state.view.status;
    const prev = prevStatus.current;
    prevStatus.current = status;

    if (status === prev) return;

    requestAnimationFrame(() => {
      switch (status) {
        case "unlock":
          if (prev === "locked") {
            // OPEN_UNLOCK: focus early-access password field
            const input =
              earlyAccessContainerRef.current?.querySelector<HTMLInputElement>(
                "input[type='password']",
              );
            input?.focus();
          }
          break;

        case "locked":
          if (prev === "unlock") {
            // CANCEL_UNLOCK: focus Locked CTA button
            lockedButtonRef.current?.focus();
          }
          break;

        case "idle":
          if (
            prev === "unlock" ||
            prev === "selected" ||
            prev === "uploadError" ||
            prev === "success"
          ) {
            // GATE_OK, REMOVE_FILE, RESET: focus Browse button
            const btn =
              dropzoneContainerRef.current?.querySelector<HTMLButtonElement>(
                "button[type='button']",
              );
            btn?.focus();
          }
          break;

        case "selected":
          if (
            prev === "idle" ||
            prev === "drag" ||
            prev === "fileError"
          ) {
            // FILE_ACCEPTED: focus Title field
            const input =
              confirmContainerRef.current?.querySelector<HTMLInputElement>(
                "input[type='text']",
              );
            input?.focus();
          }
          break;

        case "success":
          // UPLOAD_OK: focus success h2 (gate-res B1/S6)
          successContainerRef.current
            ?.querySelector<HTMLHeadingElement>("h2[tabindex='-1']")
            ?.focus();
          break;

        case "uploadError":
          // UPLOAD_FAIL: focus inline error
          confirmContainerRef.current
            ?.querySelector<HTMLParagraphElement>("[role='alert'][tabindex='-1']")
            ?.focus();
          break;
      }
    });
  }, [state.view.status]);

  // ─── Gate fetch ──────────────────────────────────────────────────────────
  async function handleGateSubmit(password: string) {
    dispatch({ type: "GATE_SUBMIT" });
    try {
      const { status } = await postEarlyAccess(password);
      if (status === 200) {
        dispatch({ type: "GATE_OK" });
        setPoliteMessage("Upload unlocked.");
      } else if (status === 401) {
        dispatch({ type: "GATE_FAIL", error: "wrong" as GateError });
      } else if (status === 429) {
        dispatch({ type: "GATE_FAIL", error: "rate-limited" as GateError });
      } else {
        dispatch({ type: "GATE_FAIL", error: "network" as GateError });
      }
    } catch {
      dispatch({ type: "GATE_FAIL", error: "network" as GateError });
    }
  }

  // ─── Create document fetch ───────────────────────────────────────────────
  async function runCreateDocument(
    file: File,
    title: string,
    password: string,
  ) {
    setPoliteMessage("Creating your share link…");
    try {
      const { status, result, errorMessage } = await createDocument({
        title,
        content: await file.text(),
        password,
      });

      if (status === 201 && result) {
        dispatch({ type: "UPLOAD_OK", result: result as CreateResult });
        // Deliberately NOT setting politeMessage here —
        // the focus move to the h2 IS the confirmation (gate-res B1).
      } else if (status === 403) {
        dispatch({ type: "UPLOAD_LOCKED" });
      } else {
        let msg = "We couldn't create your link. Please try again.";
        if (status === 413) {
          msg = "That file is too large. Markdown files up to 2 MB are supported.";
        } else if (status === 429) {
          msg = "Too many uploads. Please wait a moment and try again.";
        } else if (errorMessage) {
          msg = errorMessage;
        }
        setUploadErrorMessage(msg);
        setAlertMessage(msg);
        dispatch({ type: "UPLOAD_FAIL" });
      }
    } catch {
      const msg = "We couldn't create your link. Please try again.";
      setUploadErrorMessage(msg);
      setAlertMessage(msg);
      dispatch({ type: "UPLOAD_FAIL" });
    }
  }

  // ─── File accept / reject ────────────────────────────────────────────────
  function handleFileAccepted(file: File) {
    dispatch({ type: "FILE_ACCEPTED", file });
    setPoliteMessage(`${file.name} selected.`);
  }

  function handleFileRejected(error: FileError) {
    dispatch({ type: "FILE_REJECTED", error });
    // Visible role=alert in Dropzone is the primary signal; don't double-announce.
  }

  // ─── Confirm submit ──────────────────────────────────────────────────────
  function handleConfirmSubmit({
    title,
    password,
  }: {
    title: string;
    password: string;
  }) {
    const view = state.view;
    if (view.status !== "selected") return;
    dispatch({ type: "CONFIRM_SUBMIT" });
    void runCreateDocument(view.file, title, password);
  }

  // ─── Drag state ──────────────────────────────────────────────────────────
  function handleDragState(dragging: boolean) {
    dispatch({ type: dragging ? "DRAG_ENTER" : "DRAG_LEAVE" });
  }

  // ─── Copy announcements ──────────────────────────────────────────────────
  function handleCopied(which: "owner" | "reviewer") {
    setPoliteMessage(
      which === "owner" ? "Owner link copied" : "Reviewer link copied",
    );
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  const { view } = state;

  // Smooth enter transition shared by every step. Enter-only (no exit) so the
  // state-driven focus moves in the effect above stay reliable; gated on
  // prefers-reduced-motion (opacity-only, instant).
  const stepMotion = {
    initial: reduce ? { opacity: 0 } : { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: reduce ? 0 : 0.24, ease: [0.2, 0, 0, 1] as const },
  };

  // Suppress unused-import warnings
  void lockedButtonRef;
  void browseButtonRef;
  void successHeadingRef;
  void uploadErrorRef;
  void titleFieldRef;

  return (
    <section
      aria-labelledby="upload-heading"
      className="mx-auto w-full max-w-2xl"
    >
      {/* Gate-res B1: TWO SEPARATE live-region DOM nodes */}
      <p
        id={politeRegionId}
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {politeMessage}
      </p>
      {/* role="alert" is implicitly assertive */}
      <p role="alert" className="sr-only">
        {alertMessage}
      </p>

      {/* ── S0: Locked — landing stays minimal: just the button. The
          testers-only / early-access details live in the password entry. ── */}
      {view.status === "locked" && (
        // No enter animation here: this is the first-paint landing CTA and must
        // be visible without JS / before hydration. Only post-click steps animate.
        <div className="flex flex-col items-center">
          <h2 id="upload-heading" className="sr-only">
            Upload a Markdown file
          </h2>
          <button
            ref={lockedButtonRef}
            type="button"
            onClick={() => dispatch({ type: "OPEN_UNLOCK" })}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-accent-solid px-6 text-base font-medium text-accent-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)] transition-[background-color,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.97] motion-reduce:active:scale-100 [@media(hover:hover)]:hover:bg-accent-solid/90"
          >
            <Upload className="size-4" aria-hidden="true" />
            Upload a file
          </button>
        </div>
      )}

      {/* ── S1u: Unlock ── */}
      {view.status === "unlock" && (
        <motion.div ref={earlyAccessContainerRef} {...stepMotion}>
          <EarlyAccessField
            pending={view.pending}
            error={view.error}
            onSubmit={handleGateSubmit}
            onCancel={() => dispatch({ type: "CANCEL_UNLOCK" })}
          />
        </motion.div>
      )}

      {/* ── S2/S3/S4: Dropzone states ── */}
      {(view.status === "idle" ||
        view.status === "drag" ||
        view.status === "fileError") && (
        <motion.div ref={dropzoneContainerRef} {...stepMotion}>
          <Dropzone
            onAccept={handleFileAccepted}
            onReject={handleFileRejected}
            onDragState={handleDragState}
            state={
              view.status === "drag"
                ? "drag"
                : view.status === "fileError"
                  ? "fileError"
                  : "idle"
            }
            fileError={view.status === "fileError" ? view.error : null}
          />
        </motion.div>
      )}

      {/* ── S3 Selected / S4 Uploading / uploadError ── */}
      {(view.status === "selected" ||
        view.status === "uploading" ||
        view.status === "uploadError") && (
        <motion.div ref={confirmContainerRef} {...stepMotion}>
          <ConfirmForm
            file={view.file}
            titleError={view.status === "selected" ? view.titleError : false}
            passwordError={
              view.status === "selected" ? view.passwordError : false
            }
            onSubmit={handleConfirmSubmit}
            onRemove={() => dispatch({ type: "REMOVE_FILE" })}
            phase={
              view.status === "uploading"
                ? "uploading"
                : view.status === "uploadError"
                  ? "uploadError"
                  : "selected"
            }
            uploadErrorMessage={
              view.status === "uploadError" ? uploadErrorMessage : null
            }
            reduce={reduce}
            politeRegionId={politeRegionId}
          />
        </motion.div>
      )}

      {/* ── Success ── */}
      {view.status === "success" && (
        <div ref={successContainerRef}>
          <LinkReveal
            result={view.result}
            file={view.file}
            reduce={reduce}
            headingId={successHeadingId}
            onCopied={handleCopied}
            onReset={() => dispatch({ type: "RESET" })}
          />
        </div>
      )}
    </section>
  );
}
