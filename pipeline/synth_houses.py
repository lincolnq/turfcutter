"""Synthesize a canvass universe from OSM building footprints near the root.

Stand-in for the VAN export: one row per door with lat/lon, a fake van_id,
and a unit count for apartment buildings.
"""
import math, numpy as np, pandas as pd
from pyrosm import OSM

import argparse
ap = argparse.ArgumentParser(description="Fake door list from OSM building footprints, for trying the tool without a voter file.")
ap.add_argument("--pbf", default="data/alaska-latest.osm.pbf"); ap.add_argument("--root", required=True, help="same lat,lon as fetch_network.py")
ap.add_argument("--dist", type=float, default=4000); ap.add_argument("--graph", default="data/local.graphml")
ap.add_argument("--out", default="data/houses.csv")
a = ap.parse_args()
ROOT = tuple(map(float, a.root.split(","))); DIST_M = a.dist; PBF = a.pbf
import osmnx as ox
G = ox.load_graphml(a.graph, edge_dtypes={"osmid": str, "oneway": str, "reversed": str})
a.crs = G.graph["crs"]   # same projection as the graph
rng = np.random.default_rng(42)

lat, lon = ROOT
dlat = DIST_M / 111_000
dlon = DIST_M / (111_000 * math.cos(math.radians(lat)))
bbox = [lon - dlon, lat - dlat, lon + dlon, lat + dlat]

osm = OSM(PBF, bounding_box=bbox)
b = osm.get_buildings()
print("buildings:", len(b))
print(b.building.value_counts().head(15))

NONRES = {"commercial", "industrial", "retail", "office", "warehouse", "school",
          "church", "hospital", "garage", "garages", "shed", "roof", "hangar",
          "public", "government", "university", "hotel", "kindergarten", "service",
          "parking", "carport", "greenhouse", "barn", "fire_station", "civic",
          "supermarket", "kiosk", "storage_tank", "transportation", "stadium"}
MULTI = {"apartments", "dormitory", "terrace"}

b = b[~b.building.isin(NONRES)].copy()
# Metres-based area for size filtering.
area = b.to_crs(a.crs).geometry.area
b["area_m2"] = area.values
# Untyped "yes" buildings: keep only house-sized ones (big ones are stores, warehouses).
untyped = b.building.eq("yes")
b = b[~(untyped & ((b.area_m2 > 450) | (b.area_m2 < 40)))].copy()
# Drop any building inside commercial/industrial/retail landuse.
lu = osm.get_landuse()
if lu is not None and len(lu):
    bad = lu[lu.landuse.isin(["commercial", "industrial", "retail"])]
    if len(bad):
        inside = b.sjoin(bad[["geometry"]], how="inner", predicate="within").index.unique()
        b = b.drop(index=inside)

levels = pd.to_numeric(b.get("building:levels"), errors="coerce").fillna(2)
units = np.where(b.building.isin(MULTI),
                 np.clip((b.area_m2 * levels / 85).round(), 2, 60), 1).astype(int)
b["units"] = units

cm = b.to_crs(a.crs).geometry.centroid
c = cm.to_crs(4326)
# street name = nearest named road of any class (what the VAN address would say)
named = [(u, v, k) for u, v, k, d in G.edges(keys=True, data=True) if d.get("name")]
Gn = G.edge_subgraph(named).copy()
ne = ox.nearest_edges(Gn, cm.x.values, cm.y.values)
street = [Gn.edges[e]["name"] for e in ne]
out = pd.DataFrame({
    "street": street,
    "building_id": b["id"].values,
    "building": b.building.values,
    "units": b.units.values,
    "lat": c.y.values, "lon": c.x.values,
})
# Expand to one row per door; multi-unit buildings share a point.
out = out.loc[out.index.repeat(out.units)].reset_index(drop=True)
out["unit_no"] = out.groupby("building_id").cumcount() + 1
out["van_id"] = 100000 + np.arange(len(out))
out["units"] = out.groupby("building_id")["units"].transform("size")
out.to_csv(a.out, index=False)
print("doors:", len(out), "buildings:", out.building_id.nunique())
print(out.building.value_counts())
