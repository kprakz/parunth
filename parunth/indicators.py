"""What the agents see: everything is computed from bars that have already closed."""


def ema(vals, n):
    if not vals:
        return None
    k = 2.0 / (n + 1)
    e = vals[0]
    for v in vals[1:]:
        e = v * k + e * (1 - k)
    return e


def rsi(closes, n=14):
    """Wilder's RSI. None until there are n+1 closes."""
    if len(closes) < n + 1:
        return None
    gain = loss = 0.0
    for i in range(1, n + 1):
        d = closes[i] - closes[i - 1]
        gain += max(d, 0.0)
        loss += max(-d, 0.0)
    gain /= n
    loss /= n
    for i in range(n + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        gain = (gain * (n - 1) + max(d, 0.0)) / n
        loss = (loss * (n - 1) + max(-d, 0.0)) / n
    if loss == 0:
        return 100.0 if gain > 0 else 50.0
    return 100.0 - 100.0 / (1.0 + gain / loss)


def true_range_avg(bars, n=14):
    """Average true range over the last n bars (needs a previous close)."""
    trs = []
    for i in range(1, len(bars)):
        h, l, pc = bars[i][2], bars[i][3], bars[i - 1][4]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    if not trs:
        return None
    trs = trs[-n:]
    return sum(trs) / len(trs)


def day_context(prior_daily, prior_sessions):
    """Background for one symbol on one day, from earlier days only.

    prior_daily: daily bars before today, oldest first.
    prior_sessions: up to ten earlier sessions of 5-minute bars, for the usual
    volume by time of day.
    """
    if len(prior_daily) < 21:
        return None
    closes = [b[4] for b in prior_daily]
    sums, counts = [], []
    for bars in prior_sessions:
        cum = 0
        for i, b in enumerate(bars):
            cum += b[5]
            if i == len(sums):
                sums.append(0)
                counts.append(0)
            sums[i] += cum
            counts[i] += 1
    return {
        "prev_close": closes[-1],
        "sma20": sum(closes[-20:]) / 20.0,
        "sma50": sum(closes[-50:]) / 50.0 if len(closes) >= 50 else None,
        "high20": max(closes[-20:]),
        "atr_d": true_range_avg(prior_daily[-15:], 14),
        "vol_profile": [s / c for s, c in zip(sums, counts)],
    }


def features(ctx, warm, bars):
    """The picture at the close of bars[-1]. warm = the last bars of the session before."""
    last = bars[-1][4]
    i = len(bars) - 1
    cum_pv = cum_v = 0.0
    for b in bars:
        cum_pv += (b[2] + b[3] + b[4]) / 3.0 * b[5]
        cum_v += b[5]
    vwap = cum_pv / cum_v if cum_v else last
    closes = [b[4] for b in warm] + [b[4] for b in bars]
    recent = (list(warm) + list(bars))[-14:]
    atr5 = sum(b[2] - b[3] for b in recent) / len(recent)
    tail = closes[-13:]
    path = sum(abs(tail[k] - tail[k - 1]) for k in range(1, len(tail)))
    eff = abs(tail[-1] - tail[0]) / path if len(tail) >= 7 and path else None
    profile = ctx["vol_profile"]
    usual = profile[i] if i < len(profile) else 0
    or_ready = len(bars) >= 3
    first = bars[:3]
    return {
        "last": last,
        "t": bars[-1][0],
        "minutes": (bars[-1][0] - bars[0][0]) // 60 + 5,
        "day_open": bars[0][1],
        "day_high": max(b[2] for b in bars),
        "day_low": min(b[3] for b in bars),
        "prior_high": max(b[2] for b in bars[:-1]) if i else bars[0][2],
        "vwap": vwap,
        "ema9": ema(closes[-40:], 9),
        "rsi": rsi(closes[-60:]),
        "eff": eff,   # 1.0 = the last hour went in a straight line, 0 = pure back-and-forth
        "atr5": max(atr5, last * 0.0005),
        "relvol": (cum_v / usual) if usual else None,
        "chg": last / ctx["prev_close"] - 1.0,
        "or_ready": or_ready,
        "or_high": max(b[2] for b in first),
        "or_low": min(b[3] for b in first),
        "prev_close": ctx["prev_close"],
        "sma20": ctx["sma20"],
        "sma50": ctx["sma50"],
        "high20": ctx["high20"],
        "atr_d": ctx["atr_d"],
    }
