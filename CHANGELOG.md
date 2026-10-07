# Changelog

All notable changes to this project, oldest first within each date. Times are UTC.

## 2026-10-07

### 1. Log view rebuilt as a table

**Changed**
- `/api/logs` returns structured rows: `time`, `severity`, `category`, `event`,
  `user`, `ip`, `port`, `details`, `routine`, and the original line as `text`.
- A pattern table (`LOG_EVENT_RULES`) names each event and assigns its category,
  severity, and a routine flag.
- The log view is a table with the newest event at the top.
- The 2-second refresh keeps the reader's scroll position. While the reader is
  scrolled into older rows the table holds still and a "Live updates paused" pill
  appears. Scrolling to the top or clicking the pill resumes updates.
- Category tabs are Connections, Authentication, TLS Security, and General.

**Added**
- "Routine lines" toggle and the `verbose` query parameter. Routine protocol
  lines are hidden by default.
- Clicking a row shows the original log line.

**Fixed**
- Log text is HTML-escaped before it is placed in the page. Log lines contain
  text chosen by the connecting client.
- The forced scroll to the bottom of the log on every refresh is removed.

### 2. Dashboard client table layout

**Changed**
- The table wrapper has no border and no fixed height. The list grows with the
  page and the page scrolls.
- Fixed minimum column widths (1,660 px in total) are removed. Columns size to
  their content.
- Port is shown with the real address as `address:port`.
- Expiry shows the date, with the full timestamp on hover.
- Bandwidth is shown on two lines.
- Action buttons are icon-only with tooltips.

### 3. Incident-response fields and UTC

**Added**
- Lines from the same source address and port are correlated into a session.
  Every row of a session carries `user`, `cert_cn`, `virtual_ip`, `platform`, and
  `client`.
- Log table columns: Certificate CN, Source IP:Port, Virtual IP, Client.
- Search matches user, certificate CN, virtual IP, client, and platform.
- CSV export with every field and the original log line. Cells that begin with a
  formula character are prefixed so spreadsheet programs treat them as text.

**Changed**
- Log timestamps are converted from server local time to UTC and the column is
  labelled "Time (UTC)". The client table's expiry column is labelled
  "Expires (UTC)".
- A row shows a time only when its log line carries one. Earlier versions stamped
  untimed lines with the last timestamp seen in the file.
- Only the tail of the log is parsed, widening when a filter needs more rows. The
  last answer is reused while the log file is unchanged.

### 4. Timestamps restored in the OpenVPN log (deployment change)

**Changed**
- The `--suppress-timestamps` option was removed from the OpenVPN service's
  systemd drop-in on the production server. New log lines carry a timestamp, and
  the time column and the time-window filter work for them.

### 5. Dashboard tiles and table escaping

**Added**
- `GET /api/system/stats` returns host CPU and memory use read from `/proc/stat`
  and `/proc/meminfo`.

**Fixed**
- The CPU Usage and Memory Usage tiles show measured values. They previously
  showed random numbers.
- Every value in the client table and the console account table is HTML-escaped.
- Click handlers read names from `data-` attributes. Names were previously placed
  inside inline script.
- The client name is URL-encoded in the download link.

### 6. Configuration moved out of the code

**Added**
- `settings.py`: one loader for `config.json`, shared by the web app and both
  hook scripts. The file's location can be set with `OPENVPN_UI_CONFIG`.
- `config.example.json`: a template with placeholder values.
- Settings: `data_dir`, `clients_dir`, `crl_file`, `openvpn_service`,
  `make_client_script`, `file_owner`, `allowed_email_domains`, `ca_defaults`,
  `brand_name`, `secret_key_file`, `ui_users_file`, `session_minutes`,
  `session_cookie_secure`.
- The app stops at start-up with a message naming any missing required setting.

**Changed**
- Removed from the source: the listening address, file and directory paths, the
  owning account name, the OpenVPN unit name, the accepted email domain, default
  certificate subject values, and the organisation name in page titles and
  placeholders.
- `scripts/install.sh` asks for every deployment value, derives the project
  directory from its own location, and defaults the listening address to
  `127.0.0.1`.
- `scripts/uninstall.sh` reads the data directory from `config.json`.
- Both hook scripts run from the project directory and read their paths from
  settings.

### 7. Security hardening

**Added**
- `vpncrypto.py`: one implementation of VPN password encryption for the web app
  and the auth hook. New format `v2` adds an HMAC-SHA256 integrity tag and uses
  separate derived keys for encryption and authentication.
- CSRF protection: every `POST` under `/api/` must carry the session's token in
  the `X-CSRF-Token` header.
- Sign-in throttling: five failures from one address within 15 minutes block that
  address for the rest of the window.
- Audit entries in the service log for sign-ins, client actions, profile
  downloads, and account changes.
- Response headers `X-Content-Type-Options`, `X-Frame-Options`, and
  `Referrer-Policy`.
- Minimum length of 8 characters for console passwords, and a character set for
  console usernames.
- Protection for the last `admin` account against deletion and demotion.

**Changed**
- `/api/clients` returns VPN passwords to `admin` accounts only. Other accounts
  receive `null` and the table shows "Hidden".
- The session's account is re-read on every request. Deleting an account ends its
  session and a role change applies at once.
- The session is rebuilt at sign-in. The cookie is `HttpOnly` and `SameSite=Lax`,
  with an optional `Secure` flag.
- An unknown username costs the same hashing time at sign-in as a known one.
- The "Gen" button draws 16 characters from the browser's cryptographic random
  generator.
- The auth hook compares passwords in constant time.

**Removed**
- The debug log in `verify-user-pass.py`, which recorded submitted and stored
  passwords. The hook now reports outcomes to OpenVPN's log with the username
  only.
- The fallback that treated an undecryptable stored value as a plaintext
  password.

**Fixed**
- Revoke, delete, and download validate the client name before building any file
  path.
- The installer passes the admin password to Python through the environment. It
  was previously interpolated into Python source.

### 8. File handling, data integrity, and input handling

**Fixed**
- Data files are written to a private temporary file and renamed into place. They
  were previously written in place and restricted to mode `600` afterwards, which
  left a moment of wider permissions and exposed readers to partial content.
- Changes to the PKI and the data files run under a file lock shared by all
  workers. Simultaneous changes previously could overwrite one another.
- The secret key is created atomically with mode `600`. The app stops when the
  key is unreadable. It previously continued with a random key per worker, which
  would have stored passwords that nothing could decrypt.
- The profile builder's output is opened once without following symbolic links,
  checked to be a regular file of plausible size, and read from that handle.
- A failed write raises an error that reaches the caller. Write errors were
  previously logged and ignored.
- A data file with unparseable or wrongly shaped content is treated as empty and
  logged.
- Request bodies must be JSON objects and text fields must be strings. Other
  types previously caused a server error.
- Length limits on names, usernames, passwords, and certificate subject fields.
  Control characters are refused in passwords and subject fields, and `/` is
  refused in subject fields.
- The log endpoint clamps `limit` to 5000 rows and parses at most 2000 characters
  of a line.
- Undecodable bytes in the log are shown as a replacement character. They were
  previously dropped.
- Unexpected failures on API paths return a JSON error body.

### 9. Documentation

**Added**
- `README.md`, `LICENSE` (MIT), `CHANGELOG.md`.
- `docs/project.md`, `docs/installation.md`, `docs/configuration.md`,
  `docs/usage.md`, `docs/api.md`, `docs/explainer.md`, `docs/security.md`.

## Deployment status

Items 1 to 5 are running on the production server. Items 6 to 8 are in the
repository and have not been deployed there. `docs/installation.md` describes the
upgrade steps.
