#!/bin/bash
# ═════════════════════════════════════════════════════════════════════════════
# CinemaBerry — Complete installer for Orange Pi Zero 2W
#
# What this script does:
#   1.  Installs all system dependencies
#   2.  Installs Node.js 20 LTS
#   3.  Deploys your app and npm dependencies
#   4.  Creates a virtual Wi-Fi hotspot (uap0) that is ALWAYS on,
#       even when not connected to any real network
#   5.  Configures hostapd to broadcast the CinemaBerry Wi-Fi network
#   6.  Configures dnsmasq so phones get IPs and resolve cinema.pi
#   7.  Sets up NAT so hotspot clients can reach the internet via wlan0
#       (when wlan0 is connected — streaming works; when not, UI still works)
#   8.  Writes wifi-routes.js — Express routes for scanning / connecting Wi-Fi
#   9.  Grants passwordless nmcli access so the app can manage Wi-Fi
#   10. Registers and starts all systemd services
#
# ── CONFIGURE THESE BEFORE RUNNING ──────────────────────────────────────────
AP_SSID="CinemaBerry"        # Hotspot name phones will see
AP_PASS="popcorn1"           # Hotspot password (min 8 chars — change this!)
AP_DOMAIN="cinema.pi"        # Domain to type in the browser on your phone
AP_IP="10.42.0.1"            # Orange Pi's IP on the hotspot network
AP_DHCP_START="10.42.0.10"   # DHCP pool start
AP_DHCP_END="10.42.0.100"    # DHCP pool end
AP_CHANNEL="6"               # 2.4 GHz channel (1, 6, or 11 are cleanest)
APP_PORT="3000"              # Port your Node.js server listens on
# ─────────────────────────────────────────────────────────────────────────────

set -e

INSTALL_DIR="/home/orangepi/cinemaberry"
SERVICE_USER="orangepi"
BASE_IFACE="wlan0"
AP_IFACE="uap0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${CYAN}→${NC} $*"; }
success() { echo -e "${GREEN}✅${NC} $*"; }
warn()    { echo -e "${YELLOW}⚠️ ${NC} $*"; }
fatal()   { echo -e "${RED}❌  $*${NC}"; exit 1; }
section() { echo -e "\n${BOLD}── $* ──${NC}"; }

echo ""
echo -e "${BOLD}🎬  CinemaBerry Installer  (Orange Pi Zero 2W)${NC}"
echo "════════════════════════════════════════════════"

# ── Sanity checks ─────────────────────────────────────────────────────────────
[[ "$EUID" -eq 0 ]] && fatal "Run as the orangepi user, not root.\n   e.g.  bash install.sh"
command -v nmcli &>/dev/null || fatal "NetworkManager (nmcli) not found. Is this an Orange Pi Ubuntu image?"

# ── 1. System dependencies ────────────────────────────────────────────────────
section "System dependencies"
info "Running apt-get update…"
sudo apt-get update -q

info "Installing packages…"
sudo apt-get install -y -q \
  mpv curl iw hostapd dnsmasq iptables-persistent netfilter-persistent

# hostapd is masked by default on Ubuntu — unmask it
sudo systemctl unmask hostapd 2>/dev/null || true
sudo systemctl stop hostapd   2>/dev/null || true
success "System dependencies installed"

# ── 2. Node.js 20 LTS ────────────────────────────────────────────────────────
section "Node.js"
if node -v 2>/dev/null | grep -q "^v20"; then
  info "Node.js 20 already installed: $(node -v)"
else
  info "Installing Node.js 20 LTS…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y -q nodejs
  success "Node.js $(node -v) installed"
fi

# ── 3. Deploy app ─────────────────────────────────────────────────────────────
section "Application files"
sudo mkdir -p "$INSTALL_DIR"
# Only copy if we're not already running from inside the install directory
if [[ "$(realpath "$SCRIPT_DIR")" != "$(realpath "$INSTALL_DIR")" ]]; then
  info "Copying application to ${INSTALL_DIR}…"
  sudo cp -r "$SCRIPT_DIR/." "$INSTALL_DIR/"
else
  info "Already in ${INSTALL_DIR} — skipping copy"
fi
sudo chown -R "${SERVICE_USER}:${SERVICE_USER}" "$INSTALL_DIR"

info "Installing npm dependencies…"
cd "$INSTALL_DIR"
sudo -u "$SERVICE_USER" npm install --production
success "Application deployed"

# ── 4. Write wifi-routes.js ───────────────────────────────────────────────────
#
#  This file exports a function: require('./wifi-routes')(app)
#  Add that one line to your server.js after you create the express app.
#
section "Wi-Fi management API (wifi-routes.js)"
info "Writing wifi-routes.js…"

sudo -u "$SERVICE_USER" tee "$INSTALL_DIR/wifi-routes.js" > /dev/null <<'WIFIEOF'
/**
 * CinemaBerry Wi-Fi management routes
 * Usage in server.js:  require('./wifi-routes')(app);
 *
 * Endpoints:
 *   GET  /wifi/status      — current connection info
 *   GET  /wifi/scan        — list nearby networks
 *   POST /wifi/connect     — { ssid, password } connect to a network
 *   POST /wifi/disconnect  — disconnect from real network
 */

'use strict';
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

module.exports = function registerWifiRoutes(app) {

  // ── GET /wifi/status ──────────────────────────────────────────────────────
  app.get('/wifi/status', async (req, res) => {
    try {
      const { stdout } = await execAsync(
        'nmcli -t -f NAME,TYPE,STATE con show --active'
      );
      const activeLine = stdout
        .split('\n')
        .find(l => l.includes('802-11-wireless') && l.includes('activated'));

      const network = activeLine ? activeLine.split(':')[0] : null;

      let ip = null;
      if (network) {
        const { stdout: addrOut } = await execAsync('ip -4 addr show wlan0');
        ip = addrOut.match(/inet (\S+)/)?.[1] || null;
      }

      res.json({ connected: !!network, network, ip });
    } catch {
      res.json({ connected: false, network: null, ip: null });
    }
  });

  // ── GET /wifi/scan ────────────────────────────────────────────────────────
  app.get('/wifi/scan', async (req, res) => {
    try {
      // Request a fresh scan (may fail silently — that's fine)
      await execAsync('nmcli dev wifi rescan ifname wlan0').catch(() => {});

      const { stdout } = await execAsync(
        'nmcli -t -f SSID,SIGNAL,SECURITY dev wifi list ifname wlan0'
      );

      const networks = stdout
        .split('\n')
        .filter(Boolean)
        .map(line => {
          // nmcli escapes colons as \: — handle that
          const parts = line.replace(/\\:/g, '\x00').split(':');
          const ssid     = parts[0]?.replace(/\x00/g, ':') || '';
          const signal   = parseInt(parts[1]) || 0;
          const security = parts[2] || '--';
          return { ssid, signal, secure: security !== '--' };
        })
        .filter(n => n.ssid)
        // Deduplicate — keep the entry with the strongest signal
        .reduce((acc, n) => {
          const idx = acc.findIndex(e => e.ssid === n.ssid);
          if (idx === -1) return [...acc, n];
          if (n.signal > acc[idx].signal) acc[idx] = n;
          return acc;
        }, [])
        .sort((a, b) => b.signal - a.signal);

      res.json({ networks });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /wifi/connect ────────────────────────────────────────────────────
  app.post('/wifi/connect', async (req, res) => {
    const { ssid, password } = req.body || {};
    if (!ssid) return res.status(400).json({ error: 'ssid is required' });

    try {
      // Remove any stale saved profile for this SSID first
      await execAsync(`nmcli con delete "${ssid}"`).catch(() => {});

      const cmd = password
        ? `nmcli dev wifi connect "${ssid}" password "${password}" ifname wlan0`
        : `nmcli dev wifi connect "${ssid}" ifname wlan0`;

      await execAsync(cmd);

      const { stdout } = await execAsync('ip -4 addr show wlan0');
      const ip = stdout.match(/inet (\S+)/)?.[1] || 'unknown';
      res.json({ success: true, ip });
    } catch (e) {
      const msg = e.stderr || e.message || '';
      const hint = msg.includes('Secrets were required') || msg.includes('password')
        ? 'Wrong password?'
        : 'Connection failed — check SSID and password.';
      res.status(500).json({ error: hint, detail: msg });
    }
  });

  // ── POST /wifi/disconnect ─────────────────────────────────────────────────
  app.post('/wifi/disconnect', async (req, res) => {
    try {
      await execAsync('nmcli dev disconnect wlan0');
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};
WIFIEOF

success "wifi-routes.js written to ${INSTALL_DIR}/wifi-routes.js"

# ── 5. Write wifi-panel.html snippet ─────────────────────────────────────────
#
#  A self-contained HTML + JS panel you can paste into your UI.
#
section "Wi-Fi UI panel (wifi-panel.html)"
info "Writing wifi-panel.html…"

sudo -u "$SERVICE_USER" tee "$INSTALL_DIR/wifi-panel.html" > /dev/null <<'HTMLEOF'
<!--
  CinemaBerry Wi-Fi Settings Panel
  Drop this anywhere in your UI, or load it in an iframe / modal.
  Requires: wifi-routes.js registered on the same Express server.
-->
<style>
  #cb-wifi { font-family: sans-serif; max-width: 380px; padding: 16px; }
  #cb-wifi h3 { margin: 0 0 12px; }
  #cb-wifi button {
    padding: 8px 14px; border: none; border-radius: 6px;
    background: #1a73e8; color: #fff; cursor: pointer; font-size: 14px;
  }
  #cb-wifi button:disabled { opacity: .5; cursor: default; }
  #cb-wifi button.secondary {
    background: #e0e0e0; color: #333; margin-left: 6px;
  }
  #cb-wifi button.danger { background: #d32f2f; }
  #cb-wifi ul { list-style: none; padding: 0; margin: 12px 0; }
  #cb-wifi li {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 8px; border-bottom: 1px solid #eee; cursor: pointer;
    border-radius: 4px;
  }
  #cb-wifi li:hover { background: #f5f5f5; }
  #cb-wifi .status-box {
    padding: 10px; border-radius: 6px; margin-bottom: 12px;
    background: #f0f4ff; font-size: 14px;
  }
  #cb-wifi input {
    width: 100%; padding: 8px; box-sizing: border-box;
    border: 1px solid #ccc; border-radius: 6px;
    font-size: 14px; margin: 8px 0;
  }
  #cb-wifi .connect-form { border: 1px solid #ccc; border-radius: 8px; padding: 12px; margin-top: 10px; }
  #cb-wifi .signal { font-size: 12px; color: #555; }
</style>

<div id="cb-wifi">
  <h3>📶 Wi-Fi</h3>

  <div id="cb-status" class="status-box">Checking connection…</div>

  <button id="cb-scan-btn" onclick="cbScan()">🔍 Scan for networks</button>
  <button id="cb-disconnect-btn" class="danger" onclick="cbDisconnect()"
          style="display:none">Disconnect</button>

  <ul id="cb-network-list"></ul>

  <div id="cb-connect-form" class="connect-form" style="display:none">
    <strong id="cb-connect-ssid"></strong>
    <input type="password" id="cb-password" placeholder="Password (leave blank if open)" />
    <button onclick="cbConnect()">Connect</button>
    <button class="secondary" onclick="cbHideForm()">Cancel</button>
    <div id="cb-connect-msg" style="font-size:13px;margin-top:6px"></div>
  </div>
</div>

<script>
(function () {
  'use strict';
  let _selectedSSID = '';

  function cbSignalBar(s) {
    if (s > 70) return '▂▄▆█';
    if (s > 40) return '▂▄▆░';
    if (s > 20) return '▂▄░░';
    return '▂░░░';
  }

  window.cbRefreshStatus = async function () {
    try {
      const r = await fetch('/wifi/status');
      const { connected, network, ip } = await r.json();
      const el = document.getElementById('cb-status');
      const discBtn = document.getElementById('cb-disconnect-btn');
      if (connected) {
        el.innerHTML = `✅ Connected to <strong>${network}</strong><br><small>${ip}</small>`;
        el.style.background = '#e8f5e9';
        discBtn.style.display = 'inline-block';
      } else {
        el.innerHTML = '❌ Not connected to a network<br><small>Hotspot is still active</small>';
        el.style.background = '#fff3e0';
        discBtn.style.display = 'none';
      }
    } catch {
      document.getElementById('cb-status').textContent = 'Could not reach status endpoint';
    }
  };

  window.cbScan = async function () {
    const btn = document.getElementById('cb-scan-btn');
    btn.textContent = '⏳ Scanning…';
    btn.disabled = true;
    document.getElementById('cb-network-list').innerHTML = '';
    try {
      const r = await fetch('/wifi/scan');
      const { networks, error } = await r.json();
      if (error) { alert(error); return; }

      const list = document.getElementById('cb-network-list');
      if (!networks.length) {
        list.innerHTML = '<li style="cursor:default;color:#999">No networks found</li>';
        return;
      }
      list.innerHTML = networks.map(n => `
        <li onclick="cbShowForm(${JSON.stringify(n.ssid)})">
          <span>${n.ssid} ${n.secure ? '🔒' : '🔓'}</span>
          <span class="signal">${cbSignalBar(n.signal)} ${n.signal}%</span>
        </li>`).join('');
    } finally {
      btn.textContent = '🔍 Scan for networks';
      btn.disabled = false;
    }
  };

  window.cbShowForm = function (ssid) {
    _selectedSSID = ssid;
    document.getElementById('cb-connect-ssid').textContent = ssid;
    document.getElementById('cb-password').value = '';
    document.getElementById('cb-connect-msg').textContent = '';
    document.getElementById('cb-connect-form').style.display = 'block';
    document.getElementById('cb-password').focus();
  };

  window.cbHideForm = function () {
    document.getElementById('cb-connect-form').style.display = 'none';
  };

  window.cbConnect = async function () {
    const password = document.getElementById('cb-password').value;
    const msg = document.getElementById('cb-connect-msg');
    msg.textContent = '⏳ Connecting…';
    try {
      const r = await fetch('/wifi/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ssid: _selectedSSID, password })
      });
      const data = await r.json();
      if (data.success) {
        cbHideForm();
        await cbRefreshStatus();
        msg.textContent = '';
      } else {
        msg.style.color = 'red';
        msg.textContent = '❌ ' + (data.error || 'Connection failed');
      }
    } catch {
      msg.style.color = 'red';
      msg.textContent = '❌ Network error';
    }
  };

  window.cbDisconnect = async function () {
    if (!confirm('Disconnect from the current network?')) return;
    await fetch('/wifi/disconnect', { method: 'POST' });
    await cbRefreshStatus();
  };

  // Auto-refresh every 10 seconds
  cbRefreshStatus();
  setInterval(cbRefreshStatus, 10000);
})();
</script>
HTMLEOF

success "wifi-panel.html written to ${INSTALL_DIR}/wifi-panel.html"

# ── 6. Tell NetworkManager to ignore uap0 ────────────────────────────────────
section "NetworkManager"
info "Configuring NetworkManager to leave ${AP_IFACE} alone…"
sudo tee /etc/NetworkManager/conf.d/cinemaberry-unmanaged.conf > /dev/null <<EOF
[keyfile]
unmanaged-devices=interface-name:${AP_IFACE}
EOF
sudo systemctl reload NetworkManager 2>/dev/null || sudo systemctl restart NetworkManager

# Dispatcher: if wlan0 comes back up (e.g. after switching networks) restart the AP
info "Installing NetworkManager dispatcher for roaming recovery…"
sudo tee /etc/NetworkManager/dispatcher.d/99-cinemaberry-uap0 > /dev/null <<EOF
#!/bin/bash
IFACE="\$1"
EVENT="\$2"
if [[ "\$IFACE" == "${BASE_IFACE}" && "\$EVENT" == "up" ]]; then
  sleep 2
  systemctl restart create-uap0
  systemctl restart hostapd
fi
EOF
sudo chmod +x /etc/NetworkManager/dispatcher.d/99-cinemaberry-uap0
success "NetworkManager configured"

# ── 7. Passwordless nmcli for the app ────────────────────────────────────────
section "Sudoers"
info "Granting ${SERVICE_USER} passwordless nmcli access…"
echo "${SERVICE_USER} ALL=(ALL) NOPASSWD: /usr/bin/nmcli" \
  | sudo tee /etc/sudoers.d/cinemaberry-nmcli > /dev/null
sudo chmod 440 /etc/sudoers.d/cinemaberry-nmcli
success "Sudoers entry written"

# ── 8. Virtual AP interface service ──────────────────────────────────────────
section "Virtual AP interface (${AP_IFACE})"
info "Creating create-uap0.service…"
sudo tee /etc/systemd/system/create-uap0.service > /dev/null <<EOF
[Unit]
Description=Create virtual Wi-Fi AP interface (${AP_IFACE})
# Wait for the physical wlan0 device node, not network connectivity
After=sys-subsystem-net-devices-${BASE_IFACE}.device
Before=hostapd.service dnsmasq.service

[Service]
Type=oneshot
RemainAfterExit=yes

# Bring wlan0 up as a bare interface (no network needed)
ExecStartPre=/sbin/ip link set ${BASE_IFACE} up

# Add the virtual AP interface on top of it
ExecStart=/sbin/iw dev ${BASE_IFACE} interface add ${AP_IFACE} type __ap
ExecStartPost=/sbin/ip addr add ${AP_IP}/24 dev ${AP_IFACE}
ExecStartPost=/sbin/ip link set ${AP_IFACE} up

# Clean up on stop
ExecStop=/sbin/ip link set ${AP_IFACE} down
ExecStop=/sbin/iw dev ${AP_IFACE} del

[Install]
WantedBy=multi-user.target
EOF
success "create-uap0.service written"

# ── 9. hostapd ────────────────────────────────────────────────────────────────
section "Hotspot (hostapd)"
info "Writing hostapd configuration…"
sudo tee /etc/hostapd/cinemaberry.conf > /dev/null <<EOF
interface=${AP_IFACE}
driver=nl80211
ssid=${AP_SSID}
hw_mode=g
channel=${AP_CHANNEL}
ieee80211n=1
wmm_enabled=1
auth_algs=1
wpa=2
wpa_passphrase=${AP_PASS}
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
EOF

sudo tee /etc/default/hostapd > /dev/null <<EOF
DAEMON_CONF="/etc/hostapd/cinemaberry.conf"
EOF
success "hostapd configured"

# ── 10. dnsmasq ──────────────────────────────────────────────────────────────
section "DNS / DHCP (dnsmasq)"
info "Writing dnsmasq configuration…"
sudo tee /etc/dnsmasq.d/cinemaberry.conf > /dev/null <<EOF
# Only operate on the hotspot interface
interface=${AP_IFACE}
bind-interfaces

# DHCP pool — 24 h leases
dhcp-range=${AP_DHCP_START},${AP_DHCP_END},24h

# Tell clients: gateway + DNS = us
dhcp-option=option:router,${AP_IP}
dhcp-option=option:dns-server,${AP_IP}

# Custom domain → our IP (the app)
address=/${AP_DOMAIN}/${AP_IP}
# Also catch bare hostname without the TLD
address=/cinema/${AP_IP}

# Don't forward short hostnames to the upstream DNS
domain-needed
bogus-priv
EOF
success "dnsmasq configured"

# ── 11. IP forwarding + NAT ───────────────────────────────────────────────────
section "NAT / IP forwarding"
info "Enabling IP forwarding…"
sudo tee /etc/sysctl.d/99-cinemaberry.conf > /dev/null <<EOF
net.ipv4.ip_forward=1
EOF
sudo sysctl -p /etc/sysctl.d/99-cinemaberry.conf > /dev/null

info "Setting up iptables NAT rules…"
# Flush relevant chains first
sudo iptables -t nat -F POSTROUTING 2>/dev/null || true
sudo iptables -F FORWARD            2>/dev/null || true

# MASQUERADE: outbound traffic from hotspot goes through wlan0
sudo iptables -t nat -A POSTROUTING -o "${BASE_IFACE}" -j MASQUERADE
# Allow forwarding from hotspot → real network
sudo iptables -A FORWARD -i "${AP_IFACE}" -o "${BASE_IFACE}" -j ACCEPT
# Allow established/related traffic back from real network → hotspot
sudo iptables -A FORWARD -i "${BASE_IFACE}" -o "${AP_IFACE}" \
  -m state --state RELATED,ESTABLISHED -j ACCEPT

info "Saving iptables rules (will persist on reboot)…"
sudo netfilter-persistent save
success "NAT configured"

# ── 12. CinemaBerry app service ───────────────────────────────────────────────
section "CinemaBerry service"
info "Writing cinemaberry.service…"
sudo tee /etc/systemd/system/cinemaberry.service > /dev/null <<EOF
[Unit]
Description=CinemaBerry Cinema Experience Creator
After=graphical-session.target network.target create-uap0.service hostapd.service dnsmasq.service
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
Environment=PORT=${APP_PORT}

[Install]
WantedBy=graphical-session.target
EOF
success "cinemaberry.service written"

# ── 13. Enable and start everything ──────────────────────────────────────────
section "Starting services"
sudo systemctl daemon-reload

for svc in create-uap0 hostapd dnsmasq cinemaberry; do
  info "Enabling ${svc}…"
  sudo systemctl enable "$svc"
done

info "Starting create-uap0…"
sudo systemctl restart create-uap0
sleep 2

info "Starting hostapd…"
sudo systemctl restart hostapd

info "Starting dnsmasq…"
sudo systemctl restart dnsmasq

info "Starting cinemaberry app…"
sudo systemctl restart cinemaberry

# ── 14. UFW (if active) ───────────────────────────────────────────────────────
if sudo ufw status 2>/dev/null | grep -q "Status: active"; then
  info "Opening port ${APP_PORT} in ufw…"
  sudo ufw allow "${APP_PORT}/tcp" > /dev/null 2>&1 || true
fi

# ── Service health summary ────────────────────────────────────────────────────
section "Service status"
all_ok=true
for svc in create-uap0 hostapd dnsmasq cinemaberry; do
  state=$(systemctl is-active "$svc" 2>/dev/null || echo "unknown")
  if [[ "$state" == "active" ]]; then
    echo -e "  ${GREEN}●${NC} $svc — active"
  else
    echo -e "  ${RED}●${NC} $svc — ${state}"
    all_ok=false
  fi
done

REAL_IP=$(ip -4 addr show "${BASE_IFACE}" 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' || echo "not connected")

# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "════════════════════════════════════════════════"
if $all_ok; then
  echo -e "${GREEN}${BOLD}✅  CinemaBerry installed and running!${NC}"
else
  echo -e "${YELLOW}${BOLD}⚠️   Installation done, but some services need attention.${NC}"
  echo "    Run: sudo journalctl -u hostapd -f"
fi
echo ""
echo -e "${BOLD}  Hotspot${NC}"
echo "    SSID      →  ${AP_SSID}"
echo "    Password  →  ${AP_PASS}"
echo ""
echo -e "${BOLD}  On a phone connected to ${AP_SSID}:${NC}"
echo "    http://${AP_DOMAIN}         (domain)"
echo "    http://${AP_IP}:${APP_PORT}  (direct IP fallback)"
echo ""
echo -e "${BOLD}  On your real network (${BASE_IFACE}):${NC}"
echo "    http://${REAL_IP}:${APP_PORT}"
echo ""
echo -e "${BOLD}  One manual step required in server.js:${NC}"
echo "    Add this line after you create your Express app:"
echo ""
echo "      require('./wifi-routes')(app);"
echo ""
echo "    Then restart: sudo systemctl restart cinemaberry"
echo ""
echo -e "${BOLD}  Useful commands:${NC}"
echo "    sudo systemctl status cinemaberry"
echo "    sudo systemctl status hostapd"
echo "    sudo journalctl -u cinemaberry -f"
echo "    sudo journalctl -u hostapd -f"
echo "════════════════════════════════════════════════"
