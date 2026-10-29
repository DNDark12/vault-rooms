import { fail, SecureError } from "./errors.js";
import { activeDevice, MAX_CLOCK_SKEW_MS, roleAtLeast, roleIn, verifyGenesis, verifyNext, versionHash, type Role, type SignedVersion, type WorkspaceState } from "./workspace.js";

export type OfferResult =
  | { status: "appended"; count: number }
  | { status: "duplicate" }
  /** Our versions from `lost[0].body.v` on were replaced by a winning branch; their authors should re-apply them. */
  | { status: "replaced"; lost: SignedVersion[]; count: number }
  /** We keep our chain: the branch is invalid, loses, or starts after a gap (fetch the missing versions first). */
  | { status: "rejected"; reason: string };

/**
 * A verified workspace chain. Versions only ever come in through `offer`, which verifies each one against its
 * predecessor. When a peer's branch conflicts with ours (two admins changed things at the same time while apart),
 * every peer picks the same winner (`preferBranch`), so everyone converges.
 */
export class WorkspaceChain {
  readonly workspaceId: string;
  private versions: SignedVersion[];
  private hashes: string[];

  constructor(genesis: SignedVersion) {
    this.workspaceId = verifyGenesis(genesis);
    this.versions = [genesis];
    this.hashes = [this.workspaceId];
  }

  /** Rebuild from versions (each is verified again). With `now`, versions dated too far ahead of it are refused. */
  static load(versions: SignedVersion[], now?: number): WorkspaceChain {
    if (versions.length === 0) fail("empty_chain");
    const chain = new WorkspaceChain(versions[0]!);
    const result = chain.offer(versions.slice(1), now);
    if (versions.length > 1 && result.status !== "appended") fail("bad_chain", result.status === "rejected" ? result.reason : result.status);
    return chain;
  }

  get head(): SignedVersion {
    return this.versions[this.versions.length - 1]!;
  }

  get headHash(): string {
    return this.hashes[this.hashes.length - 1]!;
  }

  get state(): WorkspaceState {
    return this.head.body.state;
  }

  get length(): number {
    return this.versions.length;
  }

  versionAt(v: number): SignedVersion | undefined {
    return this.versions[v];
  }

  hashAt(v: number): string | undefined {
    return this.hashes[v];
  }

  /** Versions from `fromV` to the head, for a peer that is behind. */
  since(fromV: number): SignedVersion[] {
    return this.versions.slice(Math.max(1, fromV));
  }

  all(): SignedVersion[] {
    return [...this.versions];
  }

  /**
   * Offer consecutive versions from a peer. They must start right after a version we have (`branch[0].body.prev`
   * is the hash of our version `branch[0].body.v - 1`). With `now` (this peer's clock), a version dated more than
   * MAX_CLOCK_SKEW_MS after it is refused for now, so no one can push the record's time far into the future.
   */
  /** `appendOnly`: only versions that extend this chain; a branch that would replace part of it is refused unchecked. */
  offer(branch: SignedVersion[], now?: number, appendOnly = false): OfferResult {
    if (branch.length === 0) return { status: "duplicate" };
    const start = branch[0]!.body.v;
    if (start < 1) return { status: "rejected", reason: "genesis" };
    if (start > this.versions.length) return { status: "rejected", reason: "gap" };
    if (branch[0]!.body.prev !== this.hashes[start - 1]) return { status: "rejected", reason: "unknown_parent" };

    // Skip the prefix we already have (by hash, before any costly check), then verify only the rest.
    const hashes = branch.map(versionHash);
    let same = 0;
    while (same < branch.length && this.hashes[start + same] === hashes[same]) same++;
    if (same === branch.length) return { status: "duplicate" };
    const divergeAt = start + same;
    if (appendOnly && divergeAt < this.versions.length) return { status: "rejected", reason: "fork" };
    const theirs = branch.slice(same);
    const theirHashes = hashes.slice(same);
    let parent = this.versions[divergeAt - 1]!;
    let parentHash = this.hashes[divergeAt - 1]!;
    try {
      for (let i = 0; i < theirs.length; i++) {
        const version = theirs[i]!;
        if (now !== undefined && version.body.at > now + MAX_CLOCK_SKEW_MS) fail("forbidden", "future");
        verifyNext(this.workspaceId, parent, parentHash, version);
        parent = version;
        parentHash = theirHashes[i]!;
      }
    } catch (error) {
      return { status: "rejected", reason: error instanceof SecureError ? `${error.code}:${error.message}` : "invalid" };
    }

    const ours = this.versions.slice(divergeAt);
    if (ours.length === 0) {
      for (const version of theirs) this.versions.push(version);
      for (const hash of theirHashes) this.hashes.push(hash);
      return { status: "appended", count: theirs.length };
    }
    // A conflict reaching far back is refused: only a long partition with admins busy on both sides produces one
    // legitimately, while a once-trusted signer could otherwise try to rewrite old history.
    if (ours.length > MAX_FORK_DEPTH) return { status: "rejected", reason: "fork_too_deep" };
    const forkState = this.versions[divergeAt - 1]!.body.state;
    const seniority = this.seniority(divergeAt - 1);
    if (!preferBranch(forkState, seniority, theirs, theirHashes[0]!, ours, this.hashes[divergeAt]!)) return { status: "rejected", reason: "loses" };
    this.versions.splice(divergeAt, ours.length, ...theirs);
    this.hashes.splice(divergeAt, ours.length, ...theirHashes);
    return { status: "replaced", lost: ours, count: theirs.length };
  }

  /** For each user present at version `upTo`, the version that first listed them (lower = more senior). */
  private seniority(upTo: number): Map<string, number> {
    const firstSeen = new Map<string, number>();
    for (let v = 0; v <= upTo; v++) for (const userId of Object.keys(this.versions[v]!.body.state.users)) if (!firstSeen.has(userId)) firstSeen.set(userId, v);
    return firstSeen;
  }
}

export const MAX_FORK_DEPTH = 64;

/**
 * Whether a branch takes standing away from someone: revokes one of their devices, removes them, demotes them as an
 * admin, or lowers or ends their role in a room (deleting the room included). Only what someone else does to them
 * counts, so a user can't win a race by giving something of theirs up. A revocation or removal counts as it is (it is
 * final, even for someone who joined within the branch); a demotion or a lowered role only if it still holds when the
 * branch ends, compared with where it started, so taking something away and giving it back wins nothing.
 */
function takesStanding(forkState: WorkspaceState, branch: SignedVersion[]): boolean {
  const end = branch[branch.length - 1]!.body.state;
  const lower = (from: Role | undefined, to: Role | undefined) => from !== undefined && (to === undefined || !roleAtLeast(to, from));
  let prev = forkState;
  for (const version of branch) {
    const next = version.body.state;
    const actor = activeDevice(prev, version.body.by)?.user;
    for (const [deviceId, device] of Object.entries(prev.devices)) {
      if (device.user !== actor && activeDevice(prev, deviceId) && !activeDevice(next, deviceId)) return true;
    }
    for (const [userId, user] of Object.entries(prev.users)) {
      if (userId !== actor && user.admin && !next.users[userId]?.admin && forkState.users[userId]?.admin && !end.users[userId]?.admin) return true;
    }
    for (const [roomId, room] of Object.entries(prev.rooms)) {
      for (const userId of Object.keys(room.members)) {
        if (userId === actor) continue;
        if (lower(roleIn(prev, roomId, userId), roleIn(next, roomId, userId)) && lower(roleIn(forkState, roomId, userId), roleIn(end, roomId, userId))) return true;
      }
    }
    prev = next;
  }
  return false;
}

/** Ordering of a branch's first signer: admins first, then the user listed earliest. */
function rank(forkState: WorkspaceState, seniority: Map<string, number>, first: SignedVersion): { user: string; order: [number, number] } {
  const device = activeDevice(forkState, first.body.by)!;
  return { user: device.user, order: [forkState.users[device.user]!.admin ? 0 : 1, seniority.get(device.user) ?? Number.MAX_SAFE_INTEGER] };
}

/**
 * True if branch `a` should replace branch `b` (both start right after the same version, which has `forkState`). Every
 * rule compares something each branch has on its own, so the rules order any number of competing branches the same way
 * whatever order they arrive in (a rule comparing the two branches with each other could go round in circles: A revoking
 * B, B revoking C and C revoking A would each beat the one before).
 *
 * 1. A branch that takes standing away from anyone wins (`takesStanding`), so a change made at the same moment can't
 *    undo a removal, a revocation or a demotion, not even for a while.
 * 2. Otherwise the branch whose first signer ranks higher wins (`rank`). Rank can't be changed by the signer, unlike a
 *    hash, which a signer can grind by re-signing with small changes. A key rotation gets no precedence: one that loses
 *    is made again (with the removal it went with, if any).
 * 3. Then the first signer's user id, and between two branches of one user (on two of their devices) the one carrying
 *    more versions by other people, so one user can't throw away others' changes; then the device id, then the hash.
 *
 * What the losing branch took away is made again on top of the winner (see `concurrentReductions`), so concurrent
 * revocations add up whichever branch wins.
 */
export function preferBranch(
  forkState: WorkspaceState,
  seniority: Map<string, number>,
  a: SignedVersion[],
  aFirstHash: string,
  b: SignedVersion[],
  bFirstHash: string
): boolean {
  const aTakes = takesStanding(forkState, a);
  const bTakes = takesStanding(forkState, b);
  if (aTakes !== bTakes) return aTakes;
  const ra = rank(forkState, seniority, a[0]!);
  const rb = rank(forkState, seniority, b[0]!);
  for (let i = 0; i < ra.order.length; i++) if (ra.order[i] !== rb.order[i]) return ra.order[i]! < rb.order[i]!;
  if (ra.user !== rb.user) return ra.user < rb.user;
  const others = (branch: SignedVersion[]) => branch.filter((version) => activeDevice(forkState, version.body.by)?.user !== ra.user).length;
  const oa = others(a);
  const ob = others(b);
  if (oa !== ob) return oa > ob;
  if (a[0]!.body.by !== b[0]!.body.by) return a[0]!.body.by < b[0]!.body.by;
  return aFirstHash < bFirstHash;
}
