import { vi } from "vitest";

export const requestUrl = vi.fn(defaultRequestUrl);

export async function defaultRequestUrl(request: string | { url: string; method?: string; headers?: Record<string, string>; contentType?: string; body?: string | ArrayBuffer; throw?: boolean }) {
  const params = typeof request === "string" ? { url: request } : request;
  const response = await fetch(params.url, {
    method: params.method,
    headers: {
      ...(params.headers ?? {}),
      ...(params.contentType ? { "content-type": params.contentType } : {})
    },
    body: params.body
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = undefined;
  }
  if (params.throw !== false && response.status >= 400) {
    throw new Error(text || `Request failed with status ${response.status}`);
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    status: response.status,
    headers,
    text,
    json,
    arrayBuffer: new TextEncoder().encode(text).buffer
  };
}

export class Notice {
  constructor(
    readonly message?: string,
    readonly timeout?: number
  ) {}
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

export class TFile {
  constructor(readonly path: string) {}
  get extension(): string {
    return this.path.includes(".") ? this.path.split(".").pop() ?? "" : "";
  }
}

export class TFolder {
  constructor(readonly path: string) {}
}
