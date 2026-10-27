// The one Durable Object: holds the statewide graph + doors in memory, runs cuts,
// and owns all reads/writes of batches/turfs in D1 so state stays consistent.
import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { loadBin, loadJson } from "./data";
import { World, DEFAULTS, type Door, type Params, type Turf, type CutResult } from "./cutter";
import type { Env } from "./worker";
import { zipSync, strToU8 } from "fflate";

interface PreviewEntry { result: CutResult; lat: number; lon: number; params: Params; excluded: Set<number>; at: number; }

export class CutterDO extends DurableObject<Env> {
  private world: World | null = null;
  private loading: Promise<World> | null = null;
  private barriers: any = null;
  private previews = new Map<string, PreviewEntry>();
  private assign = new Map<number, number>();      // door id -> turf id (mirror of D1)
  private assignLoaded = false;
  private app = new Hono();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.routes();
  }

  async fetch(req: Request) { return this.app.fetch(req); }

  // ---- data -------------------------------------------------------------
  private async getWorld(): Promise<World> {
    if (this.world) return this.world;
    if (!this.loading) this.loading = (async () => {
      const get = async (k: string) => { const o = await this.env.DATA.get(k); if (!o) throw new Error(`missing R2 object ${k}`); return o.body; };
      const [full, walk, names, doors] = await Promise.all([
        loadBin(await get("full.bin.gz")), loadBin(await get("walk.bin.gz")),
        loadJson<string[]>(await get("names.json.gz")), loadJson<Door[]>(await get("doors.json.gz"))]);
      this.world = new World(full, walk, names, doors);
      return this.world;
    })();
    return this.loading;
  }

  private async getAssign() {
    if (!this.assignLoaded) {
      const rows = await this.env.DB.prepare("SELECT door_id, turf_id FROM door_assign").all<{ door_id: number; turf_id: number }>();
      this.assign = new Map(rows.results.map(r => [r.door_id, r.turf_id]));
      this.assignLoaded = true;
    }
    return this.assign;
  }

  private turfGeometry(w: World, edges: number[]) {
    return { type: "MultiLineString", coordinates: edges.map(e => w.edgeCoords(e)) };
  }
  private bboxOf(coords: number[][][]) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const line of coords) for (const [x, y] of line) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
    return b;
  }
  private turfJson(w: World, t: Turf, id: number | string, batchId: number | string) {
    const geometry = this.turfGeometry(w, t.edges);
    return {
      id, batch_id: batchId, turf_no: t.turfId, cell: t.cell, doors: t.doors, streets_m: Math.round(t.lengthM),
      est_walk_mi: Math.round(t.lengthM * 2 / 1609.34 * 10) / 10, est_min: Math.round(t.minutes),
      doors_per_mi: Math.round(t.doors / Math.max(t.lengthM, 1) * 1609.34), approach_m: Math.round(t.approachM),
      mode: t.approachM > 800 ? "drive" : "walk", door_ids: t.doorIdx.map(i => w.doors[i].id),
      geometry, bbox: this.bboxOf(geometry.coordinates),
    };
  }

  // ---- routes -----------------------------------------------------------
  private routes() {
    const a = this.app;
    a.onError((e, c) => c.json({ error: String(e.message ?? e) }, 500));

    a.get("/api/status", async c => {
      const w = await this.getWorld(); const asg = await this.getAssign();
      return c.json({ nodes: w.walk.n, edges: w.walk.m, cells: w.ncells, doors: w.doors.length, assigned: asg.size, bbox: w.bbox });
    });

    a.get("/api/doors", async c => {
      const w = await this.getWorld(); const asg = await this.getAssign();
      const [minx, miny, maxx, maxy] = (c.req.query("bbox") ?? "").split(",").map(Number);
      const feats: any[] = [];
      for (let i = 0; i < w.doors.length; i++) {
        const d = w.doors[i];
        if (d.lon < minx || d.lon > maxx || d.lat < miny || d.lat > maxy) continue;
        feats.push({ type: "Feature", id: d.id, geometry: { type: "Point", coordinates: [d.lon, d.lat] },
          properties: { id: d.id, b: d.b, addr: d.addr, nv: d.nv, voters: d.voters, turf: asg.get(d.id) ?? null } });
        if (feats.length > 20000) break;
      }
      return c.json({ type: "FeatureCollection", features: feats });
    });

    a.get("/api/barriers", async c => {
      if (!this.barriers) {
        const o = await this.env.DATA.get("barriers.bin.gz"); if (!o) return c.json({ type: "FeatureCollection", features: [] });
        const b = await loadBin(o.body); const off = b.off as Int32Array, xy = b.xy as Float32Array;
        const coords: number[][][] = [];
        for (let i = 0; i + 1 < off.length; i++) { const line: number[][] = []; for (let j = off[i]; j < off[i + 1]; j++) line.push([xy[2 * j], xy[2 * j + 1]]); coords.push(line); }
        this.barriers = { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: coords } }] };
      }
      return c.json(this.barriers, 200, { "Cache-Control": "public, max-age=86400" });
    });

    a.get("/api/turfs", async c => {
      const w = await this.getWorld();
      const bbox = c.req.query("bbox");
      let q = "SELECT t.*, b.label, b.created_at, b.root_lat, b.root_lon, b.params FROM turfs t JOIN batches b ON b.id = t.batch_id";
      const args: any[] = [];
      if (bbox) { const [minx, miny, maxx, maxy] = bbox.split(",").map(Number); q += " WHERE t.maxx >= ? AND t.minx <= ? AND t.maxy >= ? AND t.miny <= ?"; args.push(minx, maxx, miny, maxy); }
      q += " ORDER BY b.id DESC, t.turf_no";
      const rows = (await this.env.DB.prepare(q).bind(...args).all<any>()).results;
      const doorsByTurf = new Map<number, number[]>();
      for (const [d, t] of await this.getAssign()) { if (!doorsByTurf.has(t)) doorsByTurf.set(t, []); doorsByTurf.get(t)!.push(d); }
      const batches = new Map<number, any>();
      for (const r of rows) {
        if (!batches.has(r.batch_id)) batches.set(r.batch_id, { id: r.batch_id, label: r.label, created_at: r.created_at, root: [r.root_lat, r.root_lon], params: JSON.parse(r.params), turfs: [] });
        const edges = JSON.parse(r.edges) as number[];
        const geometry = this.turfGeometry(w, edges);
        batches.get(r.batch_id).turfs.push({ id: r.id, batch_id: r.batch_id, turf_no: r.turf_no, doors: r.doors, streets_m: Math.round(r.length_m),
          est_walk_mi: Math.round(r.length_m * 2 / 1609.34 * 10) / 10, est_min: Math.round(r.minutes), doors_per_mi: Math.round(r.doors / Math.max(r.length_m, 1) * 1609.34),
          approach_m: Math.round(r.approach_m), mode: r.approach_m > 800 ? "drive" : "walk", door_ids: doorsByTurf.get(r.id) ?? [], geometry, bbox: [r.minx, r.miny, r.maxx, r.maxy] });
      }
      return c.json({ batches: [...batches.values()] });
    });

    a.post("/api/preview", async c => {
      const w = await this.getWorld(); const asg = await this.getAssign();
      const body = await c.req.json<any>();
      const params: Params = { ...DEFAULTS, ...(body.params ?? {}) };
      // hidden floor: half the target but never above 10, so sparse areas still offer the turfs nearest the start
      if (body.params?.minDoors == null) params.minDoors = Math.max(5, Math.min(10, Math.round(params.targetDoors / 2)));
      const excluded = new Set(asg.keys());
      const t0 = Date.now();
      let result: CutResult;
      try { result = w.cut(body.lat, body.lon, params, excluded); }
      catch (e: any) { return c.json({ error: e.message }, 422); }
      const id = crypto.randomUUID();
      this.previews.set(id, { result, lat: body.lat, lon: body.lon, params, excluded, at: Date.now() });
      for (const [k, v] of this.previews) if (Date.now() - v.at > 30 * 60 * 1000 || this.previews.size > 50) this.previews.delete(k);
      return c.json({ preview_id: id, ms: Date.now() - t0, turfs: result.turfs.map((t, i) => this.turfJson(w, t, `p${i + 1}`, "preview")),
        orphans: result.orphans.length, skipped_sparse: result.skippedSparse });
    });

    a.post("/api/commit", async c => {
      const w = await this.getWorld(); const asg = await this.getAssign();
      const body = await c.req.json<any>();
      const pv = this.previews.get(body.preview_id);
      if (!pv) return c.json({ error: "preview expired; re-run it" }, 410);
      const now = new Date().toISOString();
      const label = body.label || `${pv.params.k} turfs @ ${pv.lat.toFixed(4)}, ${pv.lon.toFixed(4)}`;
      // conflict check: someone else may have committed doors since this preview ran
      for (const t of pv.result.turfs) for (const i of t.doorIdx) if (asg.has(w.doors[i].id) && !pv.excluded.has(w.doors[i].id))
        return c.json({ error: "some of these doors were committed by another batch since the preview; re-run preview" }, 409);
      const b = await this.env.DB.prepare("INSERT INTO batches (created_at, label, root_lat, root_lon, params) VALUES (?,?,?,?,?) RETURNING id")
        .bind(now, label, pv.lat, pv.lon, JSON.stringify(pv.params)).first<{ id: number }>();
      const stmts: D1PreparedStatement[] = [];
      const ins = this.env.DB.prepare("INSERT INTO turfs (batch_id, turf_no, doors, length_m, minutes, approach_m, edges, minx, miny, maxx, maxy) VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id");
      const turfIds: number[] = [];
      for (const t of pv.result.turfs) {
        const bb = this.bboxOf(this.turfGeometry(w, t.edges).coordinates);
        const r = await ins.bind(b!.id, t.turfId, t.doors, t.lengthM, t.minutes, t.approachM, JSON.stringify(t.edges), bb[0], bb[1], bb[2], bb[3]).first<{ id: number }>();
        turfIds.push(r!.id);
        const asgIns = this.env.DB.prepare("INSERT OR REPLACE INTO door_assign (door_id, turf_id) VALUES (?,?)");
        for (const i of t.doorIdx) { stmts.push(asgIns.bind(w.doors[i].id, r!.id)); asg.set(w.doors[i].id, r!.id); }
      }
      for (let i = 0; i < stmts.length; i += 100) await this.env.DB.batch(stmts.slice(i, i + 100));
      this.previews.delete(body.preview_id);
      return c.json({ batch_id: b!.id, turf_ids: turfIds });
    });

    a.delete("/api/batch/:id", async c => {
      const id = Number(c.req.param("id")); const asg = await this.getAssign();
      const turfs = (await this.env.DB.prepare("SELECT id FROM turfs WHERE batch_id = ?").bind(id).all<{ id: number }>()).results.map(r => r.id);
      for (const t of turfs) for (const [d, tt] of asg) if (tt === t) asg.delete(d);
      await this.env.DB.batch([
        this.env.DB.prepare("DELETE FROM door_assign WHERE turf_id IN (SELECT id FROM turfs WHERE batch_id = ?)").bind(id),
        this.env.DB.prepare("DELETE FROM turfs WHERE batch_id = ?").bind(id),
        this.env.DB.prepare("DELETE FROM batches WHERE id = ?").bind(id)]);
      return c.json({ ok: true, deleted_turfs: turfs.length });
    });

    a.delete("/api/turf/:id", async c => {
      const id = Number(c.req.param("id")); const asg = await this.getAssign();
      for (const [d, tt] of asg) if (tt === id) asg.delete(d);
      const row = await this.env.DB.prepare("SELECT batch_id FROM turfs WHERE id = ?").bind(id).first<{ batch_id: number }>();
      await this.env.DB.batch([
        this.env.DB.prepare("DELETE FROM door_assign WHERE turf_id = ?").bind(id),
        this.env.DB.prepare("DELETE FROM turfs WHERE id = ?").bind(id)]);
      if (row) { const left = await this.env.DB.prepare("SELECT COUNT(*) AS n FROM turfs WHERE batch_id = ?").bind(row.batch_id).first<{ n: number }>();
        if (!left?.n) await this.env.DB.prepare("DELETE FROM batches WHERE id = ?").bind(row.batch_id).run(); }
      return c.json({ ok: true });
    });

    a.get("/api/search", async c => {
      const w = await this.getWorld();
      const q = (c.req.query("q") ?? "").trim().toLowerCase();
      if (q.length < 3) return c.json({ results: [] });
      const local: any[] = [];
      for (const d of w.doors) {
        const a = d.addr.toLowerCase();
        if (a.startsWith(q) || a.includes(q)) { local.push({ label: `${d.addr}, ${d.city ?? ""}`, lat: d.lat, lon: d.lon, kind: "door" }); if (local.length >= 8) break; }
      }
      let remote: any[] = [];
      if (local.length < 5) {
        try {
          const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=us&viewbox=-170,72,-130,54&bounded=1&q=${encodeURIComponent(q)}`,
            { headers: { "User-Agent": "jkt-turf-tool/0.1 (canvass turf cutting)" } });
          if (r.ok) remote = ((await r.json()) as any[]).map(x => ({ label: x.display_name, lat: +x.lat, lon: +x.lon, kind: "place" }));
        } catch {}
      }
      return c.json({ results: [...local, ...remote] });
    });

    a.get("/api/batch/:id/export.csv", async c => {
      const w = await this.getWorld(); const id = Number(c.req.param("id"));
      const rows = (await this.env.DB.prepare("SELECT t.id, t.turf_no, a.door_id FROM turfs t JOIN door_assign a ON a.turf_id = t.id WHERE t.batch_id = ? ORDER BY t.turf_no").bind(id).all<any>()).results;
      const byId = new Map(w.doors.map(d => [d.id, d]));
      const esc = (s: any) => `"${String(s ?? "").replace(/"/g, '""')}"`;
      const lines = ["batch_id,turf_id,turf_no,door_id,address,city,n_voters,voters,van_ids,hd"];
      for (const r of rows) { const d = byId.get(r.door_id)!; lines.push([id, r.id, r.turf_no, d.id, esc(d.addr), esc(d.city), d.nv, esc(d.voters), esc(d.vanids), esc(d.hd)].join(",")); }
      return c.text(lines.join("\n"), 200, { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename=batch_${id}.csv` });
    });

    // One VAN-ID text file per turf, for VAN "Upload List" -> saved list -> Send to MiniVAN.
    a.get("/api/batch/:id/vanids.zip", async c => {
      const w = await this.getWorld(); const id = Number(c.req.param("id"));
      const rows = (await this.env.DB.prepare("SELECT t.turf_no, t.doors, a.door_id FROM turfs t JOIN door_assign a ON a.turf_id = t.id WHERE t.batch_id = ? ORDER BY t.turf_no").bind(id).all<any>()).results;
      const byId = new Map(w.doors.map(d => [d.id, d]));
      const files: Record<string, Uint8Array> = {};
      const per = new Map<number, { doors: number; ids: string[] }>();
      for (const r of rows) {
        if (!per.has(r.turf_no)) per.set(r.turf_no, { doors: r.doors, ids: [] });
        per.get(r.turf_no)!.ids.push(...byId.get(r.door_id)!.vanids.split(";"));
      }
      for (const [no, t] of per) files[`batch${id}_turf${String(no).padStart(2, "0")}_${t.doors}doors.txt`] = strToU8(t.ids.join("\r\n") + "\r\n");
      files["README.txt"] = strToU8("One file per turf, one Voter File VANID per line.\r\nIn VAN: Create a List -> Upload List -> choose a file -> name the saved list -> Send to MiniVAN.\r\n");
      const zip = zipSync(files, { level: 6 });
      return new Response(zip, { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename=batch_${id}_vanids.zip` } });
    });

    a.get("/api/turf/:id/doors", async c => {
      const w = await this.getWorld(); const id = Number(c.req.param("id"));
      const rows = (await this.env.DB.prepare("SELECT door_id FROM door_assign WHERE turf_id = ?").bind(id).all<{ door_id: number }>()).results;
      const byId = new Map(w.doors.map(d => [d.id, d]));
      return c.json({ doors: rows.map(r => byId.get(r.door_id)).filter(Boolean) });
    });
  }
}
