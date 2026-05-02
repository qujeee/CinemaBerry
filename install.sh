#!/bin/bash
# ============================================================
# install.sh — Movie Player Setup for Orange Pi Zero 2w
# Armbian Desktop XFCE
# ============================================================
# Installs: MPV, Node.js, npm packages, bluez, pulseaudio,
#           wifi-connect (Balena)
# Sets up:  systemd service that auto-starts on boot:
#             • wifi-check.sh — provisions WiFi if not connected
#             • server.js     — movie player + web UI on port 80
#           with access to XFCE display, bluetoothctl, pactl
# ============================================================

set -e

# ── Colour helpers ──────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── Must be run as root ─────────────────────────────────────
[[ $EUID -ne 0 ]] && error "Run this script as root:  sudo bash install.sh"

# ── Resolve the real user (the one who called sudo) ─────────
REAL_USER="${SUDO_USER:-$(logname 2>/dev/null || echo '')}"
[[ -z "$REAL_USER" ]] && error "Could not determine the non-root user. Run via sudo."
REAL_HOME=$(getent passwd "$REAL_USER" | cut -d: -f6)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info "Installing for user: ${REAL_USER}  (home: ${REAL_HOME})"
info "Project directory:   ${SCRIPT_DIR}"

# ── 1. System update & MPV ──────────────────────────────────
info "Updating package lists…"
sudo apt-get update -qq

info "Setting up custom ffmpeg for Hardware Video Decoding (HVD)…"
sudo wget http://apt.undo.it:7242/apt.undo.it.asc -O /etc/apt/trusted.gpg.d/apt.undo.it.asc
. /etc/os-release && echo "deb http://apt.undo.it:7242 $VERSION_CODENAME main" | sudo tee /etc/apt/sources.list.d/apt.undo.it.list
echo -e "Package: *\nPin: release o=apt.undo.it\nPin-Priority: 600" | sudo tee /etc/apt/preferences.d/apt-undo-it

info "Installing MPV…"
sudo apt-get install -y ffmpeg mpv 

sudo mkdir -p /etc/mpv
echo -e "hwdec=drm\ndrm-drmprime-video-plane=primary\ndrm-draw-plane=overlay" | sudo tee /etc/mpv/mpv.conf

success "MPV installed: $(mpv --version | head -1)"

sudo echo "extraargs=cma=256M" >> /boot/armbianEnv.txt

# ── 2. Bluetooth & PulseAudio ───────────────────────────────
info "Installing Bluetooth stack (bluez) and PulseAudio…"
apt-get install -y \
    bluez \
    bluez-tools \
    pulseaudio \
    pulseaudio-utils \
    pulseaudio-module-bluetooth \
    dbus

# Enable and start the bluetooth system service
systemctl enable bluetooth.service
systemctl start  bluetooth.service || warn "bluetooth.service could not start now (will start on boot)."

success "Bluetooth and PulseAudio installed."

# ── 3. wifi-connect (Balena) ─────────────────────────────────
# Downloads the pre-built ARM binary that creates a setup hotspot
# and captive portal when no WiFi connection is available.
WIFI_CONNECT_VERSION="4.4.6"
WIFI_CONNECT_ARCH="aarch64"   # Orange Pi Zero 2w is 64-bit ARM
WIFI_CONNECT_URL="https://github.com/balena-io/wifi-connect/releases/download/v${WIFI_CONNECT_VERSION}/wifi-connect-v${WIFI_CONNECT_VERSION}-linux-${WIFI_CONNECT_ARCH}.tar.gz"
WIFI_CONNECT_BIN="/usr/local/bin/wifi-connect"

if [[ -f "$WIFI_CONNECT_BIN" ]]; then
    info "wifi-connect already installed, skipping download."
else
    info "Downloading wifi-connect v${WIFI_CONNECT_VERSION} (${WIFI_CONNECT_ARCH})…"
    apt-get install -y curl ca-certificates
    TMP_DIR=$(mktemp -d)
    curl -fsSL "$WIFI_CONNECT_URL" -o "${TMP_DIR}/wifi-connect.tar.gz"
    tar -xzf "${TMP_DIR}/wifi-connect.tar.gz" -C "$TMP_DIR"
    install -m 755 "${TMP_DIR}/wifi-connect" "$WIFI_CONNECT_BIN"
    rm -rf "$TMP_DIR"
    success "wifi-connect installed to ${WIFI_CONNECT_BIN}"
fi

# wifi-connect needs NetworkManager (nm) — should be present on Armbian desktop,
# but make sure it is running
systemctl enable NetworkManager.service
systemctl start  NetworkManager.service || warn "NetworkManager could not start now."

# Write the wifi-check.sh wrapper that the systemd service will call
WIFI_CHECK_SCRIPT="${SCRIPT_DIR}/wifi-check.sh"
info "Writing wifi-check.sh to ${WIFI_CHECK_SCRIPT}…"
cat > "$WIFI_CHECK_SCRIPT" << 'WIFIEOF'
#!/bin/bash
# wifi-check.sh
# Runs at boot (as root, before server.js).
# If no active WiFi connection exists, starts wifi-connect which:
#   1. Broadcasts a "Cinema-Setup" hotspot
#   2. Serves a captive portal where you pick your WiFi & enter the password
#   3. Connects to that network, then exits
# Once wifi-connect exits (connected), server.js takes over.

HOTSPOT_SSID="Cinema-Setup"
WIFI_CONNECT_BIN="/usr/local/bin/wifi-connect"
CHECK_HOST="1.1.1.1"   # Ping target to confirm real connectivity

is_connected() {
    # Returns 0 (true) if there is an active WiFi connection with internet
    nmcli -t -f TYPE,STATE device | grep -q "^wifi:connected" && \
    ping -c1 -W3 "$CHECK_HOST" &>/dev/null
}

if is_connected; then
    echo "[wifi-check] Already connected to WiFi — skipping hotspot."
    exit 0
fi

echo "[wifi-check] No WiFi connection detected. Starting setup hotspot '${HOTSPOT_SSID}'…"
"$WIFI_CONNECT_BIN" \
    --ssid        "$HOTSPOT_SSID" \
    --portal-listening-port 8080

# wifi-connect blocks until the user has completed setup and the Pi
# has successfully joined the chosen network, then it exits.
echo "[wifi-check] WiFi provisioning complete. Handing off to server.js."
exit 0
WIFIEOF

chmod +x "$WIFI_CHECK_SCRIPT"
chown root:root "$WIFI_CHECK_SCRIPT"
success "wifi-check.sh written."

# ── 4. Node.js (via NodeSource — LTS) ───────────────────────
if command -v node &>/dev/null; then
    NODE_VER=$(node --version)
    info "Node.js already installed: ${NODE_VER}"
else
    info "Installing Node.js LTS via NodeSource…"
    apt-get install -y curl ca-certificates gnupg
    curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
    apt-get install -y nodejs
    success "Node.js installed: $(node --version)"
fi

success "npm: $(npm --version)"

# ── 5. npm packages ─────────────────────────────────────────
info "Installing npm packages in ${SCRIPT_DIR}…"
cd "$SCRIPT_DIR"

# Make sure package.json exists
[[ -f package.json ]] || error "No package.json found in ${SCRIPT_DIR}. Aborting npm install."

# Install as the real user so file ownership is correct
sudo -u "$REAL_USER" npm install --omit=dev

success "npm packages installed."

# ── 6. Permissions ──────────────────────────────────────────
info "Setting permissions on project directory…"
chown -R "${REAL_USER}:${REAL_USER}" "$SCRIPT_DIR"
chmod -R u+rwX,go+rX "$SCRIPT_DIR"

# Allow Node.js to bind to port 80 without root
NODE_BIN="$(command -v node)"
info "Granting node binary cap_net_bind_service (port 80)…"
apt-get install -y libcap2-bin
setcap 'cap_net_bind_service=+ep' "$NODE_BIN"
success "cap_net_bind_service set on ${NODE_BIN}"

# MPV needs access to the GPU / video devices
# bluetooth group → bluetoothctl
# pulse / pulse-access → pactl
for grp in video render audio bluetooth pulse pulse-access; do
    if getent group "$grp" &>/dev/null; then
        usermod -aG "$grp" "$REAL_USER" && info "Added ${REAL_USER} to group: ${grp}"
    fi
done

# ── 7. systemd service ──────────────────────────────────────
SERVICE_NAME="movie-player"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# Detect display — XFCE on Armbian typically uses :0
DISPLAY_NUM=":0"
XAUTH_FILE="${REAL_HOME}/.Xauthority"

info "Creating systemd service: ${SERVICE_NAME}…"
cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Movie Player (wifi-check + server.js + MPV)
# Wait for the graphical desktop, network stack, and bluetooth
After=graphical.target NetworkManager.service bluetooth.service
Wants=graphical.target NetworkManager.service bluetooth.service

[Service]
Type=simple
User=root
WorkingDirectory=${SCRIPT_DIR}

# Expose the XFCE display to MPV (opened by server.js as ${REAL_USER})
Environment="DISPLAY=${DISPLAY_NUM}"
Environment="XAUTHORITY=${XAUTH_FILE}"
Environment="HOME=${REAL_HOME}"
Environment="NODE_ENV=production"
Environment="REAL_USER=${REAL_USER}"

# PulseAudio / D-Bus for the real user
Environment="XDG_RUNTIME_DIR=/run/user/$(id -u ${REAL_USER})"
Environment="PULSE_RUNTIME_PATH=/run/user/$(id -u ${REAL_USER})/pulse"
Environment="PULSE_SERVER=unix:/run/user/$(id -u ${REAL_USER})/pulse/native"
Environment="DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u ${REAL_USER})/bus"

# 1. Run wifi provisioning (blocks until connected, then exits)
ExecStartPre=${SCRIPT_DIR}/wifi-check.sh

# 2. Wait for X display to be ready and fully responsive
ExecStartPre=/bin/bash -c 'for i in {1..60}; do DISPLAY=${DISPLAY_NUM} xset q &>/dev/null && exit 0; sleep 1; done; exit 1'

# 3. Launch server.js as the real user once WiFi is confirmed and desktop is ready
ExecStart=/usr/bin/sudo -u ${REAL_USER} ${NODE_BIN} ${SCRIPT_DIR}/server.js

# Robust restart behaviour
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=5

# Logging: journalctl -u ${SERVICE_NAME} -f
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=graphical.target
EOF

success "Service file written to ${SERVICE_FILE}"

# ── 8. Enable & start the service ───────────────────────────
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"
info "Service enabled (will start on next boot)."

# Try to start it now only if a display is already running
if DISPLAY="${DISPLAY_NUM}" xset q &>/dev/null 2>&1; then
    systemctl start "${SERVICE_NAME}.service"
    sleep 2
    if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
        success "Service is running right now."
    else
        warn "Service did not start immediately. Check: journalctl -u ${SERVICE_NAME} -f"
    fi
else
    warn "No active X display detected yet. Service will start automatically after the next login/reboot."
    info "To start it manually after logging into the desktop:  sudo systemctl start ${SERVICE_NAME}"
fi

# ── 9. Hostname (cinema / cinema.local) ─────────────────────
HOSTNAME_NEW="cinema"
HOSTNAME_OLD="$(hostname)"

if [[ "$HOSTNAME_OLD" != "$HOSTNAME_NEW" ]]; then
    info "Setting hostname to '${HOSTNAME_NEW}'…"
    hostnamectl set-hostname "$HOSTNAME_NEW"

    # Update /etc/hosts so the new name resolves locally too
    if grep -q "127.0.1.1" /etc/hosts; then
        sed -i "s/127\.0\.1\.1\s.*/127.0.1.1\t${HOSTNAME_NEW}/" /etc/hosts
    else
        echo -e "127.0.1.1\t${HOSTNAME_NEW}" >> /etc/hosts
    fi

    success "Hostname changed: ${HOSTNAME_OLD} → ${HOSTNAME_NEW}"
else
    info "Hostname is already '${HOSTNAME_NEW}', skipping."
fi

# Ensure avahi-daemon is installed and running for .local mDNS resolution
info "Installing avahi-daemon (cinema.local mDNS)…"
apt-get install -y avahi-daemon avahi-utils
systemctl enable avahi-daemon.service
systemctl restart avahi-daemon.service
success "avahi-daemon running — device is reachable at ${HOSTNAME_NEW}.local"

# ── 10. Summary ──────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Installation complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo -e "  Service name : ${CYAN}${SERVICE_NAME}${NC}"
echo -e "  Project dir  : ${CYAN}${SCRIPT_DIR}${NC}"
echo -e "  Runs as user : ${CYAN}${REAL_USER}${NC}"
echo -e "  Web UI       : ${CYAN}http://cinema.local${NC}  (port 80)"
echo ""
echo -e "  WiFi setup (first boot on new network):"
echo -e "    1. Connect your phone to ${CYAN}Cinema-Setup${NC} hotspot"
echo -e "    2. A portal opens — pick your WiFi & enter the password"
echo -e "    3. Pi connects and cinema.local becomes available"
echo ""
echo -e "  Useful commands:"
echo -e "    sudo systemctl status  ${SERVICE_NAME}"
echo -e "    sudo systemctl restart ${SERVICE_NAME}"
echo -e "    sudo journalctl -u ${SERVICE_NAME} -f"
echo ""
echo -e "${YELLOW}  Reboot recommended so group changes take effect.${NC}"
echo ""