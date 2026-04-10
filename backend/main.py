from fastapi import FastAPI, HTTPException, Depends, status, WebSocket, WebSocketDisconnect, Query, UploadFile, File, Form
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
from datetime import datetime, timedelta
from contextlib import asynccontextmanager
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

app = FastAPI(title="ServerHub API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

security = HTTPBearer()

# ─────────────────────── Config ───────────────────────
JWT_SECRET = os.getenv("JWT_SECRET", "serverhub-super-secret-change-in-prod")
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_HOURS = 12

ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin123")

SERVERS_FILE = "/data/servers.json"
SSH_KEYS_DIR = "/data/ssh_keys"
WG_CONFIGS_DIR = "/data/wg_configs"

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

def get_key_path(server_id: str) -> str:
    return os.path.join(SSH_KEYS_DIR, f"{server_id}.pem")

def get_wg_path(server_id: str) -> str:
    return os.path.join(WG_CONFIGS_DIR, f"{server_id}.conf.enc")

# ─────────────────────── Auth ───────────────────────
def create_token(username: str) -> str:
    payload = {
        "sub": username,
        "exp": datetime.utcnow() + timedelta(hours=JWT_EXPIRE_HOURS),
        "iat": datetime.utcnow(),
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

# ─────────────────────── WireGuard helpers ───────────────────────
def wg_iface(server_id: str) -> str:
    return f"wg-sh-{server_id[:8]}"

def wg_up(server_id: str) -> None:
    """Bring up a WireGuard interface for this server."""
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
    iface = wg_iface(server_id)
    tmp = f"/tmp/{iface}.conf"
    with open(tmp, "w") as f:
        f.write(config + "\n")
    os.chmod(tmp, 0o600)
    result = subprocess.run(["wg-quick", "up", tmp], capture_output=True, text=True, timeout=15)
    if result.returncode != 0 and "already exists" not in result.stderr:
        os.unlink(tmp)
        raise HTTPException(status_code=500, detail=f"WireGuard up failed: {result.stderr.strip()}")

    # Wait for the WireGuard peer handshake before we attempt SSH.
    # wg-quick returns as soon as the interface is up, but the crypto handshake
    # with the peer (and therefore actual traffic flow) takes a moment longer.
    deadline = time.monotonic() + 8  # wait at most 8 s
    while time.monotonic() < deadline:
        show = subprocess.run(
            ["wg", "show", iface, "latest-handshakes"],
            capture_output=True, text=True, timeout=5,
        )
        # Output is "peer_pubkey  <unix_timestamp>"; a non-zero timestamp means
        # the handshake completed.
        for line in show.stdout.splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[1] != "0":
                return  # handshake confirmed
        time.sleep(0.5)

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
    wg_active = False
    try:
        if server_data.get("use_wireguard"):
            wg_up(server_data["id"])
            wg_active = True
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
        if wg_active:
            wg_down(server_data["id"])

def check_server_status(server_data: dict) -> str:
    try:
        result = run_ssh_command(server_data, "echo ok", timeout=5)
        return "online" if result["success"] else "error"
    except:
        return "offline"

# ─────────────────────── Routes ───────────────────────

@app.post("/api/auth/login")
def login(req: LoginRequest):
    if req.username != ADMIN_USERNAME or req.password != ADMIN_PASSWORD:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = create_token(req.username)
    return {"token": token, "username": req.username, "expires_in": JWT_EXPIRE_HOURS * 3600}

@app.get("/api/auth/me")
def me(user: str = Depends(verify_token)):
    return {"username": user}

# ─── Servers ───
@app.get("/api/servers")
def list_servers(user: str = Depends(verify_token)):
    servers = load_servers()
    return [
        {k: v for k, v in s.items() if k not in ("password",)}
        for s in servers.values()
    ]

@app.post("/api/servers")
def add_server(req: ServerCreate, user: str = Depends(verify_token)):
    servers = load_servers()
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
        "created_at": datetime.utcnow().isoformat(),
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
def delete_server(server_id: str, user: str = Depends(verify_token)):
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")
    del servers[server_id]
    save_servers(servers)
    for path_fn in (get_key_path, get_wg_path):
        p = path_fn(server_id)
        if os.path.exists(p):
            os.remove(p)
    return {"message": "Server deleted"}

@app.get("/api/servers/{server_id}/status")
def server_status(server_id: str, user: str = Depends(verify_token)):
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")
    status = check_server_status(servers[server_id])
    servers[server_id]["status"] = status
    save_servers(servers)
    return {"status": status}

# ─── Metrics ───
@app.get("/api/servers/{server_id}/metrics")
def get_metrics(server_id: str, user: str = Depends(verify_token)):
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")
    s = servers[server_id]

    script = """
python3 -c "
import subprocess, json, os, time

# CPU
cpu_lines = open('/proc/stat').readlines()[0].split()
cpu = list(map(int, cpu_lines[1:]))
idle1 = cpu[3]
total1 = sum(cpu)
time.sleep(0.5)
cpu_lines = open('/proc/stat').readlines()[0].split()
cpu = list(map(int, cpu_lines[1:]))
idle2 = cpu[3]
total2 = sum(cpu)
cpu_pct = round(100 * (1 - (idle2-idle1)/(total2-total1)), 1)

# Memory
mem = {}
for l in open('/proc/meminfo'):
    k, v = l.split(':')
    mem[k.strip()] = int(v.strip().split()[0])
mem_total = mem['MemTotal']
mem_free = mem['MemAvailable']
mem_used = mem_total - mem_free
mem_pct = round(100 * mem_used / mem_total, 1)

# Disk
import shutil
disk = shutil.disk_usage('/')
disk_pct = round(100 * disk.used / disk.total, 1)
disk_used_gb = round(disk.used / 1024**3, 1)
disk_total_gb = round(disk.total / 1024**3, 1)

# Uptime
uptime_secs = float(open('/proc/uptime').read().split()[0])
days = int(uptime_secs // 86400)
hours = int((uptime_secs % 86400) // 3600)

# Network
net_lines = open('/proc/net/dev').readlines()
rx=tx=0
for l in net_lines[2:]:
    parts = l.split()
    if parts[0].startswith(('eth','ens','enp','wlan','bond')):
        rx += int(parts[1]); tx += int(parts[9])

print(json.dumps({'cpu':cpu_pct,'mem_pct':mem_pct,'mem_used_mb':round(mem_used/1024,1),'mem_total_mb':round(mem_total/1024,1),'disk_pct':disk_pct,'disk_used_gb':disk_used_gb,'disk_total_gb':disk_total_gb,'uptime':f'{days}d {hours}h','net_rx_mb':round(rx/1024/1024,1),'net_tx_mb':round(tx/1024/1024,1)}))
"
"""
    result = run_ssh_command(s, script, timeout=15)
    try:
        return json.loads(result["stdout"].strip())
    except:
        raise HTTPException(status_code=500, detail="Failed to parse metrics: " + result["stderr"])

# ─── Commands ───
@app.post("/api/servers/{server_id}/exec")
def exec_command(server_id: str, req: CommandRequest, user: str = Depends(verify_token)):
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")

    # Block dangerous commands
    blocked = ["rm -rf /", "mkfs", "dd if=/dev/zero", ":(){:|:&};:"]
    for b in blocked:
        if b in req.command:
            raise HTTPException(status_code=403, detail=f"Command blocked for safety: {b}")

    result = run_ssh_command(servers[server_id], req.command, timeout=30)
    return result

# ─── Services ───
@app.get("/api/servers/{server_id}/services")
def get_services(server_id: str, user: str = Depends(verify_token)):
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")
    result = run_ssh_command(servers[server_id],
        "systemctl list-units --type=service --no-pager --no-legend --all | head -30", timeout=15)
    services = []
    for line in result["stdout"].strip().splitlines():
        parts = line.split()
        if len(parts) >= 4:
            services.append({
                "name": parts[0].replace(".service", ""),
                "load": parts[1],
                "active": parts[2],
                "sub": parts[3],
                "description": " ".join(parts[4:]) if len(parts) > 4 else ""
            })
    return services

@app.post("/api/servers/{server_id}/services/{service}/action")
def service_action(server_id: str, service: str, action: str, user: str = Depends(verify_token)):
    if action not in ("start", "stop", "restart", "status"):
        raise HTTPException(status_code=400, detail="Invalid action")
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")
    result = run_ssh_command(servers[server_id], f"sudo systemctl {action} {service}", timeout=15)
    return result

# ─── Docker ───
@app.get("/api/servers/{server_id}/docker")
def get_docker(server_id: str, user: str = Depends(verify_token)):
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")
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
def docker_action(server_id: str, container: str, action: str, user: str = Depends(verify_token)):
    if action not in ("start", "stop", "restart", "logs"):
        raise HTTPException(status_code=400, detail="Invalid action")
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")
    cmd = f"docker {action} {container}" if action != "logs" else f"docker logs --tail=50 {container}"
    result = run_ssh_command(servers[server_id], cmd, timeout=20)
    return result

# ─── Files ───
@app.get("/api/servers/{server_id}/files")
def list_files(server_id: str, path: str = "/", user: str = Depends(verify_token)):
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")
    result = run_ssh_command(servers[server_id],
        f"ls -la {path} 2>&1 | head -100", timeout=10)
    return {"path": path, "output": result["stdout"]}

@app.get("/api/servers/{server_id}/file-content")
def read_file(server_id: str, path: str, user: str = Depends(verify_token)):
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")
    result = run_ssh_command(servers[server_id], f"cat {path} 2>&1 | head -500", timeout=10)
    return {"path": path, "content": result["stdout"]}

@app.post("/api/servers/{server_id}/upload")
async def upload_file(
    server_id: str,
    remote_path: str = Form(...),
    file: UploadFile = File(...),
    user: str = Depends(verify_token),
):
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")
    server_data = servers[server_id]

    data = await file.read()
    wg_active = False
    ssh_client = None
    try:
        if server_data.get("use_wireguard"):
            wg_up(server_id)
            wg_active = True
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
        if wg_active:
            wg_down(server_id)

# ─── Logs ───
@app.get("/api/servers/{server_id}/logs")
def get_logs(server_id: str, service: str = "syslog", lines: int = 100, user: str = Depends(verify_token)):
    servers = load_servers()
    if server_id not in servers:
        raise HTTPException(status_code=404, detail="Server not found")
    if service == "syslog":
        cmd = f"sudo journalctl -n {lines} --no-pager 2>/dev/null || sudo tail -n {lines} /var/log/syslog 2>/dev/null"
    else:
        cmd = f"sudo journalctl -u {service} -n {lines} --no-pager 2>/dev/null"
    result = run_ssh_command(servers[server_id], cmd, timeout=15)
    return {"logs": result["stdout"]}

@app.get("/health")
def health():
    return {"status": "ok", "time": datetime.utcnow().isoformat()}

# ─── WebSocket PTY Terminal ───
@app.websocket("/ws/servers/{server_id}/terminal")
async def terminal_ws(websocket: WebSocket, server_id: str, token: str = Query(...)):
    # Verify token
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        await websocket.close(code=4001)
        return

    servers = load_servers()
    if server_id not in servers:
        await websocket.close(code=4004)
        return

    await websocket.accept()

    server_data = servers[server_id]
    ssh_client = None
    channel = None
    wg_active = False
    stop_event = threading.Event()

    try:
        if server_data.get("use_wireguard"):
            wg_up(server_id)
            wg_active = True

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
        if wg_active:
            wg_down(server_id)
