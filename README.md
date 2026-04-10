# ServerHub 🖥

A self-hosted, multi-server infrastructure management dashboard.
Login-protected. SSH into any server and manage it from your browser — no terminal needed.

---

## Features

- 🔐 **Login-protected** — JWT-based auth, fully stateless
- 🖥 **Multi-server** — Add unlimited servers, switch between them instantly
- 🔑 **SSH Key & Password auth** — Paste your private key or use a password
- 📊 **Live metrics** — CPU, RAM, Disk, Network, Uptime (auto-refreshes)
- 💻 **Web terminal** — Run any command, with command history (↑↓), Ctrl+L to clear
- 🐳 **Docker** — List containers, start/stop/restart, view logs
- ⚙️ **Services** — Browse and control systemd services
- 📁 **File browser** — Navigate the filesystem, view file contents
- 📋 **Logs** — Tail syslog or any systemd service journal
- ⚡ **Quick actions** — One-click common ops from the Overview tab

---

## Requirements

- [Docker](https://docs.docker.com/get-docker/) + [Docker Compose](https://docs.docker.com/compose/install/)
- That's it.

---

## Quick Start

```bash
# 1. Clone / unzip the project
cd serverhub

# 2. Copy and edit the environment file
cp .env.example .env
nano .env   # change ADMIN_PASSWORD and JWT_SECRET at minimum

# 3. Start everything
docker-compose up --build -d

# 4. Open your browser
open http://localhost:3000
```

Default credentials: **admin / admin123** — change these in `.env` before exposing to any network.

---

## Accessing from another machine on your network

If you're running ServerHub on a home server or VPS and want to access it from another machine, you need to tell the frontend where the API lives.

Edit `.env`:
```env
NEXT_PUBLIC_API_URL=http://YOUR_SERVER_IP:8000
```

Then rebuild:
```bash
docker-compose down
docker-compose up --build -d
```

---

## Stopping & Starting

```bash
# Stop (keeps data)
docker-compose down

# Start again (no rebuild needed)
docker-compose up -d

# Stop and remove all data (servers, SSH keys)
docker-compose down -v
```

---

## Viewing logs

```bash
# All services
docker-compose logs -f

# Just the backend
docker-compose logs -f backend

# Just the frontend
docker-compose logs -f frontend
```

---

## Adding a server

1. Click **+ Add server** in the top-right
2. Fill in:
   - **Display name** — anything you like
   - **Tag** — prod, staging, api, db, etc.
   - **IP / Hostname** — the server's IP or domain
   - **SSH Port** — default 22
   - **SSH Username** — the user to SSH in as (e.g. `ubuntu`, `root`, `samson`)
3. Choose **SSH Key** (recommended) or **Password**
   - For SSH Key: paste the full contents of your private key (`~/.ssh/id_rsa` or similar)
4. Click **Add server** — ServerHub will test the connection immediately

### SSH Key tips

Your private key looks like:
```
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAA...
-----END OPENSSH PRIVATE KEY-----
```

To copy it:
```bash
cat ~/.ssh/id_rsa       # RSA key
cat ~/.ssh/id_ed25519   # Ed25519 key (newer, preferred)
```

Keys are stored on the ServerHub host machine at `/data/ssh_keys/` inside the Docker volume — not accessible from outside.

### Making sure your key works

On the **target server**, your public key must be in `~/.ssh/authorized_keys`:
```bash
# On your local machine
ssh-copy-id -i ~/.ssh/id_ed25519.pub ubuntu@your-server-ip

# Or manually — on the target server:
echo "YOUR_PUBLIC_KEY_CONTENT" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

---

## Metrics requirements

The **Overview** tab uses `python3` to read `/proc` on the target server. Most Ubuntu/Debian servers have it. If not:
```bash
sudo apt install python3
```

---

## Sudo for service management

To restart/start/stop systemd services from ServerHub, the SSH user needs passwordless sudo for systemctl. Add to `/etc/sudoers` on the target server (via `sudo visudo`):

```
ubuntu ALL=(ALL) NOPASSWD: /bin/systemctl
```

Replace `ubuntu` with your actual SSH username.

---

## Architecture

```
Browser (port 3000)
    │
    ▼
┌─────────────────────┐
│  Frontend (Next.js) │  ← Static React app, served by Node
│  port 3000          │
└────────┬────────────┘
         │ HTTP API calls
         ▼
┌─────────────────────┐
│  Backend (FastAPI)  │  ← JWT auth, SSH orchestration
│  port 8000          │
└────────┬────────────┘
         │ SSH (paramiko)
         ▼
┌─────────────────────┐
│  Your Ubuntu Servers│  ← Any SSH-accessible server
│  port 22            │
└─────────────────────┘
```

Both services run inside Docker containers via `docker-compose`. Server configs and SSH keys are persisted in a named Docker volume (`serverhub_data`).

---

## Security notes

- **Change the default password** before connecting any real servers
- **Generate a strong JWT secret**: `openssl rand -hex 32`
- ServerHub should ideally run on a **private network or behind a VPN** (e.g. Tailscale) — the backend can execute arbitrary commands on your servers via SSH
- **Do not expose port 8000** to the public internet — only port 3000 (frontend) is needed for browser access
- SSH keys are stored with `chmod 600` permissions inside the Docker volume

---

## Customising the admin user

Edit `.env`:
```env
ADMIN_USERNAME=samson
ADMIN_PASSWORD=your-strong-password-here
JWT_SECRET=your-64-char-hex-string-here
```

Then restart:
```bash
docker-compose restart backend
```

---

## Troubleshooting

**"Cannot connect to server"**
- Check the IP/port are correct
- Ensure SSH is running: `sudo systemctl status ssh`
- Confirm the public key is in `~/.ssh/authorized_keys` on the target server
- Test manually: `ssh -i ~/.ssh/your_key ubuntu@your-server-ip`

**"SSH authentication failed"**
- Double-check you pasted the **private** key (not the `.pub` file)
- Ensure the key format is supported (RSA, Ed25519, ECDSA)
- Try regenerating: `ssh-keygen -t ed25519 -C "serverhub"`

**Frontend can't reach the API**
- Set `NEXT_PUBLIC_API_URL` in `.env` to the correct backend URL
- Rebuild after changing this env var: `docker-compose up --build -d`

**Metrics fail with "Failed to parse metrics"**
- Install python3 on the target server: `sudo apt install python3`

**Docker tab shows nothing**
- Docker must be installed on the target server: `sudo apt install docker.io`
- The SSH user must be in the docker group: `sudo usermod -aG docker ubuntu`

---

## Project structure

```
serverhub/
├── docker-compose.yml       # Orchestrates frontend + backend
├── .env.example             # Copy to .env and edit
├── .gitignore
├── backend/
│   ├── main.py              # FastAPI app — auth, SSH, all API routes
│   ├── requirements.txt
│   └── Dockerfile
└── frontend/
    ├── app/
    │   ├── page.tsx          # Main dashboard (all tabs)
    │   ├── login/page.tsx    # Login page
    │   ├── layout.tsx
    │   └── globals.css
    ├── lib/
    │   └── api.ts            # Axios API client
    ├── next.config.ts
    ├── Dockerfile
    └── package.json
```
