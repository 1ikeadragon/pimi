# Daemon access

The daemon has one authority. A session the daemon admits can do everything the daemon user can: run agents and terminals, read and write files, change configuration, manage plugins and connected hosts. There are no principals, roles, grants, or per-RPC permissions. Admission is the security boundary, so the work is in deciding who gets admitted.

## Admission

`packages/server/src/server/session-admission-auth.ts` decides admission from the hello. The socket's transport picks the credential it must present:

| Transport                      | Admitted when                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| Local-network pairing          | `hello.auth` is a password equal to that pairing's access code. Other credentials are rejected. |
| Direct or relay, no password   | Always. Relay sockets still need the end-to-end handshake first.                                |
| Direct or relay, with password | `hello.auth` is the password or the current local credential.                                   |
| Direct, bearer header          | Pre-admitted after the header is checked against the password, or when no password is set.      |
| Plugin socket                  | Pre-admitted. The daemon opened it for a trusted local plugin.                                  |
| Connected-host channel         | Pre-admitted under its physical link, which went through one of the rows above.                 |

A rejected hello gets `hello.rejected` and close code `4401`. Nothing else is sent before admission. [SECURITY.md](../SECURITY.md#local-daemon-trust-boundary) owns the password, local credential, and relay pairing threat model.

The relay pairing offer and the local-network access code do not create an identity on the daemon. The offer only carries the key for the end-to-end handshake, so a relay client still needs the password when one is set. The access code is the credential for its local-network connection, in place of the password.

## What still narrows a session

These checks are not permissions. They follow from how the session was admitted, so keep them when you change admission.

- A routed session, one admitted through a connected-host channel, cannot open another host link or route. Connected hosts are one hop. See [Connected hosts](connected-hosts.md#ownership-and-authority).
- Plugin sockets own the `plugin:` client ID namespace. Other sockets cannot claim it, and plugin sessions do not resume.
- Resuming a session closes its connected-host links and routes, because the new hello can change its producer or routed state.

## Adding access control

Do not reintroduce a permission enum or an operation table without a caller that gets less than full authority on a live path. Hub was the only such caller and it is gone. A check that every admitted session passes is not a control; it only hides that the boundary is admission.

File preview reads any regular file the daemon can read. Workspace-scoped access would need every resource-bearing operation and outbound event to enforce the same workspace boundary first.
