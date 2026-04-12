from fastapi import FastAPI, HTTPException, Depends, status, WebSocket, WebSocketDisconnect, Query, UploadFile, File, Form, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from typing import Optional, List
import paramiko
import asyncio
import json
import os
import jwt
import hashlib
import time
import io
import threading
import select
import subprocess
import tempfile
import base64
import sqlite3
from datetime import datetime, timedelta, timezone
from twofa.auth import TwoFa
from contextlib import asynccontextmanager
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

app = FastAPI(title=f"{os.getenv('APP_NAME', 'ServerHub')} API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

security = HTTPBearer()

# ─────────────────────── Config ───────────────────────
APP_NAME = os.getenv("APP_NAME", "ServerHub")

JWT_SECRET = os.getenv("JWT_SECRET", "serverhub-super-secret-change-in-prod")
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_HOURS = 12

ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin123")

SERVERS_FILE   = "/data/servers.json"
DB_FILE        = "/data/serverhub.db"
SSH_KEYS_DIR   = "/data/ssh_keys"
WG_CONFIGS_DIR = "/data/wg_configs"

# ─────────────────────── 2FA storage config ───────────────────────
TWOFA_STORAGE                 = os.getenv("TWOFA_STORAGE", "")
TWOFA_S3_BUCKET               = os.getenv("TWOFA_S3_BUCKET", "")
TWOFA_S3_ACCESS_KEY           = os.getenv("TWOFA_S3_ACCESS_KEY", "")
TWOFA_S3_SECRET_ACCESS        = os.getenv("TWOFA_S3_SECRET_ACCESS", "")
TWOFA_CLOUDINARY_CLOUD_NAME   = os.getenv("TWOFA_CLOUDINARY_CLOUD_NAME", "")
TWOFA_CLOUDINARY_API_KEY      = os.getenv("TWOFA_CLOUDINARY_API_KEY", "")
TWOFA_CLOUDINARY_API_SECRET   = os.getenv("TWOFA_CLOUDINARY_API_SECRET", "")

os.makedirs("/data", exist_ok=True)
os.makedirs(SSH_KEYS_DIR, exist_ok=True)
os.makedirs(WG_CONFIGS_DIR, exist_ok=True)

# ─────────────────────── Encryption ───────────────────────
def _derive_fernet_key() -> bytes:
    """Derive a stable Fernet key from JWT_SECRET + a fixed salt."""
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=b"serverhub-data-v1",
        iterations=200_000,
    )
    return base64.urlsafe_b64encode(kdf.derive(JWT_SECRET.encode()))

_fernet = Fernet(_derive_fernet_key())

def encrypt(plaintext: str) -> str:
    return _fernet.encrypt(plaintext.encode()).decode()

def decrypt(ciphertext: str) -> str:
    return _fernet.decrypt(ciphertext.encode()).decode()

# ─────────────────────── Models ───────────────────────
class LoginRequest(BaseModel):
    username: str
    password: str

class ServerCreate(BaseModel):
    name: str
    ip: str
    port: int = 22
    username: str
    auth_type: str  # "password" or "key"
    password: Optional[str] = None
    private_key: Optional[str] = None
    tag: str = "server"
    # WireGuard (optional)
    use_wireguard: bool = False
    wg_config: Optional[str] = None   # full [Interface]+[Peer] wg config block

class ServerAccessRequest(BaseModel):
    server_ids: List[str]

class UserCreate(BaseModel):
    username: str
    password: str
    role: str = "developer"   # "admin" | "developer"

class StepUpRequest(BaseModel):
    code: str

class PreflightRequest(BaseModel):
    username: str

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

class ChangeRoleRequest(BaseModel):
    role: str

class CommandRequest(BaseModel):
    command: str

class Server(BaseModel):
    id: str
    name: str
    ip: str
    port: int
    username: str
    auth_type: str
    tag: str
    status: str = "unknown"

# ─────────────────────── Persistence ───────────────────────
def load_servers() -> dict:
    if os.path.exists(SERVERS_FILE):
        with open(SERVERS_FILE, "r") as f:
            return json.load(f)
    return {}

def save_servers(servers: dict):
    with open(SERVERS_FILE, "w") as f:
        json.dump(servers, f, indent=2)

def hash_password(password: str) -> str:
    return hashlib.sha256(f"serverhub-salt:{password}".encode()).hexdigest()

# ─────────────────────── SQLite DB ───────────────────────
def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                username      TEXT PRIMARY KEY,
                password_hash TEXT NOT NULL DEFAULT '',
                role          TEXT NOT NULL DEFAULT 'developer',
                created_at    TEXT NOT NULL,
                created_by    TEXT,
                twofa_key     TEXT,
                twofa_qr_url  TEXT,
                twofa_enabled INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS permissions (
                username  TEXT NOT NULL,
                server_id TEXT NOT NULL,
                PRIMARY KEY (username, server_id)
            );
        """)
        # Migrate existing DB — add columns if they don't exist yet
        for col_def in ("twofa_key TEXT", "twofa_qr_url TEXT", "twofa_enabled INTEGER DEFAULT 0"):
            try:
                conn.execute(f"ALTER TABLE users ADD COLUMN {col_def}")
            except sqlite3.OperationalError:
                pass  # column already exists
        # Migrate: mark any existing users who already have a twofa_key as enabled
        conn.execute(
            "UPDATE users SET twofa_enabled = 1 WHERE twofa_key IS NOT NULL AND twofa_key != '' AND twofa_enabled = 0"
        )
        # Bootstrap admin from env if table is empty
        cur = conn.execute("SELECT COUNT(*) FROM users")
        if cur.fetchone()[0] == 0:
            conn.execute(
                "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, 'admin', ?)",
                (ADMIN_USERNAME, hash_password(ADMIN_PASSWORD), datetime.now(timezone.utc).isoformat()),
            )
        conn.commit()
    finally:
        conn.close()

init_db()

# ─────────────────────── 2FA helpers ───────────────────────
def _twofa_client() -> TwoFa:
    return TwoFa(issuer_name=APP_NAME)

def setup_user_2fa(identifier: str) -> dict:
    """Generate a QR code via the twofa library. Returns {user_key, qr_url}."""
    if not TWOFA_STORAGE:
        raise HTTPException(
            status_code=500,
            detail="2FA storage is not configured. Set TWOFA_STORAGE (and matching credentials) in .env"
        )
    if TWOFA_STORAGE not in ("s3bucket", "cloudinary"):
        raise HTTPException(
            status_code=500,
            detail=f"Unknown TWOFA_STORAGE value '{TWOFA_STORAGE}'. Use 's3bucket' or 'cloudinary'"
        )
    client = _twofa_client()
    if TWOFA_STORAGE == "s3bucket":
        result = client.generate_qr_code(
            identifier=identifier,
            storage="s3bucket",
            bucket_name=TWOFA_S3_BUCKET,
            access_key=TWOFA_S3_ACCESS_KEY,
            secret_access=TWOFA_S3_SECRET_ACCESS,
        )
    else:
        result = client.generate_qr_code(
            identifier=identifier,
            storage="cloudinary",
            cloud_name=TWOFA_CLOUDINARY_CLOUD_NAME,
            api_key=TWOFA_CLOUDINARY_API_KEY,
            api_secret=TWOFA_CLOUDINARY_API_SECRET,
        )
    if not result.get("status"):
        raise HTTPException(status_code=500, detail=f"Failed to generate 2FA QR code: {result.get('message', '')}")
    return {"user_key": result["user_key"], "qr_url": result["url"]}

def verify_user_2fa(user_key: str, code: str) -> bool:
    """Validate a TOTP code against the stored user_key."""
    result = _twofa_client().validate_code(user_key=user_key, code=code)
    return result.get("status") is True and result.get("message") == "valid"


def assert_server_access(server_id: str, username: str):
    """Raise 403 if a developer has not been granted access to this server."""
    conn = get_db()
    try:
        row = conn.execute("SELECT role FROM users WHERE username = ?", (username,)).fetchone()
        if row and row["role"] == "admin":
            return  # admins always have full access
        exists = conn.execute(
            "SELECT 1 FROM permissions WHERE username = ? AND server_id = ?", (username, server_id)
        ).fetchone()
        if not exists:
            raise HTTPException(status_code=403, detail="You do not have access to this server")
    finally:
        conn.close()

def get_key_path(server_id: str) -> str:
    return os.path.join(SSH_KEYS_DIR, f"{server_id}.pem")

def get_wg_path(server_id: str) -> str:
    return os.path.join(WG_CONFIGS_DIR, f"{server_id}.conf.enc")

# ─────────────────────── Auth ───────────────────────
def create_token(username: str) -> str:
    payload = {
        "sub": username,
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRE_HOURS),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

def verify_token(credentials: HTTPAuthorizationCredentials = Depends(security)) -> str:
    try:
        payload = jwt.decode(credentials.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload["sub"]
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

def require_admin(username: str = Depends(verify_token)) -> str:
    conn = get_db()
    try:
        row = conn.execute("SELECT role FROM users WHERE username = ?", (username,)).fetchone()
        if not row or row["role"] != "admin":
            raise HTTPException(status_code=403, detail="Admin access required")
    finally:
        conn.close()
    return username

# ─────────────────────── Step-up (2FA gate for server access) ───────────────────────
STEP_UP_SECRET = JWT_SECRET + "_stepup_v1"
STEP_UP_EXPIRE_MINUTES = 15

def create_step_up_token(username: str) -> str:
    payload = {
        "sub": username,
        "type": "step_up",
        "exp": datetime.now(timezone.utc) + timedelta(minutes=STEP_UP_EXPIRE_MINUTES),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, STEP_UP_SECRET, algorithm=JWT_ALGORITHM)

def require_admin_and_2fa(request: Request, user: str = Depends(require_admin)) -> str:
    """Admin-only endpoints that always require a valid step-up 2FA token."""
    conn = get_db()
    try:
        row = conn.execute("SELECT twofa_enabled FROM users WHERE username = ?", (user,)).fetchone()
    finally:
        conn.close()
    if not row or not row["twofa_enabled"]:
        raise HTTPException(status_code=403, detail="2fa_not_setup")
    step_up_token = request.headers.get("x-step-up-token", "")
    if not step_up_token:
        raise HTTPException(status_code=403, detail="2fa_required")
    try:
        payload = jwt.decode(step_up_token, STEP_UP_SECRET, algorithms=[JWT_ALGORITHM])
        if payload.get("sub") != user or payload.get("type") != "step_up":
            raise HTTPException(status_code=403, detail="Invalid step-up token")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=403, detail="2fa_expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=403, detail="Invalid step-up token")
    return user

def require_2fa_if_enabled(request: Request, user: str = Depends(verify_token)) -> str:
    """Server access always requires 2FA. If not set up, block entirely. If set up, require a valid step-up token."""
    conn = get_db()
    try:
        row = conn.execute("SELECT role, twofa_enabled FROM users WHERE username = ?", (user,)).fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=403, detail="User not found")
    # 2FA must be enabled for everyone (including admins)
    if not row["twofa_enabled"]:
        raise HTTPException(status_code=403, detail="2fa_not_setup")
    # 2FA is enabled — require a valid step-up token
    step_up_token = request.headers.get("x-step-up-token", "")
    if not step_up_token:
        raise HTTPException(status_code=403, detail="2fa_required")
    try:
        payload = jwt.decode(step_up_token, STEP_UP_SECRET, algorithms=[JWT_ALGORITHM])
        if payload.get("sub") != user or payload.get("type") != "step_up":
            raise HTTPException(status_code=403, detail="Invalid step-up token")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=403, detail="2fa_expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=403, detail="Invalid step-up token")
    return user

# ─────────────────────── WireGuard helpers ───────────────────────
def wg_iface(server_id: str) -> str:
    return f"wg-sh-{server_id[:8]}"

def wg_up(server_id: str) -> None:
    """Bring up a WireGuard interface for this server (no-op if already up)."""
    iface = wg_iface(server_id)
    # If the interface already exists, skip setup entirely — this makes
    # subsequent connections to the same server near-instant.
    check = subprocess.run(["ip", "link", "show", iface], capture_output=True, timeout=3)
    if check.returncode == 0:
        return  # already up

    wg_enc = get_wg_path(server_id)
    if not os.path.exists(wg_enc):
        raise HTTPException(status_code=400, detail="WireGuard config not found")
    config = decrypt(open(wg_enc).read())
    # Strip DNS lines — resolvconf is not available in the container and we don't
    # need DNS routing; we only need the tunnel route to reach the server IP.
    config = "\n".join(
        line for line in config.splitlines()
        if not line.strip().upper().startswith("DNS")
    )
    tmp = f"/tmp/{iface}.conf"
    with open(tmp, "w") as f:
        f.write(config + "\n")
    os.chmod(tmp, 0o600)
    result = subprocess.run(["wg-quick", "up", tmp], capture_output=True, text=True, timeout=15)
    if result.returncode != 0 and "already exists" not in result.stderr:
        os.unlink(tmp)
        raise HTTPException(status_code=500, detail=f"WireGuard up failed: {result.stderr.strip()}")

    # Wait for the peer handshake — poll quickly so we don't over-wait.
    deadline = time.monotonic() + 5  # wait at most 5 s
    while time.monotonic() < deadline:
        show = subprocess.run(
            ["wg", "show", iface, "latest-handshakes"],
            capture_output=True, text=True, timeout=5,
        )
        for line in show.stdout.splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[1] != "0":
                return  # handshake confirmed
        time.sleep(0.2)

def wg_down(server_id: str) -> None:
    iface = wg_iface(server_id)
    tmp = f"/tmp/{iface}.conf"
    if os.path.exists(tmp):
        subprocess.run(["wg-quick", "down", tmp], capture_output=True, timeout=10)
        try:
            os.unlink(tmp)
        except OSError:
            pass

# ─────────────────────── SSH helpers ───────────────────────
def get_ssh_client(server_data: dict) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    connect_kwargs = {
        "hostname": server_data["ip"],
        "port": server_data["port"],
        "username": server_data["username"],
        "timeout": 10,
    }

    if server_data["auth_type"] == "key":
        key_path = get_key_path(server_data["id"])
        if not os.path.exists(key_path):
            raise HTTPException(status_code=400, detail="SSH key not found")
        # Key file is stored encrypted; decrypt into memory
        encrypted = open(key_path).read()
        key_pem = decrypt(encrypted)
        pkey = paramiko.RSAKey.from_private_key(io.StringIO(key_pem))
        connect_kwargs["pkey"] = pkey
    else:
        raw = server_data.get("password", "")
        connect_kwargs["password"] = decrypt(raw) if raw else ""

    # Retry on SSH banner read timeout — can happen in the first second after a
    # WireGuard tunnel comes up while the kernel routing table settles.
    last_exc: Exception = Exception("SSH connect failed")
    for attempt in range(3):
        try:
            client.connect(**connect_kwargs)
            return client
        except paramiko.ssh_exception.SSHException as e:
            if "banner" in str(e).lower() and attempt < 2:
                time.sleep(1.5)
                last_exc = e
                continue
            raise
    raise last_exc

def run_ssh_command(server_data: dict, command: str, timeout: int = 30) -> dict:
    client = None
    try:
        if server_data.get("use_wireguard"):
            wg_up(server_data["id"])
        client = get_ssh_client(server_data)
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        exit_code = stdout.channel.recv_exit_status()
        return {"stdout": out, "stderr": err, "exit_code": exit_code, "success": exit_code == 0}
    except paramiko.AuthenticationException:
        raise HTTPException(status_code=401, detail="SSH authentication failed")
    except (paramiko.ssh_exception.NoValidConnectionsError, OSError) as e:
        raise HTTPException(status_code=503, detail=f"Cannot connect to server: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if client:
            client.close()

def check_server_status(server_data: dict) -> str:
    try:
        result = run_ssh_command(server_data, "echo ok", timeout=5)
        return "online" if result["success"] else "error"
    except:
        return "offline"

# ─────────────────────── Routes ───────────────────────

@app.post("/api/auth/preflight")
def auth_preflight(req: PreflightRequest):
    """Return the auth type for a username so the UI can show the right input."""
    conn = get_db()
    try:
        row = conn.execute("SELECT twofa_key FROM users WHERE username = ?", (req.username,)).fetchone()
    finally:
        conn.close()
    if not row:
        # Don't reveal whether user exists — just say password
        return {"auth_type": "password"}
    return {"auth_type": "totp" if row["twofa_key"] else "password"}

@app.post("/api/auth/login")
def login(req: LoginRequest):
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT password_hash, role, twofa_enabled FROM users WHERE username = ?", (req.username,)
        ).fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not row["password_hash"]:
        raise HTTPException(status_code=401, detail="Account has no password. Ask your admin to reset it.")
    if row["password_hash"] != hash_password(req.password):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = create_token(req.username)
    return {
        "token": token,
        "username": req.username,
        "role": row["role"],
        "twofa_enabled": bool(row["twofa_enabled"]),
        "expires_in": JWT_EXPIRE_HOURS * 3600,
    }

@app.get("/api/auth/me")
def me(user: str = Depends(verify_token)):
    conn = get_db()
    try:
        row = conn.execute("SELECT role, twofa_enabled FROM users WHERE username = ?", (user,)).fetchone()
        role = row["role"] if row else "developer"
        twofa_enabled = bool(row["twofa_enabled"]) if row else False
    finally:
        conn.close()
    return {"username": user, "role": role, "twofa_enabled": twofa_enabled}

@app.post("/api/auth/change-password")
def change_password(req: ChangePasswordRequest, user: str = Depends(verify_token)):
    if len(req.new_password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    conn = get_db()
    try:
        row = conn.execute("SELECT password_hash FROM users WHERE username = ?", (user,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        if row["password_hash"] != hash_password(req.current_password):
            raise HTTPException(status_code=401, detail="Current password is incorrect")
        conn.execute("UPDATE users SET password_hash = ? WHERE username = ?",
                     (hash_password(req.new_password), user))
        conn.commit()
    finally:
        conn.close()
    return {"message": "Password changed successfully"}

# ─── User management (admin only) ───
@app.get("/api/users")
def list_users(admin: str = Depends(require_admin)):
    conn = get_db()
    try:
        rows = conn.execute("SELECT username, role, created_at, twofa_enabled, password_hash FROM users").fetchall()
        return [
            {
                "username": r["username"],
                "role": r["role"],
                "created_at": r["created_at"] or "",
                "twofa_enabled": bool(r["twofa_enabled"]),
                "has_password": bool(r["password_hash"]),
            }
            for r in rows
        ]
    finally:
        conn.close()

@app.post("/api/users")
def create_user(req: UserCreate, admin: str = Depends(require_admin)):
    if req.role not in ("admin", "developer"):
        raise HTTPException(status_code=400, detail="Role must be 'admin' or 'developer'")
    if len(req.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    created_at = datetime.now(timezone.utc).isoformat()
    conn = get_db()
    try:
        existing = conn.execute("SELECT 1 FROM users WHERE username = ?", (req.username,)).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="Username already exists")
        conn.execute(
            "INSERT INTO users (username, password_hash, role, created_at, created_by) VALUES (?, ?, ?, ?, ?)",
            (req.username, hash_password(req.password), req.role, created_at, admin),
        )
        conn.commit()
    finally:
        conn.close()
    return {"username": req.username, "role": req.role, "created_at": created_at, "twofa_enabled": False, "has_password": True}

@app.post("/api/auth/step-up")
def step_up_auth(req: StepUpRequest, user: str = Depends(verify_token)):
    """Verify a TOTP code and return a short-lived step-up token for server access."""
    conn = get_db()
    try:
        row = conn.execute("SELECT twofa_key, twofa_enabled FROM users WHERE username = ?", (user,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        if not row["twofa_enabled"] or not row["twofa_key"]:
            raise HTTPException(status_code=400, detail="2FA is not enabled for your account")
        if not verify_user_2fa(user_key=row["twofa_key"], code=req.code):
            raise HTTPException(status_code=400, detail="Invalid authenticator code")
    finally:
        conn.close()
    token = create_step_up_token(user)
    return {"step_up_token": token, "expires_in": STEP_UP_EXPIRE_MINUTES * 60}

@app.post("/api/users/{username}/activate-2fa")
def activate_user_2fa(username: str, admin: str = Depends(require_admin)):
    """Generate a TOTP QR code for a user and enable 2FA server-access gate."""
    conn = get_db()
    try:
        row = conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        twofa = setup_user_2fa(username)
        conn.execute(
            "UPDATE users SET twofa_key = ?, twofa_qr_url = ?, twofa_enabled = 1 WHERE username = ?",
            (twofa["user_key"], twofa["qr_url"], username),
        )
        conn.commit()
    finally:
        conn.close()
    return {"username": username, "twofa_enabled": True, "qr_code_url": twofa["qr_url"]}

@app.post("/api/users/{username}/deactivate-2fa")
def deactivate_user_2fa(username: str, admin: str = Depends(require_admin)):
    """Disable 2FA server-access gate for a user."""
    conn = get_db()
    try:
        row = conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        conn.execute(
            "UPDATE users SET twofa_key = NULL, twofa_qr_url = NULL, twofa_enabled = 0 WHERE username = ?",
            (username,),
        )
        conn.commit()
    finally:
        conn.close()
    return {"username": username, "twofa_enabled": False}

@app.delete("/api/users/{username}")
def delete_user(username: str, admin: str = Depends(require_admin_and_2fa)):
    if username == admin:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")
    conn = get_db()
    try:
        row = conn.execute("SELECT role FROM users WHERE username = ?", (username,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        if row["role"] == "admin":
            count = conn.execute("SELECT COUNT(*) FROM users WHERE role = 'admin'").fetchone()[0]
            if count <= 1:
                raise HTTPException(status_code=400, detail="Cannot delete the last admin account")
        conn.execute("DELETE FROM permissions WHERE username = ?", (username,))
        conn.execute("DELETE FROM users WHERE username = ?", (username,))
        conn.commit()
    finally:
        conn.close()
    return {"message": "User deleted"}

@app.put("/api/users/{username}/role")
def change_user_role(username: str, req: ChangeRoleRequest, admin: str = Depends(require_admin)):
    if req.role not in ("admin", "developer"):
        raise HTTPException(status_code=400, detail="Role must be 'admin' or 'developer'")
    conn = get_db()
    try:
        row = conn.execute("SELECT role FROM users WHERE username = ?", (username,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        if row["role"] == "admin" and req.role == "developer":
            count = conn.execute("SELECT COUNT(*) FROM users WHERE role = 'admin'").fetchone()[0]
            if count <= 1:
                raise HTTPException(status_code=400, detail="Cannot demote the last admin")
        conn.execute("UPDATE users SET role = ? WHERE username = ?", (req.role, username))
        conn.commit()
    finally:
        conn.close()
    return {"username": username, "role": req.role}

# ─── Dashboard aggregate stats ───
@app.get("/api/dashboard/stats")
def dashboard_stats(user: str = Depends(verify_token)):
    servers = load_servers()
    online  = sum(1 for s in servers.values() if s.get("status") == "online")
    offline = sum(1 for s in servers.values() if s.get("status") == "offline")
    unknown = sum(1 for s in servers.values() if s.get("status") not in ("online", "offline"))
    tags: dict = {}
    for s in servers.values():
        t = s.get("tag", "server"); tags[t] = tags.get(t, 0) + 1
    conn = get_db()
    try:
        total_users = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        admin_count = conn.execute("SELECT COUNT(*) FROM users WHERE role = 'admin'").fetchone()[0]
        dev_count   = conn.execute("SELECT COUNT(*) FROM users WHERE role = 'developer'").fetchone()[0]
    finally:
        conn.close()
    return {
        "servers": {"total": len(servers), "online": online, "offline": offline, "unknown": unknown},
        "tags": tags,
        "users": {"total": total_users, "admins": admin_count, "developers": dev_count},
    }

# ─── Servers ───
@app.get("/api/servers")
def list_servers(user: str = Depends(verify_token)):
    servers = load_servers()
    conn = get_db()
    try:
        row = conn.execute("SELECT role FROM users WHERE username = ?", (user,)).fetchone()
        role = row["role"] if row else "developer"
        if role == "admin":
            visible = list(servers.values())
        else:
            allowed_rows = conn.execute(
                "SELECT server_id FROM permissions WHERE username = ?", (user,)
            ).fetchall()
            allowed = {r["server_id"] for r in allowed_rows}
            visible = [s for s in servers.values() if s["id"] in allowed]
    finally:
        conn.close()
    return [{k: v for k, v in s.items() if k != "password"} for s in visible]

@app.post("/api/servers")
def add_server(req: ServerCreate, user: str = Depends(require_admin_and_2fa)):
    servers = load_servers()
    # Duplicate check — same IP + port
    for s in servers.values():
        if s.get("ip") == req.ip and s.get("port") == req.port:
            raise HTTPException(status_code=409, detail=f"A server at {req.ip}:{req.port} already exists ({s['name']})")
    server_id = hashlib.md5(f"{req.ip}:{req.port}:{req.name}:{time.time()}".encode()).hexdigest()[:12]

    server_data = {
        "id": server_id,
        "name": req.name,
        "ip": req.ip,
        "port": req.port,
        "username": req.username,
        "auth_type": req.auth_type,
        "tag": req.tag,
        "status": "unknown",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    if req.auth_type == "password" and req.password:
        server_data["password"] = encrypt(req.password)
    elif req.auth_type == "key" and req.private_key:
        key_path = get_key_path(server_id)
        with open(key_path, "w") as f:
            f.write(encrypt(req.private_key.strip()))
        os.chmod(key_path, 0o600)

    if req.use_wireguard and req.wg_config:
        server_data["use_wireguard"] = True
        wg_path = get_wg_path(server_id)
        with open(wg_path, "w") as f:
            f.write(encrypt(req.wg_config.strip()))
        os.chmod(wg_path, 0o600)

    servers[server_id] = server_data
    save_servers(servers)

    status = check_server_status(server_data)
    servers[server_id]["status"] = status
    save_servers(servers)

    return {k: v for k, v in servers[server_id].items() if k != "password"}

@app.delete("/api/servers/{server_id}")
def delete_server(server_id: str, user: str = Depends(require_admin_and_2fa)):
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")
    del servers[server_id]
    save_servers(servers)
    wg_down(server_id)  # bring down tunnel if running
    for path_fn in (get_key_path, get_wg_path):
        p = path_fn(server_id)
        if os.path.exists(p):
            os.remove(p)
    return {"message": "Server deleted"}

@app.get("/api/servers/{server_id}/status")
def server_status(server_id: str, user: str = Depends(require_2fa_if_enabled)):
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")
    assert_server_access(server_id, user)
    status = check_server_status(servers[server_id])
    servers[server_id]["status"] = status
    save_servers(servers)
    return {"status": status}

# ─── Metrics ───
@app.get("/api/servers/{server_id}/metrics")
def get_metrics(server_id: str, user: str = Depends(require_2fa_if_enabled)):
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")
    assert_server_access(server_id, user)
    s = servers[server_id]

    # Pure shell — no Python required on the remote server
    script = r"""
set -e
# CPU: sample /proc/stat twice with a 0.5s sleep using only shell + awk
read _ c1 c2 c3 c4 c5 c6 c7 _ < /proc/stat
sleep 0.5
read _ d1 d2 d3 d4 d5 d6 d7 _ < /proc/stat
cpu=$(awk "BEGIN{
  idle1=$c4; total1=$c1+$c2+$c3+$c4+$c5+$c6+$c7;
  idle2=$d4; total2=$d1+$d2+$d3+$d4+$d5+$d6+$d7;
  dtotal=total2-total1; didle=idle2-idle1;
  if(dtotal>0) printf \"%.1f\", 100*(1-didle/dtotal); else print \"0.0\"
}")

# Memory from /proc/meminfo (values in kB)
mem_total=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
mem_avail=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
mem_used=$((mem_total - mem_avail))
mem_pct=$(awk "BEGIN{printf \"%.1f\", 100*$mem_used/$mem_total}")
mem_used_mb=$(awk "BEGIN{printf \"%.1f\", $mem_used/1024}")
mem_total_mb=$(awk "BEGIN{printf \"%.1f\", $mem_total/1024}")

# Disk via df (no Python shutil needed)
disk_info=$(df / | awk 'NR==2{print $2,$3,$5}')
disk_total_kb=$(echo $disk_info | awk '{print $1}')
disk_used_kb=$(echo $disk_info | awk '{print $2}')
disk_pct=$(echo $disk_info | awk '{gsub(/%/,"",$3); print $3}')
disk_used_gb=$(awk "BEGIN{printf \"%.1f\", $disk_used_kb/1024/1024}")
disk_total_gb=$(awk "BEGIN{printf \"%.1f\", $disk_total_kb/1024/1024}")

# Uptime from /proc/uptime
uptime_secs=$(awk '{print int($1)}' /proc/uptime)
uptime_days=$((uptime_secs/86400))
uptime_hours=$(( (uptime_secs%86400)/3600 ))

# Network — sum all relevant interfaces
net_rx=0; net_tx=0
while read line; do
  iface=$(echo "$line" | awk -F: '{print $1}' | tr -d ' ')
  case "$iface" in eth*|ens*|enp*|wlan*|bond*|em*)
    rx=$(echo "$line" | awk '{print $2}')
    tx=$(echo "$line" | awk '{print $10}')
    net_rx=$((net_rx+rx)); net_tx=$((net_tx+tx))
  esac
done < /proc/net/dev
net_rx_mb=$(awk "BEGIN{printf \"%.1f\", $net_rx/1048576}")
net_tx_mb=$(awk "BEGIN{printf \"%.1f\", $net_tx/1048576}")

printf '{"cpu":%s,"mem_pct":%s,"mem_used_mb":%s,"mem_total_mb":%s,"disk_pct":%s,"disk_used_gb":%s,"disk_total_gb":%s,"uptime":"%dd %dh","net_rx_mb":%s,"net_tx_mb":%s}\n' \
  $cpu $mem_pct $mem_used_mb $mem_total_mb $disk_pct $disk_used_gb $disk_total_gb \
  $uptime_days $uptime_hours $net_rx_mb $net_tx_mb
"""
    result = run_ssh_command(s, script, timeout=15)
    try:
        return json.loads(result["stdout"].strip())
    except:
        raise HTTPException(status_code=500, detail="Failed to parse metrics: " + result["stderr"])

# ─── Commands ───
@app.post("/api/servers/{server_id}/exec")
def exec_command(server_id: str, req: CommandRequest, user: str = Depends(require_2fa_if_enabled)):
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")
    assert_server_access(server_id, user)
    blocked = ["rm -rf /", "mkfs", "dd if=/dev/zero", ":(){:|:&};:"]
    for b in blocked:
        if b in req.command:
            raise HTTPException(status_code=403, detail=f"Command blocked for safety: {b}")
    result = run_ssh_command(servers[server_id], req.command, timeout=30)
    return result

# ─── Services ───
@app.get("/api/servers/{server_id}/services")
def get_services(server_id: str, user: str = Depends(require_2fa_if_enabled)):
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")
    assert_server_access(server_id, user)
    result = run_ssh_command(servers[server_id],
        "systemctl list-units --type=service --no-pager --no-legend --all | head -30", timeout=15)
    services = []
    for line in result["stdout"].strip().splitlines():
        parts = line.split()
        if len(parts) >= 4:
            services.append({
                "name": parts[0].replace(".service", ""),
                "load": parts[1], "active": parts[2], "sub": parts[3],
                "description": " ".join(parts[4:]) if len(parts) > 4 else ""
            })
    return services

@app.post("/api/servers/{server_id}/services/{service}/action")
def service_action(server_id: str, service: str, action: str, user: str = Depends(require_2fa_if_enabled)):
    if action not in ("start", "stop", "restart", "status"):
        raise HTTPException(status_code=400, detail="Invalid action")
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")
    assert_server_access(server_id, user)
    result = run_ssh_command(servers[server_id], f"sudo systemctl {action} {service}", timeout=15)
    return result

# ─── Docker ───
@app.get("/api/servers/{server_id}/docker")
def get_docker(server_id: str, user: str = Depends(require_2fa_if_enabled)):
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")
    assert_server_access(server_id, user)
    result = run_ssh_command(servers[server_id],
        'docker ps -a --format \'{"id":"{{.ID}}","name":"{{.Names}}","image":"{{.Image}}","status":"{{.Status}}","ports":"{{.Ports}}","state":"{{.State}}"}\' 2>/dev/null || echo "[]"',
        timeout=15)
    containers = []
    for line in result["stdout"].strip().splitlines():
        try:
            containers.append(json.loads(line))
        except:
            pass
    return containers

@app.post("/api/servers/{server_id}/docker/{container}/action")
def docker_action(server_id: str, container: str, action: str, user: str = Depends(require_2fa_if_enabled)):
    if action not in ("start", "stop", "restart", "logs"):
        raise HTTPException(status_code=400, detail="Invalid action")
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")
    assert_server_access(server_id, user)
    cmd = f"docker {action} {container}" if action != "logs" else f"docker logs --tail=50 {container}"
    result = run_ssh_command(servers[server_id], cmd, timeout=20)
    return result

# ─── Files ───
@app.get("/api/servers/{server_id}/files")
def list_files(server_id: str, path: str = "/", user: str = Depends(require_2fa_if_enabled)):
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")
    assert_server_access(server_id, user)
    result = run_ssh_command(servers[server_id], f"ls -la {path} 2>&1 | head -100", timeout=10)
    return {"path": path, "output": result["stdout"]}

@app.get("/api/servers/{server_id}/file-content")
def read_file(server_id: str, path: str, user: str = Depends(require_2fa_if_enabled)):
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")
    assert_server_access(server_id, user)
    result = run_ssh_command(servers[server_id], f"cat {path} 2>&1 | head -500", timeout=10)
    return {"path": path, "content": result["stdout"]}

@app.post("/api/servers/{server_id}/upload")
async def upload_file(
    server_id: str,
    remote_path: str = Form(...),
    file: UploadFile = File(...),
    user: str = Depends(require_2fa_if_enabled),
):
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")
    assert_server_access(server_id, user)
    server_data = servers[server_id]
    data = await file.read()
    ssh_client = None
    try:
        if server_data.get("use_wireguard"):
            wg_up(server_id)
        ssh_client = get_ssh_client(server_data)
        sftp = ssh_client.open_sftp()
        dest = remote_path.rstrip("/") + "/" + file.filename if remote_path.endswith("/") else remote_path
        with sftp.open(dest, "wb") as rf:
            rf.write(data)
        sftp.close()
        return {"path": dest, "size": len(data), "filename": file.filename}
    except paramiko.AuthenticationException:
        raise HTTPException(status_code=401, detail="SSH authentication failed")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if ssh_client:
            ssh_client.close()

# ─── Logs ───
@app.get("/api/servers/{server_id}/logs")
def get_logs(server_id: str, service: str = "syslog", lines: int = 100, user: str = Depends(require_2fa_if_enabled)):
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")
    assert_server_access(server_id, user)
    if service == "syslog":
        cmd = f"sudo journalctl -n {lines} --no-pager 2>/dev/null || sudo tail -n {lines} /var/log/syslog 2>/dev/null"
    else:
        cmd = f"sudo journalctl -u {service} -n {lines} --no-pager 2>/dev/null"
    result = run_ssh_command(servers[server_id], cmd, timeout=15)
    return {"logs": result["stdout"]}

# ─── 2FA management (admin only) ───
@app.get("/api/users/{username}/qrcode")
def get_user_qrcode(username: str, admin: str = Depends(require_admin)):
    """Return the stored QR code URL for a user."""
    conn = get_db()
    try:
        row = conn.execute("SELECT twofa_qr_url FROM users WHERE username = ?", (username,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        if not row["twofa_qr_url"]:
            raise HTTPException(status_code=404, detail="No QR code found for this user")
        return {"qr_code_url": row["twofa_qr_url"]}
    finally:
        conn.close()

@app.post("/api/users/{username}/reset-2fa")
def reset_user_2fa(username: str, admin: str = Depends(require_admin)):
    """Regenerate a new 2FA QR code for a user (invalidates the old one)."""
    conn = get_db()
    try:
        row = conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        twofa = setup_user_2fa(username)
        conn.execute(
            "UPDATE users SET twofa_key = ?, twofa_qr_url = ? WHERE username = ?",
            (twofa["user_key"], twofa["qr_url"], username),
        )
        conn.commit()
    finally:
        conn.close()
    return {"username": username, "qr_code_url": twofa["qr_url"]}

# ─── Server access management (admin only) ───
@app.get("/api/users/{username}/servers")
def get_user_server_access(username: str, admin: str = Depends(require_admin)):
    conn = get_db()
    try:
        row = conn.execute("SELECT role FROM users WHERE username = ?", (username,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        if row["role"] == "admin":
            return {"server_ids": list(load_servers().keys()), "full_access": True}
        perms = conn.execute(
            "SELECT server_id FROM permissions WHERE username = ?", (username,)
        ).fetchall()
        return {"server_ids": [r["server_id"] for r in perms], "full_access": False}
    finally:
        conn.close()

@app.put("/api/users/{username}/servers")
def set_user_server_access(username: str, req: ServerAccessRequest, admin: str = Depends(require_admin)):
    conn = get_db()
    try:
        row = conn.execute("SELECT role FROM users WHERE username = ?", (username,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        if row["role"] == "admin":
            raise HTTPException(status_code=400, detail="Admins always have full access; no need to set permissions")
        servers = load_servers()
        invalid = [sid for sid in req.server_ids if sid not in servers]
        if invalid:
            raise HTTPException(status_code=404, detail=f"Server(s) not found: {', '.join(invalid)}")
        conn.execute("DELETE FROM permissions WHERE username = ?", (username,))
        conn.executemany(
            "INSERT INTO permissions (username, server_id) VALUES (?, ?)",
            [(username, sid) for sid in req.server_ids],
        )
        conn.commit()
    finally:
        conn.close()
    return {"username": username, "server_ids": req.server_ids}

@app.get("/health")
def health():
    return {"status": "ok", "time": datetime.now(timezone.utc).isoformat()}

# ─── WebSocket PTY Terminal ───
@app.websocket("/ws/servers/{server_id}/terminal")
async def terminal_ws(
    websocket: WebSocket,
    server_id: str,
    token: str = Query(...),
    step_up_token: Optional[str] = Query(None),
):
    # Verify main JWT
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        await websocket.close(code=4001)
        return

    servers = load_servers()
    if server_id not in servers:
        await websocket.close(code=4004)
        return

    username = payload["sub"]
    conn = get_db()
    try:
        u_row = conn.execute("SELECT role, twofa_enabled FROM users WHERE username = ?", (username,)).fetchone()
        if not u_row:
            await websocket.close(code=4001)
            return
        # Check 2FA step-up if enabled
        if u_row["twofa_enabled"]:
            if not step_up_token:
                await websocket.close(code=4003)
                conn.close()
                return
            try:
                su_payload = jwt.decode(step_up_token, STEP_UP_SECRET, algorithms=[JWT_ALGORITHM])
                if su_payload.get("sub") != username or su_payload.get("type") != "step_up":
                    await websocket.close(code=4003)
                    conn.close()
                    return
            except jwt.PyJWTError:
                await websocket.close(code=4003)
                conn.close()
                return
        # Check server access for non-admin users
        if u_row["role"] != "admin":
            p_row = conn.execute(
                "SELECT 1 FROM permissions WHERE username = ? AND server_id = ?", (username, server_id)
            ).fetchone()
            if not p_row:
                await websocket.close(code=4003)
                conn.close()
                return
    finally:
        conn.close()

    await websocket.accept()

    server_data = servers[server_id]
    ssh_client = None
    channel = None
    stop_event = threading.Event()

    try:
        if server_data.get("use_wireguard"):
            wg_up(server_id)

        ssh_client = paramiko.SSHClient()
        ssh_client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

        connect_kwargs = {
            "hostname": server_data["ip"],
            "port": server_data["port"],
            "username": server_data["username"],
            "timeout": 10,
        }

        if server_data["auth_type"] == "key":
            key_path = get_key_path(server_data["id"])
            if not os.path.exists(key_path):
                await websocket.send_bytes(b"\r\n\x1b[31mSSH key not found\x1b[0m\r\n")
                await websocket.close()
                return
            encrypted = open(key_path).read()
            pkey = paramiko.RSAKey.from_private_key(io.StringIO(decrypt(encrypted)))
            connect_kwargs["pkey"] = pkey
        else:
            raw = server_data.get("password", "")
            connect_kwargs["password"] = decrypt(raw) if raw else ""

        ssh_client.connect(**connect_kwargs)
        channel = ssh_client.invoke_shell(term="xterm-256color", width=220, height=50)
        channel.setblocking(False)

        def read_from_ssh():
            """Read SSH output and send to WebSocket."""
            loop = asyncio.new_event_loop()
            async def _send():
                while not stop_event.is_set():
                    try:
                        r, _, _ = select.select([channel], [], [], 0.05)
                        if r:
                            data = channel.recv(4096)
                            if not data:
                                break
                            await websocket.send_bytes(data)
                    except Exception:
                        break
                stop_event.set()
            loop.run_until_complete(_send())
            loop.close()

        reader_thread = threading.Thread(target=read_from_ssh, daemon=True)
        reader_thread.start()

        # Read from WebSocket and send to SSH
        try:
            while not stop_event.is_set():
                try:
                    msg = await asyncio.wait_for(websocket.receive(), timeout=0.1)
                except asyncio.TimeoutError:
                    continue

                if msg["type"] == "websocket.disconnect":
                    break

                if "bytes" in msg and msg["bytes"]:
                    channel.sendall(msg["bytes"])
                elif "text" in msg and msg["text"]:
                    try:
                        data = json.loads(msg["text"])
                        if data.get("type") == "resize":
                            cols = data.get("cols", 80)
                            rows = data.get("rows", 24)
                            channel.resize_pty(width=cols, height=rows)
                    except (json.JSONDecodeError, Exception):
                        channel.sendall(msg["text"].encode())

        except WebSocketDisconnect:
            pass

    except paramiko.AuthenticationException:
        await websocket.send_bytes(b"\r\n\x1b[31mSSH authentication failed\x1b[0m\r\n")
    except Exception as e:
        try:
            await websocket.send_bytes(f"\r\n\x1b[31mConnection error: {e}\x1b[0m\r\n".encode())
        except Exception:
            pass
    finally:
        stop_event.set()
        if channel:
            channel.close()
        if ssh_client:
            ssh_client.close()
