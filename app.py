import os
import sys
import json
import re
import datetime
import subprocess
import logging
import pwd
import secrets
import shutil
import stat
import time
import fcntl
import hmac
import tempfile
from contextlib import contextmanager
from flask import Flask, request, jsonify, render_template, redirect, url_for, session
from werkzeug.security import generate_password_hash, check_password_hash
from functools import wraps

import vpncrypto
from settings import load_settings

settings = load_settings()

app = Flask(__name__)
SECRET_KEY_FILE = settings.secret_key_file

def ensure_secret_key(path):
    """Return the secret key, creating the file on first start.

    Several workers start at once. The key is written to a private temporary
    file and hard-linked into place, which succeeds for exactly one worker and
    leaves no moment at which the file exists half-written or world-readable.
    A key that cannot be read stops the app: running with a throwaway key
    would store passwords that nothing could decrypt later.
    """
    if not os.path.exists(path):
        temp_path = f"{path}.{os.getpid()}.tmp"
        fd = os.open(temp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, 'wb') as f:
                f.write(os.urandom(32))
                f.flush()
                os.fsync(f.fileno())
            try:
                os.link(temp_path, path)
            except FileExistsError:
                pass
        finally:
            os.unlink(temp_path)
    return vpncrypto.read_secret_key(path)

SECRET_KEY = ensure_secret_key(SECRET_KEY_FILE)
app.secret_key = SECRET_KEY

app.permanent_session_lifetime = datetime.timedelta(minutes=settings.session_minutes)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    SESSION_COOKIE_SECURE=settings.session_cookie_secure,
)

# Administrative actions are written to the service log (journald under systemd).
audit_logger = logging.getLogger('openvpn_ui.audit')
if not audit_logger.handlers:
    audit_handler = logging.StreamHandler()
    audit_handler.setFormatter(logging.Formatter('%(asctime)s AUDIT %(message)s'))
    audit_logger.addHandler(audit_handler)
    audit_logger.setLevel(logging.INFO)
    audit_logger.propagate = False

def audit(action, target=''):
    audit_logger.info(
        'user=%s addr=%s action=%s target=%s',
        session.get('username', '-'), request.remote_addr, action, target
    )

def encrypt_password(password: str) -> str:
    return vpncrypto.encrypt_password(password, SECRET_KEY)

def decrypt_password(stored) -> str:
    """Password in clear for display, or "-" when there is none or it fails its integrity check."""
    plain = vpncrypto.decrypt_password(stored, SECRET_KEY)
    return plain if plain else "-"

EASYRSA_DIR = settings.get("pki_dir")
INDEX_TXT = os.path.join(EASYRSA_DIR, "pki/index.txt")
CLIENT_PASSWORDS = settings.client_passwords_file
CLIENT_LIMITS = settings.client_limits_file
CLIENT_MAPPINGS = settings.client_mappings_file
DELETED_CLIENTS = settings.deleted_clients_file
UI_USERS = settings.ui_users_file
OPENVPN_STATUS = settings.get("openvpn_status")
OPENVPN_LOG = settings.get("openvpn_log")
OPENVPN_SERVICE = settings.get("openvpn_service")
CLIENTS_DIR = settings.get("clients_dir")
CRL_FILE = settings.get("crl_file")
MAKE_CLIENT_SCRIPT = settings.get("make_client_script")
FILE_OWNER = settings.get("file_owner")
ALLOWED_EMAIL_DOMAINS = settings.allowed_email_domains

CA_ENV_VARS = {
    "country": "EASYRSA_REQ_COUNTRY",
    "province": "EASYRSA_REQ_PROVINCE",
    "city": "EASYRSA_REQ_CITY",
    "org": "EASYRSA_REQ_ORG",
    "ou": "EASYRSA_REQ_OU",
    "email": "EASYRSA_REQ_EMAIL",
}

CLIENT_NAME_RE = re.compile(r'^[a-zA-Z0-9_-]+$')
EMAIL_RE = re.compile(r'^[a-zA-Z0-9._%+-]+@([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$')

CONNECTION_CACHE = {}

def valid_client_name(name):
    return isinstance(name, str) and bool(CLIENT_NAME_RE.match(name))

def valid_vpn_username(username):
    """A well-formed email address in one of the configured domains, if any are set."""
    if not EMAIL_RE.match(username):
        return False
    if not ALLOWED_EMAIL_DOMAINS:
        return True
    domain = username.rsplit('@', 1)[1].lower()
    return any(domain == allowed or domain.endswith('.' + allowed) for allowed in ALLOWED_EMAIL_DOMAINS)

def chown_to_file_owner(path):
    try:
        owner = pwd.getpwnam(FILE_OWNER)
        os.chown(path, owner.pw_uid, owner.pw_gid)
    except Exception:
        pass

def client_profile_path(name):
    return os.path.join(CLIENTS_DIR, f"{name}.ovpn")

def write_private_file(path, data: bytes):
    """Replace `path` with `data` atomically, mode 600, owned by the file owner.

    The content goes to a temporary file that is created private, flushed to
    disk, and renamed over the target. Readers, including the OpenVPN hooks,
    see the old file or the new one and at no point a partial or
    world-readable one.
    """
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix='.' + os.path.basename(path) + '.', dir=directory)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        chown_to_file_owner(temp_path)
        os.replace(temp_path, path)
    except BaseException:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise

PROFILE_MAX_BYTES = 1024 * 1024

def build_client_profile(name):
    """Run the profile builder as the file owner and store its output in CLIENTS_DIR."""
    subprocess.run(["sudo", "-u", FILE_OWNER, MAKE_CLIENT_SCRIPT, name], check=True)
    built = os.path.join(pwd.getpwnam(FILE_OWNER).pw_dir, f"{name}.ovpn")
    # The builder's output directory belongs to another account. Open the file
    # once, refuse symbolic links, and check what was opened: a path that is
    # tested first and opened later can be swapped in between.
    try:
        fd = os.open(built, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return
    with os.fdopen(fd, 'rb') as f:
        info = os.fstat(f.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > PROFILE_MAX_BYTES:
            raise RuntimeError("Profile builder output is not a regular file of plausible size")
        content = f.read(PROFILE_MAX_BYTES + 1)
    write_private_file(client_profile_path(name), content)
    try:
        os.remove(built)
    except OSError:
        pass

def load_json(filepath, default):
    """Parsed content of a data file, or `default` when it is missing, unreadable, or the wrong shape."""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            loaded = json.load(f)
    except FileNotFoundError:
        return default
    except Exception as e:
        app.logger.error(f"Error reading JSON from {filepath}: {e}")
        return default
    if not isinstance(loaded, type(default)):
        app.logger.error(f"Unexpected content in {filepath}: expected {type(default).__name__}")
        return default
    return loaded

def save_json(filepath, data):
    """Write a data file atomically. Failures propagate so a lost write is reported to the caller."""
    write_private_file(filepath, json.dumps(data, indent=4).encode('utf-8'))

@contextmanager
def data_lock():
    """Serialise changes to the PKI and data files across gunicorn workers.

    Each change is a read, modify, write sequence. Without the lock two
    workers can read the same state and the second write discards the first.
    """
    lock_path = os.path.join(settings.get("data_dir"), ".openvpn-ui.lock")
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)

def locked(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        with data_lock():
            return f(*args, **kwargs)
    return decorated_function

def init_db_files():
    with data_lock():
        for path, default in [
            (CLIENT_PASSWORDS, {}),
            (CLIENT_LIMITS, {}),
            (CLIENT_MAPPINGS, {}),
            (DELETED_CLIENTS, []),
            (UI_USERS, [])
        ]:
            if not os.path.exists(path):
                save_json(path, default)

init_db_files()

MAX_FIELD_LEN = 256
CONTROL_CHARS_RE = re.compile(r'[\x00-\x1f\x7f]')

def json_body():
    """Request body as a dict. Anything else (list, string, absent) becomes an empty dict."""
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}

def text_field(data, key, default=""):
    """A string field, stripped. Other JSON types count as absent."""
    value = data.get(key, default)
    return value.strip() if isinstance(value, str) else default

def acceptable_text(value, max_len=MAX_FIELD_LEN):
    """Bounded length and free of control characters such as newlines."""
    return len(value) <= max_len and not CONTROL_CHARS_RE.search(value)

UI_USERNAME_RE = re.compile(r'^[a-zA-Z0-9._@-]{1,64}$')
UI_PASSWORD_MIN_LEN = 8

def ui_password_problem(password):
    """Why a console password is unacceptable, or None when it is fine."""
    if len(password) < UI_PASSWORD_MIN_LEN:
        return f"Password must be at least {UI_PASSWORD_MIN_LEN} characters"
    if not acceptable_text(password, 128):
        return "Password must be at most 128 characters and contain no control characters"
    return None

@app.errorhandler(500)
def api_internal_error(error):
    """Report unexpected failures to the page as JSON, keeping internals in the service log."""
    if request.path.startswith('/api/'):
        return jsonify({"error": "Internal error. See the service log."}), 500
    return "Internal Server Error", 500

def current_account():
    """The signed-in user's record as stored now, or None."""
    username = session.get('username')
    for user in load_json(UI_USERS, []):
        if isinstance(user, dict) and user.get('username') == username:
            return user
    return None

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not session.get('logged_in'):
            return redirect(url_for('login_page'))
        # A session outlives the request that created it. Re-read the account
        # so a deleted user or a changed role takes effect at once.
        account = current_account()
        if account is None:
            session.clear()
            return redirect(url_for('login_page'))
        session['role'] = account.get('role', 'user')
        return f(*args, **kwargs)
    return decorated_function

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if session.get('role') != 'admin':
            return jsonify({"error": "Admin role required"}), 403
        return f(*args, **kwargs)
    return decorated_function

def csrf_token():
    """The per-session token the page must echo on every state-changing request."""
    if 'csrf_token' not in session:
        session['csrf_token'] = secrets.token_urlsafe(32)
    return session['csrf_token']

@app.before_request
def check_csrf():
    if request.method == 'POST' and request.path.startswith('/api/'):
        expected = session.get('csrf_token', '')
        supplied = request.headers.get('X-CSRF-Token', '')
        if not expected or not hmac.compare_digest(expected, supplied):
            return jsonify({"error": "Invalid or missing CSRF token. Reload the page."}), 403

# Failed sign-ins per client address, kept in this worker's memory.
LOGIN_MAX_FAILURES = 5
LOGIN_WINDOW_SECONDS = 900
LOGIN_FAILURES = {}
DUMMY_PASSWORD_HASH = generate_password_hash(secrets.token_urlsafe(16))

def login_blocked(address):
    cutoff = time.time() - LOGIN_WINDOW_SECONDS
    recent = [t for t in LOGIN_FAILURES.get(address, []) if t > cutoff]
    if recent:
        LOGIN_FAILURES[address] = recent
    else:
        LOGIN_FAILURES.pop(address, None)
    return len(recent) >= LOGIN_MAX_FAILURES

def record_login_failure(address):
    LOGIN_FAILURES.setdefault(address, []).append(time.time())

@app.after_request
def add_header(response):
    if request.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('X-Frame-Options', 'DENY')
    response.headers.setdefault('Referrer-Policy', 'same-origin')
    return response

def parse_expiry_date(date_str):
    try:
        if date_str.endswith('Z'):
            date_str = date_str[:-1]
        if len(date_str) == 12:
            dt = datetime.datetime.strptime(date_str, "%y%m%d%H%M%S")
        elif len(date_str) == 14:
            dt = datetime.datetime.strptime(date_str, "%Y%m%d%H%M%S")
        else:
            return date_str
        return dt.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return date_str

def extract_cn(dn):
    match = re.search(r'/CN=([^/]+)', dn)
    if match:
        return match.group(1)
    match = re.search(r'CN=([^,]+)', dn)
    if match:
        return match.group(1)
    return dn

def parse_index_txt():
    clients_dict = {}
    if not os.path.exists(INDEX_TXT):
        return []

    deleted = load_json(DELETED_CLIENTS, [])
    mappings = load_json(CLIENT_MAPPINGS, {})
    passwords = load_json(CLIENT_PASSWORDS, {})
    limits = load_json(CLIENT_LIMITS, {})

    try:
        with open(INDEX_TXT, 'r') as f:
            lines = f.read().splitlines()

        for line in lines:
            if not line.strip():
                continue
            parts = line.split('\t')
            if len(parts) < 6:
                continue

            status = parts[0]
            expiry = parse_expiry_date(parts[1])
            cn = extract_cn(parts[5])

            if cn in deleted:
                continue
            if cn in ['ca', 'server']:
                continue

            username = mappings.get(cn, "-")
            password = decrypt_password(passwords.get(username, "-"))
            limit = limits.get(cn, 1)

            status_str = "Valid"
            if status == 'R':
                status_str = "Revoked"
            elif status == 'E':
                status_str = "Expired"

            clients_dict[cn] = {
                "name": cn,
                "username": username,
                "status": status_str,
                "expiry": expiry,
                "password": password,
                "limit": limit,
                "connected": False,
                "real_address": "-",
                "port": "-",
                "virtual_address": "-",
                "bytes_received": 0,
                "bytes_sent": 0,
                "devices": []
            }
    except Exception as e:
        app.logger.error(f"Error parsing index.txt: {e}")

    return list(clients_dict.values())

def parse_status_log(clients):
    global CONNECTION_CACHE
    if not os.path.exists(OPENVPN_STATUS):
        return clients

    status_data = {}
    try:
        with open(OPENVPN_STATUS, 'r', errors='ignore') as f:
            lines = f.read().splitlines()

        mappings = load_json(CLIENT_MAPPINGS, {})
        reverse_mappings = {uname: cert_cn for cert_cn, uname in mappings.items()}

        for line in lines:
            if line.startswith("CLIENT_LIST,"):
                parts = line.split(',')
                if len(parts) < 8:
                    continue
                username_or_cn = parts[1]
                cn = reverse_mappings.get(username_or_cn, username_or_cn)
                real_addr_full = parts[2]
                virt_addr = parts[3]
                if not virt_addr or virt_addr.strip() in ["", "-", "UNDEF"]:
                    continue
                bytes_rx = int(parts[5])
                bytes_tx = int(parts[6])

                ip_match = re.match(r'^(udp4:|tcp6:|udp6:|tcp4:)?([^:]+):(\d+)$', real_addr_full)
                if ip_match:
                    ip = ip_match.group(2)
                    port = ip_match.group(3)
                else:
                    parts_ip = real_addr_full.rsplit(':', 1)
                    ip = parts_ip[0]
                    port = parts_ip[1] if len(parts_ip) > 1 else "-"

                if cn not in status_data:
                    status_data[cn] = []

                status_data[cn].append({
                    "real_address": ip,
                    "port": port,
                    "virtual_address": virt_addr,
                    "bytes_received": bytes_rx,
                    "bytes_sent": bytes_tx
                })
    except Exception as e:
        app.logger.error(f"Error parsing status log: {e}")

    now = datetime.datetime.now()

    for cn, devices in status_data.items():
        CONNECTION_CACHE[cn] = {
            "last_seen": now,
            "devices": devices,
            "bytes_received": sum([d["bytes_received"] for d in devices]),
            "bytes_sent": sum([d["bytes_sent"] for d in devices])
        }

    for client in clients:
        cn = client["name"]
        if cn in status_data:
            client["connected"] = True
            devices = status_data[cn]
            client["devices"] = devices
            client["real_address"] = ", ".join([d["real_address"] for d in devices])
            client["port"] = ", ".join([d["port"] for d in devices])
            client["virtual_address"] = ", ".join([d["virtual_address"] for d in devices])
            client["bytes_received"] = sum([d["bytes_received"] for d in devices])
            client["bytes_sent"] = sum([d["bytes_sent"] for d in devices])
        elif cn in CONNECTION_CACHE:
            cache_info = CONNECTION_CACHE[cn]
            time_diff = now - cache_info["last_seen"]
            if time_diff.total_seconds() <= 120:
                client["connected"] = True
                devices = cache_info["devices"]
                client["devices"] = devices
                client["real_address"] = ", ".join([d["real_address"] for d in devices])
                client["port"] = ", ".join([d["port"] for d in devices])
                client["virtual_address"] = ", ".join([d["virtual_address"] for d in devices])
                client["bytes_received"] = cache_info["bytes_received"]
                client["bytes_sent"] = cache_info["bytes_sent"]
            else:
                client["connected"] = False
        else:
            client["connected"] = False

    return clients

def parse_ca_vars():
    defaults = settings.ca_defaults
    vars_path = os.path.join(EASYRSA_DIR, "vars")
    if not os.path.exists(vars_path):
        return defaults

    try:
        with open(vars_path, 'r') as f:
            content = f.read()

        country = re.search(r'set_var\s+EASYRSA_REQ_COUNTRY\s+"([^"]+)"', content)
        province = re.search(r'set_var\s+EASYRSA_REQ_PROVINCE\s+"([^"]+)"', content)
        city = re.search(r'set_var\s+EASYRSA_REQ_CITY\s+"([^"]+)"', content)
        org = re.search(r'set_var\s+EASYRSA_REQ_ORG\s+"([^"]+)"', content)
        ou = re.search(r'set_var\s+EASYRSA_REQ_OU\s+"([^"]+)"', content)
        email = re.search(r'set_var\s+EASYRSA_REQ_EMAIL\s+"([^"]+)"', content)

        if country: defaults["country"] = country.group(1)
        if province: defaults["province"] = province.group(1)
        if city: defaults["city"] = city.group(1)
        if org: defaults["org"] = org.group(1)
        if ou: defaults["ou"] = ou.group(1)
        if email: defaults["email"] = email.group(1)
    except Exception:
        pass
    return defaults

def reload_openvpn_service():
    try:
        subprocess.Popen(
            ["sudo", "systemctl", "restart", OPENVPN_SERVICE],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
    except Exception as e:
        app.logger.error(f"Error reloading OpenVPN service: {e}")

@app.route('/')
@login_required
def index_page():
    return render_template(
        'index.html',
        username=session.get('username'),
        role=session.get('role'),
        csrf_token=csrf_token(),
        brand_name=settings.brand_name,
        email_domains=ALLOWED_EMAIL_DOMAINS
    )

@app.route('/login', methods=['GET', 'POST'])
def login_page():
    if session.get('logged_in'):
        return redirect(url_for('index_page'))

    if request.method == 'POST':
        address = request.remote_addr or '-'
        if login_blocked(address):
            audit_logger.info('user=- addr=%s action=login_blocked target=', address)
            return render_template(
                'login.html', brand_name=settings.brand_name,
                error="Too many failed attempts. Try again in a few minutes."
            ), 429

        username = request.form.get('username', '').strip()
        password = request.form.get('password', '').strip()

        users = load_json(UI_USERS, [])
        if not any(isinstance(u, dict) and u.get('username') == username for u in users):
            # Spend the same hashing time for an unknown name as for a known one.
            check_password_hash(DUMMY_PASSWORD_HASH, password)
        for u in users:
            if not isinstance(u, dict):
                continue
            if u.get('username') == username and check_password_hash(u.get('password', ''), password):
                session.clear()
                session.permanent = True
                session['logged_in'] = True
                session['username'] = username
                session['role'] = u.get('role', 'user')
                csrf_token()
                LOGIN_FAILURES.pop(address, None)
                audit('login')
                return redirect(url_for('index_page'))

        record_login_failure(address)
        audit_logger.info('user=- addr=%s action=login_failed target=%s', address, username[:64])
        return render_template('login.html', brand_name=settings.brand_name, error="Invalid username or password")

    return render_template('login.html', brand_name=settings.brand_name)

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login_page'))

@app.route('/api/clients', methods=['GET'])
@login_required
def api_clients():
    clients = parse_index_txt()
    clients = parse_status_log(clients)
    # Connection passwords are for administrators only.
    if session.get('role') != 'admin':
        for client in clients:
            client["password"] = None
    return jsonify(clients)

CPU_SAMPLE = {}

def read_cpu_times():
    """Return (busy, total) jiffies from the aggregate cpu line of /proc/stat."""
    with open('/proc/stat', 'r') as f:
        fields = [int(v) for v in f.readline().split()[1:]]
    idle = fields[3] + (fields[4] if len(fields) > 4 else 0)
    total = sum(fields[:8])
    return total - idle, total

def read_cpu_percent():
    """CPU use since this worker's previous sample, as a percentage."""
    busy, total = read_cpu_times()
    previous = CPU_SAMPLE.get('last')
    if previous is None:
        import time
        previous = (busy, total)
        time.sleep(0.1)
        busy, total = read_cpu_times()
    CPU_SAMPLE['last'] = (busy, total)
    delta_total = total - previous[1]
    if delta_total <= 0:
        return 0.0
    return round(100.0 * (busy - previous[0]) / delta_total, 1)

def read_memory_percent():
    """Memory in use (total minus available) as a percentage, from /proc/meminfo."""
    values = {}
    with open('/proc/meminfo', 'r') as f:
        for line in f:
            key, _, rest = line.partition(':')
            if key in ('MemTotal', 'MemAvailable'):
                values[key] = int(rest.split()[0])
    total = values.get('MemTotal', 0)
    if total <= 0:
        return 0.0
    return round(100.0 * (total - values.get('MemAvailable', 0)) / total, 1)

@app.route('/api/system/stats', methods=['GET'])
@login_required
def api_system_stats():
    stats = {"cpu_percent": None, "memory_percent": None}
    try:
        stats["cpu_percent"] = read_cpu_percent()
    except Exception as e:
        app.logger.error(f"Error reading CPU usage: {e}")
    try:
        stats["memory_percent"] = read_memory_percent()
    except Exception as e:
        app.logger.error(f"Error reading memory usage: {e}")
    return jsonify(stats)

@app.route('/api/ca/defaults', methods=['GET'])
@login_required
def api_ca_defaults():
    return jsonify(parse_ca_vars())

@app.route('/api/clients/create', methods=['POST'])
@login_required
@admin_required
@locked
def api_create_client():
    data = json_body()
    name = text_field(data, "name")
    username = text_field(data, "username")
    password = text_field(data, "password")
    limit = data.get("limit", 1)

    if not name or not username or not password:
        return jsonify({"error": "Device Common Name, Username (Email), and Password are required"}), 400

    if len(name) > 64:
        return jsonify({"error": "Common Name must be at most 64 characters"}), 400

    if len(username) > 254:
        return jsonify({"error": "Username is too long"}), 400

    # OpenVPN hands the hook the password as one line of a file, so a line
    # break or other control character would fail every login.
    if not acceptable_text(password, 128):
        return jsonify({"error": "Password must be at most 128 characters and contain no control characters"}), 400

    dn_fields = {}
    for field, variable in CA_ENV_VARS.items():
        value = text_field(data, field)
        if not value:
            continue
        if not acceptable_text(value, 64) or '/' in value:
            return jsonify({"error": f"Certificate field '{field}' must be at most 64 characters with no slashes or control characters"}), 400
        dn_fields[variable] = value

    if not valid_client_name(name):
        return jsonify({"error": "Common Name must contain only alphanumeric characters, dashes, and underscores"}), 400

    if not valid_vpn_username(username):
        if ALLOWED_EMAIL_DOMAINS:
            allowed = ", ".join("@" + d for d in ALLOWED_EMAIL_DOMAINS)
            return jsonify({"error": f"Username must be a valid email address ending in {allowed}"}), 400
        return jsonify({"error": "Username must be a valid email address"}), 400

    try:
        limit = max(0, int(limit))
    except (TypeError, ValueError):
        limit = 1

    clients = parse_index_txt()
    if any(c["name"] == name for c in clients):
        return jsonify({"error": f"Client certificate with Common Name '{name}' already exists"}), 400

    env = os.environ.copy()
    env["EASYRSA_BATCH"] = "1"
    env.update(dn_fields)

    try:
        deleted = load_json(DELETED_CLIENTS, [])
        if name in deleted:
            deleted.remove(name)
            save_json(DELETED_CLIENTS, deleted)

        subprocess.run(
            ["./easyrsa", "gen-req", name, "nopass"],
            cwd=EASYRSA_DIR, env=env, check=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )

        subprocess.run(
            ["./easyrsa", "sign-req", "client", name],
            cwd=EASYRSA_DIR, env=env, check=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )

        subprocess.run(["sudo", "chown", "-R", f"{FILE_OWNER}:{FILE_OWNER}", EASYRSA_DIR])

        global CONNECTION_CACHE
        CONNECTION_CACHE.pop(name, None)

        mappings = load_json(CLIENT_MAPPINGS, {})
        mappings[name] = username
        save_json(CLIENT_MAPPINGS, mappings)

        passwords = load_json(CLIENT_PASSWORDS, {})
        passwords[username] = encrypt_password(password)
        save_json(CLIENT_PASSWORDS, passwords)

        limits = load_json(CLIENT_LIMITS, {})
        limits[name] = limit
        save_json(CLIENT_LIMITS, limits)

        if os.path.exists(MAKE_CLIENT_SCRIPT):
            build_client_profile(name)

        audit('client_create', name)
        return jsonify({"message": f"Client profile '{name}' created successfully"})
    except subprocess.CalledProcessError as e:
        stderr_msg = e.stderr.decode(errors='ignore') if e.stderr else str(e)
        app.logger.error(f"Easy-RSA error: {stderr_msg}")
        return jsonify({"error": f"Failed to generate certificate: {stderr_msg}"}), 500
    except Exception as e:
        app.logger.error(f"Error during client creation: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/clients/download/<name>', methods=['GET'])
@login_required
def api_download_client(name):
    if not valid_client_name(name):
        return jsonify({"error": "Invalid client name"}), 400

    clients = parse_index_txt()
    if not any(c["name"] == name for c in clients):
        return jsonify({"error": f"Client '{name}' not found"}), 404

    client_ovpn = client_profile_path(name)

    if not os.path.exists(client_ovpn):
        if os.path.exists(MAKE_CLIENT_SCRIPT):
            try:
                build_client_profile(name)
            except Exception as e:
                app.logger.error(f"Failed to generate configuration dynamically: {e}")
                return jsonify({"error": "Dynamic configuration generation failed"}), 500
        else:
            return jsonify({"error": "Configuration file not found and maker script missing"}), 404

    try:
        with open(client_ovpn, 'r') as f:
            content = f.read()
        audit('client_download', name)
        return content, 200, {
            'Content-Type': 'application/x-openvpn-profile',
            'Content-Disposition': f'attachment; filename={name}.ovpn'
        }
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/clients/revoke', methods=['POST'])
@login_required
@admin_required
@locked
def api_revoke_client():
    data = json_body()
    name = text_field(data, "name")

    if not name:
        return jsonify({"error": "Client name is required"}), 400
    if not valid_client_name(name):
        return jsonify({"error": "Invalid client name"}), 400

    try:
        cert_path = os.path.join(EASYRSA_DIR, "pki", "issued", f"{name}.crt")

        if not os.path.exists(cert_path):
            restored = False
            if os.path.exists(INDEX_TXT):
                with open(INDEX_TXT, 'r') as f:
                    for line in f:
                        if f"/CN={name}" in line or f"CN={name}" in line:
                            parts = line.split('\t')
                            if len(parts) > 3:
                                serial = parts[3]
                                backup_pem = os.path.join(EASYRSA_DIR, "pki", "certs_by_serial", f"{serial}.pem")
                                if os.path.exists(backup_pem):
                                    os.makedirs(os.path.dirname(cert_path), exist_ok=True)
                                    shutil.copy(backup_pem, cert_path)
                                    restored = True
                                    break
            if not restored:
                return jsonify({"error": f"Certificate file for '{name}' is missing and could not be restored"}), 400

        env = os.environ.copy()
        env["EASYRSA_BATCH"] = "1"

        subprocess.run(
            ["./easyrsa", "revoke", name],
            cwd=EASYRSA_DIR, env=env, check=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )

        subprocess.run(
            ["./easyrsa", "gen-crl"],
            cwd=EASYRSA_DIR, env=env, check=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )

        crl_source = os.path.join(EASYRSA_DIR, "pki", "crl.pem")
        crl_dest = CRL_FILE
        if os.path.exists(crl_source):
            subprocess.run(["sudo", "cp", crl_source, crl_dest], check=True)
            subprocess.run(["sudo", "chmod", "644", crl_dest], check=True)

        subprocess.run(["sudo", "chown", "-R", f"{FILE_OWNER}:{FILE_OWNER}", EASYRSA_DIR])

        global CONNECTION_CACHE
        CONNECTION_CACHE.pop(name, None)

        reload_openvpn_service()

        audit('client_revoke', name)
        return jsonify({"message": f"Client '{name}' revoked successfully"})
    except subprocess.CalledProcessError as e:
        stderr_msg = e.stderr.decode(errors='ignore') if e.stderr else str(e)
        app.logger.error(f"Revocation error: {stderr_msg}")
        return jsonify({"error": f"Failed to revoke certificate: {stderr_msg}"}), 500
    except Exception as e:
        app.logger.error(f"Error revoking client: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/clients/delete', methods=['POST'])
@login_required
@admin_required
@locked
def api_delete_client():
    data = json_body()
    name = text_field(data, "name")

    if not name:
        return jsonify({"error": "Client name is required"}), 400
    if not valid_client_name(name):
        return jsonify({"error": "Invalid client name"}), 400

    try:
        deleted = load_json(DELETED_CLIENTS, [])
        if name not in deleted:
            deleted.append(name)
            save_json(DELETED_CLIENTS, deleted)

        global CONNECTION_CACHE
        CONNECTION_CACHE.pop(name, None)

        mappings = load_json(CLIENT_MAPPINGS, {})
        username = mappings.pop(name, None)
        save_json(CLIENT_MAPPINGS, mappings)

        if username:
            if not any(uname == username for uname in mappings.values()):
                passwords = load_json(CLIENT_PASSWORDS, {})
                passwords.pop(username, None)
                save_json(CLIENT_PASSWORDS, passwords)

        limits = load_json(CLIENT_LIMITS, {})
        limits.pop(name, None)
        save_json(CLIENT_LIMITS, limits)

        client_ovpn = client_profile_path(name)
        if os.path.exists(client_ovpn):
            os.remove(client_ovpn)

        audit('client_delete', name)
        return jsonify({"message": f"Client '{name}' configuration removed successfully"})
    except Exception as e:
        app.logger.error(f"Error deleting client: {e}")
        return jsonify({"error": str(e)}), 500

LOG_TS_RE = re.compile(r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+')
LOG_PEER_RE = re.compile(r'^(?:(?P<user>\S+)/)?(?:udp|tcp)[46]?:(?P<ip>\S+):(?P<port>\d+)\s+(?P<msg>.*)$')
LOG_USER_RES = [
    re.compile(r"for username '([^']+)'"),
    re.compile(r'^\[([^\]]+)\] Peer Connection Initiated'),
    re.compile(r'SENT CONTROL \[([^\]]+)\]'),
    re.compile(r'Rejecting connection for (\S+)'),
]

# (pattern, event, category, severity, routine)
# First match wins. A named group "d" becomes the Details column; otherwise the
# message itself is shown. Routine lines are hidden unless verbose=1 is passed.
LOG_EVENT_RULES = [(re.compile(p), ev, cat, sev, routine) for p, ev, cat, sev, routine in [
    (r'Peer Connection Initiated with \[\w+\](?P<d>\S+)', 'Connected', 'traffic', 'INFO', False),
    (r'pool returned IPv4=(?P<d>[^,\s]+)', 'Virtual IP assigned', 'traffic', 'INFO', False),
    (r'SIGTERM\[soft,(?P<d>[^\]]*ping[^\]]*)\]', 'Disconnected (timeout)', 'traffic', 'INFO', False),
    (r'SIGTERM\[soft,(?P<d>[^\]]*)\] received, client-instance exiting', 'Disconnected', 'traffic', 'INFO', False),
    (r'Rejecting connection for .*?(?P<d>limit of \d+ exceeded.*)$', 'Device limit exceeded', 'traffic', 'WARNING', False),
    (r'Failed running command \(--client-connect\)', 'Connection rejected', 'traffic', 'WARNING', False),

    (r'authentication succeeded for username', 'Login succeeded', 'auth', 'INFO', False),
    (r'Auth Username/Password verification failed', 'Login failed', 'auth', 'ERROR', False),
    (r"'AUTH_FAILED'", 'Login rejected', 'auth', 'ERROR', False),

    (r'VERIFY ERROR: (?P<d>.*)$', 'Certificate rejected', 'tls', 'ERROR', False),
    (r'Sent fatal SSL alert: (?P<d>.*)$', 'Certificate rejected', 'tls', 'ERROR', False),
    (r'VERIFY OK: depth=0, (?P<d>.*)$', 'Certificate verified', 'tls', 'INFO', False),
    (r'VERIFY OK', 'CA verified', 'tls', 'INFO', True),
    (r'TLS key negotiation failed', 'TLS handshake timed out', 'tls', 'ERROR', False),
    (r'TLS handshake failed', 'TLS handshake failed', 'tls', 'ERROR', True),
    (r'tls-crypt unwrap(?:ping failed from \[\w+\](?P<d>\S+)| error: (?P<d2>.*))', 'Invalid packet (tls-crypt)', 'tls', 'WARNING', False),
    (r'SIGUSR1\[soft,tls-error\]', 'Client reset (TLS error)', 'tls', 'ERROR', False),
    (r'connect-freq-initial', 'Handshake rate limit hit', 'tls', 'WARNING', False),
    (r'TLS Error|TLS_ERROR|OpenSSL: error', 'TLS error', 'tls', 'ERROR', False),
    (r'TLS: soft reset', 'Key renegotiation', 'tls', 'INFO', True),
    (r'Control Channel: (?P<d>.*)$', 'Control channel', 'tls', 'INFO', True),
    (r'Data Channel: (?P<d>.*)$', 'Data channel', 'tls', 'INFO', True),
    (r'TLS: (?:move_session|tls_multi_process)', 'TLS session', 'tls', 'INFO', True),

    (r'peer info: IV_GUI_VER=(?P<d>.*)$', 'Client software', 'general', 'INFO', True),
    (r'peer info: IV_PLAT=(?P<d>.*)$', 'Client platform', 'general', 'INFO', True),
    (r'peer info:', 'Client info', 'general', 'INFO', True),
    (r'Initialization Sequence Completed', 'Server started', 'general', 'INFO', False),
    (r'SIG\w+\[hard,[^\]]*\] received, process exiting', 'Server stopped', 'general', 'WARNING', False),
    (r'Options error: (?P<d>.*)$', 'Configuration error', 'general', 'ERROR', False),
    (r'CRL: (?P<d>.*)$', 'CRL loaded', 'general', 'INFO', False),
    (r'^OpenVPN \d', 'Server starting', 'general', 'INFO', True),
    (r'Socket bind failed on local address (?P<d>.*)$', 'Server failed to bind', 'general', 'ERROR', False),
    (r'Exiting due to fatal error', 'Server exited (fatal error)', 'general', 'ERROR', False),
    (r'^(?:WARNING|Warning)[: ]\s*(?P<d>.*)$', 'Warning', 'general', 'WARNING', False),
    (r'^(?:net_\w+|sitnl_send|dco_get_peer)\b|DCO device|ovpn-dco|DCO version|library versions|Diffie-Hellman'
     r'|Socket Buffers|UDPv\d link|IFCONFIG POOL|MULTI IO|Use --help|^Note: |^NOTE: |No encryption key found'
     r'|^read UDPv\d|Current Parameter Settings|Connection profiles|Local Sockets|^\[[\d.:a-fA-F]+\]:\d+-\w+$'
     r'|^\w+(?:\[\w+\])? = ', 'Server setup', 'general', 'INFO', True),

    (r'MULTI: |PUSH: Received|SENT CONTROL .*PUSH_REPLY|Timers: |Protocol options|OPTIONS IMPORT', 'Session setup', 'traffic', 'INFO', True),
    (r'CC-EEN exit message|Delayed exit in', 'Client exiting', 'traffic', 'INFO', True),
    (r'dco_read_and_process|ovpn_handle_peer|Connection Attempt read', 'Transport notice', 'general', 'INFO', True),
]]

# Facts a single line can reveal about its session. They are carried onto every
# other row of the same session so each row identifies who and what it concerns.
LOG_SESSION_FIELD_RES = {
    "cert_cn": re.compile(r'VERIFY (?:OK|ERROR): depth=0,.*?CN=([^,\s]+)|\(CN: ([^)]+)\)'),
    "virtual_ip": re.compile(r'pool returned IPv4=([^,\s]+)'),
    "platform": re.compile(r'peer info: IV_PLAT=(\S+)'),
    "client": re.compile(r'peer info: IV_GUI_VER=(\S+)'),
}
LOG_SESSION_FIELDS = ("user", "cert_cn", "virtual_ip", "platform", "client")
LOG_SESSION_END_RE = re.compile(r'client-instance (?:exiting|restarting)')
LOG_RESPONSE_CACHE = {}
# Log lines hold text chosen by whoever connects. Bound the work per request.
LOG_MAX_ROWS = 5000
LOG_MAX_LINE_LEN = 2000

def log_time_to_utc(time_str):
    """OpenVPN writes timestamps in the server's local time; report them in UTC."""
    try:
        local_dt = datetime.datetime.strptime(time_str, '%Y-%m-%d %H:%M:%S')
        return local_dt.astimezone(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
    except Exception:
        return time_str

def parse_log_line(line):
    """Split one OpenVPN log line into the fields the log table shows."""
    time_str = None
    ts_match = LOG_TS_RE.match(line)
    rest = line[ts_match.end():] if ts_match else line
    if ts_match:
        time_str = log_time_to_utc(ts_match.group(1))
    rest = re.sub(r'^us=\d+\s+', '', rest)

    user, ip, port, msg = None, None, None, rest
    peer = LOG_PEER_RE.match(rest)
    if peer:
        user, ip, port, msg = peer.group('user'), peer.group('ip'), peer.group('port'), peer.group('msg')

    if not user:
        for user_re in LOG_USER_RES:
            found = user_re.search(msg)
            if found and found.group(1) != 'UNDEF':
                user = found.group(1)
                break

    lowered = msg.lower()
    event, cat, sev, routine, details = 'Other', 'general', 'INFO', False, msg
    if 'error' in lowered or 'fatal' in lowered or 'failed' in lowered:
        sev = 'ERROR'
    elif 'warn' in lowered:
        sev = 'WARNING'

    for pattern, rule_event, rule_cat, rule_sev, rule_routine in LOG_EVENT_RULES:
        found = pattern.search(msg)
        if found:
            event, cat, sev, routine = rule_event, rule_cat, rule_sev, rule_routine
            captured = [g for g in found.groupdict().values() if g]
            if captured:
                details = captured[0]
            break

    entry = {
        "time": time_str,
        "severity": sev,
        "category": cat,
        "event": event,
        "user": user,
        "ip": ip,
        "port": port,
        "cert_cn": None,
        "virtual_ip": None,
        "platform": None,
        "client": None,
        "details": details,
        "routine": routine,
        "ends_session": bool(LOG_SESSION_END_RE.search(msg)),
        "text": line
    }
    for field, field_re in LOG_SESSION_FIELD_RES.items():
        found = field_re.search(msg)
        if found:
            entry[field] = next((g for g in found.groups() if g), None)
    return entry

@app.route('/api/logs', methods=['GET'])
@login_required
def api_logs():
    category = request.args.get('category', 'all')
    severity = request.args.get('severity', 'all')
    limit = request.args.get('limit', '100')
    timeframe = request.args.get('timeframe', 'all')
    verbose = request.args.get('verbose', '0') == '1'

    try:
        limit = min(max(int(limit), 1), LOG_MAX_ROWS)
    except ValueError:
        limit = 100

    if not os.path.exists(OPENVPN_LOG):
        return jsonify([])

    # The page polls every few seconds; reuse the last answer while the log file
    # is unchanged. Time-window queries are not cached because they age.
    cache_key = (category, severity, limit, verbose)
    try:
        log_stat = os.stat(OPENVPN_LOG)
        log_signature = (log_stat.st_mtime_ns, log_stat.st_size)
    except OSError:
        log_signature = None
    if timeframe == 'all' and log_signature:
        cached = LOG_RESPONSE_CACHE.get(cache_key)
        if cached and cached[0] == log_signature:
            return jsonify(cached[1])

    parsed_logs = []
    try:
        timestamp_regex = re.compile(r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})')

        current_time = datetime.datetime.now()
        cutoff_time = None
        if timeframe == '30m':
            cutoff_time = current_time - datetime.timedelta(minutes=30)
        elif timeframe == '1h':
            cutoff_time = current_time - datetime.timedelta(hours=1)
        elif timeframe == '24h':
            cutoff_time = current_time - datetime.timedelta(hours=24)
        elif timeframe == '3d':
            cutoff_time = current_time - datetime.timedelta(days=3)
        elif timeframe == '1w':
            cutoff_time = current_time - datetime.timedelta(days=7)
        elif timeframe == '1m':
            cutoff_time = current_time - datetime.timedelta(days=30)

        # Undecodable bytes become a visible marker so odd input stays evident.
        with open(OPENVPN_LOG, 'r', encoding='utf-8', errors='replace') as f:
            lines = f.readlines()

        last_timestamp = None
        candidates = []
        for line in lines:
            line = line.strip()
            if not line:
                continue

            match = timestamp_regex.match(line)
            if match:
                try:
                    last_timestamp = datetime.datetime.strptime(match.group(1), '%Y-%m-%d %H:%M:%S')
                except Exception:
                    pass

            if cutoff_time and last_timestamp and last_timestamp < cutoff_time:
                continue

            candidates.append(line[:LOG_MAX_LINE_LEN])

        # Only the newest rows are returned, so parse the tail of the log and
        # widen the window only when it does not yield enough matching rows.
        window = max(2000, limit * 30)
        while True:
            parsed_logs = []
            sessions = {}
            for line in candidates[-window:]:
                entry = parse_log_line(line)

                # Lines from one client share a peer address until that client exits.
                session_info = None
                if entry["ip"]:
                    peer_key = f'{entry["ip"]}:{entry["port"]}'
                    session_info = sessions.setdefault(peer_key, {})
                    for field in LOG_SESSION_FIELDS:
                        if entry[field]:
                            session_info[field] = entry[field]
                    if entry.pop("ends_session"):
                        sessions.pop(peer_key, None)
                else:
                    entry.pop("ends_session")

                if entry["routine"] and not verbose:
                    continue
                if severity != 'all' and entry["severity"] != severity:
                    continue
                if category != 'all' and entry["category"] != category:
                    continue

                parsed_logs.append((entry, session_info))

            if len(parsed_logs) >= limit or window >= len(candidates):
                break
            window *= 4

    except Exception as e:
        app.logger.error(f"Error reading logs: {e}")

    newest_first = []
    for entry, session_info in reversed(parsed_logs[-limit:] if limit > 0 else parsed_logs):
        if session_info:
            for field in LOG_SESSION_FIELDS:
                if not entry[field]:
                    entry[field] = session_info.get(field)
        newest_first.append(entry)

    if timeframe == 'all' and log_signature:
        LOG_RESPONSE_CACHE.clear()
        LOG_RESPONSE_CACHE[cache_key] = (log_signature, newest_first)
    return jsonify(newest_first)

@app.route('/api/ui-users', methods=['GET'])
@login_required
@admin_required
def api_ui_users():
    users = load_json(UI_USERS, [])
    clean_users = [{"username": u["username"], "role": u.get("role", "user")} for u in users]
    return jsonify(clean_users)

@app.route('/api/ui-users/create', methods=['POST'])
@login_required
@admin_required
@locked
def api_ui_users_create():
    data = json_body()
    username = text_field(data, "username")
    password = text_field(data, "password")
    role = text_field(data, "role", "user")

    if not username or not password or role not in ['admin', 'user']:
        return jsonify({"error": "Invalid username, password or role"}), 400

    if not UI_USERNAME_RE.match(username):
        return jsonify({"error": "Username must be 1 to 64 letters, digits, dots, dashes, underscores or @"}), 400

    password_error = ui_password_problem(password)
    if password_error:
        return jsonify({"error": password_error}), 400

    users = load_json(UI_USERS, [])
    if any(u["username"] == username for u in users):
        return jsonify({"error": f"UI User '{username}' already exists"}), 400

    users.append({
        "username": username,
        "password": generate_password_hash(password),
        "role": role
    })
    save_json(UI_USERS, users)
    audit('ui_user_create', f"{username} role={role}")
    return jsonify({"message": f"UI User '{username}' created successfully"})

@app.route('/api/ui-users/update', methods=['POST'])
@login_required
@admin_required
@locked
def api_ui_users_update():
    data = json_body()
    username = text_field(data, "username")
    password = text_field(data, "password")
    role = text_field(data, "role")

    if password:
        password_error = ui_password_problem(password)
        if password_error:
            return jsonify({"error": password_error}), 400

    users = load_json(UI_USERS, [])
    found = False
    for u in users:
        if u["username"] == username:
            if password:
                u["password"] = generate_password_hash(password)
            if role in ['admin', 'user']:
                u["role"] = role
            found = True
            break

    if not found:
        return jsonify({"error": f"UI User '{username}' not found"}), 404

    if not any(u.get("role") == "admin" for u in users):
        return jsonify({"error": "At least one admin account must remain"}), 400

    save_json(UI_USERS, users)
    audit('ui_user_update', username)
    return jsonify({"message": f"UI User '{username}' updated successfully"})

@app.route('/api/ui-users/delete', methods=['POST'])
@login_required
@admin_required
@locked
def api_ui_users_delete():
    data = json_body()
    username = text_field(data, "username")

    if username == session.get('username'):
        return jsonify({"error": "Cannot delete your own logged-in account"}), 400

    users = load_json(UI_USERS, [])
    new_users = [u for u in users if u["username"] != username]

    if len(new_users) == len(users):
        return jsonify({"error": f"UI User '{username}' not found"}), 404

    if not any(u.get("role") == "admin" for u in new_users):
        return jsonify({"error": "At least one admin account must remain"}), 400

    save_json(UI_USERS, new_users)
    audit('ui_user_delete', username)
    return jsonify({"message": f"UI User '{username}' deleted successfully"})

@app.route('/api/ui-users/change-password', methods=['POST'])
@login_required
@locked
def api_ui_users_change_password():
    data = json_body()
    current_pass = text_field(data, "current_password")
    new_pass = text_field(data, "new_password")

    if not current_pass or not new_pass:
        return jsonify({"error": "Both current and new passwords are required"}), 400

    password_error = ui_password_problem(new_pass)
    if password_error:
        return jsonify({"error": password_error}), 400

    username = session.get('username')
    users = load_json(UI_USERS, [])

    found = False
    for u in users:
        if u["username"] == username:
            if check_password_hash(u["password"], current_pass):
                u["password"] = generate_password_hash(new_pass)
                found = True
                break
            else:
                return jsonify({"error": "Incorrect current password"}), 400

    if not found:
        return jsonify({"error": "Logged-in user not found in database"}), 404

    save_json(UI_USERS, users)
    audit('password_change', username)
    return jsonify({"message": "Password changed successfully"})

if __name__ == '__main__':
    app.run(host=settings.get('bind_address', '127.0.0.1'), port=int(settings.get('port', 8080)))