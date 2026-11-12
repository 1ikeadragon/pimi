// Which agent created a terminal through the create_terminal tool. Kept in the daemon, not the
// terminal worker, so recording an owner needs no worker protocol bump. Lost on a daemon restart;
// the terminal itself survives it. Bounded: the oldest entries go first.
const MAX_OWNERS = 2000;
const ownerByTerminalId = new Map<string, string>();

export function recordTerminalOwner(terminalId: string, agentId: string): void {
  ownerByTerminalId.delete(terminalId);
  ownerByTerminalId.set(terminalId, agentId);
  if (ownerByTerminalId.size > MAX_OWNERS) {
    const oldest = ownerByTerminalId.keys().next();
    if (!oldest.done) ownerByTerminalId.delete(oldest.value);
  }
}

export function getTerminalOwner(terminalId: string): string | undefined {
  return ownerByTerminalId.get(terminalId);
}
