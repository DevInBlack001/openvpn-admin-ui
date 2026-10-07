"""Deployment settings shared by the web app and the OpenVPN hook scripts.

Every site-specific value comes from one JSON file. Its location is the
OPENVPN_UI_CONFIG environment variable when set, otherwise config.json next
to this file. See config.example.json and docs/configuration.md.
"""
import json
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_ENV_VAR = "OPENVPN_UI_CONFIG"
CONFIG_PATH = os.environ.get(CONFIG_ENV_VAR) or os.path.join(BASE_DIR, "config.json")

# Settings the web app cannot run without.
APP_REQUIRED = (
    "pki_dir",
    "data_dir",
    "clients_dir",
    "crl_file",
    "openvpn_status",
    "openvpn_log",
    "openvpn_service",
    "make_client_script",
    "file_owner",
)

CA_FIELDS = ("country", "province", "city", "org", "ou", "email")


class SettingsError(Exception):
    """The configuration file is missing, unreadable, or incomplete."""


class Settings:
    def __init__(self, data):
        self._data = data

    def get(self, key, default=None):
        value = self._data.get(key)
        return default if value in (None, "") else value

    def _data_file(self, name):
        return os.path.join(self.get("data_dir"), name)

    # Files kept next to the code unless the configuration says otherwise.
    @property
    def secret_key_file(self):
        return self.get("secret_key_file", os.path.join(BASE_DIR, "secret.key"))

    @property
    def ui_users_file(self):
        return self.get("ui_users_file", os.path.join(BASE_DIR, "ui-users.json"))

    # Data files shared between the web app and the hooks.
    @property
    def client_passwords_file(self):
        return self._data_file("client-passwords.json")

    @property
    def client_limits_file(self):
        return self._data_file("client-limits.json")

    @property
    def client_mappings_file(self):
        return self._data_file("client-mappings.json")

    @property
    def deleted_clients_file(self):
        return self._data_file("deleted-clients.json")

    @property
    def allowed_email_domains(self):
        domains = self.get("allowed_email_domains", [])
        if isinstance(domains, str):
            domains = [domains]
        return [d.strip().lower().lstrip("@") for d in domains if d and d.strip()]

    @property
    def ca_defaults(self):
        configured = self.get("ca_defaults", {}) or {}
        return {field: str(configured.get(field, "")) for field in CA_FIELDS}

    @property
    def session_minutes(self):
        try:
            return max(1, int(self.get("session_minutes", 15)))
        except (TypeError, ValueError):
            return 15

    @property
    def session_cookie_secure(self):
        return bool(self.get("session_cookie_secure", False))

    @property
    def brand_name(self):
        return self.get("brand_name", "OpenVPN")


def load_settings(required=APP_REQUIRED):
    """Read the configuration file and check that the required keys are set."""
    try:
        with open(CONFIG_PATH, "r") as f:
            data = json.load(f)
    except FileNotFoundError:
        raise SettingsError(
            f"Configuration file not found: {CONFIG_PATH}. "
            f"Copy config.example.json to that path or set {CONFIG_ENV_VAR}."
        )
    except (OSError, ValueError) as e:
        raise SettingsError(f"Cannot read configuration file {CONFIG_PATH}: {e}")

    if not isinstance(data, dict):
        raise SettingsError(f"Configuration file {CONFIG_PATH} must contain a JSON object.")

    missing = [key for key in required if data.get(key) in (None, "")]
    if missing:
        raise SettingsError(f"Missing settings in {CONFIG_PATH}: {', '.join(missing)}")

    return Settings(data)
