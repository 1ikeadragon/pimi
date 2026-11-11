import { useEffect, useState, useSyncExternalStore } from "react";
import { useSessionStore } from "@/stores/session-store";
import { createDaemonFileSession } from "./daemon-session";
import { FileHandle, type FileHandleSnapshot, type FileTarget } from "./handle";

/** The tab target's file handle, observing while `observing`. Disposed when the target changes. */
export function useFileHandle(input: {
  serverId: string;
  target: FileTarget | null;
  absolutePath: string;
  observing: boolean;
}): FileHandle | null {
  const { serverId, target, absolutePath, observing } = input;
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const cwd = target?.cwd ?? null;
  const path = target?.path ?? null;
  const [handle, setHandle] = useState<{ key: string; handle: FileHandle } | null>(null);
  const key = client && cwd && path ? `${cwd}:${path}` : null;

  useEffect(() => {
    if (!client || !cwd || !path) {
      setHandle(null);
      return;
    }
    const session = createDaemonFileSession(client);
    const next = new FileHandle(session, { cwd, path }, absolutePath);
    setHandle({ key: `${cwd}:${path}`, handle: next });
    return () => next.dispose();
  }, [absolutePath, client, cwd, path]);

  const current = handle?.key === key ? handle.handle : null;
  useEffect(() => {
    current?.setObserving(observing);
  }, [current, observing]);
  return current;
}

const LOADING: FileHandleSnapshot = { status: "loading" };
const subscribeNothing = () => () => {};
const getLoading = () => LOADING;

export function useFileHandleSnapshot(handle: FileHandle | null): FileHandleSnapshot {
  return useSyncExternalStore(
    handle?.subscribe ?? subscribeNothing,
    handle?.getSnapshot ?? getLoading,
    handle?.getSnapshot ?? getLoading,
  );
}
