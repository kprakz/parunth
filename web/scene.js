// The live floor: a 3D scene of the market and the four agents.
//
// In the middle, a dome of points that glows green when most of the watchlist
// is up and red when most of it is down, with one spike per stock. Around it
// stand the four agents as 3D characters. Lines of light show who is pointing
// at what: stock -> pitcher -> Charlie -> Moothon -> the stock he holds.
import * as THREE from "/vendor/three.module.min.js";

const host = document.getElementById("scene");
const overlay = document.getElementById("sceneLabels");
const HUE = { chathan: 0xff7a3d, neeli: 0x3fa9ff, charlie: 0xa98bff, moothon: 0xffc533 };
const NAMES = { chathan: "Chathan", neeli: "Neeli", charlie: "Charlie", moothon: "Moothon" };
const CALL = { take: "take it", skip: "don't take", lean: "on the fence" };
const BULL = new THREE.Color(0x1fe3a2), BEAR = new THREE.Color(0xff4668);
const DOME = new THREE.Vector3(0, 0, -2.2), R = 2.25;
const SPOT = {   // where each agent stands, and which way they face
  chathan: { x: -4.3, z: 0.7, ry: 0.5, s: 1.0 },
  neeli: { x: -2.75, z: 2.3, ry: 0.36, s: 1.0 },
  charlie: { x: 2.75, z: 2.3, ry: -0.36, s: 1.0 },
  moothon: { x: 4.3, z: 0.7, ry: -0.5, s: 1.12, y: 0.16 },
};

let renderer, scene, camera, W = 0, H = 0, ok = false;
let state = null, pointer = { x: 0, y: 0 };
const people = {}, tags = {}, bubbles = {}, stocks = {}, flows = [];
let domePts, domeBase, domeGlow, ring, spikes, rim, mood = BULL.clone(), moodTo = BULL.clone();
let flowKey = "", stockKey = "", picked = null;
const clock = new THREE.Clock();

/* ---------- small builders ---------- */
const M = (color, o = {}) => new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.72, metalness: 0.05 }, o));
function add(g, geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z); m.rotation.set(rx, ry, rz); g.add(m);
  return m;
}
const sphere = (r, w = 20, h = 14) => new THREE.SphereGeometry(r, w, h);
const box = (x, y, z) => new THREE.BoxGeometry(x, y, z);
const cyl = (a, b, h, n = 14) => new THREE.CylinderGeometry(a, b, h, n);
const cap = (r, top, len) => new THREE.SphereGeometry(r, 28, 16, 0, Math.PI * 2, top * Math.PI, len * Math.PI);

/* ---------- a person: big head, small body, parts that can move ---------- */
function person(o) {
  const root = new THREE.Group(), body = new THREE.Group(), head = new THREE.Group();
  root.add(body); body.add(head); head.position.y = 1.72;
  const skin = M(o.skin), top = M(o.top, o.topX || {}), bottom = M(o.bottom), hair = M(o.hair, { roughness: 0.95 });
  const dark = M(0x101014);
  if (!o.robe) {
    add(body, cyl(0.11, 0.1, 0.5, 10), bottom, -0.14, 0.3, 0);
    add(body, cyl(0.11, 0.1, 0.5, 10), bottom, 0.14, 0.3, 0);
    add(body, box(0.2, 0.1, 0.32), dark, -0.14, 0.05, 0.05);
    add(body, box(0.2, 0.1, 0.32), dark, 0.14, 0.05, 0.05);
  }
  add(body, new THREE.CapsuleGeometry(0.3, 0.42, 6, 16), top, 0, 0.94, 0);
  const armL = new THREE.Group(), armR = new THREE.Group();
  armL.position.set(-0.37, 1.2, 0); armR.position.set(0.37, 1.2, 0);
  [armL, armR].forEach((arm) => {
    add(arm, new THREE.CapsuleGeometry(0.085, 0.34, 4, 10), top, 0, -0.24, 0);
    add(arm, sphere(0.095, 12, 10), skin, 0, -0.5, 0);
  });
  armL.rotation.z = -0.22; armR.rotation.z = 0.22;
  body.add(armL, armR);
  add(head, sphere(0.36, 28, 20), skin);
  add(head, sphere(0.042, 10, 8), dark, -0.13, 0.02, 0.325);
  add(head, sphere(0.042, 10, 8), dark, 0.13, 0.02, 0.325);
  add(head, cap(0.385, 0, 0.52), hair, 0, 0.03, -0.02, -0.28);
  return { root, body, head, armL, armR, skin, top, bottom, hair, dark, phase: Math.random() * 6 };
}

function makeChathan() {   // red glitter jacket, sunglasses, always pointing at something
  const p = person({ skin: 0xc68a5e, hair: 0x0c0c0e, bottom: 0x111114, top: 0xc8102e,
    topX: { emissive: 0x7a0010, emissiveIntensity: 0.7, metalness: 0.55, roughness: 0.32 } });
  add(p.head, box(0.52, 0.12, 0.07), M(0x050506, { roughness: 0.15, metalness: 0.8 }), 0, 0.03, 0.33);
  add(p.head, box(0.2, 0.05, 0.02), M(0xf4f4f4), 0, -0.15, 0.335);
  const gold = M(0xffc533, { emissive: 0x7a5200, metalness: 0.8, roughness: 0.3 });
  for (let i = 0; i < 5; i++) add(p.body, sphere(0.03, 8, 6), gold, 0, 0.72 + 0.1 * i, 0.3);
  add(p.body, box(0.08, 0.6, 0.03), p.dark, -0.13, 0.98, 0.27, 0, 0, 0.12);
  add(p.body, box(0.08, 0.6, 0.03), p.dark, 0.13, 0.98, 0.27, 0, 0, -0.12);
  p.armR.rotation.set(-1.35, 0, 0.1);
  p.pointing = true;
  return p;
}

function makeNeeli() {   // long dark hair with red streaks, black jacket, grey scarf
  const p = person({ skin: 0xc98d68, hair: 0x23130f, bottom: 0x121216, top: 0x15151a, topX: { roughness: 0.4, metalness: 0.3 } });
  const back = add(p.head, sphere(0.36, 20, 16), p.hair, 0, -0.4, -0.2);
  back.scale.set(1.04, 1.8, 0.62);
  const red = M(0xd2202f, { emissive: 0x5a0008, emissiveIntensity: 0.6 });
  add(p.head, box(0.07, 0.86, 0.06), red, -0.31, -0.52, 0.03);
  add(p.head, box(0.07, 0.86, 0.06), red, 0.31, -0.52, 0.03);
  add(p.head, box(0.12, 0.035, 0.02), red, 0, -0.15, 0.335);
  add(p.body, new THREE.TorusGeometry(0.23, 0.085, 10, 20), M(0x2b2b31), 0, 1.4, 0, Math.PI / 2);
  add(p.body, box(0.16, 0.3, 0.03), red, 0, 1.05, 0.285);
  return p;
}

function makeCharlie() {   // black bomber, beard, messy hair, a bottle in hand and a sword on his back
  const p = person({ skin: 0xc48c62, hair: 0x0d0d10, bottom: 0x0d0d10, top: 0x0f0f12, topX: { roughness: 0.5, metalness: 0.2 } });
  [[-0.2, 0.34, 0.1], [0.05, 0.4, 0.14], [0.24, 0.3, 0.05], [-0.05, 0.36, -0.12], [0.16, 0.38, -0.08]].forEach(([x, y, z]) =>
    add(p.head, sphere(0.13, 10, 8), p.hair, x, y, z));
  add(p.head, cap(0.372, 0.56, 0.44), p.hair, 0, 0, 0.012);
  add(p.body, box(0.03, 0.72, 0.02), M(0x8a8f96, { metalness: 0.7, roughness: 0.3 }), 0, 0.96, 0.3);
  const glass = M(0x2e7d5b, { emissive: 0x0b3a26, emissiveIntensity: 0.8, roughness: 0.15, transparent: true, opacity: 0.88 });
  add(p.armR, cyl(0.055, 0.055, 0.24, 10), glass, 0, -0.72, 0.05);
  add(p.armR, cyl(0.022, 0.03, 0.12, 8), glass, 0, -0.55, 0.05);
  add(p.body, box(0.05, 1.5, 0.03), M(0x26262b, { metalness: 0.6, roughness: 0.3 }), 0, 1.02, -0.34, 0, 0, 0.62);
  add(p.body, box(0.16, 0.04, 0.05), M(0xffc533, { metalness: 0.8, roughness: 0.3 }), -0.32, 1.48, -0.34, 0, 0, 0.62);
  return p;
}

function makeMoothon() {   // slate coat to the floor, dark cape, big beard, a staff
  const p = person({ skin: 0xb98058, hair: 0x26262a, bottom: 0x4a5a66, top: 0x4a5a66, robe: true, topX: { roughness: 0.85 } });
  add(p.body, cyl(0.32, 0.52, 1.2, 20), p.top, 0, 0.6, 0);
  const cape = M(0x161b20, { roughness: 0.9, side: THREE.DoubleSide });
  add(p.body, new THREE.CylinderGeometry(0.4, 0.86, 1.4, 20, 1, true, Math.PI - 1.35, 2.7), cape, 0, 0.74, 0);
  add(p.body, new THREE.TorusGeometry(0.31, 0.075, 10, 22), cape, 0, 1.42, 0, Math.PI / 2);
  const gold = M(0xd9a441, { emissive: 0x5a3d00, metalness: 0.85, roughness: 0.3 });
  for (let i = 0; i < 6; i++) add(p.body, sphere(0.032, 8, 6), gold, 0, 0.28 + 0.17 * i, 0.5 - 0.031 * i);
  const long = add(p.head, sphere(0.36, 20, 16), p.hair, 0, -0.14, -0.14);
  long.scale.set(1.08, 1.3, 0.8);
  const beard = M(0x1b1b1f, { roughness: 1 });
  add(p.head, cap(0.378, 0.55, 0.45), beard, 0, 0, 0.014);
  const chin = add(p.head, sphere(0.26, 16, 12), beard, 0, -0.3, 0.16);
  chin.scale.set(0.95, 1.05, 0.7);
  add(p.head, box(0.13, 0.032, 0.03), p.hair, -0.13, 0.12, 0.33, 0, 0, -0.28);
  add(p.head, box(0.13, 0.032, 0.03), p.hair, 0.13, 0.12, 0.33, 0, 0, 0.28);
  const wood = M(0x5b3a22, { roughness: 0.8 }), bronze = M(0xb07a3a, { metalness: 0.8, roughness: 0.35, emissive: 0x3a2204 });
  add(p.root, cyl(0.035, 0.042, 2.3, 10), wood, 0.66, 1.15, 0.2);
  add(p.root, new THREE.TorusGeometry(0.17, 0.045, 10, 24, Math.PI * 1.4), bronze, 0.66, 2.44, 0.2, 0, 0, Math.PI * 0.8);
  p.gem = add(p.root, sphere(0.06, 12, 10), M(0xffc533, { emissive: 0xffa800, emissiveIntensity: 1.6 }), 0.66, 2.44, 0.2);
  p.armR.rotation.set(-0.5, 0, 0.75);
  return p;
}

/* ---------- labels drawn in HTML on top of the canvas ---------- */
const tmp = new THREE.Vector3();
function place(el, v, keepInside) {
  tmp.copy(v).project(camera);
  if (tmp.z > 1) { el.style.opacity = 0; return; }
  el.style.opacity = "";
  let x = (tmp.x * 0.5 + 0.5) * W, y = (-tmp.y * 0.5 + 0.5) * H;
  if (keepInside) {   // speech bubbles never slide off the edge of the panel
    const hw = el.offsetWidth / 2 + 6, hh = el.offsetHeight / 2 + 6;
    x = Math.max(hw, Math.min(W - hw, x)); y = Math.max(hh, Math.min(H - hh, y));
  }
  el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
}
function label(cls, html) {
  const el = document.createElement("div");
  el.className = cls; el.innerHTML = html || "";
  overlay.appendChild(el);
  return el;
}

/* ---------- build ---------- */
function build() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  host.prepend(renderer.domElement);
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x05070a, 13, 30);
  camera = new THREE.PerspectiveCamera(34, 2, 0.1, 100);

  scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x0a1014, 1.25));
  const key = new THREE.DirectionalLight(0xffffff, 1.7); key.position.set(3, 7, 8); scene.add(key);
  rim = new THREE.PointLight(0x1fe3a2, 60, 16, 1.8); rim.position.set(0, 2.0, -2.2); scene.add(rim);

  const grid = new THREE.GridHelper(40, 80, 0x1f2e38, 0x111a20); scene.add(grid);

  // The dome: points on the upper half of a sphere
  const n = 1500, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const y = (i + 0.5) / n, r = Math.sqrt(1 - y * y), a = i * 2.399963;
    pos[i * 3] = Math.cos(a) * r; pos[i * 3 + 1] = y; pos[i * 3 + 2] = Math.sin(a) * r;
  }
  domeBase = pos.slice();
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  domePts = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.075, color: 0x1fe3a2, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false }));
  domePts.position.copy(DOME); domePts.scale.setScalar(R); scene.add(domePts);
  domeGlow = new THREE.Mesh(new THREE.SphereGeometry(R * 0.97, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x1fe3a2, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false }));
  domeGlow.position.copy(DOME); scene.add(domeGlow);
  ring = new THREE.Mesh(new THREE.RingGeometry(R * 1.03, R * 1.09, 72),
    new THREE.MeshBasicMaterial({ color: 0x1fe3a2, transparent: true, opacity: 0.8, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
  ring.rotation.x = -Math.PI / 2; ring.position.set(DOME.x, 0.02, DOME.z); scene.add(ring);

  // The four agents
  const makers = { chathan: makeChathan, neeli: makeNeeli, charlie: makeCharlie, moothon: makeMoothon };
  Object.keys(makers).forEach((k) => {
    const p = makers[k](), s = SPOT[k];
    p.root.position.set(s.x, s.y || 0, s.z); p.root.rotation.y = s.ry; p.root.scale.setScalar(s.s);
    p.home = p.root.position.clone();
    scene.add(p.root); people[k] = p;
    const pad = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.7, 40), new THREE.MeshBasicMaterial({ color: HUE[k], transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
    pad.rotation.x = -Math.PI / 2; pad.position.set(s.x, (s.y || 0) + 0.02, s.z); scene.add(pad);
    tags[k] = label("tag3d", ""); tags[k].dataset.agent = k;
    bubbles[k] = label("say3d", ""); bubbles[k].dataset.agent = k;
  });
  add(scene, cyl(1.05, 1.15, 0.16, 36), M(0x12181d, { metalness: 0.4, roughness: 0.5 }), SPOT.moothon.x, 0.08, SPOT.moothon.z);

  window.addEventListener("resize", resize);
  host.addEventListener("mousemove", (e) => {
    const b = host.getBoundingClientRect();
    pointer.x = (e.clientX - b.left) / b.width - 0.5; pointer.y = (e.clientY - b.top) / b.height - 0.5;
  });
  host.addEventListener("mouseleave", () => { pointer.x = 0; pointer.y = 0; });
  overlay.addEventListener("click", (e) => {
    const el = e.target.closest(".stock3d");
    if (el) window.dispatchEvent(new CustomEvent("floor:pick", { detail: el.dataset.sym }));
  });
  resize();
  ok = true;
  renderer.setAnimationLoop(frame);
}

function resize() {
  W = host.clientWidth; H = host.clientHeight;
  if (!W || !H) return;
  renderer.setSize(W, H, false);
  camera.aspect = W / H;
  // Pull the camera back just far enough that all four agents fit across the panel.
  camera.userData.dist = Math.max(8.6, 5.15 / (Math.tan(camera.fov * Math.PI / 360) * camera.aspect));
  camera.updateProjectionMatrix();
}

/* ---------- stocks on the dome ---------- */
function stockDir(i, n) {
  const a = -1.42 + 2.84 * (i + 0.5) / n, e = [0.2, 0.62, 1.04][i % 3];
  return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
}
function stockPos(sym, extra = 0) {
  const s = stocks[sym];
  return s ? DOME.clone().addScaledVector(s.dir, s.len + extra) : DOME.clone().add(new THREE.Vector3(0, R, 0));
}

function syncStocks() {
  const watch = (state.watch || []).slice().sort((a, b) => a.symbol.localeCompare(b.symbol));
  const key = watch.map((w) => w.symbol).join();
  if (key !== stockKey) {
    stockKey = key;
    Object.values(stocks).forEach((s) => s.el.remove());
    Object.keys(stocks).forEach((k) => delete stocks[k]);
    watch.forEach((w, i) => {
      const el = label("stock3d", "");
      el.dataset.sym = w.symbol;
      stocks[w.symbol] = { dir: stockDir(i, watch.length), len: R + 0.3, el };
    });
    if (spikes) { scene.remove(spikes); spikes.geometry.dispose(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(watch.length * 6), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(watch.length * 6), 3));
    spikes = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }));
    scene.add(spikes);
  }
  if (!spikes) return;
  const top = Math.max(0.005, ...watch.map((w) => Math.abs(w.chg)));
  const P = spikes.geometry.attributes.position, C = spikes.geometry.attributes.color;
  let ups = 0;
  watch.forEach((w, i) => {
    const s = stocks[w.symbol], col = w.chg >= 0 ? BULL : BEAR;
    if (w.chg >= 0) ups++;
    s.len = R + 0.3 + 1.2 * Math.abs(w.chg) / top;
    const a = DOME.clone().addScaledVector(s.dir, R), b = DOME.clone().addScaledVector(s.dir, s.len);
    P.setXYZ(i * 2, a.x, a.y, a.z); P.setXYZ(i * 2 + 1, b.x, b.y, b.z);
    C.setXYZ(i * 2, col.r * 0.35, col.g * 0.35, col.b * 0.35); C.setXYZ(i * 2 + 1, col.r, col.g, col.b);
    const html = `<b>${w.symbol}</b><span>${w.chg >= 0 ? "+" : "-"}${Math.abs(w.chg * 100).toFixed(1)}%</span>`;
    if (s.html !== html) { s.el.innerHTML = html; s.html = html; }
    s.el.className = "stock3d " + (w.chg >= 0 ? "bull" : "bear") + (w.held ? " held" : "") + (w.symbol === picked ? " on" : "");
  });
  P.needsUpdate = true; C.needsUpdate = true;
  moodTo = watch.length && ups * 2 < watch.length ? BEAR : BULL;
}

/* ---------- lines of light between whoever is pointing at whatever ---------- */
function chest(k) { const p = people[k]; return p.home.clone().add(new THREE.Vector3(0, 1.25 * SPOT[k].s, 0)); }

function syncFlows() {
  const A = state.agents, c = A.chathan.pitch, n = A.neeli.pitch, d = A.neeli.doubt, r = (A.charlie.reviews || [])[0];
  const held = (state.positions || []).map((p) => p.symbol);
  const want = [];
  if (c) want.push(["s:" + c.symbol, "chathan", HUE.chathan]);
  if (n) want.push(["s:" + n.symbol, "neeli", HUE.neeli]);
  else if (d) want.push(["s:" + d.symbol, "neeli", 0xff4668]);
  if (c) want.push(["chathan", "charlie", HUE.chathan]);
  if (n) want.push(["neeli", "charlie", HUE.neeli]);
  if (r) want.push(["charlie", "moothon", r.call === "take" ? 0x1fe3a2 : r.call === "skip" ? 0xff4668 : HUE.charlie]);
  held.forEach((s) => want.push(["moothon", "s:" + s, HUE.moothon]));
  const key = JSON.stringify(want) + stockKey;
  if (key === flowKey) return;
  flowKey = key;
  flows.forEach((f) => { scene.remove(f.line, f.dot); f.line.geometry.dispose(); });
  flows.length = 0;
  const end = (id) => (id.startsWith("s:") ? stockPos(id.slice(2), 0.05) : chest(id));
  want.forEach(([from, to, color], i) => {
    const a = end(from), b = end(to), mid = a.clone().add(b).multiplyScalar(0.5);
    mid.y += 1.2 + a.distanceTo(b) * 0.16;
    if (!from.startsWith("s:") && !to.startsWith("s:")) mid.z += 1.6;   // agent-to-agent lines swing out in front
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(48)),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }));
    const dot = new THREE.Mesh(sphere(0.075, 10, 8), new THREE.MeshBasicMaterial({ color }));
    scene.add(line, dot);
    flows.push({ curve, line, dot, off: i * 0.23 });
  });
}

/* ---------- what each agent is saying right now ---------- */
function syncSpeech() {
  const A = state.agents, v = state.verdict, c = A.chathan, n = A.neeli, r = (A.charlie.reviews || [])[0];
  const exiting = (state.positions || []).find((p) => p.advice.kind === "exit");
  const say = {
    chathan: c.pitch ? [`${c.pitch.symbol}! ${c.pitch.conviction}% sure`, "hot"] : ["Nothing is moving", ""],
    neeli: n.pitch ? [`${n.pitch.symbol} passes my checks`, "bull"] : n.doubt ? [`Not ${n.doubt.symbol} for me`, "bear"] : ["Watching", ""],
    charlie: r ? [`${r.symbol}: ${CALL[r.call]}, ${r.confidence}%`, r.call === "take" ? "bull" : r.call === "skip" ? "bear" : ""] : ["Nothing to weigh", ""],
    moothon: exiting ? [`EXIT ${exiting.symbol}`, "bear"] : v && v.action === "BUY" ? [`BUY ${v.symbol}`, "bull"]
      : v && v.idea && v.idea.veto ? [`PASS ${v.idea.symbol}`, "bear"] : ["WAIT", ""],
  };
  const last = (state.feed || []).find((m) => people[m.who]);
  Object.keys(people).forEach((k) => {
    const speaking = last && last.who === k;
    const html = `<b>${say[k][0]}</b>` + (speaking ? `<span>${escapeHtml(last.text.length > 96 ? last.text.slice(0, 94) + "..." : last.text)}</span>` : "");
    const b = bubbles[k];
    if (b._html !== html) { b.innerHTML = html; b._html = html; b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop"); }
    b.className = "say3d pop " + say[k][1] + (speaking ? " speaking" : "");
    people[k].speaking = !!speaking;
    people[k].hot = k === "chathan" && !!c.pitch;
    const t = `<b>${NAMES[k]}</b><span>trust ${Math.round(A[k].trust)}</span>`;
    if (tags[k]._html !== t) { tags[k].innerHTML = t; tags[k]._html = t; }
  });
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

/* ---------- every frame ---------- */
function frame() {
  if (!W || !H) { resize(); return; }
  const t = clock.getElapsedTime();
  const still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const dist = camera.userData.dist || 11;
  const ang = (still ? 0 : Math.sin(t * 0.16) * 0.07) + pointer.x * 0.28;
  camera.position.set(Math.sin(ang) * dist, 3.3 - pointer.y * 1.2, Math.cos(ang) * dist);
  camera.lookAt(0, 1.75, 0);

  mood.lerp(moodTo, 0.04);
  domePts.material.color.copy(mood); domeGlow.material.color.copy(mood); ring.material.color.copy(mood); rim.color.copy(mood);
  if (!still) {
    const P = domePts.geometry.attributes.position;
    for (let i = 0; i < P.count; i++) {
      const y = domeBase[i * 3 + 1], k = 1 + 0.028 * Math.sin(t * 1.7 - y * 9);
      P.setXYZ(i, domeBase[i * 3] * k, y * k, domeBase[i * 3 + 2] * k);
    }
    P.needsUpdate = true;
    domePts.rotation.y = t * 0.05;
    domeGlow.material.opacity = 0.18 + 0.06 * Math.sin(t * 1.7);
  }

  Object.keys(people).forEach((k) => {
    const p = people[k], s = SPOT[k];
    let y = 0, hx = 0, hy = 0;
    if (!still) {
      y = Math.sin(t * 1.5 + p.phase) * 0.02;
      if (p.speaking) { y += Math.abs(Math.sin(t * 7)) * 0.06; hx = Math.sin(t * 9) * 0.06; }
      if (p.hot) { y += Math.abs(Math.sin(t * 5.2)) * 0.13; p.armR.rotation.x = -1.35 + Math.sin(t * 6) * 0.25; }
      hy = Math.sin(t * 0.6 + p.phase) * 0.12;
      if (p.gem) p.gem.material.emissiveIntensity = 1.3 + Math.sin(t * 3) * 0.6;
    }
    if (p.react) {
      const q = (t - p.react.t0) / p.react.len;
      if (q >= 1) p.react = null;
      else if (p.react.how === "jump") y += Math.sin(q * Math.PI) * 0.55;
      else if (p.react.how === "shake") hy = Math.sin(q * Math.PI * 6) * 0.55;
      else if (p.react.how === "nod") hx = Math.sin(q * Math.PI * 4) * 0.32;
    }
    p.root.position.y = (s.y || 0) + y * s.s;
    p.head.rotation.set(hx, hy, 0);
    place(tags[k], tmp.set(p.home.x, (s.y || 0) - 0.02, p.home.z + 0.75));
    place(bubbles[k], tmp.set(p.home.x, (s.y || 0) + (Math.abs(s.x) > 3.5 ? 3.75 : 2.7) * s.s, p.home.z), true);
  });

  flows.forEach((f) => { f.dot.position.copy(f.curve.getPoint(still ? 0.5 : (t * 0.45 + f.off) % 1)); });
  Object.keys(stocks).forEach((sym) => place(stocks[sym].el, stockPos(sym, 0.2)));
  renderer.render(scene, camera);
}

/* ---------- the outside world talks to the floor through this ---------- */
window.Floor = {
  update(s, focus) {
    if (!ok || !s || !s.agents) return;
    state = s; picked = focus || (s.chart && s.chart.symbol) || null;
    syncStocks(); syncFlows(); syncSpeech();
  },
  react(agent, how) {
    if (ok && people[agent]) people[agent].react = { how, t0: clock.getElapsedTime(), len: how === "jump" ? 0.55 : 0.7 };
  },
};

try {
  if (host) build();
} catch (e) {
  if (host) host.classList.add("no3d");
  console.error("3D floor unavailable:", e);
}
