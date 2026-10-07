# Usage

## Signing in

Open the console address in a browser and sign in with a console account. A
session lasts 15 minutes (configurable) and each request renews it. Because the
page refreshes its data every 2 seconds, an open tab stays signed in.

Five failed sign-ins from one address within 15 minutes block further attempts
from that address until the window passes.

Use the icon at the top right to sign out, and the moon or sun icon to switch
between dark and light themes. The theme choice is remembered in the browser.

## Roles

| Capability | `admin` | `user` |
|---|---|---|
| View the dashboard and client list | yes | yes |
| Download client profiles | yes | yes |
| View and export logs | yes | yes |
| See VPN passwords | yes | no |
| Change own password (API) | yes | yes |
| Create, revoke, delete clients | yes | no |
| Manage console accounts | yes | no |

## Dashboard

### Summary tiles

| Tile | Meaning |
|---|---|
| Active Tunnels | Number of connected devices across all clients |
| Total Profiles | Number of clients listed |
| CPU Usage | Host CPU use over the last refresh interval |
| Memory Usage | Share of host memory in use |

### Client table

| Column | Meaning |
|---|---|
| Username (Email) | VPN login name |
| Common Name | Certificate CN, the client's unique identifier |
| PKI | `Valid`, `Revoked`, or `Expired` |
| Expires (UTC) | Certificate expiry date. Hover for the full timestamp. |
| Session | `Connected (n)` with the number of devices, or `Offline` |
| Max | Device limit, or `Unlimited` |
| Password | For admins: masked by default, click to reveal, click again to hide. For `user` accounts: shown as "Hidden". |
| Real Address | Public address and port of each connected device |
| Virtual IP | Address of each device inside the VPN |
| Bandwidth | Bytes received from and sent to the client in the current session |
| Actions | Download, Revoke, or Delete |

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

Click the revoke button on a valid client and confirm. The certificate is revoked,
the revocation list is regenerated, and the OpenVPN service restarts.

**The restart disconnects every connected client.** Clients with automatic
reconnection return on their own. Choose a quiet moment for revocations.

### Delete a client

Available for revoked and expired clients. Deleting removes the client's stored
password, device limit, username mapping, and profile, and hides the name from the
console. The PKI keeps its record of the certificate.

## UI Users

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

## System Logs

The newest event is at the top.

### Columns

| Column | Meaning |
|---|---|
| Time (UTC) | Timestamp of the log line, converted to UTC. `-` when the line carries no timestamp. |
| Severity | `INFO`, `WARNING`, or `ERROR`. Warnings and errors also carry a coloured bar on the left edge. |
| Category | Connections, Authentication, TLS Security, or General |
| Event | Short name of what happened |
| User | VPN username of the session |
| Certificate CN | Common name of the certificate the client presented |
| Source IP:Port | Public address and port the client connected from |
| Virtual IP | Address assigned inside the VPN |
| Client | Client software reported by the peer, or its platform |
| Details | The relevant part of the message |

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
| Category tabs | Show one category or all |
| Routine lines | Include routine protocol lines such as handshake steps, pushed options, and server start-up detail |
| Severity pills | Show one severity or all |
| Search | Filter the loaded rows by any text, including user, certificate CN, virtual IP, and client |
| Show | Number of rows to load: 100, 500, or 1000 |
| Timeframe | Limit to a recent window. Depends on timestamps in the log. |
| Refresh | Reload and return to the top |
| Export CSV | Save the rows currently shown |

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
| Who failed to log in? | Authentication tab, Errors pill |
| What did one user do? | Type the username in Search |
| Which sessions came from one address? | Type the address in Search |
| Is someone probing the server? | TLS Security tab, Warnings pill, look for "Invalid packet (tls-crypt)" and "Handshake rate limit hit" |
| Who hit the device limit? | Connections tab, Warnings pill |
| Was a revoked certificate used? | TLS Security tab, Errors pill, look for "Certificate rejected" |
