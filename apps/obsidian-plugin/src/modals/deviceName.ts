import { Platform } from "obsidian";

/** Default device name shown in the setup/join forms, via Obsidian's Platform API
 *  (the review scanner rejects navigator-based OS detection). */
export function defaultDeviceName(): string {
  if (Platform.isMacOS) return "Mac";
  if (Platform.isWin) return "Windows";
  if (Platform.isLinux) return "Linux";
  return "Obsidian desktop";
}
