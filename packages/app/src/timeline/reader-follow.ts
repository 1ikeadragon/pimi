/**
 * Whether a mounted chat view has its reader at the end of the timeline. A trim of the oldest
 * turns shifts every row above the viewport, so it only runs for a reader who is following
 * the bottom; a reader scrolled up lets the array pass its cap until they return. A chat
 * with no mounted view counts as following, so hidden chats still stay within the cap.
 */
const awayFromEnd = new Set<string>();

function key(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

export function setReaderFollowingEnd(serverId: string, agentId: string, following: boolean) {
  if (following) awayFromEnd.delete(key(serverId, agentId));
  else awayFromEnd.add(key(serverId, agentId));
}

export function isReaderFollowingEnd(serverId: string, agentId: string): boolean {
  return !awayFromEnd.has(key(serverId, agentId));
}
