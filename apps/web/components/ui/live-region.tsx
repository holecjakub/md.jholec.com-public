"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * A single polite `aria-live` region for the document experience (audit M11,
 * WCAG 4.1.3 Status Messages). Mirrors the upload flow's live-region pattern
 * (see UploadPanel): a visually-hidden `<p aria-live="polite" aria-atomic>` whose
 * text content is swapped to make a screen reader speak a status update, WITHOUT
 * moving focus.
 *
 * Why a hook + context instead of a bare node: the events that need announcing
 * originate in several places — the ActionBar copy buttons ("Link copied"),
 * DocumentView's comment flow (the viewer's own post; throttled realtime
 * arrivals). `useAnnouncer` owns the region node and a stable `announce`
 * function; the owner renders `region` once and provides `announce` through
 * {@link AnnounceContext} so any descendant can call {@link useAnnounce}.
 *
 * Repeat announcements: a screen reader only re-reads on a *content change*, so
 * announcing the same string twice (e.g. copying the link twice) would be
 * silent. `announce` clears the region first, then sets the message on the next
 * frame, so identical consecutive messages still fire.
 */

type Announce = (message: string) => void;

const AnnounceContext = createContext<Announce>(() => {});

/** Announce a polite status message. No-ops safely with no provider mounted. */
export function useAnnounce(): Announce {
  return useContext(AnnounceContext);
}

export interface Announcer {
  /** Stable across renders — safe to pass to memoized children / effect deps. */
  announce: Announce;
  /** The live-region node — render exactly once, anywhere in the subtree. */
  region: ReactNode;
  /** Wrap the subtree so `useAnnounce()` resolves to this announcer. */
  Provider: (props: { children: ReactNode }) => ReactNode;
}

/**
 * Owns one polite live region. The caller renders {@link Announcer.region} once
 * and wraps announcing descendants in {@link Announcer.Provider}; it may also
 * call {@link Announcer.announce} directly (e.g. from an effect).
 */
export function useAnnouncer(): Announcer {
  const [message, setMessage] = useState("");
  const frameRef = useRef<number | null>(null);

  const clearFrame = () => {
    if (frameRef.current === null) return;
    if (typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(frameRef.current);
    } else {
      clearTimeout(frameRef.current);
    }
    frameRef.current = null;
  };

  const announce = useCallback<Announce>((msg) => {
    // Reset to empty, then set on the next frame so a repeated identical message
    // is still a content change the screen reader will read.
    setMessage("");
    clearFrame();
    const schedule =
      typeof requestAnimationFrame !== "undefined"
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 16);
    frameRef.current = schedule(() => {
      frameRef.current = null;
      setMessage(msg);
    }) as unknown as number;
  }, []);

  useEffect(() => clearFrame, []);

  const region = (
    <p aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </p>
  );

  const Provider = useCallback(
    ({ children }: { children: ReactNode }) => (
      <AnnounceContext.Provider value={announce}>{children}</AnnounceContext.Provider>
    ),
    [announce],
  );

  return { announce, region, Provider };
}
