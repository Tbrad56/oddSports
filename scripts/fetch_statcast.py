#!/usr/bin/env python3
"""
Fetches season batter Statcast metrics (avg exit velo, barrel%, hard-hit%)
from Baseball Savant's custom leaderboard CSV export and writes them to
data/statcast.json for the app to consume.

Runs in GitHub Actions (see .github/workflows/statcast.yml) — not in the
browser, so no CORS concerns. Be a polite citizen: this runs once per day.
"""
import csv
import io
import json
import sys
import urllib.request
from datetime import date

YEAR = date.today().year

URL = (
    "https://baseballsavant.mlb.com/leaderboard/custom"
    f"?year={YEAR}&type=batter&filter=&min=25"
    "&selections=exit_velocity_avg,barrel_batted_rate,hard_hit_percent"
    "&chart=false&x=exit_velocity_avg&y=exit_velocity_avg"
    "&r=no&chartType=beeswarm&csv=true"
)

def norm_name(last_first: str) -> str:
    """'Judge, Aaron' -> 'aaron judge' (matches MLB Stats API fullName lowercased)."""
    parts = [p.strip() for p in last_first.split(",")]
    if len(parts) == 2:
        return f"{parts[1]} {parts[0]}".lower()
    return last_first.strip().lower()

def main() -> int:
    req = urllib.request.Request(URL, headers={"User-Agent": "oddSports-statcast-sync/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        text = resp.read().decode("utf-8-sig")

    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        print("No CSV header returned — Savant may have changed the endpoint.", file=sys.stderr)
        return 1

    # Column names as of the current Savant export; adjust here if they drift.
    name_col = next((c for c in reader.fieldnames if "name" in c.lower()), None)
    ev_col = next((c for c in reader.fieldnames if "exit_velocity_avg" in c), None)
    barrel_col = next((c for c in reader.fieldnames if "barrel" in c), None)
    hh_col = next((c for c in reader.fieldnames if "hard_hit" in c), None)

    if not all([name_col, ev_col, barrel_col, hh_col]):
        print(f"Missing expected columns. Got: {reader.fieldnames}", file=sys.stderr)
        return 1

    out = {}
    for row in reader:
        try:
            out[norm_name(row[name_col])] = {
                "ev": round(float(row[ev_col]), 1),
                "barrel": round(float(row[barrel_col]), 1),
                "hardhit": round(float(row[hh_col]), 1),
            }
        except (ValueError, KeyError):
            continue  # skip rows with blank/malformed numbers

    if len(out) < 50:
        print(f"Only {len(out)} players parsed — refusing to overwrite good data.", file=sys.stderr)
        return 1

    payload = {"updated": date.today().isoformat(), "season": YEAR, "batters": out}
    with open("data/statcast.json", "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"Wrote {len(out)} batters to data/statcast.json")
    return 0

if __name__ == "__main__":
    sys.exit(main())
