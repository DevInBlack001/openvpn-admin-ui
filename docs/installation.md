# Installation

## Prerequisites

| Requirement | Detail |
|---|---|
| Operating system | Debian or Ubuntu with systemd. The installer uses `apt-get` and `systemctl`. |
| OpenVPN | Installed and working as a server under a systemd unit. The project is run against OpenVPN 2.7. |
| Easy-RSA 3 | A directory with `./easyrsa`, an initialised CA, and a signed server certificate |
| Python | Python 3 with the `venv` module. The installer installs both. |
| Privileges | Root, for installation and for the service |
| System account | An account that will own the project directory, data files, and profiles |
| Profile builder | An executable script that turns a client name into a `.ovpn` file. See "Profile builder script". |

## Profile builder script

The console runs the script named in `make_client_script` as the `file_owner`
account, with one argument: the certificate CN. The script is specific to each
deployment and is kept outside this repository. Its contract:

- Input: one argument, the certificate CN.
- Output: a complete client profile written to `<home of file_owner>/<CN>.ovpn`.
- The profile embeds the CA certificate, the client certificate, the client key,
  and the TLS key, names the server's public address and port, and contains
  `auth-user-pass` so the client prompts for credentials.

The console reads the result, stores it in `clients_dir` with mode `600`, and
removes the builder's copy. The output must be a regular file of at most 1 MiB.
A symbolic link in its place is refused.

## Install

1. Place the project directory where it will live, owned by the system account.

2. Run the installer as root:

   ```bash
   sudo bash scripts/install.sh
   ```

3. Answer the prompts. Press Enter to accept a default.

   | Prompt | Default |
   |---|---|
   | Account that owns the project and data files | Current owner of the project directory |
   | Address the console listens on | `127.0.0.1` |
   | Port the console listens on | `8080` |
   | Name shown in the console header | `OpenVPN` |
   | Easy-RSA directory | `openvpn-ca` in the owner's home |
   | Directory for the console's data files | `/etc/openvpn/server` |
   | Directory for client profiles | `/etc/openvpn/clients` |
   | Revocation list path | `crl.pem` in the data directory |
   | OpenVPN status file | `openvpn-status.log` in the data directory |
   | OpenVPN log file | `/var/log/openvpn/openvpn.log` |
   | systemd unit of the OpenVPN server | `openvpn-server@server` |
   | Profile builder script | `make-client.sh` in the owner's home |
   | Email domains allowed for VPN usernames | blank, meaning any |
   | Admin username | `admin` |
   | Admin password | blank, meaning generate one |

   A generated password is printed once at the end of the run.

## What the installer does

1. Installs `python3`, `python3-pip`, and `python3-venv` with `apt-get`.
2. Creates `venv/` in the project directory and installs `requirements.txt`.
3. Writes `config.json` from your answers, keeping any extra keys already present.
4. Hashes the admin password and adds the account to `ui-users.json`.
5. Creates the four JSON data files in the data directory when they are missing,
   with mode `600`.
6. Creates the client profile directory with mode `700`.
7. Writes `/etc/systemd/system/openvpn-ui.service`.
8. Sets ownership of the project directory to the system account and of `venv/`
   to `root`.
9. Enables and starts the service.

Answers pass to Python through the environment and are written with the `json`
module, so special characters in an answer are stored literally.

## OpenVPN server directives

Add these to the OpenVPN server configuration, with paths that match
`config.json`. `<project>` stands for the project directory.

```
# Username and password check on top of the certificate
script-security 2
auth-user-pass-verify "<project>/verify-user-pass.py" via-file
username-as-common-name

# Several devices per client, capped by the device-limit hook
duplicate-cn
client-connect "<project>/limit-connections.py"

# Revocation list maintained by the console (crl_file)
crl-verify /etc/openvpn/server/crl.pem

# Files the console reads (openvpn_status, openvpn_log)
status /etc/openvpn/server/openvpn-status.log 1
status-version 2
log-append /var/log/openvpn/openvpn.log
```

Notes:

- Both hooks run from the project directory, where they find `settings.py`,
  `vpncrypto.py`, and `config.json`.
- `status-version 2` produces the `CLIENT_LIST,` lines that the console and the
  device-limit hook parse.
- When the project directory is under `/home`, the OpenVPN unit needs
  `ProtectHome=false` in a systemd drop-in so it can run the hooks.
- Start OpenVPN with timestamps enabled, which is its default. The
  `--suppress-timestamps` option leaves the log view without times.
- When `config.json` lives outside the project directory, add
  `setenv OPENVPN_UI_CONFIG /path/to/config.json`.

Restart OpenVPN after editing its configuration. A restart disconnects every
client until each reconnects.

## Verify

```bash
systemctl is-active openvpn-ui.service
journalctl -u openvpn-ui.service -n 20
curl -s -o /dev/null -w '%{http_code}\n' http://<bind-address>:<port>/login
```

Expected: `active`, gunicorn start-up lines with three workers, and `200`.

A missing setting stops the service at start-up. The journal names the missing
keys.

Then open the console in a browser, sign in, create a test client, download its
profile, and connect with it. A successful connection confirms that the hooks,
the data files, and the secret key are wired correctly.

## Serving over HTTPS

The app speaks plain HTTP. For anything beyond a trusted management network, bind
it to `127.0.0.1`, place a TLS-terminating reverse proxy in front of it, and set
`session_cookie_secure` to `true`.

## Update

After changing a Python file or a template:

```bash
sudo systemctl restart openvpn-ui.service
```

Changes to files in `static/` take effect on the next page load. Changes to the
hook scripts take effect at the next VPN connection.

Restarting `openvpn-ui.service` leaves VPN sessions untouched.

## Upgrading a deployment that predates config-driven settings

Earlier versions kept paths in the code and used a smaller `config.json`.

1. Back up the project directory, the data directory, and `secret.key`.
2. Add the required keys from [configuration.md](configuration.md) to
   `config.json`, with the values the old code used.
3. Point `auth-user-pass-verify` and `client-connect` at the scripts in the
   project directory.
4. Restart `openvpn-ui.service`, then restart OpenVPN in a quiet period.
5. Test one VPN login.

Existing clients keep their certificates, profiles, usernames, and passwords.
Stored passwords in the earlier format remain readable. Each one is rewritten in
the current format the next time it is saved.

## Uninstall

```bash
sudo bash scripts/uninstall.sh
```

The script stops, disables, and removes the systemd unit. It then asks two
questions:

| Question | Yes removes |
|---|---|
| Delete client credentials and limits database files? | `client-passwords.json`, `client-limits.json`, `client-mappings.json`, `deleted-clients.json`, and the lock file in the configured data directory |
| Delete python virtual environment and local configurations? | `venv/`, `config.json`, `ui-users.json`, `secret.key` |

Source files, the PKI, and OpenVPN's own configuration stay in place. Remove the
`auth-user-pass-verify` and `client-connect` directives from the server
configuration by hand before the next OpenVPN restart.

## Troubleshooting

| Symptom | Check |
|---|---|
| Service fails to start | `journalctl -u openvpn-ui.service`. Look for a "Missing settings" or secret key message. Confirm the bind address exists on the host and the port is free. |
| Every VPN login is rejected | Read the OpenVPN log for lines starting `verify-user-pass:`. Confirm the hook is executable, can read `config.json`, and uses the same `secret.key` as the web app. |
| OpenVPN fails to start with an `auth-user-pass-verify` error | The path in the directive is wrong or blocked by `ProtectHome`. |
| Dashboard shows everyone offline | Confirm `openvpn_status` matches the `status` directive and that `status-version 2` is set. |
| Log view is empty | Confirm `openvpn_log` matches `log-append`. |
| Log view shows `-` in the time column | OpenVPN is running with `--suppress-timestamps`. |
| Profile download fails | Run the profile builder by hand as the owner account and read its output. |
| "Invalid or missing CSRF token" | Reload the page. The token belongs to the session and a new sign-in issues a new one. |
| "Too many failed attempts" at sign-in | Wait 15 minutes, or restart `openvpn-ui.service` to clear the counters. |
