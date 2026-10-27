"""Build the OSM street network around a root point from the Geofabrik extract."""
import math, osmnx as ox
from pyrosm import OSM

import argparse
ap = argparse.ArgumentParser(description="Build a road graph from a Geofabrik .osm.pbf extract (https://download.geofabrik.de).")
ap.add_argument("--pbf", default="data/alaska-latest.osm.pbf")
ap.add_argument("--statewide", action="store_true", help="use the whole extract instead of a box around --root")
ap.add_argument("--root", default=None, help="lat,lon to centre a box on, e.g. 38.9072,-77.0369 (copy from Google Maps). Required unless --statewide")
ap.add_argument("--dist", type=float, default=4000, help="half-width of the box in metres (default 4000)")
ap.add_argument("--crs", default=None, help="projected CRS in metres; default: the UTM zone of --root (or of the extract's centre)")
ap.add_argument("--out", default=None)
args = ap.parse_args()
if not args.statewide and not args.root:
    ap.error("pass --root lat,lon (a point inside the extract) or --statewide")
ROOT = tuple(map(float, args.root.split(","))) if args.root else None
DIST_M = args.dist
PBF = args.pbf
STATEWIDE = args.statewide
OUT = args.out or ("data/statewide.graphml" if STATEWIDE else "data/local.graphml")

def utm_for(lat, lon):
    zone = int((lon + 180) // 6) + 1
    return f"EPSG:{(32600 if lat >= 0 else 32700) + zone}"

if STATEWIDE:
    osm = OSM(PBF)
else:
    lat, lon = ROOT
    dlat = DIST_M / 111_000
    dlon = DIST_M / (111_000 * math.cos(math.radians(lat)))
    osm = OSM(PBF, bounding_box=[lon - dlon, lat - dlat, lon + dlon, lat + dlat])
nodes, edges = osm.get_network(network_type="all", nodes=True)
if edges is None or len(edges) == 0:
    raise SystemExit(f"No roads found. Is --root inside the extract {PBF}? (for statewide use --statewide)")
print("raw:", len(nodes), "nodes", len(edges), "edges")
if not args.crs:
    clat, clon = ROOT if ROOT else (float(nodes.lat.mean()), float(nodes.lon.mean()))
    args.crs = utm_for(clat, clon)
    print("projection:", args.crs, "(UTM zone chosen automatically; pass --crs to override)")

keep = ["id", "u", "v", "highway", "name", "oneway", "length", "geometry", "footway", "bridge", "tunnel"]
edges = edges[keep].copy()
for c in ("highway", "name", "footway", "bridge", "tunnel"):
    edges[c] = edges[c].astype(object).where(edges[c].notna(), None).map(
        lambda x: ";".join(x) if isinstance(x, list) else x)
nodes = nodes[["id", "lon", "lat", "geometry"]].copy()

G = osm.to_graph(nodes, edges, graph_type="networkx", retain_all=True, osmnx_compatible=True)
G.graph.pop("simplified", None)
for _, _, _, d in G.edges(keys=True, data=True):
    for a, b in list(d.items()):
        if isinstance(b, list):
            d[a] = ";".join(str(x) for x in b)
    d.pop("oneway_tag", None)
G = ox.simplify_graph(G, edge_attrs_differ=["highway", "name"])
for _, _, _, d in G.edges(keys=True, data=True):   # simplify can still produce lists
    for a, b in list(d.items()):
        if isinstance(b, list):
            d[a] = ";".join(str(x) for x in b)
# any projected CRS in metres works; a whole large state may want an Albers/State Plane CRS (Alaska: EPSG:3338)
G = ox.project_graph(G, to_crs=args.crs)
print(G.graph["crs"], len(G.nodes), "nodes", len(G.edges), "edges")
ox.save_graphml(G, OUT)
