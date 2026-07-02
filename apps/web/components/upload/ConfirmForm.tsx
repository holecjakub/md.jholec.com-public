"use client";

import { useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { deriveTitle } from "./file-validation";
import { FilePreview } from "./FilePreview";
import { PasswordField } from "./PasswordField";
import { UploadConfirmButton } from "./UploadConfirmButton";

interface ConfirmFormProps {
  file: File;
  titleError: boolean;
  passwordError: boolean;
  onSubmit: (data: { title: string; password: string }) => void;
  onRemove: () => void;
  phase: "selected" | "uploading" | "uploadError";
  uploadErrorMessage?: string | null;
  reduce: boolean;
  politeRegionId: string;
}

/**
 * S3 Selected + S4 Uploading + uploadError.
 * Title field (prefilled from filename) + PasswordField + UploadConfirmButton.
 * Client validation: title required, password ≥8.
 * Focus is driven by UploadPanel via DOM queries on the container — no refs here.
 */
export function ConfirmForm({
  file,
  titleError,
  passwordError,
  onSubmit,
  onRemove,
  phase,
  uploadErrorMessage,
  reduce,
  politeRegionId,
}: ConfirmFormProps) {
  const [title, setTitle] = useState(() => deriveTitle(file.name));
  const [password, setPassword] = useState("");
  const [localTitleError, setLocalTitleError] = useState(titleError);
  const [localPasswordError, setLocalPasswordError] = useState(passwordError);
  const [passwordShakeNonce, setPasswordShakeNonce] = useState(0);

  const titleId = useId();
  const titleHelperId = useId();
  const titleErrorId = useId();
  const passwordId = useId();
  const titleRef = useRef<HTMLInputElement>(null);

  const isUploading = phase === "uploading";
  const isError = phase === "uploadError";

  function validate(): boolean {
    const trimmedTitle = title.trim();
    let hasError = false;

    if (!trimmedTitle) {
      setLocalTitleError(true);
      hasError = true;
    } else {
      setLocalTitleError(false);
    }

    if (password.length < 8) {
      setLocalPasswordError(true);
      setPasswordShakeNonce((n) => n + 1);
      hasError = true;
    } else {
      setLocalPasswordError(false);
    }

    if (hasError) {
      // Focus first invalid field
      if (!trimmedTitle) {
        titleRef.current?.focus();
      }
      // PasswordField focuses itself via its own ref on error, driven by shakeNonce
    }

    return !hasError;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isUploading) return;

    if (validate()) {
      onSubmit({ title: title.trim(), password });
    }
  }

  // The UploadConfirmButton's onActivate is used when button is clicked directly
  // (as opposed to form submit). We just call the same validation + submit path.
  function handleButtonActivate() {
    if (isUploading) return;
    if (validate()) {
      onSubmit({ title: title.trim(), password });
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
      {/* File chip */}
      <FilePreview
        file={file}
        onRemove={!isUploading ? onRemove : undefined}
        variant="selected"
        reduce={reduce}
      />

      {/* Upload error message — tabindex=-1 so focus can be moved here by the parent */}
      {isError && uploadErrorMessage && (
        <p
          role="alert"
          tabIndex={-1}
          className="text-sm text-destructive outline-none"
        >
          {uploadErrorMessage}
        </p>
      )}

      {/* Title field */}
      <div
        className={cn(
          "flex flex-col gap-1.5",
          isUploading && "pointer-events-none opacity-60",
        )}
      >
        <label htmlFor={titleId} className="text-sm font-medium text-foreground">
          Title
        </label>
        <input
          ref={titleRef}
          id={titleId}
          type="text"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            if (localTitleError && e.target.value.trim()) {
              setLocalTitleError(false);
            }
          }}
          maxLength={300}
          required
          disabled={isUploading}
          aria-invalid={localTitleError || undefined}
          aria-describedby={localTitleError ? titleErrorId : titleHelperId}
          className={cn(
            "min-h-12 w-full rounded-lg border border-input bg-background px-3.5 text-base text-foreground",
            "outline-none transition-[box-shadow,border-color] placeholder:text-muted-foreground",
            "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50",
            "disabled:opacity-60 aria-invalid:border-destructive",
          )}
        />
        {localTitleError ? (
          <p id={titleErrorId} role="alert" className="text-sm text-destructive">
            Give your document a title.
          </p>
        ) : (
          <p id={titleHelperId} className="text-sm text-muted-foreground">
            Shown to reviewers at the top of the document.
          </p>
        )}
      </div>

      {/* Password field */}
      <div className={cn(isUploading && "pointer-events-none opacity-60")}>
        <PasswordField
          id={passwordId}
          label="Password"
          value={password}
          onChange={(v) => {
            setPassword(v);
            if (localPasswordError && v.length >= 8) {
              setLocalPasswordError(false);
            }
          }}
          autoComplete="new-password"
          helper="Reviewers without the link can use this to open the document."
          error={
            localPasswordError
              ? "Password must be at least 8 characters."
              : null
          }
          shakeNonce={passwordShakeNonce}
        />
      </div>

      {/* Confirm button — gate-res B7 */}
      <UploadConfirmButton
        phase={isUploading ? "uploading" : "idle"}
        onActivate={handleButtonActivate}
        describedById={politeRegionId}
      />
    </form>
  );
}
