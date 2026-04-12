# ServerHub

A self-hosted developer operations portal. Manage unlimited servers from a single browser tab — terminal, metrics, Docker, services, files, logs, and team access control, all in one place.

---

## Table of contents

1. [Features](#features)
2. [Requirements](#requirements)
3. [Before you start — set your credentials](#before-you-start--set-your-credentials)
4. [Quick start](#quick-start)
5. [Environment variables](#environment-variables)
6. [Accessing from another machine](#accessing-from-another-machine)
7. [Dashboard walkthrough](#dashboard-walkthrough)
8. [Adding a server](#adding-a-server-admin-only)
9. [Team management](#team-management-admin-only)
10. [Changing your password](#changing-your-password)
11. [File upload](#file-upload)
12. [Architecture](#architecture)
13. [Target server requirements](#target-server-requirements)
14. [Security notes](#security-notes)
15. [Stopping and starting](#stopping-and-starting)
16. [Viewing container logs](#viewing-container-logs)
17. [Project structure](#project-structure)
18. [Troubleshooting](#troubleshooting)

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

## Before you start — set your credentials

> **This is the most important step.** ServerHub ships with a placeholder admin username and password defined in `.env.example`. You must set your own credentials before the first run. There are no hardcoded defaults — what you put in `.env` is what gets used.

### Step 1 — copy the example env file

```bash
cp .env.example .env
```

### Step 2 — open `.env` and fill in every value

```env
# The username you will log in with
ADMIN_USERNAME=admin

# Your password — choose something strong
ADMIN_PASSWORD=yourStrongPasswordHere

# A secret key used to sign JWT tokens and encrypt stored credentials.
# Generate one now: openssl rand -hex 32
JWT_SECRET=paste-your-generated-secret-here
```

**Do not skip the JWT secret.** It is used to both sign login tokens and derive the encryption key for all stored SSH keys, passwords, and WireGuard configs. If you leave it as the placeholder, anyone who reads your `.env` file can decrypt your stored credentials.

Generate a strong value right now:

```bash
openssl rand -hex 32
```

Paste the output into `JWT_SECRET` in your `.env` file.

### Step 3 — never commit `.env`

`.env` is listed in `.gitignore`. Keep it that way. Never push it to a repository.

---

## Quick start

```bash
# 1. Clone the project
git clone <repo-url> serverhub
cd serverhub

# 2. Set your credentials (see "Before you start" above)
cp .env.example .env
# Edit .env — set ADMIN_USERNAME, ADMIN_PASSWORD, and JWT_SECRET

# 3. Start everything
docker compose up --build -d

# 4. Open your browser
open http://localhost:3000
```

Sign in with the `ADMIN_USERNAME` and `ADMIN_PASSWORD` you set in `.env`.

---

## Environment variables

Edit `.env` before the first run:

```env
# ── Required — always change these ───────────────────────────────────────────

# Admin account username
ADMIN_USERNAME=admin

# Admin account password — use something strong, minimum 6 characters
ADMIN_PASSWORD=yourStrongPasswordHere

# JWT signing key AND credential encryption key.
# Generate with: openssl rand -hex 32
# WARNING: Changing this after first run will invalidate all stored encrypted
# credentials. You will need to re-add your servers.
JWT_SECRET=paste-your-generated-secret-here

# ── Required only if accessing from another machine ───────────────────────────

# Tell the browser where the backend API lives.
# Replace with the IP or hostname of the machine running ServerHub.
NEXT_PUBLIC_API_URL=http://YOUR_SERVER_IP:8000
```

> **The admin account is created from these values on the very first startup.** If you change `ADMIN_USERNAME` or `ADMIN_PASSWORD` after the database already exists, the change will not take effect — you must either change the password through the UI (gear icon → Change password) or wipe the data volume and restart.

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

Then rebuild:

```bash
docker compose down && docker compose up --build -d
```

Only port `3000` needs to be reachable from your browser. Do not expose port `8000` directly.

---

## Dashboard walkthrough

### Login

Navigate to `http://localhost:3000` (or your server's address). Sign in with the username and password you set in `.env`.

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
5. Click **Save access** — the badge updates immediately

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

Click the **⚙** gear icon in the top-right corner of the navigation bar. Enter your current password, then your new password twice. The change takes effect immediately.

---

## File upload

In the **Files** sub-tab, upload a file to the current directory two ways:

- **Click the ↑ Upload button** and pick a file
- **Drag and drop** a file onto the file browser area

Files are transferred over SFTP using the server's SSH credentials.

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
├── serverhub.db        # SQLite database — users, roles, server access grants
├── servers.json        # Server registry (no plaintext credentials)
├── ssh_keys/           # Fernet-encrypted private keys (one file per server)
└── wg_configs/         # Fernet-encrypted WireGuard configs
```

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

## Security notes

- **Set a strong password and JWT secret** before the first run — see [Before you start](#before-you-start--set-your-credentials)
- **Never expose port 8000** to the public internet — only port 3000 is needed for browser access
- Run ServerHub on a **private network or behind a VPN** — it can execute arbitrary commands on your servers via SSH
- SSH keys and WireGuard configs are stored `chmod 600` inside the Docker volume, encrypted with Fernet
- **Rotating `JWT_SECRET` will invalidate all stored encrypted credentials** — re-add servers after rotating
- Users are stored in a SQLite database (`/data/serverhub.db`) inside the Docker volume — back it up along with `ssh_keys/` and `wg_configs/`

---

## Stopping and starting

```bash
# Stop (keeps all data)
docker compose down

# Start again — no rebuild needed
docker compose up -d

# Wipe everything including stored servers, keys, and user accounts
docker compose down -v
```

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
├── .env.example              # Copy to .env and fill in your values
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

**"Invalid credentials" on first login**
- Make sure you set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env` before running `docker compose up --build`
- If you already ran it with the wrong values, wipe the data volume and rebuild: `docker compose down -v && docker compose up --build -d`
- The admin account is only bootstrapped once — on the very first startup when the database is empty

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

**Password or JWT secret changed but old credentials stopped working**
- `ADMIN_USERNAME`/`ADMIN_PASSWORD` in `.env` only apply on the very first run (database bootstrap)
- After first run, use the Change Password UI (gear icon) to update your password
- Changing `JWT_SECRET` invalidates all encrypted credentials — re-add your servers after rotating it
