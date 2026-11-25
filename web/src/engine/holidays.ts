// Seasonal themes. Everything here is visual only.
//
//   Sinterklaas  15 Nov – 5 Dec   bunting, shoes with carrots, chocolate letters, pepernoten, snow, a visit from the Sint
//   Christmas     6 Dec – 6 Jan   fairy lights, Christmas trees (the plants), Santa hats, snow
//
// Preview with ?holiday=sinterklaas|christmas|none or ?date=2026-12-20.
import { hash, type OfficeMap, type Tile } from './map';
import { WALL_RISE } from './tiles';

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

interface WallTile {
  x: number;
  face: boolean;
  window: boolean;
  /** part of a horizontal wall (walls left/right) rather than a vertical one */
  horizontal: boolean;
}

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
  private walls = new Map<number, WallTile[]>();
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
        if (isWallish(c)) {
          const face = y < map.h - 1 && !isWallish(map.at(x, y + 1));
          const horizontal = isWallish(map.at(x - 1, y)) || isWallish(map.at(x + 1, y));
          this.walls.set(y, [...(this.walls.get(y) ?? []), { x, face, window: c === 'V', horizontal }]);
          if (face) add(this.faces, x, y);
        }
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
    for (const w of this.walls.get(row) ?? []) wallSnow(v, w, row);
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
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    for (const f of this.flakes) {
      const y = ((t / 1000) * f.speed + f.phase) % 1;
      const x = (f.x + Math.sin(t / 1400 + f.phase * 10) * 0.01 * f.drift) % 1;
      const sz = f.size * v.dpr;
      ctx.globalAlpha = 0.35 + 0.15 * f.size;
      ctx.fillRect(x * v.width, y * v.height, sz, sz);
    }
    ctx.globalAlpha = 1;
  }
}

/** A Santa hat on a sprite whose box is (x, y, size). */
export function santaHat(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, flip = false) {
  const u = size / 16;
  const X = (px: number) => (flip ? x + (16 - px) * u : x + px * u);
  const rect = (px: number, py: number, w: number, h: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(flip ? X(px + w) : X(px), y + py * u, w * u, h * u);
  };
  rect(5, -1, 7, 2, '#d42a2a');
  rect(6, -2, 5, 1, '#d42a2a');
  rect(8, -3, 4, 1, '#b81f1f');
  rect(10, -4, 2, 1, '#b81f1f');
  rect(11, -5, 2, 2, '#ffffff'); // pompom
  rect(4, 1, 9, 1.6, '#f4f6fa'); // fur trim
}

// ---------- decoration pieces (coordinates in map pixels relative to the tile) ----------

function at(v: DecorView, tx: number, ty: number) {
  const { ctx, s } = v;
  const ox = v.px(tx);
  const oy = v.py(ty);
  return (x: number, y: number, w: number, h: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(ox + x * s, oy + y * s, w * s, h * s);
  };
}

function fairyLights(v: DecorView, tx: number, ty: number, t: number) {
  const r = at(v, tx, ty);
  const faceTop = 16 - WALL_RISE;
  const wireY = faceTop + 2 + (tx % 2);
  r(0, wireY, 16, 0.5, '#1a3a24');
  const colors = ['#ff4d4d', '#ffd84d', '#4dff88', '#4dc3ff', '#ff7ae0'];
  for (let i = 0; i < 4; i++) {
    const bx = 2 + i * 4;
    const k = hash(tx, ty, i);
    const on = Math.floor(t / (400 + (k % 400)) + (k % 5)) % 3 !== 0;
    const c = colors[k % colors.length];
    r(bx, wireY + 0.5, 1.5, 1.5, on ? c : '#333');
    if (on) {
      v.ctx.globalAlpha = 0.25;
      r(bx - 1, wireY - 0.5, 3.5, 3.5, c);
      v.ctx.globalAlpha = 1;
    }
  }
}

function bunting(v: DecorView, tx: number, ty: number) {
  const { ctx, s } = v;
  const ox = v.px(tx);
  const oy = v.py(ty) + (16 - WALL_RISE + 1) * s;
  ctx.fillStyle = '#d9d9d9';
  ctx.fillRect(ox, oy, 16 * s, 0.5 * s);
  const colors = ['#d42a2a', '#f4f6fa', '#e5b83b'];
  for (let i = 0; i < 4; i++) {
    const x0 = ox + i * 4 * s;
    ctx.fillStyle = colors[(tx * 4 + i) % 3];
    ctx.beginPath();
    ctx.moveTo(x0 + 0.3 * s, oy + 0.5 * s);
    ctx.lineTo(x0 + 3.7 * s, oy + 0.5 * s);
    ctx.lineTo(x0 + 2 * s, oy + 4 * s);
    ctx.closePath();
    ctx.fill();
  }
}

function christmasTree(v: DecorView, tx: number, ty: number, t: number) {
  const r = at(v, tx, ty);
  // presents
  r(0, 11, 5, 5, '#3aa7e0');
  r(2, 11, 1, 5, '#f2d13d');
  r(0, 12.5, 5, 1, '#f2d13d');
  r(11, 12, 5, 4, '#e8534a');
  r(13, 12, 1, 4, '#f4f6fa');
  // pot
  r(5, 10, 6, 6, '#8a3a2a');
  r(5, 10, 6, 1, '#b05a40');
  // layered tree
  const g = '#2f7a3a';
  const gd = '#1f5a2a';
  r(6, -11, 4, 5, g);
  r(4, -7, 8, 5, g);
  r(3, -3, 10, 6, g);
  r(2, 2, 12, 8, g);
  r(11, -7, 1, 5, gd);
  r(12, -3, 1, 6, gd);
  r(13, 2, 1, 8, gd);
  // tinsel
  r(4, -1, 9, 0.6, '#e5b83b');
  r(3, 5, 11, 0.6, '#e5b83b');
  // star
  r(7, -14, 2, 3, '#ffe066');
  r(6, -13, 4, 1, '#ffe066');
  // blinking baubles
  const spots: Array<[number, number]> = [[7, -8], [5, -4], [10, -2], [4, 2], [8, 1], [11, 4], [6, 7], [9, 8]];
  const colors = ['#ff4d4d', '#ffd84d', '#4dc3ff', '#ff7ae0', '#f4f6fa'];
  spots.forEach(([bx, by], i) => {
    const k = hash(tx, ty, i);
    const on = Math.floor(t / (350 + (k % 300))) % 2 === 0 || k % 3 === 0;
    r(bx, by, 1.5, 1.5, on ? colors[k % colors.length] : '#1f5a2a');
  });
}

function chocolateLetter(v: DecorView, tx: number, ty: number) {
  const r = at(v, tx, ty);
  // a chocolate letter on the desk top, next to the keyboard
  r(1, 4, 3, 5, '#5a3220');
  r(1, 4, 3, 1, '#7a4a30');
  r(2, 5, 1, 3, '#3e2216');
  r(3.2, 4, 0.8, 1.5, '#e5b83b'); // foil corner
}

function pepernoten(v: DecorView, tx: number, ty: number) {
  const r = at(v, tx, ty);
  for (let i = 0; i < 6; i++) {
    const k = hash('pn', tx, ty, i);
    r(1 + (k % 13), 3 + ((k >> 4) % 6), 1.4, 1.2, i % 2 ? '#8a5a30' : '#a06a3a');
  }
}

function shoe(v: DecorView, tx: number, ty: number) {
  const r = at(v, tx, ty);
  // a shoe by the window with a carrot for the horse
  r(4, 11, 8, 3, '#3b2416');
  r(9, 9, 3, 2, '#3b2416');
  r(4, 13, 8, 1, '#24160d');
  r(5, 10, 3, 2, '#2a1a10');
  // carrot
  r(6, 6, 1.5, 5, '#f08a24');
  r(7.5, 4, 1.5, 3, '#f08a24');
  r(8, 2.5, 2, 2, '#4caf50');
}

/** Snow lying on top of a wall (and a few drips over the front edge). Window glass stays clear. */
function wallSnow(v: DecorView, w: WallTile, ty: number) {
  const r = at(v, w.x, ty);
  const top = -WALL_RISE;
  const snow = '#eef4ff';
  const shadow = '#c9d6ea';
  if (w.window && w.face) {
    r(0, top, 16, 2, snow); // just the frame above the glass
    r(0, top + 2, 16, 0.6, shadow);
    return;
  }
  if (w.window && w.horizontal) {
    // glass strip lying in a horizontal wall's cap: snow on the frame above it
    r(0, top, 16, 4, snow);
    r(0, top + 4, 16, 0.6, shadow);
    return;
  }
  if (w.window) {
    // side window strip in the cap: snow on either side of the glass
    r(0, top, 4, 16, snow);
    r(12, top, 4, 16, snow);
    return;
  }
  r(0, top, 16, 16, snow);
  // soft blue shading and sparkle so it isn't a flat white block
  for (let i = 0; i < 5; i++) {
    const k = hash('sn', w.x, ty, i);
    r(k % 15, top + ((k >> 4) % 15), 1, 1, i % 2 ? shadow : '#ffffff');
  }
  if (w.face) {
    // lumpy overhang + drips over the face
    r(0, 16 - WALL_RISE - 0.5, 16, 1.2, snow);
    for (let i = 0; i < 3; i++) {
      const k = hash('drip', w.x, ty, i);
      r(1 + (k % 14), 16 - WALL_RISE + 0.5, 1, 1 + (k >> 5) % 2, snow);
    }
    r(0, 16 - WALL_RISE + 0.7, 16, 0.4, shadow);
  }
}

/** A wrapped present at absolute map-pixel coordinates. */
function giftBox(v: DecorView, g: Gift) {
  const { ctx, s } = v;
  const X = v.px(0) + g.x * s;
  const Y = v.py(0) + g.y * s;
  const rect = (x: number, y: number, w: number, h: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(X + x * s, Y + y * s, w * s, h * s);
  };
  rect(1, g.h - 0.5, g.w, 1.2, 'rgba(0,0,0,0.3)'); // shadow
  rect(0, 0, g.w, g.h, g.color);
  rect(0, 0, g.w, 1.5, 'rgba(255,255,255,0.25)'); // lid
  rect(g.w - 1, 0, 1, g.h, 'rgba(0,0,0,0.18)');
  const mid = Math.floor(g.w / 2) - 0.5;
  rect(mid, 0, 1.2, g.h, g.ribbon);
  rect(0, 1.5, g.w, 1, g.ribbon);
  rect(mid - 1.5, -1.5, 1.6, 1.6, g.ribbon); // bow
  rect(mid + 1, -1.5, 1.6, 1.6, g.ribbon);
}

/** The big decorated tree; (cx, base) in map pixels, base = bottom of the trunk. */
function bigChristmasTree(v: DecorView, cx: number, base: number, t: number) {
  const { ctx, s } = v;
  const X = (mx: number) => v.px(0) + mx * s;
  const Y = (my: number) => v.py(0) + my * s;
  const rect = (x: number, y: number, w: number, h: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(X(x), Y(y), w * s, h * s);
  };
  // shadow + trunk + stand
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(X(cx + 3), Y(base), 26 * s, 5 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  rect(cx - 3, base - 8, 6, 8, '#6b4226');
  rect(cx - 7, base - 3, 14, 3, '#8a3a2a');
  rect(cx - 7, base - 3, 14, 1, '#b05a40');
  // stacked tiers, drawn bottom to top so upper tiers overlap lower ones
  const tiers: Array<[top: number, bottom: number, half: number]> = [
    [base - 26, base - 6, 24],
    [base - 40, base - 20, 19],
    [base - 52, base - 34, 14],
    [base - 62, base - 46, 9],
    [base - 70, base - 56, 5],
  ];
  const green = '#2f7a3a';
  const dark = '#1f5a2a';
  const light = '#3f9a4a';
  for (const [top, bottom, half] of tiers) {
    for (let y = top; y < bottom; y += 2) {
      const f = (y - top) / (bottom - top);
      const w = 2 + half * 2 * f;
      rect(cx - w / 2, y, w, 2, green);
      rect(cx + w / 2 - 2, y, 2, 2, dark); // shaded right side
      if (f > 0.15) rect(cx - w / 2, y, 1.5, 2, light);
    }
    rect(cx - half, bottom - 2, half * 2, 2, dark); // tier hem
  }
  // garlands: gold swoops across each tier
  ctx.strokeStyle = '#e5b83b';
  ctx.lineWidth = Math.max(1, s * 0.8);
  for (const [top, bottom, half] of tiers.slice(0, 4)) {
    const y = bottom - (bottom - top) * 0.35;
    ctx.beginPath();
    ctx.moveTo(X(cx - half * 0.75), Y(y - 3));
    ctx.quadraticCurveTo(X(cx), Y(y + 3), X(cx + half * 0.75), Y(y - 3));
    ctx.stroke();
  }
  // baubles and twinkling lights
  const colors = ['#ff4d4d', '#ffd84d', '#4dc3ff', '#ff7ae0', '#f4f6fa', '#9b5de5'];
  for (let i = 0; i < 34; i++) {
    const k = hash('big', i);
    const tier = tiers[k % 4];
    const [top, bottom, half] = tier;
    const fy = 0.25 + ((k >> 4) % 70) / 100;
    const y = top + (bottom - top) * fy;
    const x = cx + (((k >> 8) % 100) / 100 - 0.5) * half * 2 * fy * 0.9;
    const bauble = i % 3 === 0;
    const on = bauble || Math.floor(t / (300 + (k % 400)) + (k % 7)) % 3 !== 0;
    const c = colors[k % colors.length];
    rect(x - (bauble ? 1.5 : 0.75), y, bauble ? 3 : 1.5, bauble ? 3 : 1.5, on ? c : dark);
    if (bauble) rect(x - 1, y + 0.5, 0.8, 0.8, 'rgba(255,255,255,0.7)');
    else if (on) {
      ctx.globalAlpha = 0.3;
      rect(x - 1.5, y - 0.75, 3, 3, c);
      ctx.globalAlpha = 1;
    }
  }
  // glowing star
  const pulse = 0.6 + 0.4 * Math.sin(t / 400);
  const g = ctx.createRadialGradient(X(cx), Y(base - 72), 0, X(cx), Y(base - 72), 10 * s);
  g.addColorStop(0, `rgba(255,230,120,${0.55 * pulse})`);
  g.addColorStop(1, 'rgba(255,230,120,0)');
  ctx.fillStyle = g;
  ctx.fillRect(X(cx - 10), Y(base - 82), 20 * s, 20 * s);
  rect(cx - 1, base - 78, 2, 8, '#ffe066');
  rect(cx - 4, base - 75, 8, 2, '#ffe066');
  rect(cx - 2.5, base - 76.5, 5, 5, '#ffe066');
  rect(cx - 0.5, base - 75, 1, 1, '#fff8d0');
}
