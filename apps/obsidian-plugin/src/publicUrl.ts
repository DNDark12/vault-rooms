/** Fills in "http://" and/or the actual bound port when a Public URL override omits either (the
 *  field's own description asks for "this device's LAN address", so a bare "192.168.1.100" or
 *  "192.168.1.100:9000" - not just "http://192.168.1.100" - is exactly what most users will type).
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
  if (!url.port) {
    url.port = String(port);
  }
  return `${url.protocol}//${url.host}`;
}
