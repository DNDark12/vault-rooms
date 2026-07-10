import type { InviteAcceptanceResponse, InviteJoinResponse } from "./apiClient.js";

export function inviteJoinNotice(response: InviteJoinResponse, baseUrl: string): string {
  if (response.inviteType === "team") {
    return `Joined team ${response.team.name}`;
  }
  if (response.inviteType === "room") {
    return `Joined room ${response.room.name}`;
  }
  return `Connected to ${baseUrl}`;
}

export function inviteAcceptanceNotice(result: InviteAcceptanceResponse): string {
  if (result.inviteType === "team") {
    return `Joined team ${result.team.name}`;
  }
  if (result.inviteType === "room") {
    return `Joined room ${result.room.name}`;
  }
  return "You're already connected to this server";
}
