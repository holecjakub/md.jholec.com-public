/**
 * Pure state machine for the upload feature.
 * No React imports — unit-testable in isolation.
 */

export interface UploadResult {
  slug: string;
  shareUrl: string; // reviewer link (…#t=)
  ownerUrl: string; // owner link (…#o=)
  /** Read-only agent GET capability URL (`/d/<slug>/agent/<token>`) — fetching it returns visible doc+comments HTML. */
  agentUrl: string;
  expiresAt: string; // ISO timestamptz
}

export type FileError = "wrong-type" | "too-large" | "empty";
export type GateError = "wrong" | "rate-limited" | "network";

export type UploadState =
  | { status: "locked" }
  | { status: "unlock"; pending: boolean; error: GateError | null }
  | { status: "idle" } // dropzone idle (unlocked)
  | { status: "drag" } // dropzone drag-over
  | { status: "fileError"; error: FileError } // dropzone invalid file
  | {
      status: "selected";
      file: File;
      titleError: boolean;
      passwordError: boolean;
    }
  | { status: "uploading"; file: File }
  | { status: "success"; file: File; result: UploadResult }
  | { status: "uploadError"; file: File }; // 4xx/5xx/network on create

export interface UploadPanelState {
  /** True once the gate 200s; persists through RESET so re-upload doesn't re-prompt. */
  gatePassed: boolean;
  view: UploadState;
}

export type UploadEvent =
  | { type: "OPEN_UNLOCK" }
  | { type: "CANCEL_UNLOCK" }
  | { type: "GATE_SUBMIT" }
  | { type: "GATE_OK" }
  | { type: "GATE_FAIL"; error: GateError }
  | { type: "DRAG_ENTER" }
  | { type: "DRAG_LEAVE" }
  | { type: "FILE_REJECTED"; error: FileError }
  | { type: "FILE_ACCEPTED"; file: File }
  | { type: "REMOVE_FILE" }
  | { type: "CONFIRM_INVALID"; titleError: boolean; passwordError: boolean }
  | { type: "CONFIRM_SUBMIT" }
  | { type: "UPLOAD_OK"; result: UploadResult }
  | { type: "UPLOAD_FAIL" }
  | { type: "UPLOAD_LOCKED" }
  | { type: "RETRY_UPLOAD" }
  | { type: "RESET" };

export const initialState: UploadPanelState = {
  gatePassed: false,
  view: { status: "locked" },
};

/** Guard illegal transitions by returning the same state. Never throws. */
export function reducer(
  state: UploadPanelState,
  event: UploadEvent,
): UploadPanelState {
  const { view, gatePassed } = state;

  switch (event.type) {
    case "OPEN_UNLOCK":
      if (view.status !== "locked") return state;
      return {
        ...state,
        view: { status: "unlock", pending: false, error: null },
      };

    case "CANCEL_UNLOCK":
      if (view.status !== "unlock") return state;
      return { ...state, view: { status: "locked" } };

    case "GATE_SUBMIT":
      if (view.status !== "unlock") return state;
      return {
        ...state,
        view: { status: "unlock", pending: true, error: null },
      };

    case "GATE_OK":
      if (view.status !== "unlock") return state;
      return { gatePassed: true, view: { status: "idle" } };

    case "GATE_FAIL":
      if (view.status !== "unlock") return state;
      return {
        ...state,
        view: { status: "unlock", pending: false, error: event.error },
      };

    case "DRAG_ENTER":
      if (view.status !== "idle" && view.status !== "fileError") return state;
      return { ...state, view: { status: "drag" } };

    case "DRAG_LEAVE":
      if (view.status !== "drag") return state;
      return { ...state, view: { status: "idle" } };

    case "FILE_REJECTED": {
      const allowed = ["idle", "drag", "fileError", "selected"];
      if (!allowed.includes(view.status)) return state;
      return { ...state, view: { status: "fileError", error: event.error } };
    }

    case "FILE_ACCEPTED": {
      const allowed = ["idle", "drag", "fileError"];
      if (!allowed.includes(view.status)) return state;
      return {
        ...state,
        view: {
          status: "selected",
          file: event.file,
          titleError: false,
          passwordError: false,
        },
      };
    }

    case "REMOVE_FILE":
      if (view.status !== "selected" && view.status !== "uploadError")
        return state;
      return { ...state, view: { status: "idle" } };

    case "CONFIRM_INVALID":
      if (view.status !== "selected") return state;
      return {
        ...state,
        view: {
          ...view,
          titleError: event.titleError,
          passwordError: event.passwordError,
        },
      };

    case "CONFIRM_SUBMIT":
      if (view.status !== "selected") return state;
      return {
        ...state,
        view: { status: "uploading", file: view.file },
      };

    case "UPLOAD_OK":
      if (view.status !== "uploading") return state;
      return {
        ...state,
        view: { status: "success", file: view.file, result: event.result },
      };

    case "UPLOAD_FAIL":
      if (view.status !== "uploading") return state;
      return { ...state, view: { status: "uploadError", file: view.file } };

    case "UPLOAD_LOCKED":
      if (view.status !== "uploading") return state;
      return {
        gatePassed: false,
        view: { status: "unlock", pending: false, error: null },
      };

    case "RETRY_UPLOAD":
      if (view.status !== "uploadError") return state;
      return { ...state, view: { status: "uploading", file: view.file } };

    case "RESET":
      if (view.status !== "success") return state;
      // gatePassed stays true — no re-prompt
      return { gatePassed, view: { status: "idle" } };

    default:
      return state;
  }
}
