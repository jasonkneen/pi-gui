import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject, type MutableRefObject } from "react";
import type { AppView, SelectedTranscriptRecord } from "../desktop-state";
import { VIRTUALIZATION_THRESHOLD } from "../conversation-timeline";

export type SidePanelMode = "changes" | "files";

const TIMELINE_SCROLL_INTENT_WINDOW_MS = 750;

interface TimelineOffBottomState {
  readonly scrollTop: number;
  readonly transcriptMarker: string;
}

interface UseTimelineScrollOptions {
  readonly selectedSessionKey: string;
  readonly activeTranscript: SelectedTranscriptRecord["transcript"];
  readonly isTranscriptLoading: boolean;
  readonly selectedSession: unknown;
  readonly selectedTranscriptForSession: unknown;
  readonly hasSelectedSession: boolean;
  readonly activeView: AppView | undefined;
  readonly sidePanelMode: SidePanelMode | null;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  readonly composerDraft: string;
  readonly timelinePaneRef: MutableRefObject<HTMLDivElement | null>;
}

export function useTimelineScroll({
  selectedSessionKey,
  activeTranscript,
  isTranscriptLoading,
  selectedSession,
  selectedTranscriptForSession,
  hasSelectedSession,
  activeView,
  sidePanelMode,
  composerRef,
  composerDraft,
  timelinePaneRef,
}: UseTimelineScrollOptions) {
  const lastTranscriptMarkerRef = useRef("");
  const pinnedToBottomRef = useRef(true);
  const previousTimelinePaneSizeRef = useRef<{ width: number; height: number } | null>(null);
  const lastTimelineScrollTopBySessionRef = useRef(new Map<string, number>());
  const lastTimelinePinnedBySessionRef = useRef(new Map<string, boolean>());
  const lastTimelineOffBottomStateBySessionRef = useRef(new Map<string, TimelineOffBottomState>());
  const preserveBottomOnNextPaneResizeRef = useRef(false);
  const exactBottomRestoreSessionKeyRef = useRef<string | null>(null);
  const deferredPinnedBottomAlignmentRef = useRef(false);
  const pendingPinnedBottomBehaviorRef = useRef<ScrollBehavior>("auto");
  const bottomAlignmentGenerationRef = useRef(0);
  const offBottomRestoreGenerationRef = useRef(0);
  const restoredTimelineScrollSessionKeyRef = useRef("");
  const protectedTimelineScrollSessionKeysRef = useRef(new Set<string>());
  const timelineScrollSaveGuardRef = useRef<string | null>(null);
  const timelineScrollIntentUntilRef = useRef(0);
  const selectedSessionKeyRef = useRef("");
  const timelinePrevViewRef = useRef<AppView | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [timelinePaneMountVersion, setTimelinePaneMountVersion] = useState(0);
  const [disableTimelineVirtualization, setDisableTimelineVirtualization] = useState(true);

  selectedSessionKeyRef.current = selectedSessionKey;

  const resetExactBottomRestoreState = (nextSessionKey: string | null = null) => {
    exactBottomRestoreSessionKeyRef.current = nextSessionKey;
    deferredPinnedBottomAlignmentRef.current = false;
    pendingPinnedBottomBehaviorRef.current = "auto";
  };
  const clearTimelineOffBottomState = (sessionKey: string) => {
    lastTimelineOffBottomStateBySessionRef.current.delete(sessionKey);
  };
  const hasTimelineOffBottomState = (sessionKey: string) =>
    lastTimelineOffBottomStateBySessionRef.current.has(sessionKey);
  const saveTimelineOffBottomState = (sessionKey: string, pane: HTMLDivElement) => {
    lastTimelineOffBottomStateBySessionRef.current.set(sessionKey, {
      scrollTop: pane.scrollTop,
      transcriptMarker: buildTranscriptChangeMarker(sessionKey, activeTranscript),
    });
  };
  const restoreTimelineOffBottomState = (sessionKey: string, pane: HTMLDivElement) => {
    const savedState = lastTimelineOffBottomStateBySessionRef.current.get(sessionKey);
    if (!savedState) {
      return false;
    }

    pane.scrollTop = savedState.scrollTop;
    return true;
  };
  const cancelPendingTimelineOffBottomRestore = (sessionKey: string) => {
    if (!sessionKey || !protectedTimelineScrollSessionKeysRef.current.has(sessionKey)) {
      return;
    }
    offBottomRestoreGenerationRef.current += 1;
    protectedTimelineScrollSessionKeysRef.current.delete(sessionKey);
  };
  // Two useLayoutEffect cleanups both save timeline scroll on a session switch; they fire in the
  // same commit, so dedupe by session key to run the save (and consume the single-use protection
  // guard) exactly once. Otherwise the second, unguarded save clobbers the saved off-bottom read
  // position.
  const saveTimelineScrollStateOnLeave = (sessionKey: string) => {
    const pane = timelinePaneRef.current;
    if (!pane || !sessionKey) {
      return;
    }
    if (timelineScrollSaveGuardRef.current === sessionKey) {
      return;
    }
    timelineScrollSaveGuardRef.current = sessionKey;
    queueMicrotask(() => {
      if (timelineScrollSaveGuardRef.current === sessionKey) {
        timelineScrollSaveGuardRef.current = null;
      }
    });
    if (protectedTimelineScrollSessionKeysRef.current.has(sessionKey)) {
      protectedTimelineScrollSessionKeysRef.current.delete(sessionKey);
      return;
    }
    const pinned = isNearBottom(pane);
    lastTimelineScrollTopBySessionRef.current.set(sessionKey, pane.scrollTop);
    lastTimelinePinnedBySessionRef.current.set(sessionKey, pinned);
    if (pinned) {
      clearTimelineOffBottomState(sessionKey);
    }
  };

  const scrollTimelineToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const pane = timelinePaneRef.current;
    if (!pane) {
      return;
    }

    if (
      selectedSessionKey &&
      hasTimelineOffBottomState(selectedSessionKey) &&
      !pinnedToBottomRef.current
    ) {
      return;
    }

    const alignmentGeneration = bottomAlignmentGenerationRef.current + 1;
    bottomAlignmentGenerationRef.current = alignmentGeneration;

    const align = (remainingChecks: number) => {
      if (alignmentGeneration !== bottomAlignmentGenerationRef.current) {
        return;
      }
      if (behavior === "auto") {
        pane.scrollTop = pane.scrollHeight;
      } else {
        pane.scrollTo({ top: pane.scrollHeight, behavior });
      }
      pinnedToBottomRef.current = true;
      lastTimelineScrollTopBySessionRef.current.set(selectedSessionKey, pane.scrollTop);
      lastTimelinePinnedBySessionRef.current.set(selectedSessionKey, true);
      clearTimelineOffBottomState(selectedSessionKey);
      setShowJumpToLatest(false);

      if (remainingChecks <= 0) {
        return;
      }

      window.requestAnimationFrame(() => {
        if (alignmentGeneration !== bottomAlignmentGenerationRef.current) {
          return;
        }
        const remaining = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
        if (remaining > 1 || remainingChecks > 1) {
          align(remainingChecks - 1);
        }
      });
    };

    align(6);
  }, [selectedSessionKey]);

  const requestPinnedBottomAlignment = useCallback((
    behavior: ScrollBehavior = "auto",
    options?: { readonly preferExactRestore?: boolean },
  ) => {
    if (
      selectedSessionKey &&
      hasTimelineOffBottomState(selectedSessionKey) &&
      !pinnedToBottomRef.current
    ) {
      return;
    }

    if (exactBottomRestoreSessionKeyRef.current === selectedSessionKey && selectedSessionKey) {
      pendingPinnedBottomBehaviorRef.current = behavior;
      deferredPinnedBottomAlignmentRef.current = true;
      return;
    }

    if (options?.preferExactRestore && selectedSessionKey && activeTranscript.length > VIRTUALIZATION_THRESHOLD) {
      exactBottomRestoreSessionKeyRef.current = selectedSessionKey;
      pendingPinnedBottomBehaviorRef.current = behavior;
      preserveBottomOnNextPaneResizeRef.current = true;
      setDisableTimelineVirtualization(true);
      return;
    }

    scrollTimelineToBottom(behavior);
  }, [activeTranscript.length, scrollTimelineToBottom, selectedSessionKey]);

  const finalizeTimelineVirtualizationDisable = useCallback(() => {
    const pane = timelinePaneRef.current;
    const restoreSessionKey = exactBottomRestoreSessionKeyRef.current;
    if (!pane || activeView !== "threads") {
      resetExactBottomRestoreState();
      setDisableTimelineVirtualization(false);
      return;
    }

    if (restoreSessionKey !== selectedSessionKey || !restoreSessionKey) {
      setDisableTimelineVirtualization(false);
      return;
    }

    const shouldRestoreBottom =
      pinnedToBottomRef.current || preserveBottomOnNextPaneResizeRef.current || deferredPinnedBottomAlignmentRef.current;
    if (!shouldRestoreBottom) {
      resetExactBottomRestoreState();
      setDisableTimelineVirtualization(false);
      return;
    }

    const finishRestore = (remainingChecks: number, stableChecks: number) => {
      window.requestAnimationFrame(() => {
        if (timelinePaneRef.current !== pane || exactBottomRestoreSessionKeyRef.current !== restoreSessionKey) {
          return;
        }

        if (pinnedToBottomRef.current || preserveBottomOnNextPaneResizeRef.current) {
          scrollTimelineToBottom();
        }

        const remaining = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
        const nextStableChecks = remaining <= 16 ? stableChecks + 1 : 0;
        if (remainingChecks <= 1 || nextStableChecks >= 2) {
          const shouldApplyDeferredAlignment = deferredPinnedBottomAlignmentRef.current;
          resetExactBottomRestoreState();
          if (shouldApplyDeferredAlignment) {
            scrollTimelineToBottom();
          }
          preserveBottomOnNextPaneResizeRef.current = false;
          return;
        }

        finishRestore(remainingChecks - 1, nextStableChecks);
      });
    };

    if (pinnedToBottomRef.current || preserveBottomOnNextPaneResizeRef.current) {
      scrollTimelineToBottom();
    }

    window.requestAnimationFrame(() => {
      if (timelinePaneRef.current !== pane || exactBottomRestoreSessionKeyRef.current !== restoreSessionKey) {
        return;
      }
      setDisableTimelineVirtualization(false);
      scrollTimelineToBottom(pendingPinnedBottomBehaviorRef.current);
      pendingPinnedBottomBehaviorRef.current = "auto";
      finishRestore(6, 0);
    });
  }, [scrollTimelineToBottom, selectedSessionKey, activeView]);

  const setTimelinePaneElement = useCallback((node: HTMLDivElement | null) => {
    timelinePaneRef.current = node;
    if (!node) {
      return;
    }

    setTimelinePaneMountVersion((current) => current + 1);

    const savedOffBottomState = lastTimelineOffBottomStateBySessionRef.current.get(selectedSessionKey);
    const savedPinned = lastTimelinePinnedBySessionRef.current.get(selectedSessionKey);
    const savedScrollTop = savedOffBottomState?.scrollTop ?? lastTimelineScrollTopBySessionRef.current.get(selectedSessionKey);

    if (!selectedSessionKey || activeView !== "threads") {
      setDisableTimelineVirtualization(false);
      return;
    }
    if (savedOffBottomState && isTranscriptLoading) {
      setDisableTimelineVirtualization(false);
      return;
    }

    const shouldRestoreBottom =
      !savedOffBottomState &&
      ((savedPinned ?? pinnedToBottomRef.current) || preserveBottomOnNextPaneResizeRef.current);
    if (shouldRestoreBottom) {
      preserveBottomOnNextPaneResizeRef.current = true;
      node.scrollTop = node.scrollHeight;
      window.requestAnimationFrame(() => {
        if (timelinePaneRef.current !== node) {
          return;
        }
        if (pinnedToBottomRef.current || preserveBottomOnNextPaneResizeRef.current) {
          requestPinnedBottomAlignment("auto", { preferExactRestore: true });
        }
      });
      return;
    }

    if (savedScrollTop == null && !savedOffBottomState) {
      setDisableTimelineVirtualization(false);
      return;
    }

    if (savedOffBottomState) {
      restoreTimelineOffBottomState(selectedSessionKey, node);
    } else {
      node.scrollTop = savedScrollTop ?? node.scrollTop;
    }
    const restoredPinned = isNearBottom(node);
    bottomAlignmentGenerationRef.current += 1;
    pinnedToBottomRef.current = restoredPinned;
    resetExactBottomRestoreState();
    lastTimelinePinnedBySessionRef.current.set(selectedSessionKey, restoredPinned);
    if (restoredPinned) {
      clearTimelineOffBottomState(selectedSessionKey);
    }
    window.requestAnimationFrame(() => {
      if (timelinePaneRef.current !== node) {
        return;
      }
      setDisableTimelineVirtualization(false);
    });
  }, [isTranscriptLoading, requestPinnedBottomAlignment, selectedSessionKey, activeView]);

  const schedulePinnedBottomRealignment = useCallback((delayFrames = 0) => {
    const waitForFrames = (remainingFrames: number) => {
      window.requestAnimationFrame(() => {
        if (remainingFrames > 0) {
          waitForFrames(remainingFrames - 1);
          return;
        }
        requestPinnedBottomAlignment("auto", { preferExactRestore: true });
        window.requestAnimationFrame(() => {
          preserveBottomOnNextPaneResizeRef.current = false;
          if (pinnedToBottomRef.current) {
            requestPinnedBottomAlignment("auto", { preferExactRestore: true });
          }
        });
      });
    };

    waitForFrames(delayFrames);
  }, [requestPinnedBottomAlignment]);

  useLayoutEffect(() => {
    const savedOffBottomState = selectedSessionKey
      ? lastTimelineOffBottomStateBySessionRef.current.get(selectedSessionKey)
      : undefined;
    const savedPinned = selectedSessionKey ? lastTimelinePinnedBySessionRef.current.get(selectedSessionKey) : undefined;
    const shouldRestorePinned = !savedOffBottomState
      ? savedPinned ?? true
      : false;
    setShowJumpToLatest(false);
    lastTranscriptMarkerRef.current = "";
    pinnedToBottomRef.current = shouldRestorePinned;
    timelineScrollIntentUntilRef.current = 0;
    previousTimelinePaneSizeRef.current = null;
    preserveBottomOnNextPaneResizeRef.current = false;
    restoredTimelineScrollSessionKeyRef.current = "";
    resetExactBottomRestoreState(shouldRestorePinned ? selectedSessionKey || null : null);
    setDisableTimelineVirtualization(Boolean(selectedSessionKey && shouldRestorePinned));

    return () => {
      saveTimelineScrollStateOnLeave(selectedSessionKey);
    };
  }, [selectedSessionKey]);

  useLayoutEffect(() => {
    if (activeView !== "threads" || !selectedSession || !selectedTranscriptForSession) {
      return;
    }
    if (exactBottomRestoreSessionKeyRef.current !== selectedSessionKey) {
      return;
    }
    if (!pinnedToBottomRef.current && !preserveBottomOnNextPaneResizeRef.current) {
      return;
    }

    scrollTimelineToBottom();
  }, [
    activeTranscript,
    disableTimelineVirtualization,
    scrollTimelineToBottom,
    selectedSession,
    selectedSessionKey,
    selectedTranscriptForSession,
    activeView,
  ]);

  useLayoutEffect(() => {
    const pane = timelinePaneRef.current;
    if (
      !pane ||
      !selectedSessionKey ||
      activeView !== "threads" ||
      isTranscriptLoading ||
      restoredTimelineScrollSessionKeyRef.current === selectedSessionKey
    ) {
      return;
    }

    const savedOffBottomState = lastTimelineOffBottomStateBySessionRef.current.get(selectedSessionKey);
    if (!savedOffBottomState) {
      protectedTimelineScrollSessionKeysRef.current.delete(selectedSessionKey);
      restoredTimelineScrollSessionKeyRef.current = selectedSessionKey;
      return;
    }

    const restoreGeneration = offBottomRestoreGenerationRef.current + 1;
    offBottomRestoreGenerationRef.current = restoreGeneration;
    let shouldSuppressJumpForRestore = true;
    const applyRestore = () => {
      const currentPane = timelinePaneRef.current;
      if (
        offBottomRestoreGenerationRef.current !== restoreGeneration ||
        !currentPane ||
        selectedSessionKeyRef.current !== selectedSessionKey
      ) {
        return;
      }
      if (!restoreTimelineOffBottomState(selectedSessionKey, currentPane)) {
        return;
      }
      const restoredPinned = isNearBottom(currentPane);
      bottomAlignmentGenerationRef.current += 1;
      pinnedToBottomRef.current = restoredPinned;
      preserveBottomOnNextPaneResizeRef.current = false;
      resetExactBottomRestoreState();
      lastTimelineScrollTopBySessionRef.current.set(selectedSessionKey, currentPane.scrollTop);
      lastTimelinePinnedBySessionRef.current.set(selectedSessionKey, restoredPinned);
      if (restoredPinned) {
        clearTimelineOffBottomState(selectedSessionKey);
      }
      if (shouldSuppressJumpForRestore) {
        setShowJumpToLatest(false);
        shouldSuppressJumpForRestore = false;
      }
    };

    applyRestore();
    window.requestAnimationFrame(applyRestore);
    window.setTimeout(applyRestore, 50);
    window.setTimeout(applyRestore, 150);
    window.setTimeout(applyRestore, 300);
    window.setTimeout(applyRestore, 600);
    window.setTimeout(applyRestore, 1_000);
    window.setTimeout(applyRestore, 2_000);
    lastTranscriptMarkerRef.current = savedOffBottomState.transcriptMarker;
    setDisableTimelineVirtualization(false);
    window.setTimeout(() => {
      if (
        offBottomRestoreGenerationRef.current === restoreGeneration &&
        selectedSessionKeyRef.current === selectedSessionKey
      ) {
        protectedTimelineScrollSessionKeysRef.current.delete(selectedSessionKey);
      }
    }, 2_200);
    restoredTimelineScrollSessionKeyRef.current = selectedSessionKey;
  }, [activeTranscript, isTranscriptLoading, selectedSessionKey, activeView]);

  useEffect(() => {
    if (activeView !== "threads") {
      previousTimelinePaneSizeRef.current = null;
      resetExactBottomRestoreState();
      timelinePrevViewRef.current = activeView ?? null;
      return;
    }

    if (timelinePrevViewRef.current !== "threads" && hasSelectedSession) {
      if (pinnedToBottomRef.current || preserveBottomOnNextPaneResizeRef.current) {
        preserveBottomOnNextPaneResizeRef.current = true;
        schedulePinnedBottomRealignment(1);
      }
    }

    timelinePrevViewRef.current = activeView;
  }, [activeView, hasSelectedSession, schedulePinnedBottomRealignment]);

  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!composer) {
      return undefined;
    }

    const pane = timelinePaneRef.current;
    const previousHeight = composer.getBoundingClientRect().height;
    const shouldPreserveBottom = pane
      ? isNearBottom(pane) || pinnedToBottomRef.current || preserveBottomOnNextPaneResizeRef.current
      : pinnedToBottomRef.current || preserveBottomOnNextPaneResizeRef.current;

    composer.style.height = "0px";
    composer.style.height = `${Math.min(composer.scrollHeight, 220)}px`;

    const nextHeight = composer.getBoundingClientRect().height;
    if (Math.abs(nextHeight - previousHeight) >= 1 && shouldPreserveBottom) {
      preserveBottomOnNextPaneResizeRef.current = true;
      requestPinnedBottomAlignment("auto", { preferExactRestore: true });
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          preserveBottomOnNextPaneResizeRef.current = false;
          if (pinnedToBottomRef.current) {
            requestPinnedBottomAlignment("auto", { preferExactRestore: true });
          }
        });
      });
    }
  }, [composerDraft, requestPinnedBottomAlignment, composerRef]);

  useLayoutEffect(() => {
    if (activeView !== "threads" || !selectedSession) {
      return undefined;
    }

    return () => {
      saveTimelineScrollStateOnLeave(selectedSessionKey);
    };
  }, [selectedSession, selectedSessionKey, activeView]);

  useLayoutEffect(() => {
    const pane = timelinePaneRef.current;
    if (!pane || !selectedSession || activeView !== "threads") {
      previousTimelinePaneSizeRef.current = null;
      return undefined;
    }

    const stickToBottomAfterLayoutChange = () => {
      preserveBottomOnNextPaneResizeRef.current = false;
      pinnedToBottomRef.current = true;
      window.requestAnimationFrame(() => {
        requestPinnedBottomAlignment("auto", { preferExactRestore: true });
        window.requestAnimationFrame(() => {
          if (pinnedToBottomRef.current) {
            requestPinnedBottomAlignment("auto", { preferExactRestore: true });
          }
        });
      });
    };

    const updateMeasuredSize = (nextSize: { width: number; height: number }) => {
      const previousSize = previousTimelinePaneSizeRef.current;
      previousTimelinePaneSizeRef.current = nextSize;
      const shouldStickToBottom = preserveBottomOnNextPaneResizeRef.current || pinnedToBottomRef.current;
      const widthChanged = previousSize ? Math.abs(nextSize.width - previousSize.width) >= 1 : false;
      const heightChanged = previousSize ? Math.abs(nextSize.height - previousSize.height) >= 1 : false;
      if (!previousSize || (!widthChanged && !heightChanged) || !shouldStickToBottom) {
        return;
      }

      stickToBottomAfterLayoutChange();
    };

    const paneRect = pane.getBoundingClientRect();
    updateMeasuredSize({ width: paneRect.width, height: paneRect.height });

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      updateMeasuredSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });

    resizeObserver.observe(pane);
    return () => {
      resizeObserver.disconnect();
      previousTimelinePaneSizeRef.current = null;
    };
  }, [requestPinnedBottomAlignment, selectedSessionKey, sidePanelMode, activeView, timelinePaneMountVersion]);

  useEffect(() => {
    const pane = timelinePaneRef.current;
    if (!pane || !selectedSession) {
      return;
    }

    const marker = buildTranscriptChangeMarker(selectedSessionKey, activeTranscript);
    if (marker === lastTranscriptMarkerRef.current) {
      return;
    }
    lastTranscriptMarkerRef.current = marker;

    if (pinnedToBottomRef.current) {
      requestPinnedBottomAlignment("auto", { preferExactRestore: true });
      return;
    }

    setShowJumpToLatest(true);
  }, [activeTranscript, requestPinnedBottomAlignment, selectedSession, selectedSessionKey]);

  const handleTimelineContentHeightChange = useCallback((state?: { readonly wasAtBottom: boolean }) => {
    if (state?.wasAtBottom) {
      pinnedToBottomRef.current = true;
    }
    if (!pinnedToBottomRef.current && !preserveBottomOnNextPaneResizeRef.current) {
      return;
    }

    window.requestAnimationFrame(() => {
      if (!pinnedToBottomRef.current && !preserveBottomOnNextPaneResizeRef.current) {
        return;
      }
      requestPinnedBottomAlignment("auto", { preferExactRestore: true });
    });
  }, [requestPinnedBottomAlignment]);

  const saveCurrentTimelineScrollState = () => {
    const pane = timelinePaneRef.current;
    if (!pane || !selectedSessionKey) {
      return;
    }
    const pinned = isNearBottom(pane);
    lastTimelineScrollTopBySessionRef.current.set(selectedSessionKey, pane.scrollTop);
    lastTimelinePinnedBySessionRef.current.set(selectedSessionKey, pinned);
    if (pinned) {
      clearTimelineOffBottomState(selectedSessionKey);
    } else {
      preserveBottomOnNextPaneResizeRef.current = false;
      resetExactBottomRestoreState();
      bottomAlignmentGenerationRef.current += 1;
      saveTimelineOffBottomState(selectedSessionKey, pane);
      protectedTimelineScrollSessionKeysRef.current.add(selectedSessionKey);
    }
  };

  const handleTimelineScroll = () => {
    const pane = timelinePaneRef.current;
    if (!pane) {
      return;
    }

    const pinned = isNearBottom(pane);
    const hasRecentScrollIntent = window.performance.now() <= timelineScrollIntentUntilRef.current;
    if (
      !pinned &&
      !hasRecentScrollIntent &&
      (pinnedToBottomRef.current ||
        preserveBottomOnNextPaneResizeRef.current ||
        exactBottomRestoreSessionKeyRef.current === selectedSessionKey ||
        deferredPinnedBottomAlignmentRef.current)
    ) {
      pinnedToBottomRef.current = true;
      preserveBottomOnNextPaneResizeRef.current = true;
      lastTimelinePinnedBySessionRef.current.set(selectedSessionKey, true);
      clearTimelineOffBottomState(selectedSessionKey);
      setShowJumpToLatest(false);
      requestPinnedBottomAlignment("auto", { preferExactRestore: true });
      return;
    }

    if (!pinned) {
      preserveBottomOnNextPaneResizeRef.current = false;
      resetExactBottomRestoreState();
      bottomAlignmentGenerationRef.current += 1;
    }

    pinnedToBottomRef.current = pinned;
    lastTimelineScrollTopBySessionRef.current.set(selectedSessionKey, pane.scrollTop);
    lastTimelinePinnedBySessionRef.current.set(selectedSessionKey, pinned);
    if (pinned) {
      clearTimelineOffBottomState(selectedSessionKey);
    } else if (selectedSessionKey) {
      saveTimelineOffBottomState(selectedSessionKey, pane);
    }
    if (pinned) {
      setShowJumpToLatest(false);
    }
  };

  const handleTimelineScrollIntent = () => {
    timelineScrollIntentUntilRef.current = window.performance.now() + TIMELINE_SCROLL_INTENT_WINDOW_MS;
    cancelPendingTimelineOffBottomRestore(selectedSessionKey);
  };

  const jumpToLatest = () => {
    cancelPendingTimelineOffBottomRestore(selectedSessionKey);
    if (selectedSessionKey) {
      clearTimelineOffBottomState(selectedSessionKey);
    }
    pinnedToBottomRef.current = true;
    requestPinnedBottomAlignment("smooth", { preferExactRestore: true });
  };

  // Capture the current pinned state before a layout change (e.g. toggling a side panel) so the
  // caller can restore the bottom-pinned position after the resize settles.
  const beginPreserveTimelineBottom = useCallback((): boolean => {
    const pane = timelinePaneRef.current;
    const shouldPreserveBottom = pane ? isNearBottom(pane) || pinnedToBottomRef.current : pinnedToBottomRef.current;
    if (shouldPreserveBottom) {
      preserveBottomOnNextPaneResizeRef.current = true;
    }
    return shouldPreserveBottom;
  }, [timelinePaneRef]);

  return {
    setTimelinePaneElement,
    disableTimelineVirtualization,
    finalizeTimelineVirtualizationDisable,
    handleTimelineScroll,
    handleTimelineScrollIntent,
    handleTimelineContentHeightChange,
    showJumpToLatest,
    jumpToLatest,
    saveCurrentTimelineScrollState,
    beginPreserveTimelineBottom,
    schedulePinnedBottomRealignment,
  };
}

function buildTranscriptChangeMarker(sessionKey: string, transcript: SelectedTranscriptRecord["transcript"]): string {
  const lastItem = transcript.at(-1);
  return `${sessionKey}:${transcript.length}:${lastItem ? JSON.stringify(lastItem) : ""}`;
}

function isNearBottom(element: HTMLDivElement): boolean {
  const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
  return remaining < 32;
}
