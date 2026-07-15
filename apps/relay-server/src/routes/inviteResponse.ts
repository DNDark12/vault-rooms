export type InviteResponseInput = { inviteId: string; inviteToken: string };

export type InviteSecurityContext = {
  serverId: string;
  tlsName: string;
  identitySpkiSha256: string;
  identityCertificateDer: string;
};

export function toInviteResponse(invite: InviteResponseInput, publicUrl: string, security?: InviteSecurityContext) {
  const params = new URLSearchParams({ mode: "join", server: publicUrl, token: invite.inviteToken });
  if (security) {
    params.set("serverId", security.serverId);
    params.set("security", "pinned-tls");
    params.set("tlsName", security.tlsName);
    params.set("fp", security.identitySpkiSha256);
    params.set("idc", security.identityCertificateDer);
  }
  return {
    inviteId: invite.inviteId,
    inviteToken: invite.inviteToken,
    serverUrl: publicUrl,
    joinUrl: `obsidian://vault-rooms?${params.toString()}`
  };
}
