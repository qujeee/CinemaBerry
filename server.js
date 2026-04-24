"use strict";

const express = require("express");
const multer = require("multer");
const { spawn, exec } = require("child_process");
const net = require("net");
const fs = require("fs");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const { EventEmitter } = require("events");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
const { promisify } = require("util");

// ── Paths & boot-time directories ────────────────────────────────────────────

const BASE_DIR = __dirname;
const UPLOAD_DIR = path.join(BASE_DIR, "uploads");
const SEQUENCES_DIR = path.join(BASE_DIR, "sequences");
const CONFIG_FILE = path.join(BASE_DIR, "config.json");
const MPV_SOCKET = "/tmp/mpvsocket";
const execAsync = promisify(exec);

["prerolls", "commercials", "trailers", "welcome", "intermission"].forEach(
  (c) => fs.mkdirSync(path.join(UPLOAD_DIR, c), { recursive: true }),
);
fs.mkdirSync(SEQUENCES_DIR, { recursive: true });

// ── Config ───────────────────────────────────────────────────────────────────

let config = {
  jellyfinUrl: "",
  jellyfinApiKey: "",
  jellyfinUserId: "",
  welcomeImage: "",
  audioOutput: "",
  port: 3000,
};
if (fs.existsSync(CONFIG_FILE)) {
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) };
  } catch (_) {}
}
const saveConfig = () =>
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isVideo = (f) => /\.(mp4|mkv|avi|mov|m4v|webm|wmv|flv|ts|m2ts)$/i.test(f);
const isImage = (f) => /\.(jpg|jpeg|png|gif|webp)$/i.test(f);
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

async function runCmd(command) {
  try {
    const { stdout, stderr } = await execAsync(command, { timeout: 15000 });
    return { ok: true, stdout: stdout || "", stderr: stderr || "" };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || error.message || "",
      code: error.code,
    };
  }
}

function parsePactlSinks(pactlShortOutput) {
  return pactlShortOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      const id = parts[0] || "";
      const name = parts[1] || "";
      const driver = parts[2] || "";
      const state = parts[parts.length - 1] || "";
      return {
        id,
        name,
        driver,
        state,
        isBluetooth:
          /bluez|bluetooth/i.test(name) || /bluez|bluetooth/i.test(driver),
      };
    });
}

function parseBluetoothDevices(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("Device "))
    .map((line) => {
      const match = line.match(/^Device\s+([0-9A-F:]{17})\s+(.+)$/i);
      if (!match) return null;
      return { address: match[1], name: match[2] || match[1] };
    })
    .filter(Boolean);
}

function parseBluetoothInfoFlags(infoOutput) {
  const connected = /Connected:\s+yes/i.test(infoOutput);
  const paired = /Paired:\s+yes/i.test(infoOutput);
  const trusted = /Trusted:\s+yes/i.test(infoOutput);
  const blocked = /Blocked:\s+yes/i.test(infoOutput);
  return { connected, paired, trusted, blocked };
}

const SINK_NAME_RE = /^[A-Za-z0-9._:-]+$/;
const BT_ADDRESS_RE = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/i;

async function listAudioDevices() {
  const sinksRes = await runCmd("pactl list short sinks");
  if (!sinksRes.ok) {
    return {
      available: false,
      error: "Could not query audio sinks via pactl",
      details: sinksRes.stderr,
      sinks: [],
      defaultSink: "",
    };
  }

  const infoRes = await runCmd("pactl info");
  const defaultMatch = (infoRes.stdout || "").match(/^Default Sink:\s+(.+)$/m);
  const defaultSink = defaultMatch ? defaultMatch[1].trim() : "";

  return {
    available: true,
    sinks: parsePactlSinks(sinksRes.stdout),
    defaultSink,
  };
}

async function listBluetoothDevices() {
  const devicesRes = await runCmd("bluetoothctl devices");
  if (!devicesRes.ok) {
    return {
      available: false,
      error: "Could not query Bluetooth devices via bluetoothctl",
      details: devicesRes.stderr,
      devices: [],
    };
  }

  const baseDevices = parseBluetoothDevices(devicesRes.stdout);
  const detailed = await Promise.all(
    baseDevices.map(async (dev) => {
      const infoRes = await runCmd(`bluetoothctl info ${dev.address}`);
      const flags = infoRes.ok
        ? parseBluetoothInfoFlags(infoRes.stdout)
        : { connected: false, paired: false, trusted: false, blocked: false };
      return { ...dev, ...flags };
    }),
  );

  return { available: true, devices: detailed };
}

async function setDefaultSink(sinkName) {
  if (!SINK_NAME_RE.test(sinkName)) {
    return { ok: false, error: "Invalid sink name" };
  }

  const setRes = await runCmd(`pactl set-default-sink ${sinkName}`);
  if (!setRes.ok) {
    return {
      ok: false,
      error: "Failed to set default sink",
      details: setRes.stderr,
    };
  }

  const inputsRes = await runCmd("pactl list short sink-inputs");
  if (inputsRes.ok) {
    const inputIds = inputsRes.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[0])
      .filter(Boolean);

    await Promise.all(
      inputIds.map((id) => runCmd(`pactl move-sink-input ${id} ${sinkName}`)),
    );
  }

  config.audioOutput = sinkName;
  saveConfig();
  return { ok: true };
}

async function tryAutoSwitchToBluetoothSink(btAddress) {
  const devices = await listAudioDevices();
  if (!devices.available) return;
  const normalized = btAddress.toLowerCase().replace(/:/g, "_");
  const sink = devices.sinks.find((s) =>
    s.name.toLowerCase().includes(normalized),
  );
  if (!sink) return;
  await setDefaultSink(sink.name);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function formatTime(sec) {
  if (!sec || isNaN(sec)) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function withJellyfinSubStreamFallback(url) {
  if (!url || typeof url !== "string") return null;
  if (!/\/Subtitles\/\d+\/Stream\.[^/?]+/i.test(url)) return null;
  if (/\/Subtitles\/\d+\/0\/Stream\./i.test(url)) return null;
  return url.replace(/(\/Subtitles\/\d+)(\/Stream\.[^/?]+)/i, "$1/0$2");
}

// ── MPV Controller ────────────────────────────────────────────────────────────

class MpvController extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.requestId = 0;
    this.pending = new Map();
    this.buffer = "";
    this.process = null;
    this.connected = false;
    this._reconnTimer = null;
  }

  start() {
    return new Promise((resolve) => {
      exec('pkill -f "mpv.*mpvsocket"', () => {
        setTimeout(() => {
          const args = [
            `--input-ipc-server=${MPV_SOCKET}`,
            "--idle=yes",
            "--force-window=yes",
            "--fullscreen=yes",
            "--really-quiet",
            "--no-terminal",
            "--image-display-duration=inf",
            "--loop-file=no",
            "--keep-open=no",
            "--hwdec=auto",
            "--vo=drm", // <-- ADDED: Force Direct Rendering Manager for CLI
          ];

          this.process = spawn("mpv", args, {
            // REMOVED: DISPLAY variable injection. Let mpv figure it out via DRM.
            env: { ...process.env },
            stdio: "ignore",
          });

          this.process.on("error", (err) => {
            console.warn(`[mpv] Failed to spawn: ${err.message}`);
            console.warn("      Is mpv installed?  sudo apt install mpv");
            resolve(); // continue anyway — web UI still works
          });
          this.process.on("exit", (code) => {
            this.connected = false;
            console.log(`[mpv] exited (code ${code})`);
          });
          setTimeout(() => {
            this._connect();
            setTimeout(resolve, 600);
          }, 1500);
        }, 500);
      });
    });
  }

  _connect() {
    if (this._reconnTimer) clearTimeout(this._reconnTimer);
    const sock = net.createConnection(MPV_SOCKET);
    this.socket = sock;

    sock.on("connect", () => {
      this.connected = true;
      this.buffer = "";
      console.log("[mpv] IPC connected");
      this.emit("connected");
    });

    sock.on("data", (chunk) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.event) {
            this.emit("mpv-event", msg);
          } else if (msg.request_id !== undefined) {
            const cb = this.pending.get(msg.request_id);
            if (cb) {
              this.pending.delete(msg.request_id);
              cb(msg);
            }
          }
        } catch (_) {}
      }
    });

    const reconnect = () => {
      this.connected = false;
      this._reconnTimer = setTimeout(() => this._connect(), 1500);
    };
    sock.on("error", reconnect);
    sock.on("close", reconnect);
  }

  cmd(...args) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.socket) {
        reject(new Error("mpv not connected"));
        return;
      }
      const id = ++this.requestId;
      const msg = JSON.stringify({ command: args, request_id: id }) + "\n";
      this.pending.set(id, resolve);
      this.socket.write(msg, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("Timeout"));
        }
      }, 6000);
    });
  }

  async cmdOk(...args) {
    const res = await this.cmd(...args);
    if (res?.error && res.error !== "success") {
      throw new Error(res.error);
    }
    return res;
  }

  async getProp(prop) {
    try {
      return (await this.cmd("get_property", prop)).data;
    } catch (_) {
      return null;
    }
  }
  async setProp(prop, value) {
    try {
      return await this.cmd("set_property", prop, value);
    } catch (_) {}
  }
  async loadFile(fp, mode, options) {
    try {
      const loadMode = mode || "replace";
      const runLoadFile = async (args) => {
        const res = await this.cmd(...args);
        if (res?.error && res.error !== "success") {
          throw new Error(res.error);
        }
        return res;
      };

      const baseArgs = ["loadfile", fp, loadMode];
      if (!options) {
        return await runLoadFile(baseArgs);
      }

      // Newer mpv expects an insertion index before per-file options.
      try {
        return await runLoadFile([...baseArgs, -1, options]);
      } catch (_) {
        // Fallback for older mpv variants that accept options directly.
        return await runLoadFile([...baseArgs, options]);
      }
    } catch (e) {
      console.warn("[mpv] loadfile error:", e.message);
    }
  }
  async pause() {
    await this.setProp("pause", true);
  }
  async resume() {
    await this.setProp("pause", false);
  }
  async stop() {
    try {
      await this.cmd("stop");
    } catch (_) {}
  }
  async setVolume(v) {
    await this.setProp("volume", Math.max(0, Math.min(100, v)));
  }
  async seek(s) {
    try {
      await this.cmd("seek", s, "absolute");
    } catch (_) {}
  }

  async showImage(imagePath) {
    await this.loadFile(imagePath);
  }

  async showWelcome() {
    const dir = path.join(UPLOAD_DIR, "welcome");
    const files = fs.readdirSync(dir).filter(isImage);
    const selected =
      config.welcomeImage && files.includes(config.welcomeImage)
        ? config.welcomeImage
        : files[0];
    if (selected) {
      await this.loadFile(path.join(dir, selected));
    } else {
      // Show nothing / keep idle black screen
      try {
        await this.cmd("stop");
      } catch (_) {}
    }
  }

  async showIntermission(preferredImage) {
    const dir = path.join(UPLOAD_DIR, "intermission");
    const files = fs.readdirSync(dir).filter(isImage);
    if (files.length > 0) {
      const selected =
        preferredImage && files.includes(preferredImage)
          ? preferredImage
          : files[0];
      await this.loadFile(path.join(dir, selected));
    } else {
      await this.pause();
    }
  }
}

// ── Sequence Engine ───────────────────────────────────────────────────────────

class SequenceEngine extends EventEmitter {
  constructor(mpv) {
    super();
    this.mpv = mpv;
    this.queue = [];
    this.currentIndex = -1;
    this.currentItem = null;
    this.state = "idle"; // idle | playing | paused | intermission
    this.volume = 100;
    this.posTimer = null;
    this.intermissionDone = false;
    this.savedMoviePos = 0;
    this.movieFilePath = null;
    this.movieDuration = 0;
    this._ignoreEof = false; // suppress eof during controlled transitions
    this.intermissionImage = "";
    this.movieAudioOptions = ""; // mpv options string (e.g. "aid=2,sid=3")
    this.movieExternalSubUrl = null; // external subtitle URL to add via sub-add

    mpv.on("mpv-event", (e) => this._onMpvEvent(e));
  }

  // ── Sequence resolution ──────────────────────────────────────────────────

  resolveSequence(template, movie) {
    const items = [];
    for (const item of template.items) {
      switch (item.type) {
        case "preroll": {
          const fp = path.join(UPLOAD_DIR, "prerolls", item.fileId);
          if (item.fileId && fs.existsSync(fp))
            items.push({
              type: "video",
              label: item.label || "Pre-roll",
              filePath: fp,
            });
          break;
        }

        case "random_pool": {
          const dir = path.join(UPLOAD_DIR, item.category);
          const pool = fs.readdirSync(dir).filter(isVideo);
          const picks = shuffle(pool).slice(0, item.count || 1);
          picks.forEach((f, i) =>
            items.push({
              type: "video",
              label: `${capitalize(item.category)} ${i + 1}`,
              filePath: path.join(dir, f),
            }),
          );
          break;
        }

        case "movie": {
          if (!movie) break;
          items.push({
            type: "movie",
            label: movie.title,
            filePath: movie.streamUrl,
            jellyfinId: movie.jellyfinId,
            intermission: item.intermission || { enabled: false, at: 0.5 },
            audioTrackMpvId: movie.audioTrackMpvId || null,
            subtitleMpvId:
              movie.subtitleMpvId != null ? movie.subtitleMpvId : null,
            externalSubUrl: movie.externalSubUrl || null,
          });
          break;
        }
      }
    }
    return items;
  }

  // ── Start a sequence ─────────────────────────────────────────────────────

  async start(template, movie) {
    this._stopPosTimer();
    this.queue = this.resolveSequence(template, movie);
    this.intermissionImage = template?.intermissionImage || "";
    this.currentIndex = -1;
    this.state = "playing";
    this.emit("state-change", this._snapshot());
    await this._next();
  }

  async _next() {
    this.currentIndex++;
    if (this.currentIndex >= this.queue.length) {
      await this._finish();
      return;
    }

    this.currentItem = this.queue[this.currentIndex];
    this.intermissionDone = false;
    this.savedMoviePos = 0;
    this.movieDuration = 0;
    this.movieFilePath = this.currentItem.filePath;

    if (this.currentItem.type === "movie") {
      this._startPosTimer();
    }

    // Build mpv loadfile options for audio/subtitle track selection
    let mpvOptions = "";
    let externalSubUrl = null;
    if (this.currentItem.type === "movie") {
      const parts = [];
      if (this.currentItem.audioTrackMpvId) {
        parts.push(`aid=${this.currentItem.audioTrackMpvId}`);
      }
      if (this.currentItem.externalSubUrl) {
        // External sub will be added via sub-add after load; disable internal subs
        externalSubUrl = this.currentItem.externalSubUrl;
        parts.push("sid=no");
      } else if (this.currentItem.subtitleMpvId) {
        parts.push(`sid=${this.currentItem.subtitleMpvId}`);
      } else if (this.currentItem.subtitleMpvId === 0) {
        parts.push("sid=no");
      }
      mpvOptions = parts.join(",");
      this.movieAudioOptions = mpvOptions;
      this.movieExternalSubUrl = externalSubUrl;
    }

    this._ignoreEof = false;
    await this.mpv.loadFile(
      this.currentItem.filePath,
      "replace",
      mpvOptions || undefined,
    );
    await this.mpv.resume();

    // Attach external subtitle after mpv has started loading the file
    if (externalSubUrl) {
      await sleep(1500);
      try {
        await this.mpv.cmdOk("sub-add", externalSubUrl, "select");
        await this.mpv.setProp("sub-visibility", true);
        console.log(`[engine] External subtitle loaded: ${externalSubUrl}`);
      } catch (e) {
        const fallbackUrl = withJellyfinSubStreamFallback(externalSubUrl);
        if (fallbackUrl) {
          try {
            await this.mpv.cmdOk("sub-add", fallbackUrl, "select");
            await this.mpv.setProp("sub-visibility", true);
            this.movieExternalSubUrl = fallbackUrl;
            console.log(
              `[engine] External subtitle loaded via fallback URL: ${fallbackUrl}`,
            );
          } catch (fallbackErr) {
            console.warn(
              "[engine] Could not load external subtitle:",
              `${e.message} | fallback failed: ${fallbackErr.message}`,
            );
          }
        } else {
          console.warn("[engine] Could not load external subtitle:", e.message);
        }
      }
    }

    this.state = "playing";
    this.emit("state-change", this._snapshot());
    console.log(`[engine] Playing: ${this.currentItem.label}`);
  }

  // ── Intermission ─────────────────────────────────────────────────────────

  _startPosTimer() {
    this._stopPosTimer();
    this.posTimer = setInterval(() => this._checkPosition(), 1000);
  }

  _stopPosTimer() {
    if (this.posTimer) {
      clearInterval(this.posTimer);
      this.posTimer = null;
    }
  }

  async _checkPosition() {
    if (this.state !== "playing" || this.currentItem?.type !== "movie") return;
    const pos = await this.mpv.getProp("time-pos");
    const dur = await this.mpv.getProp("duration");
    if (pos === null || dur === null || dur <= 0) return;
    if (!this.movieDuration) this.movieDuration = dur;

    this.emit("position", { position: pos, duration: dur });

    const intvl = this.currentItem.intermission;
    if (
      !this.intermissionDone &&
      intvl?.enabled &&
      pos >= dur * (intvl.at || 0.5)
    ) {
      this.savedMoviePos = pos;
      await this._triggerIntermission();
    }
  }

  async _triggerIntermission() {
    this._stopPosTimer();
    this.intermissionDone = true;
    this._ignoreEof = true;
    this.state = "intermission";
    await this.mpv.showIntermission(this.intermissionImage);
    this._ignoreEof = false;
    this.emit("state-change", this._snapshot());
    console.log(`[engine] Intermission at ${formatTime(this.savedMoviePos)}`);
  }

  async triggerManualIntermission() {
    if (this.state !== "playing") return;
    this.savedMoviePos = (await this.mpv.getProp("time-pos")) || 0;
    await this._triggerIntermission();
  }

  async resumeFromIntermission() {
    if (this.state !== "intermission") return;
    this._ignoreEof = true;
    this.state = "playing";

    if (this.movieFilePath) {
      console.log(this.movieFilePath);
      const rewindPos = Math.max(0, this.savedMoviePos - 30);
      await this.mpv.loadFile(
        this.movieFilePath,
        "replace",
        this.movieAudioOptions || undefined,
      );
      await this.mpv.resume();
      await sleep(800);
      await this.mpv.seek(rewindPos);

      // Re-attach external subtitle after seek stabilises
      if (this.movieExternalSubUrl) {
        await sleep(700);
        try {
          await this.mpv.cmdOk("sub-add", this.movieExternalSubUrl, "select");
          await this.mpv.setProp("sub-visibility", true);
          await sleep(200);
          await this.mpv.seek(rewindPos); // re-seek so position is accurate after sub load
        } catch (e) {
          const fallbackUrl = withJellyfinSubStreamFallback(
            this.movieExternalSubUrl,
          );
          if (fallbackUrl) {
            try {
              await this.mpv.cmdOk("sub-add", fallbackUrl, "select");
              await this.mpv.setProp("sub-visibility", true);
              this.movieExternalSubUrl = fallbackUrl;
              await sleep(200);
              await this.mpv.seek(rewindPos);
            } catch (fallbackErr) {
              console.warn(
                "[engine] Could not re-add external subtitle:",
                `${e.message} | fallback failed: ${fallbackErr.message}`,
              );
            }
          } else {
            console.warn(
              "[engine] Could not re-add external subtitle:",
              e.message,
            );
          }
        }
      }

      this._startPosTimer();
    } else {
      await this.mpv.resume();
    }

    this._ignoreEof = false;
    this.emit("state-change", this._snapshot());
  }

  // ── Transport controls ───────────────────────────────────────────────────

  async pause() {
    if (this.state !== "playing") return;
    this.state = "paused";
    await this.mpv.pause();
    this.emit("state-change", this._snapshot());
  }

  async resume() {
    if (this.state === "paused") {
      this.state = "playing";
      await this.mpv.resume();
      this.emit("state-change", this._snapshot());
    } else if (this.state === "intermission") {
      await this.resumeFromIntermission();
    }
  }

  async skip() {
    this._stopPosTimer();
    this._ignoreEof = true;
    await this._next();
    this._ignoreEof = false;
  }

  async previous() {
    if (!this.queue.length || this.state === "idle") return;

    this._stopPosTimer();
    this._ignoreEof = true;

    if (this.currentIndex > 0) {
      this.currentIndex -= 2;
    } else {
      this.currentIndex = -1;
    }

    await this._next();
    this._ignoreEof = false;
  }

  async stop() {
    this._stopPosTimer();
    this._ignoreEof = true;
    this.queue = [];
    this.currentIndex = -1;
    this.currentItem = null;
    this.state = "idle";
    await this.mpv.showWelcome();
    this._ignoreEof = false;
    this.emit("state-change", this._snapshot());
  }

  async seek(seconds) {
    if (this.state === "playing" || this.state === "paused") {
      await this.mpv.seek(seconds);
    }
  }

  async setVolume(v) {
    this.volume = Math.max(0, Math.min(100, v));
    await this.mpv.setVolume(this.volume);
  }

  // ── mpv event handler ────────────────────────────────────────────────────

  async _onMpvEvent(event) {
    if (event.event !== "end-file") return;
    if (event.reason !== "eof") return; // 'replaced', 'stopped' etc → ignore
    if (this._ignoreEof) return;
    if (this.state === "intermission") return;

    if (this.state === "playing") {
      if (this.currentItem?.type === "movie") {
        await this._finish();
      } else {
        await this._next();
      }
    }
  }

  async _finish() {
    this._stopPosTimer();
    this.state = "idle";
    this.currentItem = null;
    await this.mpv.showWelcome();
    this.emit("state-change", this._snapshot());
    console.log("[engine] Sequence finished");
  }

  // ── State snapshot ───────────────────────────────────────────────────────

  _snapshot() {
    return {
      state: this.state,
      currentItem: this.currentItem,
      currentIndex: this.currentIndex,
      totalItems: this.queue.length,
      volume: this.volume,
      queue: this.queue.map((item, i) => ({
        label: item.label,
        type: item.type,
        active: i === this.currentIndex,
      })),
    };
  }

  getStatus() {
    return this._snapshot();
  }
}

// ── Sequence persistence ──────────────────────────────────────────────────────

const listSequences = () =>
  fs
    .readdirSync(SEQUENCES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(SEQUENCES_DIR, f), "utf8"));
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);

const getSequence = (id) => {
  const fp = path.join(SEQUENCES_DIR, `${id}.json`);
  return fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, "utf8")) : null;
};

const saveSequence = (seq) => {
  if (!seq.id) seq.id = uuidv4();
  seq.updatedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(SEQUENCES_DIR, `${seq.id}.json`),
    JSON.stringify(seq, null, 2),
  );
  return seq;
};

const deleteSequence = (id) => {
  const fp = path.join(SEQUENCES_DIR, `${id}.json`);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
};

// ── Jellyfin helpers ──────────────────────────────────────────────────────────

async function jellyfinSearch(query) {
  if (!config.jellyfinUrl || !config.jellyfinApiKey)
    throw new Error("Jellyfin not configured");
  const params = {
    searchTerm: query,
    IncludeItemTypes: "Movie",
    api_key: config.jellyfinApiKey,
    Recursive: true,
    Fields: "Overview,RunTimeTicks",
    ImageTypeLimit: 1,
    EnableImages: true,
  };
  if (config.jellyfinUserId) params.UserId = config.jellyfinUserId;
  const res = await axios.get(`${config.jellyfinUrl}/Items`, {
    params,
    timeout: 10000,
  });
  return res.data.Items || [];
}

const jellyfinStreamUrl = (id) =>
  `${config.jellyfinUrl}/Videos/${id}/stream?api_key=${config.jellyfinApiKey}&static=true`;

const jellyfinThumbUrl = (id) =>
  `${config.jellyfinUrl}/Items/${id}/Images/Primary?api_key=${config.jellyfinApiKey}&maxWidth=300`;

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
// require("./wifi-routes")(app);
app.use(express.json());
app.use(express.static(path.join(BASE_DIR, "public")));
app.use("/uploads", express.static(UPLOAD_DIR));

// Multer factories
const videoFilter = (_, file, cb) => cb(null, isVideo(file.originalname));
const imageFilter = (_, file, cb) => cb(null, isImage(file.originalname));
const diskStore = (cat) =>
  multer.diskStorage({
    destination: (_, __, cb) => cb(null, path.join(UPLOAD_DIR, cat)),
    filename: (_, file, cb) => cb(null, file.originalname),
  });

// ── Routes: Config ────────────────────────────────────────────────────────────

app.get("/api/config", (_req, res) => res.json(config));
app.post("/api/config", (req, res) => {
  const {
    jellyfinUrl,
    jellyfinApiKey,
    jellyfinUserId,
    welcomeImage,
    audioOutput,
  } = req.body;
  if (jellyfinUrl !== undefined)
    config.jellyfinUrl = jellyfinUrl.replace(/\/$/, "");
  if (jellyfinApiKey !== undefined) config.jellyfinApiKey = jellyfinApiKey;
  if (jellyfinUserId !== undefined) config.jellyfinUserId = jellyfinUserId;
  if (welcomeImage !== undefined) config.welcomeImage = welcomeImage;
  if (audioOutput !== undefined) config.audioOutput = audioOutput;
  saveConfig();
  res.json({ ok: true });
});

// ── Routes: Audio output & Bluetooth ─────────────────────────────────────────

app.get("/api/audio/devices", async (_req, res) => {
  const data = await listAudioDevices();
  res.json(data);
});

app.post("/api/audio/output", async (req, res) => {
  const sinkName = String(req.body?.sink || "").trim();
  if (!sinkName) return res.status(400).json({ error: "Missing sink" });

  const result = await setDefaultSink(sinkName);
  if (!result.ok) return res.status(400).json(result);
  res.json({ ok: true, selected: sinkName });
});

app.get("/api/audio/bluetooth/devices", async (_req, res) => {
  const data = await listBluetoothDevices();
  res.json(data);
});

app.post("/api/audio/bluetooth/scan", async (_req, res) => {
  await runCmd("bluetoothctl scan on");
  await sleep(8000);
  await runCmd("bluetoothctl scan off");
  const data = await listBluetoothDevices();
  res.json(data);
});

app.post("/api/audio/bluetooth/connect", async (req, res) => {
  const address = String(req.body?.address || "").trim();
  if (!BT_ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: "Invalid Bluetooth address" });
  }

  await runCmd("bluetoothctl power on");
  await runCmd("bluetoothctl agent on");
  await runCmd("bluetoothctl default-agent");
  await runCmd(`bluetoothctl trust ${address}`);
  await runCmd(`bluetoothctl pair ${address}`);
  const connectRes = await runCmd(`bluetoothctl connect ${address}`);

  if (!connectRes.ok) {
    return res.status(400).json({
      error: "Failed to connect Bluetooth device",
      details: connectRes.stderr,
    });
  }

  // Give PulseAudio/PipeWire a moment to create the Bluetooth sink.
  await sleep(1200);
  await tryAutoSwitchToBluetoothSink(address);

  const devices = await listBluetoothDevices();
  res.json({ ok: true, devices: devices.devices || [] });
});

app.post("/api/audio/bluetooth/disconnect", async (req, res) => {
  const address = String(req.body?.address || "").trim();
  if (!BT_ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: "Invalid Bluetooth address" });
  }

  const disconnectRes = await runCmd(`bluetoothctl disconnect ${address}`);
  if (!disconnectRes.ok) {
    return res.status(400).json({
      error: "Failed to disconnect Bluetooth device",
      details: disconnectRes.stderr,
    });
  }

  const devices = await listBluetoothDevices();
  res.json({ ok: true, devices: devices.devices || [] });
});

// ── Routes: Sequences ─────────────────────────────────────────────────────────

app.get("/api/sequences", (_, res) => res.json(listSequences()));
app.get("/api/sequences/:id", (req, res) => {
  const s = getSequence(req.params.id);
  s ? res.json(s) : res.status(404).json({ error: "Not found" });
});
app.post("/api/sequences", (req, res) => res.json(saveSequence(req.body)));
app.put("/api/sequences/:id", (req, res) =>
  res.json(saveSequence({ ...req.body, id: req.params.id })),
);
app.delete("/api/sequences/:id", (req, res) => {
  deleteSequence(req.params.id);
  res.json({ ok: true });
});

// ── Routes: Uploads (video categories) ───────────────────────────────────────

["prerolls", "commercials", "trailers"].forEach((cat) => {
  const upload = multer({
    storage: diskStore(cat),
    fileFilter: videoFilter,
    limits: { fileSize: 10 * 1024 * 1024 * 1024 },
  });

  app.get(`/api/uploads/${cat}`, (_, res) => {
    const dir = path.join(UPLOAD_DIR, cat);
    const files = fs
      .readdirSync(dir)
      .filter(isVideo)
      .map((f) => ({
        name: f,
        size: fs.statSync(path.join(dir, f)).size,
        url: `/uploads/${cat}/${f}`,
      }));
    res.json(files);
  });

  app.post(`/api/uploads/${cat}`, upload.array("files"), (req, res) =>
    res.json({ uploaded: (req.files || []).map((f) => f.originalname) }),
  );

  app.delete(`/api/uploads/${cat}/:filename`, (req, res) => {
    const fp = path.join(UPLOAD_DIR, cat, req.params.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    res.json({ ok: true });
  });
});

// ── Routes: Uploads (image categories) ───────────────────────────────────────

["welcome", "intermission"].forEach((cat) => {
  const upload = multer({
    storage: diskStore(cat),
    fileFilter: imageFilter,
    limits: { fileSize: 50 * 1024 * 1024 },
  });

  app.get(`/api/uploads/${cat}`, (_, res) => {
    const dir = path.join(UPLOAD_DIR, cat);
    const files = fs
      .readdirSync(dir)
      .filter(isImage)
      .map((f) => ({
        name: f,
        url: `/uploads/${cat}/${f}`,
      }));
    res.json(files);
  });

  app.post(`/api/uploads/${cat}`, upload.single("file"), (req, res) => {
    if (!req.file)
      return res.status(400).json({ error: "No valid image uploaded" });
    if (cat === "welcome" && !config.welcomeImage) {
      // Default to the first explicit selection once a welcome image exists.
      config.welcomeImage = req.file.originalname;
      saveConfig();
    }
    res.json({ uploaded: req.file.originalname });
  });

  app.delete(`/api/uploads/${cat}/:filename`, (req, res) => {
    const fp = path.join(UPLOAD_DIR, cat, req.params.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);

    if (cat === "welcome" && config.welcomeImage === req.params.filename) {
      config.welcomeImage = "";
      saveConfig();
    }

    res.json({ ok: true });
  });
});

// ── Routes: Jellyfin ──────────────────────────────────────────────────────────

app.get("/api/jellyfin/search", async (req, res) => {
  try {
    const items = await jellyfinSearch(req.query.q || "");
    res.json(
      items.map((item) => ({
        id: item.Id,
        title: item.Name,
        year: item.ProductionYear,
        overview: item.Overview,
        duration: item.RunTimeTicks
          ? Math.round(item.RunTimeTicks / 10000000)
          : null,
        thumbUrl: jellyfinThumbUrl(item.Id),
        streamUrl: jellyfinStreamUrl(item.Id),
      })),
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/jellyfin/tracks/:id", async (req, res) => {
  try {
    if (!config.jellyfinUrl || !config.jellyfinApiKey)
      return res.status(400).json({ error: "Jellyfin not configured" });

    const params = { api_key: config.jellyfinApiKey, Fields: "MediaStreams" };
    if (config.jellyfinUserId) params.UserId = config.jellyfinUserId;

    const response = await axios.get(
      `${config.jellyfinUrl}/Items/${req.params.id}`,
      { params, timeout: 10000 },
    );

    const streams = response.data.MediaStreams || [];
    const mediaSourceId = response.data.MediaSources?.[0]?.Id || "";

    const mapSubtitleCodecToExt = (codec) => {
      const c = String(codec || "").toLowerCase();
      if (c === "subrip" || c === "srt") return "srt";
      if (c === "webvtt" || c === "vtt") return "vtt";
      if (c === "ass") return "ass";
      if (c === "ssa") return "ssa";
      if (c === "pgssub" || c === "sup") return "sup";
      return "srt";
    };

    const buildFallbackSubtitleUrl = (streamIndex, codec) => {
      if (!mediaSourceId) return null;
      const ext = mapSubtitleCodecToExt(codec);
      const base = `${config.jellyfinUrl}/Videos/${req.params.id}/${encodeURIComponent(mediaSourceId)}/Subtitles/${streamIndex}`;
      const q = `api_key=${encodeURIComponent(config.jellyfinApiKey)}`;

      // Use the primary path first; the /0/ path is a compatibility fallback.
      return `${base}/Stream.${ext}?${q}`;
    };

    let audioIdx = 0;
    let subIdx = 0;
    let internalSubMpvIdx = 0;
    const audioTracks = [];
    const subtitleTracks = [];

    for (const s of streams) {
      if (s.Type === "Audio") {
        audioIdx++;
        audioTracks.push({
          index: s.Index,
          mpvId: audioIdx,
          language: s.Language || "",
          title: s.DisplayTitle || s.Title || `Audio ${audioIdx}`,
          isDefault: s.IsDefault || false,
          codec: s.Codec || "",
        });
      } else if (s.Type === "Subtitle") {
        subIdx++;
        const isExternal = s.IsExternal || false;
        if (!isExternal) {
          internalSubMpvIdx++;
        }
        // Build the full delivery URL for external (non-muxed) subtitles
        let deliveryUrl = null;
        if (isExternal && s.DeliveryUrl) {
          const sep = s.DeliveryUrl.includes("?") ? "&" : "?";
          deliveryUrl = `${config.jellyfinUrl}${s.DeliveryUrl}${sep}api_key=${config.jellyfinApiKey}`;
        } else if (isExternal) {
          deliveryUrl = buildFallbackSubtitleUrl(s.Index, s.Codec);
        }
        subtitleTracks.push({
          index: s.Index,
          mpvId: subIdx,
          mpvInternalId: isExternal ? null : internalSubMpvIdx,
          language: s.Language || "",
          title: s.DisplayTitle || s.Title || `Subtitle ${subIdx}`,
          isDefault: s.IsDefault || false,
          isExternal,
          isForced: s.IsForced || false,
          deliveryUrl,
          codec: s.Codec || "",
        });
      }
    }

    console.log(
      `[jellyfin] Tracks for ${req.params.id}: audio=${audioTracks.length}, subtitles=${subtitleTracks.length}, externalSubtitles=${subtitleTracks.filter((t) => t.isExternal).length}, externalWithUrl=${subtitleTracks.filter((t) => t.isExternal && t.deliveryUrl).length}`,
    );

    res.json({ audioTracks, subtitleTracks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Routes: Playback ──────────────────────────────────────────────────────────

app.get("/api/playback/state", async (_, res) => {
  const snap = engine.getStatus();
  const [pos, dur, vol, paused] = await Promise.all([
    mpv.getProp("time-pos"),
    mpv.getProp("duration"),
    mpv.getProp("volume"),
    mpv.getProp("pause"),
  ]);
  res.json({ ...snap, position: pos, duration: dur, volume: vol, paused });
});

app.post("/api/playback/start", async (req, res) => {
  try {
    const { sequenceId, movie } = req.body;
    console.log(
      `[playback] Start request: sequenceId=${sequenceId || "(none)"}, movieId=${movie?.jellyfinId || "(none)"}, audioTrackMpvId=${movie?.audioTrackMpvId ?? "(default)"}, subtitleMpvId=${movie?.subtitleMpvId ?? "(none)"}, hasExternalSubUrl=${Boolean(movie?.externalSubUrl)}`,
    );
    if (movie?.externalSubUrl) {
      console.log(`[playback] External subtitle URL: ${movie.externalSubUrl}`);
    }
    const template = getSequence(sequenceId);
    if (!template) return res.status(404).json({ error: "Sequence not found" });
    await engine.start(template, movie);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/playback/pause", async (_, res) => {
  await engine.pause();
  res.json({ ok: true });
});
app.post("/api/playback/resume", async (_, res) => {
  await engine.resume();
  res.json({ ok: true });
});
app.post("/api/playback/stop", async (_, res) => {
  await engine.stop();
  res.json({ ok: true });
});
app.post("/api/playback/skip", async (_, res) => {
  await engine.skip();
  res.json({ ok: true });
});
app.post("/api/playback/previous", async (_, res) => {
  await engine.previous();
  res.json({ ok: true });
});
app.post("/api/playback/intermission", async (_, res) => {
  await engine.triggerManualIntermission();
  res.json({ ok: true });
});
app.post("/api/playback/seek", async (req, res) => {
  await engine.seek(parseFloat(req.body.position));
  res.json({ ok: true });
});
app.post("/api/playback/volume", async (req, res) => {
  await engine.setVolume(parseInt(req.body.volume));
  res.json({ ok: true });
});
app.post("/api/playback/show-welcome", async (_, res) => {
  try {
    if (engine.state !== "idle") {
      return res.json({ ok: false, reason: "busy" });
    }
    await mpv.showWelcome();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const broadcast = (type, data) => {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
};

wss.on("connection", async (ws) => {
  const snap = engine.getStatus();
  const [pos, dur, vol] = await Promise.all([
    mpv.getProp("time-pos"),
    mpv.getProp("duration"),
    mpv.getProp("volume"),
  ]);
  ws.send(
    JSON.stringify({
      type: "state",
      data: { ...snap, position: pos, duration: dur, volume: vol || 100 },
    }),
  );
});

// Position ticks to all connected clients
setInterval(async () => {
  if (wss.clients.size === 0 || engine.state !== "playing") return;
  const [pos, dur] = await Promise.all([
    mpv.getProp("time-pos"),
    mpv.getProp("duration"),
  ]);
  if (pos !== null) broadcast("position", { position: pos, duration: dur });
}, 1000);

// ── Wire engine events → WebSocket ────────────────────────────────────────────

const mpv = new MpvController();
const engine = new SequenceEngine(mpv);

engine.on("state-change", (snap) => broadcast("state", snap));
engine.on("position", (posData) => broadcast("position", posData));

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🎬 CinemaBerry starting…");
  try {
    await mpv.start();
    await sleep(500);

    if (config.audioOutput) {
      const setRes = await setDefaultSink(config.audioOutput);
      if (!setRes.ok) {
        console.warn(
          `[audio] Could not restore configured output (${config.audioOutput}): ${setRes.details || setRes.error}`,
        );
      }
    }

    await mpv.showWelcome();
    console.log("[mpv] Ready");
  } catch (e) {
    console.warn("[mpv] Could not start mpv:", e.message);
    console.warn("      Continuing without playback (web UI still available)");
  }

  const port = config.port || 3000;
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE")
      console.error(`[server] Port ${port} already in use.`);
    else console.error("[server] Error:", err);
  });
  server.listen(port, "0.0.0.0", () =>
    console.log(`🍿 CinemaBerry running → http://0.0.0.0:${port}`),
  );
}

main().catch(console.error);
