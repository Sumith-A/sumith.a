import fs from "node:fs";

const norm = (s) =>
  s.toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bfm\b/g, " ")
    .replace(/[^a-z0-9\u0B80-\u0BFF]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

const stations = JSON.parse(fs.readFileSync(new URL("../stations.js", import.meta.url), "utf8").replace(/^window\.STATIONS = /, "").replace(/;\s*$/, ""));
const list = fs.readFileSync(new URL("./user_list.txt", import.meta.url), "utf8")
  .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

const idx = new Map();
for (const st of stations) {
  const key = norm(st.name);
  if (!idx.has(key)) idx.set(key, st);
}

let exact = 0;
const missing = [];
const matched = [];
for (const name of list) {
  const key = norm(name);
  if (idx.has(key)) {
    exact++;
    matched.push([name, idx.get(key).name, !!idx.get(key).img]);
    continue;
  }
  // fuzzy: contains match
  const hit = stations.find((st) => {
    const k = norm(st.name);
    return k.includes(key) || key.includes(k);
  });
  if (hit) matched.push([name, hit.name, !!hit.img]);
  else missing.push(name);
}

const withImg = matched.filter((m) => m[2]).length;
console.log(`user list: ${list.length} | matched: ${matched.length} (exact ${exact}) | missing: ${missing.length}`);
console.log(`matched with local image: ${withImg} / ${matched.length}`);
if (missing.length) console.log("\nMISSING:\n" + missing.join("\n"));
const noImg = matched.filter((m) => !m[2]);
if (noImg.length) console.log("\nMATCHED BUT NO IMAGE:\n" + noImg.map((m) => `${m[0]}  ->  ${m[1]}`).join("\n"));
