"""Offline tests on synthetic bars. Run: python3 -m unittest discover -s tests -v"""
import datetime
import math
import os
import random
import sys
import unittest
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from parunth import agents, config, feed                     # noqa: E402
from parunth.engine import BAR, Engine                       # noqa: E402
from parunth.scoring import trust_score                      # noqa: E402

TZ = ZoneInfo("America/New_York")


def session_days(n, end=datetime.date(2026, 11, 6)):
    days, d = [], end
    while len(days) < n:
        if d.weekday() < 5:
            days.append(d)
        d -= datetime.timedelta(days=1)
    return days[::-1]


def make_history(symbols, n_days=30, seed=7, drift=None):
    """Random-walk 5-minute bars, plus daily bars reaching further back."""
    rng = random.Random(seed)
    drift = drift or {}
    out = {}
    days = session_days(n_days)
    for k, sym in enumerate(symbols):
        px = 100.0 + 20 * k
        daily, intraday = [], []
        for j in range(80):   # older daily history, before the intraday window
            day = days[0] - datetime.timedelta(days=80 - j)
            t = int(datetime.datetime(day.year, day.month, day.day, 9, 30, tzinfo=TZ).timestamp())
            o = px
            px *= 1 + rng.gauss(0.0005, 0.01)
            daily.append((t, o, max(o, px) * 1.003, min(o, px) * 0.997, px, 1000000))
        for day in days:
            t0 = int(datetime.datetime(day.year, day.month, day.day, 9, 30, tzinfo=TZ).timestamp())
            for i in range(78):
                o = px
                px *= 1 + rng.gauss(drift.get(sym, 0.0), 0.0012)
                h, l = max(o, px) * (1 + abs(rng.gauss(0, 0.0004))), min(o, px) * (1 - abs(rng.gauss(0, 0.0004)))
                intraday.append((t0 + i * BAR, o, h, l, px, int(50000 * (1.6 if i < 6 else 1) * rng.uniform(0.5, 1.8))))
        out[sym] = {"daily": daily, "intraday": intraday}
    return out


def make_engine(sessions=10, **over):
    cfg = config.load(path="/nonexistent")
    cfg.update(symbols=["AAA", "BBB", "CCC", "DDD"], benchmark="SPY")
    cfg.update(over)
    eng = Engine(cfg)
    eng.load(make_history(cfg["symbols"] + ["SPY"], drift={"AAA": 0.00012, "BBB": 0.00008}))
    eng.reset_book(cfg["start_cash"], sessions)
    return eng


def run(eng):
    while eng.step():
        pass
    return eng


class TrustScore(unittest.TestCase):
    def test_starts_neutral(self):
        self.assertEqual(trust_score([]), 50.0)

    def test_winners_raise_and_losers_lower(self):
        self.assertGreater(trust_score([2, 2, -1, 2, 2]), 65)
        self.assertLess(trust_score([-1] * 8), 30)

    def test_needs_evidence(self):
        self.assertLess(trust_score([3]), trust_score([3] * 10))

    def test_recent_calls_count_more(self):
        self.assertGreater(trust_score([-1] * 20 + [2] * 20), trust_score([2] * 20 + [-1] * 20))

    def test_bounded(self):
        for rs in ([50] * 100, [-50] * 100):
            self.assertTrue(0 <= trust_score(rs) <= 100)


class Feed(unittest.TestCase):
    def test_parse_skips_missing_rows(self):
        payload = {"chart": {"result": [{"timestamp": [300, 600, 900], "indicators": {"quote": [{
            "open": [1, None, 3], "high": [2, None, 4], "low": [0.5, None, 2.5],
            "close": [1.5, None, 3.5], "volume": [10, None, None]}]}}]}}
        bars = feed.parse_chart(payload)
        self.assertEqual([b[0] for b in bars], [300, 900])
        self.assertEqual(bars[1][5], 0)

    def test_unfinished_bar_is_dropped(self):
        bars = [(600, 1, 1, 1, 1, 1), (900, 1, 1, 1, 1, 1), (1015, 1, 1, 1, 1, 1)]
        self.assertEqual([b[0] for b in feed.complete_bars(bars, now=1100)], [600])
        self.assertEqual([b[0] for b in feed.complete_bars(bars, now=1200)], [600, 900])


class Judge(unittest.TestCase):
    def pitch(self, agent, conv, risk=1.0, rr=2.0):
        return {"agent": agent, "symbol": "AAA", "conviction": conv, "entry": 100.0, "stop": 100 - risk,
                "target": 100 + rr * risk, "risk": risk, "rr": rr, "reasons": ["r"], "t": 0}

    def rank(self, c=None, n=None, objections=(), trust=None):
        cfg = config.load(path="/nonexistent")
        return agents.moothon_rank({"AAA": c} if c else {}, {"AAA": n} if n else {},
                                   {"AAA": list(objections)}, trust or {"chathan": 50, "neeli": 50}, cfg)[0]

    def test_agreement_beats_either_alone(self):
        both = self.rank(self.pitch("chathan", 70), self.pitch("neeli", 70))
        alone = self.rank(n=self.pitch("neeli", 70))
        self.assertEqual(both["basis"], "both")
        self.assertGreater(both["score"], alone["score"])

    def test_severe_objection_vetoes_chathan(self):
        cand = self.rank(c=self.pitch("chathan", 95), objections=[("severe", "the daily chart is in a downtrend")])
        self.assertTrue(cand["veto"])
        self.assertEqual(cand["score"], 0)

    def test_trust_changes_how_much_chathan_counts(self):
        low = self.rank(c=self.pitch("chathan", 80), trust={"chathan": 30, "neeli": 50})
        high = self.rank(c=self.pitch("chathan", 80), trust={"chathan": 75, "neeli": 50})
        self.assertGreater(high["score"], low["score"])


class Simulation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.eng = run(make_engine())

    def test_it_trades(self):
        self.assertGreater(len(self.eng.trades), 3)

    def test_same_inputs_same_result(self):
        other = run(make_engine())
        self.assertEqual(self.eng.equity(), other.equity())
        self.assertEqual(len(self.eng.trades), len(other.trades))

    def test_flat_at_the_end_of_every_session(self):
        self.assertEqual(self.eng.positions, {})
        for t in self.eng.trades:
            self.assertEqual(self.eng.date_of(t["t_in"]), self.eng.date_of(t["t_out"] - BAR))

    def test_money_adds_up(self):
        realized = sum(t["pnl"] for t in self.eng.trades)
        self.assertAlmostEqual(self.eng.cash, self.eng.start_cash + realized, places=4)
        self.assertAlmostEqual(self.eng.equity(), self.eng.cash, places=6)

    def test_entries_fill_at_the_next_bar_open(self):
        slip = self.eng.cfg["slippage_bps"] / 10000.0
        for t in self.eng.trades:
            bar = self.eng.at[t["symbol"]][t["t_in"]]
            self.assertAlmostEqual(t["entry"], bar[1] * (1 + slip), places=6)

    def test_exits_stay_inside_the_bar_they_happened_in(self):
        slip = self.eng.cfg["slippage_bps"] / 10000.0
        for t in self.eng.trades:
            bar = self.eng.at[t["symbol"]][t["t_out"] - BAR]
            raw = t["exit"] / (1 - slip)
            self.assertLessEqual(raw, bar[2] + 1e-6)
            self.assertGreaterEqual(raw, bar[3] - 1e-6)

    def test_a_stop_never_loses_more_than_planned_without_a_gap(self):
        for t in self.eng.trades:
            if t["reason"] == "Stop hit":
                self.assertLess(t["r"], 0)
                bar = self.eng.at[t["symbol"]][t["t_out"] - BAR]
                gapped = bar[1] < t["entry"] - abs(t["pnl"] / t["shares"])
                if not gapped:
                    self.assertGreater(t["r"], -1.35)

    def test_a_small_account_still_trades_with_fractional_shares(self):
        small = run(make_engine(start_cash=100, fractional_shares=True))
        self.assertGreater(len(small.trades), 3)
        self.assertTrue(any(t["shares"] < 1 for t in small.trades))
        whole = run(make_engine(start_cash=100, fractional_shares=False))
        self.assertTrue(all(t["shares"] == int(t["shares"]) for t in whole.trades))

    def test_account_currency_only_changes_the_wording(self):
        gbp = make_engine(fx_rate=1.25, currency_symbol="\u00a3")
        gbp.reset_book(gbp.cfg["start_cash"], 10)
        run(gbp)
        self.assertEqual(len(gbp.trades), len(self.eng.trades))
        self.assertEqual(gbp.signed_money(12.5), "+\u00a310.00")
        self.assertEqual(gbp.snapshot()["money"]["rate"], 1.25)

    def test_limits_hold(self):
        cfg = self.eng.cfg
        eng = make_engine()
        while eng.step():
            self.assertLessEqual(len(eng.positions), cfg["max_positions"])
            self.assertGreaterEqual(eng.cash, -1e-6)
            for sym in eng.positions:
                self.assertNotEqual(sym, cfg["benchmark"])

    def test_trust_and_snapshot(self):
        snap = self.eng.snapshot()
        for name in ("chathan", "neeli", "moothon"):
            self.assertTrue(0 <= snap["agents"][name]["trust"] <= 100)
        self.assertGreater(snap["agents"]["chathan"]["n"], 0)
        self.assertEqual(snap["account"]["n"], len(self.eng.trades))
        self.assertTrue(math.isfinite(snap["account"]["equity"]))
        self.assertTrue(snap["clock"]["caught_up"])

    def test_live_bars_extend_the_run(self):
        eng = make_engine(sessions=3)
        cut = eng.timeline[-40]
        held = {s: [b for b in eng.intra[s] if b[0] >= cut] for s in eng.intra}
        fresh = Engine(eng.cfg)
        full = make_history(eng.cfg["symbols"] + ["SPY"], drift={"AAA": 0.00012, "BBB": 0.00008})
        fresh.load({s: {"daily": d["daily"], "intraday": [b for b in d["intraday"] if b[0] < cut]} for s, d in full.items()})
        fresh.reset_book(eng.cfg["start_cash"], 3)
        run(fresh)
        for s in fresh.symbols:
            fresh.ingest(s, held[s])
        fresh.ingest("SPY", held["SPY"])
        run(fresh)
        run(eng)
        self.assertEqual(len(fresh.timeline), len(eng.timeline))
        self.assertAlmostEqual(fresh.equity(), eng.equity(), places=6)


if __name__ == "__main__":
    unittest.main()
