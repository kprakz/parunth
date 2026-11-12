"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const AGENTS = {
  chathan: { name: "Chathan", tag: "Always eager to invest", letter: "C", hue: "var(--chathan)", lag: 0 },
  neeli: { name: "Neeli", tag: "Takes calculated risk", letter: "N", hue: "var(--neeli)", lag: -2.3 },
  charlie: { name: "Charlie", tag: "The trading consultant", letter: "Ch", hue: "var(--charlie)", lag: -4.1 },
  moothon: { name: "Moothon", tag: "The deciding judge", letter: "M", hue: "var(--moothon)", lag: -5.6 },
  system: { name: "Market", hue: "var(--muted)" },
};
const ORDER = ["chathan", "neeli", "charlie", "moothon"];
const BASIS = { both: "Both", neeli: "Neeli", chathan: "Chathan" };
const CALL = { take: "Take it", skip: "Don't take", lean: "On the fence" };

let S = null;        // latest state from the server
let focus = null;    // symbol the price chart is pinned to (null = follow Moothon)
let fmtCache = {};

/* ---------- icons: one stroke weight, drawn, no emoji ---------- */
const ICON = {
  flame: '<path d="M12 3c1 3 4 4.5 4 8.5a4 4 0 0 1-8 0c0-1.5.6-2.6 1.5-3.5 0 1.5 1 2 1.500 2C11 8 10.500 5.500 12 3z"/><path d="M12 21a7 7 0 0 0 7-7"/>',
  moon: '<path d="M20 14.500A8 8 0 1 1 9.500 4a6.500 6.500 0 0 0 10.500 10.500z"/>',
  eye: '<path d="M2 12s3.600-7 10-7 10 7 10 7-3.600 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  check: '<path d="M5 12.500l4.500 4.500L19 7.500"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  scale: '<path d="M12 4v16M7 20h10M5 8h14M5 8l-3 6a3 3 0 0 0 6 0zM19 8l-3 6a3 3 0 0 0 6 0z"/>',
  exit: '<path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9"/>',
  minus: '<path d="M6 12h12"/>',
};
const ico = (n) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;

/* ---------- formatting ---------- */
const num = (x, d = 2) => Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (x, d = 2) => (x < 0 ? "-$" : "$") + num(x, d);
const spct = (x, d = 2) => (x < 0 ? "-" : "+") + num(x * 100, d) + "%";
const sr = (x) => (x < 0 ? "-" : "+") + num(x, 2) + "R";
// Account money is held in dollars by the server and shown in the account's currency.
const MONEY = () => (S && S.money) || { symbol: "$", rate: 1 };
const cents = () => (S && S.account && S.account.start_cash / MONEY().rate < 10000 ? 2 : 0);
const cash = (x, d = 2) => (x < 0 ? "-" : "") + MONEY().symbol + num(x / MONEY().rate, d);
const scash = (x, d = 2) => (x < 0 ? "-" : "+") + MONEY().symbol + num(x / MONEY().rate, d);
const qty = (x) => Number(x).toLocaleString("en-US", { maximumFractionDigits: 4 });
const cls = (x) => (x > 0.000001 ? "up" : x < -0.000001 ? "down" : "flat");
const arrow = (x) => (x > 0.000001 ? '<svg class="tri" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1l4 8H1z"/></svg>'
  : x < -0.000001 ? '<svg class="tri dn" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1l4 8H1z"/></svg>' : "");
const capFirst = (s) => s.slice(0, 1).toUpperCase() + s.slice(1);
const compactCash = (x, span) => {
  const s = MONEY().symbol;
  if (Math.abs(x) >= 1e6) return s + (x / 1e6).toFixed(span < 2e5 ? 2 : 1) + "M";
  if (Math.abs(x) >= 1e4) return s + (x / 1e3).toFixed(span < 4e3 ? 1 : 0) + "K";
  return s + num(x, span < 20 ? 2 : 0);
};

function tfmt(kind) {
  const tz = (S && S.clock && S.clock.tz) || "America/New_York";
  const key = kind + tz;
  if (!fmtCache[key]) {
    const o = { timeZone: tz };
    if (kind === "time") Object.assign(o, { hour: "numeric", minute: "2-digit" });
    if (kind === "day") Object.assign(o, { month: "short", day: "numeric" });
    if (kind === "full") Object.assign(o, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    if (kind === "stamp") Object.assign(o, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    fmtCache[key] = new Intl.DateTimeFormat("en-US", o);
  }
  return fmtCache[key];
}
const when = (t, kind) => (t ? tfmt(kind).format(new Date(t * 1000)) : "");

function setHTML(el, html) {
  if (el._html !== html) { el.innerHTML = html; el._html = html; return true; }
  return false;
}

/* ---------- chart helpers ---------- */
function niceTicks(lo, hi, want) {
  const raw = (hi - lo) / Math.max(1, want);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(v);
  return out;
}

function hoverable(el, onMove) {
  el._onMove = onMove;
  if (!el._wired) {
    el._wired = true;
    el.addEventListener("mousemove", (e) => { el._mouse = [e.clientX, e.clientY]; el._onMove && el._onMove(); });
    el.addEventListener("mouseleave", () => {
      el._mouse = null; $("tip").hidden = true;
      const g = el.querySelector(".hov"); if (g) g.innerHTML = "";
    });
  }
  if (el._mouse) onMove();
}

function showTip(html, mx, my) {
  const tip = $("tip");
  tip.innerHTML = html; tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(window.innerWidth - w - 8, mx + 14) + "px";
  tip.style.top = Math.max(8, my - h - 12) + "px";
}

/* ---------- equity curve ---------- */
function drawCurve() {
  const el = $("curveChart"), curve = S.curve || [];
  const W = el.clientWidth, H = el.clientHeight, n = curve.length;
  if (!W) return;
  if (n < 2) { setHTML(el, '<div class="empty">The curve starts with the first bars.</div>'); return; }
  const rate = MONEY().rate, start = S.account.start_cash / rate;
  const ahead = S.account.pnl >= 0;
  const series = [
    { name: "Moothon's portfolio", color: ahead ? "var(--bull)" : "var(--bear)", vals: curve.map((c) => c[1] / rate), w: 2, glow: true },
    { name: "Just holding " + S.rules.benchmark, color: "var(--muted)", vals: curve.map((c) => c[2] / rate), w: 1.5 },
  ];
  let lo = Infinity, hi = -Infinity;
  series.forEach((s) => s.vals.forEach((v) => { lo = Math.min(lo, v); hi = Math.max(hi, v); }));
  const pad = Math.max((hi - lo) * 0.08, hi * 0.0005);
  lo -= pad; hi += pad;
  const m = { l: 62, r: 12, t: 6, b: 20 };
  const x = (i) => m.l + (W - m.l - m.r) * i / (n - 1);
  const y = (v) => m.t + (H - m.t - m.b) * (1 - (v - lo) / (hi - lo));
  let g = "";
  niceTicks(lo, hi, 4).forEach((v) => {
    g += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>` +
         `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${compactCash(v, hi - lo)}</text>`;
  });
  if (start > lo && start < hi) {
    g += `<line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${y(start)}" y2="${y(start)}"/>`;
  }
  const days = new Set(curve.map((c) => when(c[0], "day")));
  let lastX = -1e9, prev = null;
  curve.forEach((c, i) => {
    const key = days.size > 1 ? when(c[0], "day") : (new Date(c[0] * 1000).getUTCMinutes() === 0 ? when(c[0], "time") : prev);
    if (key !== prev && key && x(i) - lastX > 70 && x(i) < W - m.r - 30) {
      g += `<text x="${x(i)}" y="${H - 4}">${esc(key)}</text>`;
      lastX = x(i);
    }
    prev = key;
  });
  series.slice().reverse().forEach((s) => {
    const d = s.vals.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join("");
    g += `<path ${s.glow ? 'class="glow"' : ""} d="${d}" fill="none" stroke="${s.color}" style="color:${s.color}" stroke-width="${s.w}" stroke-linejoin="round" stroke-linecap="round"/>`;
  });
  g += `<circle class="ring" cx="${x(n - 1)}" cy="${y(series[0].vals[n - 1])}" r="4" fill="${series[0].color}"/>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Portfolio value over time against holding the benchmark">${g}<g class="hov"></g></svg>`;
  el._html = null;
  setHTML($("curveLegend"), series.map((s) => `<span><i class="key" style="background:${s.color}"></i>${esc(s.name)}</span>`).join(""));

  hoverable(el, () => {
    const box = el.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round((el._mouse[0] - box.left - m.l) / (W - m.l - m.r) * (n - 1))));
    el.querySelector(".hov").innerHTML =
      `<line class="cross" x1="${x(i)}" x2="${x(i)}" y1="${m.t}" y2="${H - m.b}"/>` +
      series.map((s) => `<circle class="ring" cx="${x(i)}" cy="${y(s.vals[i])}" r="4" fill="${s.color}"/>`).join("");
    showTip(`<b>${esc(when(curve[i][0], "full"))}</b>` + series.map((s) =>
      `<div><span><i class="key" style="background:${s.color}"></i>${esc(s.name)}</span><span>${MONEY().symbol}${num(s.vals[i])}</span></div>`).join(""),
      el._mouse[0], el._mouse[1]);
  });
}

/* ---------- price chart ---------- */
function drawPrice() {
  const el = $("priceChart"), ch = S.chart;
  const W = el.clientWidth, H = el.clientHeight;
  if (!W) return;
  $("followBtn").classList.toggle("on", !focus);
  if (!ch || !ch.bars.length) {
    setHTML(el, '<div class="empty">No bars yet for this session.</div>');
    setHTML($("priceLegend"), ""); setHTML($("chartTitle"), "Price");
    return;
  }
  const bars = ch.bars, n = bars.length, lv = ch.levels;
  const last = bars[n - 1][4];
  const chg = ch.prev_close ? last / ch.prev_close - 1 : 0;
  setHTML($("chartTitle"), `${esc(ch.symbol)} <span class="hint">${usd(last)} <span class="${cls(chg)}">${arrow(chg)}${spct(chg)}</span> today / 5-minute bars</span>`);
  let lo = Infinity, hi = -Infinity;
  bars.forEach((b) => { lo = Math.min(lo, b[3]); hi = Math.max(hi, b[2]); });
  if (lv) { lo = Math.min(lo, lv.stop); hi = Math.max(hi, lv.target); }
  const pad = Math.max((hi - lo) * 0.07, last * 0.0005);
  lo -= pad; hi += pad;
  const m = { l: 58, r: lv ? 118 : 12, t: 6, b: 20 };
  const slots = Math.max(n, 78);
  const slot = (W - m.l - m.r) / slots;
  const x = (i) => m.l + slot * (i + 0.5);
  const y = (v) => m.t + (H - m.t - m.b) * (1 - (v - lo) / (hi - lo));
  const bw = Math.max(2, Math.min(9, slot * 0.66));
  let g = "";
  niceTicks(lo, hi, 5).forEach((v) => {
    g += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>` +
         `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${num(v, hi - lo < 5 ? 2 : hi - lo < 50 ? 1 : 0)}</text>`;
  });
  let lastX = -1e9;
  bars.forEach((b, i) => {
    if (new Date(b[0] * 1000).getUTCMinutes() === 0 && x(i) - lastX > 64) {
      g += `<text x="${x(i)}" y="${H - 4}" text-anchor="middle">${esc(when(b[0], "time"))}</text>`;
      lastX = x(i);
    }
  });
  bars.forEach((b, i) => {
    const up = b[4] >= b[1], col = up ? "var(--bull)" : "var(--bear)";
    const top = y(Math.max(b[1], b[4])), bot = y(Math.min(b[1], b[4]));
    g += `<line x1="${x(i)}" x2="${x(i)}" y1="${y(b[2])}" y2="${y(b[3])}" stroke="${col}" stroke-width="1"/>` +
         `<rect x="${x(i) - bw / 2}" y="${top}" width="${bw}" height="${Math.max(1, bot - top)}" fill="${col}"/>`;
  });
  const vd = ch.vwap.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join("");
  g += `<path d="${vd}" fill="none" stroke="var(--neeli)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  let legend = `<span><i class="key box" style="background:var(--bull)"></i>Up bar</span>` +
               `<span><i class="key box" style="background:var(--bear)"></i>Down bar</span>` +
               `<span><i class="key" style="background:var(--neeli)"></i>VWAP</span>`;
  if (lv) {
    [["Target", lv.target, "var(--bull)"], ["Entry", lv.entry, "var(--ink-2)"], ["Stop", lv.stop, "var(--bear)"]].forEach(([name, v, col]) => {
      g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="${col}" stroke-width="1.5"/>` +
           `<rect x="${W - m.r + 6}" y="${y(v) - 4}" width="8" height="8" fill="${col}"/>` +
           `<text class="lvl-label" x="${W - m.r + 18}" y="${y(v) + 4}">${name} ${num(v)}</text>`;
    });
    legend += `<span>${lv.held ? "Lines: Moothon's open trade" : "Lines: the trade Moothon is about to place"}</span>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ch.symbol)} five-minute price bars">${g}<g class="hov"></g></svg>`;
  el._html = null;
  setHTML($("priceLegend"), legend);

  hoverable(el, () => {
    const box = el.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.floor((el._mouse[0] - box.left - m.l) / slot)));
    const b = bars[i];
    el.querySelector(".hov").innerHTML = `<line class="cross" x1="${x(i)}" x2="${x(i)}" y1="${m.t}" y2="${H - m.b}"/>`;
    const row = (k, v) => `<div><span>${k}</span><span>${v}</span></div>`;
    showTip(`<b>${esc(ch.symbol)} ${esc(when(b[0], "time"))}</b>` + row("Open", num(b[1])) + row("High", num(b[2])) +
      row("Low", num(b[3])) + row("Close", num(b[4])) + row("VWAP", num(ch.vwap[i])) +
      row("Volume", b[5].toLocaleString("en-US")), el._mouse[0], el._mouse[1]);
  });
}

/* ---------- faces and 3D coins ---------- */
const face = (key) => `<span class="face ${key}">${AGENTS[key].letter}</span>`;
const portrait = (key) => `<div class="who"><span class="mini">${face(key)}</span><div class="nameplate"><b>${AGENTS[key].name}</b><span>trust ${Math.round(S.agents[key].trust)}</span></div></div>`;

/* ---------- the council: two pitch, Charlie weighs, Moothon rules ---------- */
let seen = { trades: null, held: null, start: null, keys: {} };

function setBubble(id, html) {
  const el = $(id);
  if (!setHTML(el, html)) return;
  el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop");
}

function react(agent, key, how) {
  // One short reaction from the 3D character when an agent's stance changes.
  const was = seen.keys[agent];
  seen.keys[agent] = key;
  if (was === undefined || was === key || !how || S.speed >= 1000) return;
  if (window.Floor) window.Floor.react(agent, how);
}

function burst(text, good) {
  const fx = $("fx");
  if (!fx || S.speed >= 1000) return;
  let html = `<span class="${good ? "up" : "down"}">${esc(text)}</span>`;
  if (good) {
    const hues = ["var(--bull)", "var(--moothon)", "var(--neeli)", "var(--charlie)", "var(--chathan)"];
    for (let i = 0; i < 26; i++) {
      const ang = Math.random() * Math.PI * 2, far = 70 + Math.random() * 130;
      html += `<i style="background:${hues[i % hues.length]};--dx:${(Math.cos(ang) * far).toFixed(0)}px;` +
        `--dy:${(Math.sin(ang) * far - 40).toFixed(0)}px;--rot:${(Math.random() * 720 - 360).toFixed(0)}deg"></i>`;
    }
  }
  fx.innerHTML = html;
  clearTimeout(fx._t);
  fx._t = setTimeout(() => { fx.innerHTML = ""; }, 2000);
}

const nums = (p) => `<div class="nums"><span>Entry<b>${num(p.entry)}</b></span><span>Stop<b>${num(p.stop)}</b></span><span>Target<b>${num(p.target)}</b></span></div>`;
const ticket = (hue, top, bottom) => `<div class="ticket" style="--hue-t:${hue}"><b>${top}</b><span>${bottom}</span></div>`;

function renderStage() {
  const A = S.agents, v = S.verdict, c = A.chathan, n = A.neeli, ch = A.charlie, acct = S.account;
  const exiting = S.positions.find((p) => p.advice.kind === "exit");

  // Chathan: always selling something
  setHTML($("st-chathan"), portrait("chathan"));
  react("chathan", c.pitch ? c.pitch.symbol : "", c.pitch ? "jump" : null);
  setBubble("bub-chathan", c.pitch
    ? `<div class="lead">${esc(c.pitch.symbol)}! ${c.pitch.conviction}% sure, let's go!</div>${nums(c.pitch)}${esc(capFirst(c.pitch.reasons.slice(0, 3).join(", ")))}.` +
      (c.count > 1 ? ` <span class="hint">+${c.count - 1} more I like.</span>` : "")
    : "Nothing is moving. Wake me when something runs.");
  setHTML($("track-chathan"), c.pitch ? ticket("var(--chathan)", esc(c.pitch.symbol), `${c.pitch.conviction}% sure`) : "");

  // Neeli: a pitch, an objection, or silence
  let says = "Watching. Nothing passes all of my checks.", tk = "", key = "", how = null;
  if (n.pitch) {
    key = "p" + n.pitch.symbol; how = "jump";
    says = `<div class="lead">${esc(n.pitch.symbol)} passes every check. ${n.pitch.conviction}% confident.</div>${nums(n.pitch)}${esc(capFirst(n.pitch.reasons.slice(0, 3).join(", ")))}.`;
    tk = ticket("var(--neeli)", esc(n.pitch.symbol), `${n.pitch.conviction}% confident`);
  } else if (n.doubt) {
    key = "d" + n.doubt.symbol; how = "shake";
    says = `<div class="lead">Not ${esc(n.doubt.symbol)} for me.</div>${esc(capFirst(n.doubt.all.slice(0, 3).join("; ")))}.`;
    tk = ticket("var(--bear)", `${ico("x")} ${esc(n.doubt.symbol)}`, "Neeli objects");
  }
  setHTML($("st-neeli"), portrait("neeli"));
  react("neeli", key, how);
  setBubble("bub-neeli", says);
  setHTML($("track-neeli"), tk);

  // Charlie: a weight on every idea
  const reviews = ch.reviews || [];
  setHTML($("st-charlie"), portrait("charlie"));
  react("charlie", reviews.map((r) => r.symbol + r.call).join(), reviews.length ? "nod" : null);
  setHTML($("weights"), reviews.length ? reviews.map((r) => {
    const take = r.confidence >= 50, left = Math.min(50, r.confidence), width = Math.abs(r.confidence - 50);
    return `<div class="weigh"><div class="weigh-top"><b>${esc(r.symbol)}</b><span class="hint">from ${r.by.map((a) => AGENTS[a].name).join(" + ")}</span>` +
      `<span class="call ${r.call === "take" ? "up" : r.call === "skip" ? "down" : "flat"}">${CALL[r.call]} ${r.confidence}%</span></div>` +
      `<div class="gauge" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${r.confidence}" aria-label="Charlie's confidence to take ${esc(r.symbol)}"><i class="${take ? "take" : "skip"}" style="left:${left}%;width:${width}%"></i></div>` +
      `<div class="gauge-ends"><span>Don't take</span><span>Take</span></div>` +
      (r.pros.length ? `<p class="up">${ico("check")}<span class="flat">${esc(capFirst(r.pros.slice(0, 2).join(", ")))}</span></p>` : "") +
      (r.cons.length ? `<p class="down">${ico("x")}<span class="flat">${esc(capFirst(r.cons.slice(0, 2).join(", ")))}</span></p>` : "") + `</div>`;
  }).join("") : '<div class="empty">Nothing on the table to weigh.</div>');
  const lead = reviews[0];
  setHTML($("track-charlie"), lead ? ticket(lead.call === "skip" ? "var(--bear)" : lead.call === "take" ? "var(--bull)" : "var(--charlie)",
    esc(lead.symbol), `${lead.confidence}% ${CALL[lead.call]}`) : "");

  // Moothon: the ruling
  const voices = (card) => {
    let out = "";
    if (card.chathan) out += `<div><span><i class="pip" style="background:var(--chathan)"></i>Chathan ${card.chathan.conviction}%</span></div>`;
    if (card.neeli) out += `<div><span><i class="pip" style="background:var(--neeli)"></i>Neeli ${card.neeli.conviction}%</span></div>`;
    else if (card.objections && card.objections.length) out += `<div><span><i class="pip" style="background:var(--neeli)"></i>Neeli objects</span>${esc(card.objections[0])}</div>`;
    if (card.charlie) out += `<div><span><i class="pip" style="background:var(--charlie)"></i>Charlie ${card.charlie.confidence}%</span>${CALL[card.charlie.call]}: score ${card.base_score} became ${card.score}</div>`;
    return out ? `<div class="voices">${out}</div>` : "";
  };
  let stamp = "", word = "Waiting for the session to start.", mkey = "", mhow = null;
  if (exiting) {
    stamp = `<div class="stamp exit">Exit ${esc(exiting.symbol)}</div>`; mkey = "x" + exiting.symbol; mhow = "nod";
    word = `<div class="lead">Get out of ${esc(exiting.symbol)}.</div>${esc(exiting.advice.text)}`;
  } else if (v && v.action === "BUY") {
    stamp = `<div class="stamp buy">Buy ${esc(v.symbol)}</div>`; mkey = "b" + v.symbol; mhow = "nod";
    word = `<div class="lead">I'm buying ${esc(v.symbol)}. Score ${v.score}, my bar is ${S.rules.take_score}.</div>${nums(v)}` +
      `${qty(v.shares)} shares, about ${cash(v.cost, cents())}. At risk if the stop is hit: ${cash(v.at_risk, cents())}.<br>${esc(v.note)}${voices(v)}`;
  } else if (v) {
    const veto = v.idea && v.idea.veto;
    stamp = veto ? `<div class="stamp pass">Pass ${esc(v.idea.symbol)}</div>` : `<div class="stamp wait">Wait</div>`;
    mkey = (veto ? "v" : "w") + (v.idea ? v.idea.symbol : "");
    word = esc(v.reason) + (v.idea ? voices(v.idea) : "");
  }
  setHTML($("st-moothon"), portrait("moothon"));
  react("moothon", mkey, mhow);
  setHTML($("stamp"), stamp);
  setBubble("bub-moothon", word);

  // Reactions to what just happened (skipped on the first look and after a restart)
  const held = S.positions.map((p) => p.symbol).sort().join(",");
  if (seen.start === acct.start_cash && seen.trades !== null && acct.n >= seen.trades) {
    if (acct.n > seen.trades && S.trades.length) {
      const t = S.trades[0], won = t.pnl >= 0;
      burst(`${t.symbol} ${scash(t.pnl)}`, won);
      if (window.Floor) window.Floor.react("moothon", won ? "jump" : "shake");
    } else if (held !== seen.held && held.length > (seen.held || "").length) {
      const fresh = S.positions.find((p) => !(seen.held || "").split(",").includes(p.symbol));
      if (fresh) burst("Bought " + fresh.symbol, true);
    }
  }
  seen.trades = acct.n; seen.held = held; seen.start = acct.start_cash;
}

/* ---------- trust scores ---------- */
function sparkline(hist, hue) {
  if (!hist || hist.length < 2) return '<div class="spark"></div>';
  const W = 120, H = 28;
  const lo = Math.min(42, ...hist) - 2, hi = Math.max(58, ...hist) + 2;
  const x = (i) => 3 + (W - 6) * i / (hist.length - 1);
  const y = (v) => 3 + (H - 6) * (1 - (v - lo) / (hi - lo));
  const d = hist.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join("");
  return `<div class="spark" title="Trust score over time. The thin line is the neutral 50."><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
    `<line x1="0" x2="${W}" y1="${y(50)}" y2="${y(50)}" stroke="var(--axis)" stroke-width="1" vector-effect="non-scaling-stroke"/>` +
    `<path d="${d}" fill="none" stroke="${hue}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg></div>`;
}

function renderScoreboard() {
  const A = S.agents;
  const note = {
    chathan: `Moothon took ${A.chathan.taken || 0} of his picks`,
    neeli: `Moothon took ${A.neeli.taken || 0} of her picks`,
    charlie: "Scored as if he bet his confidence on each call",
    moothon: `${A.moothon.good || 0} good passes, ${A.moothon.missed || 0} missed winners`,
  };
  const unit = { chathan: "picks", neeli: "picks", charlie: "calls", moothon: "trades" };
  setHTML($("scoreboard"), `<table><thead><tr><th>Agent</th><th>Trust</th><th>Trend</th><th class="num">Finished</th>
    <th class="num">Won</th><th class="num">Average</th><th>Notes</th></tr></thead><tbody>` + ORDER.map((k) => {
    const a = A[k], m = AGENTS[k];
    return `<tr data-agent="${k}"><td><div class="agent-cell"><span class="mini">${face(k)}</span><div><b>${m.name}</b><small>${m.tag}</small></div></div></td>
      <td><div class="trust-cell"><b>${Math.round(a.trust)}</b><div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(a.trust)}" aria-label="${m.name} trust score"><i style="width:${a.trust}%"></i></div></div></td>
      <td>${sparkline(a.history, m.hue)}</td>
      <td class="num">${a.n} ${unit[k]}</td>
      <td class="num">${a.n ? Math.round(a.win_rate * 100) + "%" : "n/a"}</td>
      <td class="num ${a.n ? cls(a.avg_r) : ""}">${a.n ? sr(a.avg_r) : "n/a"}</td>
      <td class="why">${note[k]}</td></tr>`;
  }).join("") + "</tbody></table>");
}

/* ---------- the rest ---------- */
function renderHero() {
  const a = S.account;
  const hero = document.querySelector(".hero");
  hero.classList.toggle("is-up", a.pnl > 0.000001);
  hero.classList.toggle("is-down", a.pnl < -0.000001);
  $("equity").textContent = cash(a.equity);
  setHTML($("equityDelta"), `<span class="${cls(a.pnl)}">${arrow(a.pnl)}${scash(a.pnl)} (${spct(a.pnl_pct)})</span> <span class="hint">since the start</span>`);
  const b = a.bench - a.start_cash;
  setHTML($("equitySub"), `Started with ${cash(a.start_cash, 0)}. Just holding ${esc(S.rules.benchmark)} instead: ${cash(a.bench)} ` +
    `<span class="${cls(b)}">(${spct(a.start_cash ? b / a.start_cash : 0)})</span>`);
}

function renderKpis() {
  const a = S.account;
  const cell = (label, value, note, c) => `<div class="cell"><div class="label">${label}</div><div class="value ${c || ""}">${value}</div><div class="note">${note}</div></div>`;
  setHTML($("kpis"), [
    cell("Today", `${arrow(a.pnl_today)}${scash(a.pnl_today)}`, spct(a.pnl_today_pct) + " on the day", cls(a.pnl_today)),
    cell("Win rate", a.n ? Math.round(a.win_rate * 100) + "%" : "n/a", a.n ? `${a.wins} won, ${a.losses} lost` : "no closed trades yet"),
    cell("Average trade", a.n ? sr(a.avg_r) : "n/a", "profit as a multiple of the risk", a.n ? cls(a.avg_r) : ""),
    cell("Profit factor", a.profit_factor == null ? "n/a" : num(a.profit_factor), "won per unit lost"),
    cell("Worst dip", "-" + num(a.max_dd * 100) + "%", "largest fall from a peak"),
    cell("Cash", cash(a.cash, cents()), `${cash(a.invested, cents())} invested`),
  ].join(""));
}

function renderBoard() {
  const W = S.watch, shown = S.chart ? S.chart.symbol : null;
  const c = S.agents.chathan.pitch, n = S.agents.neeli.pitch;
  const top = Math.max(0.005, ...W.map((w) => Math.abs(w.chg)));
  const tile = (w, i, bear) => {
    let marks = "";
    if (w.held) marks += `<em style="--m:var(--moothon)">Held</em>`;
    if (c && c.symbol === w.symbol) marks += `<em style="--m:var(--chathan)">Chathan</em>`;
    if (n && n.symbol === w.symbol) marks += `<em style="--m:var(--neeli)">Neeli</em>`;
    return `<button type="button" class="tile ${bear ? "bear" : ""} ${w.symbol === shown ? "on" : ""}" data-sym="${esc(w.symbol)}">
      <span class="sym">${esc(w.symbol)}<small>${String(i + 1).padStart(2, "0")}</small></span>
      <span class="chg">${spct(w.chg)}</span>
      <span class="marks">${marks || (w.relvol ? num(w.relvol, 1) + "x vol" : "")}</span>
      <span class="bar"><i style="width:${Math.max(4, Math.abs(w.chg) / top * 100).toFixed(0)}%"></i></span></button>`;
  };
  const bulls = W.filter((w) => w.chg >= 0), bears = W.filter((w) => w.chg < 0).reverse();
  const tally = `<span>Bullish<b class="up">${bulls.length}</b></span><span>Bearish<b class="down">${bears.length}</b></span>`;
  setHTML($("tally"), tally); setHTML($("tally2"), tally);
  setHTML($("tiles-bull"), bulls.length ? bulls.map((w, i) => tile(w, i, false)).join("") : '<div class="empty">Nothing is up today.</div>');
  setHTML($("tiles-bear"), bears.length ? bears.map((w, i) => tile(w, i, true)).join("") : '<div class="empty">Nothing is down today.</div>');
}

function renderPositions() {
  const ps = S.positions;
  $("posHint").textContent = `${ps.length} of ${S.rules.max_positions} slots used`;
  if (!ps.length) {
    setHTML($("positions"), '<div class="empty">Moothon is holding cash. When he invests, the position and his exit advice show up here.</div>');
    return;
  }
  setHTML($("positions"), ps.map((p) => {
    const span = p.target - p.stop;
    const at = Math.max(0, Math.min(100, (p.last - p.stop) / span * 100));
    const entry = Math.max(0, Math.min(100, (p.entry - p.stop) / span * 100));
    const exit = p.advice.kind === "exit";
    return `<div class="pos">
      <div class="pos-top"><span class="sym">${esc(p.symbol)}</span><span class="pnl ${cls(p.pnl)}">${arrow(p.pnl)}${scash(p.pnl)} (${sr(p.r)})</span></div>
      <div class="pos-meta"><span>${qty(p.shares)} shares, ${cash(p.value, cents())}</span><span>in at ${num(p.entry)}, now ${num(p.last)}</span>
        <span>since ${esc(when(p.t, "time"))}</span><span>backed by ${BASIS[p.basis] || esc(p.basis)}</span></div>
      <div class="range" style="--entry:${entry}%" title="Where the price sits between the stop and the target"></div>
      <div class="range-mark"><i style="left:${at}%"></i></div>
      <div class="range-labels"><span>Stop ${num(p.stop)}</span><span>Target ${num(p.target)}</span></div>
      <div class="advice"><span class="tag ${exit ? "bear" : "dim"}">${exit ? "Exit now" : "Hold"}</span><span>${esc(p.advice.text)}</span></div>
    </div>`;
  }).join(""));
}

function renderTrades() {
  const ts = S.trades, a = S.account;
  $("tradeHint").textContent = a.n ? `${a.n} trades, ${scash(a.realized)} realized` : "";
  if (!ts.length) { setHTML($("trades"), '<div class="empty">No closed trades yet.</div>'); return; }
  setHTML($("trades"), `<table><thead><tr><th>Closed</th><th>Stock</th><th class="num">Shares</th><th class="num">In</th>
    <th class="num">Out</th><th class="num">Profit</th><th class="num">R</th><th>Backed by</th><th>Why it closed</th></tr></thead><tbody>` +
    ts.map((t) => `<tr><td>${esc(when(t.t_out, "stamp"))}</td><td><b>${esc(t.symbol)}</b></td><td class="num">${qty(t.shares)}</td>
      <td class="num">${num(t.entry)}</td><td class="num">${num(t.exit)}</td>
      <td class="num ${cls(t.pnl)}">${scash(t.pnl)}</td><td class="num ${cls(t.r)}">${sr(t.r)}</td>
      <td>${BASIS[t.basis] || esc(t.basis)}</td><td class="why">${esc(t.reason)}</td></tr>`).join("") + "</tbody></table>");
}

let feedTop = 0;
function msgHTML(m, fresh) {
  const known = AGENTS[m.who] && m.who !== "system";
  const who = AGENTS[m.who] || AGENTS.system;
  const pic = known ? `<span class="mini">${face(m.who)}</span>` : `<i class="pip"></i>`;
  return `<div class="msg ${esc(m.kind)} ${fresh ? "new" : ""}" ${known ? `data-agent="${esc(m.who)}"` : ""}>${pic}<div>
    <div class="meta"><b>${who.name}</b>${esc(when(m.t, "stamp"))}</div><p>${esc(m.text)}</p></div></div>`;
}

function renderFeed() {
  // Live comms: new lines slide in at the top; nothing already on screen is redrawn.
  const f = S.feed, el = $("feed");
  if (!f.length) { el.innerHTML = '<div class="empty">Quiet so far.</div>'; feedTop = 0; return; }
  if (f[0].id < feedTop || !feedTop) { el.innerHTML = f.map((m) => msgHTML(m, false)).join(""); feedTop = f[0].id; return; }
  const fresh = f.filter((m) => m.id > feedTop).reverse();
  fresh.forEach((m) => el.insertAdjacentHTML("afterbegin", msgHTML(m, S.speed < 1000)));
  while (el.children.length > 90) el.lastChild.remove();
  feedTop = f[0].id;
}

function renderTape() {
  // The price tape: built once per watchlist, then each price is updated in place so the scroll never jumps.
  const run = $("tapeRun"), W = S.watch.slice().sort((a, b) => a.symbol.localeCompare(b.symbol));
  const key = W.map((w) => w.symbol).join();
  if (run._key !== key) {
    run._key = key;
    const one = W.map((w) => `<span data-sym="${esc(w.symbol)}"><b>${esc(w.symbol)}</b><em></em><i></i></span>`).join("");
    run.innerHTML = one + one;
  }
  W.forEach((w) => {
    run.querySelectorAll(`[data-sym="${w.symbol}"]`).forEach((el) => {
      const px = num(w.last), was = el.children[1].textContent;
      if (was !== px) {
        el.children[1].textContent = px;
        if (was && S.speed < 30) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
      }
      el.children[2].textContent = spct(w.chg);
      el.children[2].className = cls(w.chg);
    });
  });
}

function renderMinds() {
  const B = S.brain;
  if (!B) return;
  const lean = (rows) => rows.map((r) => `${r.weight > 1 ? "more" : "less"} on ${esc(r.what)} (${num(r.weight, 1)}x)`).join("; ");
  const heed = (rows) => rows.map((r) => `${esc(r.what)} ${r.weight > 1 ? "more" : "less"} (${num(r.weight, 1)}x)`).join("; ");
  const mind = {
    chathan: `Needs ${B.chathan.bar} points to pitch (started at 35). ` + (B.chathan.weights.length ? "Leans " + lean(B.chathan.weights) + "." : "No signal has stood out yet."),
    neeli: B.neeli.waived.length ? "Dropped: " + B.neeli.waived.map(esc).join("; ") + "." : "All of her checks are still in force.",
    charlie: B.charlie.weights.length ? "Now weighs " + heed(B.charlie.weights) + "." : "Still weighing every factor as he started.",
    moothon: `Buys at score ${B.moothon.bar} or above (started at ${B.moothon.start}).`,
  };
  $("lessonHint").textContent = B.count ? `${B.count} lessons so far` : "Nothing learned yet: they need finished calls first";
  setHTML($("minds"), `<div class="minds">` + ORDER.map((k) => `<div class="mind" data-agent="${k}"><b>${AGENTS[k].name}</b><p>${mind[k]}</p></div>`).join("") + `</div>`);
  setHTML($("lessons"), B.lessons.length ? B.lessons.map((l) => msgHTML({ who: l.who, kind: "learn", t: l.t, text: l.text }, false)).join("")
    : '<div class="empty">When an agent changes how it works, the reason shows up here.</div>');
}

function renderTop() {
  const st = S.status, c = S.clock || {};
  const clock = when(c.t, "full");
  let text = S.message || "Loading";
  if (st === "replay") text = `Replay ${clock ? "/ " + clock : ""}${S.paused ? " / paused" : ""}`;
  if (st === "live") text = `Live / last bar ${clock}`;
  if (st === "closed") text = `Market closed / last bar ${clock}`;
  if (S.skipped && S.skipped.length && st !== "loading") text += ` / no data for ${S.skipped.join(", ")}`;
  $("status").className = "status " + st;
  $("statusText").textContent = text;
  $("playBtn").textContent = S.paused ? "Play" : "Pause";
  document.querySelectorAll("#speedSeg button").forEach((b) => b.classList.toggle("on", Number(b.dataset.speed) === S.speed));
  $("progressBar").style.width = (st === "replay" && c.total ? Math.round(100 * c.done / c.total) : 0) + "%";
}

function render() {
  renderTop();
  const ready = !!S.account;
  $("app").hidden = !ready;
  $("splash").hidden = ready;
  if (!ready) { $("splashText").textContent = S.message || "Loading"; return; }
  if (!render.seeded) {   // show the running account's own start in the restart box, once
    render.seeded = true;
    $("cashInput").value = Math.round(S.account.start_cash / MONEY().rate);
    $("sessionsInput").value = String(S.sessions_back);
    $("cashLabel").textContent = "Virtual cash (" + MONEY().symbol + ")";
  }
  renderHero(); renderKpis(); renderStage(); renderBoard(); renderPositions(); renderScoreboard(); renderTrades(); renderFeed();
  renderTape(); renderMinds();
  drawCurve(); drawPrice();
  if (window.Floor) window.Floor.update(S, focus);
}

/* ---------- wiring ---------- */
async function poll() {
  try {
    const r = await fetch("/api/state" + (focus ? "?symbol=" + encodeURIComponent(focus) : ""));
    S = await r.json();
    render();
  } catch (e) {
    $("status").className = "status error";
    $("statusText").textContent = "Lost contact with the server. Is server.py still running?";
  }
}
async function control(body) {
  const r = await fetch("/api/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); alert(e.error || "That did not work."); }
  poll();
}

$("playBtn").addEventListener("click", () => control({ action: S && S.paused ? "play" : "pause" }));
$("speedSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (b) control({ action: "speed", value: Number(b.dataset.speed) });
});
$("restartForm").addEventListener("submit", (e) => {
  e.preventDefault();
  control({ action: "restart", cash: Number($("cashInput").value), sessions: Number($("sessionsInput").value) });
});
document.querySelector(".board").addEventListener("click", (e) => {
  const b = e.target.closest(".tile"); if (!b) return;
  focus = b.dataset.sym || null; poll();
});
$("followBtn").addEventListener("click", () => { focus = null; poll(); });
window.addEventListener("floor:pick", (e) => { focus = e.detail || null; poll(); });
window.addEventListener("resize", () => { if (S && S.account) { drawCurve(); drawPrice(); } });

// The coins lean toward the pointer while it is over the council.
(function tilt() {
  const stage = $("stage");
  let raf = 0;
  stage.addEventListener("mousemove", (e) => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const b = stage.getBoundingClientRect();
      stage.style.setProperty("--ry", (((e.clientX - b.left) / b.width - 0.5) * 26).toFixed(1) + "deg");
      stage.style.setProperty("--rx", ((0.5 - (e.clientY - b.top) / b.height) * 16).toFixed(1) + "deg");
    });
  });
  stage.addEventListener("mouseleave", () => { stage.style.removeProperty("--ry"); stage.style.removeProperty("--rx"); });
})();

// Use the agents' pictures if they are installed; otherwise the initials stay.
ORDER.forEach((key) => {
  const img = new Image();
  img.onload = () => document.documentElement.classList.add("has-" + key);
  img.src = "/avatars/" + key + ".jpg";
});

(function loop() { poll().finally(() => setTimeout(loop, 800)); })();
