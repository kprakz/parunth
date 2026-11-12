"""The simulation: one 5-minute bar at a time, never looking ahead.

At the close of each bar the agents see only bars that have finished. Whatever
Moothon decides is filled at the NEXT bar's open, plus slippage. Stops and
targets are checked against each bar's low and high; if one bar touches both,
the stop is assumed to have come first.

The same loop serves replay (bars already downloaded) and live (bars added as
they finish), so what you watch in a replay is what live trading would do.
"""
import bisect
import datetime
import math
import threading
from zoneinfo import ZoneInfo

from . import agents
from .indicators import day_context, features
from .learning import Brain
from .scoring import book_stats, record, trust_score

BAR = 300
AGENTS = ("chathan", "neeli", "charlie", "moothon")


def usd(x):
    return ("-$%s" if x < 0 else "$%s") % format(abs(x), ",.2f")


def qty(shares):
    return ("%.4f" % shares).rstrip("0").rstrip(".")


def cap(s):
    return s[:1].upper() + s[1:]


class Engine:
    def __init__(self, cfg):
        self.cfg = cfg
        self.tz = ZoneInfo(cfg["timezone"])
        self.symbols = list(cfg["symbols"])
        self.bench = cfg["benchmark"]
        self.lock = threading.RLock()
        # Everything inside the engine is in dollars, like the prices. An account
        # in another currency is converted once, at fx dollars per unit.
        self.fx = float(cfg.get("fx_rate") or 1.0)
        self.cur = cfg.get("currency_symbol") or "$"
        self._dates = {}
        self.intra, self.at, self.bydate, self.daily = {}, {}, {}, {}
        self.timeline = []
        self.start_idx = 0
        self.reset_book(cfg["start_cash"])

    # ------------------------------------------------------------------ data

    def date_of(self, t):
        d = self._dates.get(t)
        if d is None:
            d = self._dates[t] = datetime.datetime.fromtimestamp(t, self.tz).date().isoformat()
        return d

    def load(self, history):
        for sym, data in history.items():
            self.daily[sym] = {self.date_of(b[0]): b for b in data.get("daily") or []}
            self.ingest(sym, data.get("intraday") or [])
        self.symbols = [s for s in self.symbols if s in self.intra]

    def ingest(self, sym, bars):
        """Add finished 5-minute bars that are newer than what we hold."""
        cur = self.intra.setdefault(sym, [])
        at = self.at.setdefault(sym, {})
        days = self.bydate.setdefault(sym, {})
        last = cur[-1][0] if cur else -1
        added = 0
        for b in bars:
            if b[0] <= last:
                continue
            b = tuple(b)
            cur.append(b)
            at[b[0]] = b
            days.setdefault(self.date_of(b[0]), []).append(b)
            last = b[0]
            added += 1
            if sym == self.bench:
                self.timeline.append(b[0])
        return added

    def session_dates(self):
        return sorted(self.bydate.get(self.bench, {}))

    def index_for(self, sessions_back):
        dates = self.session_dates()
        if not dates:
            return 0
        n = max(1, min(int(sessions_back), max(1, len(dates) - 11)))
        first = self.bydate[self.bench][dates[-n]][0][0]
        return bisect.bisect_left(self.timeline, first)

    # ------------------------------------------------------------------ book

    def reset_book(self, cash, sessions_back=None):
        with self.lock:
            if sessions_back is not None:
                self.start_idx = self.index_for(sessions_back)
            self.cursor = self.start_idx
            self.start_cash = float(cash)
            self.cash = float(cash)
            self.positions = {}
            self.pending = []
            self.trades = []
            self.feed = []
            self.curve = []
            self.shadows = {"chathan": [], "neeli": []}
            self.outcomes = {a: [] for a in AGENTS}
            self.trust = {a: 50.0 for a in AGENTS}
            self.trust_hist = {a: [50.0] for a in AGENTS}
            self.passes = {"good": 0, "missed": 0}
            self.brain = Brain(self.cfg)   # what the agents have learned so far
            self.day = None
            self.today, self.ctx, self.warm = {}, {}, {}
            self.daystate = {}
            self.last_px = {}
            self.last_feats = {}
            self.view = {"chathan": {}, "neeli": {}, "charlie": {}, "verdict": None, "ranked": []}
            self.now = None
            self.bench_start = None
            self.peak = float(cash)
            self.max_dd = 0.0
            self.seq = 0

    def shares_for(self, x):
        """Round a share count down: to 4 decimals if fractional shares are on."""
        if self.cfg.get("fractional_shares"):
            return math.floor(x * 10000 + 1e-9) / 10000.0
        return int(x)

    def signed_money(self, x):
        return ("-%s%s" if x < 0 else "+%s%s") % (self.cur, format(abs(x) / self.fx, ",.2f"))

    def equity(self):
        return self.cash + sum(p["shares"] * self.last_px.get(s, p["entry"]) for s, p in self.positions.items())

    def say(self, who, kind, text):
        self.seq += 1
        self.feed.append({"id": self.seq, "t": self.now, "who": who, "kind": kind, "text": text})
        if len(self.feed) > 300:
            del self.feed[:100]

    def once(self, key):
        """True the first time a key is seen today (keeps the feed from repeating)."""
        seen = self.daystate["noted"]
        if key in seen:
            return False
        seen.add(key)
        return True

    def _score(self, agent, outcome):
        self.outcomes[agent].append(outcome)
        self.trust[agent] = trust_score([o["r"] for o in self.outcomes[agent]])
        self.trust_hist[agent].append(round(self.trust[agent], 1))

    # ------------------------------------------------------------------ loop

    def has_next(self):
        return self.cursor < len(self.timeline)

    def step(self):
        """Process one bar. False when there is nothing left to process."""
        with self.lock:
            if not self.has_next():
                return False
            ts = self.timeline[self.cursor]
            day = self.date_of(ts)
            self.now = ts + BAR
            if day != self.day:
                self._rollover(day, ts)
            bars = {}
            for sym in self.symbols + [self.bench]:
                b = self.at.get(sym, {}).get(ts)
                if b and self.ctx.get(sym):
                    self.today[sym].append(b)
                    bars[sym] = b
                    self.last_px[sym] = b[4]
            if self.bench_start is None and self.bench in bars:
                self.bench_start = bars[self.bench][1]

            self._fill_pending(ts, bars)
            self._intrabar(ts, bars)
            feats = {s: features(self.ctx[s], self.warm[s], self.today[s]) for s in bars}
            self.last_feats = feats
            minutes = (ts - self.daystate["first"]) // 60 + 5
            nxt = self.timeline[self.cursor + 1] if self.cursor + 1 < len(self.timeline) else None
            last_bar = (nxt is not None and self.date_of(nxt) != day) or minutes >= self.cfg["session_minutes"]
            if last_bar:
                self._close_all(bars)
            else:
                self._manage(feats, minutes)
                self._decide(feats, minutes)
            self._mark(ts)
            self.cursor += 1
            return True

    def _rollover(self, day, ts):
        carried = list(self.positions)
        self.day = day
        self.today = {s: [] for s in self.symbols + [self.bench]}
        self.daystate = {"first": ts, "realized": 0.0, "start_equity": self.equity(),
                         "traded": set(), "noted": set(),
                         "shadowed": {"chathan": set(), "neeli": set()}}
        for sym in self.symbols + [self.bench]:
            days = self.bydate.get(sym, {})
            earlier = [d for d in sorted(days) if d < day]
            daily = dict(self.daily.get(sym, {}))
            for d in earlier:   # our own bars are the truth for days we hold
                bl = days[d]
                daily[d] = (bl[0][0], bl[0][1], max(b[2] for b in bl), min(b[3] for b in bl),
                            bl[-1][4], sum(b[5] for b in bl))
            prior = [daily[d] for d in sorted(daily) if d < day]
            self.ctx[sym] = day_context(prior, [days[d] for d in earlier[-10:]])
            self.warm[sym] = days[earlier[-1]][-30:] if earlier else []
        label = datetime.date.fromisoformat(day).strftime("%a %d %b")
        self.say("system", "day", "New session: %s" % label)
        for sym in carried:   # only happens if a session ended without a final bar
            self.pending.append({"kind": "exit", "symbol": sym, "age": 0, "tag": "close",
                                 "reason": "Carried overnight, closed at the open"})
        for agent in self.shadows:
            for sh in self.shadows[agent]:
                self._close_shadow(agent, sh, self.last_px.get(sh["symbol"], sh["entry"]))
            self.shadows[agent] = []

    # ------------------------------------------------------------- execution

    def _fill_pending(self, ts, bars):
        slip = self.cfg["slippage_bps"] / 10000.0
        keep = []
        for o in self.pending:
            b = bars.get(o["symbol"])
            if not b:
                o["age"] += 1
                if o["kind"] == "exit" or o["age"] < 3:
                    keep.append(o)
                continue
            px = b[1]
            if o["kind"] == "exit":
                pos = self.positions.get(o["symbol"])
                if pos:
                    self._close(pos, px * (1 - slip), o["reason"], o.get("tag", "advice"))
            elif o["kind"] == "shadow":
                self.shadows[o["agent"]].append({
                    "symbol": o["symbol"], "entry": px, "stop": px - o["risk"],
                    "target": px + o["rr"] * o["risk"], "risk": o["risk"], "taken": o["taken"],
                    "charlie": o.get("charlie"), "keys": o.get("keys"), "n_obj": o.get("n_obj"),
                    "factors": o.get("factors")})
            else:
                fill = px * (1 + slip)
                shares = self.shares_for(min(o["shares"], self.cash / fill))
                if shares <= 0:
                    continue
                self.cash -= shares * fill
                self.positions[o["symbol"]] = {
                    "symbol": o["symbol"], "shares": shares, "entry": fill,
                    "stop": fill - o["risk"], "target": fill + o["rr"] * o["risk"],
                    "risk": o["risk"], "rr": o["rr"], "t": ts, "high": fill, "bars": 0,
                    "basis": o["basis"], "score": o["score"], "exiting": False,
                    "advice": {"kind": "hold", "text": "Just bought. Watching the stop and the target."}}
                self.daystate["traded"].add(o["symbol"])
                p = self.positions[o["symbol"]]
                self.say("moothon", "buy", "Bought %s %s at %s. Stop %s, target %s. %s" % (
                    qty(shares), o["symbol"], usd(fill), usd(p["stop"]), usd(p["target"]), o["note"]))
        self.pending = keep

    def _intrabar(self, ts, bars):
        slip = self.cfg["slippage_bps"] / 10000.0
        for sym, pos in list(self.positions.items()):
            b = bars.get(sym)
            if not b:
                continue
            _, o, h, l, _c, _v = b
            if l <= pos["stop"]:
                if pos["stop"] > pos["entry"]:
                    why, tag = "Trailing stop hit, profit locked in", "target"
                elif pos["stop"] == pos["entry"]:
                    why, tag = "Stopped out at breakeven", "advice"
                else:
                    why, tag = "Stop hit", "stop"
                self._close(pos, min(o, pos["stop"]) * (1 - slip), why, tag)
            elif h >= pos["target"]:
                self._close(pos, max(o, pos["target"]) * (1 - slip), "Target hit", "target")
            else:
                pos["high"] = max(pos["high"], h)
                pos["bars"] += 1
        for agent, book in self.shadows.items():
            still = []
            for sh in book:
                b = bars.get(sh["symbol"])
                if b and b[3] <= sh["stop"]:
                    self._close_shadow(agent, sh, min(b[1], sh["stop"]))
                elif b and b[2] >= sh["target"]:
                    self._close_shadow(agent, sh, max(b[1], sh["target"]))
                else:
                    still.append(sh)
            self.shadows[agent] = still

    def _close(self, pos, px, reason, tag):
        sym = pos["symbol"]
        self.positions.pop(sym, None)
        self.cash += pos["shares"] * px
        pnl = (px - pos["entry"]) * pos["shares"]
        r = (px - pos["entry"]) / pos["risk"]
        self.daystate["realized"] += pnl
        self.trades.append({
            "symbol": sym, "shares": pos["shares"], "entry": pos["entry"], "exit": px,
            "t_in": pos["t"], "t_out": self.now, "pnl": pnl, "r": r, "reason": reason,
            "tag": tag, "basis": pos["basis"]})
        self._score("moothon", {"r": r, "kind": "trade", "symbol": sym})
        self._learned(self.brain.judge_scored(self.outcomes["moothon"], self.now))
        self.say("moothon", "sell-win" if pnl >= 0 else "sell-loss", "Sold %s %s at %s. %s. %s (%+.1fR)" % (
            qty(pos["shares"]), sym, usd(px), reason, self.signed_money(pnl), r))

    def _learned(self, lessons):
        for who, text in lessons:
            self.say(who, "learn", "Lesson: " + text)

    def _close_shadow(self, agent, sh, px):
        r = (px - sh["entry"]) / sh["risk"]
        self._score(agent, {"r": r, "symbol": sh["symbol"], "taken": sh["taken"]})
        self._learned(self.brain.pick_closed(agent, r, sh, self.now))
        conf = sh.get("charlie")
        if conf is not None and abs(conf - 50) >= 8:
            # Charlie is scored as if he had bet his confidence: a firm "take" on a
            # winner or a firm "don't" on a loser pays; being firmly wrong costs.
            self._score("charlie", {"r": (conf - 50) / 50.0 * max(-1.5, min(3.0, r)), "symbol": sh["symbol"],
                                    "call": "take" if conf > 50 else "skip"})
        if not sh["taken"]:
            # Judging the judge: a pass that would have lost is a good call,
            # a pass that would have won is a miss. Half weight either way.
            self.passes["good" if r <= 0 else "missed"] += 1
            self._score("moothon", {"r": max(-1.5, min(1.5, -0.5 * r)), "kind": "pass", "symbol": sh["symbol"]})
            self._learned(self.brain.judge_scored(self.outcomes["moothon"], self.now))

    def _close_all(self, bars):
        slip = self.cfg["slippage_bps"] / 10000.0
        for sym, pos in list(self.positions.items()):
            self._close(pos, self.last_px.get(sym, pos["entry"]) * (1 - slip), "Session over, flat by the close", "close")
        for agent in self.shadows:
            for sh in self.shadows[agent]:
                self._close_shadow(agent, sh, self.last_px.get(sh["symbol"], sh["entry"]))
            self.shadows[agent] = []
        self.pending = []
        self.view["verdict"] = {"action": "WAIT", "reason": "The session is over. Everything is closed."}
        self.view["chathan"] = {}
        self.view["neeli"] = {}
        self.view["charlie"] = {}
        self.view["ranked"] = []

    # --------------------------------------------------------------- moothon

    def _manage(self, feats, minutes):
        """Moothon looks after what is open and says when to get out."""
        for sym, pos in self.positions.items():
            f = feats.get(sym)
            if not f or pos["exiting"]:
                continue
            c, risk = f["last"], pos["risk"]
            r_now = (c - pos["entry"]) / risk
            r_high = (pos["high"] - pos["entry"]) / risk
            if r_high >= 1.5 and pos["stop"] < pos["entry"] + 0.5 * risk:
                pos["stop"] = pos["entry"] + 0.5 * risk
                self.say("moothon", "manage", "%s reached +1.5R. Stop raised to %s to lock in a profit." % (sym, usd(pos["stop"])))
            elif r_high >= 1.0 and pos["stop"] < pos["entry"]:
                pos["stop"] = pos["entry"]
                self.say("moothon", "manage", "%s reached +1R. Stop moved to breakeven, this one can no longer lose." % sym)

            why = None
            if minutes >= self.cfg["session_minutes"] - 15:
                why = "The close is near, time to be flat"
            elif (self.cfg.get("fade_exit", True) and pos["bars"] >= self.cfg.get("fade_bars", 4) and c < f["vwap"]
                  and f["ema9"] and c < f["ema9"] and r_now < 0.25):
                why = "Momentum faded, price fell under VWAP"
            elif self.cfg.get("stale_exit", True) and pos["bars"] >= 24 and abs(r_now) < 0.3:
                why = "Two hours and going nowhere, the money is better used elsewhere"
            if why:
                pos["exiting"] = True
                pos["advice"] = {"kind": "exit", "text": "Exit now. %s." % why}
                self.pending.append({"kind": "exit", "symbol": sym, "age": 0, "reason": why, "tag": "advice"})
                self.say("moothon", "exit", "Exit %s now. %s. Selling at the next bar." % (sym, why))
            else:
                pos["advice"] = {"kind": "hold", "text": "Hold. %+.1fR so far. Stop %s, target %s." % (
                    r_now, usd(pos["stop"]), usd(pos["target"]))}

    def _decide(self, feats, minutes):
        cfg = self.cfg
        ds = self.daystate
        mkt = feats.get(self.bench)
        c_p, n_p, reviews = {}, {}, {}
        for sym in self.symbols:
            f = feats.get(sym)
            if not f:
                continue
            p = agents.chathan(sym, f, cfg, self.brain.chathan)
            if p:
                c_p[sym] = p
            p, obj = agents.neeli(sym, f, mkt, cfg, self.brain.neeli)
            reviews[sym] = obj
            if p:
                n_p[sym] = p
        c_top = max(c_p.values(), key=lambda p: (p["conviction"], p["symbol"]), default=None)
        n_top = max(n_p.values(), key=lambda p: (p["conviction"], p["symbol"]), default=None)
        # Charlie weighs every idea on the table before Moothon sees it
        above = [1 for s in self.symbols if s in feats and feats[s]["last"] > feats[s]["vwap"]]
        seen_syms = [s for s in self.symbols if s in feats]
        breadth = (len(above) / float(len(seen_syms))) if seen_syms else None
        consult = {}
        for sym in set(c_p) | set(n_p):
            n, c = n_p.get(sym), c_p.get(sym)
            plan = {"risk": n["risk"], "rr": 2.5 if c else n["rr"]} if n else {"risk": c["risk"], "rr": c["rr"]}
            consult[sym] = agents.charlie(sym, feats[sym], mkt, breadth, plan, cfg, self.brain.charlie)
        ranked = agents.moothon_rank(c_p, n_p, reviews, self.trust, cfg, consult)

        # What the two say out loud
        if c_top and self.once(("c", c_top["symbol"])):
            self.say("chathan", "pitch", "%s! %s. I'm %d%% sure, let's go!" % (
                c_top["symbol"], cap(", ".join(c_top["reasons"][:3])), c_top["conviction"]))
        if n_top and self.once(("n", n_top["symbol"])):
            self.say("neeli", "pitch", "%s qualifies. %s." % (
                n_top["symbol"], cap(", ".join(n_top["reasons"][:4]))))
        doubt = None
        if c_top and c_top["symbol"] not in n_p:
            objs = [o for o in (reviews.get(c_top["symbol"]) or []) if o[0] != "waived"]
            if objs:
                sev = [o[1] for o in objs if o[0] == "severe"] or [objs[0][1]]
                doubt = {"symbol": c_top["symbol"], "text": sev[0], "all": [o[1] for o in objs]}
                if self.once(("no", c_top["symbol"])):
                    self.say("neeli", "object", "Not %s for me: %s." % (c_top["symbol"], sev[0]))
        self.view["chathan"] = {"pitch": c_top, "count": len(c_p)}
        self.view["neeli"] = {"pitch": n_top, "count": len(n_p), "doubt": doubt}
        self.view["ranked"] = [{k: c[k] for k in ("symbol", "score", "basis", "veto")} for c in ranked[:6]]
        tops = [p["symbol"] for p in (c_top, n_top) if p]
        order = list(dict.fromkeys(tops + [c["symbol"] for c in ranked]))[:3]
        self.view["charlie"] = {"reviews": [dict({k: v for k, v in consult[s].items() if k != "factors"}, by=[a for a, d in (("chathan", c_p), ("neeli", n_p)) if s in d])
                                            for s in order if s in consult]}
        for s in tops[:1]:
            ch = consult.get(s)
            if ch and self.once(("ch", s, ch["call"])):
                words = {"take": "take it", "skip": "don't take it", "lean": "I'm on the fence"}[ch["call"]]
                detail = "; ".join(filter(None, [cap(", ".join(ch["pros"][:2])), ("but " if ch["pros"] else "") + ", ".join(ch["cons"][:2]) if ch["cons"] else ""]))
                self.say("charlie", "weigh", "%s: %s, %d%% confident. %s." % (s, words, ch["confidence"], detail or "Nothing stands out either way"))

        # Moothon's ruling
        equity = self.equity()
        queued = [o for o in self.pending if o["kind"] == "entry"]
        block = None
        if minutes < 20:
            block = "Letting the open settle before I risk anything."
        elif minutes > cfg["session_minutes"] - 60:
            block = "Too late in the day to open a new trade."
        elif ds["realized"] <= -cfg["daily_loss_limit_pct"] / 100.0 * ds["start_equity"]:
            block = "Daily loss limit reached. No new trades today."
        elif len(self.positions) + len(queued) >= cfg["max_positions"]:
            block = "The book is full with %d positions. Nothing new until one closes." % cfg["max_positions"]

        pick, best_idea = None, None
        bar = self.brain.moothon["bar"]   # Moothon's bar moves as he learns
        for cand in ranked:
            sym = cand["symbol"]
            if sym in self.positions or sym in ds["traded"] or any(o["symbol"] == sym for o in queued):
                continue
            if best_idea is None:
                best_idea = cand
            if cand["veto"] or cand["score"] < bar:
                continue
            by_risk = equity * cfg["risk_pct"][cand["basis"]] / 100.0 / cand["risk"]
            by_cap = equity * cfg["position_cap_pct"][cand["basis"]] / 100.0 / cand["entry"]
            shares = self.shares_for(min(by_risk, by_cap, self.cash / cand["entry"]))
            if shares > 0 and shares * cand["entry"] >= 1.0:   # not worth an order under a dollar
                pick = dict(cand, shares=shares)
                break

        def card(cand):
            out = {k: cand.get(k) for k in ("symbol", "score", "base_score", "basis", "entry", "stop", "target", "rr",
                                            "note", "veto", "objections", "charlie")}
            out["chathan"] = cand["chathan"] and {"conviction": cand["chathan"]["conviction"], "reasons": cand["chathan"]["reasons"]}
            out["neeli"] = cand["neeli"] and {"conviction": cand["neeli"]["conviction"], "reasons": cand["neeli"]["reasons"]}
            return out

        if pick and not block:
            self.pending.append({"kind": "entry", "symbol": pick["symbol"], "shares": pick["shares"],
                                 "risk": pick["risk"], "rr": pick["rr"], "basis": pick["basis"],
                                 "score": pick["score"], "note": pick["note"], "age": 0})
            v = card(pick)
            v.update(action="BUY", shares=pick["shares"], cost=pick["shares"] * pick["entry"],
                     at_risk=pick["shares"] * pick["risk"],
                     reason="Best trade right now. Buying with virtual money at the next bar.")
            self.view["verdict"] = v
            self.say("moothon", "verdict", "Verdict: BUY %s, score %d. %s" % (pick["symbol"], pick["score"], pick["note"]))
            # A pick he passed on earlier and buys now counts as taken, not as a pass.
            for book in self.shadows.values():
                for sh in book:
                    if sh["symbol"] == pick["symbol"]:
                        sh["taken"] = True
            for o in self.pending:
                if o["kind"] == "shadow" and o["symbol"] == pick["symbol"]:
                    o["taken"] = True
        else:
            v = {"action": "WAIT"}
            if block:
                v["reason"] = block
            elif best_idea is None:
                v["reason"] = "Neither Chathan nor Neeli has a trade worth taking. Cash is a position too."
            elif best_idea["veto"]:
                v["reason"] = "Best idea is %s from Chathan, but I'm passing: %s." % (best_idea["symbol"], best_idea["veto"])
                if self.once(("veto", best_idea["symbol"])):
                    self.say("moothon", "pass", "Passing on %s. %s." % (best_idea["symbol"], best_idea["veto"]))
            elif best_idea["score"] < bar:
                v["reason"] = "Best idea is %s at score %d. My bar is %d, so I wait." % (
                    best_idea["symbol"], best_idea["score"], bar)
            else:
                v["reason"] = "Not enough cash for a sensible position in %s." % best_idea["symbol"]
            if best_idea:
                v["idea"] = card(best_idea)
            self.view["verdict"] = v

        # Each sub-agent's top pick is tracked on paper, taken or not, so their
        # trust score reflects their own calls and not Moothon's filtering.
        bought = pick["symbol"] if (pick and not block) else None
        if minutes <= cfg["session_minutes"] - 60:
            for agent, top in (("chathan", c_top), ("neeli", n_top)):
                if not top or top["symbol"] in ds["shadowed"][agent]:
                    continue
                waiting = sum(1 for o in self.pending if o["kind"] == "shadow" and o["agent"] == agent)
                if len(self.shadows[agent]) + waiting >= 3:
                    continue
                ds["shadowed"][agent].add(top["symbol"])
                self.pending.append({"kind": "shadow", "agent": agent, "symbol": top["symbol"], "age": 0,
                                     "risk": top["risk"], "rr": top["rr"],
                                     "charlie": (consult.get(top["symbol"]) or {}).get("confidence"),
                                     "keys": top.get("keys"),
                                     "n_obj": [o[2] for o in (reviews.get(top["symbol"]) or []) if len(o) > 2 and o[0] != "severe"],
                                     "factors": (consult.get(top["symbol"]) or {}).get("factors"),
                                     "taken": top["symbol"] == bought or top["symbol"] in self.positions})

    def _mark(self, ts):
        eq = self.equity()
        bench_px = self.last_px.get(self.bench)
        bench_eq = self.start_cash * bench_px / self.bench_start if (bench_px and self.bench_start) else self.start_cash
        self.curve.append((self.now, round(eq, 2), round(bench_eq, 2)))
        self.peak = max(self.peak, eq)
        if self.peak > 0:
            self.max_dd = max(self.max_dd, (self.peak - eq) / self.peak)

    # -------------------------------------------------------------- snapshot

    def snapshot(self, focus=None):
        with self.lock:
            eq = self.equity()
            stats = book_stats(self.trades)
            invested = eq - self.cash
            day_start = self.daystate.get("start_equity", self.start_cash) if self.daystate else self.start_cash
            account = {
                "start_cash": self.start_cash, "equity": eq, "cash": self.cash, "invested": invested,
                "pnl": eq - self.start_cash, "pnl_pct": (eq / self.start_cash - 1) if self.start_cash else 0,
                "pnl_today": eq - day_start, "pnl_today_pct": (eq / day_start - 1) if day_start else 0,
                "unrealized": sum((self.last_px.get(s, p["entry"]) - p["entry"]) * p["shares"] for s, p in self.positions.items()),
                "max_dd": self.max_dd, "bench": self.curve[-1][2] if self.curve else self.start_cash,
            }
            account.update(stats)

            agents_out = {}
            for a in AGENTS:
                rs = [o["r"] for o in self.outcomes[a] if o.get("kind") != "pass"]
                rec = record(rs)
                rec.update(trust=round(self.trust[a], 1), history=self.trust_hist[a][-120:])
                agents_out[a] = rec
            for a in ("chathan", "neeli"):
                agents_out[a].update(self.view.get(a) or {})
                agents_out[a]["open_calls"] = len(self.shadows[a])
                # How many of Moothon's trades this agent was behind, open ones included
                backed = [t["basis"] for t in self.trades] + [p["basis"] for p in self.positions.values()]
                agents_out[a]["taken"] = sum(1 for b in backed if b in (a, "both"))
            agents_out["moothon"].update(self.passes)
            agents_out["charlie"].update(self.view.get("charlie") or {})

            positions = []
            for sym, p in self.positions.items():
                last = self.last_px.get(sym, p["entry"])
                positions.append({
                    "symbol": sym, "shares": p["shares"], "entry": p["entry"], "last": last,
                    "stop": p["stop"], "target": p["target"], "pnl": (last - p["entry"]) * p["shares"],
                    "r": (last - p["entry"]) / p["risk"], "basis": p["basis"], "t": p["t"],
                    "value": last * p["shares"], "advice": p["advice"]})

            watch = []
            c_view = self.view.get("chathan") or {}
            for sym in self.symbols:
                f = self.last_feats.get(sym)
                if not f:
                    continue
                watch.append({"symbol": sym, "last": f["last"], "chg": f["chg"], "relvol": f["relvol"],
                              "held": sym in self.positions})
            watch.sort(key=lambda w: -w["chg"])

            verdict = self.view.get("verdict")
            if focus not in self.today or not self.today.get(focus):
                focus = None
            if not focus:
                if positions:
                    focus = positions[0]["symbol"]
                elif verdict and verdict.get("symbol"):
                    focus = verdict["symbol"]
                elif c_view.get("pitch"):
                    focus = c_view["pitch"]["symbol"]
                elif watch:
                    focus = watch[0]["symbol"]
            chart = None
            if focus and self.today.get(focus):
                bars = self.today[focus]
                vw, pv, vol = [], 0.0, 0.0
                for b in bars:
                    pv += (b[2] + b[3] + b[4]) / 3.0 * b[5]
                    vol += b[5]
                    vw.append(round(pv / vol, 4) if vol else b[4])
                levels = None
                if focus in self.positions:
                    p = self.positions[focus]
                    levels = {"entry": p["entry"], "stop": p["stop"], "target": p["target"], "held": True}
                elif verdict and verdict.get("action") == "BUY" and verdict.get("symbol") == focus:
                    levels = {"entry": verdict["entry"], "stop": verdict["stop"], "target": verdict["target"], "held": False}
                chart = {"symbol": focus, "bars": [list(b) for b in bars], "vwap": vw, "levels": levels,
                         "prev_close": self.ctx[focus]["prev_close"] if self.ctx.get(focus) else None}

            curve = self.curve
            if len(curve) > 500:
                k = int(math.ceil(len(curve) / 500.0))
                curve = curve[::k] + ([curve[-1]] if (len(curve) - 1) % k else [])
            total = len(self.timeline) - self.start_idx
            return {
                "clock": {"t": self.now, "day": self.day, "tz": self.cfg["timezone"],
                          "done": self.cursor - self.start_idx, "total": total,
                          "caught_up": not self.has_next()},
                "account": account, "agents": agents_out, "verdict": verdict,
                "ranked": self.view.get("ranked") or [], "positions": positions,
                "trades": self.trades[-60:][::-1], "feed": self.feed[-80:][::-1],
                "watch": watch, "chart": chart, "curve": [list(c) for c in curve],
                "money": {"symbol": self.cur, "rate": self.fx, "code": self.cfg.get("currency", "USD")},
                "brain": self.brain.summary(),
                "rules": {"take_score": self.brain.moothon["bar"], "max_positions": self.cfg["max_positions"],
                          "benchmark": self.bench},
            }
