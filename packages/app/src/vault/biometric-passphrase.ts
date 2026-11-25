// The phone keeps a vault passphrase behind Face ID or a fingerprint. Only the native build has
// that (see biometric-passphrase.native.ts); web and desktop never offer it, because a passphrase
// stored there would sit where desktop agents run.

export type BiometricReadResult =
  | { kind: "ok"; passphrase: string }
  | { kind: "missing" }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

export async function isBiometricPassphraseAvailable(): Promise<boolean> {
  return false;
}

export async function hasStoredPassphrase(_serverId: string): Promise<boolean> {
  return false;
}

export async function storePassphrase(_serverId: string, _passphrase: string): Promise<void> {
  throw new Error("Biometric passphrase storage is only available in the phone app.");
}

export async function readPassphrase(
  _serverId: string,
  _promptMessage: string,
): Promise<BiometricReadResult> {
  return { kind: "missing" };
}

export async function forgetPassphrase(_serverId: string): Promise<void> {}
