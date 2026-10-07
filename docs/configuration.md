# Configuration

Every site-specific value lives in one JSON file. The source code holds no
addresses, account names, domains, or deployment paths.

## Where the file is

| Order | Location |
|---|---|
| 1 | The path in the `OPENVPN_UI_CONFIG` environment variable, when set |
| 2 | `config.json` in the project directory |

The web app and both OpenVPN hook scripts read the same file through
`settings.py`. The installer writes it. `config.example.json` is a template with
placeholder values. `config.json` is excluded from version control.

The web app reads the file once at start-up, so restart the service after editing
it. The hook scripts read it at each connection.

## Required settings

The web app stops at start-up with a message naming any of these that is missing.

| Key | Meaning | Example |
|---|---|---|
| `pki_dir` | Easy-RSA directory. Holds `./easyrsa`, `vars`, and `pki/`. | `/path/to/easy-rsa` |
| `data_dir` | Directory for the four client data files and the lock file | `/etc/openvpn/server` |
| `clients_dir` | Directory where client profiles are stored | `/etc/openvpn/clients` |
| `crl_file` | Where the regenerated revocation list is installed. Must equal the `crl-verify` path in the OpenVPN configuration. | `/etc/openvpn/server/crl.pem` |
| `openvpn_status` | OpenVPN status file. Must equal the `status` path. | `/etc/openvpn/server/openvpn-status.log` |
| `openvpn_log` | OpenVPN log file. Must equal the `log-append` path. | `/var/log/openvpn/openvpn.log` |
| `openvpn_service` | systemd unit restarted after a revocation | `openvpn-server@server` |
| `make_client_script` | Profile builder script | `/path/to/make-client.sh` |
| `file_owner` | Account that owns data files and profiles, and that the profile builder runs as | `openvpn` |

The hook scripts need fewer keys: `verify-user-pass.py` requires `data_dir`, and
`limit-connections.py` requires `data_dir` and `openvpn_status`.

## Optional settings

| Key | Meaning | Default |
|---|---|---|
| `bind_address` | Listening address. Used by the installer for the systemd unit and by `python app.py`. | `127.0.0.1` |
| `port` | Listening port, same usage | `8080` |
| `brand_name` | Name shown in the header, the sign-in page, and the page title | `OpenVPN` |
| `allowed_email_domains` | List of domains a VPN username may belong to. Subdomains of a listed domain are accepted. An empty list accepts any email address. | `[]` |
| `ca_defaults` | Object with `country`, `province`, `city`, `org`, `ou`, `email`. Pre-fills the certificate fields when the Easy-RSA `vars` file sets none. | all empty |
| `secret_key_file` | Path of the secret key | `secret.key` in the project directory |
| `ui_users_file` | Path of the console accounts file | `ui-users.json` in the project directory |
| `session_minutes` | Console session lifetime in minutes | `15` |
| `session_cookie_secure` | Set to `true` when the console is served over HTTPS, so the browser sends the session cookie over HTTPS only | `false` |
| `theme` | Colour overrides for the dark and light themes. See "Colour theme". | none |

## Example

```json
{
    "bind_address": "192.0.2.10",
    "port": 8080,
    "brand_name": "Example VPN",

    "pki_dir": "/srv/easy-rsa",
    "data_dir": "/etc/openvpn/server",
    "clients_dir": "/etc/openvpn/clients",
    "crl_file": "/etc/openvpn/server/crl.pem",
    "openvpn_status": "/etc/openvpn/server/openvpn-status.log",
    "openvpn_log": "/var/log/openvpn/openvpn.log",
    "openvpn_service": "openvpn-server@server",
    "make_client_script": "/srv/make-client.sh",
    "file_owner": "openvpn",

    "allowed_email_domains": ["example.edu"],
    "ca_defaults": {
        "country": "US",
        "province": "CA",
        "city": "Example City",
        "org": "Example Org",
        "ou": "IT",
        "email": "admin@example.edu"
    },

    "session_minutes": 15,
    "session_cookie_secure": false
}
```

## Colour theme

The console ships with a blue accent on dark and light neutral surfaces. A
deployment can replace any colour through the `theme` setting, which holds one
object per mode. Each object maps a CSS variable to a value.

```json
"theme": {
    "dark": {
        "--accent": "#34c27a",
        "--accent-soft": "rgba(52, 194, 122, 0.16)",
        "--text-on-accent": "#05190d",
        "--highlight": "#f2c230",
        "--text-on-highlight": "#1a1400"
    },
    "light": {
        "--accent": "#0b6b3a",
        "--accent-soft": "rgba(11, 107, 58, 0.1)",
        "--highlight": "#f2b705",
        "--highlight-text": "#8a6500",
        "--text-on-highlight": "#1a1400"
    }
}
```

| Variable | Used for |
|---|---|
| `--bg-page`, `--bg-surface`, `--bg-surface-alt`, `--bg-hover`, `--bg-code` | Page, panel, raised, hover, and code backgrounds |
| `--border-color`, `--border-strong` | Dividers and control outlines |
| `--accent`, `--accent-hover`, `--accent-soft` | Active navigation, primary buttons, selected filters, focus rings |
| `--text-on-accent` | Text on an accent background |
| `--sidebar-bg`, `--sidebar-text`, `--sidebar-muted`, `--sidebar-heading`, `--sidebar-hover`, `--sidebar-active-bg`, `--sidebar-active-text`, `--sidebar-border` | Sidebar colours. They follow the surface and accent colours unless set, so a site can brand the sidebar alone. `--sidebar-bg` may be a gradient, for example `linear-gradient(180deg, #0f3d26, #0a1f15)`. |
| `--highlight` | Second brand colour: the logo mark and the strip along the top edge |
| `--highlight-text` | The highlight colour where it is used as text, for example the role tag. Set a darker shade for the light theme. |
| `--text-on-highlight` | Text on a highlight background |
| `--text-color`, `--text-secondary`, `--text-tertiary` | Primary, muted, and faint text |
| `--status-success`, `--status-warning`, `--status-danger`, `--status-info` and their `-bg` forms | Status badges, alert counters, row markers |
| `--data-ip`, `--data-port` | Addresses and ports in tables |

Variables left out keep their built-in values. A name must start with `--` and
use lower-case letters, digits, and dashes. A value may hold letters, digits,
`#`, parentheses, commas, dots, percent signs, spaces, and dashes, up to 80
characters. Entries that fail either check are ignored.

Restart the service after changing the theme.

## systemd unit

Location: `/etc/systemd/system/openvpn-ui.service`. Written by the installer from
your answers.

| Setting | Value | Meaning |
|---|---|---|
| `User` | `root` | The app runs Easy-RSA, writes the data files, reads the root-owned log, and restarts OpenVPN. |
| `WorkingDirectory` | Project directory | gunicorn imports `app:app` from here. |
| `ExecStart` | `venv/bin/gunicorn --workers 3 --bind <address>:<port> app:app` | Listening address, port, and worker count |
| `Restart` | `always`, after 5 seconds | The service comes back after a crash. |

To change the address, port, or worker count, edit `ExecStart`, then run
`sudo systemctl daemon-reload` and `sudo systemctl restart openvpn-ui.service`.

To keep `config.json` outside the project directory, add
`Environment=OPENVPN_UI_CONFIG=/path/to/config.json` to the unit and pass the same
variable to the hooks with `setenv OPENVPN_UI_CONFIG /path/to/config.json` in the
OpenVPN server configuration.

## Certificate subject defaults

The "Create Client" form is pre-filled with certificate subject fields. Values
come from the Easy-RSA `vars` file in `pki_dir`, and `ca_defaults` supplies any
field `vars` leaves unset.

| Form field | `vars` setting | `ca_defaults` key |
|---|---|---|
| Country | `EASYRSA_REQ_COUNTRY` | `country` |
| State/Province | `EASYRSA_REQ_PROVINCE` | `province` |
| City/Locality | `EASYRSA_REQ_CITY` | `city` |
| Organization | `EASYRSA_REQ_ORG` | `org` |
| Org Unit | `EASYRSA_REQ_OU` | `ou` |
| Contact Email | `EASYRSA_REQ_EMAIL` | `email` |

## Constants in the code

These are behaviour limits. They describe how the software works on any site.

| Constant | File | Value | Meaning |
|---|---|---|---|
| `LOGIN_MAX_FAILURES` | `app.py` | 5 | Failed sign-ins from one address before it is blocked |
| `LOGIN_WINDOW_SECONDS` | `app.py` | 900 | Length of the window those failures are counted in |
| `UI_PASSWORD_MIN_LEN` | `app.py` | 8 | Minimum length of a console password |
| `MAX_FIELD_LEN` | `app.py` | 256 | Default maximum length of a text field |
| `PROFILE_MAX_BYTES` | `app.py` | 1 MiB | Largest profile the app accepts from the builder |
| `LOG_MAX_ROWS` | `app.py` | 5000 | Largest `limit` the log endpoint honours |
| `LOG_MAX_LINE_LEN` | `app.py` | 2000 | Characters of a log line that are parsed |
| Connected grace period | `app.py`, `parse_status_log` | 120 s | How long a client stays "connected" after leaving the status file |
| Refresh interval | `static/app.js`, `startPolling` | 2 s | How often the console reloads its data |

## Data files

All are JSON, mode `600`, owned by `file_owner`. The web app creates any that are
missing at start-up. Each write goes to a temporary file that is renamed into
place, and changes are serialised with a lock file (`.openvpn-ui.lock` in
`data_dir`).

### client-mappings.json

Certificate CN to VPN username.

```json
{ "jdoe-laptop": "jdoe@example.edu" }
```

### client-passwords.json

VPN username to encrypted password. See [security.md](security.md) for the format.

```json
{ "jdoe@example.edu": "v2:<base64 string>" }
```

### client-limits.json

Certificate CN to maximum simultaneous devices. `0` means unlimited. A client
absent from the file has a limit of `1`.

```json
{ "jdoe-laptop": 2 }
```

### deleted-clients.json

Certificate CNs hidden from the console.

```json
["old-test-client"]
```

### ui-users.json

Console accounts. Passwords are Werkzeug password hashes.

```json
[
    { "username": "admin", "password": "<hash>", "role": "admin" }
]
```

`role` is `admin` or `user`.

### secret.key

32 random bytes, created on first start if missing. It signs console session
cookies and keys the encryption of VPN passwords. The app refuses to start when
the file is unreadable or shorter than 16 bytes.

Replacing the file signs out every console user and makes every stored VPN
password unreadable, so each client would need a new password. Back it up together
with `client-passwords.json`.

## Version control

`.gitignore` excludes `config.json`, `secret.key`, `ui-users.json`, client
profiles, key material, the virtual environment, and local working notes.
