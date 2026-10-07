#!/bin/bash
# scripts/install.sh - OpenVPN Admin UI Installer
#
# Run as root from any directory. Every site-specific value is asked for and
# written to config.json. Nothing about the deployment is fixed in this script.

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this installer as root." >&2
    exit 1
fi

UI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="openvpn-ui"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
CONFIG_FILE="$UI_DIR/config.json"
VENV_PY="$UI_DIR/venv/bin/python3"

ask() {
    # ask VARIABLE "Prompt" "default"
    local answer
    read -r -p "$2 [$3]: " answer
    printf -v "$1" '%s' "${answer:-$3}"
}

echo "=========================================="
echo " Starting OpenVPN Admin UI Installation"
echo " Project directory: $UI_DIR"
echo "=========================================="

# 1. Python environment
echo "Checking Python3 and Pip..."
apt-get update && apt-get install -y python3 python3-pip python3-venv

if [ ! -d "$UI_DIR/venv" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv "$UI_DIR/venv"
fi

echo "Installing dependencies..."
"$UI_DIR/venv/bin/pip" install -r "$UI_DIR/requirements.txt"

# 2. Deployment settings
echo "------------------------------------------"
echo "Deployment settings (press Enter to accept a default)"
ask FILE_OWNER      "Account that owns the project and data files" "$(stat -c '%U' "$UI_DIR")"
if ! id "$FILE_OWNER" >/dev/null 2>&1; then
    echo "Account '$FILE_OWNER' does not exist." >&2
    exit 1
fi
OWNER_HOME="$(getent passwd "$FILE_OWNER" | cut -d: -f6)"

ask BIND_ADDRESS    "Address the console listens on" "127.0.0.1"
ask BIND_PORT       "Port the console listens on" "8080"
ask BRAND_NAME      "Name shown in the console header" "OpenVPN"
ask PKI_DIR         "Easy-RSA directory (contains ./easyrsa and pki/)" "$OWNER_HOME/openvpn-ca"
ask DATA_DIR        "Directory for the console's data files" "/etc/openvpn/server"
ask CLIENTS_DIR     "Directory for client profiles" "/etc/openvpn/clients"
ask CRL_FILE        "Revocation list path used by crl-verify" "$DATA_DIR/crl.pem"
ask STATUS_FILE     "OpenVPN status file" "$DATA_DIR/openvpn-status.log"
ask LOG_FILE        "OpenVPN log file" "/var/log/openvpn/openvpn.log"
ask OPENVPN_SERVICE "systemd unit of the OpenVPN server" "openvpn-server@server"
ask MAKE_CLIENT     "Profile builder script" "$OWNER_HOME/make-client.sh"
ask EMAIL_DOMAINS   "Email domains allowed for VPN usernames, comma-separated (blank for any)" ""

case "$BIND_PORT" in
    ''|*[!0-9]*) echo "Port must be a number." >&2; exit 1 ;;
esac

# 3. Admin credentials
echo "------------------------------------------"
ask ADMIN_USER "Admin username" "admin"
read -r -s -p "Admin password [leave blank to generate one]: " ADMIN_PASS
echo
GENERATED_PASS=""
if [ -z "$ADMIN_PASS" ]; then
    ADMIN_PASS="$("$VENV_PY" -c 'import secrets; print(secrets.token_urlsafe(12))')"
    GENERATED_PASS="$ADMIN_PASS"
fi
echo "------------------------------------------"

# 4. Write config.json and ui-users.json.
# Values reach Python through the environment and are serialised with the json
# module, so quotes or other special characters in an answer stay data.
echo "Writing configuration..."
umask 077
export UI_DIR CONFIG_FILE FILE_OWNER BIND_ADDRESS BIND_PORT BRAND_NAME PKI_DIR DATA_DIR \
       CLIENTS_DIR CRL_FILE STATUS_FILE LOG_FILE OPENVPN_SERVICE MAKE_CLIENT EMAIL_DOMAINS \
       ADMIN_USER ADMIN_PASS

"$VENV_PY" - <<'PY'
import json, os, re, sys
from werkzeug.security import generate_password_hash

env = os.environ

def write_private(path, payload):
    temp = path + ".tmp"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(payload, f, indent=4)
        f.write("\n")
    os.replace(temp, path)

admin_user = env["ADMIN_USER"]
if not re.match(r"^[a-zA-Z0-9._@-]{1,64}$", admin_user):
    sys.exit("Admin username must be 1 to 64 letters, digits, dots, dashes, underscores or @.")
if len(env["ADMIN_PASS"]) < 8:
    sys.exit("Admin password must be at least 8 characters.")

config_path = env["CONFIG_FILE"]
config = {}
if os.path.exists(config_path):
    with open(config_path) as f:
        config = json.load(f)

config.update({
    "bind_address": env["BIND_ADDRESS"],
    "port": int(env["BIND_PORT"]),
    "brand_name": env["BRAND_NAME"],
    "pki_dir": env["PKI_DIR"],
    "data_dir": env["DATA_DIR"],
    "clients_dir": env["CLIENTS_DIR"],
    "crl_file": env["CRL_FILE"],
    "openvpn_status": env["STATUS_FILE"],
    "openvpn_log": env["LOG_FILE"],
    "openvpn_service": env["OPENVPN_SERVICE"],
    "make_client_script": env["MAKE_CLIENT"],
    "file_owner": env["FILE_OWNER"],
    "allowed_email_domains": [d.strip() for d in env["EMAIL_DOMAINS"].split(",") if d.strip()],
})
config.setdefault("ca_defaults", {k: "" for k in ("country", "province", "city", "org", "ou", "email")})
config.setdefault("session_minutes", 15)
config.setdefault("session_cookie_secure", False)
write_private(config_path, config)

users_path = os.path.join(env["UI_DIR"], "ui-users.json")
users = []
if os.path.exists(users_path):
    with open(users_path) as f:
        users = [u for u in json.load(f) if u.get("username") != admin_user]
users.append({
    "username": admin_user,
    "password": generate_password_hash(env["ADMIN_PASS"]),
    "role": "admin",
})
write_private(users_path, users)
PY
unset ADMIN_PASS

# 5. Data files and directories
echo "Initializing OpenVPN configuration databases..."
mkdir -p "$DATA_DIR" "$CLIENTS_DIR"
for file in client-passwords.json client-limits.json client-mappings.json deleted-clients.json; do
    target="$DATA_DIR/$file"
    if [ ! -f "$target" ]; then
        if [ "$file" = "deleted-clients.json" ]; then
            ( umask 077; echo "[]" > "$target" )
        else
            ( umask 077; echo "{}" > "$target" )
        fi
    fi
    chmod 600 "$target"
    chown "$FILE_OWNER:$FILE_OWNER" "$target"
done
chown "$FILE_OWNER:$FILE_OWNER" "$CLIENTS_DIR"
chmod 700 "$CLIENTS_DIR"

# 6. systemd service
echo "Creating systemd service ${SERVICE_NAME}.service..."
umask 022
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=OpenVPN PKI Management Web UI
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$UI_DIR
ExecStart=$UI_DIR/venv/bin/gunicorn --workers 3 --bind $BIND_ADDRESS:$BIND_PORT app:app
Restart=always
RestartSec=5
Environment=PATH=$UI_DIR/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=multi-user.target
EOF

# 7. Ownership
echo "Setting permissions for UI directory..."
chown -R "$FILE_OWNER:$FILE_OWNER" "$UI_DIR"
chown -R root:root "$UI_DIR/venv"
chmod 600 "$CONFIG_FILE" "$UI_DIR/ui-users.json"
chmod 755 "$UI_DIR/verify-user-pass.py" "$UI_DIR/limit-connections.py"

# 8. Start
echo "Starting ${SERVICE_NAME} service..."
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"
systemctl restart "${SERVICE_NAME}.service"

echo "=========================================="
echo " Installation Complete!"
echo " UI is running at http://$BIND_ADDRESS:$BIND_PORT"
echo " Admin Username: $ADMIN_USER"
if [ -n "$GENERATED_PASS" ]; then
    echo " Admin Password: $GENERATED_PASS"
    echo " Store it now. It is shown only this once."
fi
echo
echo " Next: add the directives in docs/installation.md to the OpenVPN"
echo " server configuration, pointing at:"
echo "   $UI_DIR/verify-user-pass.py"
echo "   $UI_DIR/limit-connections.py"
echo "=========================================="
