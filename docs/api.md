# HTTP API

The console's JavaScript calls these endpoints. All of them use the session cookie
set at sign-in.

## Conventions

- Request bodies for `POST` endpoints under `/api/` are JSON objects
  (`Content-Type: application/json`).
- Every `POST` under `/api/` must carry the session's CSRF token in the
  `X-CSRF-Token` header. The token is in the page's
  `<meta name="csrf-token">` tag. A missing or wrong token returns `403`.
- Unexpected server failures return `500` with
  `{"error": "Internal error. See the service log."}`.
- Successful actions return `200` with `{"message": "..."}`.
- Failures return `{"error": "..."}` with the status shown per endpoint.
- A request without a valid session receives a `302` redirect to `/login`.
- An admin-only endpoint called by a `user` account returns `403` with
  `{"error": "Admin role required"}`.
- Responses under `/api/` carry `Cache-Control: no-store`.

## Pages and session

| Method | Path | Access | Result |
|---|---|---|---|
| GET | `/` | signed in | The console page |
| GET | `/login` | public | The sign-in page. Redirects to `/` when already signed in. |
| POST | `/login` | public | Form fields `username`, `password`. Redirects to `/` on success. Re-renders the page with an error on failure. Returns `429` after five failures from one address within 15 minutes. |
| GET | `/logout` | any | Clears the session and redirects to `/login` |

## Clients

### GET /api/clients

Access: signed in.

Returns an array with one object per client that is present in the PKI index and
absent from the hidden list. The `ca` and `server` certificates are excluded.

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Certificate CN |
| `username` | string | VPN username, `-` when unmapped |
| `status` | string | `Valid`, `Revoked`, or `Expired` |
| `expiry` | string | Certificate expiry, `YYYY-MM-DD HH:MM:SS`, UTC |
| `password` | string or null | For `admin`: the VPN password, `-` when none is stored or the stored value fails its integrity check. For `user`: always `null`. |
| `limit` | number | Device limit, `0` for unlimited |
| `connected` | boolean | True when the client has a session, or had one within the last 120 seconds |
| `devices` | array | One object per connected device: `real_address`, `port`, `virtual_address`, `bytes_received`, `bytes_sent` |
| `real_address`, `port`, `virtual_address` | string | Comma-separated values across devices, `-` when offline |
| `bytes_received`, `bytes_sent` | number | Totals across devices |

### GET /api/system/stats

Access: signed in.

| Field | Type | Meaning |
|---|---|---|
| `cpu_percent` | number or null | Host CPU use since the worker's previous sample, from `/proc/stat` |
| `memory_percent` | number or null | Memory in use (total minus available), from `/proc/meminfo` |
| `vpn_status_age` | number or null | Seconds since OpenVPN last wrote its status file. The console shows the VPN as online while this is 60 or less. |

A value is `null` when it cannot be read.

### GET /api/ca/defaults

Access: signed in.

Returns the default certificate subject fields: `country`, `province`, `city`,
`org`, `ou`, `email`.

### POST /api/clients/create

Access: admin.

| Field | Required | Rule |
|---|---|---|
| `name` | yes | Certificate CN. Letters, digits, `-`, `_`, at most 64 characters. Must be unused. |
| `username` | yes | Email address, at most 254 characters, in an allowed domain when domains are configured |
| `password` | yes | VPN password, at most 128 characters, free of control characters |
| `limit` | no | Integer, default `1`, `0` for unlimited |
| `country`, `province`, `city`, `org`, `ou`, `email` | no | Certificate subject fields, each at most 64 characters, free of control characters and `/` |

Errors: `400` for a missing or invalid field or a duplicate name. `500` with the
Easy-RSA error text when certificate generation fails.

### GET /api/clients/download/{name}

Access: signed in.

Returns the client's profile with `Content-Type: application/x-openvpn-profile`
and a `Content-Disposition` attachment header. The profile is built on demand when
the stored file is missing.

Errors: `400` for a name with other characters. `404` when the client is unknown,
or when the profile is missing and the builder script is absent. `500` when
building fails.

### POST /api/clients/revoke

Access: admin. Body: `{"name": "<CN>"}`.

Revokes the certificate, regenerates the revocation list, installs it for OpenVPN,
and restarts the OpenVPN service.

Errors: `400` when `name` is missing or malformed, or the certificate file is
missing and has no copy in `certs_by_serial`. `500` with the Easy-RSA error text when revocation
fails.

### POST /api/clients/delete

Access: admin. Body: `{"name": "<CN>"}`.

Adds the name to the hidden list and removes its username mapping, device limit,
and stored profile. The stored password is removed when no other client uses the
same username.

Errors: `400` when `name` is missing or malformed. `500` on a file error.

## Logs

### GET /api/logs

Access: signed in.

| Parameter | Values | Default | Meaning |
|---|---|---|---|
| `category` | `all`, `traffic`, `auth`, `tls`, `general` | `all` | Event category. `traffic` is shown as "Connections". |
| `severity` | `all`, `INFO`, `WARNING`, `ERROR` | `all` | Event severity |
| `limit` | integer | `100` | Maximum rows, clamped to 1 through 5000. A non-numeric value falls back to `100`. |
| `timeframe` | `all`, `30m`, `1h`, `24h`, `3d`, `1w`, `1m` | `all` | Recent window, based on timestamps in the log |
| `verbose` | `0`, `1` | `0` | `1` includes routine protocol lines |

Returns an array, newest event first.

| Field | Type | Meaning |
|---|---|---|
| `time` | string or null | Timestamp of the line in UTC, `YYYY-MM-DD HH:MM:SS`. Null when the line has none. |
| `severity` | string | `INFO`, `WARNING`, or `ERROR` |
| `category` | string | `traffic`, `auth`, `tls`, or `general` |
| `event` | string | Event name |
| `user` | string or null | VPN username of the session |
| `ip`, `port` | string or null | Source address and port |
| `cert_cn` | string or null | CN of the client certificate |
| `virtual_ip` | string or null | Address assigned inside the VPN |
| `platform` | string or null | Platform reported by the client |
| `client` | string or null | Client software reported by the client |
| `details` | string | Relevant part of the message |
| `routine` | boolean | True for routine protocol lines |
| `text` | string | The original log line |

`user`, `cert_cn`, `virtual_ip`, `platform`, and `client` are filled from any line
of the same session, so a row can carry values that appear elsewhere in the log.

Returns an empty array when the log file is missing.

## Console accounts

### GET /api/ui-users

Access: admin. Returns an array of `{"username", "role"}`.

### POST /api/ui-users/create

Access: admin. Body: `username`, `password`, `role` (`admin` or `user`, default
`user`). The username takes letters, digits, `.`, `_`, `@`, `-`, up to 64
characters. The password needs 8 to 128 characters.

Errors: `400` for a missing or invalid field, an invalid role, or an existing
username.

### POST /api/ui-users/update

Access: admin. Body: `username`, and either or both of `password` and `role`.
An empty `password` keeps the current one.

Errors: `400` for an unacceptable password, or when the change would leave no
`admin` account. `404` when the account is unknown.

### POST /api/ui-users/delete

Access: admin. Body: `{"username": "<name>"}`.

Errors: `400` when the target is the signed-in account, or when the deletion
would leave no `admin` account. `404` when the account is unknown.

### POST /api/ui-users/change-password

Access: signed in. Body: `current_password`, `new_password`. Changes the password
of the signed-in account.

Errors: `400` for a missing field, an unacceptable new password, or a wrong
current password. `404` when the
signed-in account no longer exists.
