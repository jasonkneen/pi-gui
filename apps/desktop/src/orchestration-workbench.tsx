import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { OrchestrationChildThread } from "./desktop-state";
import { formatRelativeTime } from "./string-utils";

interface OrchestrationWorkbenchProps {
  readonly childrenThreads: readonly OrchestrationChildThread[];
  readonly onSendFollowUp: (childThreadId: string, text: string) => void;
  readonly onSetSupervisionLoop: (childThreadId: string, gate: "continue" | "stop") => void;
  readonly onOpenChild: (child: OrchestrationChildThread) => void;
}

export function OrchestrationWorkbench({
  childrenThreads,
  onSendFollowUp,
  onSetSupervisionLoop,
  onOpenChild,
}: OrchestrationWorkbenchProps) {
  const [followUpDraft, setFollowUpDraft] = useState("");
  const [selectedChildId, setSelectedChildId] = useState("");
  const selectedChild = useMemo(
    () => childrenThreads.find((child) => child.id === selectedChildId) ?? childrenThreads[0],
    [childrenThreads, selectedChildId],
  );

  useEffect(() => {
    if (selectedChild && selectedChild.id !== selectedChildId) {
      setSelectedChildId(selectedChild.id);
      return;
    }
    if (!selectedChild && selectedChildId) {
      setSelectedChildId("");
    }
  }, [selectedChild, selectedChildId]);

  function handleFollowUpSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = followUpDraft.trim();
    if (!text || !selectedChild) {
      return;
    }
    onSendFollowUp(selectedChild.id, text);
    setFollowUpDraft("");
  }

  return (
    <section className="orchestration-panel" data-testid="orchestration-workbench">
      <div className="orchestration-panel__head">
        <div>
          <div className="orchestration-panel__eyebrow">Child runner</div>
          <h2>Child threads</h2>
        </div>
        <span className="orchestration-panel__count">{childrenThreads.length}</span>
      </div>

      <div className="orchestration-child-list" data-testid="child-thread-list">
        {childrenThreads.length === 0 ? (
          <div className="orchestration-empty">No child threads</div>
        ) : (
          childrenThreads.map((child) => (
            <button
              key={child.id}
              className={`orchestration-child-row ${child.id === selectedChild?.id ? "orchestration-child-row--active" : ""}`}
              data-testid="child-thread-row"
              type="button"
              onClick={() => setSelectedChildId(child.id)}
            >
              <span className="orchestration-child-row__top">
                <span className="orchestration-child-row__title">{child.title}</span>
                <span className={`orchestration-status orchestration-status--${child.status}`}>
                  {child.status}
                </span>
              </span>
              <span className="orchestration-child-row__meta">
                {child.supervisionLoop ? `${child.supervisionLoop.gate} gate · ` : ""}
                {formatRelativeTime(child.updatedAt)}
              </span>
              <span className="orchestration-child-row__preview">{child.latestTranscript}</span>
            </button>
          ))
        )}
      </div>

      {selectedChild ? (
        <section className="orchestration-detail" data-testid="child-thread-detail">
          <div className="orchestration-detail__head">
            <h3>{selectedChild.title}</h3>
            <span className={`orchestration-status orchestration-status--${selectedChild.status}`}>
              {selectedChild.status}
            </span>
          </div>
          <button
            className="button orchestration-detail__open"
            data-testid="child-thread-open"
            disabled={!selectedChild.childSessionId}
            type="button"
            onClick={() => onOpenChild(selectedChild)}
          >
            Open thread
          </button>
          {selectedChild.supervisionLoop ? (
            <section className="orchestration-loop" data-testid="child-supervision-loop">
              <div className="orchestration-loop__head">
                <span className={`orchestration-loop__gate orchestration-loop__gate--${selectedChild.supervisionLoop.gate}`}>
                  {selectedChild.supervisionLoop.gate}
                </span>
                <span className="orchestration-loop__status">{selectedChild.supervisionLoop.status}</span>
              </div>
              <div className="orchestration-loop__reason">{selectedChild.supervisionLoop.reason}</div>
              <div className="orchestration-loop__meta">
                Checked {formatRelativeTime(selectedChild.supervisionLoop.lastCheckedAt)}
                {selectedChild.supervisionLoop.nextRunAt
                  ? ` · Next ${formatRelativeTime(selectedChild.supervisionLoop.nextRunAt)}`
                  : ""}
              </div>
              <div className="orchestration-loop__actions">
                <button
                  className="button"
                  disabled={selectedChild.supervisionLoop.gate !== "wake"}
                  type="button"
                  onClick={() => onSetSupervisionLoop(selectedChild.id, "continue")}
                >
                  Continue
                </button>
                <button
                  className="button"
                  disabled={selectedChild.supervisionLoop.gate === "stop"}
                  type="button"
                  onClick={() => onSetSupervisionLoop(selectedChild.id, "stop")}
                >
                  Stop
                </button>
              </div>
            </section>
          ) : null}
          <div className="orchestration-detail__goal">{selectedChild.goal}</div>
          <div className="orchestration-transcript" data-testid="child-thread-transcript">
            {selectedChild.transcript.map((message) => (
              <div key={message.id} className={`orchestration-message orchestration-message--${message.role}`}>
                <div className="orchestration-message__role">{message.role}</div>
                <div className="orchestration-message__text">{message.text}</div>
              </div>
            ))}
          </div>
          <form className="orchestration-follow-up" onSubmit={handleFollowUpSubmit}>
            <textarea
              aria-label="Child thread follow-up"
              data-testid="child-thread-follow-up"
              placeholder="Send follow-up"
              value={followUpDraft}
              onChange={(event) => setFollowUpDraft(event.target.value)}
            />
            <button
              className="button orchestration-follow-up__button"
              disabled={!followUpDraft.trim()}
              type="submit"
            >
              Send
            </button>
          </form>
        </section>
      ) : null}
    </section>
  );
}
