/* ============ All One Radio — app logic ============ */
(function () {
  "use strict";

  const STATIONS = (window.STATIONS || []).slice();
  const N = STATIONS.length;
  const $ = (id) => document.getElementById(id);

  /* ---------- persistent state ---------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  let favs = new Set(store.get("aor.favs", []));
  let recents = store.get("aor.recents", []).filter((id) => STATIONS.some((s) => s.id === id));
  let volume = Math.min(100, Math.max(0, store.get("aor.vol", 70)));
  let muted = store.get("aor.mute", false);

  /* ---------- audio elements (CORS + plain) ---------- */
  const aCors = new Audio();
  aCors.crossOrigin = "anonymous";
  aCors.preload = "none";
  const aPlain = new Audio();
  aPlain.preload = "none";

  let actx = null, analyser = null, srcNode = null, freqData = null;
  function ensureGraph() {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      try {
        actx = new AC();
        srcNode = actx.createMediaElementSource(aCors);
        analyser = actx.createAnalyser();
        analyser.fftSize = 64;
        analyser.smoothingTimeConstant = 0.75;
        srcNode.connect(analyser);
        analyser.connect(actx.destination);
        freqData = new Uint8Array(analyser.frequencyBinCount);
      } catch { actx = null; return false; }
    }
    if (actx.state === "suspended") actx.resume().catch(() => {});
    return true;
  }

  /* ---------- runtime state ---------- */
  const state = {
    idx: -1,        // current station index
    wantPlay: false,
    playing: false,
    loading: false,
    everPlayed: false,
    srcs: [], srcI: 0, stage: "cors",   // stage: cors | plain
    timer: null, watchdog: null,
    skipStreak: 0,
    visual: "fake",  // real | fake
    dragging: false, previewIdx: -1,
  };

  const cur = () => (state.idx >= 0 ? STATIONS[state.idx] : null);
  const activeEl = () => (state.stage === "cors" ? aCors : aPlain);

  const els = {
    dial: $("dialWindow"), scale: $("dialScale"), labels: $("dialLabels"), needle: $("needle"),
    freq: $("freqReadout"), lampPower: $("lampPower"), lampSignal: $("lampSignal"), lampAir: $("lampAir"),
    npName: $("npName"), npGenre: $("npGenre"), npStatus: $("npStatus"),
    npLogo: $("npLogo"), npFallback: $("npFallback"),
    play: $("btnPlay"), playLabel: $("playLabel"),
    fav: $("btnFav"), mute: $("btnMute"), grid: $("grid"), empty: $("empty"),
    search: $("search"), tabs: $("tabs"), presets: $("presetStrip"),
    cntAll: $("cntAll"), cntFav: $("cntFav"), cntRecent: $("cntRecent"), libCount: $("libCount"),
    needleL: $("needleL"), needleR: $("needleR"),
    vuTicks: document.querySelectorAll(".vu-ticks"),
    knob: $("volKnob"), knobPointer: $("knobPointer"), volValue: $("volValue"),
  };

  /* ---------- helpers ---------- */
  const freqOf = (i) => (N <= 1 ? 88.0 : 88.0 + (i * 19.9) / (N - 1));
  const pctOf = (i) => (N <= 1 ? 50 : (i * 100) / (N - 1));
  const initials = (name) =>
    name.replace(/[^A-Za-z0-9\u0B80-\u0BFF ]/g, " ").trim().split(/\s+/).slice(0, 2)
      .map((w) => w[0]).join("").toUpperCase() || "FM";
  const hueOf = (id) => parseInt(String(id).slice(0, 4), 16) % 360;
  const tileBg = (id) => {
    const h = hueOf(id);
    return `linear-gradient(135deg, hsl(${h} 45% 34%), hsl(${(h + 40) % 360} 55% 16%))`;
  };

  function status(text, isErr) {
    els.npStatus.textContent = text;
    els.npStatus.classList.toggle("err", !!isErr);
  }

  /* ---------- dial construction ---------- */
  function buildDial() {
    const frag = document.createDocumentFragment();
    for (let mhz = 88; mhz <= 108; mhz++) {
      for (let d = 0; d < 10; d++) {
        const v = mhz + d / 10;
        if (v > 108) break;
        const t = document.createElement("div");
        const major = d === 0;
        t.className = "tick " + (major ? "major" : "minor");
        t.style.left = (((v - 88) / 20) * 100).toFixed(3) + "%";
        if (major) t.style.bottom = "34px";
        frag.appendChild(t);
      }
    }
    els.scale.appendChild(frag);

    const lf = document.createDocumentFragment();
    for (let mhz = 88; mhz <= 108; mhz += 2) {
      const l = document.createElement("div");
      l.className = "dl";
      l.style.left = (((mhz - 88) / 20) * 100).toFixed(3) + "%";
      l.textContent = mhz;
      lf.appendChild(l);
    }
    els.labels.appendChild(lf);

    // VU meter tick marks
    els.vuTicks.forEach((g) => {
      let s = "";
      for (let i = 0; i <= 10; i++) {
        const a = (-48 + (i * 96) / 10) * (Math.PI / 180);
        const r1 = i % 5 === 0 ? 42 : 46, r2 = 52;
        const x1 = 60 + r1 * Math.sin(a), y1 = 64 - r1 * Math.cos(a);
        const x2 = 60 + r2 * Math.sin(a), y2 = 64 - r2 * Math.cos(a);
        s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
      }
      g.innerHTML = s;
    });
  }

  function setNeedle(previewIdx) {
    const i = previewIdx >= 0 ? previewIdx : state.idx;
    if (i < 0) return;
    els.needle.style.left = pctOf(i).toFixed(3) + "%";
    els.dial.setAttribute("aria-valuenow", String(i + 1));
    if (previewIdx >= 0) els.freq.textContent = freqOf(i).toFixed(1);
  }

  /* ---------- now playing ---------- */
  function renderNowPlaying() {
    const st = cur();
    if (!st) return;
    els.npName.innerHTML = `<span class="np-marquee"></span>`;
    els.npName.firstChild.textContent = st.name;
    els.npName.classList.toggle("scroll", els.npName.scrollWidth > els.npName.clientWidth + 4);
    els.npGenre.textContent = st.genre || "TAMIL FM";
    els.freq.textContent = freqOf(state.idx).toFixed(1);
    setNeedle();

    const hasImg = !!st.img;
    els.npLogo.hidden = !hasImg;
    els.npFallback.hidden = hasImg;
    if (hasImg) { els.npLogo.src = st.img; els.npLogo.alt = st.name; }
    els.npFallback.textContent = initials(st.name);
    els.npFallback.style.background = tileBg(st.id);

    els.fav.textContent = favs.has(st.id) ? "★" : "☆";
    els.fav.classList.toggle("on", favs.has(st.id));
    document.title = `${st.name} · All One Radio`;
  }

  /* ---------- playback engine ---------- */
  function clearTimers() {
    clearTimeout(state.watchdog);
    state.watchdog = null;
  }

  function stopAudio() {
    clearTimers();
    [aCors, aPlain].forEach((a) => {
      try { a.pause(); } catch { /* ignore */ }
      a.removeAttribute("src");
      try { a.load(); } catch { /* ignore */ }
    });
    state.playing = false;
    state.loading = false;
  }

  function onStreamError() {
    clearTimers();
    // stage progression: cors -> plain -> next source
    if (state.stage === "cors") {
      state.stage = "plain";
      loadCurrent();
      return;
    }
    state.srcI++;
    if (state.srcI < state.srcs.length) {
      state.stage = "cors";
      loadCurrent();
      return;
    }
    // exhausted
    state.loading = false;
    state.playing = false;
    status("OFF AIR", true);
    els.lampAir.classList.remove("on");
    els.lampAir.classList.add("err");
    els.lampSignal.classList.remove("on");
    updatePlayUI();
    if (state.wantPlay && state.skipStreak < 3) {
      state.skipStreak++;
      setTimeout(() => { if (state.wantPlay && !state.playing && !state.loading) stepStation(1, true, false); }, 1600);
    }
  }

  function loadCurrent() {
    const st = cur();
    if (!st || !state.srcs.length) return;
    const el = state.stage === "cors" ? aCors : aPlain;
    const other = state.stage === "cors" ? aPlain : aCors;
    try { other.pause(); } catch { /* ignore */ }

    if (state.stage === "cors") ensureGraph();
    state.visual = state.stage === "cors" && actx ? "real" : "fake";

    el.src = state.srcs[state.srcI];
    el.volume = volume / 100;
    el.muted = muted;
    state.loading = true;
    status(state.stage === "cors" ? "TUNING…" : "RETRY…");

    const p = el.play();
    if (p && p.catch) p.catch((err) => {
      if (err && err.name === "NotAllowedError") {
        state.loading = false;
        status("PRESS PLAY", true);
        state.wantPlay = false;
        updatePlayUI();
      } else if (err && err.name !== "AbortError") onStreamError();
    });

    clearTimers();
    state.watchdog = setTimeout(() => { if (state.loading) onStreamError(); }, 7000);
  }

  function startPlay() {
    const st = cur();
    if (!st) return;
    state.wantPlay = true;
    state.srcs = [st.stream, st.stream2].filter(Boolean);
    state.srcI = 0;
    state.stage = "cors";
    loadCurrent();
    updatePlayUI();
  }

  function pausePlay() {
    state.wantPlay = false;
    stopAudio();
    status("PAUSED");
    els.lampSignal.classList.remove("on");
    els.lampAir.classList.remove("on");
    els.lampAir.classList.add("err");
    updatePlayUI();
  }

  function updatePlayUI() {
    const on = state.wantPlay && (state.playing || state.loading);
    els.play.classList.toggle("on", on);
    els.playLabel.textContent = state.playing ? "STOP" : on ? "LOAD" : "PLAY";
    els.dial.classList.toggle("live", state.playing);
  }

  function selectStation(i, autoplay, byUser) {
    if (!N) return;
    i = ((i % N) + N) % N;
    const changed = i !== state.idx;
    if (byUser !== false) state.skipStreak = 0;
    if (changed) {
      stopAudio();
      state.idx = i;
      pushRecent(STATIONS[i].id);
      store.set("aor.last", STATIONS[i].id);
      renderNowPlaying();
      renderGrid();
      renderPresets();
      if (!state.playing) status("STANDBY");
      els.lampAir.classList.remove("err");
    }
    if (autoplay) startPlay();
    else if (!state.wantPlay) updatePlayUI();
  }

  function stepStation(dir, autoplay, byUser) {
    if (!N) return;
    if (state.idx < 0) return selectStation(dir > 0 ? 0 : N - 1, autoplay !== undefined ? autoplay : state.wantPlay, byUser);
    selectStation(state.idx + dir, autoplay !== undefined ? autoplay : state.wantPlay, byUser);
  }

  function togglePlay() {
    if (state.playing || state.loading) pausePlay();
    else if (state.idx < 0) selectStation(0, true, true);
    else startPlay();
  }

  /* audio element events */
  function wireAudio(a) {
    a.addEventListener("playing", () => {
      if (a !== activeEl()) return;
      clearTimers();
      state.playing = true;
      state.loading = false;
      state.everPlayed = true;
      state.skipStreak = 0;
      status("PLAYING");
      els.lampSignal.classList.add("on");
      els.lampAir.classList.remove("err");
      els.lampAir.classList.add("on");
      updatePlayUI();
      renderGrid();
      renderPresets();
    });
    a.addEventListener("waiting", () => { if (a === activeEl() && state.playing) status("BUFFERING"); });
    a.addEventListener("error", () => {
      // ignore errors from the inactive element or a cleared (stopped) element
      if (a !== activeEl() || !a.getAttribute("src")) return;
      onStreamError();
    });
    a.addEventListener("stalled", () => { if (a === activeEl() && state.playing) status("BUFFERING"); });
  }
  wireAudio(aCors);
  wireAudio(aPlain);

  /* ---------- favorites / recents ---------- */
  function toggleFav(id) {
    if (favs.has(id)) favs.delete(id); else favs.add(id);
    store.set("aor.favs", [...favs]);
    const st = cur();
    if (st && st.id === id) {
      els.fav.textContent = favs.has(id) ? "★" : "☆";
      els.fav.classList.toggle("on", favs.has(id));
    }
    renderGrid();
    renderPresets();
    updateCounts();
  }

  function pushRecent(id) {
    recents = [id, ...recents.filter((x) => x !== id)].slice(0, 40);
    store.set("aor.recents", recents);
    updateCounts();
  }

  /* ---------- library grid ---------- */
  let activeTab = "all", query = "";

  function filtered() {
    let list = STATIONS;
    if (activeTab === "fav") list = list.filter((s) => favs.has(s.id));
    else if (activeTab === "recent") {
      list = recents.map((id) => STATIONS.find((s) => s.id === id)).filter(Boolean);
    }
    if (query) {
      const q = query.toLowerCase();
      list = list.filter((s) => s.name.toLowerCase().includes(q) || (s.genre || "").toLowerCase().includes(q));
    }
    return list;
  }

  function renderGrid() {
    const list = filtered();
    els.empty.hidden = list.length > 0;
    els.libCount.textContent = list.length + " STATION" + (list.length === 1 ? "" : "S");

    const curId = cur() ? cur().id : null;
    const frag = document.createDocumentFragment();
    list.forEach((s) => {
      const idx = STATIONS.indexOf(s);
      const card = document.createElement("div");
      card.className = "st-card" + (s.id === curId && state.playing ? " playing" : "");
      card.dataset.id = s.id;
      card.dataset.idx = idx;

      const logo = document.createElement("div");
      logo.className = "st-logo";
      logo.style.background = tileBg(s.id);
      if (s.img) {
        const im = document.createElement("img");
        im.loading = "lazy";
        im.src = s.img;
        im.alt = "";
        im.addEventListener("error", () => { im.remove(); logo.textContent = initials(s.name); });
        logo.appendChild(im);
      } else logo.textContent = initials(s.name);

      const info = document.createElement("div");
      info.className = "st-info";
      const nm = document.createElement("div");
      nm.className = "st-name";
      nm.textContent = s.name;
      const gr = document.createElement("div");
      gr.className = "st-genre";
      gr.textContent = (s.genre || "TAMIL FM") + " · " + freqOf(idx).toFixed(1) + " MHz";
      info.append(nm, gr);

      const fav = document.createElement("button");
      fav.className = "st-fav" + (favs.has(s.id) ? " on" : "");
      fav.textContent = favs.has(s.id) ? "★" : "☆";
      fav.title = "Favorite";
      fav.addEventListener("click", (e) => { e.stopPropagation(); toggleFav(s.id); });

      const eq = document.createElement("div");
      eq.className = "st-eq";
      eq.innerHTML = "<i></i><i></i><i></i>";

      card.append(logo, info, fav, eq);
      card.addEventListener("click", () => {
        if (s.id === curId && (state.playing || state.loading)) pausePlay();
        else selectStation(idx, true, true);
      });
      frag.appendChild(card);
    });
    els.grid.replaceChildren(frag);
  }

  function updateCounts() {
    els.cntAll.textContent = N;
    els.cntFav.textContent = favs.size;
    els.cntRecent.textContent = recents.length;
  }

  /* ---------- presets ---------- */
  function presetList() {
    const ids = [...favs].filter((id) => STATIONS.some((s) => s.id === id)).slice(0, 12);
    for (const s of STATIONS) {
      if (ids.length >= 12) break;
      if (!ids.includes(s.id)) ids.push(s.id);
    }
    return ids.map((id) => STATIONS.findIndex((s) => s.id === id)).filter((i) => i >= 0);
  }

  function renderPresets() {
    const idxs = presetList();
    const frag = document.createDocumentFragment();
    idxs.forEach((i, n) => {
      const st = STATIONS[i];
      const b = document.createElement("button");
      b.className = "preset" + (i === state.idx ? " playing" : "");
      const small = document.createElement("small");
      small.textContent = "P" + (n + 1) + " · " + freqOf(i).toFixed(1);
      const nm = document.createElement("span");
      nm.textContent = st.name;
      b.append(nm, small);
      b.title = st.name;
      b.addEventListener("click", () => selectStation(i, true, true));
      frag.appendChild(b);
    });
    els.presets.replaceChildren(frag);
  }

  /* ---------- dial interaction ---------- */
  let dragTuneTimer = null;
  function idxFromX(clientX) {
    const r = els.dial.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return Math.round(p * (N - 1));
  }

  els.dial.addEventListener("pointerdown", (e) => {
    if (!N) return;
    state.dragging = true;
    els.dial.classList.add("dragging");
    els.dial.setPointerCapture(e.pointerId);
    state.previewIdx = idxFromX(e.clientX);
    setNeedle(state.previewIdx);
    els.npName.firstChild && (els.npName.firstChild.textContent = STATIONS[state.previewIdx].name);
  });
  els.dial.addEventListener("pointermove", (e) => {
    if (!state.dragging) return;
    state.previewIdx = idxFromX(e.clientX);
    setNeedle(state.previewIdx);
    const nm = els.npName.querySelector(".np-marquee");
    if (nm) nm.textContent = STATIONS[state.previewIdx].name;
    // live tuning: switch stations while dragging (only if user is in listen mode)
    if (state.wantPlay) {
      clearTimeout(dragTuneTimer);
      dragTuneTimer = setTimeout(() => {
        if (state.dragging && state.previewIdx >= 0 && state.previewIdx !== state.idx)
          selectStation(state.previewIdx, true, false);
      }, 260);
    }
  });
  function endDrag(e) {
    if (!state.dragging) return;
    state.dragging = false;
    clearTimeout(dragTuneTimer);
    els.dial.classList.remove("dragging");
    try { els.dial.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    const i = state.previewIdx >= 0 ? state.previewIdx : state.idx;
    state.previewIdx = -1;
    if (i === state.idx) {
      if (state.wantPlay && !state.playing && !state.loading) startPlay();
      return;
    }
    selectStation(i, state.wantPlay, true);
  }
  els.dial.addEventListener("pointerup", endDrag);
  els.dial.addEventListener("pointercancel", endDrag);
  els.dial.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { stepStation(-1); e.preventDefault(); e.stopPropagation(); }
    if (e.key === "ArrowRight") { stepStation(1); e.preventDefault(); e.stopPropagation(); }
  });

  /* ---------- volume knob ---------- */
  function renderVolume() {
    const angle = -140 + (volume / 100) * 280;
    els.knob.style.setProperty("--knob-angle", angle.toFixed(1) + "deg");
    els.volValue.textContent = muted ? "MUTE" : String(Math.round(volume));
    aCors.volume = aPlain.volume = volume / 100;
    aCors.muted = aPlain.muted = muted;
  }

  let knobDrag = null;
  els.knob.addEventListener("pointerdown", (e) => {
    knobDrag = { y: e.clientY, v: volume };
    els.knob.classList.add("dragging");
    els.knob.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  els.knob.addEventListener("pointermove", (e) => {
    if (!knobDrag) return;
    volume = Math.min(100, Math.max(0, knobDrag.v + (knobDrag.y - e.clientY) * 0.7));
    if (muted && volume > 0) muted = false;
    store.set("aor.vol", Math.round(volume));
    store.set("aor.mute", muted);
    renderVolume();
    renderMuteBtn();
  });
  ["pointerup", "pointercancel"].forEach((ev) =>
    els.knob.addEventListener(ev, (e) => {
      knobDrag = null;
      els.knob.classList.remove("dragging");
      try { els.knob.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    })
  );
  els.knob.addEventListener("wheel", (e) => {
    e.preventDefault();
    volume = Math.min(100, Math.max(0, volume + (e.deltaY < 0 ? 4 : -4)));
    store.set("aor.vol", Math.round(volume));
    renderVolume();
  }, { passive: false });

  function renderMuteBtn() {
    els.mute.classList.toggle("btn-mute-on", muted);
    els.mute.textContent = muted ? "UNMUTE" : "MUTE";
  }

  /* ---------- controls ---------- */
  els.play.addEventListener("click", togglePlay);
  $("btnPrev").addEventListener("click", () => stepStation(-1));
  $("btnNext").addEventListener("click", () => stepStation(1));
  els.mute.addEventListener("click", () => { muted = !muted; store.set("aor.mute", muted); renderVolume(); renderMuteBtn(); });
  els.fav.addEventListener("click", () => { const st = cur(); if (st) toggleFav(st.id); });

  /* ---------- share ---------- */
  const shareMenu = $("shareMenu");
  function sharePayload() {
    const st = cur();
    if (!st) return null;
    const url = st.slug ? `https://www.tamilradios.com/${st.slug}` : "";
    const line = `♪ Listening to ${st.name} (${freqOf(state.idx).toFixed(1)} MHz) on All One Radio`;
    return { url, text: url ? `${line} — ${url}` : line };
  }
  $("btnShare").addEventListener("click", (e) => {
    e.stopPropagation();
    const p = sharePayload();
    if (!p) return;
    const st = cur();
    $("shWhatsApp").href = `https://wa.me/?text=${encodeURIComponent(p.text)}`;
    $("shTelegram").href = `https://t.me/share/url?url=${encodeURIComponent(p.url || location.href)}&text=${encodeURIComponent("♪ " + st.name + " on All One Radio")}`;
    $("shX").href = `https://x.com/intent/post?text=${encodeURIComponent(p.text)}`;
    shareMenu.hidden = !shareMenu.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!shareMenu.hidden && !e.target.closest(".share-zone")) shareMenu.hidden = true;
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") shareMenu.hidden = true; });
  $("shCopy").addEventListener("click", async (e) => {
    e.stopPropagation();
    const p = sharePayload();
    if (!p) return;
    const text = p.url || p.text;
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      ta.remove();
    }
    const btn = $("shCopy");
    btn.textContent = "COPIED!";
    setTimeout(() => { btn.textContent = "Copy link"; }, 1400);
  });

  /* ---------- search + tabs ---------- */
  els.search.addEventListener("input", () => { query = els.search.value.trim(); renderGrid(); });
  els.tabs.addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (!b) return;
    activeTab = b.dataset.tab;
    els.tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === b));
    renderGrid();
  });

  /* ---------- keyboard ---------- */
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    // let native activation handle Space/Enter on focused buttons (avoids double toggle)
    if (t && t.tagName === "BUTTON" && (e.key === " " || e.key === "Enter")) return;
    switch (e.key) {
      case " ":
        e.preventDefault();
        togglePlay();
        break;
      case "ArrowUp": e.preventDefault(); volume = Math.min(100, volume + 5); store.set("aor.vol", Math.round(volume)); renderVolume(); break;
      case "ArrowDown": e.preventDefault(); volume = Math.max(0, volume - 5); store.set("aor.vol", Math.round(volume)); renderVolume(); break;
      case "ArrowRight": e.preventDefault(); stepStation(1); break;
      case "ArrowLeft": e.preventDefault(); stepStation(-1); break;
      case "m": case "M": muted = !muted; store.set("aor.mute", muted); renderVolume(); renderMuteBtn(); break;
      case "s": case "S": { const st = cur(); if (st) toggleFav(st.id); break; }
    }
  });

  /* ---------- VU / visualizer loop ---------- */
  const needles = { l: -48, r: -48 };
  function targetLevels() {
    if (state.visual === "real" && analyser && state.playing) {
      analyser.getByteFrequencyData(freqData);
      let l = 0, r = 0;
      const half = Math.floor(freqData.length / 2);
      for (let i = 0; i < half; i++) l += freqData[i];
      for (let i = half; i < freqData.length; i++) r += freqData[i];
      l = l / half / 255; r = r / half / 255;
      return [-48 + l * 96, -48 + r * 96];
    }
    if (state.playing) {
      const t = performance.now() / 1000;
      const l = 0.35 + 0.3 * Math.sin(t * 5.1) + 0.15 * Math.sin(t * 11.7);
      const r = 0.35 + 0.3 * Math.sin(t * 4.6 + 1.2) + 0.15 * Math.sin(t * 10.3);
      return [-48 + Math.max(0, Math.min(1, l)) * 96, -48 + Math.max(0, Math.min(1, r)) * 96];
    }
    return [-48, -48];
  }
  function loop() {
    const [tl, tr] = targetLevels();
    needles.l += (tl - needles.l) * 0.25;
    needles.r += (tr - needles.r) * 0.25;
    els.needleL.style.transform = `rotate(${needles.l.toFixed(2)}deg)`;
    els.needleR.style.transform = `rotate(${needles.r.toFixed(2)}deg)`;
    requestAnimationFrame(loop);
  }

  /* ---------- init ---------- */
  function init() {
    if (!N) {
      els.empty.hidden = false;
      els.empty.textContent = "No station data found (stations.js missing).";
      return;
    }
    buildDial();
    updateCounts();
    renderVolume();
    renderMuteBtn();
    renderGrid();
    renderPresets();
    setNeedle();
    els.lampPower.classList.add("on");
    status("STANDBY");
    els.npName.innerHTML = '<span class="np-marquee">PRESS PLAY TO START</span>';
    loop();

    // restore last station and connect immediately (autoplay may need a click)
    const lastId = store.get("aor.last", null);
    const lastIdx = lastId ? STATIONS.findIndex((s) => s.id === lastId) : -1;
    if (lastIdx >= 0) {
      state.idx = lastIdx;
      renderNowPlaying();
      renderGrid();
      renderPresets();
      startPlay();
    }
  }
  init();
})();
