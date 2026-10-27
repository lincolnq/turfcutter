"""Geocode the VAN export's distinct addresses with the Census batch geocoder.
Sends only: row id, street, city, state, zip. No names, no VAN IDs.
    python3 geocode.py            # all batches
    python3 geocode.py --test     # first 100 addresses only
Writes data/geocoded.csv (one row per distinct address) and data/van_doors.csv.
"""
import argparse, io, os, re, time, requests, pandas as pd

import glob
ap = argparse.ArgumentParser(); ap.add_argument("--test", action="store_true")
ap.add_argument("--van", default=None, help="VAN export (UTF-16 tab-separated .xls); default: newest data/van/*.xls")
a = ap.parse_args()
VAN = a.van or sorted(glob.glob("data/van/*.xls"), key=os.path.getmtime)[-1]
URL = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"

df = pd.read_csv(VAN, sep="\t", encoding="utf-16", dtype=str)
df["Address"] = df.Address.fillna("").str.strip()
df = df[~df.Address.str.fullmatch(r"(?i)private|")]            # PO-box-only voters
df["addr_key"] = (df.Address.str.upper() + "|" + df.City.fillna("").str.upper().str.strip() + "|" + df.Zip5.fillna(""))
addrs = df.drop_duplicates("addr_key")[["addr_key", "Address", "City", "State", "Zip5"]].reset_index(drop=True)
addrs["id"] = addrs.index + 1
print(f"{len(df)} voters, {len(addrs)} distinct addresses to geocode")
if a.test:
    addrs = addrs.head(100)

os.makedirs("data/geo", exist_ok=True)
frames = []
for i in range(0, len(addrs), 10000):
    chunk = addrs.iloc[i:i + 10000]
    out = f"data/geo/batch_{i // 10000:02d}.csv"
    if os.path.exists(out) and not a.test:
        c = pd.read_csv(out, dtype=str); c["id"] = c.id.astype(int); frames.append(c); print("cached", out); continue
    buf = io.StringIO()
    chunk[["id", "Address", "City", "State", "Zip5"]].to_csv(buf, index=False, header=False)
    for attempt in range(4):
        r = requests.post(URL, files={"addressFile": ("addrs.csv", buf.getvalue(), "text/csv")},
                          data={"benchmark": "Public_AR_Current"}, timeout=900)
        if r.ok: break
        print("retry", attempt, r.status_code); time.sleep(30 * (attempt + 1))
    r.raise_for_status()
    cols = ["id", "input", "match", "matchtype", "matched_address", "lonlat", "tiger_line", "side"]
    res = pd.read_csv(io.StringIO(r.text), header=None, names=cols, dtype=str); res["id"] = res.id.astype(int)
    if not a.test: res.to_csv(out, index=False)
    frames.append(res); print(f"batch {i // 10000}: {len(res)} rows, {(res.match == 'Match').sum()} matched")

res = pd.concat(frames)
res[["lon", "lat"]] = res.lonlat.str.split(",", expand=True).astype(float) if res.lonlat.notna().any() else (None, None)
print("\nmatch summary:"); print(res.match.value_counts().to_string()); print(res.matchtype.value_counts().to_string())
g = addrs.merge(res[["id", "match", "matchtype", "matched_address", "lon", "lat"]], on="id", how="left")
if not a.test:
    g.to_csv("data/geocoded.csv", index=False)
    doors = df.merge(g[["addr_key", "match", "matchtype", "lon", "lat"]], on="addr_key", how="left")
    doors.to_csv("data/van_doors.csv", index=False)
    print("wrote data/geocoded.csv and data/van_doors.csv")
else:
    print(g[["Address", "City", "match", "matchtype", "matched_address", "lon", "lat"]].head(20).to_string(index=False))
