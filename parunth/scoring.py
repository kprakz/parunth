"""Trust scores and portfolio statistics.

Every outcome is measured in R: profit or loss divided by what was at risk
when the trade was opened. +2R means it made twice the risk; -1R means the
stop was hit.
"""
import math


def trust_score(rs, decay=0.97, prior=5.0):
    """0-100. Starts at 50 and moves as results come in.

    Mostly the average R per call, partly the win rate. Recent calls count
    more (each older call weighs 3% less), and the score is held near 50 until
    there is enough evidence: it behaves as if every agent began with five
    break-even calls.
    """
    w, sw, swr, sww = 1.0, 0.0, 0.0, 0.0
    for r in reversed(rs):
        sw += w
        swr += w * max(-1.5, min(3.0, r))
        if r > 0:
            sww += w
        w *= decay
    expectancy = swr / (sw + prior)
    win_rate = (sww + prior / 2.0) / (sw + prior)
    score = 50.0 + 35.0 * math.tanh(expectancy / 0.35) + 20.0 * (win_rate - 0.5)
    return max(0.0, min(100.0, score))


def record(rs):
    n = len(rs)
    wins = sum(1 for r in rs if r > 0)
    return {
        "n": n, "wins": wins, "losses": n - wins,
        "win_rate": (wins / n) if n else None,
        "avg_r": (sum(rs) / n) if n else None,
        "total_r": sum(rs),
    }


def book_stats(trades):
    pnl = [t["pnl"] for t in trades]
    gains = sum(p for p in pnl if p > 0)
    losses = -sum(p for p in pnl if p < 0)
    out = record([t["r"] for t in trades])
    out["realized"] = sum(pnl)
    out["profit_factor"] = (gains / losses) if losses else None
    out["best"] = max(pnl) if pnl else None
    out["worst"] = min(pnl) if pnl else None
    return out
