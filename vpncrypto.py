"""Encryption of stored VPN passwords, shared by the web app and the auth hook.

Passwords are stored reversibly because administrators read them back in the
console. Two formats exist:

  v2      "v2:" + base64(iv[16] + ciphertext + tag[32])
          Separate encryption and authentication keys are derived from the
          secret key. The tag is HMAC-SHA256 over the iv and ciphertext, so a
          modified or truncated value is detected and refused.

  legacy  base64(iv[16] + ciphertext), keyed directly with the secret key and
          carrying no tag. Still readable so existing databases keep working.
          Saving a password again stores it as v2.

The keystream is HMAC-SHA256(key, iv + block counter), 32 bytes per block.
"""
import base64
import hashlib
import hmac
import os

V2_PREFIX = "v2:"
IV_LEN = 16
TAG_LEN = 32
MIN_KEY_LEN = 16


class SecretKeyError(Exception):
    """The secret key file is missing, unreadable, or too short."""


def read_secret_key(path):
    try:
        with open(path, 'rb') as f:
            key = f.read()
    except OSError as e:
        raise SecretKeyError(f"Cannot read secret key file {path}: {e}")
    if len(key) < MIN_KEY_LEN:
        raise SecretKeyError(f"Secret key file {path} holds fewer than {MIN_KEY_LEN} bytes")
    return key


def _derive(key, label):
    return hmac.new(key, b"openvpn-ui:" + label, hashlib.sha256).digest()


def _keystream_xor(key, iv, data):
    out = bytearray()
    for block_index, offset in enumerate(range(0, len(data), 32)):
        block = hmac.new(key, iv + block_index.to_bytes(4, 'big'), hashlib.sha256).digest()
        chunk = data[offset:offset + 32]
        out.extend(b ^ block[i] for i, b in enumerate(chunk))
    return bytes(out)


def encrypt_password(password, key):
    iv = os.urandom(IV_LEN)
    ciphertext = _keystream_xor(_derive(key, b"enc"), iv, password.encode('utf-8'))
    tag = hmac.new(_derive(key, b"mac"), b"v2" + iv + ciphertext, hashlib.sha256).digest()
    return V2_PREFIX + base64.b64encode(iv + ciphertext + tag).decode('ascii')


def decrypt_password(stored, key):
    """Return the password in clear, or None when the value cannot be trusted."""
    if not isinstance(stored, str) or not stored:
        return None
    try:
        if stored.startswith(V2_PREFIX):
            blob = base64.b64decode(stored[len(V2_PREFIX):].encode('ascii'), validate=True)
            if len(blob) < IV_LEN + TAG_LEN:
                return None
            iv, ciphertext, tag = blob[:IV_LEN], blob[IV_LEN:-TAG_LEN], blob[-TAG_LEN:]
            expected = hmac.new(_derive(key, b"mac"), b"v2" + iv + ciphertext, hashlib.sha256).digest()
            if not hmac.compare_digest(tag, expected):
                return None
            return _keystream_xor(_derive(key, b"enc"), iv, ciphertext).decode('utf-8')

        blob = base64.b64decode(stored.encode('ascii'), validate=True)
        if len(blob) < IV_LEN:
            return None
        return _keystream_xor(key, blob[:IV_LEN], blob[IV_LEN:]).decode('utf-8')
    except (ValueError, UnicodeError):
        return None
