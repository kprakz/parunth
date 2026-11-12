"""How the agents learn from their own results.

Nothing here is a neural network. Each agent keeps a running record, in R, of
how calls turned out when a given signal, check or factor was part of them, and
changes one thing about its own behaviour when that record is clear enough:

  Chathan   leans harder on the signals that have paid and less on the ones
            that have not, and raises his bar when his recent picks are losing.
  Neeli     drops a check that keeps blocking trades which then won (her
            missed wins), and brings it back if dropping it starts to cost.
  Charlie   re-weights each factor by whether it pointed the right way.
  Moothon   lowers his bar when he keeps passing on winners, and raises it
            when the trades he does take are losing.

Old results fade (each new one shrinks the weight of everything before it), so
an agent can change its mind again. Every change is written down as a lesson.
The memory lives with the simulation: a restart begins it again from nothing.
"""
import math

from . import agents

FADE = 0.94          # how much of the old record survives each new result
PRIOR = 4.0          # results needed before the record is believed


class Record:
    """A fading tally of results, in R."""

    def __init__(self):
        self.n = 0.0
        self.total = 0.0
        self.count = 0

    def add(self, r):
        self.n = self.n * FADE + 1.0
        self.total = self.total * FADE + max(-1.5, min(3.0, r))
        self.count += 1

    @property
    def mean(self):
        return self.total / self.n if self.n else 0.0

    @property
    def shrunk(self):
        return self.total / (self.n + PRIOR)


class Brain:
    def __init__(self, cfg):
        self.cfg = cfg
        self.chathan = {"w": {}, "bar": 35, "rec": {}, "recent": []}
        self.neeli = {"waived": set(), "rec": {}}
        self.charlie = {"w": {}, "rec": {}}
        self.moothon = {"bar": cfg["take_score"], "since": 0}
        self.lessons = []
        self._said = {}

    # ------------------------------------------------------------- helpers

    def _lesson(self, who, text, t):
        self.lessons.append({"t": t, "who": who, "text": text})
        del self.lessons[:-60]
        return (who, text)

    def _reweigh(self, who, mind, key, label, t, lo, hi, gain, read=False):
        """Turn a record into a weight; report it when it crosses a line."""
        rec = mind["rec"][key]
        w = max(lo, min(hi, 1.0 + gain * math.tanh(rec.shrunk / 0.4)))
        mind["w"][key] = round(w, 3)
        was = self._said.get((who, key), "same")
        # Lines with a gap between them, so a weight hovering near one does not flip back and forth.
        band = "more" if w >= 1.25 else "less" if w <= 0.75 else "same" if 0.92 <= w <= 1.08 else was
        if band == was or rec.count < 6:
            return None
        self._said[(who, key)] = band
        if read and band != "same":   # Charlie's factors can be warnings, so say whether the read was right
            return self._lesson(who, "My read on %s has been %s (%+.2fR a call). I'm giving it %s weight." % (
                label, "right" if band == "more" else "wrong", rec.mean, band), t)
        if band == "more":
            return self._lesson(who, "%s has been paying (%+.2fR a call). I'm leaning on it more." % (cap(label), rec.mean), t)
        if band == "less":
            return self._lesson(who, "%s has been costing me (%+.2fR a call). I'm trusting it less." % (cap(label), rec.mean), t)
        return self._lesson(who, "%s is back to normal weight." % cap(label), t)

    # ------------------------------------------------------- what they learn

    def pick_closed(self, agent, r, shadow, t):
        """One of Chathan's or Neeli's own picks has finished. Returns new lessons."""
        out = []
        if agent == "chathan":
            m = self.chathan
            for key in shadow.get("keys") or ():
                m["rec"].setdefault(key, Record()).add(r)
                out.append(self._reweigh("chathan", m, key, agents.SIGNALS.get(key, key), t, 0.4, 1.6, 0.6))
            m["recent"] = (m["recent"] + [max(-1.5, min(3.0, r))])[-10:]
            if len(m["recent"]) >= 6:
                avg = sum(m["recent"]) / len(m["recent"])
                if avg < -0.3 and m["bar"] < 55:
                    m["bar"] += 3
                    m["recent"] = []
                    out.append(self._lesson("chathan", "My last picks lost %.2fR each on average. Fine, I'll be pickier: my bar is now %d." % (-avg, m["bar"]), t))
                elif avg > 0.25 and m["bar"] > 30:
                    m["bar"] -= 2
                    m["recent"] = []
                    out.append(self._lesson("chathan", "My picks are working (%+.2fR each). Loosening up: my bar is now %d." % (avg, m["bar"]), t))
            # Neeli learns from what she said about this pick
            n = self.neeli
            for key in shadow.get("n_obj") or ():
                if key not in agents.CHECKS:
                    continue   # severe checks are never dropped
                rec = n["rec"].setdefault(key, Record())
                rec.add(r)
                label = agents.CHECKS[key]
                if key not in n["waived"] and rec.count >= 5 and rec.shrunk > 0.2:
                    n["waived"].add(key)
                    out.append(self._lesson("neeli", "I keep missing winners by %s (those trades made %+.2fR on average). I'm dropping that check." % (label, rec.mean), t))
                elif key in n["waived"] and rec.shrunk < -0.05:
                    n["waived"].discard(key)
                    out.append(self._lesson("neeli", "Dropping the check on %s was a mistake (%+.2fR since). It's back." % (label, rec.mean), t))
        # Charlie learns from every pick he reviewed
        c = self.charlie
        for key, sign in shadow.get("factors") or ():
            c["rec"].setdefault(key, Record()).add(sign * r)
            out.append(self._reweigh("charlie", c, key, agents.FACTORS.get(key, key), t, 0.3, 1.8, 0.8, read=True))
        return [o for o in out if o]

    def judge_scored(self, outcomes, t):
        """Moothon looks back at his recent trades and passes and moves his bar."""
        m = self.moothon
        m["since"] += 1
        if m["since"] < 6:
            return []
        trades = [o["r"] for o in outcomes if o.get("kind") == "trade"][-8:]
        passes = [o["r"] for o in outcomes if o.get("kind") == "pass"][-12:]   # negative = a missed winner
        lo, hi = self.cfg["take_score"] - 10, self.cfg["take_score"] + 12
        if len(trades) >= 5 and sum(trades) / len(trades) < -0.25 and m["bar"] < hi:
            m["bar"] += 2
            m["since"] = 0
            return [self._lesson("moothon", "My last %d trades averaged %+.2fR. I was too easy to convince. My bar is now %d." % (
                len(trades), sum(trades) / len(trades), m["bar"]), t)]
        missed = sum(1 for r in passes if r < 0)
        if len(passes) >= 8 and missed >= 0.6 * len(passes) and m["bar"] > lo and (not trades or sum(trades) / len(trades) > -0.1):
            m["bar"] -= 2
            m["since"] = 0
            return [self._lesson("moothon", "%d of my last %d passes went on to win. I was too cautious. My bar is now %d." % (
                missed, len(passes), m["bar"]), t)]
        return []

    # ---------------------------------------------------------- for display

    def summary(self):
        def moved(mind, labels):
            rows = [{"what": labels.get(k, k), "weight": w, "calls": mind["rec"][k].count, "avg_r": round(mind["rec"][k].mean, 2)}
                    for k, w in mind["w"].items() if abs(w - 1.0) >= 0.08]
            return sorted(rows, key=lambda x: -abs(x["weight"] - 1.0))[:4]

        return {
            "chathan": {"bar": self.chathan["bar"], "weights": moved(self.chathan, agents.SIGNALS)},
            "neeli": {"waived": [agents.CHECKS[k] for k in sorted(self.neeli["waived"])]},
            "charlie": {"weights": moved(self.charlie, agents.FACTORS)},
            "moothon": {"bar": self.moothon["bar"], "start": self.cfg["take_score"]},
            "lessons": self.lessons[-14:][::-1],
            "count": len(self.lessons),
        }


def cap(s):
    return s[:1].upper() + s[1:]
