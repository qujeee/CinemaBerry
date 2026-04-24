# 🎬 CinemaBerry

**Cinema Experience Creator for Raspberry Pi**

Turn your Raspberry Pi into a full cinema pre-show system. Build sequences of pre-rolls, commercials, trailers and movies with automatic intermissions — all controlled from a web UI on any device on your network.

---

## Requirements

| Component    | Details                                             |
| ------------ | --------------------------------------------------- |
| Raspberry Pi | 3B+ or newer recommended (Pi 4 ideal)               |
| OS           | Raspberry Pi OS with Desktop (Bullseye or Bookworm) |
| Display      | HDMI TV or monitor connected                        |
| Network      | Pi and control device on same Wi-Fi/LAN             |
| Jellyfin     | Running anywhere on your network                    |

---

## Quick Install

```bash
git clone https://github.com/qujeee/cinemaberry.git
cd cinemaberry
bash install.sh
```

Then open `http://<pi-ip>:3000` on any device.

---

## Manual Setup

```bash
# Install mpv
sudo apt install mpv

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install nodejs

# Install dependencies & start
npm install
npm start
```

---

## First-Time Setup

### 1. Connect Jellyfin

Go to **Settings** and enter:

- **Server URL** — e.g. `http://192.168.1.50:8096`
- **API Key** — create one in Jellyfin → Dashboard → API Keys
- **User ID** — optional, found in Jellyfin → Users (improves results)

Click **Save Settings**, then **Test Connection**.

### 2. Upload Your Content

Go to **Uploads** and add files to each category:

| Category         | Content                                     |
| ---------------- | ------------------------------------------- |
| 🎞 Pre-rolls     | Video bumpers/idents (play before items)    |
| 📺 Commercials   | Ad videos — CinemaBerry picks randomly      |
| 🎥 Trailers      | Movie trailers — CinemaBerry picks randomly |
| 🖼 Welcome Image | Shown on screen when nothing is playing     |
| ☕ Intermission  | Shown during intermission breaks            |

### 3. Build a Sequence

Go to **Sequences** → **New** and add items in order:

Example (matches the default cinema experience):

```
Pre-roll 1        → your opening ident
Commercials Pool  → 2 random from your commercials folder
Pre-roll 2        → second ident
Trailers Pool     → 2 random from your trailers folder
Pre-roll 3        → "Feature Presentation" bumper
Movie             → with auto-intermission at 50%
```

Save the sequence with a name like "Standard Cinema".

### 4. Start a Movie

Go to **Start Movie**:

1. Select your saved sequence
2. Search your Jellyfin library and click a movie
3. Hit **Start Cinema Experience**

---

## Playback Controls (Web UI)

| Control       | Action                   |
| ------------- | ------------------------ |
| ▶/⏸           | Play / Pause             |
| ⏭            | Skip current item        |
| ⏹             | Stop sequence            |
| 🎞            | Trigger intermission now |
| Progress bar  | Click to seek            |
| Volume slider | Adjust volume            |

When paused, the current frame freezes. Use the **🎞 Intermission** button to switch to your intermission image at any time (great for mid-movie toilet breaks).

---

## Sequence Item Types

### Pre-roll

A single video file played in sequence. Use for branded bumpers, studio logos, "please silence your phones" clips, etc.

### Random Pool

Picks N videos at random from a category (Commercials or Trailers). Each time you start a sequence the picks are reshuffled.

### Movie

The main feature. Configure:

- **Auto-intermission** — automatically pauses at 50% (or your chosen %) and shows the intermission image
- Resume from where you left off after intermission

---

## File Support

Video: `.mp4 .mkv .avi .mov .m4v .webm .wmv .flv .ts .m2ts`  
Images: `.jpg .jpeg .png .gif .webp`

---

## Architecture

```
Raspberry Pi
├── mpv          — fullscreen video player (IPC socket control)
├── server.js    — Express + WebSocket server
│   ├── MpvController   — IPC socket wrapper for mpv
│   ├── SequenceEngine  — queue management + intermission logic
│   └── API routes      — config, sequences, uploads, Jellyfin, playback
└── public/      — Web UI (served to your phone/laptop)
```

---

## Troubleshooting

**mpv won't start**  
Make sure a display is connected and X is running: `echo $DISPLAY` should return `:0`

**Jellyfin streams won't play**  
Check your Jellyfin URL doesn't have a trailing slash, and that your Pi can reach the Jellyfin server.

**No sound**  
Run `amixer` to check audio output. You may need to set the HDMI output: `sudo raspi-config` → System → Audio.

**Service won't start**  
Check logs: `sudo journalctl -u cinemaberry -f`

---

## License

MIT
