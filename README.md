# parunth

A day-trading dashboard run by four agents, on virtual money only.

- **Chathan** is always eager to invest. He chases whatever is moving.
- **Neeli** takes calculated risk. Every one of her checks must pass or she sits out.
- **Charlie** is the consultant. He pitches nothing; he weighs each idea the other two
  bring and tells Moothon how confident he is that it should be taken.
- **Moothon** is the judge. He hears all three, weighs each by the trust they have
  earned, decides what the virtual money buys, and says when to get out.

Each agent has a trust score (0 to 100, starting at 50) that moves with the results of
its own calls.

## Run it

```bash
python3 server.py
```

Then open http://127.0.0.1:8765. It needs Python 3.9 or newer and nothing else.

The dashboard replays the last few sessions bar by bar, then carries on live when it
reaches the present. The run (account, trust scores, lessons) is saved in `data/state.json`
as it goes, so stopping and starting the server continues where it left off. Press Restart,
or start with `python3 server.py --fresh`, to begin a new run. Use the top bar to pause, change the replay speed, or restart
with a different amount of virtual cash and a different starting day.

## Test it

```bash
python3 -m unittest discover -s tests -v
```

## Settings

Copy any keys you want to change from `parunth/config.py` into a `config.json` next to
`server.py`: the watchlist, starting cash, Moothon's limits, the port.

## How it works

- Prices are free, delayed 5-minute bars from Yahoo Finance for a fixed watchlist of
  US large caps. `SPY` is the yardstick and is never traded.
- At the close of each bar the agents see only finished bars. Moothon's orders fill at
  the next bar's open, with slippage. Stops and targets are checked against each bar's
  low and high; if one bar touches both, the stop is assumed to come first.
- Long only, no leverage, at most three positions, flat by the close every day.
- Chathan's and Neeli's top picks are tracked on paper whether or not Moothon takes
  them, so their trust scores reflect their own calls. Moothon is scored on his real
  trades and, at half weight, on what he passed up.

Virtual money only. Nothing here can place a real order, and none of it is financial
advice.
