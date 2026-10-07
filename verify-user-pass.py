#!/usr/bin/env python3
"""OpenVPN auth-user-pass-verify hook (via-file).

OpenVPN passes the path of a temporary file holding the username on the first
line and the password on the second. Exit status 0 accepts the login; any other
status rejects it. Outcomes are written to stderr, which OpenVPN copies to its
log. Passwords are kept out of every message.
"""
import sys
import json
import os
import hmac

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from settings import load_settings, SettingsError
from vpncrypto import decrypt_password, read_secret_key, SecretKeyError


def log(message):
    print(f"verify-user-pass: {message}", file=sys.stderr)


def main():
    if len(sys.argv) < 2:
        log("no credentials file argument")
        sys.exit(1)

    try:
        settings = load_settings(required=("data_dir",))
    except SettingsError as e:
        log(str(e))
        sys.exit(1)

    try:
        with open(sys.argv[1], 'r', errors='ignore') as f:
            lines = f.read().splitlines()
    except Exception as e:
        log(f"cannot read credentials file: {e}")
        sys.exit(1)

    if len(lines) < 2:
        log("credentials file is incomplete")
        sys.exit(1)

    username = lines[0].strip()
    password = lines[1].strip()
    if not username or not password:
        log("empty username or password")
        sys.exit(1)

    try:
        with open(settings.client_passwords_file, 'r') as f:
            passwords = json.load(f)
    except Exception as e:
        log(f"cannot read password database: {e}")
        sys.exit(1)

    encrypted = passwords.get(username)
    if not isinstance(encrypted, str):
        log(f"login rejected: unknown username {username!r}")
        sys.exit(1)

    try:
        key_bytes = read_secret_key(settings.secret_key_file)
    except SecretKeyError as e:
        log(str(e))
        sys.exit(1)

    stored = decrypt_password(encrypted, key_bytes)
    if stored is not None and hmac.compare_digest(stored.encode(), password.encode()):
        sys.exit(0)

    log(f"login rejected: wrong password for {username!r}")
    sys.exit(1)


if __name__ == '__main__':
    main()
