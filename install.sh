
#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# CinemaBerry — Install script for Raspberry Pi OS (Bullseye / Bookworm)
# Run as: bash install.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

INSTALL_DIR="/home/orangepi/cinemaberry"
SERVICE_USER="orangepi"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "🎬 CinemaBerry Installer"
echo "─────────────────────────────────────────────────────"

# ── 1. System dependencies ────────────────────────────────────────────────────
echo "→ Installing system dependencies…"
sudo apt-get update -q
sudo apt-get install -y -q mpv curl

# ── 2. Node.js (v20 LTS) ─────────────────────────────────────────────────────
if ! command -v node &> /dev/null; then
  echo "→ Installing Node.js 20 LTS…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y -q nodejs
else
  echo "→ Node.js already installed: $(node -v)"
fi

# ── 3. Copy application files ─────────────────────────────────────────────────
echo "→ Copying application to ${INSTALL_DIR}…"
sudo mkdir -p "$INSTALL_DIR"
# Only copy if we're not already running from inside the install directory
if [[ "$(realpath "$SCRIPT_DIR")" != "$(realpath "$INSTALL_DIR")" ]]; then
  echo "Copying application to ${INSTALL_DIR}…"
  sudo cp -r "$SCRIPT_DIR/." "$INSTALL_DIR/"
else
  echo "Already in ${INSTALL_DIR} — skipping copy"
fi
sudo chown -R "${SERVICE_USER}:${SERVICE_USER}" "$INSTALL_DIR"

# ── 4. Install npm dependencies ───────────────────────────────────────────────
echo "→ Installing npm dependencies…"
cd "$INSTALL_DIR"
sudo -u "$SERVICE_USER" npm install --production

# ── 5. Systemd service ────────────────────────────────────────────────────────
echo "→ Creating systemd service…"
cat <<EOF | sudo tee /etc/systemd/system/cinemaberry.service > /dev/null
[Unit]
Description=CinemaBerry Cinema Experience Creator
After=graphical-session.target network.target
Wants=graphical-session.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
Environment=DISPLAY=:0
Environment=XAUTHORITY=/home/${SERVICE_USER}/.Xauthority

[Install]
WantedBy=graphical-session.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable cinemaberry
sudo systemctl start cinemaberry

# ── 6. Firewall (optional) ────────────────────────────────────────────────────
if command -v ufw &> /dev/null; then
  echo "→ Opening port 3000 in firewall…"
  sudo ufw allow 3000/tcp > /dev/null 2>&1 || true
fi

# ── Done ──────────────────────────────────────────────────────────────────────
PI_IP=$(hostname -I | awk '{print $1}')
echo ""
echo "─────────────────────────────────────────────────────"
echo "✅ CinemaBerry installed successfully!"
echo ""
echo "   Web UI → http://${PI_IP}:3000"
echo ""
echo "   Commands:"
echo "   sudo systemctl status cinemaberry   # check status"
echo "   sudo systemctl restart cinemaberry  # restart"
echo "   sudo journalctl -u cinemaberry -f   # view logs"
echo "─────────────────────────────────────────────────────"
