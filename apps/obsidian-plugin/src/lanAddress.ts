/**
 * Classifies the address a host advertises to teammates, *before* anything tries to reach it.
 *
 * This exists because the host-side reachability probe cannot catch the single most common setup mistake:
 * a loopback address. `127.0.0.1` is trivially reachable **from the host**, so the probe goes green, the
 * invite is issued, and the failure surfaces on the teammate's machine as "can't connect" - the worst
 * possible place for it, since they can't see or fix the cause. Loopback always resolves to whoever is
 * asking, so an invite containing it points every teammate back at their own computer, and no amount of
 * hosts-file editing changes that (it isn't a name-resolution problem).
 *
 * Deliberately pure string/number parsing: the embedded server must not read network interfaces
 * (Obsidian's plugin review treats that as machine fingerprinting), so the plugin cannot verify an
 * address against the machine's real ones. What it *can* do is reject the addresses that are wrong by
 * construction, and say why.
 */
export type LanAddressClass = "loopback" | "unspecified" | "private" | "link-local" | "routable" | "hostname" | "invalid";

export type LanAddressVerdict = {
  class: LanAddressClass;
  /** Whether this address can plausibly be handed to a teammate on the same network. */
  usableForTeammates: boolean;
  /** Present when `usableForTeammates` is false: what's wrong, in the terms the user needs to act on. */
  problem?: string;
  /** Present when the address is allowed but worth flagging - shown, never used to block. */
  warning?: string;
};

/** Extracts the hostname from whatever the user typed - a bare address, `host:port`, or a full URL. */
export function hostnameOf(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return "";
  }
  try {
    // Two adjustments before parsing, both because `new URL` is stricter than what people type:
    // a schemeless "192.168.1.10:8787" parses as an opaque `scheme:data` URL rather than host:port, and a
    // bare IPv6 literal like "::1" is only valid inside brackets. Anything with several colons and no
    // scheme is treated as bare IPv6, since "host:port" only ever has one.
    const bareIpv6 = !trimmed.includes("://") && !trimmed.startsWith("[") && (trimmed.match(/:/g) ?? []).length > 1;
    const normalized = bareIpv6 ? `http://[${trimmed}]` : trimmed.includes("://") ? trimmed : `http://${trimmed}`;
    return new URL(normalized).hostname.replace(/^\[|]$/g, "");
  } catch {
    return "";
  }
}

export function classifyLanAddress(input: string): LanAddressVerdict {
  const hostname = hostnameOf(input);
  if (hostname.length === 0) {
    return { class: "invalid", usableForTeammates: false, problem: "That isn't a valid address." };
  }

  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    return { class: "loopback", usableForTeammates: false, problem: LOOPBACK_PROBLEM };
  }

  const ipv4 = parseIpv4(hostname);
  if (ipv4) {
    const [a, b] = ipv4;
    if (a === 127) {
      return { class: "loopback", usableForTeammates: false, problem: LOOPBACK_PROBLEM };
    }
    if (a === 0) {
      return {
        class: "unspecified",
        usableForTeammates: false,
        problem: "0.0.0.0 means \"every interface on this machine\", which isn't an address a teammate can connect to. Use this device's own LAN address instead."
      };
    }
    if (a === 169 && b === 254) {
      // Allowed, not blocked: two machines on one link (a direct cable, or the same Wi-Fi with no DHCP) can
      // genuinely reach each other on self-assigned addresses, and that is a legitimate LAN-only setup for
      // this product. Blocking it would refuse to issue an invite for something that works.
      return {
        class: "link-local",
        usableForTeammates: true,
        warning:
          "169.254.x.x is a self-assigned address, which usually means this device didn't get one from the network. It only works for teammates on the same direct link, and changes whenever the network does."
      };
    }
    const isPrivate = a === 10 || (a === 172 && b !== undefined && b >= 16 && b <= 31) || (a === 192 && b === 168);
    if (isPrivate) {
      return { class: "private", usableForTeammates: true };
    }
    // A public IP is unusual for a LAN-only tool but not impossible (some office networks). Allowed, and
    // deliberately not warned about here - the reachability probe is the better judge of it.
    return { class: "routable", usableForTeammates: true };
  }

  if (isIpv6Loopback(lower)) {
    return { class: "loopback", usableForTeammates: false, problem: LOOPBACK_PROBLEM };
  }
  if (lower === "::" ) {
    return {
      class: "unspecified",
      usableForTeammates: false,
      problem: "\"::\" means every interface on this machine, which isn't an address a teammate can connect to."
    };
  }
  if (lower.startsWith("fe80:")) {
    // Same reasoning as 169.254 above: usable on a single link, so warn rather than refuse to issue an invite.
    return {
      class: "link-local",
      usableForTeammates: true,
      warning: "An fe80: address is link-local: it only works between devices on the same direct link, and usually needs an interface suffix."
    };
  }

  // A hostname (including `something.local`). Can't be judged without resolving it, which is the
  // reachability probe's job - but at least it isn't wrong by construction.
  return { class: "hostname", usableForTeammates: true };
}

/**
 * Compares the address this host advertises in invites against the one a teammate actually connected on,
 * which the relay records from their request. Returns a warning when they disagree, or null when they match
 * (or when there's nothing to compare yet).
 *
 * The point is to catch a *stale* override: the address was right when it was set, then DHCP handed out a
 * different one. Nothing on the host notices - its own reachability probe keeps passing against whatever it
 * was told to check - so today this only surfaces when a teammate says "I can't connect any more", usually
 * long afterwards. The address a teammate genuinely reached is the one signal available for spotting it
 * without reading network interfaces.
 */
export function advertisedAddressDrift(advertised: string, observed: string | null | undefined): string | null {
  if (!observed) {
    return null;
  }
  const advertisedHost = hostnameOf(advertised).toLowerCase();
  const observedHost = observed.trim().toLowerCase();
  if (advertisedHost.length === 0 || observedHost.length === 0 || advertisedHost === observedHost) {
    return null;
  }
  // A teammate reaching a hostname while the override is an IP (or vice versa) is normal and works, so only
  // flag it when both are addresses of the same shape - otherwise this would nag about a working setup.
  const advertisedIsIp = classifyLanAddress(advertisedHost).class !== "hostname";
  const observedIsIp = classifyLanAddress(observedHost).class !== "hostname";
  if (advertisedIsIp !== observedIsIp) {
    return null;
  }
  return `Teammates are reaching this server at ${observedHost}, but invites advertise ${advertisedHost}. If the address changed, update Public URL override and restart the server - invites created with the old address will no longer work.`;
}

const LOOPBACK_PROBLEM =
  "A loopback address always means \"the computer that's asking\", so an invite containing it sends every teammate back to their own machine. Use this device's LAN address (something like 192.168.x.x) instead.";

function parseIpv4(hostname: string): [number, number | undefined, number | undefined, number | undefined] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const numbers = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (numbers.some((value) => Number.isNaN(value) || value > 255)) {
    return null;
  }
  return [numbers[0]!, numbers[1], numbers[2], numbers[3]];
}

function isIpv6Loopback(hostname: string): boolean {
  if (hostname === "::1") {
    return true;
  }
  // An IPv4-mapped loopback (`::ffff:127.0.0.1`) is still loopback. Both spellings have to be handled:
  // the dotted form as typed, and the hex form (`::ffff:7f00:1`) that URL parsing normalizes it into.
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(hostname);
  if (dotted) {
    return classifyLanAddress(dotted[1]!).class === "loopback";
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(hostname);
  if (hex) {
    const high = Number.parseInt(hex[1]!, 16);
    return high >>> 8 === 127;
  }
  return false;
}
