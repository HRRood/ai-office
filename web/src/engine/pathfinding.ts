// A* on the tile grid, 4-directional. Returns the tiles from start to goal (inclusive),
// or [] if unreachable.
import type { OfficeMap, Tile } from './map';

export function findPath(map: OfficeMap, start: Tile, goal: Tile): Tile[] {
  const { w, h } = map;
  const idx = (x: number, y: number) => y * w + x;
  const s = idx(start[0], start[1]);
  const g = idx(goal[0], goal[1]);
  if (s === g) return [start];
  if (!map.isWalkable(goal[0], goal[1])) return [];

  const gScore = new Float64Array(w * h).fill(Infinity);
  const came = new Int32Array(w * h).fill(-1);
  // Direction we arrived from, to slightly penalise turns -> straighter, more natural paths.
  const dirIn = new Int8Array(w * h).fill(-1);
  const closed = new Uint8Array(w * h);
  const heap = new MinHeap();
  const hScore = (i: number) => Math.abs((i % w) - goal[0]) + Math.abs(Math.floor(i / w) - goal[1]);

  gScore[s] = 0;
  heap.push(s, hScore(s));
  const DIRS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  while (heap.size) {
    const cur = heap.pop();
    if (cur === g) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % w;
    const cy = Math.floor(cur / w);
    for (let d = 0; d < 4; d++) {
      const nx = cx + DIRS[d][0];
      const ny = cy + DIRS[d][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = idx(nx, ny);
      // The start tile may be non-walkable (e.g. a worker standing somewhere odd); others must be walkable.
      if (closed[n] || !map.isWalkable(nx, ny)) continue;
      const turn = dirIn[cur] !== -1 && dirIn[cur] !== d ? 0.05 : 0;
      const tentative = gScore[cur] + 1 + turn;
      if (tentative < gScore[n]) {
        gScore[n] = tentative;
        came[n] = cur;
        dirIn[n] = d;
        heap.push(n, tentative + hScore(n));
      }
    }
  }

  if (came[g] === -1) return [];
  const path: Tile[] = [];
  for (let i = g; i !== -1; i = came[i]) path.push([i % w, Math.floor(i / w)]);
  return path.reverse();
}

class MinHeap {
  private items: number[] = [];
  private prio: number[] = [];
  get size() {
    return this.items.length;
  }
  push(item: number, p: number) {
    const a = this.items;
    const q = this.prio;
    a.push(item);
    q.push(p);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (q[parent] <= q[i]) break;
      [a[i], a[parent]] = [a[parent], a[i]];
      [q[i], q[parent]] = [q[parent], q[i]];
      i = parent;
    }
  }
  pop(): number {
    const a = this.items;
    const q = this.prio;
    const top = a[0];
    const lastItem = a.pop()!;
    const lastPrio = q.pop()!;
    if (a.length) {
      a[0] = lastItem;
      q[0] = lastPrio;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && q[l] < q[m]) m = l;
        if (r < a.length && q[r] < q[m]) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        [q[i], q[m]] = [q[m], q[i]];
        i = m;
      }
    }
    return top;
  }
}
