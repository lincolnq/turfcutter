// Road-graph turf cutter: TypeScript port of turfcut.py (same rules, same order of operations).
import { Graph } from "./graph";

export interface Door {
  id: number; b: number; lat: number; lon: number; e: number;
  addr: string; unit: string | null; street: string | null; city: string | null;
  nv: number; voters: string; vanids: string; hd: string | null;
}

export interface Params {
  k: number; shiftMin: number; targetDoors: number; minDoors: number; minPerDoor: number; walkMPerMin: number; backtrack: number;
  driveOk: boolean; walkToStartM: number; allowSparse: boolean; fill: number; maxConnectorM: number; dilution: number;
  maxWalkM: number;   // cap on walking distance per turf (= backtrack x street length)
}
export const DEFAULTS: Params = {
  k: 5, shiftMin: 120, targetDoors: 30, minDoors: 15, minPerDoor: 2, walkMPerMin: 70, backtrack: 2,
  driveOk: true, walkToStartM: 800, allowSparse: false, fill: 1.0, maxConnectorM: 150, dilution: 0.7,
  maxWalkM: 8 * 1609.34,
};

export interface Turf {
  turfId: number; cell: number;
  edges: number[];        // walk-graph edge ids
  nodes: number[];        // tree nodes (local-to-cell indices) used for merges
  doorIdx: number[];      // indices into world.doors
  doors: number; lengthM: number; minutes: number; approachM: number;
}

export interface CutResult { turfs: Turf[]; orphans: number[]; skippedSparse: { doors: number; walkKm: number }[]; }

/** Internal floor for the cutting rules. Fixed on purpose: `minDoors` is only a filter on
 *  finished candidates, so lowering it reveals small turfs without reshaping the others. */
const STANDALONE_DOORS = 10;

export class World {
  full: Graph; fullLon: Float64Array; fullLat: Float64Array;
  walk: Graph; wLon: Float64Array; wLat: Float64Array; orig: Int32Array; cell: Int32Array; ncells: number;
  ename: Int32Array; ehw: Int32Array; names: string[]; goff: Int32Array; gxy: Float32Array;
  doors: Door[];
  cellNodes: number[][]; cellEdges: number[][];
  edgeDoorOff: Int32Array; edgeDoorList: Int32Array;   // CSR: door indices per edge
  bbox: [number, number, number, number];               // extent of the doors: minLon, minLat, maxLon, maxLat
  private loc: Int32Array;

  constructor(full: Record<string, any>, walk: Record<string, any>, names: string[], doors: Door[]) {
    this.full = new Graph(full.x.length, full.eu, full.ev, full.elen);
    this.fullLon = full.lon; this.fullLat = full.lat;
    this.walk = new Graph(walk.x.length, walk.eu, walk.ev, walk.elen);
    this.wLon = walk.lon; this.wLat = walk.lat; this.orig = walk.orig; this.cell = walk.cell;
    this.ename = walk.ename; this.ehw = walk.ehw; this.names = names; this.goff = walk.goff; this.gxy = walk.gxy;
    this.ncells = 0; for (let i = 0; i < this.cell.length; i++) if (this.cell[i] + 1 > this.ncells) this.ncells = this.cell[i] + 1;
    this.cellNodes = Array.from({ length: this.ncells }, () => []);
    for (let i = 0; i < this.cell.length; i++) this.cellNodes[this.cell[i]].push(i);
    this.cellEdges = Array.from({ length: this.ncells }, () => []);
    for (let e = 0; e < this.walk.m; e++) this.cellEdges[this.cell[this.walk.eu[e]]].push(e);
    this.doors = doors;
    const cnt = new Int32Array(this.walk.m + 1);
    for (const d of doors) cnt[d.e + 1]++;
    for (let e = 0; e < this.walk.m; e++) cnt[e + 1] += cnt[e];
    this.edgeDoorOff = cnt; this.edgeDoorList = new Int32Array(doors.length);
    const fill = new Int32Array(this.walk.m);
    doors.forEach((d, i) => { this.edgeDoorList[this.edgeDoorOff[d.e] + fill[d.e]++] = i; });
    this.loc = new Int32Array(this.walk.n).fill(-1);
    this.bbox = [Infinity, Infinity, -Infinity, -Infinity];
    for (const d of doors) { this.bbox[0] = Math.min(this.bbox[0], d.lon); this.bbox[1] = Math.min(this.bbox[1], d.lat);
                             this.bbox[2] = Math.max(this.bbox[2], d.lon); this.bbox[3] = Math.max(this.bbox[3], d.lat); }
  }

  edgeDoorIdx(e: number, active: Uint8Array): number[] {
    const out: number[] = [];
    for (let p = this.edgeDoorOff[e]; p < this.edgeDoorOff[e + 1]; p++) if (active[this.edgeDoorList[p]]) out.push(this.edgeDoorList[p]);
    return out;
  }

  nearestFullNode(lon: number, lat: number): number {
    const cy = Math.cos(lat * Math.PI / 180); let best = -1, bd = Infinity;
    for (let i = 0; i < this.fullLon.length; i++) {
      const dx = (this.fullLon[i] - lon) * cy, dy = this.fullLat[i] - lat, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** Cut turfs around a root. `exclude` = door ids (Door.id) already assigned elsewhere. */
  cut(lat: number, lon: number, p: Params, exclude?: Set<number>): CutResult {
    const active = new Uint8Array(this.doors.length).fill(1);
    if (exclude) this.doors.forEach((d, i) => { if (exclude.has(d.id)) active[i] = 0; });
    const edgeDoors = new Int32Array(this.walk.m);
    for (let e = 0; e < this.walk.m; e++) for (let q = this.edgeDoorOff[e]; q < this.edgeDoorOff[e + 1]; q++) if (active[this.edgeDoorList[q]]) edgeDoors[e]++;
    const cellDoors = new Int32Array(this.ncells);
    for (let e = 0; e < this.walk.m; e++) cellDoors[this.cell[this.walk.eu[e]]] += edgeDoors[e];

    const root = this.nearestFullNode(lon, lat);
    const approach = this.full.dijkstra([root]).dist;
    const entryD = new Float64Array(this.ncells).fill(Infinity), entryN = new Int32Array(this.ncells).fill(-1);
    for (let n = 0; n < this.walk.n; n++) {
      const d = approach[this.orig[n]], c = this.cell[n];
      if (d < entryD[c]) { entryD[c] = d; entryN[c] = n; }
    }
    const ctx: Ctx = { p, active, edgeDoors, approach, orphans: [] };
    const turfs: Turf[] = [];
    const cells = [...Array(this.ncells).keys()].filter(c => entryD[c] < Infinity).sort((a, b) => entryD[a] - entryD[b]);
    for (const c of cells) {
      const ok = turfs.filter(t => t.doors >= p.minDoors).map(t => t.approachM).sort((a, b) => a - b);
      if (ok.length >= p.k && entryD[c] > ok[p.k - 1] * 1.5) break;
      if (!cellDoors[c]) continue;
      for (const t of this.cutCell(c, entryN[c], ctx)) turfs.push(t);
    }
    this.coalesce(turfs, ctx);
    turfs.sort((a, b) => a.approachM - b.approachM);
    let pool = p.driveOk ? turfs : turfs.filter(t => t.approachM <= p.walkToStartM);
    const good = pool.filter(t => t.doors >= p.minDoors);
    const cutoffA = good.length ? good[Math.min(p.k, good.length) - 1].approachM : Infinity;
    const skippedSparse = pool.filter(t => t.doors < p.minDoors && (!good.length || t.approachM < cutoffA))
      .map(t => ({ doors: t.doors, walkKm: Math.round(t.lengthM * 2 / 100) / 10 }));
    const chosen = (p.allowSparse ? pool : good).slice(0, p.k);
    const chosenSet = new Set(chosen);
    // fold candidates under the door floor into an adjacent chosen turf with room
    const hidden = turfs.filter(t => !chosenSet.has(t) && t.doors > 0 && t.doors < p.minDoors).sort((a, b) => b.doors - a.doors);
    const absorbed = this.absorb(chosen, hidden, ctx);
    for (const t of turfs) if (!chosenSet.has(t) && !absorbed.has(t)) ctx.orphans.push(...t.doorIdx);
    if (chosen.length < p.k)
      throw new Error(`density floor: only ${chosen.length} turfs with >= ${p.minDoors} doors in a ${p.shiftMin}-min shift reachable from the root (${skippedSparse.length} sparse turfs skipped). Lower the door floor, raise the shift, or allow sparse turfs.`);
    chosen.forEach((t, i) => t.turfId = i + 1);
    return { turfs: chosen, orphans: ctx.orphans, skippedSparse };
  }

  private edgeMinutes(e: number, ctx: Ctx) {
    return ctx.edgeDoors[e] * ctx.p.minPerDoor + this.walk.elen[e] * ctx.p.backtrack / ctx.p.walkMPerMin;
  }

  private cutCell(c: number, entry: number, ctx: Ctx): Turf[] {
    const { p, edgeDoors } = ctx; const W = this.walk;
    const nodes = this.cellNodes[c], L = nodes.length, loc = this.loc;
    nodes.forEach((g, i) => loc[g] = i);
    try {
      const { dist, parent } = W.dijkstra([entry]);
      // every edge belongs to its farther endpoint; the tree edge to the parent is among them
      const owned: number[][] = Array.from({ length: L }, () => []);
      for (const e of this.cellEdges[c]) {
        const u = W.eu[e], v = W.ev[e];
        owned[loc[dist[v] >= dist[u] ? v : u]].push(e);
      }
      const children: number[][] = Array.from({ length: L }, () => []);
      const par = new Int32Array(L).fill(-1);
      for (let i = 0; i < L; i++) { const pg = parent[nodes[i]]; if (pg >= 0) { par[i] = loc[pg]; children[loc[pg]].push(i); } }
      const ldist = new Float64Array(L); for (let i = 0; i < L; i++) ldist[i] = dist[nodes[i]];
      const ownDoors = (i: number) => { let s = 0; for (const e of owned[i]) s += edgeDoors[e]; return s; };
      const ownMin = (i: number) => { let s = 0; for (const e of owned[i]) s += this.edgeMinutes(e, ctx); return s; };
      const ownLen = (i: number) => { let s = 0; for (const e of owned[i]) s += W.elen[e]; return s; };

      // prune branches with no doors
      const byDepth = [...Array(L).keys()].sort((a, b) => (ldist[b] - ldist[a]) || (nodes[a] - nodes[b]));   // leaves first
      const subDoors = new Int32Array(L);
      for (const i of byDepth) { let s = ownDoors(i); for (const ch of children[i]) s += subDoors[ch]; subDoors[i] = s; }
      const lEntry = loc[entry];
      const keep = new Uint8Array(L); for (let i = 0; i < L; i++) keep[i] = (subDoors[i] > 0 || i === lEntry) ? 1 : 0;
      for (let i = 0; i < L; i++) if (keep[i]) children[i] = children[i].filter(ch => keep[ch]);

      const cell: CellCtx = { c, nodes, owned, children, ldist, lEntry, ctx };
      const turfs: Turf[] = [], turfParent: number[] = [], frags: number[][] = [];
      const accNodes: number[][] = Array.from({ length: L }, () => []);
      const accMin = new Float64Array(L), accDoors = new Int32Array(L), accEmpty = new Float64Array(L), accLen = new Float64Array(L);
      const floorDensity = STANDALONE_DOORS / p.shiftMin;
      const emit = (part: number[], parentOf: number) => {
        for (const piece of this.shrink(part, cell)) {
          const t = this.makeTurf(piece, cell);
          if (t.doors >= STANDALONE_DOORS) { turfs.push(t); turfParent.push(parentOf); }
          else if (t.doors) frags.push(piece);
        }
      };
      for (const n of byDepth) {
        if (!keep[n]) continue;
        let oNodes = [n], oMin = ownMin(n), oD = ownDoors(n), oLen = ownLen(n);
        const segLen = oLen, mergedEmpty: number[] = [];
        const kids = [...children[n]].sort((a, b) => accDoors[b] / Math.max(accMin[b], 1e-9) - accDoors[a] / Math.max(accMin[a], 1e-9));
        for (const ch of kids) {
          if (!accNodes[ch].length) continue;
          const dens = accDoors[ch] / Math.max(accMin[ch], 1e-9);
          if (dens < floorDensity || accEmpty[ch] > p.maxConnectorM) {
            emit(accNodes[ch], n);                                    // sparse or behind a long empty street
          } else if (oMin + accMin[ch] > p.shiftMin || (oLen + accLen[ch]) * p.backtrack > p.maxWalkM
                  || oD + accDoors[ch] > p.targetDoors * 1.25 || (oD + accDoors[ch] > p.targetDoors && accDoors[ch] >= p.targetDoors * 0.5)) {
            emit(accNodes[ch], n);                                    // shift is a hard cap; door target allows 25% overshoot
          } else {
            oNodes = oNodes.concat(accNodes[ch]); oMin += accMin[ch]; oD += accDoors[ch]; oLen += accLen[ch]; mergedEmpty.push(accEmpty[ch]);
          }
        }
        const empty = ownDoors(n) > 0 ? 0 : segLen + (mergedEmpty.length ? Math.min(...mergedEmpty) : 0);
        if (oD >= p.targetDoors || oMin >= p.shiftMin * p.fill || oLen * p.backtrack >= p.maxWalkM) {
          for (const piece of this.shrink(oNodes, cell)) { turfs.push(this.makeTurf(piece, cell)); turfParent.push(par[n]); }
          accNodes[n] = []; accMin[n] = 0; accDoors[n] = 0; accEmpty[n] = 0; accLen[n] = 0;
        } else {
          accNodes[n] = oNodes; accMin[n] = oMin; accDoors[n] = oD; accEmpty[n] = empty; accLen[n] = oLen;
        }
      }
      const left = accNodes[lEntry];
      if (left.length && accMin[lEntry] > 0) {
        const t = this.makeTurf(left, cell);
        if (t.doors) {
          const leftSet = new Set(left);
          const adj = turfParent.map((pa, i) => [pa, i]).filter(([pa]) => leftSet.has(pa)).map(([, i]) => i);
          const smallest = adj.length ? adj.reduce((a, b) => turfs[a].minutes <= turfs[b].minutes ? a : b) : -1;
          if (adj.length && accMin[lEntry] < p.shiftMin * 0.5 && accEmpty[lEntry] <= p.maxConnectorM
              && accDoors[lEntry] + turfs[smallest].doors <= p.targetDoors * 1.25
              && accMin[lEntry] + turfs[smallest].minutes <= p.shiftMin
              && (accLen[lEntry] + turfs[smallest].lengthM) * p.backtrack <= p.maxWalkM) {
            const i = adj.reduce((a, b) => turfs[a].minutes <= turfs[b].minutes ? a : b);
            const leftDens = t.doors / Math.max(t.minutes, 1e-9);
            if (leftDens < p.dilution * turfs[i].doors / Math.max(turfs[i].minutes, 1e-9)) {
              frags.push(left); return this.attach(turfs, frags, cell);
            }
            turfs[i] = this.makeTurf(left.concat(turfs[i].nodes), cell);
          } else turfs.push(t);
        }
      }
      return this.attach(turfs, frags, cell);
    } finally { for (const g of nodes) loc[g] = -1; }
  }

  /** Merge adjacent under-target turfs in the same cell while the result fits the door and shift budgets. */
  private coalesce(turfs: Turf[], ctx: Ctx) {
    const { p } = ctx; const W = this.walk;
    const ends = (t: Turf) => new Set(t.edges.flatMap(e => [W.eu[e], W.ev[e]]));
    let changed = true;
    while (changed) {
      changed = false;
      const order = [...turfs].sort((a, b) => a.doors - b.doors);
      for (const t of order) {
        if (t.doors >= p.targetDoors || !turfs.includes(t)) continue;
        const { dist, parent, parentEdge } = W.dijkstra(ends(t), p.maxConnectorM);
        let best: { d: number; u: Turf; n: number } | null = null;
        for (const u of turfs) {
          if (u === t || u.cell !== t.cell) continue;
          if (t.doors + u.doors > p.targetDoors * 1.25) continue;
          let dconn = Infinity, hit = -1;
          for (const n of ends(u)) if (dist[n] < dconn || (dist[n] === dconn && n < hit)) { dconn = dist[n]; hit = n; }
          if (hit < 0) continue;
          if (t.minutes + u.minutes + 2 * dconn / p.walkMPerMin > p.shiftMin) continue;
          if ((t.lengthM + u.lengthM + dconn) * p.backtrack > p.maxWalkM) continue;
          if (!best || dconn < best.d) best = { d: dconn, u, n: hit };
        }
        if (!best) continue;
        const { u, n } = best as { d: number; u: Turf; n: number };
        const extra = u.edges.concat(t.edges);
        for (let x = n; parent[x] >= 0; x = parent[x]) extra.push(parentEdge[x]);
        const merged = this.buildTurf([...new Set(extra)], u.nodes.concat(t.nodes), u.cell, ctx);
        turfs.splice(turfs.indexOf(u), 1, merged); turfs.splice(turfs.indexOf(t), 1);
        changed = true;   // keep going through this pass; the next pass re-sorts
      }
    }
  }

  /** Fold small hidden candidates into the nearest chosen turf (same cell, short connector, within the shift). */
  private absorb(chosen: Turf[], hidden: Turf[], ctx: Ctx): Set<Turf> {
    const { p } = ctx; const W = this.walk; const done = new Set<Turf>();
    const ends = (t: Turf) => new Set(t.edges.flatMap(e => [W.eu[e], W.ev[e]]));
    const chosenEnds = chosen.map(ends);
    for (const h of hidden) {
      const { dist, parent, parentEdge } = W.dijkstra(ends(h), p.maxConnectorM);
      let best: { d: number; i: number; n: number } | null = null;
      chosenEnds.forEach((tn, i) => {
        if (chosen[i].cell !== h.cell) return;
        let dconn = Infinity, hit = -1;
        for (const n of tn) if (dist[n] < dconn || (dist[n] === dconn && n < hit)) { dconn = dist[n]; hit = n; }
        if (hit < 0) return;
        if (chosen[i].minutes + h.minutes + 2 * dconn / p.walkMPerMin <= p.shiftMin && chosen[i].doors + h.doors <= p.targetDoors * 1.25
            && (chosen[i].lengthM + h.lengthM + dconn) * p.backtrack <= p.maxWalkM && (!best || dconn < best.d)) best = { d: dconn, i, n: hit };
      });
      if (!best) continue;
      const { i, n } = best as { d: number; i: number; n: number };
      const extra = chosen[i].edges.concat(h.edges);
      for (let x = n; parent[x] >= 0; x = parent[x]) extra.push(parentEdge[x]);
      const merged = this.buildTurf([...new Set(extra)], chosen[i].nodes, chosen[i].cell, ctx);
      merged.turfId = chosen[i].turfId; chosen[i] = merged; chosenEnds[i] = ends(merged); done.add(h);
    }
    return done;
  }

  private attach(turfs: Turf[], frags: number[][], cell: CellCtx): Turf[] {
    const { ctx, owned } = cell; const { p, edgeDoors } = ctx; const W = this.walk;
    const ends = (t: Turf) => new Set(t.edges.flatMap(e => [W.eu[e], W.ev[e]]));
    const turfNodes = turfs.map(ends);
    for (const part of [...frags].sort((a, b) => b.length - a.length)) {
      const partEdges = part.flatMap(i => owned[i]);
      const sources = new Set(partEdges.flatMap(e => [W.eu[e], W.ev[e]]));
      let fd = 0, fmin = 0; for (const e of partEdges) { fd += edgeDoors[e]; fmin += this.edgeMinutes(e, ctx); }
      if (!fd) continue;
      const { dist, parent, parentEdge } = W.dijkstra(sources, p.maxConnectorM);
      let best: { d: number; i: number; n: number } | null = null;
      turfNodes.forEach((tn, i) => {
        let dconn = Infinity, hit = -1;
        for (const n of tn) if (dist[n] < dconn || (dist[n] === dconn && n < hit)) { dconn = dist[n]; hit = n; }
        if (hit < 0) return;
        const total = turfs[i].minutes + fmin + 2 * dconn / p.walkMPerMin;
        const flen = partEdges.reduce((a, e) => a + W.elen[e], 0);
        if (total <= p.shiftMin && turfs[i].doors + fd <= p.targetDoors * 1.25 && (turfs[i].lengthM + flen + dconn) * p.backtrack <= p.maxWalkM
            && (!best || dconn < best.d)) best = { d: dconn, i, n: hit };
      });
      if (!best) {   // nowhere to attach: it becomes a small candidate turf (the door floor decides later)
        const t = this.makeTurf(part, cell); turfs.push(t); turfNodes.push(ends(t)); continue; }
      const { i, n } = best as { d: number; i: number; n: number };
      const extra = turfs[i].edges.concat(partEdges), pathNodes: number[] = [];
      for (let x = n; parent[x] >= 0; x = parent[x]) { extra.push(parentEdge[x]); pathNodes.push(this.loc[x]); }
      turfs[i] = this.makeTurfEdges([...new Set(extra)], turfs[i].nodes.concat(part, pathNodes.filter(x => x >= 0)), cell);
      turfNodes[i] = ends(turfs[i]);
    }
    return turfs;
  }

  /** Prune thin branches off a cut turf while what remains is still a full-enough turf. */
  private shrink(nodes: number[], cell: CellCtx): number[][] {
    const { owned, children, ctx } = cell; const { p, edgeDoors } = ctx; const W = this.walk;
    const nodeSet = new Set(nodes);
    const stats = (ns: Iterable<number>) => { let d = 0, L = 0; for (const n of ns) for (const e of owned[n]) { d += edgeDoors[e]; L += W.elen[e]; } return [d, L]; };
    const minutes = (d: number, L: number) => d * p.minPerDoor + L * p.backtrack / p.walkMPerMin;
    const subtree = (v: number) => { const out: number[] = [], st = [v]; while (st.length) { const x = st.pop()!; out.push(x); for (const ch of children[x]) if (nodeSet.has(ch)) st.push(ch); } return out; };
    const pruned: number[][] = [];
    for (;;) {
      const [td, tL] = stats(nodeSet);
      let best: number[] | null = null, bestDpk = Infinity;
      for (const v of nodeSet) {
        const br = subtree(v);
        if (br.length === nodeSet.size) continue;
        const [bd, bL] = stats(br);
        if (!bd || !bL) continue;
        const rd = td - bd, rL = tL - bL;
        if (rd < STANDALONE_DOORS || rL <= 0 || (rd < p.targetDoors && minutes(rd, rL) < p.shiftMin * p.fill)) continue;
        const bDpk = bd / bL, rDpk = rd / rL;
        if (bDpk < p.dilution * rDpk && bDpk < bestDpk) { best = br; bestDpk = bDpk; }
      }
      if (!best) break;
      for (const x of best) nodeSet.delete(x); pruned.push(best);
    }
    return [nodes.filter(n => nodeSet.has(n)), ...pruned];
  }

  private makeTurf(nodes: number[], cell: CellCtx): Turf {
    return this.makeTurfEdges(nodes.flatMap(n => cell.owned[n]), nodes, cell);
  }

  private makeTurfEdges(edgeIds: number[], nodes: number[], cell: CellCtx): Turf {
    return this.buildTurf(edgeIds, nodes, cell.c, cell.ctx);
  }

  private buildTurf(edgeIds: number[], nodes: number[], c: number, ctx: Ctx): Turf {
    const { p, edgeDoors, approach } = ctx; const W = this.walk;
    // trim door-less tails at both ends: the walk in from the entry and any empty spur
    const alive = new Set(edgeIds);
    const deg = new Map<number, number>();
    const bump = (n: number, d: number) => deg.set(n, (deg.get(n) ?? 0) + d);
    for (const e of alive) { bump(W.eu[e], 1); bump(W.ev[e], 1); }
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of [...alive]) {
        if (edgeDoors[e] === 0 && (deg.get(W.eu[e]) === 1 || deg.get(W.ev[e]) === 1)) {
          alive.delete(e); bump(W.eu[e], -1); bump(W.ev[e], -1); changed = true;
        }
      }
    }
    const t: Turf = { turfId: 0, cell: c, edges: [...alive], nodes: [...nodes], doorIdx: [], doors: 0, lengthM: 0, minutes: 0, approachM: Infinity };
    for (const e of t.edges) {
      t.lengthM += W.elen[e];
      const ids = this.edgeDoorIdx(e, ctx.active); t.doorIdx.push(...ids); t.doors += ids.length;
      for (const n of [W.eu[e], W.ev[e]]) { const a = approach[this.orig[n]]; if (a < t.approachM) t.approachM = a; }
    }
    t.minutes = t.doors * p.minPerDoor + t.lengthM * p.backtrack / p.walkMPerMin;
    return t;
  }

  /** Edge geometry as [lon, lat] pairs. */
  edgeCoords(e: number): [number, number][] {
    const out: [number, number][] = [];
    for (let i = this.goff[e]; i < this.goff[e + 1]; i++) out.push([this.gxy[2 * i], this.gxy[2 * i + 1]]);
    return out;
  }
}

interface Ctx { p: Params; active: Uint8Array; edgeDoors: Int32Array; approach: Float64Array; orphans: number[]; }
interface CellCtx { c: number; nodes: number[]; owned: number[][]; children: number[][]; ldist: Float64Array; lEntry: number; ctx: Ctx; }
