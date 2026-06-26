import type { OrchestrationChildThread } from "./desktop-state";
import { DiffPanel, type DiffPanelFileRequest, type FileWorkbenchContext } from "./diff-panel";
import { EvidenceLedgerWorkbench } from "./evidence-ledger-workbench";
import type { PiDesktopApi } from "./ipc";
import { OrchestrationWorkbench } from "./orchestration-workbench";
import { PreviewWorkbench } from "./preview-workbench";

export type OrchestratedWorkbenchMode = "children" | "evidence" | "files" | "preview";

interface OrchestratedWorkbenchProps {
  readonly mode: OrchestratedWorkbenchMode;
  readonly childrenThreads: readonly OrchestrationChildThread[];
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly sessionStatus: string | undefined;
  readonly sessionTitle?: string;
  readonly api: PiDesktopApi;
  readonly fileRequest?: DiffPanelFileRequest | null;
  readonly fileContexts: readonly FileWorkbenchContext[];
  readonly onSelectMode: (mode: OrchestratedWorkbenchMode) => void;
  readonly onSendFollowUp: (childThreadId: string, text: string) => void;
  readonly onSetSupervisionLoop: (childThreadId: string, gate: "continue" | "stop") => void;
  readonly onOpenChild: (child: OrchestrationChildThread) => void;
  readonly onAttachPreviewEvidence: (evidence: string) => void;
}

const MODE_LABELS: Readonly<Record<OrchestratedWorkbenchMode, string>> = {
  children: "Workers",
  evidence: "Evidence",
  files: "Files",
  preview: "Preview",
};

export function OrchestratedWorkbench({
  mode,
  childrenThreads,
  workspaceId,
  sessionId,
  sessionStatus,
  sessionTitle,
  api,
  fileRequest,
  fileContexts,
  onSelectMode,
  onSendFollowUp,
  onSetSupervisionLoop,
  onOpenChild,
  onAttachPreviewEvidence,
}: OrchestratedWorkbenchProps) {
  const modeCounts: Readonly<Record<OrchestratedWorkbenchMode, number>> = {
    children: childrenThreads.length,
    evidence: childrenThreads.reduce((count, child) => count + child.evidence.length, 0),
    files: fileContexts.length,
    preview: 0,
  };

  return (
    <aside className="orchestrated-workbench" data-testid="orchestrated-workbench">
      <header className="orchestrated-workbench__header">
        <div>
          <div className="orchestrated-workbench__eyebrow">Orchestrated workbench</div>
          <h2>{sessionTitle ?? "Thread workspace"}</h2>
        </div>
        <nav className="orchestrated-workbench__tabs" aria-label="Workbench modes">
          {(Object.keys(MODE_LABELS) as OrchestratedWorkbenchMode[]).map((candidate) => (
            <button
              key={candidate}
              className={`orchestrated-workbench__tab ${candidate === mode ? "orchestrated-workbench__tab--active" : ""}`}
              data-testid={`workbench-tab-${candidate}`}
              type="button"
              onClick={() => onSelectMode(candidate)}
            >
              <span>{MODE_LABELS[candidate]}</span>
              {modeCounts[candidate] > 0 ? <strong>{modeCounts[candidate]}</strong> : null}
            </button>
          ))}
        </nav>
      </header>
      <div className="orchestrated-workbench__body">
        {mode === "children" ? (
          <OrchestrationWorkbench
            childrenThreads={childrenThreads}
            onSendFollowUp={onSendFollowUp}
            onSetSupervisionLoop={onSetSupervisionLoop}
            onOpenChild={onOpenChild}
          />
        ) : null}
        {mode === "evidence" ? (
          <EvidenceLedgerWorkbench childrenThreads={childrenThreads} />
        ) : null}
        {mode === "files" ? (
          <DiffPanel
            workspaceId={workspaceId}
            sessionId={sessionId}
            api={api}
            sessionStatus={sessionStatus}
            fileRequest={fileRequest}
            contexts={fileContexts}
            onAttachEvidence={(evidence) => {
              onAttachPreviewEvidence(formatWorkbenchEvidence(evidence));
            }}
          />
        ) : null}
        {mode === "preview" ? (
          <PreviewWorkbench
            selectedSessionTitle={sessionTitle}
            onOpenExternal={(url) => {
              void api.openExternal(url);
            }}
            onAttachEvidence={onAttachPreviewEvidence}
          />
        ) : null}
      </div>
    </aside>
  );
}

function formatWorkbenchEvidence(evidence: {
  readonly source: "file";
  readonly title: string;
  readonly detail: string;
}): string {
  return ["Workbench evidence", `- Source: ${evidence.source}`, `- Title: ${evidence.title}`, evidence.detail].join("\n");
}
