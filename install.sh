#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# CinemaBerry — Install script for Armbian CLI (Orange Pi / Headless)
# Run as: sudo bash install.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

# Automatically detect the user who ran sudo, fallback to 'orangepi'
SERVICE_USER="${SUDO_USER:-orangepi}"
INSTALL_DIR="/home/${SERVICE_USER}/cinemaberry"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "🎬 CinemaBerry CLI Installer"
echo "─────────────────────────────────────────────────────"
echo "Target User: ${SERVICE_USER}"
echo "Install Dir: ${INSTALL_DIR}"

# ── 1. System dependencies ────────────────────────────────────────────────────
echo "→ Installing system dependencies…"
apt-get update -q
apt-get install -y -q mpv curl

# ── 2. Hardware Acceleration Permissions ──────────────────────────────────────
echo "→ Configuring DRM and hardware decoding permissions…"
# These groups are required to let mpv draw directly to the screen via CLI
usermod -aG video,render "$SERVICE_USER"

# ── 3. Node.js (v20 LTS) ─────────────────────────────────────────────────────
if ! command -v node &> /dev/null; then
  echo "→ Installing Node.js 20 LTS…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -q nodejs
else
  echo "→ Node.js already installed: $(node -v)"
fi

# ── 4. Copy application files ─────────────────────────────────────────────────
echo "→ Copying application to ${INSTALL_DIR}…"
mkdir -p "$INSTALL_DIR"

if [[ "$(realpath "$SCRIPT_DIR")" != "$(realpath "$INSTALL_DIR")" ]]; then
  cp -r "$SCRIPT_DIR/." "$INSTALL_DIR/"
else
  echo "Already in ${INSTALL_DIR} — skipping copy"
fi

chown -R "${SERVICE_USER}:${SERVICE_USER}" "$INSTALL_DIR"

# ── 5. Install npm dependencies ───────────────────────────────────────────────
echo "→ Installing npm dependencies…"
cd "$INSTALL_DIR"
sudo -u "$SERVICE_USER" npm install --production

# ── 6. Systemd service (CLI Optimized) ────────────────────────────────────────
echo "→ Creating systemd service…"
cat <<EOF | tee /etc/systemd/system/cinemaberry.service > /dev/null
[Unit]
Description=CinemaBerry Cinema Experience Creator
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
# No X11 DISPLAY or XAUTHORITY variables needed for DRM/CLI playback

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable cinemaberry
systemctl start cinemaberry

# ── 7. Firewall (optional) ────────────────────────────────────────────────────
if command -v ufw &> /dev/null; then
  echo "→ Opening port 3000 in firewall…"
  ufw allow 3000/tcp > /dev/null 2>&1 || true
fi

# ── Done ──────────────────────────────────────────────────────────────────────
PI_IP=$(hostname -I | awk '{print $1}')
echo ""
echo "─────────────────────────────────────────────────────"
echo "✅ CinemaBerry installed successfully!"
echo ""
echo "   NOTE: A system reboot is recommended to apply the"
echo "   new 'video' and 'render' group permissions."
echo ""
echo "   Web UI → http://${PI_IP}:3000"
echo ""
echo "   Commands:"
echo "   sudo systemctl status cinemaberry   # check status"
echo "   sudo systemctl restart cinemaberry  # restart"
echo "   sudo journalctl -u cinemaberry -f   # view logs"
echo "─────────────────────────────────────────────────────"