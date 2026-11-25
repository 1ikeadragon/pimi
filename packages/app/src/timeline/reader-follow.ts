/**
 * Whether a mounted chat view has its reader at the end of the timeline. A trim of the oldest
 * turns shifts every row above the viewport, so it only runs for a reader who is following
 * the bottom; a reader scrolled up lets the array pass its cap until they return. A chat
 * with no mounted view counts as following, so hidden chats still stay within the cap.
 */
const awayFromEnd = new Set<string>();

/**
 * Chats whose reader loaded older history and has not left and returned to the bottom since.
 * A backward page grows the array at its older end, so an oldest-end trim would drop the
 * rows the reader just asked for, and the next scroll to the history start would fetch them
 * again. Oldest trims wait until the reader returns, even for a reader who sits at the bottom
 * because the loaded history is shorter than the viewport, so the array may stay over its cap
 * meanwhile.
 */
const pagedBack = new Set<string>();

/**
 * The seq of the newest row a mounted view shows, by chat. A trim of the newest turns must
 * cut above it or the rows under the reader's eyes leave the array.
 */
const newestVisibleSeq = new Map<string, number>();

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

export function setReaderPagedBack(serverId: string, agentId: string, paged: boolean) {
  if (paged) pagedBack.add(key(serverId, agentId));
  else pagedBack.delete(key(serverId, agentId));
}

/** Whether the oldest turns may leave the array: the reader follows the end and has not paged back. */
export function canTrimOldest(serverId: string, agentId: string): boolean {
  return isReaderFollowingEnd(serverId, agentId) && !pagedBack.has(key(serverId, agentId));
}

export function setReaderNewestVisibleSeq(serverId: string, agentId: string, seq: number | null) {
  if (seq === null) newestVisibleSeq.delete(key(serverId, agentId));
  else newestVisibleSeq.set(key(serverId, agentId), seq);
}

export function getReaderNewestVisibleSeq(serverId: string, agentId: string): number | null {
  return newestVisibleSeq.get(key(serverId, agentId)) ?? null;
}
