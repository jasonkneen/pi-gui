import { useEffect, useMemo, useState } from "react";
import type { OrchestrationChildThread, OrchestrationEvidenceRecord } from "./desktop-state";
import { formatRelativeTime } from "./string-utils";

interface EvidenceLedgerWorkbenchProps {
  readonly childrenThreads: readonly OrchestrationChildThread[];
}

export function EvidenceLedgerWorkbench({ childrenThreads }: EvidenceLedgerWorkbenchProps) {
  const [selectedChildId, setSelectedChildId] = useState("");
  const selectedChild = useMemo(
    () => childrenThreads.find((child) => child.id === selectedChildId) ?? childrenThreads[0],
    [childrenThreads, selectedChildId],
  );
  const evidence = selectedChild?.evidence ?? [];
  const workerCount = evidence.filter((record) => record.source === "worker-reported").length;
  const acceptedCount = evidence.filter((record) => record.source === "orchestrator-accepted").length;
  const reviewCount = evidence.filter((record) => record.kind === "review_finding" || record.kind === "blocker").length;

  useEffect(() => {
    if (selectedChild && selectedChild.id !== selectedChildId) {
      setSelectedChildId(selectedChild.id);
      return;
    }
    if (!selectedChild && selectedChildId) {
      setSelectedChildId("");
    }
  }, [selectedChild, selectedChildId]);

  return (
    <section className="evidence-ledger" data-testid="evidence-ledger">
      <div className="evidence-ledger__head">
        <div>
          <div className="evidence-ledger__eyebrow">Evidence ledger</div>
          <h2>Review loop</h2>
        </div>
        <span className="orchestration-panel__count">{evidence.length}</span>
      </div>

      <div className="evidence-ledger__summary" aria-label="Evidence summary">
        <Metric label="Worker" value={workerCount} />
        <Metric label="Accepted" value={acceptedCount} />
        <Metric label="Review" value={reviewCount} />
      </div>

      <div className="evidence-ledger__children" data-testid="evidence-child-list">
        {childrenThreads.length === 0 ? (
          <div className="orchestration-empty">No child threads</div>
        ) : (
          childrenThreads.map((child) => (
            <button
              key={child.id}
              className={`evidence-ledger__child ${child.id === selectedChild?.id ? "evidence-ledger__child--active" : ""}`}
              type="button"
              onClick={() => setSelectedChildId(child.id)}
            >
              <span>{child.title}</span>
              <strong>{child.evidence.length}</strong>
            </button>
          ))
        )}
      </div>

      <div className="evidence-ledger__records" data-testid="evidence-records">
        {selectedChild && evidence.length === 0 ? (
          <div className="orchestration-empty">No evidence recorded yet</div>
        ) : null}
        {evidence.map((record) => (
          <EvidenceRecordRow key={record.id} record={record} />
        ))}
      </div>
    </section>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div className="evidence-ledger__metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function EvidenceRecordRow({ record }: { readonly record: OrchestrationEvidenceRecord }) {
  return (
    <article className={`evidence-record evidence-record--${record.status}`} data-testid="evidence-record">
      <div className="evidence-record__top">
        <span className={`evidence-record__source evidence-record__source--${sourceClass(record.source)}`}>
          {sourceLabel(record.source)}
        </span>
        <time>{formatRelativeTime(record.createdAt)}</time>
      </div>
      <h3>{record.title}</h3>
      {record.detail ? <p>{record.detail}</p> : null}
      <div className="evidence-record__meta">
        <span>{record.status}</span>
        {record.severity ? <span>{record.severity}</span> : null}
        {record.command ? <span>{record.command}</span> : null}
        {record.toolName ? <span>{record.toolName}</span> : null}
        {record.git?.branchName ? <span>{record.git.branchName}</span> : null}
        {record.git?.headSha ? <span>{record.git.headSha.slice(0, 8)}</span> : null}
      </div>
    </article>
  );
}

function sourceLabel(source: OrchestrationEvidenceRecord["source"]): string {
  switch (source) {
    case "worker-reported":
      return "Worker-reported";
    case "orchestrator-accepted":
      return "Orchestrator-accepted";
    case "orchestrator-observed":
      return "Orchestrator-observed";
    case "orchestrator-action":
      return "Orchestrator-action";
    case "command":
      return "Command";
    case "review":
      return "Review";
    case "blocker":
      return "Blocker";
  }
}

function sourceClass(source: OrchestrationEvidenceRecord["source"]): string {
  return source.replace(/[^a-z]/g, "-");
}
