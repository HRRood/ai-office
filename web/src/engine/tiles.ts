// Static office art in a 3/4 ("2.5D") perspective, generated in code.
//
// Two layers:
//   floor   – one canvas: floors, door thresholds, drop shadows, wall ambient occlusion
//   strips  – one canvas per tile row holding everything that stands up (walls, furniture).
//             Objects extend upward past their tile, so the renderer draws strips row by row,
//             interleaved with characters, to get correct occlusion (walk behind a desk, etc.).
import type { RoomId } from '../../../shared/rooms.config';
import { hash, type OfficeMap } from './map';

type Ctx = CanvasRenderingContext2D;

/** How far (px) the tallest object rises above its own tile. */
export const MAX_RISE = 16;
/** Wall height above the tile: the wall cap is drawn this many px higher than its tile. */
export const WALL_RISE = 12;

// A worn, lived-in station: muted metals, sand and rust tones.
const FLOORS: Record<RoomId | 'hall', string> = {
  library: '#4a3f33',
  research: '#34444a',
  serverRoom: '#262b35',
  mailroom: '#4a4436',
  reception: '#352f3c',
  openOffice: '#4a4a4c',
  workshop: '#2b303a',
  whiteboard: '#423e48',
  meeting: '#2e3440',
  lounge: '#553834',
  hall: '#4e4b46',
};

export function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(f >= 0 ? v + (255 - v) * f : v * (1 + f))));
  return `rgb(${ch(n >> 16)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

export interface MapLayers {
  floor: HTMLCanvasElement;
  /** strips[y] covers rows y-MAX_RISE/T .. y; draw it at (0, y*T - MAX_RISE). */
  strips: HTMLCanvasElement[];
}

const isWallish = (c: string) => c === '#' || c === 'V';
const isDoor = (c: string) => c === 'D' || c === 'E';
/** Secret door: a walkable gap disguised as a wall panel (no hazard stripes). */
const isSecret = (c: string) => c === 'X';
const isObject = (c: string) => !'.DEX'.includes(c);

export function renderLayers(map: OfficeMap): MapLayers {
  const T = map.tileSize;
  const floor = document.createElement('canvas');
  floor.width = map.w * T;
  floor.height = map.h * T;
  const fctx = floor.getContext('2d')!;

  // 1) floors everywhere (walls get floor underneath too, mostly hidden)
  for (let y = 0; y < map.h; y++)
    for (let x = 0; x < map.w; x++) {
      fctx.save();
      fctx.translate(x * T, y * T);
      const c = map.at(x, y);
      if (isDoor(c)) drawDoorFloor(fctx, map, x, y, c === 'E');
      else if (isSecret(c)) drawSecretDoorFloor(fctx);
      else drawFloor(fctx, map, x, y);
      fctx.restore();
    }
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
    strip.width = map.w * T;
    strip.height = T + MAX_RISE;
    const sctx = strip.getContext('2d')!;
    for (let x = 0; x < map.w; x++) {
      const c = map.at(x, y);
      if (!isObject(c)) continue;
      sctx.save();
      sctx.translate(x * T, MAX_RISE); // (0,0) = tile top-left; objects may draw at negative y
      if (c === '#') drawWall(sctx, map, x, y);
      else if (c === 'V') drawWindow(sctx, map, x, y);
      else drawFurniture(sctx, c, x, y, map);
      sctx.restore();
    }
    strips.push(strip);
  }
  return { floor, strips };
}

function r(ctx: Ctx, x: number, y: number, w: number, h: number, c: string) {
  ctx.fillStyle = c;
  ctx.fillRect(x, y, w, h);
}

/** A box seen from 3/4: top surface then front face. y = top of the box's top surface. */
function box(ctx: Ctx, x: number, y: number, w: number, topH: number, faceH: number, top: string, front: string) {
  r(ctx, x, y, w, topH, top);
  r(ctx, x, y, w, 1, shade(top, 0.25)); // back edge highlight
  r(ctx, x, y + topH, w, faceH, front);
  r(ctx, x, y + topH, w, 1, shade(front, 0.2)); // front edge highlight
  r(ctx, x, y + topH + faceH - 1, w, 1, shade(front, -0.35)); // base line
  r(ctx, x + w - 1, y, 1, topH + faceH, 'rgba(0,0,0,0.18)'); // right side in shade
}

// ---------------- floor layer ----------------

function drawFloor(ctx: Ctx, map: OfficeMap, x: number, y: number) {
  const room = map.roomAt(x, y);
  const base = FLOORS[room ?? 'hall'];
  r(ctx, 0, 0, 16, 16, base);
  const rnd = hash(x, y);
  const dark = shade(base, -0.22);
  const light = shade(base, 0.1);

  if (room === 'lounge' || room === 'reception') {
    // worn carpet
    for (let py = 0; py < 16; py += 2) for (let px = (py / 2) % 2; px < 16; px += 2) r(ctx, px, py, 1, 1, shade(base, -0.08));
  } else if (room === 'openOffice' || !room) {
    // corridor grating: slats over a dark gap, with a frame every tile
    r(ctx, 0, 0, 16, 16, shade(base, -0.35));
    for (let py = 1; py < 15; py += 3) {
      r(ctx, 1, py, 14, 2, base);
      r(ctx, 1, py, 14, 1, light);
    }
    r(ctx, 0, 0, 16, 1, dark);
    r(ctx, 0, 0, 1, 16, dark);
  } else if (room === 'meeting' || room === 'research' || room === 'whiteboard') {
    // offset deck plates (a staggered, hex-like pattern)
    const off = (y % 2) * 8;
    r(ctx, 0, 0, 16, 1, dark);
    r(ctx, (off + 0) % 16, 0, 1, 16, dark);
    r(ctx, (off + 8) % 16, 0, 1, 16, dark);
    r(ctx, 1, 1, 6, 1, light);
    r(ctx, 9, 1, 6, 1, light);
  } else if (room === 'library') {
    // scuffed plating with a worn path pattern
    r(ctx, 0, 0, 16, 1, dark);
    r(ctx, 0, 8, 16, 1, dark);
    r(ctx, (rnd % 2) * 8, 0, 1, 16, dark);
  } else {
    // heavy deck plates with bevels and rivets
    r(ctx, 0, 0, 16, 1, light);
    r(ctx, 0, 0, 1, 16, light);
    r(ctx, 0, 15, 16, 1, dark);
    r(ctx, 15, 0, 1, 16, dark);
    for (const [px, py] of [[2, 2], [13, 2], [2, 13], [13, 13]]) r(ctx, px, py, 1, 1, shade(base, -0.3));
    if (room === 'workshop' && y % 3 === 0) r(ctx, 0, 11, 16, 1, '#1b2028'); // cable trench
    if (room === 'serverRoom') {
      r(ctx, 7, 0, 1, 16, shade(base, 0.12));
      r(ctx, 0, 7, 16, 1, shade(base, 0.12));
    }
  }
  // grime, scuffs and the odd oil stain: this station has seen some use
  for (let i = 0; i < 3; i++) {
    const k = hash(rnd, i);
    r(ctx, k % 15, (k >> 4) % 15, 1, 1, 'rgba(0,0,0,0.18)');
  }
  if (rnd % 7 === 0) r(ctx, 3 + (rnd % 8), 3 + ((rnd >> 3) % 8), 3, 2, 'rgba(20,14,10,0.22)');
  if (rnd % 5 === 1) r(ctx, 2 + (rnd % 10), 4 + ((rnd >> 5) % 8), 3, 1, 'rgba(255,255,255,0.06)');
}

function drawDoorFloor(ctx: Ctx, map: OfficeMap, x: number, y: number, entrance: boolean) {
  r(ctx, 0, 0, 16, 16, '#3a3834');
  const blocked = (c: string) => isWallish(c) || isDoor(c);
  const vertical = blocked(map.at(x, y - 1)) || blocked(map.at(x, y + 1));
  // blast-door threshold: a recessed track with hazard chevrons on either side
  if (vertical) {
    r(ctx, 6, 0, 4, 16, '#22211f');
    r(ctx, 7, 0, 2, 16, '#141312');
    for (let i = 0; i < 16; i += 4) {
      r(ctx, 1, i, 4, 2, '#d9a53a');
      r(ctx, 11, i + 2, 4, 2, '#d9a53a');
    }
  } else {
    r(ctx, 0, 6, 16, 4, '#22211f');
    r(ctx, 0, 7, 16, 2, '#141312');
    for (let i = 0; i < 16; i += 4) {
      r(ctx, i, 1, 2, 4, '#d9a53a');
      r(ctx, i + 2, 11, 2, 4, '#d9a53a');
    }
  }
  if (entrance) {
    r(ctx, 1, 1, 2, 2, '#58e07a');
    r(ctx, 1, 13, 2, 2, '#58e07a');
  }
}

/** A wall panel slid aside: bulkhead-coloured plating with a dark passage seam and a faint glyph. */
function drawSecretDoorFloor(ctx: Ctx) {
  r(ctx, 0, 0, 16, 16, '#2d2f35');
  r(ctx, 0, 0, 3, 16, '#3d3f46'); // panel edge, slid into the left jamb
  r(ctx, 3, 0, 1, 16, '#1b1c20');
  r(ctx, 5, 0, 7, 16, '#1f2025'); // the passage
  r(ctx, 6, 0, 5, 16, '#17181c');
  r(ctx, 13, 0, 3, 16, '#3d3f46');
  r(ctx, 12, 0, 1, 16, '#1b1c20');
  r(ctx, 14, 6, 1, 1, '#b07cff'); // tiny glowing glyph only people in the know notice
  r(ctx, 14, 8, 1, 1, '#b07cff');
  r(ctx, 14, 7, 1, 1, 'rgba(176,124,255,0.4)');
}

/** Light comes from the top-left: shadows fall down and to the right. */
function drawFloorShading(ctx: Ctx, map: OfficeMap, x: number, y: number) {
  const c = map.at(x, y);
  if (isWallish(c)) return;
  if (isObject(c)) {
    // drop shadow of furniture onto the floor to its lower right
    const g = ctx.createLinearGradient(0, 12, 0, 20);
    g.addColorStop(0, 'rgba(0,0,0,0.32)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(2, 12, 16, 8);
    return;
  }
  // ambient occlusion where floor meets a wall
  if (isWallish(map.at(x, y - 1))) {
    const g = ctx.createLinearGradient(0, 0, 0, 7);
    g.addColorStop(0, 'rgba(0,0,0,0.42)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 16, 7);
  }
  if (isWallish(map.at(x - 1, y))) {
    const g = ctx.createLinearGradient(0, 0, 5, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.35)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 5, 16);
  }
  if (isWallish(map.at(x + 1, y))) {
    r(ctx, 15, 0, 1, 16, 'rgba(0,0,0,0.15)');
  }
}

// ---------------- walls ----------------

function drawWallCap(ctx: Ctx, map: OfficeMap, x: number, y: number) {
  const top = '#2d2f35';
  r(ctx, 0, -WALL_RISE, 16, 16, top);
  const edge = '#4a4d56';
  const up = map.at(x, y - 1);
  if (!isWallish(up)) r(ctx, 0, -WALL_RISE, 16, 1, edge);
  if (!isWallish(map.at(x - 1, y))) r(ctx, 0, -WALL_RISE, 1, 16, edge);
  if (!isWallish(map.at(x + 1, y))) r(ctx, 15, -WALL_RISE, 1, 16, '#1b1c20');
  // greebles: conduit runs and vents on top of the bulkheads
  const k = hash('cap', x, y);
  if (k % 3 === 0) {
    r(ctx, 0, -WALL_RISE + 5, 16, 2, '#3e4048');
    r(ctx, 0, -WALL_RISE + 5, 16, 1, '#555862');
  }
  if (k % 5 === 1) {
    r(ctx, 4, -WALL_RISE + 2, 6, 3, '#1f2025');
    for (let i = 0; i < 3; i++) r(ctx, 5 + i * 2, -WALL_RISE + 3, 1, 1, '#3a3c44');
  }
  r(ctx, 0, -WALL_RISE + 10, 16, 1, 'rgba(0,0,0,0.15)');
}

/** True when the tile below is open, so the wall shows its front face. */
const hasFace = (map: OfficeMap, x: number, y: number) => y < map.h - 1 && !isWallish(map.at(x, y + 1));

function drawWall(ctx: Ctx, map: OfficeMap, x: number, y: number) {
  drawWallCap(ctx, map, x, y);
  if (y === map.h - 1) r(ctx, 0, 16 - WALL_RISE, 16, WALL_RISE, '#2d2f35'); // close off the map's bottom edge
  if (!hasFace(map, x, y)) return;
  const faceTop = 16 - WALL_RISE; // face runs from the bottom of the cap to the floor
  const h = WALL_RISE;
  const k = hash('wall', x, y);
  // ribbed bulkhead panels
  r(ctx, 0, faceTop, 16, h, '#3d3f46');
  r(ctx, 0, faceTop, 16, 1, '#61646e'); // top lip catches the light
  r(ctx, 0, faceTop + 1, 16, 1, '#2a2c31');
  for (const rx of [3, 11]) {
    r(ctx, rx, faceTop + 2, 2, h - 4, '#34363c');
    r(ctx, rx, faceTop + 2, 1, h - 4, '#4b4e57');
  }
  // a pipe along some walls
  if (k % 4 === 0) {
    r(ctx, 0, faceTop + 3, 16, 2, '#56504a');
    r(ctx, 0, faceTop + 3, 16, 1, '#7a7268');
    r(ctx, 7, faceTop + 2, 2, 4, '#3a3530'); // clamp
  }
  // small control panel with blinking-ready lights, or a vent, or a warning stencil
  if (k % 7 === 2) {
    r(ctx, 5, faceTop + 3, 6, 5, '#1d1e22');
    r(ctx, 6, faceTop + 4, 1, 1, '#e8534a');
    r(ctx, 8, faceTop + 4, 1, 1, '#58e07a');
    r(ctx, 6, faceTop + 6, 4, 1, '#d9a53a');
  } else if (k % 7 === 4) {
    r(ctx, 6, faceTop + 4, 5, 4, '#26272c');
    for (let i = 0; i < 3; i++) r(ctx, 6, faceTop + 4 + i + i, 5, 1, '#1a1b1f');
  }
  // accent light strip (mostly warm, now and then cool)
  const lit = (x + y) % 3 === 0;
  const cool = k % 5 === 0;
  r(ctx, 0, faceTop + 8, 16, 1, lit ? (cool ? '#5fd4e0' : '#ffb35a') : cool ? '#2f7a84' : '#7a5530');
  if (lit) r(ctx, 0, faceTop + 9, 16, 1, cool ? 'rgba(95,212,224,0.22)' : 'rgba(255,179,90,0.2)');
  // rust streak under a seam
  if (k % 6 === 3) r(ctx, 12 + (k % 3), faceTop + 2, 1, 6, 'rgba(140,70,30,0.45)');
  // baseboard
  r(ctx, 0, 14, 16, 2, '#232428');
  // blast-door frame next to a doorway: angled hazard-striped jamb
  const doorLeft = isDoor(map.at(x - 1, y));
  const doorRight = isDoor(map.at(x + 1, y));
  if (doorLeft || doorRight) {
    const jx = doorLeft ? 0 : 12;
    r(ctx, jx, faceTop, 4, h, '#55524c');
    for (let i = 0; i < h; i += 3) r(ctx, jx + (doorLeft ? 0 : 1), faceTop + i, 3, 1, '#d9a53a');
    r(ctx, doorLeft ? 3 : 12, faceTop, 1, h, '#2a2926');
  }
  // darker where the wall ends next to an opening
  if (!isWallish(map.at(x - 1, y)) && !doorLeft) r(ctx, 0, faceTop, 1, h, '#4d5059');
  if (!isWallish(map.at(x + 1, y)) && !doorRight) r(ctx, 15, faceTop, 1, h, '#26272b');
}

function stars(ctx: Ctx, seed: number, x: number, y: number, w: number, h: number) {
  r(ctx, x, y, w, h, '#0b1026');
  for (let i = 0; i < 5; i++) {
    const s = hash(seed, i);
    r(ctx, x + (s % w), y + ((s >> 8) % h), 1, 1, i === 0 ? '#ffe9a8' : '#cfd8ff');
  }
  if (seed % 7 === 0 && w > 6 && h > 6) {
    r(ctx, x + 2, y + 2, 3, 3, '#c0763c');
    r(ctx, x + 2, y + 2, 1, 1, '#0b1026');
  }
}

function drawWindow(ctx: Ctx, map: OfficeMap, x: number, y: number) {
  drawWallCap(ctx, map, x, y);
  const seed = hash('star', x, y);
  if (hasFace(map, x, y)) {
    // tall viewport in the wall face (and up into the cap)
    const top = -WALL_RISE + 3;
    r(ctx, 0, top - 1, 16, 16 - top + 1, '#8a95aa');
    stars(ctx, seed, 1, top, 14, 14 - top);
    r(ctx, 0, 14, 16, 2, '#232733');
    // glass glint
    r(ctx, 2, top + 1, 1, 3, 'rgba(255,255,255,0.25)');
  } else if (isWallish(map.at(x - 1, y)) || isWallish(map.at(x + 1, y))) {
    // window in a horizontal wall seen from above (e.g. the bottom outer wall): horizontal glass strip
    if (y === map.h - 1) r(ctx, 0, 16 - WALL_RISE, 16, WALL_RISE, '#2c3140');
    r(ctx, 0, -WALL_RISE + 4, 16, 9, '#8a95aa');
    stars(ctx, seed, 0, -WALL_RISE + 5, 16, 7);
  } else {
    // window in a vertical wall seen from above: vertical glass strip
    r(ctx, 4, -WALL_RISE, 8, 16, '#8a95aa');
    stars(ctx, seed, 5, -WALL_RISE, 6, 16);
  }
}

// ---------------- furniture ----------------

function drawFurniture(ctx: Ctx, c: string, x: number, y: number, map?: OfficeMap) {
  const rnd = hash('f', x, y);
  switch (c) {
    case 'B': {
      // data-archive rack: slots of data cartridges with glowing tips
      box(ctx, 1, -14, 14, 3, 27, '#4a4a50', '#2a2a2f');
      r(ctx, 2, -10, 12, 24, '#18181c');
      const glow = ['#ffb35a', '#5fd4e0', '#e8534a', '#9be870'];
      for (const row of [-10, -2, 6]) {
        for (let i = 0; i < 6; i++) {
          const k = hash(rnd, row, i);
          if (k % 6 === 0) continue; // a missing cartridge
          r(ctx, 2 + i * 2, row + 1, 2, 6, k % 2 ? '#5a5650' : '#6a645a');
          r(ctx, 2 + i * 2, row + 1, 2, 1, glow[k % glow.length]);
        }
        r(ctx, 2, row + 7, 12, 1, '#3e3e44');
      }
      break;
    }
    case 'S': {
      // server rack / power cell bank: heavy casing, vents, cable bundle
      box(ctx, 1, -14, 14, 2, 29, '#44464e', '#17181c');
      r(ctx, 2, -11, 12, 25, '#202127');
      for (let i = 0; i < 6; i++) {
        r(ctx, 3, -10 + i * 4, 10, 3, '#2d2f37');
        r(ctx, 3, -10 + i * 4, 10, 1, '#3d4049');
        r(ctx, 4, -9 + i * 4, 5, 1, '#121316'); // vents
      }
      r(ctx, 13, -6, 1, 20, '#3a2a22'); // cable bundle
      r(ctx, 14, -2, 1, 16, '#2a3a26');
      break;
    }
    case 'M': {
      // stacked cargo crates with stencil marks and hazard stripes
      const crate = (cx: number, cy: number, w: number, hh: number, col: string) => {
        box(ctx, cx, cy, w, 2, hh, shade(col, 0.15), col);
        r(ctx, cx + 1, cy + 3, w - 2, 1, shade(col, -0.25));
        r(ctx, cx + 1, cy + 2 + hh - 2, w - 2, 1, shade(col, -0.25));
      };
      const k = hash(rnd, 'crate');
      crate(0, 2, 9, 11, k % 2 ? '#6b6250' : '#5a5f52');
      crate(8, 4, 8, 9, k % 3 ? '#7a5a3a' : '#5a5250');
      crate(2, -7, 7, 8, '#6a5a44');
      r(ctx, 3, 8, 3, 1, '#d9a53a'); // stencil marks
      r(ctx, 10, 9, 4, 1, '#e8e2d0');
      for (let i = 0; i < 7; i += 2) r(ctx, 2 + i, -2, 1, 1, '#d9a53a');
      break;
    }
    case 'd': {
      // console desk: angled control panel with chunky buttons, CRT-style monitor
      box(ctx, 0, 4, 16, 7, 5, '#8c8a86', '#55534f');
      r(ctx, 0, 11, 16, 1, '#3e3c39');
      r(ctx, 1, 15, 2, 1, '#2e2d2b');
      r(ctx, 13, 15, 2, 1, '#2e2d2b');
      // monitor housing (deep, rounded) with amber or green text
      r(ctx, 7, 3, 2, 4, '#2a2928'); // stand
      r(ctx, 5, 6, 6, 1, '#2a2928');
      r(ctx, 3, -5, 10, 9, '#262523'); // housing
      r(ctx, 3, -5, 10, 1, '#3a3936');
      const amber = rnd % 3 !== 0;
      r(ctx, 4, -4, 8, 6, amber ? '#2a1a08' : '#0a2410');
      const txt = amber ? '#ffb35a' : '#7dff9a';
      r(ctx, 5, -3, 5, 1, txt);
      r(ctx, 5, -1, 3, 1, txt);
      r(ctx, 5, 1, 6, 1, amber ? 'rgba(255,179,90,0.5)' : 'rgba(125,255,154,0.5)');
      // button panel + keyboard
      r(ctx, 3, 8, 8, 2, '#3a3936');
      r(ctx, 3, 8, 8, 1, '#4a4844');
      for (const [bx, col] of [[12, '#e8534a'], [13, '#d9a53a'], [14, '#58e07a']] as const) r(ctx, bx, 7, 1, 1, col);
      if (rnd % 2) r(ctx, 12, 9, 2, 2, '#6a645a'); // a mug that has seen better days
      break;
    }
    case 'T': {
      // metal table with a rounded lip
      box(ctx, 0, 2, 16, 9, 4, '#9a9690', '#5e5b56');
      r(ctx, 1, 3, 14, 1, 'rgba(255,255,255,0.12)');
      r(ctx, 1, 15, 2, 1, '#3a3836');
      r(ctx, 13, 15, 2, 1, '#3a3836');
      break;
    }
    case 'R': {
      // the manager's executive desk: dark wood, gold trim
      box(ctx, 0, -2, 16, 6, 12, '#6b4428', '#3b2416');
      r(ctx, 0, 8, 16, 1, '#c9a66b');
      r(ctx, 2, 6, 12, 1, '#4a2e1c');
      // The manager sits behind the right end of the desk: keep that tile low (papers + nameplate)
      // so nothing tall stands in front of him.
      const rightEnd = map ? map.at(x + 1, y) !== 'R' : false;
      const k = rightEnd ? 2 : hash('desk', x) % 2;
      if (k === 0) {
        // desk lamp
        r(ctx, 3, -6, 1, 5, '#c9a66b');
        r(ctx, 1, -8, 5, 2, '#2f6b4a');
      } else if (k === 1) {
        // holo-display
        ctx.globalAlpha = 0.6;
        r(ctx, 4, -9, 8, 6, '#4ff0ff');
        ctx.globalAlpha = 1;
        r(ctx, 5, -8, 4, 1, '#e0ffff');
        r(ctx, 5, -6, 6, 1, '#e0ffff');
        r(ctx, 7, -3, 2, 1, '#2a303c');
      } else {
        // papers + a gold nameplate
        r(ctx, 2, -1, 5, 3, '#f4f6fa');
        r(ctx, 9, 0, 5, 2, '#e5b83b');
      }
      break;
    }
    case 'P': {
      // alien plant in a pot
      box(ctx, 4, 9, 8, 2, 5, '#9a7a5e', '#7a5a44');
      const leaf = rnd % 2 ? '#58b368' : '#7a6fd6';
      r(ctx, 2, 1, 4, 8, leaf);
      r(ctx, 10, 0, 4, 9, shade(leaf, -0.1));
      r(ctx, 5, -6, 6, 15, shade(leaf, 0.12));
      r(ctx, 6, -6, 2, 10, shade(leaf, 0.3));
      r(ctx, 7, -8, 2, 2, '#f2d13d');
      break;
    }
    case 's': {
      // sofa: backrest + seat
      box(ctx, 0, -3, 16, 2, 7, '#7e45b0', '#5e2f8e');
      box(ctx, 0, 5, 16, 5, 5, '#a46ad6', '#6e3a9e');
      r(ctx, 7, 5, 1, 5, '#8a4fbf');
      break;
    }
    case 'W': {
      // whiteboard on legs
      r(ctx, 2, 8, 1, 8, '#7a8599');
      r(ctx, 13, 8, 1, 8, '#7a8599');
      r(ctx, 0, -9, 16, 17, '#9aa3b3');
      r(ctx, 1, -8, 14, 14, '#f4f6fa');
      const ink = ['#e8534a', '#3aa7e0', '#2fb39a'][rnd % 3];
      r(ctx, 2, -6 + (rnd % 2), 8, 1, ink);
      r(ctx, 3, -3, 10, 1, ink);
      r(ctx, 2, 0, 5, 1, '#555');
      r(ctx, 3, 2, 7, 1, '#555');
      if (rnd % 2) {
        r(ctx, 11, -6, 3, 3, ink);
        r(ctx, 12, -5, 1, 1, '#f4f6fa');
      }
      r(ctx, 0, 6, 16, 2, '#7a8599'); // marker tray
      break;
    }
    case 'K': {
      // coffee machine
      box(ctx, 2, -9, 12, 2, 22, '#444b5c', '#2b2f3a');
      r(ctx, 4, -5, 8, 4, '#151820');
      r(ctx, 5, -4, 4, 2, '#58e07a'); // display
      r(ctx, 11, -4, 1, 1, '#e8534a');
      r(ctx, 5, 3, 6, 8, '#151820');
      r(ctx, 6, 7, 4, 4, '#f4f6fa');
      r(ctx, 6, 7, 4, 1, '#6b3f1d');
      break;
    }
    case 'J': {
      // jukebox: rounded top, light bands (animated in the evening by the renderer), speaker grille
      box(ctx, 2, -10, 12, 2, 24, '#7a3b8f', '#4a1f5c');
      r(ctx, 3, -11, 10, 2, '#7a3b8f');
      r(ctx, 4, -12, 8, 1, '#9a55b0');
      r(ctx, 4, -8, 8, 6, '#1a0f22'); // record window
      r(ctx, 6, -7, 4, 4, '#2a2a33');
      r(ctx, 7, -6, 2, 2, '#e8534a');
      for (const [i, c] of ['#f2d13d', '#e05fae', '#53c7d6'].entries()) r(ctx, 3, -1 + i * 2, 10, 1, c);
      for (let gy = 6; gy < 12; gy += 2) r(ctx, 4, gy, 8, 1, '#2e1838'); // grille
      break;
    }
    case 'Q': {
      // beer taps on a bar counter, with a full mug
      box(ctx, 0, 2, 16, 6, 8, '#8a5a3a', '#5a3a24');
      r(ctx, 0, 11, 16, 1, '#c9a66b'); // brass rail
      for (const tx of [3, 7]) {
        r(ctx, tx, -4, 2, 7, '#c9ced8'); // chrome tap
        r(ctx, tx, -5, 2, 1, '#eef0f4');
        r(ctx, tx - 1, -7, 4, 2, tx === 3 ? '#e8534a' : '#3aa7e0'); // handle
      }
      r(ctx, 11, -1, 4, 5, '#f2b13d'); // mug
      r(ctx, 11, -2, 4, 2, '#fffbe8'); // foam
      r(ctx, 15, 0, 1, 3, '#d8dde6'); // handle
      break;
    }
    case 'F': {
      // fridge
      box(ctx, 2, -14, 12, 2, 28, '#ffffff', '#dde2ea');
      r(ctx, 2, -3, 12, 1, '#9aa3b3');
      r(ctx, 11, -9, 1, 4, '#9aa3b3');
      r(ctx, 11, 0, 1, 6, '#9aa3b3');
      break;
    }
    case 'H': {
      // holo-projector pad: a faint cone of light with a small ringed planet floating in it
      box(ctx, 3, 9, 10, 2, 4, '#4a4c54', '#2c2e34');
      r(ctx, 4, 9, 8, 1, '#5fd4e0');
      r(ctx, 5, 10, 1, 1, '#d9a53a');
      r(ctx, 10, 10, 1, 1, '#d9a53a');
      ctx.globalAlpha = 0.18;
      r(ctx, 5, -6, 6, 15, '#6fe6ff');
      ctx.globalAlpha = 0.75;
      r(ctx, 6, -5, 4, 4, '#6fd0ff'); // planet
      r(ctx, 6, -5, 2, 2, '#bff2ff');
      r(ctx, 4, -3, 8, 1, '#a0f0ff'); // ring
      ctx.globalAlpha = 1;
      break;
    }
    case 'A': {
      // comm dish on a pole
      box(ctx, 4, 12, 8, 1, 3, '#4a5366', '#3a4252');
      r(ctx, 7, 0, 2, 12, '#7a8599');
      r(ctx, 1, -9, 14, 9, '#d6dbe4');
      r(ctx, 3, -8, 10, 7, '#aab3c2');
      r(ctx, 1, -1, 14, 1, '#9aa3b3');
      r(ctx, 7, -12, 2, 5, '#7a8599');
      r(ctx, 7, -13, 2, 1, '#e8534a');
      break;
    }
  }
}

/** Where the blinking LEDs sit on a server rack, relative to the tile's top-left. */
export const RACK_LEDS: Array<[number, number]> = [-9, -5, -1, 3, 7, 11].map((y) => [11, y] as [number, number]);
