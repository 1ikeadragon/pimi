export {
  openClientSecureChannel,
  openDaemonSecureChannel,
  PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE,
  PROTECTED_RECORD_FAILED_CLOSE_CODE,
} from "./secure-channel.js";
export type {
  ClientSecureChannelOptions,
  DaemonSecureChannelOptions,
  SecureChannel,
  SecureChannelEvents,
  Transport,
  TransportMessage,
} from "./secure-channel.js";

export {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  exportSecretKey,
  importSecretKey,
} from "./crypto.js";
export type { KeyPair } from "./crypto.js";
