#!/bin/bash
# scripts/uninstall.sh - OpenVPN Admin UI Uninstaller

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this uninstaller as root." >&2
    exit 1
fi

UI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_FILE="/etc/systemd/system/openvpn-ui.service"
CONFIG_FILE="$UI_DIR/config.json"

# The data directory is whatever this deployment configured.
DATA_DIR=""
if [ -f "$CONFIG_FILE" ]; then
    DATA_DIR="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("data_dir",""))' "$CONFIG_FILE" 2>/dev/null || true)"
fi

echo "=========================================="
echo " Starting OpenVPN Admin UI Uninstallation"
echo "=========================================="

# 1. Stop and disable systemd service
if systemctl is-active --quiet openvpn-ui.service || systemctl is-enabled --quiet openvpn-ui.service; then
    echo "Stopping and disabling openvpn-ui.service..."
    systemctl stop openvpn-ui.service || true
    systemctl disable openvpn-ui.service || true
fi

# Remove systemd service file
if [ -f "$SERVICE_FILE" ]; then
    echo "Removing systemd service file..."
    rm -f "$SERVICE_FILE"
    systemctl daemon-reload
fi

# 2. Optionally clean up credentials and limits database files
echo "------------------------------------------"
if [ -n "$DATA_DIR" ]; then
    read -r -p "Do you want to delete client credentials and limits database files in $DATA_DIR? (client-passwords, limits, mappings, deleted-clients) [y/N]: " CLEAN_DB
    CLEAN_DB=${CLEAN_DB:-n}
else
    echo "No data directory found in $CONFIG_FILE. Leaving database files alone."
    CLEAN_DB=n
fi
echo "------------------------------------------"

if [[ "$CLEAN_DB" =~ ^[Yy]$ ]]; then
    echo "Deleting configuration and limits databases..."
    rm -f "$DATA_DIR/client-passwords.json"
    rm -f "$DATA_DIR/client-limits.json"
    rm -f "$DATA_DIR/client-mappings.json"
    rm -f "$DATA_DIR/deleted-clients.json"
    rm -f "$DATA_DIR/.openvpn-ui.lock"
else
    echo "Preserving configuration and limits databases."
fi

# 3. Optionally clean up environment and config
echo "------------------------------------------"
read -r -p "Do you want to delete python virtual environment and local configurations? (venv, config.json, ui-users.json, secret.key) [y/N]: " CLEAN_ENV
CLEAN_ENV=${CLEAN_ENV:-n}
echo "------------------------------------------"

if [[ "$CLEAN_ENV" =~ ^[Yy]$ ]]; then
    echo "Removing python virtualenv and config databases..."
    rm -rf "$UI_DIR/venv"
    rm -f "$UI_DIR/config.json"
    rm -f "$UI_DIR/ui-users.json"
    rm -f "$UI_DIR/secret.key"
else
    echo "Preserving virtualenv and local configurations."
fi

echo "=========================================="
echo " Uninstallation Complete!"
echo " Note: Web UI source code files in $UI_DIR were kept."
echo " Remove the auth-user-pass-verify and client-connect lines from the"
echo " OpenVPN server configuration before restarting OpenVPN."
echo "=========================================="
