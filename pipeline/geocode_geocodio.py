"""Re-geocode the VAN export's distinct addresses with Geocodio (rooftop accuracy).
Sends only: row id, street, city, state, zip. Reads GEOCODIO_API_KEY from the environment.
Keeps the Census result where Geocodio's accuracy is no better.
    python3 geocode_geocodio.py --test     # first 100 only, prints results, nothing saved
    python3 geocode_geocodio.py            # all, writes data/geo/geocodio_*.json and updates data/geocoded.csv
"""
import argparse, json, os, sys, time, requests, pandas as pd

import glob
ap = argparse.ArgumentParser(); ap.add_argument("--test", action="store_true")
ap.add_argument("--van", default=None, help="VAN export; default: newest data/van/*.xls")
a = ap.parse_args()
KEY = os.environ.get("GEOCODIO_API_KEY")
if not KEY:
    sys.exit("set GEOCODIO_API_KEY first")

g = pd.read_csv("data/geocoded.csv", dtype=str)
g["id"] = g.id.astype(int)
addrs = g.head(100) if a.test else g
print(f"{len(addrs)} addresses")

os.makedirs("data/geo", exist_ok=True)
RANK = {"rooftop": 5, "point": 5, "nearest_rooftop_match": 4, "range_interpolation": 3, "street_center": 2, "place": 1, "state": 0}
def fetch(i):
    """One 10k batch; cached on disk so an interrupted run never re-sends (and never re-pays)."""
    chunk = addrs.iloc[i:i + 10000]
    out = f"data/geo/geocodio_{i // 10000:02d}.json"
    if os.path.exists(out) and not a.test:
        print("cached", out); return json.load(open(out))
    payload = {str(r.id): {"street": r.Address, "city": r.City if isinstance(r.City, str) else "",
                           "state": "AK", "postal_code": r.Zip5 if isinstance(r.Zip5, str) else ""}
               for r in chunk.itertuples()}
    for attempt in range(4):
        r = requests.post("https://api.geocod.io/v1.7/geocode", params={"api_key": KEY}, json=payload, timeout=900)
        if r.ok: break
        print("retry", attempt, r.status_code, r.text[:200]); time.sleep(20 * (attempt + 1))
    r.raise_for_status()
    res = r.json()["results"]
    if not a.test: json.dump(res, open(out, "w"))
    print(f"batch {i // 10000}: {len(res)} results", flush=True)
    return res

from concurrent.futures import ThreadPoolExecutor
starts = list(range(0, len(addrs), 10000))
with ThreadPoolExecutor(max_workers=len(starts)) as ex:
    results = list(ex.map(fetch, starts))

rows = []
for res in results:
    for rid, rr in res.items():
        best = (rr.get("response", {}).get("results") or [None])[0]
        if best:
            rows.append({"id": int(rid), "g_lat": best["location"]["lat"], "g_lon": best["location"]["lng"],
                         "g_accuracy": best.get("accuracy"), "g_type": best.get("accuracy_type"),
                         "g_address": best.get("formatted_address")})
        else:
            rows.append({"id": int(rid), "g_type": None})

gg = pd.DataFrame(rows)
print("\nGeocodio accuracy types:"); print(gg.g_type.value_counts(dropna=False).to_string())
m = addrs.merge(gg, on="id", how="left")
if a.test:
    print(m[["Address", "matchtype", "g_type", "g_accuracy", "g_address"]].head(25).to_string(index=False)); sys.exit()

# choose the better source per address: Geocodio when it is rooftop-ish or Census has nothing
census_ok = m.match.eq("Match")
use_g = m.g_type.map(RANK).fillna(-1) >= 4
use_g |= ~census_ok & m.g_type.map(RANK).fillna(-1) >= 2
m["lat"] = m.lat.astype(float).where(~use_g, m.g_lat); m["lon"] = m.lon.astype(float).where(~use_g, m.g_lon)
m["match"] = m.match.where(~use_g, "Match"); m["source"] = pd.Series("census", index=m.index).where(~use_g, "geocodio")
m.loc[~census_ok & ~use_g, "source"] = "none"
print("\nfinal source:"); print(m.source.value_counts().to_string())
m.to_csv("data/geocoded.csv", index=False)
# rebuild van_doors.csv so van_to_houses.py picks it up
df = pd.read_csv(a.van or sorted(glob.glob("data/van/*.xls"), key=os.path.getmtime)[-1], sep="\t", encoding="utf-16", dtype=str)
df["Address"] = df.Address.fillna("").str.strip(); df = df[~df.Address.str.fullmatch(r"(?i)private|")]
df["addr_key"] = df.Address.str.upper() + "|" + df.City.fillna("").str.upper().str.strip() + "|" + df.Zip5.fillna("")
df.merge(m[["addr_key", "match", "matchtype", "lon", "lat", "source", "g_type"]], on="addr_key", how="left").to_csv("data/van_doors.csv", index=False)
print("updated data/geocoded.csv and data/van_doors.csv; now run: python3 van_to_houses.py")
