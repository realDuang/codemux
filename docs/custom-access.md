# Custom browser access

CodeMux can be reached through an existing IP address or domain independently of
its built-in Cloudflare Tunnel. The browser connects to the same running CodeMux
instance and operates its existing sessions. Engines, files, and credentials stay
on the host computer.

## Configure an entry point

1. Open **Remote Access** on the CodeMux host.
2. Select **Custom entry** and enter the complete address, for example
   `http://192.168.1.20:8233` or `https://codemux.example.com`.
3. Save it, then enable **Remote Access**. **Web App** displays the active address
   and a locally generated QR code.
4. Open that address on another device, enter the host's access code, and approve
   the device on the host. The browser can then read and operate the same sessions.

Saving an address does not create a network route, change DNS, obtain a TLS
certificate, or start a tunnel. Configure those facilities outside CodeMux. The
host must remain running and reachable. The default web port is 8233; use the port
displayed by the running instance if it differs.

Addresses support HTTP or HTTPS, IPv4, bracketed IPv6, domain names, and explicit
ports. Credentials, query parameters, fragments, and subpaths such as
`https://example.com/codemux/` are not supported. For direct LAN access, set the
custom entry to the host's LAN IP and web port.

## Enable, disable, and switch methods

Remote access has one active mode: **Off**, **Custom entry**, or **Cloudflare
Tunnel**. New installations default to Off. A valid custom address saved before
the mode selector was introduced is migrated to Custom entry.

Turning remote access off blocks remote HTTP requests and WebSocket connections,
including already connected browser sessions. Localhost and the desktop app remain
available. The custom address and Cloudflare configuration are retained for the
next activation. Remote devices cannot change the access mode or custom address.

Selecting another method while enabled switches the active mode. CodeMux stops
its Cloudflare connector before activating custom access. Only the selected
browser-facing origin is accepted for remote requests; a proxy must preserve that
origin. Switching to Cloudflare prevents browser use of the custom entry.

CodeMux controls access to its own server. An externally managed proxy or tunnel
can additionally withdraw its listener when access is disabled, but CodeMux does
not install or manage that external service.

## Proxy configuration

Forward the complete HTTP origin, including the `/ws` WebSocket upgrade, to the
CodeMux web port. Preserve the browser-facing Host header and overwrite untrusted
forwarding headers with verified client information. A proxy or SSH bridge that
connects through loopback must not erase the remote identity and present requests
as trusted localhost traffic. Use HTTPS at the entry point for public access.

The gateway authenticates browser connections with their device token. Device
revocation is checked on requests and server notifications; idle connections are
checked by the gateway heartbeat. Reconnecting to the same instance reloads its
session history. An interrupted WebSocket closes terminal processes owned by that
connection; active terminals are not migrated between connections.

## Cloudflare and webhooks

Custom access and Cloudflare Tunnel are mutually exclusive. Cloudflare Tunnel
starts only when its mode is explicitly enabled; saving a custom address does not
start it. CodeMux displays the active method's address.
Webhook setup uses the active custom address or running Cloudflare Tunnel URL.
When remote access is off, no remote callback address is advertised.
A private LAN address can serve browser clients
without being reachable by an external messaging platform; configure a reachable
callback address with that platform when using webhook channels.

This setting is an advertised entry point, not a remote desktop-client mode. It
does not connect the desktop application to another CodeMux host.

## Cloudflare custom domains

Cloudflare quick tunnels require no Cloudflare account setup and produce a
temporary `*.trycloudflare.com` URL each time they start.

A custom domain requires a Cloudflare named tunnel and a local tunnel credential
file. CodeMux looks for a UUID-named JSON file in `~/.cloudflared/`, for example
`~/.cloudflared/<tunnel-id>.json`. If a custom domain is configured but that
credential is missing, CodeMux will stop startup with a missing-credentials error
instead of silently falling back to a random quick tunnel URL.

To prepare a custom domain:

```bash
# Sign in and choose the Cloudflare zone for your domain.
# This writes ~/.cloudflared/cert.pem.
cloudflared tunnel login

# If the tunnel already exists, find its name and UUID.
cloudflared tunnel list

# Download/write the connector credential that CodeMux can detect.
cloudflared tunnel token --cred-file ~/.cloudflared/<tunnel-id>.json <tunnel-name-or-id>

# Route the hostname to that named tunnel, if it is not already routed.
cloudflared tunnel route dns <tunnel-name-or-id> <your-domain>
```

If you do not already have a named tunnel, create one first with
`cloudflared tunnel create <tunnel-name>`; that command also writes the credential
JSON. Keep `cert.pem` and `<tunnel-id>.json` private and never commit them to the
repository.
