# Remote connections

**Remote connections** is the single entry point for Direct, SSH, Cloudflare, and Microsoft Dev Tunnels.
The page groups actions by the computer being accessed, so an outbound SSH session
and this computer's Cloudflare sharing can remain active independently:

| Section | Purpose |
| --- | --- |
| **Connect to another computer** | Open a saved connection, add a Direct/SSH destination, or discover your Microsoft Dev Tunnels computers. Shared tunnel links also work as Direct HTTPS destinations. |
| **Access this computer from another device** | Configure Direct, Cloudflare, or Microsoft Dev Tunnels sharing, then copy the address/access code or scan the QR code. |

An empty saved-connection list offers Direct, Microsoft Dev Tunnels, and SSH shortcuts. Once connections
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

## Microsoft Dev Tunnels

Install Microsoft's `devtunnel` CLI on the computer running the CodeMux server
(`winget install Microsoft.devtunnel` on Windows). Select **Microsoft Dev Tunnels**
in this computer's sharing settings, then enable it. Desktop and Node server hosts
use the same provider; it forwards only the configured CodeMux Web port, including
HTTP and WebSocket traffic. Cloudflare remains a separate choice. Only one sharing
method is enabled at a time.

The provider reuses the CLI's existing login. An explicit enable/retry can open
interactive Microsoft sign-in on the host. On Windows this uses a separate native
window so Windows account authentication has a parent console. Device-code
fallback is stopped, not offered as an alternative. Startup restoration never
opens sign-in automatically; an expired login is shown as an error requiring
retry. Headless hosts need a valid CLI login established beforehand.

CodeMux creates a dedicated persistent tunnel, defaulting to **Only my account**.
Its identity is retained in the host's settings, not taken from the CLI's
last-used tunnel. Existing unrelated tunnels are never adopted or stopped.
Disabling access stops the owned connector without deleting the persistent
tunnel. Re-enabling reuses its address; changing the CLI account or Web port
creates a different dedicated tunnel. The service expires tunnels after 30 days
of inactivity; expired tunnels are recreated when enabling access.

Advanced settings can explicitly grant access to the current **Microsoft Entra
tenant** or to **Anyone with the address**. Tenant access includes the entire
tenant, not just a team. These choices must be permitted by your organization.
Switching back to private resets both tunnel-level and port-level access grants.
CodeMux's own access-code/device-approval flow is required in every mode.

Private visitors first authenticate to Microsoft Dev Tunnels. Desktop Direct
connections use a separate sandboxed sign-in window sharing only that saved
host's browser partition; the application window remains locked to its selected
origin. The tunnel's first-visit confirmation may also appear there.

The provider preserves the public Host and Origin headers, so tunnel traffic
cannot acquire the host's loopback-only management privileges. No usable link is
published until the connector reports readiness. Unexpected disconnects retry
with bounded backoff; disabling access cancels pending sign-in, provisioning, and
reconnection. Login credentials stay in the CLI's credential store, not CodeMux
settings or logs.

Dev Tunnels is a development service with service quotas, not an availability or
compliance guarantee. Inspect account limits with `devtunnel limits`.

### Discover and connect to your computers

Under **Connect to another computer**, select **Microsoft Dev Tunnels**. Desktop
checks the current local CLI login and lists your tagged CodeMux tunnels. If login
is missing or expired, explicitly select **Sign in to Microsoft and discover**;
opening the dialog never launches login automatically. Refresh and cancellation
are available. Discovery needs the CLI on the connecting desktop but does not
need this computer's CodeMux server to be running.

The host adds tunnel labels `codemux` and `codemux-discovery-v1`, plus `codemux-web`
on its single Web port. Only the locally saved, account-matched host identity is
updated; unrecognized tunnels are not adopted. After upgrading an existing host,
restart its Dev Tunnels sharing once to add labels. **Computer name** in sharing
settings is optional and is stored in the service's tunnel description; avoid
sensitive information. Without a name, CodeMux uses a generic description.

Discovery only lists owned tunnels, not every computer in the tenant or every
tunnel someone has allowed you to visit. It never hosts, stops, updates, or deletes
the results. The desktop validates version and port labels, the tunnel identity,
and its HTTPS address before offering a connection. Host online/offline status is
a service hint, not an application health check. Offline hosts and hosts without
a published Web address cannot be connected from the list.

Browser clients do not expose the server's CLI account or discovery API. They
offer a shared-link field instead; desktop also keeps that field for colleagues'
links, missing CLI installations, and older hosts. Links must be HTTPS
`*.devtunnels.ms` origins. Saved tunnel connections reuse the existing Direct
transport and browser isolation, and reopen in the Dev Tunnels editor.

CLI discovery credentials are separate from visitor browser cookies. Connecting
may therefore require Microsoft sign-in again, followed by CodeMux authentication.
Labels are discovery metadata, never proof of trust or a replacement for either
authentication layer.

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
