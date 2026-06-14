// Generate a multi-resolution Windows .ico from the FullBand SVG, reliably:
// drive a headless Edge over CDP, rasterize the SVG to a canvas at each size
// (crisp downscales), pull the PNGs back, and pack them into icon.ico.
const fs = require("fs");
const path = require("path");
const DBG = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SIZES = [256, 128, 64, 48, 32, 16];

const SVG = `<svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#262626"/><stop offset="1" stop-color="#0d0d0d"/></linearGradient>
    <linearGradient id="amb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffc874"/><stop offset="1" stop-color="#f0a43c"/></linearGradient>
    <filter id="glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="4.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect x="6" y="6" width="244" height="244" rx="56" fill="url(#bg)" stroke="#333" stroke-width="2"/>
  <g filter="url(#glow)" fill="url(#amb)">
    <rect x="56" y="66" width="34" height="124" rx="17"/>
    <rect x="111" y="114" width="34" height="76" rx="17"/>
    <rect x="166" y="90" width="34" height="100" rx="17"/>
  </g>
  <g fill="#fff8ec">
    <rect x="50" y="78" width="46" height="12" rx="6"/>
    <rect x="105" y="126" width="46" height="12" rx="6"/>
    <rect x="160" y="102" width="46" height="12" rx="6"/>
  </g>
</svg>`;

async function getWs() {
  for (let i = 0; i < 40; i++) { try { const l = await fetch(`${DBG}/json`).then((r) => r.json()); const p = l.find((t) => t.type === "page"); if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl; } catch {} await sleep(250); }
  throw new Error("no CDP page");
}
function client(ws) { const s = new WebSocket(ws); let id = 0; const pend = new Map(); const ready = new Promise((r) => (s.onopen = r));
  s.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return { ready, send: (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); s.send(JSON.stringify({ id: i, method, params })); }) }; }
async function ev(c, expr) { const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "exc"); return r.result?.result?.value; }

(async () => {
  const c = client(await getWs()); await c.ready;
  await c.send("Runtime.enable"); await c.send("Page.enable");
  await c.send("Page.navigate", { url: "about:blank" }); await sleep(400);
  const svgB64 = Buffer.from(SVG).toString("base64");
  const expr = `(async () => {
    const sizes = ${JSON.stringify(SIZES)};
    const url = 'data:image/svg+xml;base64,' + '${svgB64}';
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const out = {};
    for (const s of sizes) {
      const cv = document.createElement('canvas'); cv.width = s; cv.height = s;
      const ctx = cv.getContext('2d');
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0,0,s,s); ctx.drawImage(img, 0, 0, s, s);
      out[s] = cv.toDataURL('image/png').split(',')[1];
    }
    return out;
  })()`;
  const pngs = await ev(c, expr);
  const dir = path.join(__dirname, "_icons");
  fs.mkdirSync(dir, { recursive: true });
  const imgs = [];
  for (const s of SIZES) {
    const data = Buffer.from(pngs[s], "base64");
    fs.writeFileSync(path.join(dir, `icon-${s}.png`), data);
    imgs.push({ size: s, data });
    console.log(`icon-${s}.png  ${data.length} bytes`);
  }
  // assemble ICO (PNG-compressed entries)
  const count = imgs.length;
  const header = Buffer.alloc(6); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4);
  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  imgs.forEach((im, i) => { const e = i * 16; const dim = im.size >= 256 ? 0 : im.size;
    entries.writeUInt8(dim, e); entries.writeUInt8(dim, e + 1);
    entries.writeUInt16LE(1, e + 4); entries.writeUInt16LE(32, e + 6);
    entries.writeUInt32LE(im.data.length, e + 8); entries.writeUInt32LE(offset, e + 12); offset += im.data.length; });
  fs.writeFileSync(path.join(__dirname, "icon.ico"), Buffer.concat([header, entries, ...imgs.map((i) => i.data)]));
  console.log("icon.ico packed:", imgs.map((i) => i.size).join("/"));
  process.exit(0);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
