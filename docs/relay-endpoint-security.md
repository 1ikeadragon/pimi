# Relay endpoint security

The relay carries daemon sessions between a client and a daemon that cannot reach each other directly. The relay is untrusted, so the two endpoints secure the session themselves. This doc owns the protected construction, its mapping onto Pimi's handshake and record flow, the negotiation rules, and the enforcement flag. The threat model lives in [SECURITY.md](../SECURITY.md); the code is `packages/relay/src/secure-channel.ts`.

There is one construction: `Noise_NK_25519_ChaChaPoly_SHA256` (revision 34) with authenticated records. The NaCl `box` construction it replaced had no replay protection ([#359](https://github.com/1ikeadragon/pimi/issues/359)) and was removed in 0.17.64; a peer that does not send a valid `protected` envelope fails the handshake.

The shared entry points are `openClientSecureChannel` and `openDaemonSecureChannel`, which return a `SecureChannel`.

## Noise mapping

- **Pattern:** NK. The daemon's static key is the existing `$PIMI_HOME/daemon-keypair.json` X25519 key that pairing already distributes. There is no second daemon identity.
- **Prologue:** the ASCII bytes `pimi-relay-e2ee/1`.
- **Primitives:** `@noble/curves` x25519, `@noble/ciphers` ChaCha20-Poly1305, `@noble/hashes` SHA-256 and HMAC. The state machine in `packages/relay/src/noise/` is our own implementation of the spec and is checked against vendored third-party vectors in `noise/fixtures/`.
- **Message 1** (`-> e, es`) travels inside the hello: `{ type: "e2ee_hello", protected: { v: 1, message: <base64> } }`. The Noise payload is the offered parameters.
- **Message 2** (`<- e, ee`) travels inside the ready: `{ type: "e2ee_ready", protected: { v: 1, message: <base64> } }`. Its payload is the selected parameters.
- **Parameters payload:** two bytes, `[0x01 version][flags]`. Flag bit 0 is `binaryCiphertext`. Unknown versions, reserved flag bits, and a selection the client did not offer fail the handshake.
- **Split:** the initiator sends with the first cipher state and receives with the second. The daemon is the mirror. Nonces are 64-bit little-endian in a 12-byte nonce, reserved synchronously before any await, never wrapped. A receiver advances its counter only after the tag verifies.

Nothing else is bound into the handshake. The outer JSON, the relay URL, and session credentials are not authenticated by Noise. Credentials travel in the application `hello` after message 2 verified the daemon.

## Records

Each application frame becomes one record of one or more Noise transport messages:

```
chunk plaintext = kind(1) || flags(1) || totalLength(u32 BE) || data
wire record     = (u16 BE ciphertextLength || ciphertext)+
```

`kind` is `0x00` text or `0x01` binary. `flags` bit 0 marks the first chunk and bit 1 the last. `data` is at most 65513 bytes per chunk, so a chunk never exceeds the Noise message limit. The chunk count is `max(1, ceil(totalLength / 65513))`.

The receiver rejects a record whose metadata disagrees between chunks, whose non-final chunks are not full, whose byte total differs from `totalLength`, or that has zero chunks, trailing bytes, reserved flags, or an invalid kind. Partial plaintext never reaches the application. Transport AD is empty, as the Noise spec writes it; framing authenticity comes from the metadata being inside the ciphertext. `packages/relay/src/protected-records.ts` owns this.

Frame kind is preserved on the wire: text records are base64 WebSocket text, binary records are WebSocket binary when `binaryCiphertext` was negotiated.

## Retries and failures

- The client resends its hello every second until a ready arrives. The daemon caches the exact hello text and ready text for the channel. An identical hello gets the identical ready and counters keep running. A different hello closes the channel (`1008`, transcript mismatch). A ready after the channel is open is ignored.
- A fresh daemon channel always generates a fresh `e`, so a recorded hello and its records fail authentication when replayed later, including after a daemon restart.
- A missing or invalid `protected` field fails the handshake.
- Any record failure (bad tag, duplicate, reordered, reflected, malformed) closes the channel and nothing from that record is delivered. The daemon closes with `1011`; the client closes with `4003`, because a browser `WebSocket.close` accepts only `1000` and `3000`-`4999`.
- A record header is checked against the bytes actually received before any buffer is allocated for it, so a header claiming gigabytes costs nothing.
- Keys are cleared on close as a best effort.

## Who can connect

NK authenticates the daemon to the client, not the client. Possession of the daemon public key (in every pairing link and QR code) lets a client finish the handshake; admission then asks for the daemon password if one is set. On a host without a password, the pairing link is the only credential.

- **Pairing reset** (Pair device → Reset pairing, RPC `daemon.pairing.reset.request`) rotates `daemon-keypair.json`, turns LAN pairing off, and drops every relay and LAN connection. Old links stop working because their handshake can no longer complete. The serverId stays the same, so hosts keep their identity in every app.
- **Password guessing** over relay or LAN is serialized and backed off exponentially after each failure, up to 30 seconds (`throttledPasswordCheck` in `websocket-server.ts`).

## Relay registration

The relay never sees a key. To stop anyone who knows a serverId from registering as that daemon and evicting it, every `role=server` socket carries `Authorization: Bearer <token>`. The token is 256 random bits in `$PIMI_HOME/relay-server-token`, separate from the E2EE key so a pairing reset leaves the binding intact. The relay binds SHA-256(token) to the serverId the first time it sees it and rejects any other token with `401`. See [self-hosted-relay.md](self-hosted-relay.md) for persistence and limits.

Turning the relay off terminates every relay data socket rather than sending a close frame, so a peer that withholds the close handshake cannot keep its session.
