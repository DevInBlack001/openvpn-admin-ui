# Project

## Purpose

OpenVPN Admin UI is a web console for administering one OpenVPN server. It was
built for the ICT staff of the University of Mines and Technology (UMaT), who
operate the university's OpenVPN server.

## Inspiration

Four needs led to the project.

**Manual command-line work was slow.** Issuing and revoking clients by hand on
the server, with Easy-RSA and a profile-building script, took too long and was
error-prone.

**The VPN needed per-user controls.** Three controls were required for each
client: a username in the form of a university email address, a password in
addition to the certificate, and a cap on how many devices that client may connect
at once.

**Staff needed visibility and auditing.** The team needed to see who is connected
and review the server log without SSH access.

**The work needed to be delegated.** Staff without shell access needed a way to
manage VPN users and download profiles.

## What it does

| Area | Capability |
|---|---|
| Client lifecycle | Create a client with certificate, username, password, and device limit. Revoke. Remove from the console. |
| Profiles | Build and download a self-contained `.ovpn` profile per client. |
| Monitoring | Show each client's certificate status, expiry, session state, source address, VPN address, and traffic. |
| Logs | Present the OpenVPN log as a filterable table of named events with session identity on every row, and export it as CSV. |
| Access control | Console accounts with an `admin` or `user` role, managed from the console. |

## Design

### Components

| Component | Runs as | Role |
|---|---|---|
| Flask application (`app.py`) | gunicorn under systemd | Serves the console and the JSON API. Runs Easy-RSA. Reads the OpenVPN status file and log. |
| `settings.py` | Imported by the app and both hooks | Loads `config.json` and checks that required settings are present. |
| `vpncrypto.py` | Imported by the app and the auth hook | Encrypts and decrypts stored VPN passwords with an integrity check. |
| `verify-user-pass.py` | OpenVPN, at each connection | Confirms the username and password a client sent. |
| `limit-connections.py` | OpenVPN, at each connection | Rejects a connection when the client already has its maximum number of devices connected. |
| Browser front end (`index.html`, `app.js`, `style.css`) | The administrator's browser | One page with three views: Dashboard, Event Log, Console Users. |

### Data

The project uses plain files. There is no database server.

| Data | Location | Written by | Read by |
|---|---|---|---|
| Certificates and keys | Easy-RSA PKI directory | Easy-RSA, started by the web app | Web app, profile builder |
| Certificate CN to username | `client-mappings.json` | Web app | Web app, `limit-connections.py` |
| Username to encrypted password | `client-passwords.json` | Web app | Web app, `verify-user-pass.py` |
| Certificate CN to device limit | `client-limits.json` | Web app | Web app, `limit-connections.py` |
| Names hidden from the console | `deleted-clients.json` | Web app | Web app |
| Console accounts | `ui-users.json` | Installer, web app | Web app |
| Live sessions | OpenVPN status file | OpenVPN | Web app, `limit-connections.py` |
| Server events | OpenVPN log | OpenVPN | Web app |

### Authentication of VPN clients

A client must pass three checks to connect.

1. **Certificate.** OpenVPN verifies the client certificate against the CA and the
   certificate revocation list.
2. **Username and password.** OpenVPN passes the credentials to
   `verify-user-pass.py`, which decrypts the stored password and compares.
3. **Device limit.** OpenVPN runs `limit-connections.py`, which counts the
   client's sessions in the status file and compares the count to its limit.

OpenVPN is configured to use the username as the session's common name. The status
file and most log lines therefore identify a session by username. The web app maps
usernames back to certificate CNs through `client-mappings.json`.

### Client lifecycle

| Action | What happens |
|---|---|
| Create | Easy-RSA generates a key and request and signs a client certificate. The mapping, encrypted password, and limit are saved. The profile builder writes the `.ovpn` file. |
| Download | The stored profile is returned. If it is missing, it is rebuilt first. |
| Revoke | Easy-RSA revokes the certificate and regenerates the revocation list. The list is copied to the OpenVPN directory and the OpenVPN service restarts. |
| Delete | The client's mapping, password, limit, and profile are removed and its name is added to the hidden list. The PKI keeps its record of the certificate. |

### Log analysis

The log view turns OpenVPN's text log into structured events.

1. Each line is split into timestamp, user, source address, source port, and message.
2. An ordered table of patterns names the event and assigns a category, a severity,
   and a routine flag.
3. Lines from the same source address and port belong to one session. Facts learned
   on any line of a session (user, certificate CN, VPN address, platform, client
   software) are carried onto all of its rows.
4. Routine protocol lines are hidden by default and available through a toggle.
5. Timestamps are converted to UTC.

The four categories are Connections, Authentication, TLS Security, and General.

### Interface

The console is laid out as a security operations tool. A sidebar holds the
navigation and an error count for the last 24 hours. The top bar shows the
current UTC time, whether the VPN server is running, the signed-in account, and
the theme switch. The dashboard opens with counters for failed logins, TLS
errors, port probes, and device-limit rejections, followed by the most recent
alerts and the client list. Tables stack related fields, such as the user over
the certificate CN, so a row shows a whole session at common screen widths.

Colours come from CSS variables. A deployment sets its own palette and display
name in `config.json`.

## Technology

| Layer | Choice |
|---|---|
| Backend | Python 3, Flask 3.0, Werkzeug 3.0 |
| Application server | gunicorn 21.2, three sync workers |
| PKI | Easy-RSA 3 |
| Front end | Server-rendered HTML with plain JavaScript and CSS, system fonts, no third-party assets |
| Process management | systemd |
| Storage | JSON files |

## Scope and limits

- The console manages one OpenVPN server on the same host.
- The installer targets Debian and Ubuntu.
- Every site-specific value comes from `config.json`.
  [configuration.md](configuration.md) lists the settings.
- The profile builder script is supplied by each deployment.
- Known security limitations are listed in [security.md](security.md).

## How it was built

The code was written entirely by AI coding assistants. Abdullah Armiyao directed
the work: he set the requirements, called the shots, and made every decision the
assistants worked from.

## Author and license

Directed and owned by Abdullah Armiyao. Released under the MIT License.
