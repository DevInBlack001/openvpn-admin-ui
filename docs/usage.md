# Usage

## Signing in

Open the console address in a browser and sign in with a console account. A
session lasts 15 minutes (configurable) and each request renews it. Because the
page refreshes its data every 2 seconds, an open tab stays signed in.

Five failed sign-ins from one address within 15 minutes block further attempts
from that address until the window passes.

## Layout

| Area | Contents |
|---|---|
| Sidebar | **Dashboard**, **Event Log**, and for admins **Console Users**. The Event Log entry carries a red count of errors in the last 24 hours. At the foot, a card shows the signed-in account and role with the log-out button. |
| Top bar | Page title and subtitle, the VPN server's state, the current UTC time, and the theme switch |
| Content | The selected view |

The VPN pill reads **VPN Online** while OpenVPN keeps refreshing its status file
and **VPN Offline** once the file is more than a minute old.

The theme switch names the theme a click changes to. The choice is remembered in
the browser. On narrow screens the sidebar becomes a drawer opened with the menu
button beside the title.

## Roles

| Capability | `admin` | `user` |
|---|---|---|
| View the dashboard and client list | yes | yes |
| Download client profiles | yes | yes |
| View and export the event log | yes | yes |
| See VPN passwords | yes | no |
| Change own password (API) | yes | yes |
| Create, revoke, delete clients | yes | no |
| Manage console accounts | yes | no |

## Dashboard

### Counters

| Counter | Meaning |
|---|---|
| Active Tunnels | Connected devices across all clients |
| Client Profiles | Clients listed |
| Failed Logins | Wrong username or password, last 24 hours |
| TLS Errors | Failed TLS handshakes and rejected certificates, last 24 hours |
| Port Probes | Packets that failed the TLS key check, last 24 hours. These come from hosts probing the VPN port without the shared key. |
| Limit Rejections | Connections refused because the client was at its device limit, last 24 hours |
| Host CPU | Host CPU use over the last refresh interval |
| Host Memory | Share of host memory in use |

The four 24-hour counters refresh every 15 seconds. A counter above zero takes a
red or amber outline. A value ending in `+` means the count reached the number of
rows the dashboard reads (1000).

### Recent Alerts

The eight most recent warnings and errors from the last 24 hours, newest first.

| Column | Meaning |
|---|---|
| Time (UTC) | Timestamp of the log line |
| Severity | `WARNING` or `ERROR` |
| Event and Details | Event name, with the relevant part of the message beneath it |
| User / Certificate CN | VPN username, with the certificate CN beneath it |
| Source IP:Port / Virtual IP | Public address and port, with the VPN address beneath it |

**Open in Event Log** opens the Event Log filtered to errors from the last 24
hours.

### Client Profiles

| Column | Meaning |
|---|---|
| User / Certificate CN | VPN login name, with the certificate CN beneath it |
| Certificate | `Valid`, `Revoked`, or `Expired`, with the expiry date beneath it. Hover for the full UTC timestamp. |
| Session | `Connected (n)` with the number of devices, or `Offline` |
| Max | Device limit, or `Unlimited` |
| Password | For admins: masked by default, click to reveal, click again to hide. For `user` accounts: shown as "Hidden". |
| Source / Virtual IP | Public address and port of each connected device, with its VPN address beneath it |
| Traffic | Bytes received from and sent to the client in the current session |
| Actions | **Download**, **Revoke**, or **Delete**. Below about 1640 pixels of window width the buttons show icons only, with tooltips. |

The search box filters by email, common name, real address, or virtual IP.

### Create a client

1. Click **Add Client**.
2. Enter the username (an email address in an allowed domain), a common name for
   the certificate (letters, digits, dashes, underscores), and a password. **Gen**
   produces a random 16-character password.
3. Choose the device limit: 1 to 4, or Unlimited.
4. Adjust the certificate subject fields if needed.
5. Click **Create Client**.

Download the profile from the client's row and deliver it, with the username and
password, to the user through a trusted channel.

### Revoke a client

Click **Revoke** on a valid client and confirm. The certificate is revoked, the
revocation list is regenerated, and the OpenVPN service restarts.

**The restart disconnects every connected client.** Clients with automatic
reconnection return on their own. Choose a quiet moment for revocations.

### Delete a client

Available for revoked and expired clients. Deleting removes the client's stored
password, device limit, username mapping, and profile, and hides the name from the
console. The PKI keeps its record of the certificate.

## Event Log

The newest event is at the top.

### Columns

| Column | Meaning |
|---|---|
| Time (UTC) | Timestamp of the log line, converted to UTC. `-` when the line carries no timestamp. |
| Severity / Category | `INFO`, `WARNING`, or `ERROR`, with the category beneath it. Warnings and errors also carry a coloured bar on the left edge and bold text. |
| Event and Details | Short name of what happened, with the relevant part of the message beneath it |
| User / Certificate CN | VPN username of the session, with the common name of the certificate the client presented beneath it |
| Source IP:Port / Virtual IP | Public address and port the client connected from, with the address assigned inside the VPN beneath it |
| Client | Client software reported by the peer, or its platform. Hover for both. |

Click a row to show the original log line beneath it.

### Events by category

| Category | Events |
|---|---|
| Connections | Connected, Virtual IP assigned, Disconnected, Disconnected (timeout), Device limit exceeded, Connection rejected |
| Authentication | Login succeeded, Login failed, Login rejected |
| TLS Security | Certificate verified, Certificate rejected, TLS handshake timed out, TLS error, Client reset (TLS error), Invalid packet (tls-crypt), Handshake rate limit hit |
| General | Server started, Server stopped, Server failed to bind, Server exited (fatal error), Configuration error, CRL loaded, Warning, Other |

### Controls

| Control | Effect |
|---|---|
| Rows | Number of rows to load: 100, 500, or 1000 |
| Window | Limit to a recent period. Depends on timestamps in the log. |
| Export CSV | Save the rows currently shown |
| Refresh | Reload and return to the top |
| Category | Show one category or all |
| Routine lines | Include routine protocol lines such as handshake steps, pushed options, and server start-up detail |
| Search | Filter the loaded rows by any text, including user, certificate CN, virtual IP, and client |
| Severity | Show one severity or all |

### Scrolling and live updates

The table refreshes every 2 seconds while you are at the top. When you scroll down
to read older rows, the table holds still and a "Live updates paused" pill appears
once new events arrive. Scroll back to the top or click the pill to resume.

### CSV export

The file is named `openvpn-log-export-<date>-<time>-UTC.csv` and contains one row
per event with these columns: `time_utc`, `severity`, `category`, `event`, `user`,
`certificate_cn`, `source_ip`, `source_port`, `virtual_ip`, `client_platform`,
`client_software`, `details`, `raw_log_line`.

### Investigation examples

| Question | How |
|---|---|
| Who failed to log in? | Category Authentication, Severity Errors |
| What did one user do? | Type the username in Search |
| Which sessions came from one address? | Type the address in Search |
| Is someone probing the server? | Category TLS Security, Severity Warnings. Look for "Invalid packet (tls-crypt)" and "Handshake rate limit hit". |
| Who hit the device limit? | Category Connections, Severity Warnings |
| Was a revoked certificate used? | Category TLS Security, Severity Errors. Look for "Certificate rejected". |

## Console Users

Visible to admins. Lists console accounts with their roles.

- **Add UI User** creates an account with the `user` or `admin` role. Passwords
  need at least 8 characters.
- **Edit** changes an account's password or role. A role change applies to that
  account's open sessions at once.
- **Delete** removes an account and ends its open sessions. The account you are
  signed in with shows **Edit Password** only.
- One `admin` account always remains: the console refuses to delete or demote
  the last one.

## Audit trail

The service log records sign-ins, client creation, revocation, deletion, profile
downloads, and account changes, each with the acting account and source address:

```bash
journalctl -u openvpn-ui.service | grep AUDIT
```
