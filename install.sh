#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

# ==========================================
# Configuration Variables
# ==========================================
APP_NAME="cinemaberry"
NODE_VERSION="20"

# Automatically get the directory where this script is located
# This ensures the service paths are correct no matter where you cloned the repo
APP_DIR=$(dirname $(realpath "$0"))

# Ensure the script is run as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run this script with sudo."
  exit 1
fi

echo "🚀 Starting Cinemaberry Installation from $APP_DIR..."

# 1. Update system and install basic dependencies
echo "📦 Installing system dependencies (mpv, curl, build-essential)..."
apt-get update
apt-get install -y curl mpv build-essential

# 2. Install Node.js
echo "🟢 Installing Node.js (Version $NODE_VERSION LTS)..."
curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
apt-get install -y nodejs

# 3. Install NPM packages
echo "📚 Installing Node.js dependencies..."
cd "$APP_DIR"
npm install

# 4. Set up the Systemd Service
echo "⚙️ Creating systemd service for $APP_NAME..."
cat <<EOF > /etc/systemd/system/$APP_NAME.service
[Unit]
Description=Cinemaberry Node.js Media Server
After=network.target

[Service]
# RUN AS YOUR DESKTOP USER, NOT ROOT
User=cinema
Group=cinema

ExecStart=/usr/bin/node /opt/cinemaberry/server.js
WorkingDirectory=/opt/cinemaberry

Restart=always
RestartSec=3

Environment=NODE_ENV=production
Environment=PORT=3000

# THE MAGIC KEYS FOR X11/XFCE:
Environment=DISPLAY=:0
Environment=XAUTHORITY=/home/cinema/.Xauthority

StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# 5. Enable and start the service
echo "🔄 Reloading systemd and starting $APP_NAME..."
systemctl daemon-reload
systemctl enable $APP_NAME
systemctl restart $APP_NAME

echo "✅ Installation complete!"
echo "🌐 Your Cinemaberry server should now be running on port 3000."
echo "Check the status using: sudo systemctl status $APP_NAME"