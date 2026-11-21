import base64
import json
import os
from pathlib import Path
import secrets
import tempfile
import threading

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def data_directory():
    return Path(os.environ.get("ONEYES_DATA_DIR", Path.home() / ".oneyes-comfyui"))


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".oneyes-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            json.dump(value, file, ensure_ascii=False)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Vault:
    def __init__(self, directory=None):
        self.directory = Path(directory or data_directory())
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.Lock()

    def master(self):
        path = self.directory / "vault.master"
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            return path.read_bytes()
        with os.fdopen(fd, "wb") as file:
            file.write(secrets.token_bytes(32))
        return path.read_bytes()

    def read(self):
        path = self.directory / "vault.json"
        if not path.exists():
            return {}
        envelope = json.loads(path.read_text("utf-8"))
        plain = AESGCM(self.master()).decrypt(base64.b64decode(envelope["iv"]), base64.b64decode(envelope["data"]), None)
        return json.loads(plain)

    def save(self, changes):
        with self.lock:
            values = self.read()
            for name, value in changes.items():
                if name not in ("default", "image", "text") or not isinstance(value, str):
                    raise ValueError("Key 设置无效")
                if value.strip():
                    values[name] = value.strip()
                else:
                    values.pop(name, None)
                values.get("_owners", {}).pop(name, None)
            iv = secrets.token_bytes(12)
            encrypted = AESGCM(self.master()).encrypt(iv, json.dumps(values).encode(), None)
            write_json(self.directory / "vault.json", {"iv": base64.b64encode(iv).decode(), "data": base64.b64encode(encrypted).decode()})

    def key(self, profile):
        values = self.read()
        value = values.get(profile) or values.get("default") or os.environ.get("ONEYES_API_KEY")
        if not value:
            raise ValueError("请先打开 OneYes 设置并保存 API Key")
        return value

    def status(self):
        values = self.read()
        return {name: bool(values.get(name)) for name in ("default", "image", "text")}
