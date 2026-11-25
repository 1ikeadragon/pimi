import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";
import type { BiometricReadResult } from "./biometric-passphrase";

export type { BiometricReadResult };

// SecureStore keys allow only letters, digits, ".", "-" and "_".
function storeKey(serverId: string): string {
  return `pimi.vault.passphrase.${serverId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

function readOptions(serverId: string, promptMessage: string): SecureStore.SecureStoreOptions {
  return {
    keychainService: storeKey(serverId),
    requireAuthentication: true,
    authenticationPrompt: promptMessage,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };
}

export async function isBiometricPassphraseAvailable(): Promise<boolean> {
  if (!(await SecureStore.isAvailableAsync())) return false;
  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  return hasHardware && (await LocalAuthentication.isEnrolledAsync());
}

// Reading prompts for biometrics, so presence is checked without a prompt: an unauthenticated
// read of the same service returns nothing. This is a separate keychain service holding a marker.
function markerOptions(serverId: string): SecureStore.SecureStoreOptions {
  return { keychainService: `${storeKey(serverId)}.marker` };
}

export async function hasStoredPassphrase(serverId: string): Promise<boolean> {
  return (await SecureStore.getItemAsync(storeKey(serverId), markerOptions(serverId))) !== null;
}

export async function storePassphrase(serverId: string, passphrase: string): Promise<void> {
  await SecureStore.setItemAsync(storeKey(serverId), passphrase, readOptions(serverId, ""));
  await SecureStore.setItemAsync(storeKey(serverId), "1", markerOptions(serverId));
}

// SecureStore reports a dismissed prompt as a coded error: ERR_AUTHENTICATION on Android and the
// keychain's "user canceled" text on iOS.
function isCancel(error: Error & { code?: string }): boolean {
  return error.code === "ERR_AUTHENTICATION" || /cancel/i.test(error.message);
}

export async function readPassphrase(
  serverId: string,
  promptMessage: string,
): Promise<BiometricReadResult> {
  if (!(await hasStoredPassphrase(serverId))) return { kind: "missing" };
  try {
    const passphrase = await SecureStore.getItemAsync(
      storeKey(serverId),
      readOptions(serverId, promptMessage),
    );
    return passphrase === null ? { kind: "missing" } : { kind: "ok", passphrase };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (isCancel(error)) return { kind: "cancelled" };
    return { kind: "failed", message: error.message };
  }
}

export async function forgetPassphrase(serverId: string): Promise<void> {
  await SecureStore.deleteItemAsync(storeKey(serverId), readOptions(serverId, ""));
  await SecureStore.deleteItemAsync(storeKey(serverId), markerOptions(serverId));
}
