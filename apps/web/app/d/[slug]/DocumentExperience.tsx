"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { fetchDocument, redeemToken, type DocPayload } from "@/lib/document-api";
import { Gate } from "@/components/document/Gate";
import { ErrorState, LoadingState } from "@/components/document/states";

// The ready-state experience (react-markdown + highlight + comments layer +
// motion) is by far the heaviest part of this route. Load it lazily so the
// checking/gate/loading phases ship only this small shell — the CSS spinner and
// the gate paint without downloading any of the rendering pipeline. `ssr:
// false` keeps it out of the server HTML too (the doc is fetched client-side
// anyway, since the access token lives in the URL fragment).
const DocumentView = dynamic(
  () =>
    import("@/components/document/DocumentView").then((mod) => mod.DocumentView),
  {
    ssr: false,
    // Same label + centered overlay as the pre-fetch phases, so the loader
    // doesn't jump or flicker while the chunk finishes downloading.
    loading: () => <LoadingState label="Loading document…" />,
  },
);

type Status =
  | { kind: "checking" }
  | { kind: "gate"; hasToken: boolean; token: string | null; fromOwner: boolean }
  | { kind: "loading" }
  | { kind: "ready"; data: DocPayload }
  | { kind: "error"; message: string };

interface StashedToken {
  token: string;
  fromOwner: boolean;
}

/** Parse an invite (#t=) or owner (#o=) token from a URL fragment string. */
function parseFragmentToken(hash: string): StashedToken | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const invite = params.get("t");
  if (invite) return { token: invite, fromOwner: false };
  const owner = params.get("o");
  if (owner) return { token: owner, fromOwner: true };
  return null;
}

export function DocumentExperience({ slug }: { slug: string }) {
  const [status, setStatus] = useState<Status>({ kind: "checking" });
  // Token lives only in memory; never in state that could re-render into the URL.
  const tokenRef = useRef<StashedToken | null>(null);
  // Which slug the stashed token belongs to (see the mount effect).
  const tokenSlugRef = useRef(slug);

  // Client-side navigation /d/a → /d/b reuses this component instance, so
  // without a reset the OLD document stays on screen as `ready` under the new
  // URL until the new fetch resolves (audit 3.12). Adjusting state during
  // render (the React-sanctioned reset-on-prop-change pattern) swaps to the
  // loader in the SAME render pass — no frame ever shows A's payload at B's URL.
  const [renderedSlug, setRenderedSlug] = useState(slug);
  if (renderedSlug !== slug) {
    setRenderedSlug(slug);
    setStatus({ kind: "checking" });
  }

  // Resolve the current session into the next Status. Awaits the network call
  // first, so any state transition derived from it happens asynchronously.
  const resolveStatus = useCallback(async (): Promise<Status> => {
    const result = await fetchDocument(slug);
    if (result.status === 200 && result.payload) {
      const payload = result.payload;
      const stashed = tokenRef.current;
      // An OWNER link opened on top of a non-owner (reviewer) session must still open
      // the owner view. Without this, the existing reviewer session short-circuits here
      // and the owner link silently shows reviewer access (the reported bug). Redeem the
      // owner token to UPGRADE the session, reusing the viewer's existing name so it's
      // seamless. We only ever upgrade (reviewer → owner), never downgrade.
      if (stashed?.fromOwner && payload.role !== "owner") {
        const self = payload.participants.find((p) => p.id === payload.participantId);
        if (self?.name) {
          const redeemed = await redeemToken(slug, stashed.token, self.name);
          if (redeemed.ok) {
            tokenRef.current = null;
            const upgraded = await fetchDocument(slug);
            if (upgraded.status === 200 && upgraded.payload) {
              return { kind: "ready", data: upgraded.payload };
            }
          }
        }
        // No reusable name or the redeem failed → let the gate claim owner access.
        return { kind: "gate", hasToken: true, token: stashed.token, fromOwner: true };
      }
      return { kind: "ready", data: payload };
    }
    if (result.status === 401) {
      const stashed = tokenRef.current;
      return {
        kind: "gate",
        hasToken: stashed !== null,
        token: stashed?.token ?? null,
        fromOwner: stashed?.fromOwner ?? false,
      };
    }
    if (result.status === 404) {
      return {
        kind: "error",
        message: "This document does not exist or has been removed.",
      };
    }
    return {
      kind: "error",
      message: result.errorMessage ?? "Something went wrong. Please try again.",
    };
  }, [slug]);

  const loadDocument = useCallback(async () => {
    setStatus(await resolveStatus());
  }, [resolveStatus]);

  // Mount: stash the fragment token, scrub it from the URL BEFORE any network
  // call (so it can't leak via Referer), then check the session. The session
  // check is awaited inside this closure, so the setState that applies its
  // result runs after the network round-trip — never synchronously on mount.
  useEffect(() => {
    let active = true;
    // A token stashed for a PREVIOUS slug must never be offered to another
    // document's gate — drop it when this effect re-runs for a new slug.
    if (tokenSlugRef.current !== slug) {
      tokenSlugRef.current = slug;
      tokenRef.current = null;
    }
    // Stash the fragment token WITHOUT ever clobbering an already-stashed one
    // with null (audit 1.7): React StrictMode double-invokes this effect in dev,
    // and the first pass has already scrubbed the hash — so the second pass
    // parses an empty fragment. Overwriting unconditionally dropped the token
    // and sent every invite/owner link to the password gate.
    const stashed = parseFragmentToken(window.location.hash);
    if (stashed) tokenRef.current = stashed;
    if (window.location.hash) {
      // Drop the fragment from the URL/history whether or not it held a token.
      window.history.replaceState(null, "", window.location.pathname);
    }
    // Warm the heavy document chunk in parallel with the session check, so
    // reaching `ready` doesn't wait on a serial JS download after the fetch.
    void import("@/components/document/DocumentView");
    void (async () => {
      const next = await resolveStatus();
      if (active) setStatus(next);
    })();
    return () => {
      active = false;
    };
  }, [resolveStatus, slug]);

  const handleAuthenticated = useCallback(() => {
    setStatus({ kind: "loading" });
    void loadDocument();
  }, [loadDocument]);

  const handleRetry = useCallback(() => {
    setStatus({ kind: "checking" });
    void loadDocument();
  }, [loadDocument]);

  switch (status.kind) {
    case "checking":
      return <LoadingState label="Opening document…" />;
    case "loading":
      return <LoadingState label="Loading document…" />;
    case "gate":
      return (
        <Gate
          slug={slug}
          hasFragmentToken={status.hasToken}
          tokenFromOwner={status.fromOwner}
          token={status.token}
          onAuthenticated={handleAuthenticated}
          onTokenInvalidated={() => {
            tokenRef.current = null;
          }}
        />
      );
    case "ready":
      // Keyed by slug (audit 3.12): a payload for a DIFFERENT document must
      // remount the whole view, so useComments (and every layer below) starts
      // fresh instead of reconciling doc B's state into doc A's tree.
      return <DocumentView key={slug} data={status.data} />;
    case "error":
      return <ErrorState message={status.message} onRetry={handleRetry} />;
  }
}
