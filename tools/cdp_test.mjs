import { spawn } from "node:child_process";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = "file:///C:/Users/sumit/Downloads/sumith%20radio/index.html";
const PORT = 9223;

const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}\\aor-cdp-profile-${PORT}`,
  "--autoplay-policy=no-user-gesture-required",
  URL,
], { stdio: "ignore", windowsHide: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.url.includes("index.html"));
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("CDP target not found");
}

const target = await getTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => pending.set(id, res));
}
async function ev(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return "EXCEPTION: " + (r.result.exceptionDetails.text || "");
  return r.result?.result?.value;
}

await send("Runtime.enable");
await sleep(1200); // let app init

const results = [];
const check = (name, ok, extra = "") => {
  results.push([ok ? "PASS" : "FAIL", name, extra]);
};

check("stations loaded", (await ev("window.STATIONS.length")) === 548, String(await ev("window.STATIONS.length")));
check("grid cards rendered", (await ev("document.querySelectorAll('.st-card').length")) === 548);
check("presets rendered", (await ev("document.querySelectorAll('.preset').length")) === 12);
check("power lamp on", await ev("document.getElementById('lampPower').classList.contains('on')"));

// select a known station via search + click
await ev(`(()=>{const s=document.getElementById('search');s.value='Jayam';s.dispatchEvent(new Event('input'))})()`);
await sleep(200);
const filtered = await ev("document.querySelectorAll('.st-card').length");
check("search filters (Jayam)", filtered > 0 && filtered < 20, filtered + " results");
await ev("document.querySelector('.st-card').click()");
await sleep(900);
const np = await ev("document.getElementById('npName').textContent");
check("station selected (now playing text)", /Jayam/i.test(np), np);
const freq = await ev("document.getElementById('freqReadout').textContent");
check("frequency readout set", /^\d+\.\d$/.test(freq), freq + " MHz");
const needle = await ev("document.getElementById('needle').style.left");
check("needle moved", !!needle, needle);

// clear search, verify full grid
await ev(`(()=>{const s=document.getElementById('search');s.value='';s.dispatchEvent(new Event('input'))})()`);
await sleep(150);

// SHARE MENU
await ev("document.getElementById('btnShare').click()");
await sleep(150);
check("share menu opens", (await ev("document.getElementById('shareMenu').hidden")) === false);
const wa = await ev("document.getElementById('shWhatsApp').href");
const tg = await ev("document.getElementById('shTelegram').href");
const xh = await ev("document.getElementById('shX').href");
check("whatsapp link built", wa.startsWith("https://wa.me/?text=") && decodeURIComponent(wa).includes("Jayam"), wa.slice(0, 80));
check("telegram link built", tg.startsWith("https://t.me/share/url"), tg.slice(0, 80));
check("x link built", xh.startsWith("https://x.com/intent/post"), xh.slice(0, 80));
await ev("document.getElementById('shCopy').click()");
await sleep(300);
const copyLabel = await ev("document.getElementById('shCopy').textContent");
check("copy feedback", copyLabel === "COPIED!", copyLabel);
await ev("document.body.click()");
await sleep(100);
check("share menu closes on outside click", (await ev("document.getElementById('shareMenu').hidden")) === true);

// favorites
await ev("document.getElementById('btnFav').click()");
await sleep(100);
check("favorite toggled", (await ev("document.getElementById('cntFav').textContent")) === "1");
check("favorite persisted", (await ev("localStorage.getItem('aor.favs')")).includes("Jayam") === false && (await ev("JSON.parse(localStorage.getItem('aor.favs')).length")) === 1);
await ev(`document.querySelector('.st-fav.on').click()`);
await sleep(100);
check("favorite removed via card star", (await ev("document.getElementById('cntFav').textContent")) === "0");

// tabs
await ev(`document.querySelector('.tab[data-tab="recent"]').click()`);
await sleep(100);
check("recent tab has 1+", Number(await ev("document.querySelectorAll('.st-card').length")) >= 1);
await ev(`document.querySelector('.tab[data-tab="all"]').click()`);

// keyboard: space toggles play label area, arrows change station
const beforeName = await ev("document.getElementById('npName').textContent");
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
await sleep(300);
const afterName = await ev("document.getElementById('npName').textContent");
check("ArrowRight tunes next station", beforeName !== afterName, `${beforeName} -> ${afterName}`);
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))`);
await sleep(300);
check("ArrowLeft returns", (await ev("document.getElementById('npName').textContent")) === beforeName);

// volume keyboard
const volBefore = await ev("document.getElementById('volValue').textContent");
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}))`);
check("ArrowUp raises volume", Number(await ev("document.getElementById('volValue').textContent")) > Number(volBefore), volBefore + " -> " + (await ev("document.getElementById('volValue').textContent")));

// mute
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'m',bubbles:true}))`);
await sleep(50);
check("M mutes", (await ev("document.getElementById('btnMute').classList.contains('btn-mute-on')")) === true);
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'m',bubbles:true}))`);

// play state / status
const statusText = await ev("document.getElementById('npStatus').textContent");
check("status indicator active", ["PLAYING", "TUNING…", "RETRY…", "OFF AIR", "PRESS PLAY", "BUFFERING", "PAUSED"].includes(statusText), statusText);

// dial drag simulation: set needle via selectStation through preset click
await ev("document.querySelectorAll('.preset')[3].click()");
await sleep(400);
const pName = await ev("document.getElementById('npName').textContent");
check("preset click tunes station", pName.length > 0 && pName !== "PRESS PLAY TO START", pName);

console.log("\n=== ALL ONE RADIO — VERIFICATION ===");
for (const [st, name, extra] of results) console.log(`${st === "PASS" ? "✓" : "✗"} ${name}${extra ? "  (" + extra + ")" : ""}`);
const fails = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);

ws.close();
spawn("taskkill", ["/PID", String(edge.pid), "/T", "/F"], { stdio: "ignore" });
process.exit(fails ? 1 : 0);
