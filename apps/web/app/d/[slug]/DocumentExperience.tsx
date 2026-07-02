"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchDocument, redeemToken, type DocPayload } from "@/lib/document-api";
import { Gate } from "@/components/document/Gate";
import { DocumentView } from "@/components/document/DocumentView";
import { ErrorState, LoadingState } from "@/components/document/states";

type Status =
  | { kind: "checking" }
  | { kind: "gate"; hasToken: boolean; token: string | null }
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
        return { kind: "gate", hasToken: true, token: stashed.token };
      }
      return { kind: "ready", data: payload };
    }
    if (result.status === 401) {
      const stashed = tokenRef.current;
      return {
        kind: "gate",
        hasToken: stashed !== null,
        token: stashed?.token ?? null,
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
    tokenRef.current = parseFragmentToken(window.location.hash);
    // Drop the fragment from the URL/history regardless of whether one was found.
    window.history.replaceState(null, "", window.location.pathname);
    void (async () => {
      const next = await resolveStatus();
      if (active) setStatus(next);
    })();
    return () => {
      active = false;
    };
  }, [resolveStatus]);

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
          token={status.token}
          onAuthenticated={handleAuthenticated}
          onTokenInvalidated={() => {
            tokenRef.current = null;
          }}
        />
      );
    case "ready":
      return <DocumentView data={status.data} />;
    case "error":
      return <ErrorState message={status.message} onRetry={handleRetry} />;
  }
}
