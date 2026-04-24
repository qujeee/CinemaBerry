"use strict";

// ── State ──────────────────────────────────────────────────────────────────────

const state = {
  playback: { state: "idle", queue: [], currentIndex: -1, currentItem: null },
  position: 0,
  duration: 0,
  volume: 100,
  paused: false,
  sequences: [],
  uploads: {
    prerolls: [],
    commercials: [],
    trailers: [],
    welcome: [],
    intermission: [],
  },
  welcomeImage: "",
  currentUcat: "prerolls",
  selectedSeqId: null,
  selectedMovie: null,
  builderItems: [],
  editingSeqId: null,
  prerollFiles: [],
  intermissionFiles: [],
  builderIntermissionImage: "",
  movieSearchResults: [],
  movieTracks: { audioTracks: [], subtitleTracks: [] },
  selectedAudioTrack: null,
  selectedSubtitleTrack: null,
  audioDevices: [],
  defaultAudioSink: "",
  bluetoothDevices: [],
};

// ── WebSocket ──────────────────────────────────────────────────────────────────

let ws;
function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onmessage = (e) => {
    try {
      const { type, data } = JSON.parse(e.data);
      if (type === "state") handleStateUpdate(data);
      if (type === "position") handlePositionUpdate(data);
    } catch (_) {}
  };

  ws.onclose = () => setTimeout(connectWs, 2000);
}

// ── API helpers ────────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  return res.json();
}
const get = (path) => api("GET", path);
const post = (path, b) => api("POST", path, b);
const put = (path, b) => api("PUT", path, b);
const del = (path) => api("DELETE", path);

// ── Formatting ─────────────────────────────────────────────────────────────────

function fmtTime(sec) {
  if (!sec || isNaN(sec)) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ── Toast ──────────────────────────────────────────────────────────────────────

function toast(msg, type = "") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Tab navigation ─────────────────────────────────────────────────────────────

document.querySelectorAll("nav button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll("nav button")
      .forEach((b) => b.classList.remove("active"));
    document
      .querySelectorAll(".tab-content")
      .forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");

    if (btn.dataset.tab === "start-movie") refreshSmSequences();
    if (btn.dataset.tab === "sequences") refreshSequences();
    if (btn.dataset.tab === "settings") loadSettings();
  });
});

// ── State updates ──────────────────────────────────────────────────────────────

function handleStateUpdate(data) {
  state.playback = data;
  if (data.volume !== undefined) state.volume = data.volume;
  if (data.paused !== undefined) state.paused = data.paused;
  renderNowPlaying();
}

function handlePositionUpdate(data) {
  state.position = data.position || 0;
  state.duration = data.duration || 0;
  renderProgress();
}

// ── Now Playing rendering ──────────────────────────────────────────────────────

function renderNowPlaying() {
  const pb = state.playback;

  // Status dot & badge
  const dot = document.getElementById("statusDot");
  const badge = document.getElementById("npStateBadge");
  dot.className = `status-dot ${pb.state}`;
  badge.className = `np-state-badge badge-${pb.state}`;
  badge.textContent = pb.state.charAt(0).toUpperCase() + pb.state.slice(1);
  document.getElementById("statusText").textContent =
    pb.state === "playing"
      ? "Playing"
      : pb.state === "paused"
        ? "Paused"
        : pb.state === "intermission"
          ? "Intermission"
          : "Idle";

  // Title
  const item = pb.currentItem;
  document.getElementById("npTitle").textContent = item
    ? item.label
    : "Welcome to CinemaBerry";
  document.getElementById("npSubtitle").textContent = item
    ? `Item ${pb.currentIndex + 1} of ${pb.totalItems}`
    : "Start a movie to begin the cinema experience";

  // Play/pause button
  const isPlaying = pb.state === "playing";
  document.getElementById("btnPlayPause").textContent =
    pb.state === "paused" || pb.state === "intermission"
      ? "▶"
      : isPlaying
        ? "⏸"
        : "▶";

  // Progress bar visibility
  document.getElementById("progressWrap").style.display =
    pb.state === "idle" ? "none" : "flex";

  // Queue
  renderQueue(pb.queue);
}

function renderProgress() {
  const pos = state.position || 0;
  const dur = state.duration || 0;
  const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
  document.getElementById("progressFill").style.width = `${pct}%`;
  document.getElementById("timeCurrent").textContent = fmtTime(pos);
  document.getElementById("timeTotal").textContent = fmtTime(dur);
}

function renderQueue(queue) {
  const el = document.getElementById("queueList");
  if (!queue || queue.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">🎬</div><div>No sequence playing</div></div>`;
    document.getElementById("queueCount").textContent = "";
    return;
  }
  document.getElementById("queueCount").textContent = `${queue.length} items`;
  el.innerHTML = queue
    .map((item, i) => {
      const icon =
        item.type === "movie" ? "🎬" : item.type === "preroll" ? "🎞" : "📺";
      const cls = item.active
        ? "active"
        : i < (state.playback.currentIndex || 0)
          ? "done"
          : "";
      return `<div class="queue-item ${cls}">
      <span class="queue-icon">${icon}</span>
      <span class="queue-label">${item.label}</span>
      <span class="queue-type">${item.type}</span>
    </div>`;
    })
    .join("");
}

// ── Playback controls ──────────────────────────────────────────────────────────

document.getElementById("btnPlayPause").addEventListener("click", async () => {
  if (state.playback.state === "intermission") {
    await post("/api/playback/resume");
  } else if (state.playback.state === "playing") {
    await post("/api/playback/intermission");
  }
});

document
  .getElementById("btnPrevious")
  .addEventListener("click", () => post("/api/playback/previous"));

document
  .getElementById("btnSkip")
  .addEventListener("click", () => post("/api/playback/skip"));

// Volume
const volSlider = document.getElementById("volumeSlider");
const volLabel = document.getElementById("volumeLabel");
volSlider.addEventListener("input", () => {
  volLabel.textContent = volSlider.value;
  post("/api/playback/volume", { volume: parseInt(volSlider.value) });
});

// Progress seek
document.getElementById("progressBar").addEventListener("click", (e) => {
  if (state.duration <= 0) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  const seek = Math.floor(pct * state.duration);
  post("/api/playback/seek", { position: seek });
});

// ── Start Movie tab ────────────────────────────────────────────────────────────

async function refreshSmSequences() {
  const seqs = await get("/api/sequences");
  state.sequences = seqs;
  const el = document.getElementById("smSequenceList");
  if (seqs.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><div>No sequences yet — create one in the Sequences tab</div></div>`;
    return;
  }
  el.innerHTML = seqs
    .map(
      (seq) => `
    <div class="seq-card ${state.selectedSeqId === seq.id ? "selected" : ""}"
         data-id="${seq.id}" onclick="selectSequence('${seq.id}')">
      <div style="font-size:20px">${getSeqIcon(seq)}</div>
      <div>
        <div class="seq-name">${esc(seq.name)}</div>
        <div class="seq-meta">${seq.items?.length || 0} items · ${summariseSeq(seq)}</div>
      </div>
      ${state.selectedSeqId === seq.id ? '<span style="margin-left:auto;color:var(--gold)">✓</span>' : ""}
    </div>
  `,
    )
    .join("");
  checkSmReady();
}

function getSeqIcon(seq) {
  const types = (seq.items || []).map((i) => i.type);
  if (types.includes("movie")) return "🎬";
  return "📋";
}

function summariseSeq(seq) {
  const types = (seq.items || []).map((i) =>
    i.type === "preroll"
      ? "Pre-roll"
      : i.type === "random_pool"
        ? `${i.count}×${i.category}`
        : i.type === "movie"
          ? "Movie"
          : i.type,
  );
  return types.join(" → ");
}

function selectSequence(id) {
  state.selectedSeqId = id;
  refreshSmSequences();
  checkSmReady();
}

// Jellyfin search
document
  .getElementById("btnJellyfinSearch")
  .addEventListener("click", doJellyfinSearch);
document.getElementById("jellyfinSearch").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doJellyfinSearch();
});

async function doJellyfinSearch() {
  const q = document.getElementById("jellyfinSearch").value.trim();
  const el = document.getElementById("movieGrid");
  state.movieSearchResults = [];
  el.innerHTML =
    '<div class="empty-state"><div class="spinner" style="margin:0 auto"></div></div>';
  try {
    const movies = await get(`/api/jellyfin/search?q=${encodeURIComponent(q)}`);
    if (movies.error) {
      el.innerHTML = `<div class="empty-state" style="color:var(--danger)">${esc(movies.error)}</div>`;
      return;
    }
    if (movies.length === 0) {
      el.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><div>No results</div></div>`;
      return;
    }

    state.movieSearchResults = movies;

    el.innerHTML = movies
      .map(
        (m) => `
      <div class="movie-card ${state.selectedMovie?.id === m.id ? "selected" : ""}"
           onclick="selectMovieById('${esc(m.id)}', this)">
        ${
          m.thumbUrl
            ? `<img class="movie-thumb" src="${esc(m.thumbUrl)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
            : ""
        }
        <div class="movie-thumb-placeholder" style="${m.thumbUrl ? "display:none" : ""}">🎬</div>
        <div class="movie-info">
          <div class="movie-title">${esc(m.title)}</div>
          <div class="movie-year">${m.year || ""} ${m.duration ? "· " + fmtTime(m.duration) : ""}</div>
        </div>
      </div>
    `,
      )
      .join("");
  } catch (e) {
    el.innerHTML = `<div class="empty-state" style="color:var(--danger)">Search failed — check Jellyfin settings</div>`;
  }
}

async function selectMovieById(id, cardEl) {
  const movie = state.movieSearchResults.find(
    (m) => String(m.id) === String(id),
  );
  if (!movie) return;

  state.selectedMovie = movie;
  state.selectedAudioTrack = null;
  state.selectedSubtitleTrack = null;
  state.movieTracks = { audioTracks: [], subtitleTracks: [] };

  // Refresh grid selection immediately
  document
    .querySelectorAll(".movie-card")
    .forEach((el) => el.classList.remove("selected"));
  if (cardEl) cardEl.classList.add("selected");

  // Show step 3 card early so the user sees feedback
  checkSmReady();

  // Fetch audio & subtitle tracks from Jellyfin
  try {
    const tracks = await get(`/api/jellyfin/tracks/${id}`);
    if (!tracks.error) {
      state.movieTracks = tracks;
      // Pre-select the default audio track
      state.selectedAudioTrack =
        tracks.audioTracks.find((t) => t.isDefault) ||
        tracks.audioTracks[0] ||
        null;
      // Pre-select the default subtitle (none if nothing is marked default)
      state.selectedSubtitleTrack =
        tracks.subtitleTracks.find((t) => t.isDefault) || null;
    }
  } catch (_) {}

  checkSmReady();
}

function checkSmReady() {
  const card = document.getElementById("smStartCard");
  if (state.selectedSeqId && state.selectedMovie) {
    card.style.display = "block";
    const seq = state.sequences.find((s) => s.id === state.selectedSeqId);
    document.getElementById("smSummary").innerHTML =
      `<strong style="color:var(--gold-hi)">${esc(state.selectedMovie.title)}</strong>
       &nbsp;with sequence&nbsp;
       <strong style="color:var(--gold-hi)">${seq ? esc(seq.name) : ""}</strong>`;
    renderTrackSelectors();
  } else {
    card.style.display = "none";
  }
}

function renderTrackSelectors() {
  const wrap = document.getElementById("smTrackSelectors");
  const audioSel = document.getElementById("smAudioTrack");
  const subSel = document.getElementById("smSubtitleTrack");
  if (!wrap || !audioSel || !subSel) return;

  const { audioTracks, subtitleTracks } = state.movieTracks;

  if (audioTracks.length === 0 && subtitleTracks.length === 0) {
    wrap.style.display = "none";
    return;
  }

  wrap.style.display = "block";

  // ── Audio tracks ───────────────────────────────────────────────
  if (audioTracks.length > 0) {
    audioSel.innerHTML = audioTracks
      .map(
        (t) =>
          `<option value="${t.mpvId}">${esc(t.title)}${t.isDefault ? " ★" : ""}</option>`,
      )
      .join("");
    audioSel.value = state.selectedAudioTrack?.mpvId ?? audioTracks[0].mpvId;
    document.getElementById("smAudioRow").style.display = "block";
  } else {
    document.getElementById("smAudioRow").style.display = "none";
  }

  // ── Subtitle tracks ────────────────────────────────────────────
  subSel.innerHTML =
    `<option value="">None (off)</option>` +
    subtitleTracks
      .map(
        (t) =>
          `<option value="${t.mpvId}">${esc(t.title)}${t.isExternal ? " 🌐" : ""}${t.isDefault ? " ★" : ""}</option>`,
      )
      .join("");
  subSel.value = state.selectedSubtitleTrack?.mpvId ?? "";
  document.getElementById("smSubRow").style.display =
    subtitleTracks.length > 0 ? "block" : "none";

  // ── Track selection event handlers ─────────────────────────────
  audioSel.onchange = () => {
    state.selectedAudioTrack =
      audioTracks.find((t) => t.mpvId === parseInt(audioSel.value)) || null;
  };
  subSel.onchange = () => {
    state.selectedSubtitleTrack =
      subtitleTracks.find((t) => t.mpvId === parseInt(subSel.value)) || null;
  };
}

document
  .getElementById("btnStartSequence")
  .addEventListener("click", async () => {
    if (!state.selectedSeqId || !state.selectedMovie) return;
    const btn = document.getElementById("btnStartSequence");
    btn.disabled = true;
    btn.textContent = "Starting…";
    try {
      // Build movie payload, including selected audio/subtitle tracks
      const moviePayload = {
        title: state.selectedMovie.title,
        jellyfinId: state.selectedMovie.id,
        streamUrl: state.selectedMovie.streamUrl,
      };

      if (state.selectedAudioTrack) {
        moviePayload.audioTrackMpvId = state.selectedAudioTrack.mpvId;
      }

      if (state.selectedSubtitleTrack) {
        // External subtitle: stream it via Jellyfin delivery URL
        if (
          state.selectedSubtitleTrack.isExternal &&
          state.selectedSubtitleTrack.deliveryUrl
        ) {
          moviePayload.externalSubUrl = state.selectedSubtitleTrack.deliveryUrl;
        } else {
          moviePayload.subtitleMpvId =
            state.selectedSubtitleTrack.mpvInternalId ||
            state.selectedSubtitleTrack.mpvId;
        }
      } else {
        // "None" chosen — explicitly disable subtitles
        moviePayload.subtitleMpvId = 0;
      }

      const res = await post("/api/playback/start", {
        sequenceId: state.selectedSeqId,
        movie: moviePayload,
      });
      if (res.error) {
        toast(res.error, "error");
      } else {
        toast("🎬 Cinema experience starting!", "success");
        document.querySelector('nav button[data-tab="now-playing"]').click();
      }
    } catch (e) {
      toast("Failed to start", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "🎬 Start Cinema Experience";
    }
  });

// ── Sequences tab ──────────────────────────────────────────────────────────────

async function refreshSequences() {
  const seqs = await get("/api/sequences");
  state.sequences = seqs;
  renderSequenceList(seqs);
}

function renderSequenceList(seqs) {
  const el = document.getElementById("sequenceList");
  if (seqs.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><div>No sequences yet — click New to create one</div></div>`;
    return;
  }
  el.innerHTML = seqs
    .map(
      (seq) => `
    <div class="seq-card">
      <div style="font-size:20px">${getSeqIcon(seq)}</div>
      <div style="flex:1">
        <div class="seq-name">${esc(seq.name)}</div>
        <div class="seq-meta">${seq.items?.length || 0} items · ${summariseSeq(seq)}</div>
      </div>
      <div class="seq-actions">
        <button class="btn btn-ghost btn-icon" onclick="editSequence('${seq.id}')" title="Edit">✏️</button>
        <button class="btn btn-danger btn-icon" onclick="removeSequence('${seq.id}')" title="Delete">🗑</button>
      </div>
    </div>
  `,
    )
    .join("");
}

document
  .getElementById("btnNewSequence")
  .addEventListener("click", () => openBuilder(null));

async function editSequence(id) {
  const seq = await get(`/api/sequences/${id}`);
  openBuilder(seq);
}

async function removeSequence(id) {
  if (!confirm("Delete this sequence?")) return;
  await del(`/api/sequences/${id}`);
  toast("Sequence deleted");
  refreshSequences();
}

// ── Sequence Builder ───────────────────────────────────────────────────────────

async function openBuilder(seq) {
  state.editingSeqId = seq?.id || null;
  state.builderItems = seq?.items ? JSON.parse(JSON.stringify(seq.items)) : [];
  state.builderIntermissionImage = seq?.intermissionImage || "";
  document.getElementById("seqName").value = seq?.name || "";
  document.getElementById("builderTitle").textContent = seq
    ? `Edit: ${seq.name}`
    : "New Sequence";
  document.getElementById("sequenceBuilder").style.display = "block";
  document
    .getElementById("sequenceBuilder")
    .scrollIntoView({ behavior: "smooth" });

  // Load preroll files for dropdowns
  const [prerolls, intermission] = await Promise.all([
    get("/api/uploads/prerolls"),
    get("/api/uploads/intermission"),
  ]);
  state.prerollFiles = prerolls;
  state.intermissionFiles = intermission;

  renderIntermissionSelect();

  renderBuilderItems();
}

function renderIntermissionSelect() {
  const select = document.getElementById("seqIntermissionImage");
  if (!select) return;

  select.innerHTML = [
    `<option value="">Use default (first uploaded intermission image)</option>`,
    ...state.intermissionFiles.map(
      (file) => `<option value="${esc(file.name)}">${esc(file.name)}</option>`,
    ),
  ].join("");

  const exists = state.intermissionFiles.some(
    (file) => file.name === state.builderIntermissionImage,
  );
  select.value = exists ? state.builderIntermissionImage : "";
  state.builderIntermissionImage = select.value;
}

function closeBuilder() {
  document.getElementById("sequenceBuilder").style.display = "none";
  state.editingSeqId = null;
  state.builderItems = [];
}

document
  .getElementById("btnCloseBuilder")
  .addEventListener("click", closeBuilder);
document
  .getElementById("btnCancelBuilder")
  .addEventListener("click", closeBuilder);

document.getElementById("btnAddPreroll").addEventListener("click", () => {
  state.builderItems.push({ type: "preroll", fileId: "", label: "Pre-roll" });
  renderBuilderItems();
});

document.getElementById("btnAddCommercials").addEventListener("click", () => {
  state.builderItems.push({
    type: "random_pool",
    category: "commercials",
    count: 2,
    label: "Commercials",
  });
  renderBuilderItems();
});

document.getElementById("btnAddTrailers").addEventListener("click", () => {
  state.builderItems.push({
    type: "random_pool",
    category: "trailers",
    count: 2,
    label: "Trailers",
  });
  renderBuilderItems();
});

document.getElementById("btnAddMovie").addEventListener("click", () => {
  if (state.builderItems.find((i) => i.type === "movie")) {
    toast("Only one Movie item per sequence", "error");
    return;
  }
  state.builderItems.push({
    type: "movie",
    intermission: { enabled: true, at: 0.5 },
    label: "Movie",
  });
  renderBuilderItems();
});

function renderBuilderItems() {
  const el = document.getElementById("builderItems");
  if (state.builderItems.length === 0) {
    el.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:10px 0">No items yet — add some above</div>`;
    return;
  }

  el.innerHTML = state.builderItems
    .map((item, i) => {
      const icon =
        item.type === "movie" ? "🎬" : item.type === "preroll" ? "🎞" : "📺";
      const typeLabel =
        item.type === "random_pool"
          ? `Random ${item.category === "commercials" ? "Commercials" : "Trailers"} Pool`
          : item.type === "movie"
            ? "Movie"
            : "Pre-roll";

      let controls = "";

      if (item.type === "preroll") {
        const opts = state.prerollFiles
          .map(
            (f) =>
              `<option value="${esc(f.name)}" ${item.fileId === f.name ? "selected" : ""}>${esc(f.name)}</option>`,
          )
          .join("");
        controls = `
        <div class="form-group">
          <label>Pre-roll file</label>
          <select onchange="builderUpdate(${i},'fileId',this.value)">
            <option value="">-- select a pre-roll --</option>
            ${opts}
          </select>
        </div>
        <div class="form-group">
          <label>Label</label>
          <input type="text" value="${esc(item.label || "Pre-roll")}"
                 onchange="builderUpdate(${i},'label',this.value)">
        </div>`;
      } else if (item.type === "random_pool") {
        controls = `
        <div class="form-row">
          <div class="form-group">
            <label>Category</label>
            <select onchange="builderUpdate(${i},'category',this.value)">
              <option value="commercials" ${item.category === "commercials" ? "selected" : ""}>Commercials</option>
              <option value="trailers"    ${item.category === "trailers" ? "selected" : ""}>Trailers</option>
            </select>
          </div>
          <div class="form-group">
            <label>Count (random picks)</label>
            <input type="number" min="1" max="10" value="${item.count || 2}"
                   onchange="builderUpdate(${i},'count',parseInt(this.value))">
          </div>
        </div>
        <div class="form-group">
          <label>Label</label>
          <input type="text" value="${esc(item.label || "")}"
                 onchange="builderUpdate(${i},'label',this.value)">
        </div>`;
      } else if (item.type === "movie") {
        const intvl = item.intermission || {};
        controls = `
        <label class="checkbox-row">
          <input type="checkbox" ${intvl.enabled ? "checked" : ""}
                 onchange="builderUpdateNested(${i},'intermission','enabled',this.checked)">
          Auto-intermission mid-movie
        </label>
        ${
          intvl.enabled
            ? `
        <div class="form-group" style="margin-top:6px">
          <label>Intermission at (% of movie)</label>
          <input type="number" min="1" max="99" value="${Math.round((intvl.at || 0.5) * 100)}"
                 onchange="builderUpdateNested(${i},'intermission','at',parseInt(this.value)/100)">
        </div>`
            : ""
        }`;
      }

      return `
      <div class="builder-item">
        <span class="builder-item-icon">${icon}</span>
        <div class="builder-item-body">
          <div class="builder-item-type">${typeLabel}</div>
          ${controls}
        </div>
        <div class="builder-item-controls">
          ${i > 0 ? `<button class="btn btn-ghost btn-icon" onclick="builderMove(${i},-1)" title="Move up">↑</button>` : ""}
          ${i < state.builderItems.length - 1 ? `<button class="btn btn-ghost btn-icon" onclick="builderMove(${i},1)" title="Move down">↓</button>` : ""}
          <button class="btn btn-danger btn-icon" onclick="builderRemove(${i})" title="Remove">✕</button>
        </div>
      </div>`;
    })
    .join("");
}

function builderUpdate(index, key, value) {
  state.builderItems[index][key] = value;
  // Re-render only if type changed (skip for text inputs to not interrupt typing)
  if (key !== "label" && key !== "fileId") renderBuilderItems();
}

function builderUpdateNested(index, parent, key, value) {
  if (!state.builderItems[index][parent])
    state.builderItems[index][parent] = {};
  state.builderItems[index][parent][key] = value;
  renderBuilderItems();
}

function builderMove(index, dir) {
  const items = state.builderItems;
  const newIdx = index + dir;
  if (newIdx < 0 || newIdx >= items.length) return;
  [items[index], items[newIdx]] = [items[newIdx], items[index]];
  renderBuilderItems();
}

function builderRemove(index) {
  state.builderItems.splice(index, 1);
  renderBuilderItems();
}

document
  .getElementById("btnSaveSequence")
  .addEventListener("click", async () => {
    const name = document.getElementById("seqName").value.trim();
    if (!name) {
      toast("Please enter a sequence name", "error");
      return;
    }
    const seq = {
      name,
      items: state.builderItems,
      intermissionImage: state.builderIntermissionImage || "",
    };
    if (state.editingSeqId) {
      await put(`/api/sequences/${state.editingSeqId}`, seq);
      toast("Sequence updated", "success");
    } else {
      await post("/api/sequences", seq);
      toast("Sequence saved", "success");
    }
    closeBuilder();
    refreshSequences();
  });

document
  .getElementById("seqIntermissionImage")
  .addEventListener("change", (e) => {
    state.builderIntermissionImage = e.target.value || "";
  });

// ── Uploads tab ────────────────────────────────────────────────────────────────

document.querySelectorAll(".upload-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document
      .querySelectorAll(".upload-tab")
      .forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    state.currentUcat = tab.dataset.ucat;
    loadUploads();
  });
});

async function loadUploads() {
  const cat = state.currentUcat;
  const isImg = cat === "welcome" || cat === "intermission";
  const titles = {
    prerolls: "Pre-rolls",
    commercials: "Commercials",
    trailers: "Trailers",
    welcome: "Welcome Image",
    intermission: "Intermission Image",
  };

  document.getElementById("uploadCatTitle").textContent = titles[cat] || cat;
  const hint = document.getElementById("dropHint");
  const inp = document.getElementById("fileInput");
  const prevWrap = document.getElementById("imagePreviewWrap");

  if (isImg) {
    inp.multiple = false;
    inp.accept = "image/*";
    hint.textContent = "JPG, PNG, GIF, WebP";
    document.getElementById("dropLabel").textContent =
      "Drop image here or click to browse";
    document.getElementById("dropIcon").textContent = "🖼";
    prevWrap.style.display = "none";
  } else {
    inp.multiple = true;
    inp.accept = "video/*,.mkv,.ts,.m2ts";
    hint.textContent = "MP4, MKV, AVI, MOV, WebM and more";
    document.getElementById("dropLabel").textContent =
      "Drop video files here or click to browse";
    document.getElementById("dropIcon").textContent = "📂";
    prevWrap.style.display = "none";
  }

  const spinner = document.getElementById("uploadSpinner");
  spinner.style.display = "block";
  try {
    if (cat === "welcome") {
      const cfg = await get("/api/config");
      state.welcomeImage = cfg.welcomeImage || "";
    }
    const files = await get(`/api/uploads/${cat}`);
    renderFileList(files, cat, isImg);
  } finally {
    spinner.style.display = "none";
  }
}

function renderFileList(files, cat, isImg) {
  const el = document.getElementById("uploadFileList");
  const prevWrap = document.getElementById("imagePreviewWrap");
  const prevImg = document.getElementById("imagePreview");
  const pickerWrap = document.getElementById("welcomePickerWrap");

  pickerWrap.style.display = "none";

  if (isImg) {
    if (files.length === 0) {
      prevWrap.style.display = "none";
      el.innerHTML = `<div class="empty-state" style="padding:20px 0">No images uploaded yet</div>`;
      return;
    }

    const selectedName = cat === "welcome" ? state.welcomeImage : "";
    const selectedFile = files.find((f) => f.name === selectedName) || files[0];

    if (files.length > 0) {
      prevImg.src = selectedFile.url + "?t=" + Date.now();
      prevWrap.style.display = "block";
    }

    if (cat === "welcome") {
      renderWelcomePicker(files, selectedFile?.name || "");
    }

    el.innerHTML = files
      .map(
        (f) => `
      <div class="file-item">
        <span style="font-size:18px">🖼</span>
        <span class="file-name">${esc(f.name)}</span>
        <button class="btn btn-danger" onclick="deleteUpload('${cat}','${esc(f.name)}')">Remove</button>
      </div>`,
      )
      .join("");
  } else {
    if (files.length === 0) {
      el.innerHTML = `<div class="empty-state" style="padding:20px 0">No files uploaded yet</div>`;
      return;
    }
    el.innerHTML = files
      .map(
        (f) => `
      <div class="file-item">
        <span style="font-size:18px">🎬</span>
        <span class="file-name">${esc(f.name)}</span>
        <span class="file-size">${fmtSize(f.size)}</span>
        <button class="btn btn-danger btn-icon" onclick="deleteUpload('${cat}','${esc(f.name)}')" title="Delete">🗑</button>
      </div>`,
      )
      .join("");
  }
}

function renderWelcomePicker(files, selectedName) {
  const pickerWrap = document.getElementById("welcomePickerWrap");
  const picker = document.getElementById("welcomeImageSelect");
  const note = document.getElementById("welcomeImageNote");

  pickerWrap.style.display = "block";
  picker.innerHTML = [
    `<option value="">Use the first uploaded image</option>`,
    ...files.map(
      (file) => `<option value="${esc(file.name)}">${esc(file.name)}</option>`,
    ),
  ].join("");

  picker.value = files.some((file) => file.name === selectedName)
    ? selectedName
    : "";
  note.textContent = picker.value
    ? `Currently selected: ${picker.value}`
    : "No specific image selected; the first uploaded image is used at startup.";

  picker.onchange = async () => {
    const welcomeImage = picker.value;
    state.welcomeImage = welcomeImage;
    await post("/api/config", { welcomeImage });
    await refreshWelcomeScreen();
    toast(
      welcomeImage
        ? "Welcome image saved and shown"
        : "Welcome image reset and shown",
      "success",
    );
    loadUploads();
  };
}

async function deleteUpload(cat, name) {
  if (!confirm(`Delete ${name}?`)) return;
  await del(`/api/uploads/${cat}/${encodeURIComponent(name)}`);
  if (cat === "welcome") await refreshWelcomeScreen();
  toast("File deleted");
  loadUploads();
}

async function refreshWelcomeScreen() {
  try {
    const res = await post("/api/playback/show-welcome");
    if (res && res.ok === false && res.reason === "busy") {
      toast("Welcome image saved. It will display when playback is idle.");
    }
  } catch (_) {}
}

// Drop zone
const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");

dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () =>
  dropZone.classList.remove("dragover"),
);
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  uploadFiles(e.dataTransfer.files);
});
fileInput.addEventListener("change", () => uploadFiles(fileInput.files));

async function uploadFiles(files) {
  if (!files || files.length === 0) return;
  const cat = state.currentUcat;
  const isImg = cat === "welcome" || cat === "intermission";
  const spinner = document.getElementById("uploadSpinner");
  spinner.style.display = "block";

  try {
    const fd = new FormData();
    if (isImg) {
      fd.append("file", files[0]);
    } else {
      Array.from(files).forEach((f) => fd.append("files", f));
    }

    const res = await fetch(`/api/uploads/${cat}`, {
      method: "POST",
      body: fd,
    });
    const data = await res.json();
    if (data.error) {
      toast(data.error, "error");
    } else {
      if (cat === "welcome") await refreshWelcomeScreen();
      toast(`Uploaded successfully`, "success");
    }
    loadUploads();
  } catch (e) {
    toast("Upload failed", "error");
  } finally {
    spinner.style.display = "none";
    fileInput.value = "";
  }
}

// ── Settings tab ───────────────────────────────────────────────────────────────

async function loadSettings() {
  const cfg = await get("/api/config");
  document.getElementById("cfgJellyfinUrl").value = cfg.jellyfinUrl || "";
  document.getElementById("cfgApiKey").value = cfg.jellyfinApiKey || "";
  document.getElementById("cfgUserId").value = cfg.jellyfinUserId || "";
  await Promise.all([
    refreshAudioDevices(cfg.audioOutput || ""),
    refreshBluetoothDevices(),
  ]);
}

async function refreshAudioDevices(selectedSink = "") {
  const msg = document.getElementById("audioSettingsMsg");
  const select = document.getElementById("cfgAudioOutput");
  const note = document.getElementById("audioOutputNote");

  const data = await get("/api/audio/devices");
  if (!data.available) {
    select.innerHTML = `<option value="">No audio backend detected</option>`;
    note.textContent =
      "Install and enable PulseAudio/PipeWire to list outputs.";
    msg.textContent = data.error || "Could not read audio devices";
    msg.style.color = "var(--danger)";
    return;
  }

  state.audioDevices = data.sinks || [];
  state.defaultAudioSink = data.defaultSink || "";

  if (state.audioDevices.length === 0) {
    select.innerHTML = `<option value="">No output devices found</option>`;
    note.textContent = "No sinks reported by pactl.";
    return;
  }

  select.innerHTML = state.audioDevices
    .map((sink) => {
      const type = sink.isBluetooth ? "Bluetooth" : "System";
      const status = sink.state ? ` (${sink.state})` : "";
      return `<option value="${esc(sink.name)}">${esc(sink.name)} · ${type}${esc(status)}</option>`;
    })
    .join("");

  const preferred =
    selectedSink || state.defaultAudioSink || state.audioDevices[0]?.name || "";
  const exists = state.audioDevices.some((sink) => sink.name === preferred);
  select.value = exists ? preferred : state.audioDevices[0].name;

  note.textContent = state.defaultAudioSink
    ? `Current default output: ${state.defaultAudioSink}`
    : "No default output reported.";
}

async function refreshBluetoothDevices() {
  const select = document.getElementById("btDeviceSelect");
  const note = document.getElementById("btDeviceNote");
  const msg = document.getElementById("audioSettingsMsg");

  const data = await get("/api/audio/bluetooth/devices");
  if (!data.available) {
    state.bluetoothDevices = [];
    select.innerHTML = `<option value="">Bluetooth unavailable</option>`;
    note.textContent = "Enable Bluetooth service to manage devices.";
    msg.textContent = data.error || "Could not read Bluetooth devices";
    msg.style.color = "var(--danger)";
    return;
  }

  state.bluetoothDevices = data.devices || [];
  if (state.bluetoothDevices.length === 0) {
    select.innerHTML = `<option value="">No Bluetooth devices discovered</option>`;
    note.textContent = "Run a scan to discover nearby devices.";
    return;
  }

  select.innerHTML = state.bluetoothDevices
    .map((dev) => {
      const flags = [
        dev.connected ? "connected" : "disconnected",
        dev.paired ? "paired" : "unpaired",
      ].join(", ");
      return `<option value="${esc(dev.address)}">${esc(dev.name)} · ${esc(dev.address)} (${flags})</option>`;
    })
    .join("");

  const connected = state.bluetoothDevices.find((dev) => dev.connected);
  if (connected) select.value = connected.address;

  note.textContent = connected
    ? `Connected: ${connected.name} (${connected.address})`
    : "No Bluetooth device connected.";
}

document
  .getElementById("btnSaveSettings")
  .addEventListener("click", async () => {
    await post("/api/config", {
      jellyfinUrl: document.getElementById("cfgJellyfinUrl").value.trim(),
      jellyfinApiKey: document.getElementById("cfgApiKey").value.trim(),
      jellyfinUserId: document.getElementById("cfgUserId").value.trim(),
    });
    toast("Settings saved", "success");
  });

document
  .getElementById("btnRefreshAudioDevices")
  .addEventListener("click", async () => {
    await Promise.all([refreshAudioDevices(), refreshBluetoothDevices()]);
    toast("Audio devices refreshed", "success");
  });

document
  .getElementById("btnSaveAudioOutput")
  .addEventListener("click", async () => {
    const msg = document.getElementById("audioSettingsMsg");
    const sink = document.getElementById("cfgAudioOutput").value;
    if (!sink) return;

    msg.textContent = "Applying output…";
    msg.style.color = "var(--muted)";

    const res = await post("/api/audio/output", { sink });
    if (res.error) {
      msg.textContent = "✗ " + res.error;
      msg.style.color = "var(--danger)";
      return;
    }

    msg.textContent = `✓ Output set to ${sink}`;
    msg.style.color = "var(--success)";
    await refreshAudioDevices(sink);
    toast("Audio output updated", "success");
  });

document
  .getElementById("btnScanBluetooth")
  .addEventListener("click", async () => {
    const msg = document.getElementById("audioSettingsMsg");
    msg.textContent = "Scanning for Bluetooth devices (8s)…";
    msg.style.color = "var(--muted)";

    const data = await post("/api/audio/bluetooth/scan", {});
    if (data.error) {
      msg.textContent = "✗ " + data.error;
      msg.style.color = "var(--danger)";
      return;
    }

    await refreshBluetoothDevices();
    msg.textContent = "✓ Scan complete";
    msg.style.color = "var(--success)";
  });

document
  .getElementById("btnConnectBluetooth")
  .addEventListener("click", async () => {
    const msg = document.getElementById("audioSettingsMsg");
    const address = document.getElementById("btDeviceSelect").value;
    if (!address) return;

    msg.textContent = `Connecting to ${address}…`;
    msg.style.color = "var(--muted)";

    const data = await post("/api/audio/bluetooth/connect", { address });
    if (data.error) {
      msg.textContent = "✗ " + data.error;
      msg.style.color = "var(--danger)";
      return;
    }

    await Promise.all([refreshBluetoothDevices(), refreshAudioDevices()]);
    msg.textContent = "✓ Bluetooth device connected";
    msg.style.color = "var(--success)";
    toast("Bluetooth connected", "success");
  });

document
  .getElementById("btnDisconnectBluetooth")
  .addEventListener("click", async () => {
    const msg = document.getElementById("audioSettingsMsg");
    const address = document.getElementById("btDeviceSelect").value;
    if (!address) return;

    msg.textContent = `Disconnecting ${address}…`;
    msg.style.color = "var(--muted)";

    const data = await post("/api/audio/bluetooth/disconnect", { address });
    if (data.error) {
      msg.textContent = "✗ " + data.error;
      msg.style.color = "var(--danger)";
      return;
    }

    await refreshBluetoothDevices();
    msg.textContent = "✓ Bluetooth device disconnected";
    msg.style.color = "var(--success)";
    toast("Bluetooth disconnected", "success");
  });

document
  .getElementById("btnTestJellyfin")
  .addEventListener("click", async () => {
    const msg = document.getElementById("settingsMsg");
    msg.textContent = "Testing…";
    msg.style.color = "var(--muted)";
    try {
      const res = await get("/api/jellyfin/search?q=");
      if (res.error) {
        msg.textContent = "✗ " + res.error;
        msg.style.color = "var(--danger)";
      } else {
        msg.textContent = `✓ Connected — ${res.length} movies found`;
        msg.style.color = "var(--success)";
      }
    } catch (e) {
      msg.textContent = "✗ Connection failed";
      msg.style.color = "var(--danger)";
    }
  });

// ── Misc helpers ───────────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Init ───────────────────────────────────────────────────────────────────────

(async () => {
  connectWs();
  // Load initial playback state
  try {
    const s = await get("/api/playback/state");
    handleStateUpdate(s);
    if (s.position)
      handlePositionUpdate({ position: s.position, duration: s.duration });
    if (s.volume !== null) {
      volSlider.value = s.volume || 100;
      volLabel.textContent = s.volume || 100;
    }
  } catch (_) {}

  // Load uploads on the uploads tab
  loadUploads();
})();
