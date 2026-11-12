"""Defaults, overridable by a config.json next to server.py."""
import json
import os

DEFAULTS = {
    # What the agents watch. Liquid US large caps; the benchmark is never traded.
    "symbols": [
        "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD",
        "NFLX", "AVGO", "JPM", "BAC", "XOM", "CVX", "WMT", "COST",
        "DIS", "BA", "INTC", "PLTR", "COIN", "UBER", "CRM", "ORCL",
    ],
    "benchmark": "SPY",
    "timezone": "America/New_York",
    "session_minutes": 390,        # 9:30 to 16:00

    # Virtual money
    "currency": "GBP",             # the account's currency; stock prices stay in dollars
    "start_cash": 100,
    "fractional_shares": True,     # needed for a small account: one share can cost more than the pot
    "sessions_back": 5,            # where the simulation starts
    "speed": 6,                    # replay bars per second (1000 = as fast as possible)
    "slippage_bps": 1,             # charged on every fill

    # Moothon's rules
    "take_score": 62,              # minimum judge score to invest
    "max_positions": 3,
    "daily_loss_limit_pct": 2.0,   # stop opening trades after losing this much in a day
    "position_cap_pct": {"both": 33, "neeli": 25, "chathan": 15},
    "risk_pct": {"both": 1.0, "neeli": 0.75, "chathan": 0.4},

    "port": 8765,
}


def load(path=None):
    cfg = json.loads(json.dumps(DEFAULTS))
    path = path or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            user = json.load(fh)
        for key, val in user.items():
            if isinstance(val, dict) and isinstance(cfg.get(key), dict):
                cfg[key].update(val)
            else:
                cfg[key] = val
    cfg["symbols"] = [s.upper() for s in cfg["symbols"] if s.upper() != cfg["benchmark"].upper()]
    cfg["benchmark"] = cfg["benchmark"].upper()
    return cfg
