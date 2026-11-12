import type { PimiApi } from "@pimi/client";
import { createContext, useContext, type ReactNode } from "react";

const PimiApiContext = createContext<PimiApi | null>(null);

export function usePimiContextValue(): PimiApi | null {
  return useContext(PimiApiContext);
}

export function PimiApiProvider({ children, pimi }: { children: ReactNode; pimi: PimiApi }) {
  return <PimiApiContext.Provider value={pimi}>{children}</PimiApiContext.Provider>;
}

export function usePimi(): PimiApi {
  const pimi = usePimiContextValue();
  if (!pimi) throw new Error("usePimi must run inside a contributed plugin surface");
  return pimi;
}
