"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const AGENTS = {
  chathan: { name: "Chathan", tag: "Always eager to invest", letter: "C", hue: "var(--chathan)" },
  neeli: { name: "Neeli", tag: "Takes calculated risk", letter: "N", hue: "var(--neeli)" },
  moothon: { name: "Moothon", tag: "The deciding judge", letter: "M", hue: "var(--moothon)" },
  system: { name: "Market", hue: "var(--muted)" },
};
const BASIS = { both: "Both", neeli: "Neeli", chathan: "Chathan" };

let S = null;        // latest state from the server
let focus = null;    // symbol the price chart is pinned to (null = follow Moothon)
let fmtCache = {};

/* ---------- formatting ---------- */
const num = (x, d = 2) => Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (x, d = 2) => (x < 0 ? "-$" : "$") + num(x, d);
const susd = (x, d = 2) => (x < 0 ? "-$" : "+$") + num(x, d);
const spct = (x, d = 2) => (x < 0 ? "-" : "+") + num(x * 100, d) + "%";
const sr = (x) => (x < 0 ? "-" : "+") + num(x, 2) + "R";
// Account money is held in dollars by the server and shown in the account's currency.
const MONEY = () => (S && S.money) || { symbol: "$", rate: 1 };
const cents = () => (S && S.account && S.account.start_cash / MONEY().rate < 10000 ? 2 : 0);
const cash = (x, d = 2) => (x < 0 ? "-" : "") + MONEY().symbol + num(x / MONEY().rate, d);
const scash = (x, d = 2) => (x < 0 ? "-" : "+") + MONEY().symbol + num(x / MONEY().rate, d);
const qty = (x) => Number(x).toLocaleString("en-US", { maximumFractionDigits: 4 });
const cls = (x) => (x > 0.000001 ? "up" : x < -0.000001 ? "down" : "flat");
const arrow = (x) => (x > 0.000001 ? "▲" : x < -0.000001 ? "▼" : "■");
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
  if (el._html !== html) { el.innerHTML = html; el._html = html; }
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
  const series = [
    { name: "Moothon's portfolio", color: "var(--moothon)", vals: curve.map((c) => c[1] / rate), w: 2 },
    { name: "Just holding " + S.rules.benchmark, color: "var(--muted)", vals: curve.map((c) => c[2] / rate), w: 1.5 },
  ];
  let lo = Infinity, hi = -Infinity;
  series.forEach((s) => s.vals.forEach((v) => { lo = Math.min(lo, v); hi = Math.max(hi, v); }));
  const pad = Math.max((hi - lo) * 0.08, hi * 0.0005);
  lo -= pad; hi += pad;
  const m = { l: 56, r: 12, t: 6, b: 20 };
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
    if (key !== prev && key && x(i) - lastX > 64 && x(i) < W - m.r - 30) {
      g += `<text x="${x(i)}" y="${H - 4}">${esc(key)}</text>`;
      lastX = x(i);
    }
    prev = key;
  });
  series.slice().reverse().forEach((s) => {
    const d = s.vals.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join("");
    g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.w}" stroke-linejoin="round" stroke-linecap="round"/>`;
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
  if (!ch || !ch.bars.length) {
    setHTML(el, '<div class="empty">No bars yet for this session.</div>');
    setHTML($("priceLegend"), ""); setHTML($("chartTitle"), "Price");
    return;
  }
  const bars = ch.bars, n = bars.length, lv = ch.levels;
  const last = bars[n - 1][4];
  const chg = ch.prev_close ? last / ch.prev_close - 1 : 0;
  setHTML($("chartTitle"), `${esc(ch.symbol)} <span class="hint">${usd(last)} <span class="${cls(chg)}">${arrow(chg)} ${spct(chg)}</span> today, 5-minute bars</span>`);
  let lo = Infinity, hi = -Infinity;
  bars.forEach((b) => { lo = Math.min(lo, b[3]); hi = Math.max(hi, b[2]); });
  if (lv) { lo = Math.min(lo, lv.stop); hi = Math.max(hi, lv.target); }
  const pad = Math.max((hi - lo) * 0.07, last * 0.0005);
  lo -= pad; hi += pad;
  const m = { l: 52, r: lv ? 104 : 12, t: 6, b: 20 };
  const slots = Math.max(n, 78);
  const slot = (W - m.l - m.r) / slots;
  const x = (i) => m.l + slot * (i + 0.5);
  const y = (v) => m.t + (H - m.t - m.b) * (1 - (v - lo) / (hi - lo));
  const bw = Math.max(2, Math.min(10, slot * 0.68));
  let g = "";
  niceTicks(lo, hi, 5).forEach((v) => {
    g += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>` +
         `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${num(v, hi - lo < 5 ? 2 : hi - lo < 50 ? 1 : 0)}</text>`;
  });
  let lastX = -1e9;
  bars.forEach((b, i) => {
    if (new Date(b[0] * 1000).getUTCMinutes() === 0 && x(i) - lastX > 56) {
      g += `<text x="${x(i)}" y="${H - 4}" text-anchor="middle">${esc(when(b[0], "time"))}</text>`;
      lastX = x(i);
    }
  });
  bars.forEach((b, i) => {
    const up = b[4] >= b[1], col = up ? "var(--good)" : "var(--bad)";
    const top = y(Math.max(b[1], b[4])), bot = y(Math.min(b[1], b[4]));
    g += `<line x1="${x(i)}" x2="${x(i)}" y1="${y(b[2])}" y2="${y(b[3])}" stroke="${col}" stroke-width="1"/>` +
         `<rect x="${x(i) - bw / 2}" y="${top}" width="${bw}" height="${Math.max(1, bot - top)}" rx="1" fill="${col}"/>`;
  });
  const vd = ch.vwap.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join("");
  g += `<path d="${vd}" fill="none" stroke="var(--neeli)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  let legend = `<span><i class="key box" style="background:var(--good)"></i>Up bar</span>` +
               `<span><i class="key box" style="background:var(--bad)"></i>Down bar</span>` +
               `<span><i class="key" style="background:var(--neeli)"></i>VWAP</span>`;
  if (lv) {
    [["Target", lv.target, "var(--good)"], ["Entry", lv.entry, "var(--ink-2)"], ["Stop", lv.stop, "var(--bad)"]].forEach(([name, v, col]) => {
      g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="${col}" stroke-width="1.5"/>` +
           `<rect x="${W - m.r + 6}" y="${y(v) - 4}" width="8" height="8" rx="2" fill="${col}"/>` +
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

/* ---------- pieces ---------- */
function trustLabel(t) {
  return t >= 65 ? "High" : t >= 55 ? "Good" : t >= 45 ? "Neutral" : t >= 35 ? "Low" : "Poor";
}

function sparkline(hist, hue) {
  if (!hist || hist.length < 2) return '<div class="spark"></div>';
  const W = 240, H = 34;
  const lo = Math.min(42, ...hist) - 2, hi = Math.max(58, ...hist) + 2;
  const x = (i) => 4 + (W - 8) * i / (hist.length - 1);
  const y = (v) => 3 + (H - 6) * (1 - (v - lo) / (hi - lo));
  const d = hist.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join("");
  return `<div class="spark" title="Trust score over time. The thin line is the neutral 50."><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
    `<line x1="0" x2="${W}" y1="${y(50)}" y2="${y(50)}" stroke="var(--grid)" stroke-width="1" vector-effect="non-scaling-stroke"/>` +
    `<path d="${d}" fill="none" stroke="${hue}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg></div>`;
}

function agentHead(key, a) {
  const meta = AGENTS[key];
  return `<div class="who"><div class="avatar">${meta.letter}</div><div><h3>${meta.name}</h3><p>${meta.tag}</p></div></div>
    <div class="trust">
      <div class="num">${Math.round(a.trust)}<small> /100</small></div>
      <div class="cap"><span>Trust score</span><b>${trustLabel(a.trust)}</b></div>
      <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(a.trust)}" aria-label="${meta.name} trust score"><i style="width:${a.trust}%"></i></div>
    </div>${sparkline(a.history, meta.hue)}`;
}

function recordLine(a, word, extra) {
  if (!a.n) return `<div class="record"><span>No finished ${word} yet</span>${extra || ""}</div>`;
  return `<div class="record"><span><b>${a.n}</b> ${word}</span><span><b>${Math.round(a.win_rate * 100)}%</b> won</span>` +
    `<span>average <b class="${cls(a.avg_r)}">${sr(a.avg_r)}</b></span>${extra || ""}</div>`;
}

function planBox(p) {
  return `<div class="plan"><div><span>Entry</span><b>${num(p.entry)}</b></div>` +
    `<div><span>Stop</span><b>${num(p.stop)}</b></div><div><span>Target</span><b>${num(p.target)}</b></div></div>`;
}

function reasons(list) {
  return list && list.length ? "<ul>" + list.map((r) => `<li>${esc(r)}</li>`).join("") + "</ul>" : "";
}

function renderAgents() {
  const A = S.agents;
  const c = A.chathan, n = A.neeli, mo = A.moothon, v = S.verdict;

  let say;
  if (c.pitch) {
    say = `<div class="line">Buy ${esc(c.pitch.symbol)}. I'm ${c.pitch.conviction}% sure!</div>${planBox(c.pitch)}${reasons(c.pitch.reasons)}` +
      (c.count > 1 ? `<p class="quiet" style="margin-top:8px">And ${c.count - 1} more I like right now.</p>` : "");
  } else {
    say = `<p class="quiet">Nothing is moving enough right now. Even for me.</p>`;
  }
  setHTML($("agent-chathan"), agentHead("chathan", c) +
    recordLine(c, "calls", `<span>Moothon took <b>${c.taken || 0}</b></span>`) + `<div class="say">${say}</div>`);

  if (n.pitch) {
    say = `<div class="line">${esc(n.pitch.symbol)} passes every check. ${n.pitch.conviction}% confident.</div>${planBox(n.pitch)}${reasons(n.pitch.reasons)}`;
  } else {
    say = `<p class="quiet">Sitting out. Nothing passes all of my checks.</p>` +
      (n.doubt ? `<div class="line" style="margin-top:10px">On Chathan's ${esc(n.doubt.symbol)}:</div>${reasons(n.doubt.all)}` : "");
  }
  setHTML($("agent-neeli"), agentHead("neeli", n) +
    recordLine(n, "calls", `<span>Moothon took <b>${n.taken || 0}</b></span>`) + `<div class="say">${say}</div>`);

  const voices = (card) => {
    let out = "";
    if (card.chathan) out += `<div><span><i class="pip" style="background:var(--chathan)"></i>Chathan ${card.chathan.conviction}%</span>${esc(card.chathan.reasons.slice(0, 3).join(", "))}</div>`;
    if (card.neeli) out += `<div><span><i class="pip" style="background:var(--neeli)"></i>Neeli ${card.neeli.conviction}%</span>${esc(card.neeli.reasons.slice(0, 3).join(", "))}</div>`;
    else if (card.objections && card.objections.length) out += `<div><span><i class="pip" style="background:var(--neeli)"></i>Neeli objects</span>${esc(card.objections.slice(0, 2).join("; "))}</div>`;
    return out ? `<div class="voices">${out}</div>` : "";
  };
  if (!v) {
    say = `<p class="quiet">Waiting for the session to start.</p>`;
  } else if (v.action === "BUY") {
    say = `<div class="verdict"><span class="badge buy">BUY</span><span class="sym">${esc(v.symbol)}</span>` +
      `<span class="hint">score ${v.score}, my bar is ${S.rules.take_score}</span></div>` +
      `<p class="quiet">${esc(v.reason)}</p>${planBox(v)}` +
      `<p class="quiet"><b>${qty(v.shares)}</b> shares, about ${cash(v.cost, cents())}. At risk if the stop is hit: ${cash(v.at_risk, cents())}.</p>` +
      `<p class="quiet" style="margin-top:6px">${esc(v.note)}</p>${voices(v)}`;
  } else {
    say = `<div class="verdict"><span class="badge wait">WAIT</span></div><p class="quiet">${esc(v.reason)}</p>`;
    if (v.idea) {
      say += `<div class="line" style="margin-top:12px">Closest idea: ${esc(v.idea.symbol)}, score ${v.idea.score}</div>${voices(v.idea)}`;
    }
  }
  const passes = `<span>good passes <b>${mo.good || 0}</b></span><span>missed winners <b>${mo.missed || 0}</b></span>`;
  setHTML($("agent-moothon"), agentHead("moothon", mo) + recordLine(mo, "trades", passes) + `<div class="say">${say}</div>`);
}

function renderHero() {
  const a = S.account;
  $("equity").textContent = cash(a.equity);
  setHTML($("equityDelta"), `<span class="${cls(a.pnl)}">${arrow(a.pnl)} ${scash(a.pnl)} (${spct(a.pnl_pct)})</span> <span class="hint">since the start</span>`);
  const b = a.bench - a.start_cash;
  setHTML($("equitySub"), `Started with ${cash(a.start_cash, 0)}. Just holding ${esc(S.rules.benchmark)} instead: ${cash(a.bench)} ` +
    `<span class="${cls(b)}">(${spct(a.start_cash ? b / a.start_cash : 0)})</span>`);
}

function renderKpis() {
  const a = S.account;
  const tile = (label, value, note, c) => `<div class="tile"><div class="label">${label}</div><div class="value ${c || ""}">${value}</div><div class="note">${note}</div></div>`;
  setHTML($("kpis"), [
    tile("Today", `${arrow(a.pnl_today)} ${scash(a.pnl_today)}`, spct(a.pnl_today_pct) + " on the day", cls(a.pnl_today)),
    tile("Win rate", a.n ? Math.round(a.win_rate * 100) + "%" : "n/a", a.n ? `${a.wins} won, ${a.losses} lost` : "no closed trades yet"),
    tile("Average trade", a.n ? sr(a.avg_r) : "n/a", "profit as a multiple of the risk", a.n ? cls(a.avg_r) : ""),
    tile("Profit factor", a.profit_factor == null ? "n/a" : num(a.profit_factor), "dollars won per dollar lost"),
    tile("Worst dip", "-" + num(a.max_dd * 100) + "%", "largest fall from a peak"),
    tile("Cash", cash(a.cash, cents()), `${cash(a.invested, cents())} invested`),
  ].join(""));
}

function renderPositions() {
  const ps = S.positions;
  $("posHint").textContent = `${ps.length} of ${S.rules.max_positions} slots used`;
  if (!ps.length) {
    setHTML($("positions"), '<div class="empty" style="height:140px">Moothon is holding cash. When he invests, the position and his exit advice show up here.</div>');
    return;
  }
  setHTML($("positions"), ps.map((p) => {
    const span = p.target - p.stop;
    const at = Math.max(0, Math.min(100, (p.last - p.stop) / span * 100));
    const entry = Math.max(0, Math.min(100, (p.entry - p.stop) / span * 100));
    const exit = p.advice.kind === "exit";
    return `<div class="pos">
      <div class="pos-top"><span class="sym">${esc(p.symbol)}</span><span class="pnl ${cls(p.pnl)}">${arrow(p.pnl)} ${scash(p.pnl)} (${sr(p.r)})</span></div>
      <div class="pos-meta"><span>${qty(p.shares)} shares, ${cash(p.value, cents())}</span><span>in at ${num(p.entry)}, now ${num(p.last)}</span>
        <span>since ${esc(when(p.t, "time"))}</span><span>backed by ${BASIS[p.basis] || p.basis}</span></div>
      <div class="range" style="--entry:${entry}%" title="Where the price sits between the stop and the target"><i style="left:${at}%"></i></div>
      <div class="range-labels"><span>Stop ${num(p.stop)}</span><span>Target ${num(p.target)}</span></div>
      <div class="advice"><span class="badge ${exit ? "exit" : "hold"}">${exit ? "EXIT NOW" : "HOLD"}</span><span>${esc(p.advice.text)}</span></div>
    </div>`;
  }).join(""));
}

function renderTrades() {
  const ts = S.trades, a = S.account;
  $("tradeHint").textContent = a.n ? `${a.n} trades, ${scash(a.realized)} realized` : "";
  if (!ts.length) { setHTML($("trades"), '<div class="empty" style="height:120px">No closed trades yet.</div>'); return; }
  setHTML($("trades"), `<table><thead><tr><th>Closed</th><th>Stock</th><th class="num">Shares</th><th class="num">In</th>
    <th class="num">Out</th><th class="num">Profit</th><th class="num">R</th><th>Backed by</th><th>Why it closed</th></tr></thead><tbody>` +
    ts.map((t) => `<tr><td>${esc(when(t.t_out, "stamp"))}</td><td><b>${esc(t.symbol)}</b></td><td class="num">${qty(t.shares)}</td>
      <td class="num">${num(t.entry)}</td><td class="num">${num(t.exit)}</td>
      <td class="num ${cls(t.pnl)}">${scash(t.pnl)}</td><td class="num ${cls(t.r)}">${sr(t.r)}</td>
      <td>${BASIS[t.basis] || esc(t.basis)}</td><td class="why">${esc(t.reason)}</td></tr>`).join("") + "</tbody></table>");
}

function renderFeed() {
  const f = S.feed;
  if (!f.length) { setHTML($("feed"), '<div class="empty" style="height:120px">Quiet so far.</div>'); return; }
  setHTML($("feed"), f.map((m) => {
    const who = AGENTS[m.who] || AGENTS.system;
    return `<div class="msg ${esc(m.kind)}"><i class="pip" style="background:${who.hue}"></i><div>
      <div class="meta"><b>${who.name}</b>${esc(when(m.t, "stamp"))}</div><p>${esc(m.text)}</p></div></div>`;
  }).join(""));
}

function renderWatch() {
  const shown = S.chart ? S.chart.symbol : null;
  setHTML($("watch"), `<button class="chip ${focus ? "" : "on"}" data-sym="">Follow Moothon</button>` + S.watch.map((w) =>
    `<button class="chip ${w.symbol === shown && focus ? "on" : ""} ${w.held ? "held" : ""}" data-sym="${esc(w.symbol)}" title="${w.held ? "Moothon holds this" : ""}">
      <b>${esc(w.symbol)}</b><span class="${cls(w.chg)}">${spct(w.chg, 1)}</span></button>`).join(""));
}

function renderTop() {
  const st = S.status, c = S.clock || {};
  const clock = when(c.t, "full");
  let text = S.message || "Loading";
  if (st === "replay") text = `Replay ${clock ? "at " + clock : ""}${S.paused ? " (paused)" : ""}`;
  if (st === "live") text = `Live, last bar ${clock}`;
  if (st === "closed") text = `Market closed, last bar ${clock}`;
  if (S.skipped && S.skipped.length && st !== "loading") text += `. No data for ${S.skipped.join(", ")}`;
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
  renderHero(); renderKpis(); renderAgents(); renderPositions(); renderTrades(); renderFeed(); renderWatch();
  drawCurve(); drawPrice();
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
$("watch").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  focus = b.dataset.sym || null; poll();
});
window.addEventListener("resize", () => { if (S && S.account) { drawCurve(); drawPrice(); } });

(function loop() { poll().finally(() => setTimeout(loop, 800)); })();
