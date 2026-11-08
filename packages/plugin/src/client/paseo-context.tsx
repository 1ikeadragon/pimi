import type { PaseoApi } from "@pimi/client";
import { createContext, useContext, type ReactNode } from "react";

const PaseoApiContext = createContext<PaseoApi | null>(null);

export function usePaseoContextValue(): PaseoApi | null {
  return useContext(PaseoApiContext);
}

export function PaseoApiProvider({ children, paseo }: { children: ReactNode; paseo: PaseoApi }) {
  return <PaseoApiContext.Provider value={paseo}>{children}</PaseoApiContext.Provider>;
}

export function usePimi(): PaseoApi {
  const paseo = usePaseoContextValue();
  if (!paseo) throw new Error("usePimi must run inside a contributed plugin surface");
  return paseo;
}

/** @deprecated Use usePimi. */
export const usePaseo = usePimi;
