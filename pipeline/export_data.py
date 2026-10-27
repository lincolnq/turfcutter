"""Export the walkable graph, the full road graph, cells, and snapped doors as
compact gzipped JSON for the TypeScript cutter (uploaded to R2).

    python3 export_data.py --graph data/alaska.graphml --houses data/houses_van.csv --out data/export
"""
import argparse, gzip, json, os, numpy as np, pandas as pd, pyproj
from shapely.ops import transform
from roadgraph import RoadGraph

ap = argparse.ArgumentParser()
ap.add_argument("--graph", default="data/statewide.graphml"); ap.add_argument("--houses", default="data/houses_van.csv")
ap.add_argument("--out", default="data/export"); a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
c = RoadGraph(a.graph, a.houses)
to_wgs = pyproj.Transformer.from_crs(c.crs, 4326, always_xy=True)

def write_bin(path, arrays):
    """Binary container: u32 header length, JSON header [{name, dtype, len}], then raw arrays (8-byte aligned)."""
    import struct
    hdr, blobs, off = [], [], 0
    for name, arr in arrays.items():
        arr = np.ascontiguousarray(arr)
        pad = (-off) % 8
        blobs.append(b"\0" * pad); off += pad
        hdr.append({"name": name, "dtype": arr.dtype.name, "len": int(arr.size), "off": off})
        b = arr.tobytes(); blobs.append(b); off += len(b)
    h = json.dumps(hdr).encode()
    with gzip.open(path, "wb") as f:
        f.write(struct.pack("<I", len(h))); f.write(h); f.write(b"".join(blobs))
    print(f"{path}: {os.path.getsize(path) / 1e6:.1f} MB")

# --- full graph (approach distances): undirected, one edge per pair with min length
full_nodes = list(c.Gfull.nodes)
fidx = {n: i for i, n in enumerate(full_nodes)}
fe = {}
for u, v, k, d in c.Gfull.edges(keys=True, data=True):
    if d["cls"] == "skip" or u == v:
        continue
    key = (min(fidx[u], fidx[v]), max(fidx[u], fidx[v]))
    fe[key] = min(fe.get(key, 1e18), float(d["length"]))
ffx = np.array([c.Gfull.nodes[n]["x"] for n in full_nodes]); ffy = np.array([c.Gfull.nodes[n]["y"] for n in full_nodes])
flon, flat = to_wgs.transform(ffx, ffy)
write_bin(f"{a.out}/full.bin.gz", {
    "x": ffx.astype(np.float32), "y": ffy.astype(np.float32),
    "lon": np.array(flon, np.float64), "lat": np.array(flat, np.float64),
    "eu": np.array([k[0] for k in fe], np.int32), "ev": np.array([k[1] for k in fe], np.int32),
    "elen": np.array(list(fe.values()), np.float32)})

# --- walkable graph: split nodes map back to a full node for approach lookup
w_nodes = list(c.W.nodes)
widx = {n: i for i, n in enumerate(w_nodes)}
names, name_idx = [], {}
def nid(s):
    s = "" if s is None else str(s)
    if s not in name_idx: name_idx[s] = len(names); names.append(s)
    return name_idx[s]
eu, ev, elen, ename, ehw, goff, gxy = [], [], [], [], [], [0], []
eidx = {}
for u, v, k, d in c.W.edges(keys=True, data=True):
    eidx[c._ekey((u, v, k))] = len(eu)
    eu.append(widx[u]); ev.append(widx[v]); elen.append(float(d["length"]))
    ename.append(nid(d.get("name"))); ehw.append(nid(d.get("highway")))
    g = transform(to_wgs.transform, d["geometry"])
    for x, y in g.coords: gxy += [x, y]
    goff.append(len(gxy) // 2)
wx = np.array([c.W.nodes[n]["x"] for n in w_nodes]); wy = np.array([c.W.nodes[n]["y"] for n in w_nodes])
lon, lat = to_wgs.transform(wx, wy)
write_bin(f"{a.out}/walk.bin.gz", {
    "x": wx.astype(np.float32), "y": wy.astype(np.float32), "lon": np.array(lon, np.float64), "lat": np.array(lat, np.float64),
    "orig": np.array([fidx[n[1] if isinstance(n, tuple) else n] for n in w_nodes], np.int32),
    "cell": np.array([c.cell_of[n] for n in w_nodes], np.int32),
    "eu": np.array(eu, np.int32), "ev": np.array(ev, np.int32), "elen": np.array(elen, np.float32),
    "ename": np.array(ename, np.int32), "ehw": np.array(ehw, np.int32),
    "goff": np.array(goff, np.int32), "gxy": np.array(gxy, np.float32)})
with gzip.open(f"{a.out}/names.json.gz", "wt") as f:
    json.dump(names, f, separators=(",", ":"))

# --- doors, with the walkable edge index they snapped to
h = c.houses
def col(r, name, default=None):
    v = getattr(r, name, default)
    return default if v is None or (isinstance(v, float) and pd.isna(v)) else v
doors = []
for r in h.itertuples():   # works for the VAN-derived list and for synth_houses.py output
    doors.append({"id": int(r.van_id), "b": int(r.building_id), "lat": round(float(r.lat), 6), "lon": round(float(r.lon), 6),
                  "e": eidx[c._ekey(r.edge)], "addr": str(col(r, "address", f"building {r.building_id}")), "unit": col(r, "unit"),
                  "street": col(r, "street"), "city": col(r, "city"),
                  "nv": int(col(r, "n_voters", 1)), "voters": str(col(r, "voters", "")), "vanids": str(col(r, "van_ids", r.van_id)), "hd": col(r, "hd")})
with gzip.open(f"{a.out}/doors.json.gz", "wt") as f:
    json.dump(doors, f, separators=(",", ":"))

# barrier roads for drawing (not crossings)
boff, bxy = [0], []
for u, v, k, d in c.Gfull.edges(keys=True, data=True):
    if d["cls"] == "barrier" and d.get("geometry") is not None and str(d.get("highway")) not in ("footway", "path", "cycleway"):
        g = transform(to_wgs.transform, d["geometry"])
        for x, y in g.coords: bxy += [x, y]
        boff.append(len(bxy) // 2)
write_bin(f"{a.out}/barriers.bin.gz", {"off": np.array(boff, np.int32), "xy": np.array(bxy, np.float32)})
print(f"full: {len(full_nodes)} nodes {len(fe)} edges; walk: {len(w_nodes)} nodes {len(eu)} edges, {c.ncells} cells; doors: {len(doors)}; names: {len(names)}")
