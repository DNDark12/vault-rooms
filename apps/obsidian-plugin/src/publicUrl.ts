/** Always rewrites the Public URL override to the server's actual bound port, adding "http://" too
 *  if the input has no scheme at all (the field's own description asks for "this device's LAN
 *  address", so a bare "192.168.1.100" - not "http://192.168.1.100" - is exactly what most users
 *  will type). The override field's only job is supplying the address the plugin can't
 *  auto-detect (see "Security model" in the README) - the port is a separately configured value
 *  (explicit Port setting, or auto-picked), and is never something the override should be allowed
 *  to disagree with. A port the user happens to type into this field (e.g. copying a URL that
 *  included one from a previous session, or a stale port from before the server was restarted on
 *  a different one) is silently DISCARDED and replaced with the real one - respecting it instead
 *  would produce an invite/LAN URL pointing at a port the server isn't actually listening on, with
 *  no indication anything was wrong (this is exactly how a previous version of this function
 *  shipped a real bug: an override with an explicit-but-stale port silently won out over the
 *  server's real port).
 *  `new URL(...)` throws on a schemeless input like "192.168.1.100:9000" instead of parsing it as
 *  host:port (it looks like an opaque "scheme:opaque-data" URL without "//"), so a scheme is
 *  prepended first whenever the input doesn't already contain "://" - this repo's relay only ever
 *  speaks plain HTTP (see SECURITY.md - no TLS in v0.1), so "http://" is the only sensible default,
 *  never invented for an input that already specifies some other scheme. Rebuilds from the parsed
 *  origin only (protocol + host), discarding any path/query the user might have typed by mistake,
 *  rather than using URL#toString()'s normalization - that appends a trailing slash which would
 *  double up with the leading "/" every caller already prepends to request paths. Returns the
 *  input unchanged if it still doesn't parse as a URL even with a scheme prepended, so an
 *  actually-malformed override surfaces as a connection failure rather than being silently
 *  "fixed" into something wrong. */
export function withPort(urlString: string, port: number): string {
  const withScheme = urlString.includes("://") ? urlString : `http://${urlString}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return urlString;
  }
  url.port = String(port);
  return `${url.protocol}//${url.host}`;
}
