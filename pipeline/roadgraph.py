"""Road graph preprocessing for the turf cutter (the cutting itself is app/src/cutter.ts).

  1. Load the OSM graph, classify every edge as walkable or barrier.
  2. Build the walkable graph. Barrier roads are removed and any node that sits
     on a barrier is split so walkable streets on opposite sides never connect.
  3. Each connected component of the walkable graph is a "cell".
  4. Snap doors to a walkable edge, preferring one whose name matches the address street.
"""
from __future__ import annotations
import math
import re, networkx as nx, pandas as pd, osmnx as ox, geopandas as gpd
from shapely.geometry import LineString

BARRIER = {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
           "secondary", "secondary_link", "tertiary", "tertiary_link"}
NOT_WALK = {"steps", "elevator", "corridor", "raceway", "bus_guideway", "track"}


_ABBR = {"n": "north", "s": "south", "e": "east", "w": "west", "ave": "avenue", "av": "avenue",
         "blvd": "boulevard", "st": "street", "dr": "drive", "cir": "circle", "rd": "road",
         "ln": "lane", "ct": "court", "pl": "place", "hwy": "highway", "pkwy": "parkway",
         "ter": "terrace", "trl": "trail", "lp": "loop", "way": "way"}


def norm_street(name):
    """Normalize a street name for matching: lowercase, abbreviations expanded, punctuation dropped."""
    if name is None or (isinstance(name, float) and math.isnan(name)):
        return None
    name = str(name).split(";")[0].lower()
    toks = [t for t in re.split(r"[^a-z0-9]+", name) if t]
    return " ".join(_ABBR.get(t, t) for t in toks) or None


def road_class(hw) -> str:
    """Classify a highway tag. Merged edges may carry several values; any barrier
    component makes the edge a barrier, and it is walkable only if some component is."""
    if hw is None:
        return "walk"
    parts = [t.strip(" '[]\"") for t in re.split(r"[;,]", str(hw)) if t.strip(" '[]\"")]
    if any(t in BARRIER for t in parts):
        return "barrier"
    if parts and all(t in NOT_WALK for t in parts):
        return "skip"
    return "walk"


class RoadGraph:
    def __init__(self, graphml: str, houses_csv: str):
        import pickle, os
        pkl = graphml + ".pkl"
        if os.path.exists(pkl) and os.path.getmtime(pkl) >= os.path.getmtime(graphml):
            G = pickle.load(open(pkl, "rb"))
        else:
            G = ox.load_graphml(graphml, edge_dtypes={"osmid": str, "oneway": str, "reversed": str})
            pickle.dump(G, open(pkl, "wb"), protocol=pickle.HIGHEST_PROTOCOL)
        self.crs = G.graph["crs"]
        self.Gfull = ox.convert.to_undirected(G)
        self._classify()
        self._build_walkable()
        self._load_houses(houses_csv)

    # -- step 1/2 ------------------------------------------------------------
    def _classify(self):
        for u, v, k, d in self.Gfull.edges(keys=True, data=True):
            d["cls"] = road_class(d.get("highway"))
            if d["cls"] == "walk" and str(d.get("footway")) == "crossing":
                d["cls"] = "barrier"  # crosswalk across a big road is still a crossing

    def _build_walkable(self):
        Gf = self.Gfull
        barrier_nodes = {n for u, v, k, d in Gf.edges(keys=True, data=True)
                         if d["cls"] == "barrier" for n in (u, v)}
        W = nx.MultiGraph()
        W.graph["crs"] = self.crs
        self.split_of = {}  # (orig_node, edge key) -> split node id
        for u, v, k, d in Gf.edges(keys=True, data=True):
            if d["cls"] != "walk":
                continue
            uu = self._split(u, (u, v, k), barrier_nodes)
            vv = self._split(v, (u, v, k), barrier_nodes)
            W.add_node(uu, **Gf.nodes[u]); W.add_node(vv, **Gf.nodes[v])
            geom = d.get("geometry") or LineString([(Gf.nodes[u]["x"], Gf.nodes[u]["y"]),
                                                   (Gf.nodes[v]["x"], Gf.nodes[v]["y"])])
            W.add_edge(uu, vv, key=k, length=float(d["length"]), geometry=geom,
                       highway=d.get("highway"), name=d.get("name"), orig=(u, v, k))
        self.W = W
        # cells = connected components with at least one edge
        self.cell_of, self.cell_nodes = {}, {}
        for i, comp in enumerate(nx.connected_components(W)):
            self.cell_nodes[i] = list(comp)
            for n in comp:
                self.cell_of[n] = i
        self.ncells = len(self.cell_nodes)
        # doors per cell, so empty cells (parking lots, trails) are skipped cheaply
        self.cell_doors = {}

    def _split(self, n, ek, barrier_nodes):
        """A node on a barrier road gets a separate copy per walkable edge."""
        if n not in barrier_nodes:
            return n
        return self.split_of.setdefault((n, ek), ("s", n, ek))

    # -- step 3 ------------------------------------------------------------
    def _load_houses(self, csv):
        h = pd.read_csv(csv)
        pts = gpd.GeoSeries.from_xy(h.lon, h.lat, crs=4326).to_crs(self.crs)
        h["x"], h["y"] = pts.x.values, pts.y.values
        # Snap buildings (not every door) to a walkable edge. Prefer an edge whose
        # name matches the address street; otherwise the nearest edge.
        bld = h.drop_duplicates("building_id")
        edges = gpd.GeoDataFrame(
            [{"e": (u, v, k), "name": norm_street(d.get("name")), "geometry": d["geometry"]}
             for u, v, k, d in self.W.edges(keys=True, data=True)], crs=self.crs)
        sidx = edges.sindex
        pts = gpd.GeoSeries.from_xy(bld.x, bld.y, crs=self.crs)
        streets = bld["street"].map(norm_street) if "street" in bld else pd.Series([None] * len(bld), index=bld.index)
        snap_e, snap_d, snap_named = [], [], []
        for pt, st in zip(pts, streets):
            cand = edges.iloc[sidx.query(pt.buffer(150))]
            if len(cand) == 0:
                snap_e.append(None); snap_d.append(math.inf); snap_named.append(False); continue
            dd = cand.geometry.distance(pt)
            i0 = dd.idxmin()
            pick, named = i0, False
            if st:
                m = dd[cand["name"] == st]
                if len(m) and m.min() <= max(2 * dd[i0], 40):
                    pick, named = m.idxmin(), True
            snap_e.append(edges.at[pick, "e"]); snap_d.append(dd[pick]); snap_named.append(named)
        snap = pd.DataFrame({"building_id": bld.building_id.values, "edge": snap_e,
                             "snap_m": snap_d, "snap_named": snap_named})
        h = h.merge(snap, on="building_id")
        self.unsnapped = h[h.snap_m > 120]
        h = h[h.snap_m <= 120].copy()
        self.houses = h
        self.doors_on_edge: dict[tuple, list] = {}
        for e, vid in zip(h.edge, h.van_id):
            self.doors_on_edge.setdefault(self._ekey(e), []).append(vid)
        self.doorcount = {e: len(v) for e, v in self.doors_on_edge.items()}
        for e, n in self.doorcount.items():
            c = self.cell_of[e[0]]
            self.cell_doors[c] = self.cell_doors.get(c, 0) + n

    @staticmethod
    def _ekey(e):
        u, v, k = e
        return (min(u, v, key=repr), max(u, v, key=repr), k)
