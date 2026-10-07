# Security

This document describes how the project protects access, what was reviewed, and
which limitations remain. Read it before deploying.

## Model

| Boundary | Mechanism |
|---|---|
| VPN access | Client certificate, plus username and password, plus a device limit |
| Console access | Username and password, session cookie signed with `secret.key` |
| Console privileges | `admin` and `user` roles, re-read from the accounts file on every request |
| State-changing requests | Per-session CSRF token required in the `X-CSRF-Token` header |
| Network exposure | The console listens on one address chosen at install time. The default is `127.0.0.1`. |

## Sensitive files

| File | Contains | Protection |
|---|---|---|
| `secret.key` | Session signing key and the key for VPN password encryption | Mode `600`, created atomically, excluded from version control |
| `config.json` | Deployment paths and addresses | Mode `600`, excluded from version control |
| `ui-users.json` | Console accounts with hashed passwords | Mode `600`, excluded from version control |
| `client-passwords.json` | Encrypted VPN passwords | Mode `600` |
| PKI `private/` directory | CA and client private keys | Easy-RSA defaults |
| Client profiles in `clients_dir` | Embedded client private keys | Mode `600`, directory mode `700` |

## Authentication and sessions

- Console passwords are stored as Werkzeug password hashes. New passwords need at
  least 8 characters.
- The session is cleared and rebuilt at sign-in, so a session identifier from
  before sign-in carries nothing forward.
- The session cookie is `HttpOnly` and `SameSite=Lax`. Set
  `session_cookie_secure` to `true` behind HTTPS.
- Each request re-reads the signed-in account. Deleting an account ends its
  session at once, and a role change takes effect at once.
- Five failed sign-ins from one address within 15 minutes block that address for
  the rest of the window. An unknown username costs the same hashing time as a
  known one.
- The last `admin` account is protected from deletion and demotion.

## Authorisation

| Data or action | `admin` | `user` |
|---|---|---|
| VPN passwords in `/api/clients` | returned | withheld (`null`) |
| Create, revoke, delete clients | allowed | refused with `403` |
| Manage console accounts | allowed | refused with `403` |
| Download profiles, read logs | allowed | allowed |

A profile holds a certificate and key. A VPN login also needs the password, which
a `user` account cannot read.

## Stored VPN passwords

VPN passwords are stored encrypted, and reversibly, because administrators read
them back in the console. `vpncrypto.py` implements the format, and the web app
and the auth hook share that one implementation.

Format `v2`: `"v2:" + base64(iv + ciphertext + tag)`.

1. Two keys are derived from `secret.key` with HMAC-SHA256 and distinct labels:
   one for encryption, one for authentication.
2. A random 16-byte IV is generated per password.
3. The keystream is HMAC-SHA256 of the IV and a block counter under the
   encryption key. It is XORed with the UTF-8 password.
4. The 32-byte tag is HMAC-SHA256 over the IV and ciphertext under the
   authentication key.

On reading, the tag is verified in constant time before decryption. A modified,
truncated, or wrongly keyed value is refused, and the auth hook rejects the login.

Values written by earlier versions (base64 of IV and ciphertext, no tag) remain
readable. Saving a password again stores it as `v2`.

The auth hook compares passwords in constant time and writes outcomes to
OpenVPN's log with the username only.

## File handling

- **Atomic, private writes.** Each data file is written to a temporary file that
  is created with mode `600`, flushed to disk, and renamed over the target.
  Readers see the previous content or the new content. The OpenVPN hooks read
  these files while the web app runs, so a partial file would reject logins.
- **Serialised updates.** Every change to the PKI or the data files runs under an
  exclusive file lock shared by all gunicorn workers. Two simultaneous changes
  both take effect.
- **Secret key creation.** The key is written to a private temporary file and
  hard-linked into place. Exactly one worker's key wins when several start
  together, and the file is complete from the moment it exists.
- **Profile builder output.** The app opens the builder's output once with
  `O_NOFOLLOW`, checks the opened file is a regular file of plausible size, and
  reads from that same handle. A symbolic link placed at that path is refused.
- **Failures surface.** A failed write raises an error that reaches the caller as
  an HTTP `500`. A data file with unparseable or wrongly shaped content is
  treated as empty for reading and logged.

## Input handling and encoding

| Input | Rule |
|---|---|
| Request bodies | Must be a JSON object. Fields of another JSON type count as absent. |
| Certificate name | Letters, digits, `-`, `_`, at most 64 characters. Checked on create, revoke, delete, and download, before any file path is built. |
| VPN username | Well-formed email address, at most 254 characters, in a configured domain when domains are configured |
| VPN password | At most 128 characters, free of control characters. OpenVPN passes the password to the hook as one line of a file. |
| Certificate subject fields | At most 64 characters, free of control characters and `/` |
| Console username | Letters, digits, `.`, `_`, `@`, `-`, at most 64 characters |
| Device limit | Integer, floor of `0` |
| Log query `limit` | Clamped to 1 through 5000 |
| Log lines | Truncated to 2000 characters before parsing. Undecodable bytes become a visible replacement character. |

Output encoding:

- Every value the page inserts into HTML passes through `escapeHtml`, in the log
  table and in the dashboard and account tables. Log lines and peer information
  contain text chosen by the connecting client.
- Click handlers read their arguments from `data-` attributes, which keeps every
  value out of inline script.
- Server-rendered templates use Jinja autoescaping.
- Colour overrides from the `theme` setting are placed in a style block. Each
  variable name and value is matched against a strict pattern first, and entries
  that fail are dropped.
- The pages load no fonts, scripts, or styles from other hosts, so a browser
  using the console contacts the console only.
- CSV export quotes every cell and prefixes cells that begin with `=`, `+`, `-`,
  or `@` with an apostrophe, so spreadsheet programs treat them as text.
- Easy-RSA and other system commands are started with argument lists, without a
  shell.

Response headers on every response: `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: same-origin`. API responses add
`Cache-Control: no-store`.

## Audit trail

Sign-ins, failed sign-ins, blocked sign-ins, client creation, revocation,
deletion, profile downloads, and console account changes are written to the
service log with the acting account and source address:

```bash
journalctl -u openvpn-ui.service | grep AUDIT
```

## Known limitations

| # | Limitation | Effect | Mitigation |
|---|---|---|---|
| 1 | The app serves plain HTTP. | Passwords and the session cookie are readable on the network path. | Bind to `127.0.0.1` and front it with a TLS reverse proxy. |
| 2 | VPN passwords are reversible by design. | Anyone holding `secret.key` and `client-passwords.json` recovers every VPN password. | Protect and back up both files together. Root on the host already holds both. |
| 3 | The service runs as root. | A code-execution flaw in the console gives control of the host. | Keep the console on a management network with few accounts. |
| 4 | Sign-in throttling and the caches live in each worker's memory. | With three workers an address gets up to three times the configured attempts, and counters reset on restart. | Add rate limiting at the reverse proxy for stronger guarantees. |
| 5 | Behind a reverse proxy the app sees the proxy's address. | Throttling and audit entries name the proxy. | Keep proxy access logs, or apply throttling at the proxy. |
| 6 | The device limit is checked against the status file, which OpenVPN refreshes periodically. | Two devices connecting within the same refresh interval can both pass the check. | Use a short status interval (1 second in the suggested configuration). |
| 7 | The page uses inline event handlers and styles. | A strict Content-Security-Policy would block the page, so none is set. | Output escaping is the defence in place. |
| 8 | The sign-in form carries no CSRF token. | A third-party page could sign a browser in to an account the attacker controls. | Low impact for an internal console. |
| 9 | A revocation restarts OpenVPN. | All clients disconnect until they reconnect. | Revoke during quiet periods. |

## Recommended deployment practice

- Bind the console to `127.0.0.1` or an internal management address and restrict
  access with a firewall.
- Put a TLS-terminating reverse proxy in front of it and set
  `session_cookie_secure`.
- Keep console accounts few and give `admin` only to people who issue clients.
- Run OpenVPN with timestamps enabled and rotate its log.
- Revoke a client's certificate and issue a new password whenever its profile or
  password may have been exposed.
- Back up `secret.key`, `client-passwords.json`, and the PKI directory together,
  to storage with the same protection as the server.

## Reporting a problem

Open an issue in the repository, or contact the author directly for anything that
should stay private until fixed.
