#!/usr/bin/env python3
"""OpenVPN client-connect hook: enforce the per-client device limit.

OpenVPN sets the session's common name in the environment. With
username-as-common-name that value is the VPN username. Exit status 0 lets the
client in; status 1 rejects the connection.
"""
import os
import sys
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from settings import load_settings, SettingsError


def main():
    common_name = os.environ.get("common_name")
    if not common_name:
        sys.exit(0)

    try:
        settings = load_settings(required=("data_dir", "openvpn_status"))
    except SettingsError as e:
        print(f"limit-connections: {e}", file=sys.stderr)
        sys.exit(1)

    mappings_file = settings.client_mappings_file
    limits_file = settings.client_limits_file

    # 1. Map username/common_name to certificate CN
    cert_cn = common_name
    if os.path.exists(mappings_file):
        try:
            with open(mappings_file, "r") as f:
                mappings = json.load(f)
                # Find CN where value matches common_name (username)
                for cn, username in mappings.items():
                    if username == common_name:
                        cert_cn = cn
                        break
        except Exception:
            pass

    # 2. Get limit for the certificate CN
    limit = 1
    if os.path.exists(limits_file):
        try:
            with open(limits_file, "r") as f:
                limits = json.load(f)
                limit = limits.get(cert_cn, 1)
        except Exception:
            limit = 1

    if limit == 0:
        sys.exit(0)

    status_log = settings.get("openvpn_status")
    count = 0
    if os.path.exists(status_log):
        try:
            with open(status_log, "r", errors="ignore") as f:
                for line in f:
                    if line.startswith(f"CLIENT_LIST,{common_name},"):
                        count += 1
        except Exception:
            pass

    if count >= limit:
        print(f"Rejecting connection for {common_name} (CN: {cert_cn}): limit of {limit} exceeded (current: {count})")
        sys.exit(1)

    sys.exit(0)


if __name__ == "__main__":
    main()
