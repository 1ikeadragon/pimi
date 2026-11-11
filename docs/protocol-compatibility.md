# Protocol Compatibility

Pimi is alpha software. The app, the CLI, the built-in plugins, and the daemon ship together in one build and are updated together. There is no compatibility with older daemons, older apps, or older clients.

A stale pairing still happens in development: an app reload picks up new code while a long-running daemon keeps its loaded version. Restart the daemon. Do not write code for the mismatch.

## Change both sides together

A protocol change lands in one commit that updates the schema, the daemon, and every client that reads or writes the message.

- Add required fields as required. A field is `.optional()` only when the value can be absent in the current build.
- Remove a field, message, or RPC by deleting its schema, its handler, its sender, and every reader.
- Rename in place. Do not keep the old name as an alias.
- Do not add fallbacks, version checks, or "update the host" branches for a peer that lacks a change.
- Do not gate a feature on `server_info.features.*` or a `hello` capability to cover an older peer. Use a flag only for a fact that varies between current hosts or clients: an installed provider, a host kind, a client that has no browser to drive.

Schemas live in `packages/protocol/src/messages.ts`. New RPC names follow [rpc-namespacing.md](rpc-namespacing.md).

## Wire schemas stay pure

Inbound validators are generated from the schemas, and the generator compiles only structural declarations. See [protocol-validation.md](protocol-validation.md).

- No `.transform()`, `.catch()`, or `.preprocess()` on WebSocket message schemas. Normalize in an explicit pass after validation.
- Use `z.discriminatedUnion()` when every branch shares a literal tag. Plain `z.union()` is forbidden there.
- `.default()` belongs on primitive leaves only, never on item schemas inside large arrays or big inbound containers.

## Client capability ownership

The client package advertises the protocol behavior it implements. Add a capability to its exhaustive defaults and implement the associated subscription or decoding behavior there. The app, CLI, and plugins inherit those defaults; they supply only host resources such as browser automation, or explicit overrides.

Connecting creates no timeline or event demand. Client subscriptions own their network membership, release it on unsubscribe, and restore it after reconnect. Raw message observers inspect traffic without requesting streams. Application caches and which agents are visible remain caller-owned.

## Owned observations

Each subscription is owned by its source, as described in [architecture](architecture.md#websocket-protocol). Independent filters per subscription and quiet connections are the only delivery model. The setup panel owns a workspace-scoped observation while active and visible; directory metadata signals failures without requesting output.

## Binary chunking

`binary_chunking_v1` in `hello` and `server_info.features.binaryChunkingV1` negotiate connection-scoped framing, because the native transport cannot use it for uploads. Application serializers and routed envelopes use the same boundary. Small messages and handshakes keep their existing representation.

The reserved binary opcode `0x31` is followed by version `1`, original kind (`0` text, `1` binary), and START/END flag bits `0`/`1`. Remaining bytes are an unchanged slice. There is no total length or chunk count. The receiver buffers up to the 100 MiB logical limit and decodes UTF-8 only after END. Transfers cannot interleave. Disconnect clears partial state and negotiation.

The lower transport supplies its plaintext frame budget, including encryption overhead. The sender waits for drain between chunks while ordinary messages keep the existing delivery path. Slow-client protections count messages queued behind an active transfer as well as bytes already in the socket. The framing module never selects an encryption construction.

React Native's WebSocket does not report its queued bytes, so the client cannot wait for native drain. Android's OkHttp transport closes when a send would put more than 16 MiB in its queue. The native transport disables outbound chunking, including on routed channels, and keeps its single-frame admission errors. Inbound chunking stays enabled; daemon-to-native responses use the daemon's paced writes.

## Data on disk is different

The alpha rule covers peers, not stored data. Records already in the daemon home, app storage, or desktop settings are read by the next build. Code that reads an older stored shape stays until the data can no longer exist, and carries a `COMPAT(name)` comment that names the file or storage key it protects. Behavior differences between versions of a third-party agent CLI are tagged the same way with the tool and version.

`rg "COMPAT\("` lists those two cases and nothing else.
