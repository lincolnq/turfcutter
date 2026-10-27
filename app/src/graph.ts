// Undirected graph in CSR form with a binary-heap Dijkstra.

class MinHeap {
  keys: number[] = []; vals: number[] = [];
  get size() { return this.keys.length; }
  push(k: number, v: number) {
    const K = this.keys, V = this.vals; K.push(k); V.push(v);
    let i = K.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= K[i]) break;
      [K[p], K[i]] = [K[i], K[p]]; [V[p], V[i]] = [V[i], V[p]]; i = p; }
  }
  pop(): [number, number] {
    const K = this.keys, V = this.vals; const top: [number, number] = [K[0], V[0]];
    const lk = K.pop()!, lv = V.pop()!;
    if (K.length) { K[0] = lk; V[0] = lv; let i = 0; const n = K.length;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < n && K[l] < K[m]) m = l; if (r < n && K[r] < K[m]) m = r; if (m === i) break;
        [K[m], K[i]] = [K[i], K[m]]; [V[m], V[i]] = [V[i], V[m]]; i = m; } }
    return top;
  }
}

export interface Dijkstra { dist: Float64Array; parent: Int32Array; parentEdge: Int32Array; }

export class Graph {
  n: number; m: number;
  eu: Int32Array; ev: Int32Array; elen: Float32Array;
  off: Int32Array; to: Int32Array; edge: Int32Array;   // CSR adjacency
  constructor(n: number, eu: Int32Array, ev: Int32Array, elen: Float32Array) {
    this.n = n; this.m = eu.length; this.eu = eu; this.ev = ev; this.elen = elen;
    const deg = new Int32Array(n + 1);
    for (let e = 0; e < this.m; e++) { deg[eu[e] + 1]++; deg[ev[e] + 1]++; }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    this.off = deg; this.to = new Int32Array(deg[n]); this.edge = new Int32Array(deg[n]);
    const fill = new Int32Array(n);
    for (let e = 0; e < this.m; e++) {
      const u = eu[e], v = ev[e];
      let p = this.off[u] + fill[u]++; this.to[p] = v; this.edge[p] = e;
      p = this.off[v] + fill[v]++; this.to[p] = u; this.edge[p] = e;
    }
  }
  other(e: number, n: number) { return this.eu[e] === n ? this.ev[e] : this.eu[e]; }

  /** Multi-source Dijkstra over the whole graph. dist is Infinity where unreached. */
  dijkstra(sources: Iterable<number>, cutoff = Infinity): Dijkstra {
    const dist = new Float64Array(this.n).fill(Infinity);
    const parent = new Int32Array(this.n).fill(-1);
    const parentEdge = new Int32Array(this.n).fill(-1);
    const heap = new MinHeap();
    for (const s of sources) { dist[s] = 0; heap.push(0, s); }
    while (heap.size) {
      const [d, u] = heap.pop();
      if (d > dist[u]) continue;
      for (let p = this.off[u]; p < this.off[u + 1]; p++) {
        const v = this.to[p], e = this.edge[p], nd = d + this.elen[e];
        if (nd > cutoff || nd >= dist[v]) continue;
        dist[v] = nd; parent[v] = u; parentEdge[v] = e; heap.push(nd, v);
      }
    }
    return { dist, parent, parentEdge };
  }
}
