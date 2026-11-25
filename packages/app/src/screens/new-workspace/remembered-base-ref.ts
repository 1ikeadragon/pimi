import { useCallback, useEffect } from "react";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import { useTranslation } from "@/i18n/use-translation";
import { mergeProjectDefaults } from "@/create-agent-preferences/preferences";
import { useFetchQuery } from "@/data/query";
import { useFormPreferences } from "@/hooks/use-form-preferences";

// `refMode: "exact"` matches by substring, so looking up refs/heads/x also returns
// refs/heads/x-y, newest first. 200 is the most the request schema allows
// (BranchSuggestionsRequestSchema); a page that fills up without the exact ref cannot prove the
// ref is gone, so the lookup throws instead of reporting "missing" and dropping the entry.
const REF_LOOKUP_LIMIT = 200;

// Same freshness window as the branch suggestions query in the New workspace screen.
const REMEMBERED_REF_STALE_MS = 15_000;

async function refExists(client: DaemonClient, cwd: string, refName: string): Promise<boolean> {
  const result = await client.getBranchSuggestions({
    cwd,
    query: refName,
    refMode: "exact",
    limit: REF_LOOKUP_LIMIT,
  });
  if (result.error) throw new Error(result.error);
  if (result.branches.includes(refName)) return true;
  if (result.branches.length >= REF_LOOKUP_LIMIT) {
    throw new Error(`Could not confirm ${refName}: too many refs match`);
  }
  return false;
}

interface UseRememberedBaseRefInput {
  client: DaemonClient | null;
  isConnected: boolean;
  serverId: string;
  cwd: string | null;
  projectKey: string | null;
  /** The base picker is on screen, so a remembered ref is worth validating. */
  active: boolean;
}

interface RememberedBaseRef {
  /** The stored ref unless it is known to be gone. Optimistic while the lookup is in flight. */
  refName: string | null;
  remember: (refName: string) => void;
  forget: () => void;
  /**
   * The remembered ref confirmed against the repo now, or null when none is stored. A stored ref
   * that is gone is dropped and rejected: the picker has already switched to the default base, and
   * creating silently from it would branch off something the user did not last see.
   */
  resolveForCreate: (client: DaemonClient, cwd: string) => Promise<string | null>;
}

export function useRememberedBaseRef(input: UseRememberedBaseRefInput): RememberedBaseRef {
  const { client, isConnected, serverId, cwd, projectKey, active } = input;
  const { t } = useTranslation();
  const { preferences, updatePreferences } = useFormPreferences();
  const storedRef = projectKey ? preferences.projectDefaults?.[projectKey]?.baseRefName : undefined;

  const update = useCallback(
    (baseRefName: string | null) => {
      if (!projectKey) return;
      updatePreferences((current) =>
        mergeProjectDefaults({
          preferences: current,
          projectKey,
          updates: { baseRefName },
        }),
      ).catch((error: unknown) => {
        console.warn("[NewWorkspace] could not save the remembered base branch", error);
      });
    },
    [projectKey, updatePreferences],
  );
  const remember = useCallback((refName: string) => update(refName), [update]);
  const forget = useCallback(() => update(null), [update]);

  const lookup = useFetchQuery({
    queryKey: ["remembered-base-ref", serverId, cwd, storedRef],
    queryFn: () => {
      if (!client || !cwd || !storedRef) throw new Error("Remembered base lookup is not ready");
      return refExists(client, cwd, storedRef);
    },
    enabled: active && isConnected && Boolean(client && cwd && storedRef),
    dataShape: "value",
    staleTimeMs: REMEMBERED_REF_STALE_MS,
    retry: false,
  });

  const isMissing = lookup.data === false;
  const lookupError = lookup.error;
  useEffect(() => {
    if (isMissing) forget();
  }, [forget, isMissing]);
  useEffect(() => {
    if (lookupError) {
      console.warn("[NewWorkspace] could not validate the remembered base branch", lookupError);
    }
  }, [lookupError]);

  const resolveForCreate = useCallback(
    async (createClient: DaemonClient, createCwd: string): Promise<string | null> => {
      if (!storedRef) return null;
      if (await refExists(createClient, createCwd, storedRef)) return storedRef;
      forget();
      throw new Error(t("newWorkspace.errors.rememberedBaseMissing", { ref: storedRef }));
    },
    [forget, storedRef, t],
  );

  const isUsable = !isMissing && !lookupError;
  const refName = isUsable ? (storedRef ?? null) : null;
  return { refName, remember, forget, resolveForCreate };
}
