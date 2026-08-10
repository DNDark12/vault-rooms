export type RawHttpResponse = {
  readonly vaultRoomsRawResponse: true;
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly headers?: Record<string, string>;
};

export function rawHttpResponse(
  body: Uint8Array,
  contentType = "application/octet-stream",
  headers?: Record<string, string>
): RawHttpResponse {
  return { vaultRoomsRawResponse: true, body, contentType, ...(headers ? { headers } : {}) };
}

export function isRawHttpResponse(value: unknown): value is RawHttpResponse {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as Partial<RawHttpResponse>).vaultRoomsRawResponse === true &&
      (value as Partial<RawHttpResponse>).body instanceof Uint8Array
  );
}
