import { describe, expect, it, vi } from "vitest";
import type { MountedRoomState } from "./syncClient.js";
import { CrdtOperationJournal, type CrdtOperationJournalDeps } from "./crdtOperationJournal.js";
import { CrdtRejectedError } from "./crdtSession.js";

function room(): MountedRoomState {
  return {
    roomId: "room_1",
    serverId: "server_1",
    mountPath: "Shared",
    files: {},
    crdtEnabled: true,
    canPushLocalEdits: true,
    pendingCrdtOperations: []
  };
}

function harness(initialRoom = room(), overrides: Partial<CrdtOperationJournalDeps> = {}) {
  const rooms = new Map([[initialRoom.roomId, initialRoom]]);
  const existingPaths = new Set<string>();
  const sends: Array<{ kind: "create" | "rename"; operationId: string; oldRelativePath?: string; relativePath: string }> = [];
  const deletes: string[] = [];
  const reconciled: string[] = [];
  const persistSnapshots: string[] = [];
  const unsupported = vi.fn();
  let sequence = 0;
  const journal = new CrdtOperationJournal({
    getRoom: (roomId) => rooms.get(roomId),
    persist: async () => {
      persistSnapshots.push(JSON.stringify(initialRoom.pendingCrdtOperations ?? []));
    },
    canReplay: (candidate) => candidate.serverId === "server_1" && candidate.canPushLocalEdits === true,
    pathExists: async (_roomId, relativePath) => existingPaths.has(relativePath),
    create: async (_roomId, relativePath, operationId) => {
      sends.push({ kind: "create", operationId, relativePath });
      return { relativePath };
    },
    rename: async (_roomId, oldRelativePath, relativePath, operationId) => {
      sends.push({ kind: "rename", operationId, oldRelativePath, relativePath });
      return { relativePath };
    },
    resolveCreate: async (_roomId, relativePath) => ({ relativePath }),
    resolveRename: async (_roomId, _oldRelativePath, relativePath) => ({ relativePath }),
    reconcilePath: async (_roomId, relativePath) => {
      reconciled.push(relativePath);
    },
    queueDelete: async (_roomId, relativePath) => {
      deletes.push(relativePath);
    },
    convertToCas: async () => undefined,
    onUnsupported: unsupported,
    onReplayError: vi.fn(),
    createOperationId: () => `op_${++sequence}`,
    now: () => `2026-08-03T00:00:0${sequence}.000Z`,
    ...overrides
  });
  return { journal, initialRoom, existingPaths, sends, deletes, reconciled, persistSnapshots, unsupported };
}

describe("CrdtOperationJournal", () => {
  it("persists an offline create and replays it only after a receipt-capable room snapshot", async () => {
    const h = harness();
    h.existingPaths.add("Offline.md");

    await h.journal.recordCreate("room_1", "Offline.md");
    expect(h.sends).toEqual([]);
    expect(h.initialRoom.pendingCrdtOperations).toEqual([
      expect.objectContaining({ operationId: "op_1", kind: "create", relativePath: "Offline.md" })
    ]);

    h.journal.markSnapshotReady("room_1", true);
    await h.journal.drain("room_1");

    expect(h.sends).toEqual([{ kind: "create", operationId: "op_1", relativePath: "Offline.md" }]);
    expect(h.initialRoom.pendingCrdtOperations).toEqual([]);
    expect(h.persistSnapshots.some((snapshot) => snapshot.includes("attemptedAt"))).toBe(true);
  });

  it("converts an unattempted create to the CAS lane when live editing was disabled", async () => {
    const disabledRoom = room();
    disabledRoom.crdtEnabled = false;
    const convertToCas = vi.fn().mockResolvedValue(undefined);
    const h = harness(disabledRoom, { convertToCas } as never);
    h.existingPaths.add("Offline.md");
    await h.journal.recordCreate("room_1", "Offline.md");

    h.journal.markSnapshotReady("room_1", true);
    await h.journal.drain("room_1");

    expect(convertToCas).toHaveBeenCalledWith(
      "room_1",
      expect.objectContaining({ kind: "create", relativePath: "Offline.md" }),
      { committed: false, relativePath: "Offline.md" }
    );
    expect(disabledRoom.pendingCrdtOperations).toEqual([]);
    expect(h.sends).toEqual([]);
  });

  it("resolves an attempted rename before converting its rebased final path to CAS", async () => {
    const disabledRoom = room();
    disabledRoom.crdtEnabled = false;
    disabledRoom.pendingCrdtOperations = [
      {
        operationId: "op_attempted",
        kind: "rename",
        oldRelativePath: "A.md",
        relativePath: "B.md",
        queuedAt: "2026-08-03T00:00:00.000Z",
        attemptedAt: "2026-08-03T00:00:01.000Z"
      },
      {
        operationId: "op_follower",
        kind: "rename",
        oldRelativePath: "B.md",
        relativePath: "C.md",
        queuedAt: "2026-08-03T00:00:02.000Z"
      }
    ];
    const convertToCas = vi.fn().mockResolvedValue(undefined);
    const resolveRename = vi.fn().mockRejectedValue(
      new CrdtRejectedError("CRDT_DISABLED", "Live editing is turned off for this room.")
    );
    const h = harness(disabledRoom, { convertToCas, resolveRename } as never);
    h.existingPaths.add("C.md");

    h.journal.markSnapshotReady("room_1", true);
    await h.journal.drain("room_1");

    expect(resolveRename).toHaveBeenCalledWith("room_1", "A.md", "B.md", "op_attempted");
    expect(convertToCas).toHaveBeenCalledOnce();
    expect(convertToCas).toHaveBeenCalledWith(
      "room_1",
      expect.objectContaining({ kind: "rename", oldRelativePath: "A.md", relativePath: "C.md" }),
      { committed: false, relativePath: "C.md" }
    );
    expect(disabledRoom.pendingCrdtOperations).toEqual([]);
  });

  it("turns an uncommitted attempted create plus offline rename into one CAS create", async () => {
    const disabledRoom = room();
    disabledRoom.crdtEnabled = false;
    disabledRoom.pendingCrdtOperations = [
      {
        operationId: "op_attempted",
        kind: "create",
        relativePath: "A.md",
        queuedAt: "2026-08-03T00:00:00.000Z",
        attemptedAt: "2026-08-03T00:00:01.000Z"
      },
      {
        operationId: "op_follower",
        kind: "rename",
        oldRelativePath: "A.md",
        relativePath: "B.md",
        queuedAt: "2026-08-03T00:00:02.000Z"
      }
    ];
    const convertToCas = vi.fn().mockResolvedValue(undefined);
    const resolveCreate = vi.fn().mockRejectedValue(
      new CrdtRejectedError("CRDT_DISABLED", "Live editing is turned off for this room.")
    );
    const h = harness(disabledRoom, { convertToCas, resolveCreate });
    h.existingPaths.add("B.md");

    h.journal.markSnapshotReady("room_1", true);
    await h.journal.drain("room_1");

    expect(resolveCreate).toHaveBeenCalledWith("room_1", "A.md", "op_attempted");
    expect(convertToCas).toHaveBeenCalledOnce();
    expect(convertToCas).toHaveBeenCalledWith(
      "room_1",
      expect.objectContaining({ kind: "create", relativePath: "B.md" }),
      { committed: false, relativePath: "B.md" }
    );
    expect(disabledRoom.pendingCrdtOperations).toEqual([]);
  });

  it("rebases an offline rename onto a committed receipt path before moving it to CAS", async () => {
    const disabledRoom = room();
    disabledRoom.crdtEnabled = false;
    disabledRoom.pendingCrdtOperations = [
      {
        operationId: "op_attempted",
        kind: "create",
        relativePath: "A.md",
        queuedAt: "2026-08-03T00:00:00.000Z",
        attemptedAt: "2026-08-03T00:00:01.000Z"
      },
      {
        operationId: "op_follower",
        kind: "rename",
        oldRelativePath: "A.md",
        relativePath: "B.md",
        queuedAt: "2026-08-03T00:00:02.000Z"
      }
    ];
    const convertToCas = vi.fn().mockResolvedValue(undefined);
    const resolveCreate = vi.fn().mockResolvedValue({ relativePath: "A 1.md" });
    const h = harness(disabledRoom, { convertToCas, resolveCreate });
    h.existingPaths.add("B.md");

    h.journal.markSnapshotReady("room_1", true);
    await h.journal.drain("room_1");

    expect(convertToCas).toHaveBeenCalledOnce();
    expect(convertToCas).toHaveBeenCalledWith(
      "room_1",
      expect.objectContaining({ kind: "rename", oldRelativePath: "A 1.md", relativePath: "B.md" }),
      { committed: false, relativePath: "B.md" }
    );
    expect(disabledRoom.pendingCrdtOperations).toEqual([]);
  });

  it("coalesces only unattempted payloads and appends a new operation after the first send", async () => {
    const h = harness();
    h.existingPaths.add("Final.md");
    await h.journal.recordCreate("room_1", "Draft.md");
    await h.journal.recordRename("room_1", "Draft.md", "Final.md");
    expect(h.initialRoom.pendingCrdtOperations).toEqual([
      expect.objectContaining({ operationId: "op_1", kind: "create", relativePath: "Final.md" })
    ]);

    const attempted = room();
    attempted.pendingCrdtOperations = [
      {
        operationId: "op_existing",
        kind: "create",
        relativePath: "Draft.md",
        queuedAt: "2026-08-03T00:00:00.000Z",
        attemptedAt: "2026-08-03T00:00:01.000Z"
      }
    ];
    const afterSend = harness(attempted);
    await afterSend.journal.recordRename("room_1", "Draft.md", "Final.md");
    expect(attempted.pendingCrdtOperations).toEqual([
      expect.objectContaining({ operationId: "op_existing", kind: "create", relativePath: "Draft.md" }),
      expect.objectContaining({ operationId: "op_1", kind: "rename", oldRelativePath: "Draft.md", relativePath: "Final.md" })
    ]);
  });

  it("reduces chained renames and keeps independent operation order", async () => {
    const h = harness();
    await h.journal.recordRename("room_1", "A.md", "B.md");
    await h.journal.recordCreate("room_1", "Independent.md");
    await h.journal.recordRename("room_1", "B.md", "C.md");

    expect(h.initialRoom.pendingCrdtOperations).toEqual([
      expect.objectContaining({ operationId: "op_1", kind: "rename", oldRelativePath: "A.md", relativePath: "C.md" }),
      expect.objectContaining({ operationId: "op_2", kind: "create", relativePath: "Independent.md" })
    ]);
  });

  it("reduces deletes without losing an ambiguous attempted operation", async () => {
    const unattempted = harness();
    await unattempted.journal.recordCreate("room_1", "Gone.md");
    expect(await unattempted.journal.recordDelete("room_1", "Gone.md")).toEqual({ handled: true });
    expect(unattempted.initialRoom.pendingCrdtOperations).toEqual([]);

    const attemptedRoom = room();
    attemptedRoom.pendingCrdtOperations = [
      {
        operationId: "op_attempted",
        kind: "rename",
        oldRelativePath: "Old.md",
        relativePath: "New.md",
        queuedAt: "2026-08-03T00:00:00.000Z",
        attemptedAt: "2026-08-03T00:00:01.000Z"
      }
    ];
    const attempted = harness(attemptedRoom);
    expect(await attempted.journal.recordDelete("room_1", "New.md")).toEqual({ handled: true });
    expect(attemptedRoom.pendingCrdtOperations?.[0]).toMatchObject({ deleteAfterAck: true });
  });

  it("reduces rename deletes back to the server path, including a mixed attempted lineage", async () => {
    const unattempted = harness();
    await unattempted.journal.recordRename("room_1", "A.md", "B.md");
    expect(await unattempted.journal.recordDelete("room_1", "B.md")).toEqual({
      handled: false,
      relativePath: "A.md"
    });
    expect(unattempted.initialRoom.pendingCrdtOperations).toEqual([]);

    const mixedRoom = room();
    mixedRoom.pendingCrdtOperations = [
      {
        operationId: "op_attempted",
        kind: "rename",
        oldRelativePath: "A.md",
        relativePath: "B.md",
        queuedAt: "2026-08-03T00:00:00.000Z",
        attemptedAt: "2026-08-03T00:00:01.000Z"
      }
    ];
    const mixed = harness(mixedRoom);
    await mixed.journal.recordRename("room_1", "B.md", "C.md");
    expect(await mixed.journal.recordDelete("room_1", "C.md")).toEqual({ handled: true });
    expect(mixedRoom.pendingCrdtOperations).toEqual([
      expect.objectContaining({ operationId: "op_attempted", relativePath: "B.md", deleteAfterAck: true })
    ]);

    const ordinary = harness();
    expect(await ordinary.journal.recordDelete("room_1", "Existing.md")).toEqual({
      handled: false,
      relativePath: "Existing.md"
    });
  });

  it("resolves an attempted operation receipt before durably queueing its later delete", async () => {
    const attemptedRoom = room();
    attemptedRoom.pendingCrdtOperations = [
      {
        operationId: "op_attempted_create",
        kind: "create",
        relativePath: "Gone.md",
        queuedAt: "2026-08-03T00:00:00.000Z",
        attemptedAt: "2026-08-03T00:00:01.000Z",
        deleteAfterAck: true
      }
    ];
    const h = harness(attemptedRoom);
    h.journal.markSnapshotReady("room_1", true);
    await h.journal.drain("room_1");

    expect(h.sends).toEqual([{ kind: "create", operationId: "op_attempted_create", relativePath: "Gone.md" }]);
    expect(h.deletes).toEqual(["Gone.md"]);
    expect(attemptedRoom.pendingCrdtOperations).toEqual([]);
  });

  it("queues an attempted rename's delete exactly once", async () => {
    const attemptedRoom = room();
    attemptedRoom.pendingCrdtOperations = [
      {
        operationId: "op_attempted_rename",
        kind: "rename",
        oldRelativePath: "Old.md",
        relativePath: "Gone.md",
        queuedAt: "2026-08-03T00:00:00.000Z",
        attemptedAt: "2026-08-03T00:00:01.000Z",
        deleteAfterAck: true
      }
    ];
    const h = harness(attemptedRoom);

    h.journal.markSnapshotReady("room_1", true);
    await h.journal.drain("room_1");
    h.journal.markSnapshotReady("room_1", true);
    await h.journal.drain("room_1");

    expect(h.sends).toEqual([
      { kind: "rename", operationId: "op_attempted_rename", oldRelativePath: "Old.md", relativePath: "Gone.md" }
    ]);
    expect(h.deletes).toEqual(["Gone.md"]);
  });

  it("retains an attempted operation when the transport disconnects during replay", async () => {
    let rejectSend!: (error: Error) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const h = harness(room(), {
      create: async () => new Promise((_, reject) => {
        rejectSend = reject;
        markStarted();
      })
    });
    h.existingPaths.add("Offline.md");
    await h.journal.recordCreate("room_1", "Offline.md");

    h.journal.markSnapshotReady("room_1", true);
    await started;
    h.journal.markDisconnected();
    rejectSend(new Error("transport closed"));
    await h.journal.drain("room_1");

    expect(h.initialRoom.pendingCrdtOperations).toEqual([
      expect.objectContaining({ operationId: "op_1", relativePath: "Offline.md", attemptedAt: expect.any(String) })
    ]);
  });

  it("keeps the journal intact and warns instead of retrying against an older relay", async () => {
    const h = harness();
    h.existingPaths.add("Offline.md");
    await h.journal.recordCreate("room_1", "Offline.md");

    h.journal.markSnapshotReady("room_1", false);
    await h.journal.drain("room_1");

    expect(h.sends).toEqual([]);
    expect(h.initialRoom.pendingCrdtOperations).toHaveLength(1);
    expect(h.unsupported).toHaveBeenCalledWith("room_1");
  });

  it("shows the older-relay warning only once across reconnects", async () => {
    const h = harness();
    h.existingPaths.add("Offline.md");
    await h.journal.recordCreate("room_1", "Offline.md");

    h.journal.markSnapshotReady("room_1", false);
    await h.journal.drain("room_1");
    h.journal.markDisconnected();
    h.journal.markSnapshotReady("room_1", false);
    await h.journal.drain("room_1");

    expect(h.unsupported).toHaveBeenCalledOnce();
  });

  it("surfaces a terminal local-path error instead of silently dropping the operation", async () => {
    const onReplayError = vi.fn();
    const h = harness(room(), { onReplayError });
    await h.journal.recordCreate("room_1", "Missing.md");

    h.journal.markSnapshotReady("room_1", true);
    await h.journal.drain("room_1");

    expect(onReplayError).toHaveBeenCalledWith(
      "room_1",
      expect.objectContaining({ operationId: "op_1", relativePath: "Missing.md" }),
      expect.objectContaining({ code: "LOCAL_PATH_MISSING" })
    );
    expect(h.initialRoom.pendingCrdtOperations).toHaveLength(1);
  });

  it("replays the same persisted operationId after a restart-style reconstruction", async () => {
    const persisted = room();
    persisted.pendingCrdtOperations = [
      { operationId: "op_persisted", kind: "create", relativePath: "Restart.md", queuedAt: "2026-08-03T00:00:00.000Z" }
    ];
    const h = harness(persisted);
    h.existingPaths.add("Restart.md");

    h.journal.markSnapshotReady("room_1", true);
    await h.journal.drain("room_1");

    expect(h.sends).toEqual([{ kind: "create", operationId: "op_persisted", relativePath: "Restart.md" }]);
  });

  it("makes an explicitly rejected payload editable again under a fresh operation ID", async () => {
    const rejected = new CrdtRejectedError("FILE_EXISTS", "That path already exists.");
    const pendingRoom = room();
    pendingRoom.pendingCrdtOperations = [
      {
        operationId: "op_rejected",
        kind: "rename",
        oldRelativePath: "Old.md",
        relativePath: "Taken.md",
        queuedAt: "2026-08-03T00:00:00.000Z",
        attemptedAt: "2026-08-03T00:00:01.000Z"
      }
    ];
    const h = harness(pendingRoom, { rename: async () => Promise.reject(rejected) });
    h.existingPaths.add("Taken.md");

    h.journal.markSnapshotReady("room_1", true);
    await h.journal.drain("room_1");

    expect(pendingRoom.pendingCrdtOperations?.[0]).not.toHaveProperty("attemptedAt");

    h.journal.markDisconnected();
    await h.journal.recordRename("room_1", "Taken.md", "Available.md");
    expect(pendingRoom.pendingCrdtOperations).toEqual([
      expect.objectContaining({
        operationId: "op_1",
        kind: "rename",
        oldRelativePath: "Old.md",
        relativePath: "Available.md"
      })
    ]);
  });

  it("quarantines a receipt owned by another device without changing its operation ID", async () => {
    const pendingRoom = room();
    pendingRoom.pendingCrdtOperations = [
      {
        operationId: "op_other_device",
        kind: "create",
        relativePath: "Offline.md",
        queuedAt: "2026-08-03T00:00:00.000Z",
        attemptedAt: "2026-08-03T00:00:01.000Z"
      }
    ];
    const mismatch = new CrdtRejectedError(
      "CRDT_OPERATION_DEVICE_MISMATCH",
      "This operation receipt belongs to another device."
    );
    const h = harness(pendingRoom, { create: async () => Promise.reject(mismatch) });
    h.existingPaths.add("Offline.md");

    h.journal.markSnapshotReady("room_1", true);
    await h.journal.drain("room_1");

    expect(pendingRoom.pendingCrdtOperations).toEqual([
      expect.objectContaining({
        operationId: "op_other_device",
        relativePath: "Offline.md",
        attemptedAt: "2026-08-03T00:00:01.000Z"
      })
    ]);
  });

  it("reconciles disk content only after an attempted create's rename follower reaches its final path", async () => {
    const pendingRoom = room();
    pendingRoom.pendingCrdtOperations = [
      {
        operationId: "op_create",
        kind: "create",
        relativePath: "Draft.md",
        queuedAt: "2026-08-03T00:00:00.000Z",
        attemptedAt: "2026-08-03T00:00:01.000Z"
      },
      {
        operationId: "op_rename",
        kind: "rename",
        oldRelativePath: "Draft.md",
        relativePath: "Final.md",
        queuedAt: "2026-08-03T00:00:02.000Z"
      }
    ];
    const h = harness(pendingRoom);
    h.existingPaths.add("Final.md");

    h.journal.markSnapshotReady("room_1", true);
    await h.journal.drain("room_1");

    expect(h.sends).toEqual([
      { kind: "create", operationId: "op_create", relativePath: "Draft.md" },
      { kind: "rename", operationId: "op_rename", oldRelativePath: "Draft.md", relativePath: "Final.md" }
    ]);
    expect(h.reconciled).toEqual(["Final.md"]);
    expect(pendingRoom.pendingCrdtOperations).toEqual([]);
  });

  it("keeps the receipt identity immutable when a coded local follow-up fails after ACK", async () => {
    const followUpError = Object.assign(new Error("Disk temporarily unavailable."), { code: "EIO" });
    const onReplayError = vi.fn();
    const h = harness(room(), {
      reconcilePath: async () => Promise.reject(followUpError),
      onReplayError
    });
    h.existingPaths.add("Offline.md");
    await h.journal.recordCreate("room_1", "Offline.md");

    h.journal.markSnapshotReady("room_1", true);
    await h.journal.drain("room_1");

    expect(h.initialRoom.pendingCrdtOperations).toEqual([
      expect.objectContaining({ operationId: "op_1", relativePath: "Offline.md", attemptedAt: expect.any(String) })
    ]);
    expect(onReplayError).toHaveBeenCalledWith(
      "room_1",
      expect.objectContaining({ operationId: "op_1" }),
      followUpError
    );
  });

  it("does not rebase a follower before the acknowledged local follow-up succeeds", async () => {
    const followUpError = Object.assign(new Error("Disk temporarily unavailable."), { code: "EIO" });
    let deleteAttempts = 0;
    const pendingRoom = room();
    pendingRoom.pendingCrdtOperations = [
      {
        operationId: "op_create",
        kind: "create",
        relativePath: "Draft.md",
        queuedAt: "2026-08-03T00:00:00.000Z",
        attemptedAt: "2026-08-03T00:00:01.000Z",
        deleteAfterAck: true
      },
      {
        operationId: "op_rename",
        kind: "rename",
        oldRelativePath: "Draft.md",
        relativePath: "Final.md",
        queuedAt: "2026-08-03T00:00:02.000Z"
      }
    ];
    const onReplayError = vi.fn();
    const h = harness(pendingRoom, {
      create: async () => ({ relativePath: "Draft 1.md" }),
      queueDelete: async () => {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw followUpError;
      },
      onReplayError
    });
    h.existingPaths.add("Final.md");

    h.journal.markSnapshotReady("room_1", true);
    await h.journal.drain("room_1");

    expect(pendingRoom.pendingCrdtOperations).toEqual([
      expect.objectContaining({
        operationId: "op_create",
        relativePath: "Draft.md",
        attemptedAt: "2026-08-03T00:00:01.000Z",
        deleteAfterAck: true
      }),
      expect.objectContaining({
        operationId: "op_rename",
        oldRelativePath: "Draft.md",
        relativePath: "Final.md"
      })
    ]);
    expect(onReplayError).toHaveBeenCalledWith(
      "room_1",
      expect.objectContaining({ operationId: "op_create" }),
      followUpError
    );

    h.journal.markSnapshotReady("room_1", true);
    await h.journal.drain("room_1");

    expect(h.sends).toEqual([
      {
        kind: "rename",
        operationId: "op_rename",
        oldRelativePath: "Draft 1.md",
        relativePath: "Final.md"
      }
    ]);
    expect(pendingRoom.pendingCrdtOperations).toEqual([]);
    expect(onReplayError).toHaveBeenCalledOnce();
  });
});
