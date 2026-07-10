export type InviteClipboard = { writeText(text: string): Promise<void> };

export async function copyInviteLink(joinUrl: string, clipboard: InviteClipboard | undefined, selectFallback: () => void): Promise<boolean> {
  if (clipboard) {
    try {
      await clipboard.writeText(joinUrl);
      return true;
    } catch {
      // Clipboard access can be unavailable in insecure contexts or denied at runtime. Preserve
      // the repo's existing select-and-notify path instead of turning a convenience into an error.
    }
  }
  selectFallback();
  return false;
}
