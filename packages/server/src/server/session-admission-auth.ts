import { compare } from "bcryptjs";
import type { WSHelloMessage } from "@pimi/protocol/messages";
import { matchesLocalCredential } from "./local-credential.js";

export type AdmissionFailure = "password_required" | "incorrect_password";

/** Every admitted session has the daemon's full authority; this decides only whether to admit. */
export async function resolveSessionAdmission(input: {
  credential: WSHelloMessage["auth"];
  passwordHash: string | undefined;
  localCredential: string | null;
  lanAccessCode?: string;
}): Promise<AdmissionFailure | null> {
  const { credential, passwordHash, localCredential, lanAccessCode } = input;
  if (lanAccessCode) {
    if (!credential) return "password_required";
    return credential.kind === "password" &&
      matchesLocalCredential(lanAccessCode, credential.password)
      ? null
      : "incorrect_password";
  }
  if (!passwordHash) return null;
  if (!credential) return "password_required";
  if (credential.kind === "localCredential") {
    return localCredential && matchesLocalCredential(localCredential, credential.token)
      ? null
      : "incorrect_password";
  }
  return (await compare(credential.password, passwordHash)) ? null : "incorrect_password";
}
