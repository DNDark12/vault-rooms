import { Notice, requestUrl } from "obsidian";

const LATEST_RELEASE_URL = "https://api.github.com/repos/DNDark12/vault-rooms/releases/latest";

export async function notifyIfUpdateAvailable(installedVersion: string): Promise<void> {
  try {
    const response = await requestUrl({
      url: LATEST_RELEASE_URL,
      method: "GET",
      headers: { Accept: "application/vnd.github+json" },
      throw: false
    });
    if (response.status !== 200 || !isRecord(response.json) || typeof response.json.tag_name !== "string") {
      return;
    }
    const latestVersion = response.json.tag_name.replace(/^v/, "");
    if (!isNewerStableVersion(latestVersion, installedVersion)) {
      return;
    }
    new Notice(
      `A newer version of Vault Rooms is available in Community Plugins.\n\nYou are using ${installedVersion}.\nThe latest is ${latestVersion}.`,
      10000
    );
  } catch {
    // Update discovery is optional; offline startup and GitHub rate limits must stay invisible.
  }
}

function isNewerStableVersion(candidate: string, current: string): boolean {
  const candidateParts = stableVersionParts(candidate);
  const currentParts = stableVersionParts(current);
  if (!candidateParts || !currentParts) return false;
  for (let index = 0; index < candidateParts.length; index += 1) {
    const difference = candidateParts[index]! - currentParts[index]!;
    if (difference !== 0) return difference > 0;
  }
  return false;
}

function stableVersionParts(version: string): [number, number, number] | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
