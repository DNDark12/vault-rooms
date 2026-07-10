export type InviteResponseInput = { inviteId: string; inviteToken: string };

export function toInviteResponse(invite: InviteResponseInput, publicUrl: string) {
  return {
    inviteId: invite.inviteId,
    inviteToken: invite.inviteToken,
    serverUrl: publicUrl,
    joinUrl: `obsidian://vault-rooms?mode=join&server=${encodeURIComponent(publicUrl)}&token=${encodeURIComponent(invite.inviteToken)}`
  };
}
