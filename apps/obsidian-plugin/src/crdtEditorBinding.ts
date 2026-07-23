import { Compartment, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import * as Y from "yjs";
import { yCollab } from "y-codemirror.next";
import type { CrdtSessionManager } from "./crdtSession.js";

/**
 * Productionized form of the Phase 0.2 spike (crdtEditorBindingSpike.test.ts): binds a Y.Text to a
 * real CM6 `EditorView` via y-codemirror.next's `yCollab`, with a `Y.UndoManager` scoped to the
 * local peer's own edits (yCollab wires `undoManager.addTrackedOrigin(its own sync config)`
 * automatically on mount - see the spike's Step 2 finding - so remote-applied edits are never eaten
 * by a local undo). Awareness (presence/cursors) is deliberately not wired - that's P2 #2, not this
 * effort (see Phase 0.1's dependency-matrix note that awareness is out of scope here).
 */
export function buildCrdtEditorExtension(ytext: Y.Text, undoManager: Y.UndoManager): Extension {
  return yCollab(ytext, null, { undoManager });
}

export type CrdtEditorTarget = { roomId: string; relativePath: string };

export type CrdtEditorControllerDeps = {
  /** Live accessor rather than a fixed instance - the plugin recreates its CrdtSessionManager
   *  whenever the active server changes (mirrors how VaultSyncEngine/RelayApiClient are also
   *  recreated per connectSyncSocket() call - see main.ts), so this controller (constructed once,
   *  at plugin load) always needs whichever manager is current, not a stale one from a prior
   *  server. Returns undefined when no server is active. */
  getSessionManager: () => CrdtSessionManager | undefined;
  /**
   * Resolves the (roomId, relativePath) a given vault-relative file path maps to, or undefined if
   * it's not inside any currently-mounted CRDT-enabled room's subtree, or isn't CRDT-eligible
   * (`.md`). Folder-scoped by construction (a caller only ever asks about one specific path, never
   * enumerates - CLAUDE.md rule 5).
   */
  resolveCrdtTarget: (vaultPath: string) => CrdtEditorTarget | undefined;
};

/** One entry per currently open markdown editor view that main.ts wants reconciled - see
 *  CrdtEditorController.syncOpenViews. */
export type OpenCrdtEditorView = { vaultPath: string; view: EditorView };

type ViewBinding = {
  target: CrdtEditorTarget;
  /** Resolves once this exact binding attempt has either applied (compartment reconfigured with a
   *  live session) or been superseded (view closed / reconciled onto a different target before the
   *  session finished opening). Lets a concurrent syncOpenViews call see "this view is already bound
   *  or binding to this exact target" via the map entry alone, without needing to await anything -
   *  the entry is written synchronously before the async session-open work starts (see bindView). */
  ready: Promise<void>;
};

function sameTarget(a: CrdtEditorTarget | undefined, b: CrdtEditorTarget | undefined): boolean {
  return a !== undefined && b !== undefined && a.roomId === b.roomId && a.relativePath === b.relativePath;
}

/**
 * Reconciles a shared `Compartment` (registered once, globally, via `Plugin#registerEditorExtension`)
 * across *every currently-open* CRDT-eligible markdown editor view, not just the focused one - so
 * every open pane showing a live CRDT note stays bound to its yCollab session and reflects remote
 * edits immediately, regardless of which pane currently has focus. A `Compartment` slices a
 * *specific* `EditorView`'s own configuration - reconfiguring it for one view's dispatch does not
 * affect any other view sharing the same `Compartment` instance, which is what makes tracking many
 * views against one shared `Compartment` correct and cheap (no per-view Compartment needed).
 *
 * Second-hardware-testing-round item 3: this supersedes the v1 scope note that used to live here
 * ("only actively (re)binds the currently focused editor view... a background pane keeps its last-
 * bound content until refocused"). The underlying Y.Doc/session already received and merged remote
 * updates regardless of focus even in v1 - this class is purely about keeping every open *editor
 * view* refreshed/bound, not just the focused one.
 */
export class CrdtEditorController {
  readonly compartment = new Compartment();
  private readonly bound = new Map<EditorView, ViewBinding>();

  constructor(private readonly deps: CrdtEditorControllerDeps) {}

  /** The extension to pass to `Plugin#registerEditorExtension` - starts empty in every CM6
   *  instance; reconfigured per-view by `syncOpenViews`. */
  extension(): Extension {
    return this.compartment.of([]);
  }

  /**
   * Reconciles the current binding set against `openViews` - every markdown editor view currently
   * open (main.ts resolves this via Obsidian's `Workspace#getLeavesOfType("markdown")`, re-run on
   * `active-leaf-change`/`file-open`/`layout-change` so pane splits, closes, and file switches in
   * *any* pane are all picked up, not just the focused one):
   *  - Binds any view whose file resolves to a CRDT target and isn't already correctly bound.
   *  - Unbinds any previously-bound view that's no longer present in `openViews`, or whose file has
   *    changed away from its previously-bound target.
   *  - Leaves an already-correctly-bound view completely alone: no needless compartment
   *    reconfigure, no new `Y.UndoManager` - so a live editor's undo history and yCollab binding
   *    survive repeated reconcile calls (e.g. a `layout-change` firing for an unrelated pane split).
   *
   * Safe to call repeatedly/concurrently - a bind already in flight for a given view+target is not
   * duplicated (see bindView's synchronous map write before the async session-open work starts).
   */
  async syncOpenViews(openViews: OpenCrdtEditorView[]): Promise<void> {
    const sessionManager = this.deps.getSessionManager();
    const targetsByView = new Map<EditorView, CrdtEditorTarget | undefined>();
    for (const { vaultPath, view } of openViews) {
      // Only resolve against a live session manager - with none available, every view is treated as
      // "not a CRDT target right now" so the loop below unbinds anything currently bound (matching
      // the prior single-view behavior's null-handling when no server/session manager is active).
      targetsByView.set(view, sessionManager ? this.deps.resolveCrdtTarget(vaultPath) : undefined);
    }

    for (const [view, binding] of [...this.bound.entries()]) {
      const target = targetsByView.get(view);
      if (!targetsByView.has(view) || !sameTarget(target, binding.target)) {
        this.unbindView(view);
      }
    }

    if (!sessionManager) {
      return;
    }

    const pending: Array<Promise<void>> = [];
    for (const [view, target] of targetsByView) {
      if (!target) {
        continue;
      }
      const existing = this.bound.get(view);
      if (existing && sameTarget(existing.target, target)) {
        continue; // Already correctly bound - leave it alone (no rebuild, no undo-history reset).
      }
      pending.push(this.bindView(view, target, sessionManager));
    }
    await Promise.all(pending);
  }

  /** Call on plugin unload / whenever the session manager is about to be torn down (e.g.
   *  connectSyncSocket() switching servers), so no view keeps a live binding to a session that's
   *  about to disappear. Tears down every currently-tracked view, not just one. */
  unbindAll(): void {
    for (const view of [...this.bound.keys()]) {
      this.unbindView(view);
    }
  }

  private async bindView(view: EditorView, target: CrdtEditorTarget, sessionManager: CrdtSessionManager): Promise<void> {
    const ready = this.openSessionAndBind(view, target, sessionManager);
    // Written synchronously (before the await inside openSessionAndBind's own call to ensureSession
    // yields control) so a concurrent syncOpenViews call sees this view as already
    // bound/binding-to-this-target and doesn't start a second, redundant bind for it.
    this.bound.set(view, { target, ready });
    await ready;
  }

  private async openSessionAndBind(view: EditorView, target: CrdtEditorTarget, sessionManager: CrdtSessionManager): Promise<void> {
    const session = await sessionManager.ensureSession(target.roomId, target.relativePath);
    const current = this.bound.get(view);
    // Superseded while awaiting: the view was closed, or a later syncOpenViews call already
    // unbound/rebound it onto a different target. Reference equality against the exact target this
    // call started with (not sameTarget's value equality) - only the bindView call that actually owns
    // the current map entry should be allowed to apply its result.
    if (!current || current.target !== target) {
      return;
    }
    sessionManager.bindToEditor(target.roomId, target.relativePath);
    const undoManager = new Y.UndoManager(session.ytext);
    view.dispatch({ effects: this.compartment.reconfigure(buildCrdtEditorExtension(session.ytext, undoManager)) });
  }

  private unbindView(view: EditorView): void {
    const existing = this.bound.get(view);
    this.bound.delete(view);
    if (existing) {
      this.deps.getSessionManager()?.unbindFromEditor(existing.target.roomId, existing.target.relativePath);
    }
    view.dispatch({ effects: this.compartment.reconfigure([]) });
  }
}
