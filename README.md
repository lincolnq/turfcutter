# turf — request-driven canvass turf cutting

Give it a start point and a number of volunteers; get back that many contiguous
walking turfs that never cross a big road, keep dead-ends with their street,
fit a shift, and skip streets with no target doors. Built for a targeted voter
universe in Alaska, but nothing in the code is Alaska-specific.

Two parts:

- **`app/`** — the thing you run: a TypeScript cutter inside a Cloudflare Durable
  Object, D1 for committed turfs, a MapLibre page for cutting and committing.
  Runs locally under `wrangler dev` with no Cloudflare account.
- **`pipeline/`** — Python preprocessing that turns an OpenStreetMap extract
  and a voter file into the compact data the app loads. Run once per data refresh.

## How cutting works

1. **Roads are classified.** Motorway/trunk/primary/secondary/tertiary (and
   tagged crosswalks) are *barriers*; everything else is walkable.
2. **Barriers split the map into cells.** Intersections on a barrier are split
   so streets on opposite sides never connect through them. A turf lives in one cell.
3. **Doors snap to a walkable street**, preferring one whose name matches the
   address street.
4. **Cells are ranked by road distance from the start.** Inside a cell, a
   shortest-path tree from the cell's entry is cut bottom-up into subtrees:
   every edge belongs to its farther endpoint, so a subtree is always a connected
   set of streets. A subtree becomes a turf when it reaches the door target or
   the shift/distance cap. Branches that are sparse, behind a long empty street,
   or would blow a budget stand alone or are set aside.
5. **Cleanup passes:** stranded fragments attach to the nearest turf over the
   real street graph; adjacent under-target turfs in a cell merge; candidates
   under the (hidden) door floor fold into a neighbour with room; door-less
   tails are trimmed so a turf starts where the doors start.
6. The *k* nearest turfs that clear the floor are returned. Already-committed
   doors are invisible to new cuts.

Estimated minutes per turf = doors × (per-knock + answer-rate × conversation)
+ 2 × street length ÷ walking pace. Walking distance is always 2 × street length.

The cutter is `app/src/cutter.ts`; the road classification, barrier splitting
and door snapping it relies on happen once in `pipeline/roadgraph.py`.

## Quick start (demo, no voter file)

Needs Python 3.11+, Node 20+, and a Geofabrik extract for your state from
<https://download.geofabrik.de>: pick the `<state>-latest.osm.pbf` file (not
the shapefile or GeoPackage versions, which drop tags the cutter uses). The
Alaska one is ~140 MB. Put it in `data/`.

```bash
pip install -r requirements.txt
cd app && npm install && cd ..

# 1. road graph: a 4 km box around a point. --root is any lat,lon inside the extract
#    (right-click a spot in Google Maps and copy the numbers). --statewide instead takes the whole file.
python3 pipeline/fetch_network.py --pbf data/alaska-latest.osm.pbf --root 61.216,-149.894
# 2. fake doors from OSM building footprints in that box (same --root)
python3 pipeline/synth_houses.py --pbf data/alaska-latest.osm.pbf --root 61.216,-149.894
# 3. export for the app
python3 pipeline/export_data.py --graph data/local.graphml --houses data/houses.csv
# 4. load into wrangler's local emulator and run
cd app && ./scripts/load-local-data.sh && npm run dev     # http://localhost:8787
```

The projection is picked automatically (the UTM zone of the point). For a
whole large state you may prefer its Albers or State Plane CRS via `--crs`,
e.g. `--crs EPSG:3338` for Alaska; everything downstream reads it from the graph.

## With a real voter file

The pipeline expects a VAN canvass list export: a UTF-16, tab-separated text
file (VAN names it `.xls`) with at least `Voter File VANID`, `FirstName`,
`LastName`, `Address`, `City`, `State`, `Zip5`, `HD`. Drop it in `data/van/`.

```bash
python3 pipeline/fetch_network.py --pbf data/<state>-latest.osm.pbf --statewide
python3 pipeline/geocode.py             # Census batch geocoder, free, no key; ~5 min per 50k
python3 pipeline/geocode_geocodio.py    # optional rooftop upgrade; needs GEOCODIO_API_KEY in .env (~$0.50/1k)
python3 pipeline/van_to_houses.py       # parse units/streets, one row per door -> data/houses_van.csv
python3 pipeline/export_data.py         # -> data/export/*.gz
cd app && ./scripts/load-local-data.sh && npm run dev
```

Geocoding sends street, city, state, zip and a row number to the geocoder —
no names, no VAN IDs. Census results are street-range interpolation (dots on
the street); Geocodio gives rooftop placement for most addresses.

Other voter-file formats: produce a CSV with the columns `van_id` (door id),
`building_id`, `unit_no`, `units`, `lat`, `lon`, `street`, `address`, `city`,
`n_voters`, `voters`, `van_ids`, `hd` and point `pipeline/export_data.py --houses` at it.

## The app

- Search or click to set a start; **Cut new turfs** opens the sliders and
  previews live (cuts take ~100–300 ms statewide).
- **Commit** saves the batch for everyone. Batches and turfs can be deleted.
- Committed doors are excluded from later cuts. Gray dots are target doors not
  in any turf in view.
- Per batch: `csv` (every door with voters and VAN IDs) and `VAN lists` (a zip
  with one VAN-ID file per turf, for VAN's list upload).

API lives in `app/src/do.ts`: `/api/doors`, `/api/turfs`, `/api/preview`,
`/api/commit`, `/api/batch/:id`, `/api/turf/:id`, `/api/search`,
`/api/batch/:id/export.csv`, `/api/batch/:id/vanids.zip`.

### Deploying to Cloudflare

```bash
cd app
npx wrangler login
npx wrangler r2 bucket create turf-data
npx wrangler d1 create turf            # paste the database_id into wrangler.toml
./scripts/load-remote-data.sh
npm run deploy
```

Then put Cloudflare Access in front of it — there is no login in the app.
The whole statewide dataset (~20 MB gzipped) lives in one Durable Object's
memory; cold start is a couple of seconds.

## Known limits

- Apartment buildings count every unit as a door at one point; stairs and
  hallways are not in the time estimate, and a building can't be split.
- Pedestrian bridges/tunnels over highways are only honoured if untagged as crossings.
- The "set aside" count and gray dots are the honest leftovers of a targeted
  universe; a drive-canvass mode for sparse areas does not exist yet.
- No auth, no per-user attribution, no results sync, no canvasser-facing page.
  VAN import is manual (one list per turf) unless your committee has API
  access or activist codes.
