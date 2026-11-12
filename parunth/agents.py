"""The council.

Chathan is always eager: he chases whatever is moving and is sure about it.
Neeli takes calculated risk: every one of her checks must pass or she sits out.
Charlie is the consultant: he pitches nothing himself. He weighs every idea the
other two bring and tells Moothon how confident he is that it should be taken.
Moothon is the judge: he hears all three, weighs each by the trust they have
earned, and decides what the virtual money does.

Each of them also learns. Every signal, check and factor below has a key, and
the engine keeps score of how calls that used it turned out (see learning.py).
That record comes back in here as `mind`: Chathan leans on the signals that
have paid and raises his bar when he is losing, Neeli drops a check that keeps
blocking winners, and Charlie re-weights his factors.

A pitch is a plain dict: symbol, conviction (0-100), entry, stop, target,
risk (per share), rr (reward to risk), the reasons in the agent's words, and
the keys of the signals behind it.
"""

# What the keys mean, in words, for the lessons the agents write down.
SIGNALS = {
    "up": "a stock already up on the day", "orb": "an opening-range breakout", "vol": "heavy volume",
    "vwap": "holding above VWAP", "hod": "a fresh high of the day", "high20": "a 20-day high",
}
CHECKS = {
    "early": "waiting out the first half hour", "late": "no new trades in the last hour",
    "below20": "wanting a close above the 20-day average", "mkt_weak": "wanting a firm market",
    "below_vwap": "wanting price above VWAP", "below_mid": "wanting price above the opening-range midpoint",
    "no_momentum": "wanting RSI above 50", "light_vol": "wanting normal volume",
    "wide_stop": "refusing a wide stop", "far_target": "wanting the target inside a normal day's range",
}
FACTORS = {
    "rs": "leading the market", "lag": "lagging the market", "breadth_up": "a healthy watchlist",
    "breadth_dn": "a weak watchlist", "morning": "the morning window", "midday": "midday chop",
    "late": "little time left", "clean": "a clean, steady move", "choppy": "choppy price action",
    "aligned": "price above its short average", "no_room": "a target beyond the day's range",
    "room": "room left in the day's range", "stretched": "being stretched above VWAP",
    "gap": "a big gap up", "vol_ok": "volume confirming", "vol_thin": "thin volume",
}


def _w(mind, key):
    return ((mind or {}).get("w") or {}).get(key, 1.0)


def _pitch(agent, sym, f, conviction, risk, rr, reasons, keys):
    entry = f["last"]
    return {
        "agent": agent, "symbol": sym, "t": f["t"],
        "conviction": int(round(max(1, min(99, conviction)))),
        "entry": round(entry, 2), "stop": round(entry - risk, 2),
        "target": round(entry + rr * risk, 2),
        "risk": risk, "rr": rr, "reasons": reasons, "keys": keys,
    }


def chathan(sym, f, cfg, mind=None):
    """Momentum chaser. Tight stop, big target, low bar for getting excited."""
    if not f["or_ready"] or f["minutes"] > cfg["session_minutes"] - 45:
        return None
    last, pts, why, keys = f["last"], 0.0, [], []

    def got(key, points, text=None):
        nonlocal pts
        pts += points * _w(mind, key)
        keys.append(key)
        if text:
            why.append(text)

    if f["chg"] > 0:
        got("up", min(30.0, f["chg"] / 0.03 * 30.0), "up %.1f%% today" % (f["chg"] * 100))
    if last > f["or_high"]:
        got("orb", 20, "broke the opening-range high %.2f" % f["or_high"])
    rv = f["relvol"]
    if rv and rv > 1:
        got("vol", min(20.0, (rv - 1) / 1.5 * 20.0), "%.1fx the usual volume" % rv if rv >= 1.2 else None)
    if last > f["vwap"]:
        got("vwap", 10, "holding above VWAP")
    if last >= f["prior_high"]:
        got("hod", 10, "fresh high of the day")
    if last >= f["high20"]:
        got("high20", 10, "at a 20-day high")
    if pts < (mind or {}).get("bar", 35):
        return None
    risk = max(1.2 * f["atr5"], 0.0015 * last)
    return _pitch("chathan", sym, f, pts + 15, risk, 3.0, why, keys)


def neeli(sym, f, mkt, cfg, mind=None):
    """Returns (pitch or None, objections).

    An objection is (severity, text, key). Severity is "severe", "minor", or
    "waived": a minor check she has learned to drop because it kept blocking
    winners. A waived objection no longer stops her, but it is still reported
    so the record on that check keeps running and she can bring it back.
    """
    obj, good = [], []
    waived = (mind or {}).get("waived") or ()
    last, vwap = f["last"], f["vwap"]

    def minor(key, text):
        obj.append(("waived" if key in waived else "minor", text, key))

    if not f["or_ready"] or f["minutes"] < 30:
        minor("early", "too early, the open is still noise")
    elif f["minutes"] > cfg["session_minutes"] - 60:
        minor("late", "too late in the day to start a trade")

    pc, sma20, sma50 = f["prev_close"], f["sma20"], f["sma50"]
    if pc < sma20 and (sma50 is None or pc < sma50):
        obj.append(("severe", "the daily chart is in a downtrend", "downtrend"))
    elif pc < sma20:
        minor("below20", "it closed below its 20-day average")
    else:
        good.append("daily trend is up")

    if mkt:
        if mkt["chg"] < -0.01:
            obj.append(("severe", "the market is down %.1f%%" % (-mkt["chg"] * 100), "mkt_down"))
        elif mkt["chg"] < 0 and mkt["last"] < mkt["vwap"]:
            minor("mkt_weak", "the market is weak (%s under VWAP)" % cfg["benchmark"])
        else:
            good.append("market is supportive")

    if last <= vwap:
        minor("below_vwap", "price is below VWAP")
    elif f["or_ready"] and last < (f["or_high"] + f["or_low"]) / 2.0:
        minor("below_mid", "price is under the opening-range midpoint")
    else:
        good.append("above VWAP %.2f" % vwap)

    r = f["rsi"]
    if r is not None:
        if r >= 76:
            obj.append(("severe", "RSI %d is overbought, that is chasing" % r, "overbought"))
        elif r < 50:
            minor("no_momentum", "RSI %d shows no momentum" % r)
        else:
            good.append("RSI %d, room to run" % r)

    atr_d = f["atr_d"]
    if atr_d:
        ext = (last - vwap) / atr_d
        if ext > 0.6:
            obj.append(("severe", "stretched %.1f daily ranges above VWAP" % ext, "stretched"))

    rv = f["relvol"]
    if rv is not None and rv < 0.9:
        minor("light_vol", "volume is light (%.1fx usual)" % rv)

    stop = min(vwap, last - 2.0 * f["atr5"])
    risk = last - stop
    if risk <= 0:
        risk = 2.0 * f["atr5"]
    if risk / last > 0.012:
        minor("wide_stop", "the stop would sit %.1f%% away, too wide" % (risk / last * 100))
    risk = min(max(risk, 0.002 * last), 0.02 * last)
    if atr_d and (last + 2.0 * risk) - f["day_low"] > 1.6 * atr_d:
        minor("far_target", "the target is beyond a normal day's range")

    if any(o[0] != "waived" for o in obj):
        return None, obj

    conv = 55.0
    if sma50 is not None and sma20 > sma50:
        conv += 8
    if rv is not None and rv >= 1.5:
        conv += 8
        good.append("%.1fx the usual volume" % rv)
    if last > f["or_high"]:
        conv += 8
        good.append("above the opening range")
    if mkt and mkt["chg"] > 0:
        conv += 6
    if r is not None and 55 <= r <= 68:
        conv += 5
    if last >= f["day_high"] * 0.998:
        conv += 5
    conv -= 4 * len(obj)   # a check she waived still makes her a little less sure
    good.append("risking %.2f%% to make %.2f%%" % (risk / last * 100, 2 * risk / last * 100))
    return _pitch("neeli", sym, f, conv, risk, 2.0, good, [o[2] for o in obj]), obj


def charlie(sym, f, mkt, breadth, plan, cfg, mind=None):
    """The consultant's second opinion on one idea: how confident to take it, 0-100.

    He looks at what the other two mostly ignore: is the stock leading the
    market, is the whole watchlist healthy, is this a good hour for breakouts,
    is the move clean or choppy, and is there room left in today's range for
    the target. plan is the trade as Moothon would place it (risk, rr).
    """
    score, pros, cons, factors = 50.0, [], [], []
    last = f["last"]

    def pro(key, points, text=None):
        nonlocal score
        score += points * _w(mind, key)
        factors.append((key, 1))
        if text:
            pros.append(text)

    def con(key, points, text):
        nonlocal score
        score -= points * _w(mind, key)
        factors.append((key, -1))
        cons.append(text)

    if mkt:
        rs = f["chg"] - mkt["chg"]
        if rs >= 0.01:
            pro("rs", min(12.0, rs / 0.03 * 12.0), "leading the market by %.1f%%" % (rs * 100))
        elif rs < 0:
            con("lag", 8, "lagging the market")
    if breadth is not None:
        if breadth >= 0.6:
            pro("breadth_up", 8, "%d%% of the watchlist is above VWAP" % round(breadth * 100))
        elif breadth <= 0.35:
            con("breadth_dn", 10, "only %d%% of the watchlist is above VWAP" % round(breadth * 100))
    m = f["minutes"]
    if 30 <= m <= 120:
        pro("morning", 6, "the morning trend window")
    elif 120 < m <= 240:
        con("midday", 8, "midday chop, breakouts often fail now")
    elif m > 300:
        con("late", 5, "little time left before the close")
    eff = f.get("eff")
    if eff is not None:
        if eff >= 0.45:
            pro("clean", 10, "a clean, steady move")
        elif eff < 0.2:
            con("choppy", 10, "choppy, back-and-forth price action")
    if f["ema9"] and last > f["ema9"] > f["vwap"]:
        pro("aligned", 5)
    atr_d = f["atr_d"]
    if atr_d:
        used = (f["day_high"] - f["day_low"]) / atr_d
        need = plan["rr"] * plan["risk"] / atr_d
        if used + need > 1.5:
            con("no_room", 12, "the target needs more than a normal day's range")
        elif used < 0.6:
            pro("room", 6, "plenty of the day's range left")
        if (last - f["vwap"]) / atr_d > 0.5:
            con("stretched", 10, "stretched far above VWAP")
    gap = f["day_open"] / f["prev_close"] - 1.0
    if gap > 0.04:
        con("gap", 8, "gapped up %d%%, late buyers get trapped" % round(gap * 100))
    rv = f["relvol"]
    if rv is not None:
        if rv >= 1.5:
            pro("vol_ok", 6, "volume confirms it")
        elif rv < 0.8:
            con("vol_thin", 6, "no volume behind it")
    conf = int(round(max(5.0, min(95.0, score))))
    return {"symbol": sym, "confidence": conf, "pros": pros, "cons": cons, "factors": factors,
            "call": "take" if conf >= 58 else "skip" if conf <= 42 else "lean"}


CHARLIE_SAYS = {"take": "Charlie says take it", "skip": "Charlie says don't", "lean": "Charlie is on the fence"}


def moothon_rank(c_pitches, n_pitches, reviews, trust, cfg, consult=None):
    """Every idea on the table, scored by the judge, best first.

    Agreement gets a bonus. Neeli alone is taken at close to face value.
    Chathan alone is discounted, loses points for each of Neeli's minor
    objections, and is vetoed outright by a severe one. How much each voice
    counts moves with the trust score that agent has earned.

    consult is Charlie's review per symbol. His confidence moves the score up
    or down around his neutral 50, and it moves it more the more he is trusted.
    """
    pull = 0.3 + 0.5 * trust.get("charlie", 50.0) / 100.0
    tc, tn = trust["chathan"] / 100.0, trust["neeli"] / 100.0
    out = []
    for sym in sorted(set(c_pitches) | set(n_pitches)):
        c, n = c_pitches.get(sym), n_pitches.get(sym)
        objections = [o for o in (reviews.get(sym) or []) if o[0] != "waived"]
        severe = [o[1] for o in objections if o[0] == "severe"]
        minor = [o[1] for o in objections if o[0] == "minor"]
        cand = {"symbol": sym, "chathan": c, "neeli": n, "veto": None, "note": "",
                "objections": [o[1] for o in objections]}
        if c and n:
            score = (c["conviction"] * tc + n["conviction"] * tn) / max(tc + tn, 1e-9) + 12
            cand.update(basis="both", entry=n["entry"], risk=n["risk"], rr=2.5,
                        note="Chathan and Neeli both want it, so I use Neeli's stop and a 2.5R target.")
        elif n:
            score = n["conviction"] * (0.75 + 0.5 * tn)
            cand.update(basis="neeli", entry=n["entry"], risk=n["risk"], rr=n["rr"],
                        note="Neeli's rules all pass. Chathan is not excited, which is fine.")
        else:
            cand.update(basis="chathan", entry=c["entry"], risk=c["risk"], rr=c["rr"])
            if severe:
                cand["veto"] = "Neeli warns " + severe[0]
                score = 0.0
            else:
                score = c["conviction"] * (0.45 + 0.6 * tc) - 6 * len(minor)
                cand["note"] = ("Only Chathan wants it. Neeli has no serious objection, so a small position."
                                if not minor else
                                "Only Chathan wants it and Neeli is lukewarm (%s), so a small position." % minor[0])
        cand["base_score"] = int(round(max(0.0, min(99.0, score))))
        ch = (consult or {}).get(sym)
        cand["charlie"] = ch
        if ch and not cand["veto"]:
            score += (ch["confidence"] - 50) * pull
            cand["note"] += " %s (%d%%)." % (CHARLIE_SAYS[ch["call"]], ch["confidence"])
        cand["score"] = int(round(max(0.0, min(99.0, score))))
        cand["stop"] = round(cand["entry"] - cand["risk"], 2)
        cand["target"] = round(cand["entry"] + cand["rr"] * cand["risk"], 2)
        out.append(cand)
    out.sort(key=lambda x: (-x["score"], x["symbol"]))
    return out
