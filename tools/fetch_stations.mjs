import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://www.tamilradios.com";
const PAGES = 10;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const ROOT = path.dirname(fileURLToPath(new URL("..", import.meta.url)));
const IMG_DIR = path.join(ROOT, "img");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractFlightStrings(html) {
  const out = [];
  const needle = "self.__next_f.push([1,";
  let idx = 0;
  while ((idx = html.indexOf(needle, idx)) !== -1) {
    let i = idx + needle.length;
    while (i < html.length && /\s/.test(html[i])) i++;
    if (html[i] !== '"') { idx++; continue; }
    i++;
    let s = "";
    let closed = false;
    while (i < html.length) {
      const c = html[i];
      if (c === "\\") {
        const n = html[i + 1];
        if (n === "u") {
          s += String.fromCharCode(parseInt(html.slice(i + 2, i + 6), 16));
          i += 6;
        } else {
          const map = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f" };
          s += map[n] ?? n;
          i += 2;
        }
        continue;
      }
      if (c === '"') { closed = true; i++; break; }
      s += c;
      i++;
    }
    if (closed) { out.push(s); idx = i; } else idx++;
  }
  return out;
}

function sliceBalancedJson(text, start) {
  let depth = 0, inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "[") depth++;
    else if (c === "]") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

function findStationsArrays(rscText) {
  const found = [];
  const needle = '"stations":[';
  let idx = 0;
  while ((idx = rscText.indexOf(needle, idx)) !== -1) {
    const start = idx + needle.length - 1;
    const slice = sliceBalancedJson(rscText, start);
    if (slice) {
      try { found.push(JSON.parse(slice)); } catch { /* ignore */ }
      idx = start + slice.length;
    } else idx++;
  }
  return found;
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function cleanStation(s) {
  const img = s.image || "";
  let image = null;
  if (img) {
    const abs = img.startsWith("http") ? img : BASE + img;
    try {
      const u = new URL(abs);
      if (u.pathname.startsWith("/api/files/")) image = BASE + u.pathname;
    } catch { /* ignore */ }
  }
  return {
    id: s.id,
    slug: s.slug || null,
    name: s.name || s.desktop_title || s.mobile_title || "Unknown",
    genre: s.genre || "",
    country: s.country || "",
    stream: s.web_stream_url || s.url || null,
    stream2: s.url && s.url !== s.web_stream_url ? s.url : null,
    image,
  };
}

async function downloadImage(st) {
  if (!st.image) return false;
  const ext = (st.image.match(/\.(jpg|jpeg|png|webp|gif)$/i) || [])[1] || "jpg";
  const file = path.join(IMG_DIR, `${st.id}.${ext}`);
  try {
    await fs.access(file);
    st.img = `img/${st.id}.${ext}`;
    return true;
  } catch { /* not downloaded yet */ }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(st.image, {
        headers: { "user-agent": UA, referer: BASE + "/" },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(String(res.status));
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 200) throw new Error("too small");
      await fs.writeFile(file, buf);
      st.img = `img/${st.id}.${ext}`;
      return true;
    } catch (e) {
      if (attempt === 3) console.warn(`  image failed: ${st.name} (${e.message})`);
      else await sleep(800 * attempt);
    }
  }
  return false;
}

async function main() {
  await fs.mkdir(IMG_DIR, { recursive: true });
  const map = new Map();
  for (let p = 1; p <= PAGES; p++) {
    const url = p === 1 ? BASE + "/" : `${BASE}/page/${p}`;
    process.stdout.write(`fetch ${url} ... `);
    try {
      const html = await fetchPage(url);
      const chunks = extractFlightStrings(html);
      const arrays = findStationsArrays(chunks.join(""));
      let added = 0;
      for (const arr of arrays) {
        for (const raw of arr) {
          const st = cleanStation(raw);
          if (st.id && st.name && !map.has(st.id)) { map.set(st.id, st); added++; }
        }
      }
      console.log(`${added} new (total ${map.size})`);
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
    if (p < PAGES) await sleep(700);
  }

  const stations = [...map.values()].filter((s) => s.stream);
  stations.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));

  const slim = () =>
    stations.map(({ id, name, genre, slug, stream, stream2, img }) => ({
      id, name, genre: genre || "", slug: slug || "", stream, stream2: stream2 || "", img: img || "",
    }));
  const writeStations = async () => {
    const js =
      "window.STATIONS = " +
      JSON.stringify(slim(), null, 0).replace(/</g, "\\u003c") +
      ";\n";
    await fs.writeFile(path.join(ROOT, "stations.js"), js, "utf8");
    return js;
  };

  await writeStations();
  console.log(`\n${stations.length} stations with streams. Downloading images...`);

  const CONCURRENCY = 4;
  let done = 0, ok = 0, fail = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < stations.length) {
      const st = stations[cursor++];
      const good = await downloadImage(st);
      good ? ok++ : fail++;
      done++;
      if (done % 50 === 0) console.log(`  ${done}/${stations.length} (ok ${ok}, fail ${fail})`);
      await sleep(100);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`images: ${ok} ok, ${fail} missing`);

  const js = await writeStations();
  console.log(`wrote stations.js (${slim().length} stations, ${(js.length / 1024).toFixed(0)} KB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
