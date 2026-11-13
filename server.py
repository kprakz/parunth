#!/usr/bin/env python3
"""Parunth dashboard server. Standard library only.

    python3 server.py            then open http://127.0.0.1:8765

Loads market history, replays the last few sessions at the chosen speed, and
when it reaches the present keeps going live, one 5-minute bar at a time.
Virtual money only: nothing here can reach a broker.
"""
import argparse
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from parunth import config, feed
from parunth.engine import Engine

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
STATE = os.path.join(ROOT, "data", "state.json")   # the run's memory; data/ is never committed
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
}
AVATARS = {"/avatars/%s.jpg" % name: "%s.jpg" % name for name in ("chathan", "neeli", "charlie", "moothon")}
CURRENCY_SYMBOLS = {"USD": "$", "GBP": "\u00a3", "EUR": "\u20ac", "INR": "\u20b9"}


class Runner(threading.Thread):
    """Owns the engine and moves it forward."""

    def __init__(self, cfg, fresh=False):
        super().__init__(daemon=True)
        self.cfg = cfg
        self.fresh = fresh          # ignore any saved run and start over
        self.saved_at = 0.0
        self.saved_cursor = -1
        self.resumed = False
        self.engine = None
        self.status = "loading"
        self.message = "Starting up"
        self.speed = cfg["speed"]
        self.paused = False
        self.sessions_back = cfg["sessions_back"]
        self.last_poll = 0.0
        self.announced_live = False
        self.errors = {}

    def run(self):
        try:
            self._load()
        except Exception as e:
            self.status, self.message = "error", "Could not load market data: %s" % e
            return
        while True:
            try:
                self._tick()
            except Exception as e:   # keep the dashboard alive, show what went wrong
                self.message = "Problem while running: %s" % e
                time.sleep(2)

    def _load(self):
        symbols = self.cfg["symbols"] + [self.cfg["benchmark"]]

        def progress(done, total):
            self.message = "Loading market history: %d of %d symbols" % (done, total)

        code = str(self.cfg.get("currency") or "USD").upper()
        self.cfg["currency"] = code
        self.cfg["fx_rate"], self.cfg["currency_symbol"] = 1.0, CURRENCY_SYMBOLS.get(code, code + " ")
        if code != "USD":
            # One exchange rate, fixed for the whole run: currency moves are not simulated.
            self.message = "Looking up the %s exchange rate" % code
            rate = feed.fetch_chart(code + "USD=X", "5d", "1d")
            if not rate:
                raise RuntimeError("no exchange rate for %s" % code)
            self.cfg["fx_rate"] = rate[-1][4]
        history, self.errors = feed.load_history(symbols, progress=progress)
        if self.cfg["benchmark"] not in history:
            raise RuntimeError("no data for the benchmark %s (%s)" % (
                self.cfg["benchmark"], self.errors.get(self.cfg["benchmark"], "unknown")))
        engine = Engine(self.cfg)
        engine.load(history)
        engine.reset_book(self.cfg["start_cash"] * self.cfg["fx_rate"], self.sessions_back)
        if not self.fresh and os.path.exists(STATE):
            try:
                with open(STATE, encoding="utf-8") as fh:
                    saved = json.load(fh)
                engine.restore(saved["engine"])
                self.sessions_back = saved.get("sessions_back", self.sessions_back)
                self.resumed = True
                engine.say("system", "day", "Picked up where the last run stopped. Account, trust scores and lessons are as they were.")
            except (ValueError, KeyError, TypeError, OSError) as e:   # a bad save must not stop the app
                engine.reset_book(self.cfg["start_cash"] * self.cfg["fx_rate"], self.sessions_back)
                engine.say("system", "day", "Could not read the saved run (%s). Started a new one." % e)
        self.engine = engine
        self.last_poll = time.time()
        self.status, self.message = "replay", ""

    def save(self, force=False):
        """Write the run to disk: after every live bar, and every few seconds during a replay."""
        eng = self.engine
        if not eng or (eng.cursor == self.saved_cursor and not force):
            return
        if not force and eng.has_next() and time.time() - self.saved_at < 5:
            return
        data = {"engine": eng.dump(), "sessions_back": self.sessions_back, "saved": time.time()}
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        tmp = STATE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, separators=(",", ":"))
        os.replace(tmp, STATE)
        self.saved_at, self.saved_cursor = time.time(), eng.cursor

    def _tick(self):
        eng = self.engine
        self.save()
        if self.paused:
            time.sleep(0.1)
            return
        if eng.has_next():
            self.status = "replay"
            if self.speed >= 1000:
                with eng.lock:
                    for _ in range(40):
                        if not eng.step():
                            break
                time.sleep(0.005)
            else:
                eng.step()
                time.sleep(1.0 / self.speed)
            return
        # Caught up with the present: wait for the market to print new bars.
        latest = eng.timeline[-1] + feed.BAR if eng.timeline else 0
        fresh = time.time() - latest < 15 * 60
        self.status = "live" if fresh else "closed"
        if not self.announced_live:
            self.announced_live = True
            with eng.lock:
                eng.say("system", "day", "Caught up with the market. Running live from here." if fresh else
                        "Caught up. The market is closed, waiting for the next session.")
        if time.time() - self.last_poll >= (60 if fresh else 300):
            self.last_poll = time.time()
            polled = feed.poll_today(eng.symbols + [eng.bench])
            with eng.lock:
                bench_bars = polled.pop(eng.bench, None)
                for sym, bars in polled.items():
                    eng.ingest(sym, bars)
                if bench_bars:   # the benchmark drives the clock, so it goes in last
                    eng.ingest(eng.bench, bench_bars)
        else:
            time.sleep(0.5)

    def control(self, body):
        action = body.get("action")
        if action == "pause":
            self.paused = True
        elif action == "play":
            self.paused = False
        elif action == "speed":
            self.speed = max(1, min(1000, int(body.get("value", self.speed))))
        elif action == "restart" and self.engine:
            fx = self.engine.fx
            cash = float(body.get("cash", self.engine.start_cash / fx))
            if not 10 <= cash <= 1e9:
                raise ValueError("virtual cash must be between 10 and 1,000,000,000")
            self.sessions_back = max(1, min(49, int(body.get("sessions", self.sessions_back))))
            self.engine.reset_book(cash * fx, self.sessions_back)
            self.announced_live = False
            self.paused = False
            self.save(force=True)   # a restart replaces the saved run
        else:
            raise ValueError("unknown action")

    def state(self, focus):
        base = {"status": self.status, "message": self.message, "speed": self.speed, "resumed": self.resumed,
                "paused": self.paused, "sessions_back": self.sessions_back,
                "skipped": sorted(self.errors)}
        if self.engine:
            base.update(self.engine.snapshot(focus))
        return base


def make_handler(runner):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, code, body, ctype, cache="no-store"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", cache)
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code, obj):
            self._send(code, json.dumps(obj, separators=(",", ":")).encode("utf-8"), "application/json")

        def do_GET(self):
            url = urlparse(self.path)
            if url.path == "/api/state":
                focus = (parse_qs(url.query).get("symbol") or [""])[0].upper() or None
                return self._json(200, runner.state(focus))
            if url.path in STATIC:
                name, ctype = STATIC[url.path]
                with open(os.path.join(WEB, name), "rb") as fh:
                    return self._send(200, fh.read(), ctype)
            if url.path in AVATARS:   # optional pictures; the page falls back to initials
                path = os.path.join(WEB, "avatars", AVATARS[url.path])
                if os.path.exists(path):
                    with open(path, "rb") as fh:
                        return self._send(200, fh.read(), "image/jpeg", "max-age=3600")
            self._json(404, {"error": "not found"})

        def do_POST(self):
            if urlparse(self.path).path != "/api/control":
                return self._json(404, {"error": "not found"})
            try:
                size = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(min(size, 4096)) or b"{}")
                runner.control(body)
                self._json(200, {"ok": True})
            except (ValueError, TypeError) as e:
                self._json(400, {"error": str(e)})

    return Handler


def main():
    ap = argparse.ArgumentParser(description="Parunth: three agents, virtual money.")
    ap.add_argument("--port", type=int)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--fresh", action="store_true", help="ignore the saved run and start a new one")
    args = ap.parse_args()
    cfg = config.load()
    port = args.port or cfg["port"]
    runner = Runner(cfg, fresh=args.fresh)
    runner.start()
    server = ThreadingHTTPServer((args.host, port), make_handler(runner))
    print("Parunth is running at http://%s:%d  (Ctrl+C to stop)" % (args.host, port))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        runner.save(force=True)
        print("\nStopped. The run is saved and will continue next time.")


if __name__ == "__main__":
    main()
