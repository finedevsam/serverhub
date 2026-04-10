# ServerHub

A self-hosted developer operations portal. Manage unlimited servers from a single browser tab — terminal, metrics, Docker, services, files, logs, and team access control, all in one place.

---

## Features

| Category | What you get |
|---|---|
| **Authentication** | JWT-based login, role-based access (Admin / Developer), change password |
| **Multi-server** | Add unlimited servers, open each as a browser tab, switch without losing your session |
| **Terminal** | Full xterm.js PTY over WebSocket — resizable, persistent across tab switches |
| **Metrics** | Live CPU, RAM, Disk, Network, Uptime — auto-refreshes every 10 s |
| **Docker** | List containers, start / stop / restart, tail logs |
| **Services** | Browse and control systemd services |
| **File browser** | Navigate the filesystem, view file contents, upload files via SFTP drag-and-drop |
| **Logs** | Tail syslog or any systemd service journal |
| **Quick actions** | One-click common ops (restart nginx, disk usage, process list, etc.) from Overview |
| **WireGuard VPN** | Connect through a WireGuard tunnel before SSH for VPN-protected servers |
| **Team management** | Add team members, assign roles, control per-user server access |
| **Security** | All credentials (passwords, SSH keys, WireGuard configs) are Fernet-encrypted at rest |

---

## Requirements

- [Docker](https://docs.docker.com/get-docker/) + [Docker Compose](https://docs.docker.com/compose/install/)
- That's it.

---

## Quick start

```bash
# 1. Clone the project
git clone <repo-url> serverhub
cd serverhub

# 2. Copy and edit the environment file
cp .env.example .env
# Edit .env — change ADMIN_PASSWORD and JWT_SECRET at minimum

# 3. Start everything
docker compose up --build -d

# 4. Open your browser
open http://localhost:3000
```

Default credentials: **admin / admin123**  
Change these in `.env` before exposing to any network.

---

## Environment variables

Edit `.env` before the first run:

```env
# Required — change these
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
JWT_SECRET=change-me-use-openssl-rand-hex-32

# Required if accessing from another machine
NEXT_PUBLIC_API_URL=http://YOUR_SERVER_IP:8000
```

Generate a strong JWT secret:
```bash
openssl rand -hex 32
```

After changing any variable, rebuild:
```bash
docker compose down
docker compose up --build -d
```

---

## Accessing from another machine

If ServerHub runs on a home server or VPS, tell the frontend where the API lives:

```env
# .env
NEXT_PUBLIC_API_URL=http://YOUR_SERVER_IP:8000
```

Then rebuild the frontend:
```bash
docker compose down && docker compose up --build -d
```

---

## Stopping and starting

```bash
# Stop (keeps all data)
docker compose down

# Start again — no rebuild needed
docker compose up -d

# Wipe everything including stored servers and keys
docker compose down -v
```

---

## Dashboard walkthrough

### Login

Navigate to `http://localhost:3000`. Sign in with your admin credentials.

### Dashboard tab

The landing page after login. Shows:

- **Stat cards** — total servers, online, offline, unknown, team size, admin count
- **Status distribution chart** — donut chart of server health
- **Servers by tag chart** — bar chart breakdown by tag (prod, staging, api, db, dev)
- **Team panel** — member and role counts with a link to the Team tab
- **Recent servers** — click any row to open a connection tab
- **All servers grid** — quick-glance status of every server

### Servers tab

Full table of all servers you have access to. Columns: Status, Name, IP, Port, User, Auth, Tag, VPN.

- **Connect** — opens the server as a tab in the top bar
- **Delete** (admin only) — permanently removes the server and its stored credentials

### Connection tabs

Each connected server opens as a tab in the top bar. Tabs stay alive when you switch away — your terminal session, WebSocket connection, and all tab state are preserved.

Inside each connection:

| Sub-tab | Description |
|---|---|
| **Overview** | Live metrics cards + quick-action buttons that run a command in the terminal |
| **Terminal** | Full PTY terminal. Resizes with the window. Reconnect button if the connection drops. |
| **Docker** | Container list with Start / Stop / Restart / Logs actions |
| **Services** | Systemd service list with Start / Stop / Restart actions |
| **Files** | File browser with path bar, quick-path buttons, file viewer, and file upload |
| **Logs** | Live log viewer for syslog or any named systemd service |

---

## Adding a server (admin only)

1. Click **+ Add server** in the top-right corner (or in the Servers / Dashboard tab)
2. Fill in the form:

| Field | Notes |
|---|---|
| Display name | Anything you like — shown in tabs and lists |
| Tag | `prod`, `staging`, `api`, `db`, `dev`, or `server` — used for grouping and colour coding |
| IP / Hostname | The server's IP address or domain name |
| Port | SSH port, default `22` |
| SSH Username | The user to SSH as (e.g. `ubuntu`, `root`, `deploy`) |
| Authentication | **SSH Key** (recommended) or **Password** |
| WireGuard VPN | Optional — paste a full `wg-quick` config if the server is behind a WireGuard VPN |

3. Click **Add server** — ServerHub tests the connection immediately and shows the status.

### SSH key tips

Paste the full private key contents:
```
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAA...
-----END OPENSSH PRIVATE KEY-----
```

Copy from your local machine:
```bash
cat ~/.ssh/id_ed25519    # Ed25519 (recommended)
cat ~/.ssh/id_rsa        # RSA
```

The public key must be in `~/.ssh/authorized_keys` on the target server:
```bash
# From your local machine
ssh-copy-id -i ~/.ssh/id_ed25519.pub ubuntu@your-server-ip

# Or manually on the target server
echo "YOUR_PUBLIC_KEY" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

All keys are **encrypted at rest** using Fernet (AES-128-CBC) derived from your `JWT_SECRET`.

### WireGuard tips

Paste a standard `wg-quick` config block:
```ini
[Interface]
PrivateKey = <your-private-key>
Address = 10.0.0.2/32

[Peer]
PublicKey = <server-public-key>
Endpoint = vpn.example.com:51820
AllowedIPs = 10.0.0.0/24
```

ServerHub brings the tunnel up before each SSH connection and tears it down after. DNS lines are stripped automatically — they are not needed inside the container.

---

## File upload

In the **Files** sub-tab, upload a file to the current directory two ways:

- **Click the ↑ Upload button** and pick a file
- **Drag and drop** a file onto the file browser area

Files are transferred over SFTP using the server's SSH credentials.

---

## Team management (admin only)

Open the **Team** tab in the top navigation bar.

### Adding a team member

1. Click **Add member**
2. Set a username and password (minimum 6 characters)
3. Choose a role:

| Role | Permissions |
|---|---|
| **Admin** | Full access — add/delete servers, manage users, grant access, change any setting |
| **Developer** | Can only see and connect to servers explicitly granted by an admin |

4. Click **Add member**

### Granting server access to a developer

By default a new developer has no server access. To grant access:

1. Go to the **Team** tab
2. Find the developer's row — the **Server access** column shows how many servers they can currently access
3. Click the **Access** button
4. In the modal, check the servers you want to grant access to (use **All** / **None** for bulk select)
5. Click **Save access** — the badge updates immediately, no page refresh needed

Access changes take effect on the developer's next API call. If they are currently logged in, the next time they load the Servers tab they will see only their granted servers.

### Changing a role

In the Team tab, use the role dropdown on any member's row to switch between Admin and Developer. Changing a developer to Admin immediately grants them full access to all servers.

Safeguards:
- You cannot remove yourself from the team
- You cannot demote the last remaining admin
- You cannot delete the last remaining admin account

### Removing a team member

Click **Remove** on their row. Their access is revoked immediately.

---

## Changing your password

Click the **⚙** gear icon in the top-right corner of the navigation bar. Enter your current password, then your new password twice. The change takes effect immediately — use the new password on next sign-in.

---

## Target server requirements

| Feature | Requirement on the target server |
|---|---|
| Metrics | `python3` installed (`sudo apt install python3`) |
| Services tab | `systemd` (standard on Ubuntu 16.04+) |
| Service start/stop | Passwordless sudo for systemctl (see below) |
| Docker tab | Docker installed, SSH user in `docker` group |
| File browser / upload | SFTP enabled (default on most SSH servers) |
| Logs | `journalctl` or `/var/log/syslog` |

### Passwordless sudo for service management

On the **target server**, add to `/etc/sudoers` via `sudo visudo`:

```
ubuntu ALL=(ALL) NOPASSWD: /bin/systemctl
```

Replace `ubuntu` with your actual SSH username.

### Docker group

```bash
sudo usermod -aG docker ubuntu
# Log out and back in for the group change to take effect
```

---

## Architecture

```
Browser (port 3000)
    │
    ▼
┌───────────────────────┐
│  Frontend (Next.js)   │  Static React app — all UI, xterm.js terminal
│  port 3000            │
└──────────┬────────────┘
           │  HTTP API + WebSocket
           ▼
┌───────────────────────┐
│  Backend (FastAPI)    │  JWT auth, SSH/SFTP orchestration, user management
│  port 8000            │  Fernet encryption of stored credentials
└──────────┬────────────┘
           │  SSH / SFTP (paramiko)
           │  WireGuard tunnel (wg-quick) when configured
           ▼
┌───────────────────────┐
│  Your servers         │  Any SSH-accessible Linux server
│  port 22              │
└───────────────────────┘
```

Data is persisted in a named Docker volume (`serverhub_data`) mounted at `/data`:

```
/data/
├── servers.json        # Server registry (no plaintext credentials)
├── users.json          # User accounts (bcrypt-style hashed passwords)
├── permissions.json    # Per-user server access grants
├── ssh_keys/           # Fernet-encrypted private keys (one file per server)
└── wg_configs/         # Fernet-encrypted WireGuard configs
```

---

## Security notes

- **Change the default password** (`admin123`) before connecting any real servers
- **Generate a strong JWT secret**: `openssl rand -hex 32` — this also derives the encryption key for stored credentials
- Run ServerHub on a **private network or behind a VPN** — it can execute arbitrary commands on your servers via SSH
- **Do not expose port 8000** to the public internet — only port 3000 is needed for browser access
- SSH keys and WireGuard configs are stored `chmod 600` inside the Docker volume
- Rotating `JWT_SECRET` will invalidate all stored encrypted credentials — re-add servers after rotating

---

## Viewing container logs

```bash
# All services
docker compose logs -f

# Backend only
docker compose logs -f backend

# Frontend only
docker compose logs -f frontend
```

---

## Project structure

```
serverhub/
├── docker-compose.yml        # Orchestrates frontend + backend
├── .env.example              # Copy to .env and customise
├── .gitignore
├── README.md
├── backend/
│   ├── main.py               # FastAPI app — auth, SSH, encryption, all API routes
│   ├── requirements.txt
│   └── Dockerfile
└── frontend/
    ├── app/
    │   ├── page.tsx           # Main dashboard — all tabs, components, modals
    │   ├── TerminalTab.tsx    # xterm.js PTY over WebSocket
    │   ├── login/page.tsx     # Login page
    │   ├── layout.tsx
    │   └── globals.css
    ├── lib/
    │   └── api.ts             # Axios API client with auth interceptors
    ├── next.config.ts
    ├── Dockerfile
    └── package.json
```

---

## Troubleshooting

**"Cannot connect to server"**
- Verify the IP, port, and username are correct
- Confirm SSH is running on the target: `sudo systemctl status ssh`
- Test manually: `ssh -i ~/.ssh/your_key ubuntu@your-server-ip`
- Check the public key is in `~/.ssh/authorized_keys` on the target

**"SSH authentication failed"**
- Make sure you pasted the **private** key, not the `.pub` file
- Supported formats: RSA, Ed25519, ECDSA
- Try regenerating: `ssh-keygen -t ed25519 -C "serverhub"`

**WireGuard connection fails**
- Verify the `[Peer]` Endpoint is reachable from the ServerHub host
- Check the AllowedIPs covers the target server's IP
- DNS lines are stripped automatically — this is intentional

**Metrics tab shows "Failed to parse metrics"**
- Install python3 on the target: `sudo apt install python3`

**Docker tab is empty**
- Install Docker on the target: `sudo apt install docker.io`
- Add the SSH user to the docker group: `sudo usermod -aG docker ubuntu`

**Frontend can't reach the API**
- Set `NEXT_PUBLIC_API_URL` in `.env` to the correct backend address
- Rebuild after changing it: `docker compose up --build -d`

**Developer sees no servers after being granted access**
- They need to refresh the page once — the server list is fetched on load
- Confirm the Access button was saved (the badge in Team tab updates immediately if saved correctly)

**"Admin access required" error**
- The action requires an Admin role — Developers cannot add/delete servers or manage users
