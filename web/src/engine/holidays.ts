// Seasonal themes. Everything here is visual only.
//
//   Sinterklaas  15 Nov – 5 Dec   bunting, shoes with carrots, chocolate letters, pepernoten, snow, a visit from the Sint
//   Christmas     6 Dec – 6 Jan   fairy lights, Christmas trees (the plants), Santa hats, snow
//
// Preview with ?holiday=sinterklaas|christmas|none or ?date=2026-12-20.
//
// The decorations are real low-poly 3D meshes (see mesh.ts). They are drawn live every frame, so each
// static piece is built once and baked into a cached bitmap at the current zoom; only the animated bits
// (blinking bulbs, glows, the pulsing star) are drawn live on top.
import { hash, type OfficeMap, type Tile } from './map';
import { WALL_IN, WALL_RISE } from './tiles';
import { poly, shade, softShadow, type Pt } from './lowpoly';
import { Mesh, project, SKEW, type V3 } from './mesh';
import { HEAD_DX } from './sprites';

export type Holiday = 'sinterklaas' | 'christmas' | null;

export const HOLIDAY_INFO: Record<Exclude<Holiday, null>, { badge: string; cheers: string[] }> = {
  sinterklaas: { badge: '🎁 Sinterklaas', cheers: ['Proost! 🎁', 'Cheers! 🍺', 'Pepernoten! 🍪'] },
  christmas: { badge: '🎄 Christmas', cheers: ['Merry Christmas! 🎄', 'Cheers! 🍺', 'Ho ho ho! 🎅'] },
};

/** Which theme applies on a date. Months are 0-based (10 = November). */
export function holidayFor(d: Date): Holiday {
  const m = d.getMonth();
  const day = d.getDate();
  if ((m === 10 && day >= 15) || (m === 11 && day <= 5)) return 'sinterklaas';
  if ((m === 11 && day >= 6) || (m === 0 && day <= 6)) return 'christmas';
  return null;
}

/** Today's date, or ?date= for previews. */
export function currentDate(now = new Date()): Date {
  const date = new URLSearchParams(location.search).get('date');
  return date && !Number.isNaN(Date.parse(date)) ? new Date(`${date}T12:00:00`) : now;
}

/** Gifts under the big tree: one on 6 Dec, one more every day after. */
export function giftsUnderTree(d: Date): number {
  const start = new Date(d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear(), 11, 6);
  const days = Math.floor((d.getTime() - start.getTime()) / 86_400_000);
  return Math.max(1, days + 1);
}

/** Current holiday, honouring ?holiday= and ?date= for previews. */
export function currentHoliday(now = new Date()): Holiday {
  const q = new URLSearchParams(location.search);
  const forced = q.get('holiday');
  if (forced === 'sinterklaas' || forced === 'christmas') return forced;
  if (forced === 'none') return null;
  const date = q.get('date');
  if (date && !Number.isNaN(Date.parse(date))) return holidayFor(new Date(`${date}T12:00:00`));
  return holidayFor(now);
}

/** Drawing context the decorations need from the renderer. */
export interface DecorView {
  ctx: CanvasRenderingContext2D;
  /** One map pixel in device pixels. */
  s: number;
  dpr: number;
  px(tx: number): number;
  py(ty: number): number;
  width: number;
  height: number;
}

const isWallish = (c: string) => c === '#' || c === 'V';

/** Wall solids as tiles.ts builds them (the secret door is a wall too). */
const isSolid = (c: string) => c === '#' || c === 'V' || c === 'X';

interface Gift {
  /** map pixels, absolute */
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  ribbon: string;
}

const GIFT_COLORS: Array<[string, string]> = [
  ['#e8534a', '#f2d13d'],
  ['#3aa7e0', '#f4f6fa'],
  ['#7bc950', '#e8534a'],
  ['#9b5de5', '#f2d13d'],
  ['#f2d13d', '#e8534a'],
  ['#e05fae', '#f4f6fa'],
  ['#f4f6fa', '#d42a2a'],
  ['#2fb39a', '#f2d13d'],
];

/** Precomputed decoration positions for a map. */
export class HolidayDecor {
  /** Wall tiles with a visible front face, grouped by row. */
  private faces = new Map<number, number[]>();
  private plants = new Map<number, number[]>();
  private desks = new Map<number, number[]>();
  private tables = new Map<number, number[]>();
  /** Floor tiles where Sinterklaas shoes stand. */
  readonly shoeTiles: Tile[] = [];
  /** Sinterklaas presents scattered around the office, one or two per room. */
  private sintGifts: Array<{ tile: Tile; gift: Gift }> = [];
  /** The big Christmas tree: base center in map pixels, the tiles it and its gifts cover, gift slots. */
  private bigTree: { cx: number; base: number; row: number; tiles: Tile[]; slots: Gift[] } | null = null;
  private flakes: Array<{ x: number; speed: number; drift: number; size: number; phase: number }> = [];
  /** How many gifts are under the big tree today. */
  giftCount = 1;

  /** `reserved`: floor tiles that are spoken for (e.g. the manager's seat); no decorations go there. */
  constructor(private readonly map: OfficeMap, reserved: Tile[] = []) {
    const T = map.tileSize;
    const add = (m: Map<number, number[]>, x: number, y: number) => m.set(y, [...(m.get(y) ?? []), x]);
    for (let y = 0; y < map.h; y++)
      for (let x = 0; x < map.w; x++) {
        const c = map.at(x, y);
        // lights and bunting hang on wall fronts that face open floor (not the hull, not above a doorway)
        const below = map.at(x, y + 1);
        if (isSolid(c) && y < map.h - 1 && !isSolid(below) && below !== 'D' && below !== 'E') add(this.faces, x, y);
        if (c === 'P') add(this.plants, x, y);
        if (c === 'd') add(this.desks, x, y);
        if (c === 'T') add(this.tables, x, y);
        // shoes go on the floor right under a window, but not next to a desk
        if (c === '.' && map.at(x, y - 1) === 'V' && map.at(x - 1, y) !== 'd' && map.at(x + 1, y) !== 'd')
          this.shoeTiles.push([x, y]);
      }

    // Sinterklaas gifts: quiet floor tiles against a room's back or side wall (not next to doors or furniture),
    // and only where blocking the tile keeps every other floor tile reachable.
    const taken = new Set(this.shoeTiles.map(([x, y]) => `${x},${y}`));
    for (const [x, y] of reserved) taken.add(`${x},${y}`);
    const baseline = this.reachable(taken);
    for (const id of Object.keys(map.rooms) as Array<keyof OfficeMap['rooms']>) {
      const [x0, y0, x1, y1] = map.rooms[id].rect;
      const free = map.overflow[id].filter(([x, y]) => {
        const againstWall = isWallish(map.at(x, y - 1)) || isWallish(map.at(x - 1, y)) || isWallish(map.at(x + 1, y));
        return x > x0 && x < x1 && y > y0 && y < y1 - 1 && againstWall && !taken.has(`${x},${y}`);
      });
      const n = Math.min(free.length, 1 + (hash('gifts', id) % 2));
      for (let i = 0; i < n; i++) {
        const tile = free[hash('gift', id, i) % free.length];
        const key = `${tile[0]},${tile[1]}`;
        if (taken.has(key)) continue;
        taken.add(key);
        if (this.reachable(taken) < baseline - taken.size + this.shoeTiles.length + reserved.length) {
          taken.delete(key); // would cut something off
          continue;
        }
        const [color, ribbon] = GIFT_COLORS[hash(id, i) % GIFT_COLORS.length];
        const w = 7 + (hash('w', id, i) % 4);
        const h = 6 + (hash('h', id, i) % 4);
        this.sintGifts.push({ tile, gift: { x: tile[0] * T + (16 - w) / 2, y: tile[1] * T + 14 - h, w, h, color, ribbon } });
      }
    }

    // Big Christmas tree near the right side of the open office (a 4x3 block of free floor).
    const [, oy0, ox1, oy1] = map.rooms.openOffice.rect;
    const row = Math.floor((oy0 + oy1) / 2) + 1; // the tree's base row
    const tiles: Tile[] = [];
    for (let y = row - 2; y <= row + 1; y++) for (let x = ox1 - 6; x <= ox1 - 1; x++) tiles.push([x, y]);
    if (tiles.every(([x, y]) => map.at(x, y) === '.')) {
      const cx = (ox1 - 3) * T; // between the 3rd and 4th tile from the wall
      const base = (row + 1) * T - 2;
      const slots: Gift[] = [];
      // gifts in rings around the trunk: closest first, so each new day's gift appears at the edge of the pile
      for (let ring = 0; ring < 4; ring++) {
        const count = 6 + ring * 2;
        for (let i = 0; i < count; i++) {
          const a = Math.PI * (0.05 + (0.9 * i) / (count - 1)); // front half-circle
          const rx = 20 + ring * 9;
          const ry = 6 + ring * 4;
          const k = hash('slot', ring, i);
          const w = 6 + (k % 5);
          const h = 5 + ((k >> 3) % 5);
          const [color, ribbon] = GIFT_COLORS[k % GIFT_COLORS.length];
          slots.push({ x: cx - Math.cos(a) * rx - w / 2, y: base + Math.sin(a) * ry - h - 2, w, h, color, ribbon });
        }
      }
      // spread the order a little so the pile grows evenly left and right
      slots.sort((p, q) => Math.hypot(p.x - cx, (p.y - base) * 2) - Math.hypot(q.x - cx, (q.y - base) * 2));
      this.bigTree = { cx, base, row, tiles, slots };
    }

    for (let i = 0; i < 90; i++)
      this.flakes.push({
        x: (hash('flake', i) % 10000) / 10000,
        speed: 0.025 + (hash('speed', i) % 100) / 2500,
        drift: 0.3 + (hash('drift', i) % 100) / 100,
        size: 1 + (hash('size', i) % 3),
        phase: (hash('phase', i) % 1000) / 1000,
      });
  }

  /** How many walkable tiles can be reached from the entrance if `blocked` tiles are off limits. */
  private reachable(blocked: Set<string>): number {
    const { map } = this;
    const walk = (x: number, y: number) => '.DE'.includes(map.at(x, y)) && !blocked.has(`${x},${y}`);
    const seen = new Set<string>([`${map.entrance[0]},${map.entrance[1]}`]);
    const queue: Tile[] = [map.entrance];
    while (queue.length) {
      const [x, y] = queue.pop()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const [nx, ny] = [x + dx, y + dy];
        const k = `${nx},${ny}`;
        if (!seen.has(k) && walk(nx, ny)) {
          seen.add(k);
          queue.push([nx, ny]);
        }
      }
    }
    return seen.size;
  }

  /** Floor tiles decorations stand on this season: nobody walks or stands there. */
  blockedTiles(h: Holiday): Tile[] {
    if (h === 'sinterklaas') return [...this.shoeTiles, ...this.sintGifts.map((g) => g.tile)];
    if (h === 'christmas') return this.bigTree?.tiles ?? [];
    return [];
  }

  /** Decorations that belong to row `row` (drawn right after that row's walls/furniture, before its workers). */
  drawRow(h: Holiday, row: number, v: DecorView, t: number) {
    if (!h) return;
    for (const x of this.faces.get(row) ?? []) (h === 'christmas' ? fairyLights : bunting)(v, x, row, t);
    if (h === 'christmas') {
      for (const x of this.plants.get(row) ?? []) christmasTree(v, x, row, t);
      const tree = this.bigTree;
      if (tree) {
        const T = this.map.tileSize;
        const shown = tree.slots.slice(0, Math.min(this.giftCount, tree.slots.length));
        // gifts behind the trunk line go before the tree, the rest after (in their own row)
        for (const g of shown) if (Math.floor((g.y + g.h) / T) === row && g.y + g.h < tree.base - 4) giftBox(v, g);
        if (row === tree.row) bigChristmasTree(v, tree.cx, tree.base, t);
        for (const g of shown) if (Math.floor((g.y + g.h) / T) === row && g.y + g.h >= tree.base - 4) giftBox(v, g);
      }
    }
    if (h === 'sinterklaas') {
      for (const x of this.desks.get(row) ?? []) if (hash('letter', x, row) % 3 === 0) chocolateLetter(v, x, row);
      for (const x of this.tables.get(row) ?? []) pepernoten(v, x, row);
      for (const [x, y] of this.shoeTiles) if (y === row) shoe(v, x, y);
      for (const { tile, gift } of this.sintGifts) if (tile[1] === row) giftBox(v, gift);
    }
  }

  /** Over everything (but under name tags): snow during both holiday seasons. */
  drawOverlay(h: Holiday, v: DecorView, t: number) {
    if (!h) return;
    const { ctx } = v;
    // small faceted diamonds, batched by size into one path each (3 fills per frame)
    ctx.fillStyle = '#f4f8ff';
    for (let size = 1; size <= 3; size++) {
      ctx.beginPath();
      for (const f of this.flakes) {
        if (f.size !== size) continue;
        const y = ((t / 1000) * f.speed + f.phase) % 1;
        const x = (f.x + Math.sin(t / 1400 + f.phase * 10) * 0.01 * f.drift) % 1;
        const r = 0.8 * size * v.dpr;
        const cx = x * v.width;
        const cy = y * v.height;
        ctx.moveTo(cx, cy - r);
        ctx.lineTo(cx + r * 0.75, cy);
        ctx.lineTo(cx, cy + r);
        ctx.lineTo(cx - r * 0.75, cy);
        ctx.closePath();
      }
      ctx.globalAlpha = 0.35 + 0.15 * size;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

// ---------- baking: meshes are built once, cached as bitmaps, stamped every frame ----------

type Ctx = CanvasRenderingContext2D;
/** Screen-space bounds in art units: x0, y0, w, h. */
type Box = [number, number, number, number];
interface Baked<T> {
  c: HTMLCanvasElement;
  x0: number;
  y0: number;
  data: T;
}

const bakes = new Map<string, Baked<unknown>>();
let bakeScale = 0;

/** Paint `paint` (art units, origin = the piece's art origin) once per zoom level into a cached canvas. */
function bake<T>(key: string, s: number, box: Box, paint: (ctx: Ctx) => T): Baked<T> {
  if (s !== bakeScale) {
    bakes.clear();
    bakeScale = s;
  }
  let b = bakes.get(key) as Baked<T> | undefined;
  if (!b) {
    if (bakes.size > 1500) bakes.clear(); // a map has a few hundred pieces; this only guards runaway growth
    const [x0, y0, w, h] = box;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w * s));
    c.height = Math.max(1, Math.ceil(h * s));
    const g = c.getContext('2d')!;
    g.scale(s, s);
    g.translate(-x0, -y0);
    b = { c, x0, y0, data: paint(g) };
    bakes.set(key, b);
  }
  return b;
}

/** Draw a bake whose art origin sits at device point (ox, oy). */
function stamp(v: DecorView, b: Baked<unknown>, ox: number, oy: number) {
  v.ctx.drawImage(b.c, ox + b.x0 * v.s, oy + b.y0 * v.s);
}

/** Draw in art units with the origin at screen point (ox, oy). */
function inArt(v: DecorView, ox: number, oy: number, draw: (ctx: Ctx) => void) {
  const { ctx, s } = v;
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(s, s);
  draw(ctx);
  ctx.restore();
}

/** Cached soft radial glow sprites, one per color (cheap to stamp every frame). */
const glowSprites = new Map<string, HTMLCanvasElement>();
function glow(ctx: Ctx, x: number, y: number, r: number, color: string, alpha: number) {
  let c = glowSprites.get(color);
  if (!c) {
    c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const n = parseInt(color.slice(1), 16);
    const rgb = `${n >> 16},${(n >> 8) & 255},${n & 255}`;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, `rgba(${rgb},0.9)`);
    grad.addColorStop(0.3, `rgba(${rgb},0.4)`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    glowSprites.set(color, c);
  }
  const a = ctx.globalAlpha;
  ctx.globalAlpha = a * alpha;
  ctx.drawImage(c, x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = a;
}

/** A two-facet diamond (a lit bulb's hot core, a twinkle). */
function diamond(ctx: Ctx, x: number, y: number, rx: number, ry: number, base: string) {
  poly(ctx, [[x, y - ry], [x, y + ry], [x - rx, y]], shade(base, 0.3));
  poly(ctx, [[x, y - ry], [x + rx, y], [x, y + ry]], shade(base, -0.08));
}

// ---------- 3D building blocks ----------

/** One fir tier: a cone [base z, height, radius]. */
type Tier = [number, number, number];

/** A point on (or `out` units outside) a cone tier: angle a (π/2 = facing the viewer), height fraction f. */
function onCone(cx: number, cy: number, ry: number, [z0, h, r]: Tier, a: number, f: number, out = 0): V3 {
  const rr = r * (1 - f) + out;
  return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * ry, z0 + h * f];
}

/** Stacked low-poly cones, each turned a little so the facets don't line up. */
function firTiers(m: Mesh, cx: number, cy: number, ry: number, tiers: Tier[], green: string, sides: (i: number) => number) {
  tiers.forEach(([z0, h, r], i) => m.cylinder(cx, cy, z0, r, 0, h, sides(i), shade(green, i % 2 ? 0.07 : -0.04), { ry, rot: 0.35 + i * 0.9, jitter: 0.05 }));
}

/** A garland of small gold beads sagging across the front of a tier. */
function garland(m: Mesh, cx: number, cy: number, ry: number, tier: Tier, f0: number, n: number, bead: number) {
  for (let i = 0; i < n; i++) {
    const a = Math.PI * (0.14 + (0.72 * i) / (n - 1));
    const [x, y, z] = onCone(cx, cy, ry, tier, a, f0 - 0.13 * Math.sin(a), bead * 0.6);
    m.ball(x, y, z, bead, bead, bead, '#e5b83b', { jitter: 0.08 });
  }
}

/** A faceted five-point star standing upright, its centre raised toward the viewer. */
function star3d(m: Mesh, cx: number, cy: number, cz: number, r: number, color: string) {
  const pts: V3[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 ? r * 0.45 : r;
    pts.push([cx + Math.cos(a) * rr, cy, cz - Math.sin(a) * rr]);
  }
  const front: V3 = [cx, cy + r * 0.5, cz];
  for (let i = 0; i < 10; i++) m.face([front, pts[i], pts[(i + 1) % 10]], color, { jitter: 0, strength: 0.8 });
}

/**
 * A wrapped present: screen top-left (x, y), screen size w x h, floor contact along y + h.
 * A real box (lid rim bevelled) with two ribbon bands wrapped around it and a bow of two loops.
 */
function present(ctx: Ctx, x: number, y: number, w: number, h: number, color: string, ribbon: string, seed = 0) {
  softShadow(ctx, x + w / 2 + 0.8, y + h - 0.3, w * 0.7, 1.5, 0.4);
  const m = new Mesh(seed);
  const d = Math.min(w * 0.75, h * 0.5); // depth
  const ht = h - d; // height
  const y1 = y + h; // front edge on the floor
  const y0 = y1 - d;
  const mid = x + w / 2;
  const cy = y0 + d / 2;
  const rw = Math.min(0.65, w / 9);
  const e = 0.07; // ribbons sit just proud of the box
  m.box(x, y0, 0, w, d, ht, color, { chamfer: 0.3, bevel: 0.35 });
  m.box(mid - rw, y0 - e, 0, rw * 2, d + e * 2, ht + e, ribbon, { jitter: 0.02 });
  m.box(x - e, cy - rw, 0, w + e * 2, rw * 2, ht + e, ribbon, { jitter: 0.02 });
  // bow: two flattened loops and a knot
  const bz = ht + 0.55;
  m.ball(mid - 1.05, cy, bz, 1.15, 0.65, 0.6, ribbon);
  m.ball(mid + 1.05, cy, bz, 1.15, 0.65, 0.6, ribbon);
  m.ball(mid, cy + 0.1, ht + 0.45, 0.55, 0.55, 0.5, shade(ribbon, -0.1));
  m.draw(ctx);
}

// ---------- decoration pieces ----------

const LIGHT_COLORS = ['#ff4d4d', '#ffd84d', '#4dff88', '#4dc3ff', '#ff7ae0'];
const BAUBLE_COLORS = ['#ff4d4d', '#ffd84d', '#4dc3ff', '#ff7ae0', '#f4f6fa'];

interface Bulb {
  /** screen position, art units relative to the bake origin */
  x: number;
  y: number;
  c: string;
  k: number;
}

const PLANT_TIERS: Tier[] = [
  [4.2, 9.8, 7.6],
  [8.8, 8.8, 6.5],
  [13, 7.6, 5],
  [16.8, 6.6, 3.4],
];

/** The plant's place taken by a small decorated fir in a red pot, with two presents in front. */
function christmasTree(v: DecorView, tx: number, ty: number, t: number) {
  const b = bake(`ptree:${tx},${ty}`, v.s, [-1.5, -17, 19, 34], (ctx) => {
    softShadow(ctx, 8.5, 14.8, 7.5, 1.8, 0.35);
    const m = new Mesh(hash('ptree', tx, ty));
    const cx = 8;
    const cy = 11;
    const ry = 0.78;
    const pot = '#8a3a2a';
    m.cylinder(cx, cy + 0.4, 0, 3.3, 3.9, 4, 8, pot, { ry: 0.8 });
    m.cylinder(cx, cy + 0.4, 3.6, 4.3, 4.2, 1.1, 8, shade(pot, 0.12), { ry: 0.8 });
    firTiers(m, cx, cy, ry, PLANT_TIERS, '#2f7a3a', () => 7);
    garland(m, cx, cy, ry, PLANT_TIERS[0], 0.42, 9, 0.38);
    garland(m, cx, cy, ry, PLANT_TIERS[1], 0.45, 7, 0.36);
    const spots: Array<[number, number, number]> = [
      [0, 0.28, 0.16], [0, 0.62, 0.12], [0, 0.86, 0.5], [1, 0.22, 0.28],
      [1, 0.58, 0.55], [2, 0.38, 0.2], [2, 0.76, 0.42], [3, 0.52, 0.3],
    ];
    const bulbs: Bulb[] = [];
    spots.forEach(([ti, a, f], i) => {
      const k = hash(tx, ty, i);
      const c = BAUBLE_COLORS[k % BAUBLE_COLORS.length];
      const p = onCone(cx, cy, ry, PLANT_TIERS[ti], a * Math.PI, f, 0.55);
      m.ball(p[0], p[1], p[2], 0.85, 0.85, 0.85, shade(c, -0.25), { jitter: 0.02 });
      const [sx, sy] = project(p);
      bulbs.push({ x: sx, y: sy, c, k });
    });
    star3d(m, cx, cy, 24, 2.3, '#ffd84d');
    m.draw(ctx);
    present(ctx, 0, 11, 5, 5, '#3aa7e0', '#f2d13d', hash('pp', tx, ty));
    present(ctx, 11, 12, 5, 4, '#e8534a', '#f4f6fa', hash('pq', tx, ty));
    return { bulbs, star: project([cx, cy, 24]) };
  });
  stamp(v, b, v.px(tx), v.py(ty));
  inArt(v, v.px(tx), v.py(ty), (ctx) => {
    ctx.globalCompositeOperation = 'lighter';
    for (const { x, y, c, k } of b.data.bulbs) {
      const on = Math.floor(t / (350 + (k % 300))) % 2 === 0 || k % 3 === 0;
      if (on) glow(ctx, x, y, 2.4, c, 0.55);
    }
    glow(ctx, b.data.star[0], b.data.star[1], 4, '#ffe066', 0.45);
    ctx.globalCompositeOperation = 'source-over';
    for (const { x, y, c, k } of b.data.bulbs) {
      const on = Math.floor(t / (350 + (k % 300))) % 2 === 0 || k % 3 === 0;
      if (on) diamond(ctx, x - 0.15, y - 0.15, 0.4, 0.5, shade(c, 0.35));
    }
  });
}

/** Block letters as strokes in a 3 x 5 box (y down): [x0, y0, x1, y1] centre lines, 0.9 thick. */
const LETTERS: Array<Array<[number, number, number, number]>> = [
  [[0.45, 4.55, 0.45, 0.45], [2.55, 4.55, 2.55, 0.45], [0.55, 0.5, 1.5, 2.5], [2.45, 0.5, 1.5, 2.5]], // M
  [[0.45, 0.45, 0.45, 4.55], [0.45, 0.45, 2.55, 0.45], [0.45, 2.5, 2.1, 2.5], [0.45, 4.55, 2.55, 4.55]], // E
  [[0.45, 0.45, 0.45, 4.55], [2.55, 0.45, 2.55, 4.55], [0.45, 2.5, 2.55, 2.5]], // H
  [[0.45, 0.45, 2.55, 0.45], [1.5, 0.45, 1.5, 4.55]], // T
  [[0.45, 0.45, 0.45, 4.55], [0.45, 4.55, 2.55, 4.55]], // L
  [[0.5, 4.55, 1.5, 0.45], [2.5, 4.55, 1.5, 0.45], [1.05, 3.2, 1.95, 3.2]], // A
];

/** A chocolate letter standing on the left of a desk top (z = 5), with a peeled corner of gold foil. */
function chocolateLetter(v: DecorView, tx: number, ty: number) {
  const glyph = LETTERS[hash('glyph', tx, ty) % LETTERS.length];
  const b = bake(`letter:${tx},${ty}`, v.s, [-0.5, -1.5, 7, 10], (ctx) => {
    const z = 5;
    const ly = 11.4; // letter's front face
    const dep = 0.9;
    softShadow(ctx, 3.4, ly - dep / 2 - z + 0.6, 2.6, 0.7, 0.35);
    const m = new Mesh(hash('choc', tx, ty));
    const ox = 1.2;
    for (const [x0, y0, x1, y1] of glyph) {
      const ax = ox + x0;
      const az = z + 5 - y0;
      const bx = ox + x1;
      const bz = z + 5 - y1;
      const len = Math.hypot(bx - ax, bz - az);
      const th = 0.9;
      m.push().translate((ax + bx) / 2, ly - dep / 2, (az + bz) / 2).rotateY(Math.atan2(-(bz - az), bx - ax));
      m.box(-len / 2 - th / 2, -dep / 2, -th / 2, len + th, dep, th, '#6a3c24', { jitter: 0.02 });
      m.pop();
    }
    // gold foil peeled back from the base
    m.face([[ox + 2.2, ly + 0.05, z], [ox + 3.6, ly + 0.05, z], [ox + 3.5, ly + 0.4, z + 1.6]], '#f2cd5a', { strength: 0.6 });
    m.face([[ox + 2.2, ly + 0.05, z], [ox + 3.5, ly + 0.4, z + 1.6], [ox + 2.5, ly + 0.5, z + 1]], '#b8892a', { strength: 0.6 });
    m.draw(ctx);
  });
  stamp(v, b, v.px(tx), v.py(ty));
}

/** Pepernoten: little domed cookies scattered over a table top (z = 5). */
function pepernoten(v: DecorView, tx: number, ty: number) {
  const b = bake(`pn:${tx},${ty}`, v.s, [-1, 0, 18, 12], (ctx) => {
    const m = new Mesh(hash('pn', tx, ty));
    const z = 5;
    for (let i = 0; i < 6; i++) {
      const k = hash('pn', tx, ty, i);
      const x = 1.7 + (k % 13);
      const y = 8.6 + ((k >> 4) % 6);
      const c = i % 2 ? '#8a5a30' : '#a06a3a';
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.beginPath();
      ctx.ellipse(x + 0.25, y - z + 0.25, 1, 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
      m.cylinder(x, y, z, 0.85, 0.45, 0.5, 6, c, { ry: 0.85, rot: k % 3, topColor: shade(c, 0.08) });
    }
    m.draw(ctx);
  });
  stamp(v, b, v.px(tx), v.py(ty));
}

/** A shoe by the window with a carrot for the Sint's horse. */
function shoe(v: DecorView, tx: number, ty: number) {
  const b = bake(`shoe:${tx},${ty}`, v.s, [1, 0, 15, 16], (ctx) => {
    softShadow(ctx, 8.4, 13.6, 5.2, 1.2, 0.4);
    const m = new Mesh(hash('shoe', tx, ty));
    const leather = '#3b2416';
    const y0 = 11.2;
    const d = 2.6;
    m.box(3.8, y0 - 0.1, 0, 8.6, d + 0.2, 0.7, '#1f130b', { chamfer: 0.6 }); // sole
    m.box(4.1, y0, 0.7, 4.8, d, 1.6, leather, { chamfer: 1, bevel: 0.7 }); // toe
    m.box(8.5, y0, 0.7, 3.7, d, 3.4, leather, { chamfer: 0.6, bevel: 0.45 }); // heel
    m.face([[9.1, y0 + 0.5, 4.12], [11.6, y0 + 0.5, 4.12], [11.6, y0 + d - 0.5, 4.12], [9.1, y0 + d - 0.5, 4.12]], '#140c06', { jitter: 0 });
    // carrot, tip tucked into the shoe
    m.push().translate(10, y0 + d / 2, 8.6).rotateY(-0.32).rotateX(Math.PI);
    m.cylinder(0, 0, 0, 0.95, 0, 4.6, 6, '#f08a2a');
    m.pop();
    m.push().translate(8.75, y0 + d / 2, 8.75);
    for (const [ay, ax, c] of [[-0.6, 0.1, '#5cbf5f'], [0.1, -0.2, '#4caf50'], [0.7, 0.2, '#3a8f3e']] as Array<[number, number, string]>) {
      m.push().rotateY(ay).rotateX(ax);
      m.cylinder(0, 0, 0, 0.35, 0, 2.4, 4, c);
      m.pop();
    }
    m.pop();
    m.draw(ctx);
  });
  stamp(v, b, v.px(tx), v.py(ty));
}

/** A wrapped present at absolute map-pixel coordinates. */
function giftBox(v: DecorView, g: Gift) {
  const b = bake(`gift:${g.x},${g.y},${g.w},${g.h},${g.color}`, v.s, [g.x - 2, g.y - 3, g.w + 5, g.h + 5], (ctx) =>
    present(ctx, g.x, g.y, g.w, g.h, g.color, g.ribbon, hash('gift', g.x, g.y)),
  );
  stamp(v, b, v.px(0), v.py(0));
}

const BIG_TIERS: Tier[] = [
  [6, 22, 24],
  [19, 20, 19],
  [31, 17, 14],
  [42, 15, 9],
  [52, 14, 5],
];

/** The big decorated tree; (cx, base) in map pixels, base = front of the stand on the floor. */
function bigChristmasTree(v: DecorView, cx: number, base: number, t: number) {
  const b = bake(`bigtree:${cx},${base}`, v.s, [cx - 34, base - 84, 64, 96], (ctx) => {
    const cy = base - 5;
    const ry = 0.6;
    softShadow(ctx, cx + 2, base - 1, 26, 5, 0.4);
    const m = new Mesh(hash('bigtree', cx));
    m.cylinder(cx, cy, 0, 7.5, 6.6, 3, 8, '#8a3a2a', { ry, topColor: shade('#8a3a2a', 0.1) });
    m.cylinder(cx, cy, 3, 3, 2.6, 6, 6, '#6b4226', { ry });
    firTiers(m, cx, cy, ry, BIG_TIERS, '#2f7a3a', (i) => [10, 9, 8, 7, 6][i]);
    BIG_TIERS.slice(0, 4).forEach((tier, i) => garland(m, cx, cy, ry, tier, 0.4, 15 - i * 2, 0.6));
    const bulbs: Bulb[] = [];
    for (let i = 0; i < 34; i++) {
      const k = hash('big', i);
      const tier = BIG_TIERS[k % 4];
      const f = 0.12 + (((k >> 4) % 70) / 100) * 0.85;
      const a = Math.PI * (0.12 + 0.76 * (((k >> 8) % 100) / 100));
      const c = ['#ff4d4d', '#ffd84d', '#4dc3ff', '#ff7ae0', '#f4f6fa', '#9b5de5'][k % 6];
      if (i % 3 === 0) {
        const p = onCone(cx, cy, ry, tier, a, f, 1.2);
        m.ball(p[0], p[1], p[2], 1.6, 1.6, 1.6, c, { detail: 1, jitter: 0.02 }); // bauble
        continue;
      }
      const p = onCone(cx, cy, ry, tier, a, f, 0.6);
      m.ball(p[0], p[1], p[2], 0.7, 0.7, 0.9, '#1d3b2a', { jitter: 0 }); // bulb (lit live)
      const [sx, sy] = project(p);
      bulbs.push({ x: sx, y: sy, c, k });
    }
    star3d(m, cx, cy, 70, 4.6, '#ffd84d');
    m.draw(ctx);
    return { bulbs, star: project([cx, cy, 70]) };
  });
  stamp(v, b, v.px(0), v.py(0));
  inArt(v, v.px(0), v.py(0), (ctx) => {
    const lit = b.data.bulbs.filter(({ k }) => Math.floor(t / (300 + (k % 400)) + (k % 7)) % 3 !== 0);
    ctx.globalCompositeOperation = 'lighter';
    for (const { x, y, c } of lit) glow(ctx, x, y, 3, c, 0.6);
    const pulse = 0.6 + 0.4 * Math.sin(t / 400);
    glow(ctx, b.data.star[0], b.data.star[1], 11, '#ffe066', 0.7 * pulse);
    ctx.globalCompositeOperation = 'source-over';
    for (const { x, y, c } of lit) diamond(ctx, x, y, 0.65, 0.9, c);
  });
}

// ---------- Santa hat ----------

const hats = new Map<string, HTMLCanvasElement>();
/** Hat bounds in sprite units (16-unit box). */
const HAT_BOX: Box = [0, -8, 16, 12];

function buildHat(flip: boolean): Mesh {
  const m = new Mesh(flip ? 7 : 6);
  if (flip) m.translate(16, 0, 0).scale(-1, 1, 1);
  const red = '#d42a2a';
  // A sprite has no depth: the hat lives in the y = 0 plane, so screen y = -z.
  m.push().translate(8.6, 0, -0.7).rotateY(0.45);
  m.cylinder(0, 0, 0, 3.9, 2.3, 3.6, 8, red, { ry: 0.42 });
  m.pop();
  m.ball(10.17, 0, 2.53, 2.25, 0.95, 2.25, red);
  m.push().translate(10.17, 0, 2.53).rotateY(1.05);
  m.cylinder(0, 0, 0, 2.3, 0, 3.5, 7, shade(red, -0.05), { ry: 0.42 });
  m.pop();
  // fluffy fur brim and pompom always in front of the red cloth
  m.ball(8.6, 0, -1, 5, 1.6, 0.8, '#f4f6fa', { detail: 1, rough: 0.12, layer: 1 });
  m.ball(13.25, 0, 4.6, 1.4, 1.4, 1.4, '#ffffff', { detail: 1, rough: 0.1, layer: 1 });
  return m;
}

/** A Santa hat on a sprite whose box is (x, y, size), in device pixels. Mirrored when `flip`. */
export function santaHat(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, flip = false) {
  const u = size / 16;
  const key = `${Math.round(size * 2)}:${flip ? 1 : 0}`;
  let c = hats.get(key);
  const [bx, by, bw, bh] = HAT_BOX;
  if (!c) {
    if (hats.size > 48) hats.clear();
    c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(bw * u));
    c.height = Math.max(1, Math.ceil(bh * u));
    const g = c.getContext('2d')!;
    g.scale(c.width / bw, c.height / bh);
    g.translate(-bx, -by);
    buildHat(flip).draw(g);
    hats.set(key, c);
  }
  // the hat box is built around a head at (8, 4.4); heads lean left with the camera skew
  ctx.drawImage(c, x + (bx + HEAD_DX) * u, y + by * u, bw * u, bh * u);
}

// ---------- wall-attached decor (follows the wall caps in tiles.ts) ----------

/** Origin at the top-left of tile (tx, ty). */
const inTile = (v: DecorView, tx: number, ty: number, draw: (ctx: Ctx) => void) => inArt(v, v.px(tx), v.py(ty), draw);

/**
 * Map 2D art drawn flat on a wall's front face through the camera skew, so it leans exactly like the
 * 3D face: x shifts by SKEW·z. The art is authored as if the face were the plane y = 16 (z = 16 - screen
 * y); slim walls stand back from the tile edge, so it is moved onto the real face at y = 16 - WALL_IN.
 */
function onFace(ctx: Ctx) {
  ctx.translate(0, -WALL_IN);
  ctx.transform(1, 0, -SKEW, 1, SKEW * 16, 0);
}

function fairyLights(v: DecorView, tx: number, ty: number, t: number) {
  inTile(v, tx, ty, (ctx) => {
    onFace(ctx);
    // the wire sags between tiles; ends meet the neighbours' wires at y0
    const y0 = 16 - WALL_RISE + 2;
    const sag = 1.6;
    const wy = (x: number) => y0 + sag * (1 - ((x - 8) / 8) ** 2);
    const bulbs = [0, 1, 2, 3].map((i) => {
      const bx = 2 + i * 4;
      const k = hash(tx, ty, i);
      return { bx, by: wy(bx), c: LIGHT_COLORS[k % LIGHT_COLORS.length], on: Math.floor(t / (400 + (k % 400)) + (k % 5)) % 3 !== 0 };
    });
    for (const b of bulbs) if (b.on) glow(ctx, b.bx, b.by + 1.8, 3.6, b.c, 0.6);
    ctx.strokeStyle = '#1d3b2a';
    ctx.lineWidth = 0.4;
    ctx.beginPath();
    ctx.moveTo(0, y0);
    ctx.quadraticCurveTo(8, y0 + sag * 2, 16, y0);
    ctx.stroke();
    for (const b of bulbs) {
      poly(ctx, [[b.bx - 0.4, b.by - 0.1], [b.bx + 0.4, b.by - 0.1], [b.bx + 0.45, b.by + 0.5], [b.bx - 0.45, b.by + 0.5]], '#2a3a30');
      diamond(ctx, b.bx, b.by + 1.6, 0.8, 1.15, b.on ? b.c : shade(b.c, -0.62));
    }
  });
}

function bunting(v: DecorView, tx: number, ty: number) {
  inTile(v, tx, ty, (ctx) => {
    onFace(ctx);
    const y0 = 16 - CAP_ZS + 0.4; // just under the cap's front rim
    const sag = 1.2;
    const wy = (x: number) => y0 + sag * (1 - ((x - 8) / 8) ** 2);
    ctx.strokeStyle = '#d9d9d9';
    ctx.lineWidth = 0.4;
    ctx.beginPath();
    ctx.moveTo(0, y0);
    ctx.quadraticCurveTo(8, y0 + sag * 2, 16, y0);
    ctx.stroke();
    const colors = ['#d42a2a', '#f4f6fa', '#e5b83b'];
    for (let i = 0; i < 4; i++) {
      const x0 = i * 4 + 0.3;
      const x1 = i * 4 + 3.7;
      const xm = i * 4 + 2;
      const c = colors[(tx * 4 + i) % 3];
      const tip: Pt = [xm + 0.15, wy(xm) + 3.6];
      poly(ctx, [[x0, wy(x0)], [xm, wy(xm)], tip], shade(c, 0.12));
      poly(ctx, [[xm, wy(xm)], [x1, wy(x1)], tip], shade(c, -0.2));
    }
  });
}

/** Height where the slim walls' vertical faces end (bunting hangs just under it). */
const CAP_ZS = WALL_RISE - 1.7;
