# Explainer

A reference to every module, function, variable, and data structure in the
project. Read [project.md](project.md) first for the overall design.

## Contents

1. [settings.py](#settingspy)
2. [vpncrypto.py](#vpncryptopy)
3. [app.py](#apppy)
4. [verify-user-pass.py](#verify-user-passpy)
5. [limit-connections.py](#limit-connectionspy)
6. [static/app.js](#staticappjs)
7. [templates](#templates)
8. [static/style.css](#staticstylecss)
9. [scripts](#scripts)
10. [External file formats](#external-file-formats)

---

## settings.py

Loads the configuration file for the web app and both hooks.

### Module variables

| Name | Meaning |
|---|---|
| `BASE_DIR` | Directory that contains `settings.py`, the project directory |
| `CONFIG_ENV_VAR` | Name of the environment variable that can point at the configuration file: `OPENVPN_UI_CONFIG` |
| `CONFIG_PATH` | Path of the configuration file in use: the variable's value when set, otherwise `config.json` in `BASE_DIR` |
| `APP_REQUIRED` | Tuple of keys the web app needs: `pki_dir`, `data_dir`, `clients_dir`, `crl_file`, `openvpn_status`, `openvpn_log`, `openvpn_service`, `make_client_script`, `file_owner` |
| `CA_FIELDS` | Names of the six certificate subject fields: `country`, `province`, `city`, `org`, `ou`, `email` |
| `THEME_NAME_RE` | Pattern a theme variable name must match: `--` followed by lower-case letters, digits, and dashes |
| `THEME_VALUE_RE` | Pattern a theme value must match: letters, digits, `#`, parentheses, commas, dots, percent signs, spaces, and dashes, up to 60 characters |

### SettingsError

Exception raised when the configuration file is missing, unreadable, malformed,
or lacks a required key. The message names the file and the missing keys.

### Settings

Wraps the parsed configuration.

| Member | Returns |
|---|---|
| `get(key, default=None)` | The value of `key`. `default` when the key is absent, `null`, or an empty string. |
| `secret_key_file` | Configured path, or `secret.key` in `BASE_DIR` |
| `ui_users_file` | Configured path, or `ui-users.json` in `BASE_DIR` |
| `client_passwords_file` | `client-passwords.json` in `data_dir` |
| `client_limits_file` | `client-limits.json` in `data_dir` |
| `client_mappings_file` | `client-mappings.json` in `data_dir` |
| `deleted_clients_file` | `deleted-clients.json` in `data_dir` |
| `allowed_email_domains` | List of lower-cased domains with any leading `@` removed. A single string is accepted as a one-item list. |
| `ca_defaults` | Dict with all six `CA_FIELDS`, empty string for any the configuration omits |
| `session_minutes` | Integer of at least 1, default 15 |
| `session_cookie_secure` | Boolean, default false |
| `brand_name` | String, default `OpenVPN` |
| `theme_css` | CSS text built from the `theme` setting: one rule for `:root` (dark) and one for `body.light-theme`, holding the variables that pass both patterns. Empty when nothing valid is configured. |
| `_data_file(name)` | Helper that joins `data_dir` and a file name |

### load_settings(required=APP_REQUIRED)

Reads `CONFIG_PATH`, checks the content is a JSON object, checks every key in
`required` has a value, and returns a `Settings`. Raises `SettingsError`
otherwise. The hooks pass a shorter `required` tuple.

---

## vpncrypto.py

Encrypts and decrypts stored VPN passwords. The module docstring describes both
storage formats. [security.md](security.md) explains the design.

### Module variables

| Name | Value | Meaning |
|---|---|---|
| `V2_PREFIX` | `"v2:"` | Marks a value in the current format |
| `IV_LEN` | 16 | Bytes of random IV per password |
| `TAG_LEN` | 32 | Bytes of the HMAC-SHA256 tag |
| `MIN_KEY_LEN` | 16 | Shortest secret key accepted |

### Functions

| Function | Purpose |
|---|---|
| `read_secret_key(path)` | Returns the bytes of the key file. Raises `SecretKeyError` when the file is unreadable or shorter than `MIN_KEY_LEN`. |
| `_derive(key, label)` | Returns a 32-byte subkey: HMAC-SHA256 of `"openvpn-ui:" + label` under `key`. Labels in use are `enc` and `mac`. |
| `_keystream_xor(key, iv, data)` | XORs `data` with a keystream made of HMAC-SHA256(`key`, `iv` + 4-byte block counter) blocks. The same call encrypts and decrypts. |
| `encrypt_password(password, key)` | Returns a `v2` string: random IV, ciphertext under the `enc` subkey, tag under the `mac` subkey. |
| `decrypt_password(stored, key)` | Returns the password, or `None` when the value is empty, malformed, fails its tag, or decodes to invalid UTF-8. Reads `v2` values and values in the earlier untagged format. |

`SecretKeyError` is the exception `read_secret_key` raises.

---

## app.py

The Flask application. Sections follow the order of the file.

### Start-up

| Name | Meaning |
|---|---|
| `settings` | The `Settings` object from `load_settings()`. A `SettingsError` here stops the app with a clear message. |
| `app` | The Flask application object that gunicorn serves |
| `SECRET_KEY_FILE` | Path of the secret key, from settings |
| `ensure_secret_key(path)` | Creates the key on first start and returns its bytes. The key is written to a private temporary file and hard-linked to `path`, so one worker wins when several start together and the file is complete from the moment it exists. Raises when the key is unreadable. |
| `SECRET_KEY` | The key bytes. Also assigned to `app.secret_key` to sign sessions. |
| `app.permanent_session_lifetime` | Session lifetime, from `settings.session_minutes` |
| `SESSION_COOKIE_HTTPONLY`, `SESSION_COOKIE_SAMESITE`, `SESSION_COOKIE_SECURE` | Cookie flags: script access blocked, `Lax`, and the configured secure flag |

### Audit logging

| Name | Meaning |
|---|---|
| `audit_logger` | Logger named `openvpn_ui.audit`. Writes to standard error, which systemd stores in the journal. Format: time, the word `AUDIT`, then the message. |
| `audit(action, target='')` | Writes one entry with the signed-in username, the client address, an action name, and the object acted on. |

Action names: `login`, `login_failed`, `login_blocked`, `client_create`,
`client_download`, `client_revoke`, `client_delete`, `ui_user_create`,
`ui_user_update`, `ui_user_delete`, `password_change`.

### Password helpers

| Function | Purpose |
|---|---|
| `encrypt_password(password)` | `vpncrypto.encrypt_password` with `SECRET_KEY` |
| `decrypt_password(stored)` | The password for display, or `"-"` when none is stored or the value fails its check |

### Paths and constants

| Name | Meaning |
|---|---|
| `EASYRSA_DIR` | `pki_dir`. Easy-RSA commands run here. |
| `INDEX_TXT` | `pki/index.txt` under `EASYRSA_DIR`, the PKI's certificate index |
| `CLIENT_PASSWORDS`, `CLIENT_LIMITS`, `CLIENT_MAPPINGS`, `DELETED_CLIENTS` | Paths of the four client data files |
| `UI_USERS` | Path of the console accounts file |
| `OPENVPN_STATUS`, `OPENVPN_LOG` | Paths of OpenVPN's status file and log |
| `OPENVPN_SERVICE` | systemd unit restarted after a revocation |
| `CLIENTS_DIR` | Directory of stored profiles |
| `CRL_FILE` | Where the regenerated revocation list is installed |
| `MAKE_CLIENT_SCRIPT` | Profile builder script |
| `FILE_OWNER` | Account that owns data files and runs the builder |
| `ALLOWED_EMAIL_DOMAINS` | List of permitted domains for VPN usernames |
| `CA_ENV_VARS` | Maps each subject field name to its Easy-RSA environment variable, for example `country` to `EASYRSA_REQ_COUNTRY` |
| `CLIENT_NAME_RE` | Pattern for a certificate name: letters, digits, `-`, `_` |
| `EMAIL_RE` | Pattern for a well-formed email address |
| `CONNECTION_CACHE` | Per-worker dict, certificate CN to the last seen session data and time. Keeps a client "connected" for 120 seconds after it leaves the status file, which smooths gaps between status refreshes. |

### Validation and file helpers

| Function | Purpose |
|---|---|
| `valid_client_name(name)` | True for a string that matches `CLIENT_NAME_RE` |
| `valid_vpn_username(username)` | True for a well-formed email in an allowed domain or one of its subdomains. With no domains configured, any well-formed email passes. |
| `chown_to_file_owner(path)` | Gives `path` to `FILE_OWNER`. Silent when the account is absent or the process lacks the right. |
| `client_profile_path(name)` | Path of a client's stored profile |
| `write_private_file(path, data)` | Atomic replace: writes `data` to a temporary file created private in the same directory, syncs it, sets its owner, and renames it over `path`. Removes the temporary file on failure. |
| `PROFILE_MAX_BYTES` | Largest builder output accepted, 1 MiB |
| `build_client_profile(name)` | Runs the builder as `FILE_OWNER`, opens its output once with `O_NOFOLLOW`, checks the opened file is a regular file within the size limit, stores it with `write_private_file`, and removes the builder's copy. Does nothing when the builder produced no file. |
| `load_json(filepath, default)` | Parsed content of a data file. Returns `default` when the file is missing, unreadable, unparseable, or of a different JSON type than `default`. Problems other than absence are logged. |
| `save_json(filepath, data)` | Serialises `data` and writes it with `write_private_file`. Errors propagate. |
| `data_lock()` | Context manager holding an exclusive `flock` on `.openvpn-ui.lock` in `data_dir`. Shared by all workers. |
| `locked(f)` | Decorator that runs a view inside `data_lock()` |
| `init_db_files()` | Under the lock, creates each data file that is missing with empty content. Runs at import. |

### Request helpers

| Name | Purpose |
|---|---|
| `MAX_FIELD_LEN` | Default length limit for text fields, 256 |
| `CONTROL_CHARS_RE` | Matches ASCII control characters, including newline and DEL |
| `json_body()` | The request body as a dict. A missing body or a body of another JSON type yields an empty dict. |
| `text_field(data, key, default="")` | A stripped string field. A value of another type yields `default`. |
| `acceptable_text(value, max_len)` | True when the value fits the limit and holds no control characters |
| `UI_USERNAME_RE` | Pattern for a console username |
| `UI_PASSWORD_MIN_LEN` | Minimum console password length, 8 |
| `ui_password_problem(password)` | A message describing why a console password is unacceptable, or `None` |
| `api_internal_error(error)` | Handler for HTTP 500. API paths get a JSON error body. Details stay in the service log. |

### Access control

| Name | Purpose |
|---|---|
| `current_account()` | The signed-in user's record as stored now, or `None` |
| `login_required(f)` | Decorator. Redirects to `/login` without a session. Re-reads the account on each request: a deleted account loses its session, and the session's role is refreshed from the file. |
| `admin_required(f)` | Decorator. Returns `403` unless the session role is `admin`. |
| `inject_branding()` | Template context processor. Gives every template `brand_name` and `theme_css`. |
| `csrf_token()` | Returns the session's CSRF token, creating a random one on first use |
| `check_csrf()` | Runs before every request. For a `POST` under `/api/`, compares the `X-CSRF-Token` header with the session token in constant time and returns `403` on mismatch. |
| `LOGIN_MAX_FAILURES`, `LOGIN_WINDOW_SECONDS` | Throttle settings: 5 failures in 900 seconds |
| `LOGIN_FAILURES` | Per-worker dict, client address to the times of its recent failures |
| `DUMMY_PASSWORD_HASH` | A hash checked when the username is unknown, so both cases take similar time |
| `login_blocked(address)` | Drops failures older than the window and reports whether the address has reached the limit |
| `record_login_failure(address)` | Appends the current time to the address's failures |
| `add_header(response)` | Runs after every request. Adds `Cache-Control: no-store` to API responses and `X-Content-Type-Options`, `X-Frame-Options`, and `Referrer-Policy` to all responses. |

Decorator order on a view is `@app.route`, `@login_required`, `@admin_required`,
`@locked`. Authentication and authorisation run before the lock is taken.

### PKI and status parsing

| Function | Purpose |
|---|---|
| `parse_expiry_date(date_str)` | Converts an index date (`YYMMDDHHMMSSZ` or the four-digit-year form) to `YYYY-MM-DD HH:MM:SS`. Returns the input unchanged when it has another shape. Index dates are UTC. |
| `extract_cn(dn)` | Pulls the CN out of a subject string in `/CN=name` or `CN=name,` form |
| `parse_index_txt()` | Reads `INDEX_TXT` and returns one dict per client certificate, skipping `ca`, `server`, and hidden names. Joins in the username, decrypted password, and limit. Later index lines for the same CN replace earlier ones, so the newest certificate wins. |
| `parse_status_log(clients)` | Reads `CLIENT_LIST` lines from the status file, maps each session's username back to its certificate CN, attaches devices and traffic totals to the matching clients, and applies the 120-second grace period from `CONNECTION_CACHE`. |
| `parse_ca_vars()` | Returns the default certificate subject fields: `settings.ca_defaults`, overridden by any `set_var EASYRSA_REQ_*` lines in the Easy-RSA `vars` file |
| `reload_openvpn_service()` | Starts `systemctl restart` for `OPENVPN_SERVICE` without waiting for it |

Client dict fields: `name`, `username`, `status`, `expiry`, `password`, `limit`,
`connected`, `real_address`, `port`, `virtual_address`, `bytes_received`,
`bytes_sent`, `devices`.

Index status letters: `V` valid, `R` revoked, `E` expired.

### Host statistics

| Name | Purpose |
|---|---|
| `CPU_SAMPLE` | Per-worker dict holding the previous `(busy, total)` CPU sample under the key `last` |
| `read_cpu_times()` | Reads the aggregate `cpu` line of `/proc/stat` and returns busy and total jiffies. Idle and I/O wait count as idle. |
| `read_cpu_percent()` | Busy share of the time since the worker's previous sample. The first call takes two samples 0.1 seconds apart. |
| `read_memory_percent()` | `(MemTotal - MemAvailable) / MemTotal` from `/proc/meminfo`, as a percentage |

### Page and session routes

| Function | Route | Purpose |
|---|---|---|
| `index_page()` | `GET /` | Renders the console with the username, role, CSRF token, brand name, and allowed email domains |
| `login_page()` | `GET, POST /login` | Shows the form. On `POST`: applies the throttle, checks the credentials, rebuilds the session, issues a CSRF token, and writes an audit entry. |
| `logout()` | `GET /logout` | Clears the session |

### API routes

[api.md](api.md) documents parameters and responses.

| Function | Route | Notes |
|---|---|---|
| `api_clients()` | `GET /api/clients` | `parse_index_txt` then `parse_status_log`. Sets `password` to `null` for non-admins. |
| `api_system_stats()` | `GET /api/system/stats` | CPU and memory percentages and the age of the OpenVPN status file in seconds, `null` for a value that cannot be read |
| `api_ca_defaults()` | `GET /api/ca/defaults` | `parse_ca_vars()` |
| `api_create_client()` | `POST /api/clients/create` | Validates every field, runs `easyrsa gen-req` and `sign-req`, saves mapping, password, and limit, builds the profile |
| `api_download_client(name)` | `GET /api/clients/download/<name>` | Validates the name, rebuilds a missing profile, returns the file |
| `api_revoke_client()` | `POST /api/clients/revoke` | Restores a missing certificate file from `certs_by_serial` when possible, runs `easyrsa revoke` and `gen-crl`, installs the list at `CRL_FILE`, restarts OpenVPN |
| `api_delete_client()` | `POST /api/clients/delete` | Hides the name and removes its mapping, limit, and profile. Removes the password when no other certificate uses that username. |
| `api_logs()` | `GET /api/logs` | See "Log parsing" |
| `api_ui_users()` | `GET /api/ui-users` | Usernames and roles, without password hashes |
| `api_ui_users_create()` | `POST /api/ui-users/create` | Validates username, password, and role |
| `api_ui_users_update()` | `POST /api/ui-users/update` | Changes password, role, or both. Keeps at least one admin. |
| `api_ui_users_delete()` | `POST /api/ui-users/delete` | Refuses the signed-in account and the last admin |
| `api_ui_users_change_password()` | `POST /api/ui-users/change-password` | Changes the signed-in account's password after checking the current one |

### Log parsing

| Name | Meaning |
|---|---|
| `LOG_TS_RE` | Matches a leading `YYYY-MM-DD HH:MM:SS` timestamp |
| `LOG_PEER_RE` | Matches the peer prefix: optional `user/`, then protocol, source address, and source port, followed by the message. Named groups: `user`, `ip`, `port`, `msg`. |
| `LOG_USER_RES` | Patterns that find a username inside a message when the prefix has none |
| `LOG_EVENT_RULES` | Ordered list of `(pattern, event, category, severity, routine)`. The first matching pattern classifies the line. A named group `d` (or any named group) supplies the Details text. |
| `LOG_SESSION_FIELD_RES` | Patterns for facts a line reveals about its session: `cert_cn`, `virtual_ip`, `platform`, `client` |
| `LOG_SESSION_FIELDS` | The five fields copied across a session's rows: `user`, `cert_cn`, `virtual_ip`, `platform`, `client` |
| `LOG_SESSION_END_RE` | Matches the lines that end a client instance |
| `LOG_RESPONSE_CACHE` | Per-worker dict holding the last answer, keyed by query, with the log file's size and modification time |
| `LOG_MAX_ROWS` | Largest row count a request may ask for, 5000 |
| `LOG_MAX_LINE_LEN` | Characters of a line that are parsed, 2000 |

| Function | Purpose |
|---|---|
| `log_time_to_utc(time_str)` | Interprets a log timestamp as server local time and returns it in UTC |
| `parse_log_line(line)` | Splits a line into timestamp, peer prefix, and message, classifies it with `LOG_EVENT_RULES`, and extracts session facts. Lines that match no rule become event `Other` in category `general`, with severity guessed from the words `error`, `fatal`, `failed`, or `warn`. |
| `api_logs()` | Applies the time window, parses the tail of the log, correlates sessions, filters, and returns the newest rows first |

Entry fields returned by `parse_log_line`: `time`, `severity`, `category`,
`event`, `user`, `ip`, `port`, `cert_cn`, `virtual_ip`, `platform`, `client`,
`details`, `routine`, `text`, and `ends_session` (removed before the response).

How `api_logs` works:

1. Reads the query parameters and clamps `limit`.
2. Returns the cached answer when the query is the same and the log file's size
   and modification time are unchanged. Time-window queries skip the cache.
3. Reads the file, tracking the most recent timestamp seen, and keeps the lines
   inside the requested window as `candidates`.
4. Parses the last `window` candidates, where `window` starts at
   `max(2000, limit * 30)`.
5. Keeps a `sessions` dict keyed by `ip:port`. Each line's facts update its
   session. A line that ends a client instance removes the session, so a reused
   source port starts fresh.
6. Applies the routine, severity, and category filters.
7. When fewer than `limit` rows matched and older candidates remain, multiplies
   `window` by 4 and repeats from step 4.
8. Takes the newest `limit` rows, fills each row's empty session fields from its
   session, and returns them newest first.

Categories: `traffic` (shown as Connections), `auth`, `tls`, `general`.

---

## verify-user-pass.py

OpenVPN's `auth-user-pass-verify` hook, in `via-file` mode. OpenVPN passes the
path of a temporary file with the username on line 1 and the password on line 2.
Exit status `0` accepts the login and `1` rejects it.

| Function | Purpose |
|---|---|
| `log(message)` | Writes a line to standard error with the prefix `verify-user-pass:`. OpenVPN copies it to its log. |
| `main()` | Loads settings (requires `data_dir`), reads the credentials file, looks up the username in the passwords file, reads the secret key, decrypts the stored value, and compares it with the submitted password in constant time |

Every failure path exits with `1`: missing argument, unreadable settings,
unreadable credentials, empty fields, unreadable password database, unknown
username, unreadable key, a stored value that fails its integrity check, or a
wrong password. Log messages carry the username only.

---

## limit-connections.py

OpenVPN's `client-connect` hook. OpenVPN provides the session's common name in
the environment variable `common_name`. With `username-as-common-name` that value
is the VPN username.

`main()`:

1. Exits `0` when `common_name` is unset.
2. Loads settings (requires `data_dir` and `openvpn_status`). Exits `1` when
   settings cannot be loaded.
3. Maps the username to its certificate CN through the mappings file.
4. Reads that CN's limit, default `1`. A limit of `0` exits `0` at once.
5. Counts `CLIENT_LIST` lines in the status file that carry this common name.
6. Exits `1` with a "Rejecting connection" message when the count has reached the
   limit, otherwise `0`.

Local variables: `mappings_file`, `limits_file`, `cert_cn`, `limit`,
`status_log`, `count`.

---

## static/app.js

The console's behaviour. Plain JavaScript, loaded at the end of `index.html`.

### CSRF wrapper

| Name | Meaning |
|---|---|
| `CSRF_TOKEN` | The token from the page's `<meta name="csrf-token">` tag |
| `nativeFetch` | The browser's original `fetch` |
| `window.fetch` | Replacement that adds the `X-CSRF-Token` header to every request other than `GET` and `HEAD` |

### State variables

| Name | Meaning |
|---|---|
| `clientsData` | Last client list from `/api/clients` |
| `defaultDNVals` | Default certificate subject fields from `/api/ca/defaults` |
| `cachedLogs` | Last rows from `/api/logs` |
| `cachedLogsSignature` | JSON text of `cachedLogs`, used to detect change |
| `activeLogTab` | Selected log category: `all`, `traffic`, `auth`, `tls`, `general` |
| `activeSeverityFilter` | Selected severity: `all`, `INFO`, `WARNING`, `ERROR` |
| `activePage` | Visible view: `dashboardPage`, `userManagementPage`, `logsPage` |
| `uiUsersData` | Last console account list |
| `revealedPasswords` | Set of certificate CNs whose password is currently shown |
| `statsInterval`, `clientsInterval`, `logsInterval`, `alertsInterval` | Timer handles for the four refresh loops |
| `LOG_CATEGORY_LABELS` | Display names for the log categories |
| `LOG_MUTED` | The dimmed dash shown for an empty table value |
| `VPN_STATUS_STALE_SECONDS` | Age of the status file beyond which the VPN is shown as offline, 60 |
| `ALERT_PANEL_ROWS` | Rows in the dashboard's Recent Alerts panel, 8 |
| `ALERT_FETCH_ROWS` | Rows requested per severity for the 24-hour counters, 1000 |

### Start-up and navigation

| Function | Purpose |
|---|---|
| `DOMContentLoaded` handler | Applies the saved theme, starts the UTC clock, shows the dashboard, wires the forms, loads defaults and clients, starts polling, and attaches the log table's scroll listener |
| `startPolling()` | Starts three 2-second timers (tiles, clients, and logs while the log view is open) and a 15-second timer for the alert summary |
| `stopPolling()` | Clears the timers |
| `switchPage(pageId)` | Shows one view, marks its sidebar entry, sets the page title from the entry's `data-title`, closes the drawer, and loads that view's data |
| `toggleTheme()` | Switches light and dark and stores the choice in `localStorage` under `theme` |
| `updateThemeLabel()` | Sets the theme button's text to the theme a click switches to |
| `toggleSidebar(open)` | Opens or closes the navigation drawer used on narrow screens. Toggles when called without an argument. |
| `updateUtcClock()` | Writes the current UTC date and time into the top bar. Runs every second. |

### Dashboard

| Function | Purpose |
|---|---|
| `fetchSystemStats()` | Computes Active Tunnels (connected devices) and Total Profiles from `clientsData` |
| `fetchHostStats()` | Loads `/api/system/stats`, fills the CPU and memory tiles (showing `--%` for a missing value), and passes the status file's age to `showVpnStatus` |
| `showVpnStatus(ageSeconds)` | Sets the top bar's VPN pill to Online, Offline, or unknown |
| `fetchAlertSummary()` | Loads the last 24 hours of errors and of warnings, fills the four alert counters and the sidebar's error count, and passes the newest rows to `renderAlertPanel` |
| `setAlertStat(name, text, alarmClass)` | Writes one counter and outlines its card when the value is above zero |
| `renderAlertPanel(rows)` | Builds the Recent Alerts table |
| `openAlertsInEventLog()` | Opens the Event Log with the window set to 24 hours and the severity set to errors |
| `fetchCAStatus()` | Loads the default certificate fields |
| `fetchClients()` | Loads the client list, redirects to `/login` when the session has ended, and re-renders |
| `renderClients(clients)` | Filters by the search box and builds the table rows. Every value passes through `escapeHtml`. Buttons carry the client name in a `data-name` attribute. |
| `filterClientsTable()` | Re-renders after the search box changes |
| `togglePasswordReveal(el, clientName)` | Shows or masks one client's password |
| `generateRandomPassword()` | Fills the password field with 16 characters chosen with `crypto.getRandomValues` from a 64-symbol alphabet |
| `downloadClient(name)` | Navigates to the download endpoint with the name URL-encoded |
| `confirmRevokeClient(name)`, `confirmDeleteClient(name)` | Open the confirmation dialog and send the request on confirm |
| `formatBytes(bytes)` | Formats a byte count with a binary unit |

Local helpers inside `renderClients`: `safeName` (escaped CN), `realAddress`
(`address:port` per device with its VPN address beneath), `expiryDate` (date part
of the expiry), `statusBadge`, `connectionStatus`, `bandwidth`, `actionButtons`,
`limitLabel`, `isPasswordRevealed`, `passwordDisplay`, `passwordBg`.

### Dialogs and forms

| Function | Purpose |
|---|---|
| `openModal(modalId)`, `closeModal(modalId)` | Show and hide a dialog. Opening the create dialog fills the default fields. |
| `populateDefaults()` | Copies `defaultDNVals` into the certificate fields |
| `initFormHandlers()` | Attaches submit handlers for the create-client, create-user, and edit-user forms. Each collects the fields, posts JSON, shows a toast on success, and shows the server's error text on failure. |
| `showToast(message)` | Shows a notice for 3 seconds |

### Console accounts

| Function | Purpose |
|---|---|
| `fetchUIUsers()` | Loads the account list |
| `renderUIUsers(users)` | Builds the account rows with escaped values and `data-` attributes |
| `openEditUserModal(username, role)` | Opens the edit dialog. The role selector is disabled for the signed-in account. |
| `confirmDeleteUIUser(username)` | Confirms and deletes an account |

### Logs

| Function | Purpose |
|---|---|
| `fetchLogs(force = false)` | Loads rows for the current filters. With `force`, redraws and returns to the top. Without it (the timer), redraws only when the data changed and the reader is at the top. When the reader has scrolled down and new data arrived, shows the paused pill. |
| `setLogsPaused(paused)` | Shows or hides the paused pill |
| `jumpToLatestLogs()` | Redraws from `cachedLogs`, scrolls to the top, hides the pill |
| `icon(name)` | Markup for an icon from the SVG sprite |
| `avatar(name, online)` | A round badge with the first letter of a name, marked when the session is live |
| `escapeHtml(value)` | Replaces `&`, `<`, `>`, `"`, and `'` with HTML entities. `null` and `undefined` become an empty string. |
| `filterLogsBySearch(logs)` | Keeps rows whose raw line, event, user, certificate CN, virtual IP, client, or platform contains the search text |
| `renderLogsTable(logs)` | Builds two table rows per event: the visible row, and a hidden row holding the original line |
| `logSeverityCell(log, withCategory)` | Severity badge, with the category beneath it when asked |
| `logEventCell(log)` | Event name with the details beneath it |
| `logIdentityCell(log)` | Username with the certificate CN beneath it |
| `logNetworkCell(log)` | Source address and port with the VPN address beneath it |
| `toggleLogRaw(row)` | Shows or hides the original line. Does nothing while text is selected, so copying works. |
| `filterLogsConsole()` | Re-renders after the search box changes |
| `switchLogTab(tabId)`, `switchSeverityFilter(sevId)` | Change a filter and reload |
| `exportLogs()` | Builds a CSV of the rows shown and saves it. Local helpers: `columns` (header names and accessors) and `csvCell` (quoting and formula guard). |

### String.prototype.strip

A small alias for `trim()`, defined at the end of the file and used by the client
search box.

---

## templates

### index.html

The console page. Jinja variables: `username`, `role`, `csrf_token`,
`brand_name`, `email_domains`, `theme_css`.

| Element id | Role |
|---|---|
| `sidebar`, `sidebarBackdrop` | Navigation and the backdrop behind its drawer form |
| `navAlertCount` | Error count beside the Event Log entry |
| `pageTitle`, `utcClock`, `vpnStatusDot`, `vpnStatusText`, `themeToggleBtn` | Top bar parts |
| `currentUserDisplay` | Holds `data-role` and `data-username` for the script |
| `dashboardPage`, `userManagementPage`, `logsPage` | The three views. The accounts view is rendered for admins only. |
| `activeConnsStat`, `totalClientsStat`, `cpuUsageStat`, `ramUsageStat` | Summary counter values |
| `failedLoginsStat`, `tlsErrorsStat`, `probesStat`, `limitRejectsStat` and the matching `...Card` ids | 24-hour alert counters and their cards |
| `alertTableBody` | Recent Alerts table body |
| `clientSearchInput`, `clientTableBody` | Client search box and table body |
| `uiUserTableBody` | Account table body |
| `logLimitSelector`, `logTimeframeSelector`, `logSearchInput`, `logVerboseToggle` | Log controls |
| `logTableScroll`, `logTableBody`, `logPausedPill` | Log scroll container, table body, and paused pill |
| `createModal`, `createUserModal`, `editUserModal`, `confirmModal` | Dialogs |
| `createClientForm` with `clientUsernameInput`, `clientNameInput`, `clientPasswordInput`, `clientLimitInput`, `dnCountry`, `dnProvince`, `dnCity`, `dnOrg`, `dnOU`, `dnEmail` | Create-client form fields |
| `createUserForm` with `uiUsernameInput`, `uiPasswordInput`, `uiRoleInput` | Create-account form fields |
| `editUserForm` with `editUiUsernameInput`, `editUiPasswordInput`, `editUiRoleInput` | Edit-account form fields |
| `confirmTitle`, `confirmMessage`, `confirmActionBtn` | Confirmation dialog parts |
| `toastNotification` | Notice area |

### login.html

The sign-in page. It uses the shared stylesheet and carries a small script for
the theme switch. Jinja variables: `brand_name`, `theme_css`, `error`. The form
posts `username` and `password` to `/login`.

---

## static/style.css

### Theme variables

Defined on `:root` for the dark theme and overridden under `body.light-theme`.

| Variable | Use |
|---|---|
| `--bg-page`, `--bg-surface`, `--bg-surface-alt`, `--bg-hover`, `--bg-code` | Page, panel, raised, hover, and code backgrounds |
| `--sidebar-bg`, `--sidebar-text`, `--sidebar-muted`, `--sidebar-heading`, `--sidebar-hover`, `--sidebar-active-bg`, `--sidebar-active-text`, `--sidebar-border` | Sidebar colours. Default to the surface and accent variables. |
| `--radius-lg` | Corner radius of panels and cards |
| `--border-color`, `--border-strong` | Dividers and control outlines |
| `--accent`, `--accent-hover`, `--accent-soft`, `--text-on-accent` | Main brand colour and the text placed on it |
| `--highlight`, `--highlight-text`, `--text-on-highlight` | Second brand colour for the logo mark, the top strip, and the role tag. Follows the accent unless a theme sets it. |
| `--text-color`, `--text-secondary`, `--text-tertiary` | Primary, muted, and faint text |
| `--status-success`, `--status-warning`, `--status-danger`, `--status-info`, each with a `-bg` form | Status colours and their tinted backgrounds |
| `--data-ip`, `--data-port` | Addresses and ports in tables |
| `--shadow-sm`, `--shadow-md` | Panel and dialog shadows |
| `--radius-sm`, `--radius`, `--transition-speed` | Corner radii and transition time |
| `--font-sans`, `--font-mono` | System font stacks |

A deployment overrides any of these through the `theme` setting. See
[configuration.md](configuration.md#colour-theme).

### Main class groups

| Classes | Use |
|---|---|
| `.sidebar`, `.logo-area`, `.logo-icon`, `.logo-words`, `.logo-text`, `.logo-sub`, `.nav-menu`, `.nav-section`, `.nav-tab`, `.nav-count`, `.sidebar-user`, `.sidebar-logout` | Sidebar navigation and account card |
| `.icon`, `.icon-sprite` | Inline SVG icons drawn from the sprite at the top of `index.html` |
| `.avatar`, `.avatar-sm`, `.identity`, `.session-pill`, `.all-clear` | Lettered avatars with a live marker, name blocks, session state, and the empty alert state |
| `.main-panel`, `.top-bar`, `.top-bar-title`, `.system-status`, `.status-pill`, `.role-tag`, `.theme-toggle`, `.nav-toggle`, `.sidebar-backdrop`, `.content-area` | Top bar and page frame |
| `.stats-grid`, `.stat-card`, `.stat-top`, `.stat-icon`, `.stat-label`, `.stat-value`, `.stat-meta`, `.meter`, `.meter-fill`, `.tone-accent`, `.tone-clear`, `.tone-neutral`, `.is-warning`, `.is-danger` | Dashboard counters, their icon chips, usage bars, and tone colours |
| `.main-card`, `.card-header`, `.header-left`, `.panel-icon`, `.panel-sub`, `.panel-tag`, `.table-container` | Panels and the scrolling table wrapper |
| `.client-table`, `.client-name-cell`, `.ip-cell`, `.actions-col`, `.actions-cell-wrapper`, `.password-cell` | Client and account tables |
| `.badge`, `.badge-success`, `.badge-danger`, `.badge-warning`, `.badge-info`, `.status-dot` | Status markers |
| `.btn`, `.btn-primary`, `.btn-danger`, `.btn-sm` | Buttons |
| `.form-input`, `.form-select`, `.field-label`, `.input-group`, `.input-grid-2`, `.field-hint` | Form controls |
| `.log-controls-row`, `.log-tabs`, `.log-tab`, `.severity-pill`, `.log-filter-group`, `.log-verbose-toggle` | Event log controls |
| `.log-table-wrapper`, `.log-table-scroll`, `.log-table`, `.log-row`, `.log-row-warning`, `.log-row-error`, `.log-raw-row`, `.log-col-*`, `.log-sub`, `.log-event-details`, `.log-paused-pill` | Event log and alert tables |
| `.modal-overlay`, `.modal`, `.modal-header`, `.modal-body`, `.modal-footer`, `.modal-section-title` | Dialogs |
| `.login-page`, `.login-panel`, `.login-brand`, `.login-submit`, `.login-notice`, `.login-theme-toggle` | Sign-in page |
| `.alert`, `.spinner`, `.toast`, `.hidden`, `.text-muted`, `.mono` | Feedback and utilities |

---

## scripts

### install.sh

| Variable | Meaning |
|---|---|
| `UI_DIR` | Project directory, derived from the script's own location |
| `SERVICE_NAME`, `SERVICE_FILE` | Name and path of the systemd unit |
| `CONFIG_FILE` | `config.json` in `UI_DIR` |
| `VENV_PY` | Python interpreter inside the virtual environment |
| `FILE_OWNER`, `OWNER_HOME` | Owning account and its home directory |
| `BIND_ADDRESS`, `BIND_PORT`, `BRAND_NAME`, `PKI_DIR`, `DATA_DIR`, `CLIENTS_DIR`, `CRL_FILE`, `STATUS_FILE`, `LOG_FILE`, `OPENVPN_SERVICE`, `MAKE_CLIENT`, `EMAIL_DOMAINS` | Answers to the deployment prompts |
| `ADMIN_USER`, `ADMIN_PASS`, `GENERATED_PASS` | Admin account answers. `GENERATED_PASS` is set only when the script generated the password. |

`ask VARIABLE "Prompt" "default"` reads one answer and stores the default when
the answer is empty.

The embedded Python block validates the admin username and password length,
merges the answers into any existing `config.json`, and adds the admin account to
`ui-users.json`. Its helper `write_private(path, payload)` writes JSON to a
temporary file with mode `600` and renames it into place.

[installation.md](installation.md) lists the steps the script performs.

### uninstall.sh

| Variable | Meaning |
|---|---|
| `UI_DIR` | Project directory, derived from the script's own location |
| `SERVICE_FILE` | Path of the systemd unit |
| `CONFIG_FILE` | `config.json` in `UI_DIR` |
| `DATA_DIR` | `data_dir` read from `config.json`. Empty when the file is absent, in which case the data files are left alone. |
| `CLEAN_DB`, `CLEAN_ENV` | Answers to the two removal questions |

---

## External file formats

### pki/index.txt

Easy-RSA's certificate index. One line per certificate, tab-separated:

| Position | Content |
|---|---|
| 0 | Status: `V`, `R`, or `E` |
| 1 | Expiry date, `YYMMDDHHMMSSZ` |
| 2 | Revocation date, empty for valid certificates |
| 3 | Serial number in hexadecimal |
| 4 | File name, usually `unknown` |
| 5 | Subject, containing `/CN=<name>` |

### OpenVPN status file, version 2

Comma-separated. The console reads the `CLIENT_LIST` lines:

| Position | Content |
|---|---|
| 0 | `CLIENT_LIST` |
| 1 | Common name (the username under `username-as-common-name`) |
| 2 | Real address, `proto:ip:port` |
| 3 | Virtual IPv4 address |
| 4 | Virtual IPv6 address |
| 5 | Bytes received |
| 6 | Bytes sent |
| 7 onward | Connected since, username, client id, peer id, cipher |

### OpenVPN log line

```
[YYYY-MM-DD HH:MM:SS ][user/]proto:ip:port message
```

Server-level lines carry the timestamp and message only. The `user/` part appears
after a client has authenticated.
