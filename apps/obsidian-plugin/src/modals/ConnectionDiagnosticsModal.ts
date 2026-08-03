import { Modal } from "obsidian";
import type { ConnectionDiagnosticsReport, DiagnosticStep } from "../connectionDiagnostics.js";
import type VaultRoomsPlugin from "../main.js";
import { userFacingError } from "../errorMessages.js";
import { PANEL_COPY } from "../views/panelCopy.js";

/** Renders a connection-diagnostics run (see connectionDiagnostics.ts) as a step-by-step
 *  checklist, so "why can't I connect" reads as "this exact step failed, check this" instead of
 *  one opaque error toast. The run starts when the modal opens; the modal owns no logic beyond
 *  presentation. */
export class ConnectionDiagnosticsModal extends Modal {
  constructor(
    plugin: VaultRoomsPlugin,
    private readonly baseUrl: string,
    private readonly run: () => Promise<ConnectionDiagnosticsReport>
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.setTitle("Test connection");
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: "vault-rooms-room-meta", text: this.baseUrl });
    const status = this.contentEl.createDiv({ text: "Running checks…" });
    void this.run().then(
      (report) => this.renderReport(report),
      (error: unknown) => {
        status.setText(userFacingError(error, "Diagnostics failed unexpectedly."));
      }
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderReport(report: ConnectionDiagnosticsReport): void {
    this.contentEl.empty();
    // No address subtitle here: the first check already reports it as its own detail. This modal is the
    // one place the address stays visible, because "the owner's IP changed" is the most common cause of
    // a failed LAN connection and both the user and whoever helps them need to see it.
    const list = this.contentEl.createDiv({ cls: "vault-rooms-diagnostic-list" });
    for (const step of report.steps) {
      this.renderStep(list, step);
    }
    this.contentEl.createDiv({
      cls: `vault-rooms-diagnostic-summary ${report.ok ? "is-ok" : "is-fail"}`,
      text: report.ok
        ? "Connected - everything checks out."
        : "The first failing step above is the thing to fix; later steps were skipped."
    });
  }

  private renderStep(parent: HTMLElement, step: DiagnosticStep): void {
    const row = parent.createDiv({ cls: `vault-rooms-diagnostic-row is-${step.status}` });
    row.createSpan({
      cls: "vault-rooms-diagnostic-mark",
      text: step.status === "pass" ? "✓" : step.status === "fail" ? "✕" : "•"
    });
    const text = row.createDiv({ cls: "vault-rooms-diagnostic-text" });
    text.createDiv({ text: step.label });
    if (step.detail) {
      text.createDiv({ cls: "vault-rooms-room-meta", text: step.detail });
    }
    if (step.evidence) {
      // Behind a disclosure: the raw token is what makes the failure diagnosable, but it is not the
      // sentence a user should have to read first.
      const technical = text.createEl("details", { cls: "vault-rooms-diagnostic-evidence" });
      technical.createEl("summary", { text: PANEL_COPY.diagnostics.technical });
      technical.createDiv({ cls: "vault-rooms-room-meta", text: step.evidence });
    }
  }
}
