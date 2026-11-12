"""Market data: free, delayed bars from Yahoo Finance's chart endpoint.

Unofficial and rate limited, so this is polite: one host, an honest client
name, a small worker pool, a disk cache, and a backoff when told to slow down.
A bar is a tuple (t, open, high, low, close, volume); t is the bar's start, in
epoch seconds.
"""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

UA = "parunth-dashboard/0.1 (personal paper-trading dashboard)"
HOST = "https://query2.finance.yahoo.com"
BAR = 300  # seconds in a 5-minute bar
CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "cache")


def parse_chart(payload):
    """Yahoo chart JSON -> list of bars, skipping rows with missing prices."""
    result = (payload.get("chart") or {}).get("result") or []
    if not result:
        return []
    res = result[0]
    stamps = res.get("timestamp") or []
    quote = ((res.get("indicators") or {}).get("quote") or [{}])[0]
    cols = [quote.get(k) or [] for k in ("open", "high", "low", "close", "volume")]
    bars = []
    for i, t in enumerate(stamps):
        try:
            o, h, l, c, v = (col[i] for col in cols)
        except IndexError:
            break
        if None in (o, h, l, c):
            continue
        bars.append((int(t), float(o), float(h), float(l), float(c), int(v or 0)))
    return bars


def fetch_chart(symbol, rng, interval, timeout=30):
    url = "%s/v8/finance/chart/%s?range=%s&interval=%s&includePrePost=false" % (
        HOST, urllib.parse.quote(symbol), rng, interval)
    last = None
    for attempt in range(3):
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return parse_chart(json.load(resp))
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 429 or e.code >= 500:
                time.sleep(3 + 4 * attempt)   # asked to slow down: wait, then try again
                continue
            raise
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            last = e
            time.sleep(1 + attempt)
    raise RuntimeError("could not fetch %s (%s %s): %s" % (symbol, rng, interval, last))


def complete_bars(bars, now=None, step=BAR):
    """Only whole 5-minute bars: aligned to the grid and already finished."""
    now = time.time() if now is None else now
    return [b for b in bars if b[0] % step == 0 and b[0] + step <= now]


def _cached(symbol, rng, interval, max_age):
    path = os.path.join(CACHE_DIR, "%s_%s_%s.json" % (symbol.replace("/", "_"), rng, interval))
    if max_age and os.path.exists(path) and time.time() - os.path.getmtime(path) < max_age:
        try:
            with open(path, encoding="utf-8") as fh:
                return [tuple(b) for b in json.load(fh)]
        except (ValueError, OSError):
            pass
    bars = fetch_chart(symbol, rng, interval)
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(bars, fh)
    os.replace(tmp, path)
    return bars


def load_history(symbols, max_age=600, progress=None, workers=4):
    """60 days of 5-minute bars and a year of daily bars for every symbol."""
    out, errors, done = {}, {}, [0]

    def one(sym):
        try:
            intraday = complete_bars(_cached(sym, "60d", "5m", max_age))
            daily = _cached(sym, "1y", "1d", max(max_age, 6 * 3600))
            return sym, {"intraday": intraday, "daily": daily}, None
        except Exception as e:  # one bad ticker must not sink the rest
            return sym, None, str(e)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for sym, data, err in pool.map(one, symbols):
            done[0] += 1
            if data and data["intraday"]:
                out[sym] = data
            else:
                errors[sym] = err or "no data"
            if progress:
                progress(done[0], len(symbols))
    return out, errors


def poll_today(symbols, workers=4):
    """The current session's finished 5-minute bars, per symbol."""
    def one(sym):
        try:
            return sym, complete_bars(fetch_chart(sym, "1d", "5m", timeout=20))
        except Exception:
            return sym, None

    with ThreadPoolExecutor(max_workers=workers) as pool:
        return {sym: bars for sym, bars in pool.map(one, symbols) if bars}
