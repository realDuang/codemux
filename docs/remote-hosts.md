# Remote connections

**Remote connections** is the single entry point for Direct, SSH, and Cloudflare.
The page groups actions by the computer being accessed, so an outbound SSH session
and this computer's Cloudflare sharing can remain active independently:

| Section | Purpose |
| --- | --- |
| **Connect to another computer** | Open a saved connection, or add a Direct/SSH destination. A shared Cloudflare URL works as a Direct HTTPS destination. |
| **Access this computer from another device** | Configure Direct or Cloudflare sharing, then copy the address/access code or scan the QR code. |

An empty saved-connection list offers Direct and SSH shortcuts. Once connections
are saved, **Add connection** opens the method picker. Enter the destination and
select **Connect**; the form remains available after a failure. An in-progress
connection can be cancelled. Saved rows keep Open/Connect as their primary action;
Edit, Disconnect, and Remove are in the row menu. Removing a saved connection does
not delete remote sessions.

Sharing configuration opens in a dialog. Selecting another method only edits the
draft; cancelling leaves the active method unchanged. Successful configuration
returns to the address/QR/access-code summary. Direct is labeled **Configured**
rather than claiming verified reachability. Cloudflare reflects the tunnel's
actual state and presents failures with a retry action; stopped or failed tunnels
do not expose a stale address as usable. Access codes remain masked until revealed.

The page replaces the separate Hosts and Web App tabs. Device management remains
beside this computer's sharing summary, and the footer explicitly opens local chat.
Navigation retains text on mobile; primary forms share one dialog layout.

Remote connections are also available in the local server manager while the local server is
stopped or unavailable. Connecting remotely does not start or replace local engines.
Each connected host opens in its own window, with separate browser storage.

## Direct connection

Enter a hostname or IP and the CodeMux Web port (default `8233`). Select **Use SSL**
for an HTTPS entry. The advanced form accepts a complete HTTP(S) origin and an
optional display name. IPv6 is supported; paths, credentials, queries, and fragments
are not accepted as connection destinations.

The remote host must be running and reachable. For access outside its loopback
interface, enable [Direct connection on that host](custom-access.md) using the
same origin. Its existing access-code and device-approval flow appears in the
remote window; those credentials remain in that host's browser partition.
The client does not configure DNS, certificates, routers, or server admission.

## Remote SSH

Enter an existing SSH config alias, `user@host`, or `ssh://user@host:2222`.
The optional port in the address belongs to SSH. **Advanced → Remote CodeMux port**
selects the remote Web service port, normally `8233`.

CodeMux invokes the system OpenSSH client and uses its config, keys, and SSH agent.
The host key must already be trusted, and login must work non-interactively.
For an unknown or changed host key, verify it through SSH in a terminal first.
CodeMux never stores SSH passwords or private keys and does not install or start
the remote server. SSH connection URLs cannot contain a password or remote command.

The owned SSH process forwards a local loopback port to the remote computer's
`127.0.0.1:<CodeMux Web port>`. Both HTTP and WebSocket traffic use that tunnel.
The remote server's normal loopback authentication applies, so its public remote
access mode can remain Off. The connected window enters chat after authentication.

An established SSH connection reconnects with bounded backoff after transport
failure. The saved local port is reused so browser authentication, settings, and
drafts keep the same origin. If another application takes that port, CodeMux reports
the conflict instead of silently opening a new storage origin. Closing the remote
window, disconnecting, or quitting CodeMux releases its SSH process and listener.
Stopping the separate local CodeMux server does not close remote connections.

## Isolation and compatibility

Remote pages run without the desktop preload or Node integration, with Electron's
sandbox and Web security enabled. They access the selected host through the
existing Web API. They cannot use the local desktop's native APIs or local server
controls. Each saved host has its own persistent partition; changing its destination
also changes the partition so old credentials are not sent to a different host.

Connection preferences are stored in the desktop-owned `remote-hosts.json` beside
its user data, independently of the service-owned settings writer. A malformed
host file blocks host-list operations without preventing local desktop startup
or overwriting the recovery file. Existing custom-entry configuration continues
to use the persisted `custom` mode.

The interaction follows Paseo's method picker, direct Host/Port/SSL form, advanced
connection form, and desktop-only SSH choice. CodeMux retains its own access-code
authentication and Web port. References: [Paseo method picker](https://github.com/getpaseo/paseo/blob/fcda2f1cf0a36a2e81583a5616773321918b2de4/packages/app/src/components/add-host-method-modal.tsx),
[direct form](https://github.com/getpaseo/paseo/blob/fcda2f1cf0a36a2e81583a5616773321918b2de4/packages/app/src/components/add-host-modal.tsx),
[SSH form](https://github.com/getpaseo/paseo/blob/fcda2f1cf0a36a2e81583a5616773321918b2de4/packages/app/src/components/add-remote-ssh-host-modal.tsx).

## Validation

The automated suite covers address validation, persistent identity, storage failures,
SSH cancellation/timeouts and cleanup, native IPC sender checks, remote-window
isolation, and reconnect behavior. An isolated macOS OpenSSH server with throwaway
keys also verified actual HTTP and WebSocket forwarding and port release.

Hidden Electron windows verified Direct and SSH HTTP/WebSocket round trips,
absence of the local native API, and storage isolation. Ego Browser checks exercised
the rendered forms, failed-connection retry, HTTPS fields, saved-host actions,
mobile layout, single-request direct enablement, QR/access-code display, and the
connected-host route into the existing chat. Conversation checks used synthetic
engine fixtures; no live engine credentials or installed application were changed.
