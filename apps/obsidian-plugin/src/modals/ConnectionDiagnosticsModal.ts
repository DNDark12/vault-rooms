import { Modal } from "obsidian";
import type { ConnectionDiagnosticsReport, DiagnosticStep } from "../connectionDiagnostics.js";
import type VaultRoomsPlugin from "../main.js";

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
        status.setText(error instanceof Error ? error.message : "Diagnostics failed unexpectedly.");
      }
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderReport(report: ConnectionDiagnosticsReport): void {
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: "vault-rooms-room-meta", text: this.baseUrl });
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
  }
}
