import { useEffect, useRef, useState } from "react";
import type { DesktopAppState } from "../desktop-state";
import type { PiDesktopApi } from "../ipc";

interface UseComposerDraftSyncParams {
  readonly api: PiDesktopApi | undefined;
  readonly snapshot: DesktopAppState | null;
  readonly selectedSessionKey: string;
}

/**
 * Owns the session composer draft: local state mirrored into a ref, hydration from the
 * persisted snapshot (respecting the sync nonce/source), a debounced write-back, and a
 * flush so a pending write lands before the active session changes.
 */
export function useComposerDraftSync(params: UseComposerDraftSyncParams) {
  const { api, snapshot, selectedSessionKey } = params;
  const [composerDraft, setComposerDraft] = useState("");
  const composerDraftRef = useRef("");
  const hydratedComposerSessionKeyRef = useRef("");
  const handledComposerSyncNonceRef = useRef(0);
  const pendingComposerDraftRef = useRef<string | null>(null);
  const composerDraftWriteTimerRef = useRef<number | null>(null);
  const flushComposerDraftRef = useRef<() => void>(() => {});

  composerDraftRef.current = composerDraft;
  const persistedComposerDraft = snapshot?.composerDraft ?? "";

  useEffect(() => {
    if (!snapshot) {
      return;
    }

    if (hydratedComposerSessionKeyRef.current !== selectedSessionKey) {
      hydratedComposerSessionKeyRef.current = selectedSessionKey;
      handledComposerSyncNonceRef.current = snapshot.composerDraftSyncNonce;
      setComposerDraft(snapshot.composerDraft);
      return;
    }

    if (snapshot.composerDraftSyncNonce === handledComposerSyncNonceRef.current) {
      return;
    }

    handledComposerSyncNonceRef.current = snapshot.composerDraftSyncNonce;
    if (snapshot.composerDraftSyncSource === "persist" || snapshot.composerDraftSyncSource === "state") {
      return;
    }

    setComposerDraft(snapshot.composerDraft);
  }, [
    selectedSessionKey,
    snapshot?.composerDraft,
    snapshot?.composerDraftSyncNonce,
    snapshot?.composerDraftSyncSource,
  ]);

  useEffect(() => {
    if (!api || composerDraft === persistedComposerDraft) {
      pendingComposerDraftRef.current = null;
      return undefined;
    }

    pendingComposerDraftRef.current = composerDraft;
    const timeout = window.setTimeout(() => {
      composerDraftWriteTimerRef.current = null;
      pendingComposerDraftRef.current = null;
      void api.updateComposerDraft(composerDraft);
    }, 350);
    composerDraftWriteTimerRef.current = timeout;

    // Only the timer is cancelled here (each keystroke reschedules it); the pending value stays in
    // pendingComposerDraftRef so a session switch can flush it before the active session changes.
    return () => {
      window.clearTimeout(timeout);
      composerDraftWriteTimerRef.current = null;
    };
  }, [api, composerDraft, persistedComposerDraft]);

  useEffect(() => () => flushComposerDraftRef.current(), []);

  const flushComposerDraft = () => {
    if (composerDraftWriteTimerRef.current !== null) {
      window.clearTimeout(composerDraftWriteTimerRef.current);
      composerDraftWriteTimerRef.current = null;
    }
    const pending = pendingComposerDraftRef.current;
    pendingComposerDraftRef.current = null;
    if (pending !== null && api) {
      void api.updateComposerDraft(pending);
    }
  };
  flushComposerDraftRef.current = flushComposerDraft;

  return { composerDraft, setComposerDraft, composerDraftRef, flushComposerDraft };
}
