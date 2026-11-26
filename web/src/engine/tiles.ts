// Static office art, built as real low-poly 3D geometry (see mesh.ts) and baked once.
//
// Two layers:
//   floor   – one canvas: floors (low-relief panels, planks, carpets, grates), door thresholds,
//             drop shadows and wall ambient occlusion.
//   strips  – one canvas per tile row holding everything that stands up (walls, furniture).
//             Objects extend upward past their tile, so the renderer draws strips row by row,
//             interleaved with characters, to get correct occlusion (walk behind a desk, etc.).
//
// Walls are slim solids: a band 16 - 2·WALL_IN thick down the middle of their tile, with arms out to
// neighbouring walls and doors, so runs join into one continuous wall and junctions become L/T/plus
// shapes. Their tops are rounded off by two bevel steps on every exposed edge; the camera's skew shows
// the right-hand side of every wall. The floor of the neighbouring room runs on under the gap.
import type { RoomId } from '../../../shared/rooms.config';
import { hash, type OfficeMap } from './map';
import { drawFurniture } from './furniture';
import { ART_RES, poly, shade, softShadow, type Pt } from './lowpoly';
import { Mesh, SKEW, VIEW, project, type P2, type V3 } from './mesh';

export { shade };

type Ctx = CanvasRenderingContext2D;

/** How far (px) the tallest object rises above its own tile. */
export const MAX_RISE = 16;
/** Wall height above the tile: the wall cap is drawn this many px higher than its tile. */
export const WALL_RISE = 12;

// A worn, lived-in station: muted metals, sand and rust tones.
const FLOORS: Record<RoomId | 'hall', string> = {
  library: '#4a3d30',
  research: '#33444a',
  serverRoom: '#2a313c',
  mailroom: '#4a4436',
  reception: '#352f3c',
  openOffice: '#4c4e56',
  workshop: '#323845',
  whiteboard: '#403c47',
  meeting: '#2e3440',
  lounge: '#55372f',
  dorm: '#2e3447',
  hall: '#4a4843',
};

const BULKHEAD = '#3d3f46';
const CAP = '#2a2c33';
const HULL = '#272930';
const FRAME = '#6c7488';
const JAMB = '#56534c';
const AMBER = '#ffb35a';
const TEAL = '#5fd4e0';
const HAZARD = '#d9a53a';
const SPACE = '#0b1026';

/** Wall solid dimensions (art units). */
const H = WALL_RISE;

/** Extra room on the left of each strip: in plan space, height leans objects left by up to MAX_RISE. */
export const STRIP_PAD = MAX_RISE;

/**
 * Both layers are in PLAN space (mesh.ts): draw them through the isometric transform (ISO_MATRIX).
 *   floor      covers plan (0, 0) .. (w*T, h*T); draw it at plan (0, 0).
 *   strips[y]  covers plan (-STRIP_PAD, y*T - MAX_RISE) .. (w*T, (y+1)*T); draw it at that top-left.
 * Draw the strips in row order, each row's characters right after it, for correct occlusion.
 */
export interface MapLayers {
  floor: HTMLCanvasElement;
  strips: HTMLCanvasElement[];
}

/** Tiles that are built as wall solids. The secret door is a wall panel people walk through. */
const isSolid = (c: string) => c === '#' || c === 'V' || c === 'X';
const isDoor = (c: string) => c === 'D' || c === 'E';
const isObject = (c: string) => !'.DE'.includes(c);

export function renderLayers(map: OfficeMap): MapLayers {
  const T = map.tileSize;
  // Baked at ART_RES device px per art unit; all drawing code below works in art units.
  const floor = document.createElement('canvas');
  floor.width = map.w * T * ART_RES;
  floor.height = map.h * T * ART_RES;
  const fctx = floor.getContext('2d')!;
  fctx.scale(ART_RES, ART_RES);

  // 1) floors: room by room, as continuous low-relief geometry
  drawFloors(fctx, map);
  // 2) shadows / ambient occlusion on top of the floor
  for (let y = 0; y < map.h; y++)
    for (let x = 0; x < map.w; x++) {
      fctx.save();
      fctx.translate(x * T, y * T);
      drawFloorShading(fctx, map, x, y);
      fctx.restore();
    }

  // 3) standing objects, one strip per row
  const strips: HTMLCanvasElement[] = [];
  for (let y = 0; y < map.h; y++) {
    const strip = document.createElement('canvas');
    strip.width = (STRIP_PAD + map.w * T) * ART_RES;
    strip.height = (T + MAX_RISE) * ART_RES;
    const sctx = strip.getContext('2d')!;
    sctx.scale(ART_RES, ART_RES);
    for (let x = 0; x < map.w; x++) {
      const c = map.at(x, y);
      if (!isObject(c)) continue;
      sctx.save();
      // (0,0) = tile top-left in plan space; tall things lean up and to the left (by z) in plan space
      sctx.translate(STRIP_PAD + x * T, MAX_RISE);
      if (isSolid(c)) drawWall(sctx, map, x, y);
      else drawFurniture(sctx, c, x, y, map);
      sctx.restore();
    }
    strips.push(strip);
  }
  return { floor, strips };
}

/**
 * Where a viewport's glass shows on screen, relative to its tile's top-left (art units), for overlays
 * like the star-streak jump. Matches the geometry drawn by drawWall.
 */
export function windowGlass(map: OfficeMap, x: number, y: number): { gx: number; gy: number; gw: number; gh: number } {
  const g = glassOf(map, x, y);
  if (!g) return { gx: 0, gy: 0, gw: 0, gh: 0 };
  const corners: V3[] =
    g.kind === 'front'
      ? [[g.x0, g.y, g.z0], [g.x1, g.y, g.z0], [g.x0, g.y, g.z1], [g.x1, g.y, g.z1]]
      : [[g.x, g.y0, g.z0], [g.x, g.y1, g.z0], [g.x, g.y0, g.z1], [g.x, g.y1, g.z1]];
  const ps = corners.map(project);
  const xs = ps.map((p) => p[0]);
  const ys = ps.map((p) => p[1]);
  const gx = Math.min(...xs);
  const gy = Math.min(...ys);
  return { gx, gy, gw: Math.max(...xs) - gx, gh: Math.max(...ys) - gy };
}

// ---------------- 2D helpers (glows, stars) ----------------

function r(ctx: Ctx, x: number, y: number, w: number, h: number, c: string) {
  ctx.fillStyle = c;
  ctx.fillRect(x, y, w, h);
}

function clipRect(ctx: Ctx, x: number, y: number, w: number, h: number) {
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
}

/** A soft round glow (for lamps and indicator lights). */
function glow(ctx: Ctx, cx: number, cy: number, rad: number, rgb: string, a = 0.45) {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
  g.addColorStop(0, `rgba(${rgb},${a})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
}

/** An irregular, soft-edged stain polygon (grime, oil, scuffs). */
function stain(ctx: Ctx, seed: number, cx: number, cy: number, rad: number, fill: string) {
  const pts: Pt[] = [];
  const n = 6;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (seed % 5) * 0.3;
    const j = 0.65 + ((hash(seed, i) % 100) / 100) * 0.5;
    pts.push([cx + Math.cos(a) * rad * j, cy + Math.sin(a) * rad * j * 0.7]);
  }
  poly(ctx, pts, fill);
}

/** Deep space inside a glass rect: faceted night sky, a faint nebula, diamond stars, maybe a planet. */
function stars(ctx: Ctx, seed: number, x: number, y: number, w: number, h: number) {
  ctx.save();
  clipRect(ctx, x, y, w, h);
  r(ctx, x, y, w, h, SPACE);
  // low-poly sky: two big facets
  poly(ctx, [[x, y], [x + w, y], [x + w * ((seed % 5) / 8 + 0.2), y + h]], '#0e1430');
  poly(ctx, [[x + w, y + h * 0.3], [x + w, y + h], [x + w * 0.4, y + h]], '#0a0e22');
  if (seed % 3 === 0) {
    const nx = x + (seed % Math.max(1, Math.floor(w)));
    const ny = y + ((seed >> 5) % Math.max(1, Math.floor(h)));
    poly(ctx, [[nx - 4, ny], [nx, ny - 2.5], [nx + 5, ny - 1], [nx + 2, ny + 2.5], [nx - 3, ny + 2]], seed % 2 ? 'rgba(95,212,224,0.1)' : 'rgba(176,124,255,0.12)');
  }
  const count = Math.max(3, Math.round((w * h) / 22));
  for (let i = 0; i < count; i++) {
    const s = hash(seed, i);
    const sx = x + 0.6 + ((s % 1000) / 1000) * (w - 1.2);
    const sy = y + 0.6 + (((s >> 10) % 1000) / 1000) * (h - 1.2);
    const sr = i === 0 ? 0.8 : 0.32 + ((s >> 20) % 3) * 0.12;
    poly(ctx, [[sx, sy - sr], [sx + sr * 0.6, sy], [sx, sy + sr], [sx - sr * 0.6, sy]], i === 0 ? '#ffe9a8' : '#cfd8ff');
  }
  if (seed % 7 === 0 && w > 6 && h > 6) {
    // a small rust planet, lit from the top-left
    const cx = x + 4;
    const cy = y + 3.5;
    const pts: Pt[] = [];
    for (let i = 0; i < 8; i++) pts.push([cx + Math.cos((i / 8) * Math.PI * 2) * 2, cy + Math.sin((i / 8) * Math.PI * 2) * 2]);
    poly(ctx, pts, '#8a4f2a');
    poly(ctx, [pts[4], pts[5], pts[6], pts[7], [cx + 0.3, cy + 0.3]], '#c0763c');
    poly(ctx, [pts[0], pts[1], pts[2], [cx + 0.5, cy + 0.5]], '#5e3520');
  }
  // glass glint: one diagonal facet
  const gx = x + w * 0.2;
  poly(ctx, [[gx, y], [gx + 2.2, y], [gx - h * 0.35 + 2.2, y + h], [gx - h * 0.35, y + h]], 'rgba(255,255,255,0.05)');
  ctx.restore();
}

// ---------------- 3D building blocks ----------------

/** Chamfered rectangle outline (c = 0 gives the plain rectangle). */
function octo(x0: number, y0: number, x1: number, y1: number, c: number): P2[] {
  if (c <= 0.001) return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  return [[x0 + c, y0], [x1 - c, y0], [x1, y0 + c], [x1, y1 - c], [x1 - c, y1], [x0 + c, y1], [x0, y1 - c], [x0, y0 + c]];
}

/** Pseudo-random in [-1, 1] from any key. */
function rnd(...k: Array<string | number>) {
  return ((hash(...k) % 10007) / 10007) * 2 - 1;
}

/**
 * A low-relief floor plate: sloped bevel facets from the outline (z0) up to an inset top (z0 + h), and
 * the top triangulated as a fan around a slightly raised, off-centre hub, so it reads as facets.
 */
function facetPlate(
  m: Mesh,
  outer: P2[],
  inner: P2[],
  col: string,
  o: { z0?: number; h?: number; dome?: number; seed?: number; layer?: number; jitter?: number } = {},
) {
  const z0 = o.z0 ?? 0;
  const zt = z0 + (o.h ?? 0.35);
  let cx = 0;
  let cy = 0;
  for (const [x, y] of inner) {
    cx += x / inner.length;
    cy += y / inner.length;
  }
  let minX = Infinity;
  let maxX = -Infinity;
  for (const [x] of inner) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
  }
  const s = o.seed ?? 0;
  const span = (maxX - minX) * 0.12;
  const hub: V3 = [cx + rnd(s, 'hx') * span, cy + rnd(s, 'hy') * span * 0.7, zt + (o.dome ?? 0.12)];
  const polys: V3[][] = [];
  const n = outer.length;
  for (let i = 0; i < n; i++) {
    const a = outer[i];
    const b = outer[(i + 1) % n];
    const ia = inner[i];
    const ib = inner[(i + 1) % n];
    polys.push([[a[0], a[1], z0], [b[0], b[1], z0], [ib[0], ib[1], zt], [ia[0], ia[1], zt]]);
    if (Math.hypot(ib[0] - ia[0], ib[1] - ia[1]) > 0.01) polys.push([[ia[0], ia[1], zt], [ib[0], ib[1], zt], hub]);
  }
  m.solid(polys, col, { jitter: o.jitter ?? 0.022, layer: o.layer });
}

/** A rectangular plate with chamfered corners. */
function plate(
  m: Mesh,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  col: string,
  o: { z0?: number; h?: number; b?: number; c?: number; dome?: number; seed?: number; layer?: number; jitter?: number } = {},
) {
  const b = o.b ?? 0.8;
  const c = Math.min(o.c ?? 1.2, (x1 - x0) / 3, (y1 - y0) / 3);
  const ci = Math.max(0, c - b * 0.414);
  facetPlate(m, octo(x0, y0, x1, y1, c), octo(x0 + b, y0 + b, x1 - b, y1 - b, ci), col, o);
}

/** A flat-topped hexagonal plate. */
function hexPlate(m: Mesh, cx: number, cy: number, rad: number, col: string, o: { h?: number; b?: number; dome?: number; seed?: number } = {}) {
  const b = o.b ?? 0.9;
  const ring = (rr: number): P2[] => Array.from({ length: 6 }, (_, i) => [cx + Math.cos((i * Math.PI) / 3) * rr, cy + Math.sin((i * Math.PI) / 3) * rr] as P2);
  facetPlate(m, ring(rad), ring(rad - b * 1.155), col, o);
}

/**
 * A long wood plank: bevelled on all sides, its top a strip of triangles with gently varying heights
 * (a little warp and wear), so it catches the light in facets instead of as one flat slab.
 */
function plank(m: Mesh, x0: number, x1: number, y0: number, y1: number, col: string, key: string) {
  const b = 0.45;
  const h = 0.25;
  const segs = Math.max(2, Math.round((x1 - x0) / 9));
  const ox: number[] = [];
  const ix: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    let px = x0 + (x1 - x0) * t;
    if (i > 0 && i < segs) px += rnd(key, i, 'x') * 1.5;
    ox.push(px);
    ix.push(Math.max(x0 + b, Math.min(x1 - b, px)));
  }
  // a gentle warp along the plank: each segment tilts a little, but stays planar (calm facets)
  const zb = (i: number) => h + rnd(key, i) * 0.08;
  const zf = zb;
  const polys: V3[][] = [];
  for (let i = 0; i < segs; i++) {
    const A: V3 = [ix[i], y0 + b, zb(i)];
    const B: V3 = [ix[i + 1], y0 + b, zb(i + 1)];
    const C: V3 = [ix[i + 1], y1 - b, zf(i + 1)];
    const D: V3 = [ix[i], y1 - b, zf(i)];
    polys.push([A, B, C, D]);
    polys.push([[ox[i], y0, 0], [ox[i + 1], y0, 0], B, A]);
    polys.push([[ox[i], y1, 0], [ox[i + 1], y1, 0], C, D]);
  }
  polys.push([[x0, y0, 0], [x0, y1, 0], [ix[0], y1 - b, zf(0)], [ix[0], y0 + b, zb(0)]]);
  polys.push([[x1, y0, 0], [x1, y1, 0], [ix[segs], y1 - b, zf(segs)], [ix[segs], y0 + b, zb(segs)]]);
  // the warped top is not convex, so emit plain faces (each one is lit by the side facing the camera)
  for (const p of polys) m.face(p, col, { jitter: 0.02 });
}

/**
 * A recess cut into a front (y = 16) face: opening xa..xb, za..zb; the back plane sits `d` deep and
 * each side slopes in by `e` (> d, so every slope faces the camera). Sides with l / r = false are left
 * open so a recess can continue seamlessly into the neighbouring tile.
 */
function frontRecess(
  m: Mesh,
  xa: number,
  xb: number,
  za: number,
  zb: number,
  d: number,
  e: number,
  back: string,
  rim: string,
  o: { l?: boolean; r?: boolean; layer?: number; emissive?: boolean; y?: number } = {},
) {
  const l = o.l ?? true;
  const rr = o.r ?? true;
  const Y = o.y ?? 16;
  const Yb = Y - d;
  const ixa = l ? xa + e : xa;
  const ixb = rr ? xb - e : xb;
  const iza = za + e;
  const izb = zb - e;
  const fo = { layer: o.layer ?? 1, jitter: 0 };
  m.face([[ixa, Yb, iza], [ixb, Yb, iza], [ixb, Yb, izb], [ixa, Yb, izb]], back, { ...fo, emissive: o.emissive });
  m.face([[xa, Y, za], [xb, Y, za], [ixb, Yb, iza], [ixa, Yb, iza]], rim, fo);
  m.face([[xa, Y, zb], [xb, Y, zb], [ixb, Yb, izb], [ixa, Yb, izb]], rim, fo);
  if (l) m.face([[xa, Y, za], [xa, Y, zb], [ixa, Yb, izb], [ixa, Yb, iza]], rim, fo);
  if (rr) m.face([[xb, Y, za], [xb, Y, zb], [ixb, Yb, izb], [ixb, Yb, iza]], rim, fo);
  return { ixa, ixb, iza, izb, Yb };
}

/**
 * A recess cut into a horizontal surface at height z (a wall cap or a floor plate). Open sides (no
 * slope) are shifted so the floor of the recess lines up exactly with the neighbouring tile's.
 */
function topRecess(
  m: Mesh,
  xa: number,
  xb: number,
  ya: number,
  yb: number,
  z: number,
  d: number,
  e: number,
  back: string,
  rim: string,
  o: { l?: boolean; r?: boolean; far?: boolean; near?: boolean; layer?: number; emissive?: boolean } = {},
) {
  const l = o.l ?? true;
  const rr = o.r ?? true;
  const far = o.far ?? true;
  const near = o.near ?? true;
  const zb = z - d;
  const ixa = l ? xa + e : xa + SKEW * d;
  const ixb = rr ? xb - e : xb + SKEW * d;
  const iya = far ? ya + e : ya - d;
  const iyb = near ? yb - e : yb - d;
  const fo = { layer: o.layer ?? 1, jitter: 0 };
  m.face([[ixa, iya, zb], [ixb, iya, zb], [ixb, iyb, zb], [ixa, iyb, zb]], back, { ...fo, emissive: o.emissive });
  if (far) m.face([[xa, ya, z], [xb, ya, z], [ixb, iya, zb], [ixa, iya, zb]], rim, fo);
  if (near) m.face([[xa, yb, z], [xb, yb, z], [ixb, iyb, zb], [ixa, iyb, zb]], rim, fo);
  if (l) m.face([[xa, ya, z], [xa, yb, z], [ixa, iyb, zb], [ixa, iya, zb]], rim, fo);
  if (rr) m.face([[xb, ya, z], [xb, yb, z], [ixb, iyb, zb], [ixb, iya, zb]], rim, fo);
  return { ixa, ixb, iya, iyb, zb };
}

/** Diagonal hazard stripes across a vertical plane y = Y, spanning x0..x1, between z0 and z1. */
function faceStripes(m: Mesh, x0: number, x1: number, Y: number, z0: number, z1: number, layer: number) {
  const rise = (x1 - x0) * 0.55;
  const t = 1.1;
  for (let z = z0; z + rise + t <= z1 + 0.01; z += t * 2.2) {
    m.face([[x0, Y, z], [x1, Y, z + rise], [x1, Y, z + rise + t], [x0, Y, z + t]], HAZARD, { layer, jitter: 0 });
  }
}

// ---------------- floor layer ----------------

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function drawFloors(ctx: Ctx, map: OfficeMap) {
  const T = map.tileSize;
  r(ctx, 0, 0, map.w * T, map.h * T, '#1a1b20');

  const seen = new Set<string>();
  for (const id of Object.keys(map.rooms) as RoomId[]) {
    const [rx0, ry0, rx1, ry1] = map.rooms[id].rect;
    const key = `${rx0},${ry0},${rx1},${ry1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // the floor runs on under the gap between the room and its slim walls
    const b: Box = { x0: (rx0 + 1) * T - WALL_IN, y0: (ry0 + 1) * T - WALL_IN, x1: rx1 * T + WALL_IN, y1: ry1 * T + WALL_IN };
    ctx.save();
    clipRect(ctx, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    roomFloor(ctx, id, b);
    ctx.restore();
  }

  // stray floor outside any room (corridors): grating, tile by tile
  for (let y = 0; y < map.h; y++)
    for (let x = 0; x < map.w; x++) {
      const c = map.at(x, y);
      if (isSolid(c) || isDoor(c) || map.roomAt(x, y)) continue;
      ctx.save();
      ctx.translate(x * T, y * T);
      // reach under the gap beside neighbouring slim walls
      const gx0 = isSolid(map.at(x - 1, y)) ? -WALL_IN : 0;
      const gy0 = isSolid(map.at(x, y - 1)) ? -WALL_IN : 0;
      const gx1 = isSolid(map.at(x + 1, y)) ? 16 + WALL_IN : 16;
      const gy1 = isSolid(map.at(x, y + 1)) ? 16 + WALL_IN : 16;
      clipRect(ctx, gx0, gy0, gx1 - gx0, gy1 - gy0);
      const m = new Mesh(hash('hall', x, y));
      grate(ctx, m, gx0, gy0, gx1, gy1, FLOORS.hall, true);
      m.draw(ctx);
      ctx.restore();
    }

  // door thresholds
  for (let y = 0; y < map.h; y++)
    for (let x = 0; x < map.w; x++) {
      const c = map.at(x, y);
      if (!isDoor(c)) continue;
      ctx.save();
      ctx.translate(x * T, y * T);
      clipRect(ctx, 0, 0, T, T);
      drawDoorFloor(ctx, map, x, y, c === 'E');
      ctx.restore();
    }

  // grime, scuffs and the odd oil stain: this station has seen some use
  for (let y = 0; y < map.h; y++)
    for (let x = 0; x < map.w; x++) {
      if (map.at(x, y) !== '.') continue;
      const k = hash(x, y, 'grime');
      if (k % 5 !== 0) continue;
      stain(ctx, k, x * T + 4 + (k % 8), y * T + 4 + ((k >> 4) % 8), 2.4, 'rgba(10,8,6,0.09)');
    }
}

/** A grating: a raised frame around chunky slats over a dark sump. */
function grate(ctx: Ctx, m: Mesh, x0: number, y0: number, x1: number, y1: number, base: string, frame: boolean) {
  r(ctx, x0, y0, x1 - x0, y1 - y0, shade(base, -0.55));
  if (frame) {
    const fb = 1.4;
    plate(m, x0, y0, x1, y0 + fb, base, { c: 0, b: 0.5, h: 0.45, dome: 0 });
    plate(m, x0, y1 - fb, x1, y1, base, { c: 0, b: 0.5, h: 0.45, dome: 0 });
    plate(m, x0, y0 + fb, x0 + fb, y1 - fb, base, { c: 0, b: 0.5, h: 0.45, dome: 0 });
    plate(m, x1 - fb, y0 + fb, x1, y1 - fb, base, { c: 0, b: 0.5, h: 0.45, dome: 0 });
    x0 += fb;
    x1 -= fb;
    y0 += fb;
    y1 -= fb;
  }
  const n = Math.max(2, Math.round((y1 - y0) / 2.6));
  const step = (y1 - y0) / n;
  for (let i = 0; i < n; i++) {
    m.box(x0 + 0.3, y0 + i * step + 0.45, 0, x1 - x0 - 0.6, step - 0.9, 0.35, shade(base, 0.04), { bevel: 0.3, bevelH: 0.2, jitter: 0.02 });
  }
}

/** A carpet: a continuous low-poly heightfield (big soft triangles), seamless across the room. */
function carpet(m: Mesh, b: Box, col: string, key: string, cell = 8, amp = 0.75) {
  const nx = Math.ceil((b.x1 - b.x0) / cell) + 2;
  const ny = Math.ceil((b.y1 - b.y0) / cell) + 2;
  const P = (i: number, j: number): V3 => {
    const gx = b.x0 + (i - 1) * cell;
    const gy = b.y0 + (j - 1) * cell;
    return [gx + rnd(key, gx, gy, 'x') * cell * 0.22, gy + rnd(key, gx, gy, 'y') * cell * 0.22, amp * (0.5 + 0.5 * rnd(key, gx, gy, 'z'))];
  };
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const a = P(i, j);
      const bb = P(i + 1, j);
      const c = P(i + 1, j + 1);
      const d = P(i, j + 1);
      if ((i + j) & 1) {
        m.face([a, bb, c], col, { jitter: 0.03 });
        m.face([a, c, d], col, { jitter: 0.03 });
      } else {
        m.face([a, bb, d], col, { jitter: 0.03 });
        m.face([bb, c, d], col, { jitter: 0.03 });
      }
    }
}

/** A rug lying on carpet: a thick bevelled border, a raised field and a row of diamond motifs. */
function rug(m: Mesh, x0: number, y0: number, x1: number, y1: number, border: string, field: string, accent: string, seed: number) {
  plate(m, x0, y0, x1, y1, border, { z0: 0, h: 1.0, b: 0.7, c: 0.8, dome: 0, layer: 1, seed, jitter: 0.015 });
  plate(m, x0 + 1.8, y0 + 1.8, x1 - 1.8, y1 - 1.8, field, { z0: 1.0, h: 0.2, b: 0.45, c: 0.6, dome: 0.12, layer: 2, seed: seed + 1, jitter: 0.02 });
  const cy = (y0 + y1) / 2;
  const n = Math.max(1, Math.round((x1 - x0 - 6) / 9));
  const step = (x1 - x0 - 4) / n;
  const ry = Math.min(3, (y1 - y0) / 2 - 3);
  for (let i = 0; i < n; i++) {
    const cx = x0 + 2 + step * (i + 0.5);
    m.extrude([[cx, cy - ry], [cx + ry * 0.9, cy], [cx, cy + ry], [cx - ry * 0.9, cy]], 1.25, 1.38, accent, { layer: 3, jitter: 0.02 });
  }
}

function roomFloor(ctx: Ctx, id: RoomId, b: Box) {
  const base = FLOORS[id] ?? FLOORS.hall;
  const m = new Mesh(hash('floor', id));
  // the groove colour between panels: the same material, a touch deeper (no black seams)
  r(ctx, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, shade(base, -0.2));
  const after: Array<() => void> = [];
  const tint = (k: number, amt = 0.03) => shade(base, ((k % 5) - 2) * amt);

  switch (id) {
    case 'library': {
      // long warm deck planks, three per tile row, staggered with random lengths
      r(ctx, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, shade(base, -0.1));
      const PW = 16 / 3;
      for (let y = b.y0, row = 0; y < b.y1; y += PW, row++) {
        let x = b.x0 - (hash('lib', row) % 40);
        let n = 0;
        while (x < b.x1) {
          const len = 34 + (hash('libl', row, n) % 30);
          const k = hash('plank', row, n);
          plank(m, x + 0.12, x + len - 0.12, y + 0.12, y + PW - 0.12, tint(k, 0.04), `p${row}.${n}`);
          x += len;
          n++;
        }
      }
      break;
    }
    case 'research': {
      // hexagonal lab tiles: reads as low-poly terrain rather than a square grid
      const R = 10;
      const dx = R * 1.5;
      const dy = R * Math.sqrt(3);
      for (let i = -1; i * dx < b.x1 - b.x0 + R; i++)
        for (let j = -1; j * dy < b.y1 - b.y0 + R; j++) {
          const cx = b.x0 + i * dx;
          const cy = b.y0 + j * dy + (i & 1 ? dy / 2 : 0);
          const k = hash('hex', i, j);
          hexPlate(m, cx, cy, R - 0.3, tint(k, 0.03), { h: 0.4, b: 1.0, dome: 0.22, seed: k });
        }
      break;
    }
    case 'serverRoom': {
      // raised access floor: square tiles, every few a perforated cooling grate, teal aisle seams
      for (let y = b.y0, ty = 0; y < b.y1; y += 16, ty++)
        for (let x = b.x0, tx = 0; x < b.x1; x += 16, tx++) {
          const k = hash('srv', tx, ty);
          const grill = (tx + ty * 2) % 3 === 0;
          plate(m, x + 0.3, y + 0.3, x + 15.7, y + 15.7, tint(k, 0.02), { c: 0.9, b: 0.7, h: 0.4, dome: grill ? 0 : 0.1, seed: k });
          if (grill) {
            const rc = topRecess(m, x + 3.2, x + 12.8, y + 3.2, y + 12.8, 0.4, 0.35, 0.5, '#13161b', shade(base, -0.05), { layer: 1 });
            for (let i = 0; i < 4; i++) {
              const sy = rc.iya + 0.3 + i * ((rc.iyb - rc.iya) / 4);
              m.box(rc.ixa + 0.2, sy, rc.zb, rc.ixb - rc.ixa - 0.4, 0.9, 0.22, shade(base, 0.1), { layer: 2, jitter: 0 });
            }
          }
        }
      // cold-aisle light seams in the grooves
      for (let y = b.y0 + 32; y < b.y1; y += 48) {
        m.face([[b.x0, y - 0.25, 0.02], [b.x1, y - 0.25, 0.02], [b.x1, y + 0.25, 0.02], [b.x0, y + 0.25, 0.02]], TEAL, { emissive: true, alpha: 0.55, layer: 1 });
        after.push(() => {
          const g = ctx.createLinearGradient(0, y - 3, 0, y + 3);
          g.addColorStop(0, 'rgba(95,212,224,0)');
          g.addColorStop(0.5, 'rgba(95,212,224,0.14)');
          g.addColorStop(1, 'rgba(95,212,224,0)');
          ctx.fillStyle = g;
          ctx.fillRect(b.x0, y - 3, b.x1 - b.x0, 6);
        });
      }
      break;
    }
    case 'workshop': {
      // big bolted tech panels with a cable trench running through
      for (let y = b.y0, ty = 0; y < b.y1; y += 32, ty++)
        for (let x = b.x0, tx = 0; x < b.x1; x += 32, tx++) {
          const k = hash('dev', tx, ty);
          plate(m, x + 0.35, y + 0.35, x + 31.65, y + 31.65, tint(k, 0.025), { c: 2.2, b: 1.1, h: 0.45, dome: 0.3, seed: k });
          for (const [bx, by] of [[3.4, 3.4], [28.6, 3.4], [3.4, 28.6], [28.6, 28.6]])
            m.cylinder(x + bx, y + by, 0.45, 0.6, 0.45, 0.25, 6, shade(base, -0.08), { layer: 1, jitter: 0 });
        }
      for (let ty = 3; ty * 16 + b.y0 - 16 < b.y1; ty += 3) {
        const ya = b.y0 + (ty - 1) * 16 + 9.4;
        const yb = ya + 3.8;
        m.face([[b.x0, ya + 0.6, 0], [b.x1, ya + 0.6, 0], [b.x1, yb, 0], [b.x0, yb, 0]], '#1b2028', { layer: 2, jitter: 0 });
        m.face([[b.x0, ya, 0.45], [b.x1, ya, 0.45], [b.x1, ya + 0.6, 0], [b.x0, ya + 0.6, 0]], shade(base, -0.1), { layer: 2, jitter: 0 });
        for (const [cy, rad, col] of [[ya + 1.7, 0.55, '#262a31'], [ya + 2.9, 0.4, '#3d3630']] as Array<[number, number, string]>) {
          m.push().translate(b.x0, cy, rad).rotateY(Math.PI / 2).cylinder(0, 0, 0, rad, rad, b.x1 - b.x0, 6, col, { layer: 3, jitter: 0, rot: 0 }).pop();
        }
      }
      break;
    }
    case 'mailroom': {
      // scuffed sand plating, bolted, with stencilled lane markers
      for (let y = b.y0, ty = 0; y < b.y1; y += 32, ty++)
        for (let x = b.x0, tx = 0; x < b.x1; x += 32, tx++) {
          const k = hash('mail', tx, ty);
          plate(m, x + 0.35, y + 0.35, x + 31.65, y + 31.65, tint(k, 0.03), { c: 2.4, b: 1.1, h: 0.4, dome: 0.28, seed: k });
          for (const [bx, by] of [[3.4, 3.4], [28.6, 3.4], [3.4, 28.6], [28.6, 28.6]])
            m.cylinder(x + bx, y + by, 0.4, 0.6, 0.45, 0.25, 6, shade(base, -0.1), { layer: 1, jitter: 0 });
          if (tx % 2 === 0) {
            const cx = x + 16;
            const cy = y + 16;
            m.face([[cx - 5, cy - 1.6, 0.72], [cx + 3, cy - 1.6, 0.72], [cx + 5, cy + 1.6, 0.72], [cx - 3, cy + 1.6, 0.72]], HAZARD, { layer: 2, alpha: 0.28, jitter: 0 });
          }
        }
      break;
    }
    case 'openOffice': {
      // big calm composite deck: 2x2-tile panels, softly faceted
      for (let y = b.y0, ty = 0; y < b.y1; y += 32, ty++)
        for (let x = b.x0, tx = 0; x < b.x1; x += 32, tx++) {
          const k = hash('oo', tx, ty);
          plate(m, x + 0.35, y + 0.35, x + 31.65, y + 31.65, tint(k, 0.018), { c: 2.6, b: 1.1, h: 0.45, dome: 0.32, seed: k });
        }
      break;
    }
    case 'meeting': {
      for (let y = b.y0, ty = 0; y < b.y1; y += 32, ty++)
        for (let x = b.x0, tx = 0; x < b.x1; x += 32, tx++) {
          const k = hash('meet', tx, ty);
          plate(m, x + 0.35, y + 0.35, x + 31.65, y + 31.65, tint(k, 0.02), { c: 1.4, b: 1.0, h: 0.4, dome: 0.28, seed: k });
        }
      // a big rug under the table
      rug(m, b.x0 + 8, b.y0 + 24, b.x1 - 8, b.y1 - 24, '#3b2f45', '#4a3d58', '#7a6a8a', 3);
      break;
    }
    case 'whiteboard': {
      // diagonal (diamond) plates: a 45-degree lattice, so the room never reads as a square grid
      const D = 16; // half-diagonal
      for (let j = -1; j * D < b.y1 - b.y0 + D; j++)
        for (let i = -1; i * 2 * D < b.x1 - b.x0 + 2 * D; i++) {
          const cx = b.x0 + i * 2 * D + (j & 1 ? D : 0);
          const cy = b.y0 + j * D;
          const k = hash('wb', i, j);
          const ring = (hd: number): P2[] => [[cx, cy - hd], [cx + hd, cy], [cx, cy + hd], [cx - hd, cy]];
          facetPlate(m, ring(D - 0.45), ring(D - 0.45 - 1.3), tint(k, 0.025), { h: 0.38, dome: 0.25, seed: k });
        }
      break;
    }
    case 'reception': {
      carpet(m, b, base, 'rec');
      // a rug in front of the manager's desk
      rug(m, b.x0 + 24, b.y0 + 40, b.x1 - 24, b.y1 - 24, '#43352c', '#5a3236', '#7a5f42', 1);
      break;
    }
    case 'lounge': {
      carpet(m, b, base, 'lounge');
      rug(m, b.x0 + 8, b.y0 + 40, b.x0 + 104, b.y0 + 88, '#2f4a4a', '#3c5e5c', '#a8884a', 2);
      break;
    }
    case 'dorm': {
      carpet(m, b, base, 'dorm', 8, 0.6);
      // a runner down the aisle between the bunks
      rug(m, b.x0 + 33, b.y0 + 4, b.x0 + 47, b.y1 - 4, '#3a3048', '#4b4266', '#8a7ab0', 4);
      break;
    }
    default: {
      for (let y = b.y0, ty = 0; y < b.y1; y += 16, ty++)
        for (let x = b.x0, tx = 0; x < b.x1; x += 16, tx++) {
          const k = hash('def', tx, ty);
          plate(m, x + 0.3, y + 0.3, x + 15.7, y + 15.7, tint(k), { c: 1.6, b: 0.9, h: 0.4, dome: 0.15, seed: k });
        }
    }
  }
  m.draw(ctx);
  for (const f of after) f();
}

function drawDoorFloor(ctx: Ctx, map: OfficeMap, x: number, y: number, entrance: boolean) {
  const base = '#4a4740';
  const m = new Mesh(hash('door', x, y));
  const blocked = (c: string) => isSolid(c) || isDoor(c);
  // a door in a horizontal wall: people pass north-south
  const ns = blocked(map.at(x - 1, y)) || blocked(map.at(x + 1, y)) || !(blocked(map.at(x, y - 1)) || blocked(map.at(x, y + 1)));
  // swap axes so one layout serves both orientations
  const P = (u: number, v: number): [number, number] => (ns ? [u, v] : [v, u]);
  const rect = (u0: number, v0: number, u1: number, v1: number) => {
    const [ax, ay] = P(u0, v0);
    const [bx, by] = P(u1, v1);
    return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)] as const;
  };
  // blast-door threshold: raised sill plates either side of a grated track
  const [tx0, ty0, tx1, ty1] = rect(5.6, 0, 10.4, 16);
  ctx.save();
  grate(ctx, m, tx0, ty0, tx1, ty1, '#3a3834', false);
  ctx.restore();
  for (const [u0, u1] of [[0.2, 5.6], [10.4, 15.8]]) {
    const [a, b, c, d] = rect(u0, -0.2, u1, 16.2);
    plate(m, a, b, c, d, base, { c: 0, b: 0.8, h: 0.6, dome: 0.08 });
    // hazard chevrons, as raised inlays on the sill
    const cu = (u0 + u1) / 2;
    for (const cv of [4, 12]) {
      const arms: Array<Array<[number, number]>> = [
        [[cu - 1.6, cv - 1.8], [cu, cv], [cu, cv + 1.2], [cu - 1.6, cv - 0.6]],
        [[cu, cv], [cu + 1.6, cv - 1.8], [cu + 1.6, cv - 0.6], [cu, cv + 1.2]],
      ];
      for (const arm of arms) m.extrude(arm.map(([u, v]) => P(u, v)), 0.6, 0.78, HAZARD, { layer: 2, jitter: 0 });
    }
  }
  m.draw(ctx);
  if (entrance) {
    // airlock: green guide lights
    const lm = new Mesh(hash('elight', x, y));
    for (const [u, v] of [[2.9, 1.6], [2.9, 14.4], [13.1, 1.6], [13.1, 14.4]]) {
      const [lx, ly] = P(u, v);
      lm.cylinder(lx, ly, 0.6, 0.9, 0.7, 0.3, 6, '#58e07a', { emissive: true });
      glow(ctx, lx, ly - 0.9, 3.2, '88,224,122', 0.45);
    }
    lm.draw(ctx);
  }
}

// ---------------- sliding doors (animated by the renderer) ----------------

/** Does a door tile let people pass north-south (it sits in a horizontal wall)? Same rule as its floor. */
export function doorRunsNS(map: OfficeMap, x: number, y: number) {
  const blocked = (c: string) => isSolid(c) || isDoor(c);
  return blocked(map.at(x - 1, y)) || blocked(map.at(x + 1, y)) || !(blocked(map.at(x, y - 1)) || blocked(map.at(x, y + 1)));
}

/** Steps of the door animation that get their own baked image (0 = shut, DOOR_STEPS = fully open). */
export const DOOR_STEPS = 12;
/** Tile-local plan-space box each baked door image covers (it leans up and left with height). */
export const DOOR_BOX = { x: -8, y: -16, w: 28, h: 34 } as const;
const doorCache = new Map<string, HTMLCanvasElement>();

/**
 * A pair of sliding door panels in a doorway, `step` of DOOR_STEPS open: each panel slides into its side
 * of the wall, so the opening widens from the middle. Baked once per (orientation, kind, step) in plan
 * space, covering DOOR_BOX of the tile; draw it at the tile's plan position through the camera transform.
 */
export function doorImage(map: OfficeMap, x: number, y: number, step: number): HTMLCanvasElement {
  const ns = doorRunsNS(map, x, y);
  const entrance = map.at(x, y) === 'E';
  // a doorway two tiles wide is one door: each tile holds one panel that slides away from the other tile
  const along = (d: number) => (ns ? map.at(x + d, y) : map.at(x, y + d));
  const pairLo = isDoor(along(-1)); // the doorway continues on the u = 0 side
  const pairHi = isDoor(along(1)); // ... on the u = 16 side
  const mode = pairLo === pairHi ? 'both' : pairHi ? 'lo' : 'hi'; // which side(s) the panels hide in
  const key = `${ns ? 1 : 0}${entrance ? 1 : 0}${mode}:${step}`;
  let c = doorCache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = DOOR_BOX.w * ART_RES;
  c.height = DOOR_BOX.h * ART_RES;
  const ctx = c.getContext('2d')!;
  ctx.scale(ART_RES, ART_RES);
  ctx.translate(-DOOR_BOX.x, -DOOR_BOX.y);

  const open = step / DOOR_STEPS;
  const ease = open * open * (3 - 2 * open);
  const m = new Mesh(entrance ? 71 : 70);
  // the layout is written for a door in a horizontal wall (panels slide along x); swap for the other way
  const P = (u: number, v: number): [number, number] => (ns ? [u, v] : [v, u]);
  const panel = entrance ? '#4f5a56' : '#4b5060';
  const light = ease > 0.05 ? '#58e07a' : '#ff5a4a';
  const v0 = WALL_IN + 1.1;
  const v1 = 16 - WALL_IN - 1.1;
  const H = WALL_RISE - 0.9;
  const half = mode === 'both' ? 8 - 0.08 : 16 - 0.08;
  const w = half * (1 - ease) + 0.6 * ease; // a lip stays visible at each jamb when fully open
  const sides = mode === 'both' ? [-1, 1] : mode === 'lo' ? [-1] : [1];
  const slab = (u0: number, u1: number, z0: number, z1: number, col: string, o: { emissive?: boolean; dv?: number; layer?: number } = {}) => {
    const dv = o.dv ?? 0;
    const [ax, ay] = P(u0, v0 - dv);
    const [bx, by] = P(u1, v1 + dv);
    m.box(Math.min(ax, bx), Math.min(ay, by), z0, Math.abs(bx - ax), Math.abs(by - ay), z1 - z0, col, {
      emissive: o.emissive,
      bevel: o.emissive || o.layer ? 0 : 0.3,
      bevelH: 0.25,
      jitter: 0.01,
      layer: o.layer ?? 0,
    });
  };
  for (const side of sides) {
    // u runs along the wall; the left panel hugs u = 0, the right one u = 16
    const u0 = side < 0 ? 0 : 16 - w;
    const u1 = side < 0 ? w : 16;
    slab(u0, u1, 0, H, panel);
    // a window slit and the hazard edge on the meeting side
    const edge = side < 0 ? u1 - 0.7 : u0;
    if (w > 1.4) {
      slab(edge, edge + 0.7, 0.4, H - 0.4, '#d9a53a', { dv: 0.06, layer: 1 });
      const wa = side < 0 ? Math.max(u0 + 0.8, u1 - 4.2) : u0 + 1.2;
      const wb = side < 0 ? u1 - 1.2 : Math.min(u1 - 0.8, u0 + 4.2);
      if (wb - wa > 0.6) slab(wa, wb, 6.2, 9.0, '#16202c', { dv: 0.05, layer: 1 });
    }
  }
  // the status light over the middle of the doorway: red when shut, green while open
  if (mode === 'both') slab(6.6, 9.4, H + 0.05, H + 0.55, light, { emissive: true, dv: -0.4, layer: 2 });
  else if (mode === 'lo') slab(14.6, 16, H + 0.05, H + 0.55, light, { emissive: true, dv: -0.4, layer: 2 });
  else slab(0, 1.4, H + 0.05, H + 0.55, light, { emissive: true, dv: -0.4, layer: 2 });
  m.draw(ctx);
  doorCache.set(key, c);
  return c;
}

/** Light comes from the top-left: shadows fall down and to the right. */
function drawFloorShading(ctx: Ctx, map: OfficeMap, x: number, y: number) {
  const c = map.at(x, y);
  if (isSolid(c)) return;
  if (isObject(c)) {
    // soft contact shadow of furniture, falling a little to the lower right (no hard-edged boxes)
    softShadow(ctx, 9.5, 14, 10, 4.5, 0.32);
    return;
  }
  // ambient occlusion where floor meets a wall (slim walls stand WALL_IN into their own tile)
  const I = WALL_IN;
  if (isSolid(map.at(x, y - 1))) {
    const g = ctx.createLinearGradient(0, -I, 0, 8 - I);
    g.addColorStop(0, 'rgba(0,0,0,0.42)');
    g.addColorStop(0.35, 'rgba(0,0,0,0.16)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, -I, 16, 8);
  }
  if (isSolid(map.at(x - 1, y))) {
    const g = ctx.createLinearGradient(-I, 0, 6 - I, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.34)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-I, 0, 6, 16);
  }
  if (isSolid(map.at(x + 1, y))) {
    const g = ctx.createLinearGradient(16 + I, 0, 12 + I, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.18)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(12 + I, 0, 4, 16);
  }
  if (isSolid(map.at(x, y + 1))) {
    const g = ctx.createLinearGradient(0, 16 + I, 0, 16 + I - 3);
    g.addColorStop(0, 'rgba(0,0,0,0.16)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 13 + I, 16, 3);
  }
}

// ---------------- walls ----------------

/** How far a wall sits in from an open side of its tile (the wall is 16 - 2·WALL_IN thick). */
export const WALL_IN = 4.5;
const WA = WALL_IN;
const WB = 16 - WALL_IN;
/** Rounded cap: two bevel steps (insets B1, B2) between the vertical sides (top at Z1) and the cap (H). */
const B1 = 0.7;
const B2 = 1.8;
const Z1 = H - 1.7;
const Z2 = H - 0.55;

/** Walls reach out to (join) neighbouring walls and doors. */
const joins = (c: string) => isSolid(c) || isDoor(c);

interface Outline {
  /** Footprint polygon, clockwise on screen. */
  pts: P2[];
  /** open[i]: edge pts[i] -> pts[i+1] is exposed (gets faces and a bevel); closed edges meet a neighbour. */
  open: boolean[];
}

/** The wall's footprint on its tile: a central core plus an arm toward every joined neighbour. */
function wallOutline(map: OfficeMap, x: number, y: number): Outline {
  const last = y === map.h - 1;
  // off the map counts as open, so the outer hull is a clean slim wall (no arms into the void)
  const inMap = (tx: number, ty: number) => tx >= 0 && ty >= 0 && tx < map.w && ty < map.h;
  const J = (tx: number, ty: number) => inMap(tx, ty) && joins(map.at(tx, ty));
  const U = J(x, y - 1);
  const D = J(x, y + 1);
  const L = J(x - 1, y);
  const R = J(x + 1, y);
  const tU = U ? 0 : WA;
  const bD = D ? 16 : WB;
  const lL = L ? 0 : WA;
  const rR = R ? 16 : WB;
  const raw: P2[] = [[WA, tU], [WB, tU], [WB, WA], [rR, WA], [rR, WB], [WB, WB], [WB, bD], [WA, bD], [WA, WB], [lL, WB], [lL, WA], [WA, WA]];
  let pts = raw.filter((p, i) => {
    const q = raw[(i + raw.length - 1) % raw.length];
    return p[0] !== q[0] || p[1] !== q[1];
  });
  for (let i = 0; i < pts.length && pts.length > 3; ) {
    const a = pts[(i + pts.length - 1) % pts.length];
    const b = pts[i];
    const c = pts[(i + 1) % pts.length];
    if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])) {
      pts = pts.filter((_, k) => k !== i);
      i = 0;
    } else i++;
  }
  const edge = (v: number) => v === 0 || v === 16;
  const open = pts.map((p, i) => {
    const q = pts[(i + 1) % pts.length];
    if (p[0] === q[0] && edge(p[0])) return isDoor(map.at(x + (p[0] === 16 ? 1 : -1), y));
    if (p[1] === q[1] && edge(p[1])) return p[1] === 16 ? last || isDoor(map.at(x, y + 1)) : isDoor(map.at(x, y - 1));
    return true;
  });
  return { pts, open };
}

/** Outward 2D normals of the outline's edges. */
function normals(o: Outline): P2[] {
  const n = o.pts.length;
  return o.pts.map((p, i) => {
    const q = o.pts[(i + 1) % n];
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const l = Math.hypot(dx, dy) || 1;
    return [dy / l, -dx / l] as P2;
  });
}

/** The outline with its open edges pushed in by s (all corners are right angles). */
function inset(o: Outline, s: number): P2[] {
  const n = o.pts.length;
  const nr = normals(o);
  return o.pts.map((p, i) => {
    const j = (i + n - 1) % n;
    const a = o.open[j] ? s : 0;
    const b = o.open[i] ? s : 0;
    return [p[0] - a * nr[j][0] - b * nr[i][0], p[1] - a * nr[j][1] - b * nr[i][1]] as P2;
  });
}

/** The wall solid: visible sides, two rounded bevel steps on every open edge, and the cap. */
function wallSolid(m: Mesh, o: Outline, last: boolean) {
  const n = o.pts.length;
  const nr = normals(o);
  const r1 = inset(o, B1);
  const r2 = inset(o, B2);
  const opt = (t: V3, layer = 0) => ({ twoSided: false, toward: t, jitter: 0, layer });
  for (let i = 0; i < n; i++) {
    if (!o.open[i]) continue;
    const j = (i + 1) % n;
    const a = o.pts[i];
    const b = o.pts[j];
    const [nx, ny] = nr[i];
    if (nx * VIEW[0] + ny * VIEW[1] > 0) {
      const col = ny > 0.5 && last ? HULL : BULKHEAD;
      m.face([[a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], Z1], [a[0], a[1], Z1]], col, opt([nx, ny, 0]));
    }
    m.face([[a[0], a[1], Z1], [b[0], b[1], Z1], [r1[j][0], r1[j][1], Z2], [r1[i][0], r1[i][1], Z2]], CAP_EDGE, opt([nx, ny, 0.6], 1));
    m.face([[r1[i][0], r1[i][1], Z2], [r1[j][0], r1[j][1], Z2], [r2[j][0], r2[j][1], H], [r2[i][0], r2[i][1], H]], CAP, opt([nx * 0.5, ny * 0.5, 1], 1));
  }
  m.face(r2.map(([px, py]) => [px, py, H] as V3), CAP, { jitter: 0, layer: 1 });
}
const CAP_EDGE = '#34363e';

type Glass =
  | { kind: 'front'; x0: number; x1: number; y: number; z0: number; z1: number }
  | { kind: 'side'; x: number; y0: number; y1: number; z0: number; z1: number };

/** Does this wall tile show a front face, and where (screen-plane y within the tile)? */
function frontOf(map: OfficeMap, x: number, y: number): number | null {
  if (x < 0 || y < 0 || x >= map.w || y >= map.h || !isSolid(map.at(x, y))) return null;
  if (y === map.h - 1) return 16;
  return joins(map.at(x, y + 1)) ? null : WB;
}
/** A viewport in a wall's front face. */
const isFaceWindow = (map: OfficeMap, x: number, y: number) => map.at(x, y) === 'V' && frontOf(map, x, y) !== null;
/** A plain bulkhead front (the light strip, kick band and pipes run continuously along these). */
const isFaceWall = (map: OfficeMap, x: number, y: number) => frontOf(map, x, y) !== null && map.at(x, y) !== 'V';

/** Glass geometry of a viewport tile (shared by drawWall and windowGlass). */
function glassOf(map: OfficeMap, x: number, y: number): (Glass & { l: boolean; r: boolean; xa: number; xb: number }) | null {
  if (map.at(x, y) !== 'V') return null;
  const fy = frontOf(map, x, y);
  if (fy !== null) {
    const wl = isFaceWindow(map, x - 1, y);
    const wr = isFaceWindow(map, x + 1, y);
    const xa = wl ? 0 : 1.0;
    const xb = wr ? 16 : 15.0;
    const e = 1.3;
    return { kind: 'front', x0: wl ? xa : xa + e, x1: wr ? xb : xb - e, y: fy - WIN_D, z0: WIN_Z0 + e, z1: WIN_Z1 - e, l: !wl, r: !wr, xa, xb };
  }
  // a viewport in a wall running north-south: glass in its (visible) right-hand side
  if (joins(map.at(x + 1, y))) return null;
  const y0 = (joins(map.at(x, y - 1)) ? 0 : WA) + 1.2;
  const y1 = (joins(map.at(x, y + 1)) ? 16 : WB) - 1.2;
  return { kind: 'side', x: WB + 0.06, y0, y1, z0: 2.6, z1: 9.0, l: true, r: true, xa: y0, xb: y1 };
}
const WIN_Z0 = 1.2;
const WIN_Z1 = 9.6;
/** Bulkhead front: inset panels and the accent light strip (heights on the face). */
const PZ0 = 2.0;
const PZ1 = 6.0;
const LZ0 = 6.5;
const LZ1 = 8.3;
const WIN_D = 1.0;

/** The run of plain bulkhead fronts that (x, y) belongs to: [first, last] tile x. */
function faceRun(map: OfficeMap, x: number, y: number): [number, number] {
  let a = x;
  let b = x;
  while (isFaceWall(map, a - 1, y)) a--;
  while (isFaceWall(map, b + 1, y)) b++;
  return [a, b];
}

function drawWall(ctx: Ctx, map: OfficeMap, x: number, y: number) {
  const c = map.at(x, y);
  const last = y === map.h - 1;
  const L = joins(map.at(x - 1, y));
  const R = joins(map.at(x + 1, y));
  const below = map.at(x, y + 1);

  const base = new Mesh(hash('wall', x, y));
  const det = new Mesh(hash('wdet', x, y));
  const glows: Array<() => void> = [];

  // ---- the slim solid with its rounded cap ----
  wallSolid(base, wallOutline(map, x, y), last);
  const FY = frontOf(map, x, y); // front face plane (null: no front here)
  const fx0 = L ? 0 : WA;
  const fx1 = R ? 16 : WB;
  const full = fx0 === 0 && fx1 === 16;

  // ---- front face details ----
  const glass = glassOf(map, x, y);
  if (glass?.kind === 'front' && FY !== null) {
    // a viewport: a deep, sloped frame around glass looking out into space
    const g = glass;
    frontRecess(base, g.xa, g.xb, WIN_Z0, WIN_Z1, WIN_D, 1.3, SPACE, FRAME, { l: g.l, r: g.r, emissive: true, y: FY, layer: 2 });
    if (!g.l) det.box(-0.6, FY - WIN_D - 0.1, WIN_Z0, 1.2, WIN_D + 0.1, WIN_Z1 - WIN_Z0, FRAME, { jitter: 0, layer: 2 });
    // a sill ledge under the glass
    det.box(g.l ? g.xa - 0.5 : 0, FY - 0.4, 0.7, (g.r ? g.xb + 0.5 : 16) - (g.l ? g.xa - 0.5 : 0), 1.0, 0.6, shade(FRAME, -0.1), { jitter: 0, layer: 2, bevel: 0.25, bevelH: 0.2 });
  } else if (glass?.kind === 'side') {
    // a viewport in the right-hand side of a north-south wall
    const g = glass;
    const fr = (y0: number, y1: number, z0: number, z1: number, xx: number, col: string, o: object) =>
      base.face([[xx, y0, z0], [xx, y1, z0], [xx, y1, z1], [xx, y0, z1]], col, { twoSided: false, toward: [1, 0, 0], jitter: 0, layer: 2, ...o });
    fr(g.y0 - 0.8, g.y1 + 0.8, g.z0 - 0.8, g.z1 + 0.8, WB + 0.03, FRAME, {});
    fr(g.y0, g.y1, g.z0, g.z1, g.x, SPACE, { emissive: true, layer: 3 });
  } else if (FY !== null && full) {
    const run = faceRun(map, x, y);
    const runL = x > run[0];
    const runR = x < run[1];
    const k = hash('wall', x, y);
    const Y = { y: FY, layer: 2 };
    // kick band along the floor
    frontRecess(base, 0, 16, 0.3, 1.7, 0.35, 0.45, '#24252a', shade(BULKHEAD, -0.1), { l: !runL, r: !runR, ...Y });
    if (last) {
      // the outer hull: plain, heavy plating
      for (const px of [0.6, 8.6]) frontRecess(base, px, px + 6.8, 2.6, 9.2, 0.5, 0.7, shade(HULL, -0.1), HULL, Y);
    } else {
      // two inset panels per tile with sloped sides
      const pk = shade(BULKHEAD, -0.22);
      frontRecess(base, 0.6, 7.4, PZ0, PZ1, 0.6, 0.8, pk, BULKHEAD, Y);
      const special = k % 7;
      if (special === 2) {
        // control panel with indicator lights
        const rc = frontRecess(base, 8.6, 15.4, PZ0, PZ1, 0.7, 0.85, '#1b1c21', BULKHEAD, Y);
        for (const [lx, col, rgb] of [[10.6, '#e8534a', '232,83,74'], [12.4, '#58e07a', '88,224,122']] as Array<[number, string, string]>) {
          const lz = rc.izb - 0.9;
          det.face([[lx - 0.45, rc.Yb + 0.02, lz - 0.45], [lx + 0.45, rc.Yb + 0.02, lz - 0.45], [lx + 0.45, rc.Yb + 0.02, lz + 0.45], [lx - 0.45, rc.Yb + 0.02, lz + 0.45]], col, { emissive: true, layer: 3 });
          const [sx, sy] = project([lx, rc.Yb, lz]);
          glows.push(() => glow(ctx, sx, sy, 1.8, rgb, 0.4));
        }
        det.face([[rc.ixa + 0.3, rc.Yb + 0.02, rc.iza + 0.3], [rc.ixb - 0.3, rc.Yb + 0.02, rc.iza + 0.3], [rc.ixb - 0.3, rc.Yb + 0.02, rc.iza + 0.9], [rc.ixa + 0.3, rc.Yb + 0.02, rc.iza + 0.9]], HAZARD, { layer: 3, jitter: 0 });
      } else if (special === 4) {
        // a vent: dark slot with louvres
        const rc = frontRecess(base, 8.6, 15.4, PZ0, PZ1, 0.7, 0.85, '#202126', BULKHEAD, Y);
        for (let i = 0; i < 2; i++) {
          const lz = rc.iza + 0.35 + i * 1.25;
          det.face([[rc.ixa + 0.2, rc.Yb + 0.02, lz], [rc.ixb - 0.2, rc.Yb + 0.02, lz], [rc.ixb - 0.2, rc.Yb + 0.5, lz + 0.6], [rc.ixa + 0.2, rc.Yb + 0.5, lz + 0.6]], '#4a4c55', { layer: 3, jitter: 0 });
        }
      } else {
        frontRecess(base, 8.6, 15.4, PZ0, PZ1, 0.6, 0.8, pk, BULKHEAD, Y);
      }
      // accent light strip: continuous along the run, lit or dimmed per run
      const rk = hash('run', run[0], y);
      const on = rk % 3 !== 0;
      const lightCol = rk % 5 === 0 ? TEAL : AMBER;
      const rc = frontRecess(base, runL ? 0 : 0.4, runR ? 16 : 15.6, LZ0, LZ1, 0.45, 0.6, '#1d1e22', shade(BULKHEAD, -0.05), { l: !runL, r: !runR, ...Y });
      const lz0 = rc.iza + 0.12;
      const lz1 = rc.izb - 0.12;
      det.face([[rc.ixa, rc.Yb + 0.02, lz0], [rc.ixb, rc.Yb + 0.02, lz0], [rc.ixb, rc.Yb + 0.02, lz1], [rc.ixa, rc.Yb + 0.02, lz1]], on ? lightCol : shade(lightCol, -0.6), { emissive: true, layer: 3 });
      if (on) {
        glows.push(() => {
          const g = ctx.createLinearGradient(0, FY - LZ0, 0, FY - LZ0 + 2.5);
          g.addColorStop(0, lightCol === TEAL ? 'rgba(95,212,224,0.24)' : 'rgba(255,179,90,0.22)');
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          ctx.fillRect(SKEW * LZ0, FY - LZ0, 16, 2.5);
        });
      }
      // a pipe along some runs, with a clamp on every tile
      if (rk % 4 === 1 && run[1] > run[0]) {
        const px0 = runL ? 0 : 0.8;
        const px1 = runR ? 16 : 15.2;
        det.push().translate(px0, FY + 0.45, 9.15).rotateY(Math.PI / 2).cylinder(0, 0, 0, 0.55, 0.55, px1 - px0, 6, '#6e675e', { jitter: 0, layer: 2, rot: 0 }).pop();
        det.box(7, FY - 0.3, 8.35, 2, 1.5, 1.6, '#4a443e', { jitter: 0, layer: 3, bevel: 0.3, bevelH: 0.3 });
      }
      // rust streak under a seam
      if (k % 6 === 3) {
        const sx = 7.6 + (k % 3) * 0.3;
        det.face([[sx - 0.5, FY + 0.02, 6.2], [sx + 0.5, FY + 0.02, 6.2], [sx + 0.25, FY + 0.02, 2.6], [sx - 0.1, FY + 0.02, 2.0]], '#8c461e', { emissive: true, alpha: 0.35, layer: 3 });
      }
    }
  }

  // ---- door posts: a chunky, rounded post where a wall meets a doorway ----
  const post = (x0: number, y0: number, x1: number, y1: number, stripes: boolean) => {
    det.box(x0, y0, 0, x1 - x0, y1 - y0, H + 0.9, JAMB, { chamfer: 0.9, bevel: 0.9, bevelH: 0.8, jitter: 0, layer: 2 });
    if (stripes) faceStripes(det, x0 + 0.9, x1 - 0.9, y1 + 0.02, 1.0, 9.6, 3);
  };
  if (isDoor(map.at(x + 1, y))) post(16 - 2.6, WA - 0.9, 16.4, WB + 0.9, true);
  if (isDoor(map.at(x - 1, y))) post(-0.4, WA - 0.9, 2.6, WB + 0.9, true);
  if (!last && isDoor(below)) post(WA - 0.9, 16 - 2.6, WB + 0.9, 16.4, true);
  if (isDoor(map.at(x, y - 1))) post(WA - 0.9, -0.4, WB + 0.9, 2.6, false);

  // ---- the secret door: a barely-there panel and a faint glyph only insiders notice ----
  if (c === 'X') {
    const side = !R; // the right-hand face shows on a north-south wall
    const pz = 8.4;
    if (side) {
      base.face([[WB + 0.03, 4, 0], [WB + 0.03, 12, 0], [WB + 0.03, 12, pz], [WB + 0.03, 4, pz]], shade(BULKHEAD, -0.12), { twoSided: false, toward: [1, 0, 0], jitter: 0, layer: 2 });
    } else if (FY !== null) {
      base.face([[4, FY + 0.03, 0], [12, FY + 0.03, 0], [12, FY + 0.03, pz], [4, FY + 0.03, pz]], shade(BULKHEAD, -0.12), { jitter: 0, layer: 2 });
    }
    const gx0 = 8;
    det.face([[gx0, 6.6, H + 0.02], [gx0 + 0.7, 8, H + 0.02], [gx0, 9.4, H + 0.02], [gx0 - 0.7, 8, H + 0.02]], '#b07cff', { emissive: true, alpha: 0.75, layer: 3 });
    const [gx, gy] = project([gx0, 8, H]);
    glows.push(() => glow(ctx, gx, gy, 2.4, '176,124,255', 0.22));
  }

  // ---- draw: solid, then glass contents, then details and glows ----
  base.draw(ctx);
  if (glass) {
    const seed = hash('star', x, y);
    ctx.save();
    if (glass.kind === 'front') {
      // the back plane y = g.y, mapped so that local (x, v) = (x, -z)
      ctx.transform(1, 0, -SKEW, 1, 0, glass.y);
      stars(ctx, seed, glass.x0, -glass.z1, glass.x1 - glass.x0, glass.z1 - glass.z0);
    } else {
      // the side plane x = g.x, mapped so that local (u, v) = (y, -z)
      ctx.transform(0, 1, -SKEW, 1, glass.x, 0);
      stars(ctx, seed, glass.y0, -glass.z1, glass.y1 - glass.y0, glass.z1 - glass.z0);
    }
    ctx.restore();
  }
  det.draw(ctx);
  for (const f of glows) f();
}

// Furniture lives in furniture.ts; re-exported so existing imports keep working.
export { RACK_LEDS } from './furniture';
