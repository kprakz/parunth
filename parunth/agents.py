"""The council.

Chathan is always eager: he chases whatever is moving and is sure about it.
Neeli takes calculated risk: every one of her checks must pass or she sits out.
Moothon is the judge: he hears both, weighs each by the trust they have earned,
and decides what the virtual money does.

A pitch is a plain dict: symbol, conviction (0-100), entry, stop, target,
risk (per share), rr (reward to risk) and the reasons, in the agent's words.
"""


def _pitch(agent, sym, f, conviction, risk, rr, reasons):
    entry = f["last"]
    return {
        "agent": agent, "symbol": sym, "t": f["t"],
        "conviction": int(round(max(1, min(99, conviction)))),
        "entry": round(entry, 2), "stop": round(entry - risk, 2),
        "target": round(entry + rr * risk, 2),
        "risk": risk, "rr": rr, "reasons": reasons,
    }


def chathan(sym, f, cfg):
    """Momentum chaser. Tight stop, big target, low bar for getting excited."""
    if not f["or_ready"] or f["minutes"] > cfg["session_minutes"] - 45:
        return None
    last, pts, why = f["last"], 0.0, []
    if f["chg"] > 0:
        pts += min(30.0, f["chg"] / 0.03 * 30.0)
        why.append("up %.1f%% today" % (f["chg"] * 100))
    if last > f["or_high"]:
        pts += 20
        why.append("broke the opening-range high %.2f" % f["or_high"])
    rv = f["relvol"]
    if rv and rv > 1:
        pts += min(20.0, (rv - 1) / 1.5 * 20.0)
        if rv >= 1.2:
            why.append("%.1fx the usual volume" % rv)
    if last > f["vwap"]:
        pts += 10
        why.append("holding above VWAP")
    if last >= f["prior_high"]:
        pts += 10
        why.append("fresh high of the day")
    if last >= f["high20"]:
        pts += 10
        why.append("at a 20-day high")
    if pts < 35:
        return None
    risk = max(1.2 * f["atr5"], 0.0015 * last)
    return _pitch("chathan", sym, f, pts + 15, risk, 3.0, why)


def neeli(sym, f, mkt, cfg):
    """Returns (pitch or None, objections). An objection is (severity, text)."""
    obj, good = [], []
    last, vwap = f["last"], f["vwap"]

    if not f["or_ready"] or f["minutes"] < 30:
        obj.append(("minor", "too early, the open is still noise"))
    elif f["minutes"] > cfg["session_minutes"] - 60:
        obj.append(("minor", "too late in the day to start a trade"))

    pc, sma20, sma50 = f["prev_close"], f["sma20"], f["sma50"]
    if pc < sma20 and (sma50 is None or pc < sma50):
        obj.append(("severe", "the daily chart is in a downtrend"))
    elif pc < sma20:
        obj.append(("minor", "it closed below its 20-day average"))
    else:
        good.append("daily trend is up")

    if mkt:
        if mkt["chg"] < -0.01:
            obj.append(("severe", "the market is down %.1f%%" % (-mkt["chg"] * 100)))
        elif mkt["chg"] < 0 and mkt["last"] < mkt["vwap"]:
            obj.append(("minor", "the market is weak (%s under VWAP)" % cfg["benchmark"]))
        else:
            good.append("market is supportive")

    if last <= vwap:
        obj.append(("minor", "price is below VWAP"))
    elif f["or_ready"] and last < (f["or_high"] + f["or_low"]) / 2.0:
        obj.append(("minor", "price is under the opening-range midpoint"))
    else:
        good.append("above VWAP %.2f" % vwap)

    r = f["rsi"]
    if r is not None:
        if r >= 76:
            obj.append(("severe", "RSI %d is overbought, that is chasing" % r))
        elif r < 50:
            obj.append(("minor", "RSI %d shows no momentum" % r))
        else:
            good.append("RSI %d, room to run" % r)

    atr_d = f["atr_d"]
    if atr_d:
        ext = (last - vwap) / atr_d
        if ext > 0.6:
            obj.append(("severe", "stretched %.1f daily ranges above VWAP" % ext))

    rv = f["relvol"]
    if rv is not None and rv < 0.9:
        obj.append(("minor", "volume is light (%.1fx usual)" % rv))

    stop = min(vwap, last - 2.0 * f["atr5"])
    risk = last - stop
    if risk <= 0:
        risk = 2.0 * f["atr5"]
    if risk / last > 0.012:
        obj.append(("minor", "the stop would sit %.1f%% away, too wide" % (risk / last * 100)))
    risk = max(risk, 0.002 * last)
    if atr_d and (last + 2.0 * risk) - f["day_low"] > 1.6 * atr_d:
        obj.append(("minor", "the target is beyond a normal day's range"))

    if obj:
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
    good.append("risking %.2f%% to make %.2f%%" % (risk / last * 100, 2 * risk / last * 100))
    return _pitch("neeli", sym, f, conv, risk, 2.0, good), obj


def moothon_rank(c_pitches, n_pitches, reviews, trust, cfg):
    """Every idea on the table, scored by the judge, best first.

    Agreement gets a bonus. Neeli alone is taken at close to face value.
    Chathan alone is discounted, loses points for each of Neeli's minor
    objections, and is vetoed outright by a severe one. How much each voice
    counts moves with the trust score that agent has earned.
    """
    tc, tn = trust["chathan"] / 100.0, trust["neeli"] / 100.0
    out = []
    for sym in sorted(set(c_pitches) | set(n_pitches)):
        c, n = c_pitches.get(sym), n_pitches.get(sym)
        objections = reviews.get(sym) or []
        severe = [t for s, t in objections if s == "severe"]
        minor = [t for s, t in objections if s == "minor"]
        cand = {"symbol": sym, "chathan": c, "neeli": n, "veto": None,
                "objections": [t for _, t in objections]}
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
        cand["score"] = int(round(max(0.0, min(99.0, score))))
        cand["stop"] = round(cand["entry"] - cand["risk"], 2)
        cand["target"] = round(cand["entry"] + cand["rr"] * cand["risk"], 2)
        out.append(cand)
    out.sort(key=lambda x: (-x["score"], x["symbol"]))
    return out
