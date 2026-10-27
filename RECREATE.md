# How to recreate this with an AI assistant

Written by the assistant that built it. This is not the exact prompt log (see
PROMPTS.md for that); it is what I would tell someone who wants to get to the
same place in one working day, including the things that mattered and the
things that cost time.

## What you need before you start

- A clear one-paragraph statement of the job. The opening prompt here did
  almost all the work: *request-driven cutting from a point for N volunteers,
  never cross big roads, dead-ends stay with their street, manageable walking,
  tunable density floor that errors by default.* Every later decision was
  checked against that paragraph.
- A real place to point at. A specific start address in a town you know lets
  you judge the output by eye, which is the only judgment that matters.
- Your voter file, or patience until it arrives. The first half of the day
  ran on fake doors synthesized from OpenStreetMap building footprints, and
  that was enough to get the algorithm most of the way.
- A phone, if you want the canvasser side. You will be the tester.

## The arc, in phases

### 1. Design before code

Ask for the design first and read it. The useful answer is short: cut on the
road graph, not on polygons; big roads become barriers that split the map into
cells; a turf lives in one cell; grow turfs along a shortest-path tree so
contiguity and dead-ends are automatic. If the assistant proposes drawing
polygons, push back.

Ask it to list the constraints you have not thought of. Density floors for a
targeted universe, apartment buildings, drive-to-start versus walk-from-here,
re-walks, and data quality all came out of that question and all turned out to
matter.

### 2. A throwaway prototype on fake data

Ask for synthetic doors from OSM building footprints around your start point
and a command-line cutter that writes a map. Then look at the map and
complain about specific turfs by number: *turf 1 should just be the dense
neighborhood on the left; turf 6 has an empty spur north; turf 4 has dots
mixed into turf 5.* Each complaint should produce one rule change and a
rerun. Do not accept a fix without a before/after map.

The rules that survived, in the order they were needed:

- Ignore branches with no doors at all.
- Prefer a street whose name matches the address when snapping doors.
- Cut a turf as soon as it is good enough rather than growing it to the limit.
- Measure thinness in doors per mile of street, not per minute, because
  per-door time swamps the walking and hides sprawl.
- Only prune thin branches from a turf that is already full; a turf with
  budget keeps its side streets rather than stranding doors.
- After cutting, attach stranded fragments to the nearest turf over the real
  street graph, because the tree does not see adjacency across its branches.
- Merge adjacent under-target turfs in the same cell.

### 3. Maps and tiles

Expect a detour. Free raster tile servers either need keys now or refuse
requests from a local HTML file. Ask up front: *what free vector tile source
works at scale without a key?* The answer is OpenFreeMap with MapLibre, and
getting there directly saves an hour. Tell the assistant to ask you for keys
rather than hunting for keyless options.

When the assistant cannot see a browser page, say *just ask me to test it*
and report what you see. A headless-browser debugging loop is slow and the
assistant's screenshot tooling is worse than your eyes. For actual bugs, a
small script that evaluates JavaScript inside the page through Chrome's
debugging protocol was the thing that found the real causes.

### 4. Real data

A VAN export is a UTF-16 tab-separated file named .xls with no coordinates.
You will geocode. The free Census batch geocoder places points on the street
by interpolation; a paid rooftop geocoder (Geocodio, roughly $0.50 per
thousand) puts them on houses and rescues some misses. Both are fine for
cutting; rooftop matters for the canvasser's map. Decide how much you care.

Insist that only street, city, state, and zip leave your machine, never names
or IDs. Run a 100-address test before the full file. Run batches
concurrently. Cache each batch to disk so an interruption never re-sends
anything you have paid for.

Then re-examine the output against VAN's own map for the same area. Differences
in dot placement are geocoder disagreement, typically 40 meters; differences
in which dots exist are usually VAN's geocoder having missed addresses. Overlay
them if you have an image editor; it settles the question in a minute.

### 5. Productionize

Describe the app in one prompt: search or click to set a start, doors in
view, turfs in or near the viewport, a cut button with live-preview sliders,
commit to a shared list grouped by batch, delete batch or turf. Ask for the
architecture plan before any code and read it.

If you want serverless, say so before the port. The useful fact: the whole
statewide road graph is 20 MB as typed arrays, so one Durable Object holds it
and cuts run in 100 to 300 ms. The port from Python to TypeScript took a few
hours because the graph libraries were only used for Dijkstra and connected
components, which are short to write. Demand a parity test: same roots, same
parameters, identical door sets per turf. It passed on 90 of 90 turfs, which
is how you know the port is the same algorithm.

### 6. Tuning controls that humans understand

Every control is a chance to confuse. Ask for human terms and a one-line
explanation under each. The ones that ended up mattering: number of turfs,
doors per turf, a shift-length cap, a distance cap, and an Advanced section
with per-knock time, answer rate, conversation length, walking pace,
drive-to-start, and the longest empty street a turf may walk through.

Two rules worth stating explicitly to the assistant, because the first
versions violated both:

- *A slider should change what it names and nothing else.* The door floor
  originally fed the cutting rules, so lowering it reshaped existing turfs.
  Separating the internal threshold from the user's filter fixed it.
- *Lowering a floor should only reveal smaller turfs near the start.* Say
  that sentence and the assistant can verify it directly.

Also remove controls that do nothing. One slider turned out to be inert after
a later change; ask *does this setting make any difference under my current
settings?* and expect an honest answer.

### 7. Getting turfs into VAN

Find out early what your VAN account can do: upload a list, create activist
codes, create tags, apply tags in bulk, API access. Each closed door removes
an integration path, and in this case all of them were closed except
applying canvass results in bulk, which is the one that matters for a
custom canvasser page. Ask the assistant for the options ranked by effort
rather than for a single answer.

### 8. Make it shareable

Ask for a repo with code only, a demo path that works with no voter file,
and the fewest moving parts. Then ask *did we get rid of the old code that
was superseded?* and *is anything here fiddly or confusing?* and delete
accordingly. Preprocessing in one folder, app in another, one README. The
first attempt kept a superseded Python cutter as "reference"; it was
misleading within an hour of the TypeScript cutter diverging, and it went.

## Habits that made the difference

- Ask *why* before *fix*. "Why does it make this 5-mile turf?" got the right
  answer (the sliders) where "make it shorter" would have changed the code.
- Make it reproduce the problem against the API with your exact parameters
  before touching anything. Twice the bug was in the page, not the cutter,
  and once it was a slider whose label had drifted from its position.
- Give it the screenshot and the turf number. Vague complaints produce vague
  fixes.
- When it is about to spend money or send data externally, make it ask.
  When it is about to change a server you are using, make it wait.
- Keep deliverables small and verifiable: a table of numbers before and after,
  a map you can look at, a parity count.
