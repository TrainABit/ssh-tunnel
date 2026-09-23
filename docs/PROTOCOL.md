# TunnelVault device protocol

This document specifies the protocol between a TunnelVault **device** (the
`tunnelvault` client running next to the services it exposes) and the
TunnelVault **server**. It covers protocol version 2 (current) and the legacy
version 1 that older clients and servers still speak.

Reference implementations: `backend/src/protocol.js` + `backend/src/wsHandler.js`
(server) and `client/src/tunnel.js` + `client/src/protocol.js` (device).

---

## 1. Transport and authentication

The device opens a WebSocket (RFC 6455) to the path `/ws` of the server's API
port, e.g. `wss://tunnel.example.com/ws`. Use `wss://` in production: the token
is sent in a request header and is only as secret as the transport.

Upgrade request headers:

| Header | Value | Notes |
|---|---|---|
| `Authorization` | `Bearer <token>` | **Required.** Either an active device token (from the dashboard) or the server's admin `AUTH_TOKEN`. Query-string tokens (`?auth_token=`) are **not** accepted. |
| `X-TunnelVault-Protocol` | `2` | Sent by v2 devices. Absent or invalid means version 1. |

(A development server without `AUTH_TOKEN` also accepts connections without a
token; they act as the admin token. Deactivated device tokens are refused
even then.)

Upgrade responses other than `101`:

| Status | Meaning | Device behaviour |
|---|---|---|
| `401 Unauthorized` | Missing, unknown or deactivated token. | Log "token revoked or invalid", keep retrying at the maximum backoff. |
| `429 Too Many Requests` (`Retry-After: 60`) | Per-IP limit: more than 60 upgrade attempts per minute, or more than 10 failed authentications with unknown/missing tokens per minute (then *all* attempts from that IP are refused until the window ends). Configurable with `WS_UPGRADE_RATE_MAX` / `WS_AUTH_FAIL_MAX`. | Back off. |

Server-side limits: WebSocket `maxPayload` is **1 MiB** (bigger frames close
the connection with 1009); permessage-deflate is disabled. The server pings
every 30 s and terminates connections from which nothing (pong, ping or
message) arrived since the previous ping. On the same timer it re-checks every
device token against the database: a deleted or deactivated token is
disconnected with close code `4000`. Revoking a token in the dashboard
disconnects it immediately (close frame, then a hard terminate after 2 s if
the device does not complete the closing handshake).

Keepalive in the other direction: the reference device sends a WebSocket ping
every **15 s** and counts anything it receives (messages, pings, pongs) as a
sign of life. After **35 s** without any incoming frame it terminates the
connection and reconnects, so a half-open TCP connection is noticed quickly.
Device pings also count as liveness on the server, so a device whose link is
busy with queued data is not dropped because the server's own ping is stuck
behind that data.

## 2. Version negotiation

Immediately after the upgrade the server sends a text frame:

```json
{"type":"hello","protocolVersion":2,"features":["binary-data","flow-control"]}
```

* The server uses v2 features on a connection **only if** the upgrade request
  carried `X-TunnelVault-Protocol` >= 2. Otherwise it speaks v1 to that
  connection (JSON `tcp-data`, never sends `tcp-pause`/`tcp-resume`). It still
  sends `hello`; v1 devices ignore unknown message types.
* A device uses v2 features **only after** it received `hello` with
  `protocolVersion >= 2`. Servers older than 2.0 never send `hello`, so a v2
  device automatically falls back to v1 with them.
* A device honours `hello` **once per connection and only before the first
  `tcp-open`**. A late or repeated `hello` is ignored: switching the framing
  of streams that are already open would corrupt them. If `hello` lists
  `features`, the device uses only the listed ones (`binary-data`,
  `flow-control`).
* The server accepts incoming binary DATA frames and `tcp-pause`/`tcp-resume`
  from any connection.

## 3. Frames

* **Text frames** carry one JSON object with a string `type` (control
  messages, section 4). They are never used for bulk data in v2.
* **Binary frames** (v2 only) carry tunnel data. Binary frames are never
  parsed as JSON.

### 3.1 Binary DATA frame (v2)

```
 0        1                                 17
+--------+---------------------------------+---------------------------+
|  0x01  |  connId (16 raw bytes, UUID)     |  payload (0..256 KiB)     |
+--------+---------------------------------+---------------------------+
```

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | Frame type. `0x01` = DATA. |
| 1 | 16 | `connId` as the 16 raw bytes of the UUID (the hex digits of `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` in order). |
| 17 | n | Payload bytes for that connection. |

Rules:

* Senders never put more than **256 KiB** of payload into one frame (larger
  chunks are split).
* Receivers **ignore** frames shorter than 17 bytes, frames with an unknown
  type byte (reserved for future use) and frames for unknown `connId`s.

## 4. Control messages

All fields are validated by the receiver. Unknown extra fields are ignored.
UUIDs are canonical 36-character strings (case-insensitive on input, the
server emits lower case). Ports are integers 1..65535.

### 4.1 Device -> server

| `type` | Fields | Description |
|---|---|---|
| `register` | `localPort` (int, required), `protocol` (`"tcp"` \| `"http"`, default `"http"`), `name` (string <= 256, optional), `subdomain` (string <= 255, optional, http only) | Create a tunnel for a local port. |
| `reconnect` | `tunnelId` (UUID), `ownerSecret` (string) | Re-attach a tunnel created earlier (after a network drop or restart). |
| `tcp-close` | `connId` | "I will send no more data for `connId`" (section 5). |
| `tcp-pause` | `connId` | v2 flow control: stop sending data for `connId`. |
| `tcp-resume` | `connId` | v2 flow control: continue sending. |
| `tcp-data` | `connId`, `data` (base64 string) | **Legacy v1** data message. Accepted from any peer. The reference device puts at most **190 KiB of raw bytes** into one message, so the base64 JSON envelope stays below 256 KiB. |
| `response` | — | **Legacy.** Reply to a `request` (section 7). Servers >= 2.0 never send `request`, so they ignore it. |

A message that fails validation is answered with an `error` carrying
`INVALID_MESSAGE`, `INVALID_PORT` or `UNKNOWN_TYPE`. After more than 50 invalid
messages the server closes the connection with `4001`. Malformed input never
affects other connections.

### 4.2 Server -> device

| `type` | Fields | Description |
|---|---|---|
| `hello` | `protocolVersion` (2), `features` (`["binary-data","flow-control"]`) | First message on every connection. |
| `registered` | `tunnelId`, `publicUrl`, `ownerSecret`, `protocol`, `allocatedPort` (int \| null), `localPort` | Answer to `register`. `publicUrl` is `tcp:<port>` for TCP tunnels and e.g. `https://<subdomain>.example.com` for HTTP tunnels. The device must store `tunnelId` + `ownerSecret` (file mode 0600) to reconnect later. |
| `reconnected` | `tunnelId`, `publicUrl`, `allocatedPort`, `localPort`, `protocol` | Answer to a successful `reconnect`. TCP tunnels keep their public port whenever it is free. |
| `standby` | `tunnelId` | The tunnel is paused in the dashboard: stay connected, expect no traffic. Sent after `registered` (when a new registration inherited a pause) or instead of `reconnected`. Resuming in the dashboard closes the connection; the device reconnects and gets `reconnected`. |
| `tcp-open` | `connId` (UUID), `tunnelId`, `localPort` | A public client connected (TCP tunnel) or an HTTP request arrived (HTTP tunnel): open a TCP connection to `localhost:<localPort>`. Devices must only accept ports of their own configured tunnels (and, when `tunnelId` is present, only the tunnel this device registered for that port); otherwise they reply `tcp-close {connId}` without opening any local connection (the reference device also logs a rate-limited warning). A server can therefore never reach a local port the device owner did not configure. |
| `tcp-close` | `connId` | See section 5. |
| `tcp-pause` / `tcp-resume` | `connId` | v2 flow control (section 6). Sent only to v2 connections. |
| `tcp-data` | `connId`, `data` (base64) | Tunnel data for **v1** connections. |
| `reboot` | — | Dashboard asked the device to reboot. Devices ignore it unless the owner opted in (`allow_reboot`). |
| `error` | `message`, `code?`, `tunnelId?`, `localPort?` | See section 8. |

## 5. Streams (`connId`) and close semantics

Every public TCP connection and every proxied HTTP request is one **stream**,
identified by a random UUID `connId` chosen by the server in `tcp-open`.

* Data for a stream flows in both directions as DATA frames (v2) or
  `tcp-data` (v1), in order.
* `tcp-close {connId}` means **"I will send no more data for connId"**
  (a half-close, like TCP FIN). Each side sends it **at most once** per
  `connId`: when its local socket emitted `end`, or when it closed/errored,
  whichever happens first.
* On receiving `tcp-close`, a side calls `end()` on its local socket (flushing
  data already received) and forgets the `connId` once that local socket has
  closed. The stream is finished when both sides sent `tcp-close`.
* A device that cannot or will not connect (port not allowed, connection
  refused) replies `tcp-close` straight away; the server then closes the
  public connection.
* Duplicate `tcp-close` messages and messages for unknown `connId`s are ignored.
* When the WebSocket closes, every stream on it is torn down (public
  connections are reset).

## 6. Flow control (v2)

Two mechanisms keep memory bounded on both sides:

1. **Per stream.** When writing received data to the local socket returns
   `false` (its buffer is full), send `tcp-pause {connId}` to the peer; on that
   socket's `drain`, send `tcp-resume {connId}`. On receiving `tcp-pause`,
   stop reading the local socket of that stream; on `tcp-resume`, read again.
   The server applies the same rule to its public sockets (it pauses the
   device when a public client reads slowly, with a 1 MiB per-stream buffer).
2. **Per WebSocket.** Each side stops reading *all* local sockets while its
   WebSocket's `bufferedAmount` is above a high-water mark (8 MiB) and resumes
   once it drops below the low-water mark (1 MiB), checked from the `send`
   completion callbacks.

**Pause and close are independent.** `tcp-close` only ends one direction of
a stream; it does not cancel a `tcp-pause`. A side that was paused stays
paused after the peer's `tcp-close` until it receives `tcp-resume`, and a
`tcp-resume` may still arrive after `tcp-close` (the server sends it as soon
as the public client reads again). Receivers must accept `tcp-resume` for a
half-closed stream. The reference device gives up a stream that the server has
half-closed and keeps paused for **5 minutes**: it aborts the local socket.

A peer that keeps sending more than 32 MiB for one stream after being paused
is considered broken: the server drops that stream (and, for v2 peers, counts
it as a protocol violation). v1 peers cannot be paused, so for them this cap is
the only bound. The reference device applies a similar bound when talking to a
v1 server: if more than 64 MiB pile up for one local socket, it closes that
connection.

## 7. HTTP tunnels

HTTP tunnels use the same stream mechanism: for each incoming request the
server's HTTP proxy opens a stream with `tcp-open {localPort: <http tunnel
port>}` and speaks HTTP/1.1 over it (one request per stream, `Connection:
close`). The device just pipes bytes to its local web server; no HTTP
awareness is needed on the device. Request and response bodies are streamed
with backpressure; WebSocket and other `Upgrade` requests are passed through.

The proxy routes by `Host: <subdomain>.<DOMAIN>` (only hosts under `DOMAIN`),
or, for hosts outside `DOMAIN` such as a bare IP address, by `?tunnel=<tunnelId>`
(all tunnels then share one browser origin, so use that only for testing). It regenerates `X-Forwarded-For`,
`X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Real-IP`, drops hop-by-hop
headers, strips any `Domain=` attribute from `Set-Cookie` (cookies stay
host-only) and blocks `Strict-Transport-Security` / `Public-Key-Pins` from
tunnelled applications.

**Legacy (servers < 2.0 only):** old servers send
`{"type":"request","id","method","path","headers","body"}` (body base64 or
null) and expect `{"type":"response","id","statusCode","headers","body","bodyEncoding":"base64"}`.
Current servers never send `request`; devices keep handling it for old
servers, restricted to their configured HTTP tunnel ports.

## 8. Errors

`error` messages always carry a human-readable `message`; machine-readable
fields are optional so old devices keep working.

| `code` | When | Extra fields | Device reaction |
|---|---|---|---|
| `TUNNEL_NOT_FOUND` | `reconnect` failed: unknown tunnel, wrong `ownerSecret`, or the tunnel belongs to a different token. `message` is always `Tunnel not found for reconnect`. | `tunnelId` (always) | Re-register **only that tunnel** (`register` with the same local port). |
| `TUNNEL_LIMIT` | The token already has `MAX_TUNNELS_PER_TOKEN` (default 10) tunnels attached to live connections (counted across all connections of the token; admin-token connections are limited per connection). | `localPort` (register) or `tunnelId` (reconnect) | Do not retry in a loop. |
| `INVALID_PORT` | `localPort` missing or outside 1..65535. | | Fix configuration. |
| `INVALID_MESSAGE` | Malformed JSON, wrong field types, bad UUIDs, bad `protocol`. | | Bug in the device. |
| `UNKNOWN_TYPE` | Unknown `type`. | | Ignore (newer device, older server). |
| *(none)* | Operational problems, e.g. `No public TCP port available for this tunnel`, `Registration failed`. | `tunnelId`, `localPort` when known | Log. |

## 9. WebSocket close codes

| Code | Meaning | Device reaction |
|---|---|---|
| `1000` | Normal closure (e.g. tunnel paused/resumed or removed in the dashboard). | Reconnect. |
| `1001` | Server shutting down. | Reconnect with backoff. |
| `1009` | Frame larger than 1 MiB. | Bug in the device. |
| `4000` | Token revoked or deleted. | Log "token revoked or invalid", retry at maximum backoff (the upgrade will get 401 until the token is re-activated). |
| `4001` | Protocol violation (too many invalid messages). | Reconnect with backoff; fix the device. |
| `4003` | Superseded: a newer connection with the same token exceeded `MAX_CONNECTIONS_PER_TOKEN` (default 4); the **oldest** connection is closed. | Reconnect with backoff (normally the newer connection is this device's own replacement socket). |

## 10. Ownership rules

* A tunnel belongs to the token that created it (`null` for the admin token).
  `reconnect` requires the correct `ownerSecret` **and** the same token.
* A device that lost its state and registers the same local port and protocol
  again with the same token replaces its own stale (offline) record and keeps
  its public TCP port. Records of other tokens are never touched.
* HTTP subdomains are unique across owners: if the requested subdomain is taken
  by another owner the server appends `-2`, `-3`, ... (see `publicUrl`).
* Upgrade from 1.x: tunnel records written by servers older than 2.0 have no
  owner token. Such a record is claimed once, by the first `reconnect` that
  presents its correct `ownerSecret`; from then on it belongs to that token.
  This keeps existing devices on their public TCP ports across the upgrade.

## 11. Example (v2)

```
device -> server   GET /ws  Authorization: Bearer 3f9c...   X-TunnelVault-Protocol: 2
server -> device   101 Switching Protocols
server -> device   {"type":"hello","protocolVersion":2,"features":["binary-data","flow-control"]}
device -> server   {"type":"register","name":"pi","localPort":22,"protocol":"tcp"}
server -> device   {"type":"registered","tunnelId":"6f1c...","publicUrl":"tcp:10000","ownerSecret":"a1b2...","protocol":"tcp","allocatedPort":10000,"localPort":22}
                   (someone connects to server:10000)
server -> device   {"type":"tcp-open","connId":"0d3e...","tunnelId":"6f1c...","localPort":22}
device -> server   <binary 0x01 | 0d3e... | "SSH-2.0-OpenSSH_9.6\r\n">
server -> device   <binary 0x01 | 0d3e... | "SSH-2.0-PuTTY\r\n">
...
server -> device   {"type":"tcp-close","connId":"0d3e..."}      (public client closed)
device -> server   {"type":"tcp-close","connId":"0d3e..."}      (local socket ended)
```

The same exchange with a v1 peer uses `{"type":"tcp-data","connId":"0d3e...","data":"U1NILTIuMC4uLg=="}`
text frames instead of binary frames and has no `tcp-pause`/`tcp-resume`.

## 12. Reference device behaviour

What the `tunnelvault` client (2.0) does beyond the wire rules above. Other
device implementations should behave the same way.

| Topic | Behaviour |
|---|---|
| Upgrade request | Always sends `Authorization: Bearer <token>`, `X-TunnelVault-Protocol: 2` and `User-Agent: tunnelvault-client/<version>`. A token found in a legacy `?auth_token=` server URL is removed from the URL and sent as the Bearer header instead. Redirects are not followed. Handshake timeout 15 s. |
| Plaintext warning | Warns when the server URL is `ws://` and the host is neither localhost nor a private address (the token would cross the network unencrypted). |
| `register` vs `reconnect` | Sends `reconnect` only for a saved `tunnelId` that is a UUID and has an `ownerSecret`; anything else is registered afresh. |
| Saved state | `tunnelId` + `ownerSecret` per local port in `state.json` (directory 0700, file 0600, written atomically). Location: `$TUNNELVAULT_STATE_DIR`, default `~/.tunnelvault`; the systemd service installed by `install-client.sh` uses `/var/lib/tunnelvault`. Without it the device registers afresh; a 2.0 server then still returns the previous TCP port when the token, local port and protocol are the same and the port is free (section 10). |
| `TUNNEL_NOT_FOUND` | Re-registers only the tunnel named by `tunnelId`. With old servers that send no `tunnelId`, it re-registers only the reconnects that failed. |
| Reconnect backoff | Starts at 1 s and doubles up to 30 s. It resets only after a connection stayed up for at least 10 s, so a server that accepts and immediately drops the connection is not hit once per second. |
| Close `4000`, HTTP `401` | Logs "token revoked or invalid" and keeps retrying at the maximum backoff (30 s), so a re-activated token reconnects by itself. |
| Close `4003`, HTTP `429` | Retries at the maximum backoff. |
| Keepalive | WebSocket ping every 15 s; reconnects after 35 s without any incoming frame (section 1). |
| `hello` | Honoured once, before the first `tcp-open` only (section 2). |
| `tcp-open` allowlist | Only configured local ports, and only this device's own `tunnelId` for that port; everything else gets `tcp-close` and no local connection (section 4.2). |
| Pause after close | A pause survives the peer's `tcp-close`; a half-closed stream that stays paused is given up after 5 minutes (section 6). |
| Legacy `tcp-data` | At most 190 KiB of raw bytes per message. |
| v1 servers | No flow control exists; more than 64 MiB buffered for one local socket closes that connection. Legacy `request` messages are proxied only to configured HTTP tunnel ports (fallback: the first HTTP tunnel), hop-by-hop headers are stripped and responses are capped at 700 KiB (larger ones get `502`). |
| `reboot` | Ignored unless remote reboot is enabled: config `"allow_reboot": true` or `TUNNELVAULT_ALLOW_REBOOT=1` (the environment variable overrides the config in both directions). Runs `sudo -n systemctl reboot`, then `sudo -n reboot`; as root without sudo. |
| Server text | Control characters are stripped from every server-supplied string before it is displayed or logged. |
