// Furniture art: everything that stands on a tile (desks, racks, plants, beds...).
// Drawn into the per-row strips by tiles.ts. Coordinates are art units: (0,0) is the tile's top-left
// on the floor, a tile is 16 x 16, and objects may rise above it (negative screen y, up to -MAX_RISE).
//
// Every piece is a real low-poly 3D model built with mesh.ts (world: x right, y toward the viewer,
// z up; screen = (x + SKEW·z, y − z)). Rule of thumb for the height budget: a point at floor depth y
// and height z lands at screen y − z, which must stay above −16.
//
// Flat details that sit on a front-facing plane (screen text, whiteboard ink, stencils) are drawn in
// 2D through `onPlane()`, which shears the context onto that plane, so they follow the camera skew.
// Runs of the same piece (desk rows, tables, sofas, the whiteboard wall) are one continuous mesh,
// clipped per tile, so neighbours meet seamlessly.
import { hash, type OfficeMap } from './map';
import { mix, shade, softShadow } from './lowpoly';
import { Mesh, project, SKEW, type FaceOpts, type V3 } from './mesh';

type Ctx = CanvasRenderingContext2D;

// ---------------------------------------------------------------------------------------------
// local helpers

/** A prism of `sides` faces from a to b (rods, struts, cables, arms). */
function rod(m: Mesh, a: V3, b: V3, r: number, color: string, o: FaceOpts = {}, sides = 5) {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  const n: V3 = [d[0] / l, d[1] / l, d[2] / l];
  const ref: V3 = Math.abs(n[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  let u: V3 = [n[1] * ref[2] - n[2] * ref[1], n[2] * ref[0] - n[0] * ref[2], n[0] * ref[1] - n[1] * ref[0]];
  const ul = Math.hypot(u[0], u[1], u[2]) || 1;
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v: V3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  const ring = (p: V3) =>
    Array.from({ length: sides }, (_, i) => {
      const t = (i / sides) * Math.PI * 2 + 0.4;
      const c = Math.cos(t) * r;
      const s = Math.sin(t) * r;
      return [p[0] + u[0] * c + v[0] * s, p[1] + u[1] * c + v[1] * s, p[2] + u[2] * c + v[2] * s] as V3;
    });
  const ra = ring(a);
  const rb = ring(b);
  const polys: V3[][] = [ra, rb];
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    polys.push([ra[i], ra[j], rb[j], rb[i]]);
  }
  m.solid(polys, color, o);
}

/** A leaf blade from `base` to `tip`, folded along its spine (two two-sided facets). */
function blade(m: Mesh, base: V3, tip: V3, w: number, col: string, o: FaceOpts = {}) {
  const d: V3 = [tip[0] - base[0], tip[1] - base[1], tip[2] - base[2]];
  const hl = Math.hypot(d[0], d[1]) || 1;
  // horizontal perpendicular, so the blade lies "flat" and its fold opens upward
  const px = -d[1] / hl;
  const py = d[0] / hl;
  const mid: V3 = [base[0] + d[0] * 0.45, base[1] + d[1] * 0.45, base[2] + d[2] * 0.45 + w * 0.25];
  const l: V3 = [mid[0] + px * w, mid[1] + py * w, mid[2] - w * 0.35];
  const r: V3 = [mid[0] - px * w, mid[1] - py * w, mid[2] - w * 0.35];
  m.face([base, l, tip], col, o);
  m.face([base, tip, r], shade(col, -0.06), o);
}

/**
 * Draw flat 2D detail onto the front-facing plane y = Y. Inside `draw`, x is world x and the vertical
 * coordinate is −z (so 2D code that grows downward keeps working); the camera skew is applied for you.
 */
function onPlane(ctx: Ctx, Y: number, draw: () => void) {
  ctx.save();
  ctx.transform(1, 0, -SKEW, 1, 0, Y);
  draw();
  ctx.restore();
}

/** Fill a 2D polygon. */
function poly(ctx: Ctx, pts: Array<[number, number]>, fill: string) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

/** A short slanted bar (screen text, labels). */
function bar(ctx: Ctx, x: number, y: number, w: number, h: number, fill: string) {
  const c = h * 0.5;
  poly(ctx, [[x + c, y], [x + w, y], [x + w - c, y + h], [x, y + h]], fill);
}

/** Soft additive-looking halo for lamps and screens, at a world point. */
function halo(ctx: Ctx, at: V3, r: number, rgb: string, a = 0.3) {
  const [cx, cy] = project(at);
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, `rgba(${rgb},${a})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

/** Tapered contact shadow under a run, with slanted ends where the run stops. */
function bandShadow(ctx: Ctx, l: boolean, r: boolean, y0: number, y1: number, alpha = 0.32) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, `rgba(0,0,0,${alpha})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  const xa = l ? -1 : 0.5;
  const xb = r ? 17 : 16;
  ctx.beginPath();
  ctx.moveTo(xa, y0);
  ctx.lineTo(xb, y0);
  ctx.lineTo(r ? xb : xb - 0.6, y1);
  ctx.lineTo(l ? xa : xa + 0.6, y1);
  ctx.closePath();
  ctx.fill();
}

/**
 * Runs of the same piece: draw one long body (x0, w extend past joined edges), clipped to this tile,
 * so neighbours meet seamlessly. `l` / `r` tell whether the left / right neighbour is the same piece.
 */
function span(
  ctx: Ctx,
  map: OfficeMap | undefined,
  c: string,
  x: number,
  y: number,
  draw: (x0: number, w: number, l: boolean, r: boolean) => void,
) {
  const l = map?.at(x - 1, y) === c;
  const r = map?.at(x + 1, y) === c;
  ctx.save();
  if (l || r) {
    const cx0 = l ? 0 : -4;
    const cx1 = r ? 16 : 20;
    ctx.beginPath();
    ctx.rect(cx0, -16, cx1 - cx0, 34);
    ctx.clip();
  }
  const x0 = l ? -6 : 0;
  const x1 = r ? 22 : 16;
  draw(x0, x1 - x0, l, r);
  ctx.restore();
}

const GLOW = ['#ffb35a', '#5fd4e0', '#e8734a', '#9be870'];

// ---- anchors the renderer animates on top of the baked art (screen art units, tile top-left) ----

/** Server rack blade heights (z of each blade's bottom), top blade last. */
const BLADE_Z = [0, 1, 2, 3, 4, 5].map((i) => 2.1 + i * 3.25);
const BLADE_FRONT = 15.3;
/** Where the blinking LEDs sit on a server rack: top-left of a 1x1 cell centred on the LED. */
export const RACK_LEDS: Array<[number, number]> = BLADE_Z.map((z) => {
  const [sx, sy] = project([11.9, BLADE_FRONT + 0.12, z + 1.4]);
  return [sx - 0.5, sy - 0.5] as [number, number];
}).reverse();

const JUKE_FRONT = 15.3;
const JUKE_BAND_Z = [11.6, 10.1, 8.6];
/** Jukebox light bands, top to bottom: [x, y, w, h] in screen art units (renderer recolours them). */
export const JUKE_BANDS: Array<[number, number, number, number]> = JUKE_BAND_Z.map((z) => {
  const [sx, sy] = project([3.4, JUKE_FRONT + 0.05, z + 0.9]);
  return [sx, sy, 9.2, 0.9] as [number, number, number, number];
});
const JUKE_REC: V3 = [8, JUKE_FRONT + 0.5, 15.4];
/** Centre and radius of the jukebox record's label (screen art units); the renderer spins it. */
export const JUKE_RECORD: [number, number, number] = [...project(JUKE_REC), 0.85];

/** Holo pad scan range: centre x and the top / bottom screen y of the light cone. */
export const HOLO_SCAN = { x: 7.1, top: -5.2, bottom: 8.8 };

// ---------------------------------------------------------------------------------------------

export function drawFurniture(ctx: Ctx, c: string, x: number, y: number, map?: OfficeMap) {
  const rnd = hash('f', x, y);
  const m = new Mesh(rnd % 997);
  switch (c) {
    case 'B': {
      // data-archive rack: an open steel shelving unit, three bays of cartridges with glowing tips
      softShadow(ctx, 8, 15.2, 8.5, 1.6, 0.4);
      const steel = rnd % 3 === 0 ? '#4f4b46' : '#4a4c53';
      const dark = shade(steel, -0.45);
      m.box(1.4, 9.4, 0, 13.2, 5.2, 0.9, '#17171b'); // kick plinth
      m.box(2.2, 9, 0.9, 11.6, 0.9, 21.4, '#1b1c21', { jitter: 0.02 }); // back panel
      m.box(1, 9, 0, 1.3, 6.2, 22.3, steel, { chamfer: 0.35 });
      m.box(13.7, 9, 0, 1.3, 6.2, 22.3, steel, { chamfer: 0.35 });
      m.box(0.7, 8.7, 22.3, 14.6, 6.8, 1.1, shade(steel, 0.08), { bevel: 0.5, bevelH: 0.5, layer: 2 });
      for (let bay = 0; bay < 3; bay++) {
        const z0 = 0.9 + bay * 7.1;
        m.box(2.3, 9.8, z0, 11.4, 5.4, 0.55, shade(steel, 0.12), { bevel: 0.15 });
        let cx = 2.9;
        for (let i = 0; i < 4; i++) {
          const k = hash(rnd, bay, i);
          const cw = 2.25;
          if (k % 7 !== 0) {
            const h = 5 + (k % 5) * 0.3;
            const body = ['#6a645a', '#5a5650', '#77705f', '#5d6066'][k % 4];
            const zb = z0 + 0.55;
            m.push();
            if (k % 11 === 0) {
              // the odd cartridge leans on its neighbour
              m.translate(cx, 11, zb).rotateY(0.16).translate(-cx, -11, -zb);
            }
            m.box(cx, 10.6, zb, cw, 3.8, h - 0.7, body, { chamfer: 0.25, layer: 1 });
            m.box(cx, 10.6, zb + h - 0.7, cw, 3.8, 0.7, GLOW[k % GLOW.length], { emissive: true, chamfer: 0.25, layer: 1 });
            m.pop();
          }
          cx += cw + 0.42;
        }
        // shelf lip in front
        m.box(2.3, 15, z0 - 0.1, 11.4, 0.35, 0.7, dark, { layer: 2 });
      }
      m.draw(ctx);
      halo(ctx, [8, 13, 12], 7, '255,190,120', 0.08);
      break;
    }
    case 'S': {
      // server rack: heavy casing, six blades with vents and an LED bay each, cables down the side
      softShadow(ctx, 8, 15.2, 8.5, 1.6, 0.42);
      const casing = rnd % 4 === 0 ? '#4b4743' : '#44464e';
      m.box(1.5, 9.4, 0, 13, 5.2, 0.9, '#141519');
      m.box(1, 9, 0.8, 14, 6, 21.8, casing, { chamfer: 0.6, bevel: 0.6 });
      // top vent strip
      m.box(3, 10.4, 22.6, 10, 2.8, 0.25, shade(casing, -0.35));
      const blank = rnd % 5 === 0 ? rnd % 6 : -1;
      BLADE_Z.forEach((zb, i) => {
        m.box(2.1, 14.4, zb, 11.8, BLADE_FRONT - 14.4, 2.8, '#2f3139', { bevel: 0.25, bevelH: 0.25, layer: 1 });
        // LED bay: the renderer blinks an LED at RACK_LEDS
        m.box(10.6, BLADE_FRONT, zb + 0.45, 2.6, 0.1, 1.9, '#0d0f13', { jitter: 0, layer: 2 });
        if (i === blank) {
          // an empty slot plate with a hazard stripe
          m.box(2.8, BLADE_FRONT, zb + 0.5, 7.2, 0.12, 1.8, '#c98f2e', { jitter: 0, layer: 2 });
        }
      });
      m.box(1.6, 14.9, 0.8, 0.4, 0.5, 21.4, shade(casing, 0.2), { layer: 1 }); // rail
      // cable bundle hanging down the right side
      rod(m, [15.2, 14.6, 12], [15.3, 15.2, 0.4], 0.42, '#2f4a2c', { layer: 3 });
      rod(m, [14.6, 15.2, 17], [14.9, 15.5, 0.4], 0.45, '#6a3a26', { layer: 3 });
      m.draw(ctx);
      onPlane(ctx, BLADE_FRONT + 0.12, () => {
        BLADE_Z.forEach((zb, i) => {
          if (i === blank) {
            for (let s = 0; s < 3; s++) {
              const sx = 3.4 + s * 2.2;
              poly(ctx, [[sx, -zb - 2], [sx + 1.1, -zb - 2], [sx + 0.5, -zb - 0.6], [sx - 0.6, -zb - 0.6]], '#2a2216');
            }
            return;
          }
          for (let s = 0; s < 4; s++) {
            const sx = 3.6 + s * 1.55;
            poly(ctx, [[sx, -zb - 2.2], [sx + 0.9, -zb - 2.2], [sx + 0.4, -zb - 0.6], [sx - 0.5, -zb - 0.6]], '#15161b');
          }
          poly(ctx, [[11.4, -zb - 1.9], [12.4, -zb - 1.9], [12.4, -zb - 0.9], [11.4, -zb - 0.9]], '#16302a');
        });
      });
      halo(ctx, [11.5, 15, 11], 6, '90,230,140', 0.06);
      break;
    }
    case 'M': {
      // stacked cargo crates: chamfered, bevelled boxes with corner plates, stencils and hazard stripes
      softShadow(ctx, 8.5, 14.8, 8.5, 1.8, 0.4);
      const k = hash(rnd, 'crate');
      const colA = k % 2 ? '#6b6250' : '#5a5f52';
      const colB = k % 3 ? '#7a5a3a' : '#5a5250';
      const colC = k % 5 === 0 ? '#5e6a6a' : '#6a5a44';
      const crate = (cx: number, cy: number, cz: number, w: number, d: number, h: number, col: string, layer: number) => {
        m.box(cx, cy, cz, w, d, h, col, { chamfer: 0.6, bevel: 0.6, layer });
        // corner posts
        const p = shade(col, -0.3);
        m.box(cx - 0.15, cy + d - 1.1, cz, 1.2, 1.25, h - 0.4, p, { chamfer: 0.2, layer: layer + 1 });
        m.box(cx + w - 1.05, cy + d - 1.1, cz, 1.2, 1.25, h - 0.4, p, { chamfer: 0.2, layer: layer + 1 });
      };
      crate(0.6, 5.6, 0, 8.4, 9.2, 10, colA, 0);
      crate(1.6, 6.6, 10, 6.6, 6.6, 6, colC, 2);
      crate(8.6, 8, 0, 7, 7, 8, colB, 4);
      if (k % 3 === 0) m.box(10, 9, 8, 4.6, 4, 2.4, '#6f6656', { chamfer: 0.4, bevel: 0.4, layer: 6 }); // a small parcel
      m.draw(ctx);
      // chevron stencil on the big crate, a label plate on the front crate, hazard band on the top one
      onPlane(ctx, 14.82, () => {
        poly(ctx, [[2.6, -7.2], [4.6, -5.6], [6.6, -7.2], [6.6, -5.8], [4.6, -4.2], [2.6, -5.8]], '#d9a53a');
      });
      onPlane(ctx, 15.02, () => {
        poly(ctx, [[10.2, -6.2], [14, -6.4], [14.1, -4], [10.3, -3.8]], '#d8d0bc');
        bar(ctx, 10.8, -5.4, 2.6, 0.8, '#5a5040');
      });
      onPlane(ctx, 13.22, () => {
        for (let i = 0; i < 4; i++) {
          const sx = 2.9 + i * 1.6;
          poly(ctx, [[sx, -14], [sx + 0.8, -14], [sx + 1.5, -12.8], [sx + 0.7, -12.8]], '#d9a53a');
        }
      });
      break;
    }
    case 'd': {
      // console desk: one long top per row, a pedestal per seat, a deep monitor, keyboard and buttons
      const pd = 1.9 + (rnd % 3) * 0.3;
      const ped = new Mesh(rnd + 1);
      ped.box(pd, 9.8, 0, 4.4, 4.7, 4.2, '#77746f', { chamfer: 0.25 });
      ped.box(pd + 0.3, 14.5, 0.4, 3.8, 0.25, 1.6, '#5a5854', { layer: 1 });
      ped.box(pd + 0.3, 14.5, 2.3, 3.8, 0.25, 1.6, '#5a5854', { layer: 1 });
      ped.box(pd + 1.5, 14.7, 1.0, 1.4, 0.3, 0.35, '#2e2d2b', { jitter: 0, layer: 2 });
      ped.box(pd + 1.5, 14.7, 2.9, 1.4, 0.3, 0.35, '#2e2d2b', { jitter: 0, layer: 2 });
      span(ctx, map, 'd', x, y, (x0, w, l, r) => {
        bandShadow(ctx, l, r, 14.2, 16.4, 0.34);
        const s = new Mesh(7);
        s.box(x0 + 0.4, 9.1, 0.5, w - 0.8, 0.7, 3.7, '#5e5c58'); // modesty panel
        s.draw(ctx);
        ped.draw(ctx);
        const t = new Mesh(8);
        if (!l) t.box(0.5, 8.9, 0, 1.3, 5.9, 4.2, '#6e6b66', { chamfer: 0.25 });
        if (!r) t.box(14.2, 8.9, 0, 1.3, 5.9, 4.2, '#6e6b66', { chamfer: 0.25 });
        t.box(x0, 8.5, 4.2, w, 6.5, 0.8, '#8a8782', { bevel: 0.35, bevelH: 0.3, layer: 1 });
        t.draw(ctx);
      });
      // monitor: weighted foot, neck, deep chamfered housing
      m.box(5.8, 9.6, 5, 4.4, 2.4, 0.45, '#2a2928', { bevel: 0.25, chamfer: 0.4 });
      m.box(7.4, 9.9, 5.4, 1.2, 0.9, 3, '#3a3936', { chamfer: 0.25, layer: 1 });
      m.box(3, 9.6, 8, 10, 1.4, 7, '#2b2a28', { chamfer: 0.45, bevel: 0.4, layer: 2 });
      const amber = rnd % 3 !== 0;
      const scr = amber ? '#2a1a08' : '#0a2410';
      const txt = amber ? '#ffb35a' : '#7dff9a';
      const dim = amber ? 'rgba(255,179,90,0.45)' : 'rgba(125,255,154,0.45)';
      m.face([[3.8, 11.02, 8.8], [12.2, 11.02, 8.8], [12.2, 11.02, 14.2], [3.8, 11.02, 14.2]], scr, { emissive: true, layer: 3 });
      // keyboard with two raised key rows
      m.box(3.6, 11.9, 5, 7.2, 2.4, 0.45, '#34332f', { bevel: 0.15 });
      m.box(4, 12.2, 5.45, 6.4, 0.75, 0.2, '#4d4b46', { jitter: 0.02 });
      m.box(4, 13.15, 5.45, 6.4, 0.75, 0.2, '#45433f', { jitter: 0.02 });
      // chunky buttons
      for (const [i, col] of ['#e8534a', '#d9a53a', '#58e07a'].entries())
        m.cylinder(12.2 + i * 1.3, 13.4, 5, 0.6, 0.48, 0.55, 6, col, { topColor: shade(col, 0.15) });
      if (rnd % 2) {
        // a mug that has seen better days
        m.cylinder(13.4, 10.6, 5, 0.95, 1.05, 2.3, 7, '#6a645a', { topColor: '#3b2416' });
        rod(m, [14.4, 10.9, 6.6], [14.9, 11.0, 5.9], 0.25, '#5a554c', {}, 4);
      }
      m.draw(ctx);
      halo(ctx, [8, 11, 11.5], 5.4, amber ? '255,179,90' : '125,255,154', 0.18);
      onPlane(ctx, 11.04, () => {
        // screen content in plane units: x is world x, y is -z (screen spans -14.2 .. -8.8)
        bar(ctx, 4.5, -13.6, 3.8 + (rnd % 2), 0.9, txt);
        bar(ctx, 4.5, -12.1, 2.6, 0.9, dim);
        bar(ctx, 4.5, -10.6, 3.4, 0.9, dim);
        for (let i = 0; i < 3; i++) {
          const h = 1 + ((rnd >> (i * 3)) % 4) * 0.5;
          poly(ctx, [[9.2 + i * 0.8, -9.4 - h], [9.8 + i * 0.8, -9.4 - h], [9.8 + i * 0.8, -9.4], [9.2 + i * 0.8, -9.4]], txt);
        }
        poly(ctx, [[4.4, -14.2], [7.6, -14.2], [4.4, -10.4], [3.8, -10.4], [3.8, -13.6]], 'rgba(255,255,255,0.06)'); // glass sheen
        if (rnd % 5 === 0) poly(ctx, [[11, -15.2], [13.2, -15], [13.1, -12.8], [10.9, -13]], '#e8cf5a'); // sticky note
      });
      break;
    }
    case 'T': {
      // metal table: one long top per run, inset panel, apron and legs at the ends
      span(ctx, map, 'T', x, y, (x0, w, l, r) => {
        bandShadow(ctx, l, r, 13.6, 16, 0.3);
        const bx0 = l ? x0 : x0 + 1.1;
        const bx1 = r ? x0 + w : x0 + w - 1.1;
        const leg = (lx: number) => {
          m.box(lx, 7.7, 0, 1.2, 1.2, 4.2, '#4a4846', { chamfer: 0.3 });
          m.box(lx, 12.1, 0, 1.2, 1.2, 4.2, '#3f3d3b', { chamfer: 0.3 });
        };
        if (!l) leg(1.1);
        if (!r) leg(13.7);
        m.box(bx0, 8, 3.3, bx1 - bx0, 5.4, 0.9, '#7a7670');
        m.box(x0, 7, 4.2, w, 7, 0.8, '#9a9690', { bevel: 0.4, bevelH: 0.3 });
        m.box(l ? x0 : x0 + 1.4, 8.2, 5, (r ? x0 + w : x0 + w - 1.4) - (l ? x0 : x0 + 1.4), 4.6, 0.1, '#a9a59e', { jitter: 0.02, layer: 1 });
        m.draw(ctx);
      });
      if (rnd % 4 === 0) {
        // a stray datapad
        const p = new Mesh(rnd);
        p.translate(5.6, 10.2, 5.1).rotateZ(-0.18);
        p.box(-1.8, -1.3, 0, 3.6, 2.6, 0.3, '#3a3d44', { bevel: 0.1 });
        p.face([[-1.4, -1, 0.31], [1.4, -1, 0.31], [1.4, 1, 0.31], [-1.4, 1, 0.31]], '#7fd6e8', { emissive: true });
        p.draw(ctx);
      }
      break;
    }
    case 'R': {
      // the manager's executive desk: dark wood, leather inlay, gold trim, panelled front
      span(ctx, map, 'R', x, y, (x0, w, l, r) => {
        bandShadow(ctx, l, r, 14.6, 16.4, 0.36);
        const bx0 = l ? x0 : x0 + 0.5;
        const bx1 = r ? x0 + w : x0 + w - 0.5;
        const s = new Mesh(11);
        s.box(bx0 + 0.3, 6.6, 0, bx1 - bx0 - 0.6, 8.4, 0.8, '#24160d');
        s.box(bx0, 6.2, 0.8, bx1 - bx0, 9, 6.4, '#6b4428', { chamfer: l || r ? 0 : 0.3 });
        s.box(bx0, 15.2, 5.6, bx1 - bx0, 0.25, 0.7, '#e0c084', { jitter: 0.01 });
        s.box(x0, 5.8, 7.2, w, 9.8, 0.9, '#7a4e2e', { bevel: 0.45, bevelH: 0.35 });
        s.box(l ? x0 : x0 + 1.4, 6.6, 8.1, (r ? x0 + w : x0 + w - 1.4) - (l ? x0 : x0 + 1.4), 4.8, 0.12, '#2f4a3a', { jitter: 0.015, layer: 1 });
        s.draw(ctx);
      });
      // raised panels on the front
      m.box(1.4, 15.2, 1.6, 6, 0.3, 3.4, '#5e3a22', { bevel: 0.2 });
      m.box(8.6, 15.2, 1.6, 6, 0.3, 3.4, '#5e3a22', { bevel: 0.2 });
      m.draw(ctx);
      // The manager sits behind the right end of the desk: keep that tile low (papers + nameplate)
      // so nothing tall stands in front of him.
      const rightEnd = map ? map.at(x + 1, y) !== 'R' : false;
      const k = rightEnd ? 2 : hash('desk', x) % 2;
      const top = 8.1;
      const o = new Mesh(rnd + 1);
      if (k === 0) {
        // desk lamp: gold base and arm, green faceted shade, warm pool of light
        ctx.fillStyle = 'rgba(255,205,130,0.16)';
        ctx.beginPath();
        const [px, py] = project([5, 10.4, top]);
        ctx.ellipse(px, py, 4, 1.8, 0, 0, Math.PI * 2);
        ctx.fill();
        o.cylinder(3.2, 9.4, top, 1.5, 1.2, 0.6, 7, '#c9a66b');
        rod(o, [3.2, 9.4, top + 0.5], [3.6, 9.2, top + 5.6], 0.32, '#c9a66b', {}, 4);
        rod(o, [3.6, 9.2, top + 5.6], [5.2, 9.8, top + 6], 0.3, '#c9a66b', {}, 4);
        o.cylinder(5.4, 9.9, top + 3.6, 2.6, 1.1, 2.8, 6, '#2f6b4a', { topColor: '#24543a' });
        o.cylinder(5.4, 9.9, top + 3.3, 2.2, 2.2, 0.3, 6, '#ffd08a', { emissive: true });
        o.draw(ctx);
        halo(ctx, [5.4, 9.9, top + 3.4], 4, '255,200,120', 0.3);
      } else if (k === 1) {
        // holo-display: emitter, beam, floating translucent panel
        o.box(6.2, 8.4, top, 3.6, 1.6, 0.9, '#2a303c', { chamfer: 0.4, bevel: 0.2 });
        o.cylinder(8, 9.2, top + 0.9, 0.9, 0.7, 0.3, 6, '#9ff6ff', { emissive: true });
        o.face([[7, 9.2, top + 1.2], [9, 9.2, top + 1.2], [12, 9.2, top + 3.4], [4, 9.2, top + 3.4]], '#4ff0ff', { emissive: true, alpha: 0.12 });
        o.face([[4, 9.2, top + 3.4], [12, 9.2, top + 3.4], [12, 9.2, top + 9.6], [4, 9.2, top + 9.2]], '#4ff0ff', { emissive: true, alpha: 0.3 });
        o.face([[4, 9.2, top + 9.2], [12, 9.2, top + 9.6], [12, 9.2, top + 10.2], [4, 9.2, top + 9.8]], '#c8ffff', { emissive: true, alpha: 0.45 });
        o.draw(ctx);
        onPlane(ctx, 9.21, () => {
          bar(ctx, 5, -top - 8.2, 4, 0.9, 'rgba(224,255,255,0.85)');
          bar(ctx, 5, -top - 6.6, 6, 0.9, 'rgba(224,255,255,0.6)');
          bar(ctx, 5, -top - 5, 3, 0.9, 'rgba(224,255,255,0.5)');
        });
        const g = new Mesh(rnd + 2);
        g.ball(10.4, 9.4, top + 7.6, 0.9, 0.9, 0.9, '#9ff6ff', { emissive: true });
        g.draw(ctx);
        halo(ctx, [8, 9.2, top + 6.5], 6, '79,240,255', 0.14);
      } else {
        // papers + a gold nameplate
        o.push().translate(4.4, 10.6, top).rotateZ(-0.12);
        o.box(-2.3, -1.8, 0, 4.6, 3.6, 0.12, '#d9dce2', { jitter: 0.01 });
        o.pop();
        o.push().translate(4.6, 10.4, top + 0.12).rotateZ(0.1);
        o.box(-2.3, -1.8, 0, 4.6, 3.6, 0.12, '#f4f6fa', { jitter: 0.01 });
        o.pop();
        o.box(9, 12.4, top, 5, 1.2, 1.5, '#e5b83b', { bevel: 0.3 });
        o.draw(ctx);
        onPlane(ctx, 13.62, () => bar(ctx, 9.9, -top - 1.05, 3.2, 0.55, '#7a5a1e'));
      }
      break;
    }
    case 'P': {
      // alien plant in a faceted pot
      softShadow(ctx, 8, 15, 5.4, 1.4, 0.42);
      const pot = rnd % 3 === 0 ? '#5a5f66' : '#9a6a4a';
      m.lathe(8, 12, [[2.3, 0], [3.1, 1.6], [3.4, 3.6], [3.3, 5], [3.8, 5.2], [3.8, 6], [3.2, 6.1]], 8, pot, {
        rot: 0.2,
        bands: [undefined, undefined, undefined, shade(pot, 0.12), shade(pot, 0.12), shade(pot, 0.12)],
        topColor: '#3a2a20',
      });
      m.draw(ctx);
      const leafCol = rnd % 2 ? '#58b368' : '#7a6fd6';
      const back = mix(leafCol, '#1b2620', 0.3);
      const j = (i: number) => (((rnd >> (i * 2)) & 3) - 1.5) * 0.12;
      const lf = new Mesh(rnd + 3);
      const base: V3 = [8, 12, 5.8];
      // [yaw, how far it leans from upright, length, width, colour]
      const leaves: Array<[number, number, number, number, string]> = [
        [Math.PI * 1.15 + j(0), 1.05, 8.5, 1.5, back],
        [Math.PI * 1.85 + j(1), 1.0, 8.5, 1.5, back],
        [Math.PI * 1.35 + j(2), 0.62, 10, 1.6, leafCol],
        [Math.PI * 1.65 + j(3), 0.6, 10.5, 1.6, leafCol],
        [Math.PI * 0.85 + j(4), 0.95, 7.5, 1.4, mix(leafCol, '#ffffff', 0.06)],
        [Math.PI * 0.15 + j(5), 0.95, 7.5, 1.4, leafCol],
        [Math.PI * 0.5 + j(6), 0.85, 6, 1.3, mix(leafCol, '#ffffff', 0.1)],
      ];
      for (const [yaw, lean, len, w, col] of leaves) {
        const tip: V3 = [base[0] + Math.cos(yaw) * Math.sin(lean) * len, base[1] + Math.sin(yaw) * Math.sin(lean) * len * 0.8, base[2] + Math.cos(lean) * len];
        blade(lf, base, tip, w, col);
      }
      // central stalk with a glowing seed pod
      rod(lf, base, [8.2, 11.6, 17.4], 0.35, mix(leafCol, '#2a3a20', 0.3), {}, 4);
      lf.ball(8.2, 11.6, 18.2, 1.3, 1.3, 1.15, '#f2d13d', { emissive: false, strength: 0.6 });
      lf.draw(ctx);
      halo(ctx, [8.2, 11.6, 18.2], 3.2, '242,209,61', 0.25);
      break;
    }
    case 'b': {
      // bed, two tiles wide: steel frame, thick mattress, pillow and blanket; posts at both ends
      const left = map?.at(x + 1, y) === 'b';
      const pair = left ? x : x - 1;
      const blanket = ['#4a5a8a', '#7a4a3a', '#56624a', '#3f6a70'][hash('bunk', pair, y) % 4];
      const frame = '#5a6170';
      const post = '#3e4450';
      // back posts and the head / foot board stand behind the mattress: draw them first
      const bk = new Mesh(pair + 2);
      const px = left ? 0 : 14.4;
      bk.box(px, 5.4, 0, 1.6, 1.6, left ? 11 : 8.2, post, { chamfer: 0.35, bevel: 0.35 });
      bk.box(px + 0.3, 7, 3.4, 1, 6.6, left ? 5.6 : 3.6, shade(post, 0.15), { bevel: 0.3 });
      if (left) bk.box(0.2, 6.8, 7.6, 1.2, 7, 0.8, post);
      /** The blanket spans both tiles: one mesh, offset by `ox` and clipped to this tile. */
      const cover = (ox: number) => {
        ctx.save();
        ctx.beginPath();
        ctx.rect(ox === 0 ? -4 : 0, -16, 20, 34);
        ctx.clip();
        const bl = new Mesh(pair * 7 + y);
        bl.translate(ox, 0, 0);
        bl.box(8.4, 6.1, 5.4, 22, 8.9, 1.1, blanket, { bevel: 0.6, bevelH: 0.5 });
        bl.box(8.4, 14.6, 2.6, 22, 0.45, 3.4, shade(blanket, -0.05), { layer: 1 }); // hanging over the side
        bl.box(22.8, 8.4, 6.5, 5.6, 5, 0.5, mix(blanket, '#ffffff', 0.07), { bevel: 0.4, layer: 2 }); // folded-back corner
        bl.draw(ctx);
        ctx.restore();
      };
      span(ctx, map, 'b', x, y, (x0, w, l, r) => {
        bandShadow(ctx, l, r, 14.2, 16.4, 0.36);
        bk.draw(ctx);
        const s = new Mesh(5);
        s.box(x0, 6.2, 1, w, 8.8, 2.6, frame, { bevel: 0.3 });
        s.box(l ? x0 : x0 + 0.4, 6.6, 3.6, w - (l ? 0 : 0.4) - (r ? 0 : 0.4), 8, 2.2, '#c9cfdc', { bevel: 0.9, bevelH: 0.7 });
        s.draw(ctx);
      });
      if (left) {
        const p = new Mesh(pair);
        p.ball(4.4, 10.6, 6.6, 2.6, 3.5, 1.1, '#eef1f7', { detail: 1, rough: 0.05 }); // pillow
        p.box(6.6, 6.3, 5.6, 2, 8.6, 0.55, '#dfe4ee', { bevel: 0.3 }); // turned-down sheet
        p.draw(ctx);
        cover(0);
        m.box(0, 13.6, 0, 1.6, 1.6, 8.4, post, { chamfer: 0.35, bevel: 0.35 });
        m.draw(ctx);
      } else {
        cover(-16);
        m.box(14.4, 13.6, 0, 1.6, 1.6, 7.4, post, { chamfer: 0.35, bevel: 0.35 });
        m.draw(ctx);
      }
      break;
    }
    case 's': {
      // sofa: base, backrest, a seat and back cushion per tile, armrests where the run ends
      const fabric = '#7a5a8e';
      const l = map?.at(x - 1, y) === 's';
      const r = map?.at(x + 1, y) === 's';
      span(ctx, map, 's', x, y, (x0, w, jl, jr) => {
        bandShadow(ctx, jl, jr, 14.4, 16.4, 0.32);
        const s = new Mesh(3);
        s.box(x0, 6.5, 0, w, 0.6, 1, '#1d1622'); // shadowed foot
        s.box(x0, 5.5, 0.8, w, 9.4, 3.6, fabric, { bevel: 0.5 });
        s.box(x0, 4, 0.8, w, 3, 9.2, mix(fabric, '#000000', 0.12), { bevel: 0.6 });
        // rolled top of the backrest
        rod(s, [x0, 5.5, 10], [x0 + w, 5.5, 10], 1.55, mix(fabric, '#000000', 0.08), { layer: 1 }, 7);
        s.draw(ctx);
      });
      const ca = l ? 0.25 : 2.9;
      const cb = r ? 15.75 : 13.1;
      const cu = new Mesh(rnd);
      cu.push().translate(0, 7.6, 4.6).rotateX(-0.2);
      cu.box(ca, -0.9, 0, cb - ca, 1.9, 5.6, mix(fabric, '#ffffff', 0.04), { chamfer: 0.6, bevel: 0.8, bevelH: 0.6 });
      cu.pop();
      cu.box(ca, 7.2, 4.4, cb - ca, 7.8, 1.7, mix(fabric, '#ffffff', 0.12), { chamfer: 0.8, bevel: 0.8, bevelH: 0.7 });
      if (rnd % 4 === 0) {
        // a throw pillow leaning on the backrest
        cu.push().translate(ca + 2.8, 9.2, 8).rotateY(-0.3);
        cu.ball(0, 0, 0, 2, 0.9, 2, '#d9a53a', { detail: 1, rough: 0.06 });
        cu.pop();
      }
      const arm = (ax: number) => {
        const col = mix(fabric, '#000000', 0.2);
        cu.box(ax, 4.6, 0, 2.9, 10.6, 6.8, col, { chamfer: 0.6, layer: 1 });
        rod(cu, [ax + 1.45, 4.6, 6.8], [ax + 1.45, 15.2, 6.8], 1.5, mix(fabric, '#000000', 0.14), { layer: 2 }, 7);
      };
      if (!l) arm(0);
      if (!r) arm(13.1);
      cu.draw(ctx);
      break;
    }
    case 'W': {
      // whiteboard wall: one long board across the run on posts, legs where it ends
      const l = map?.at(x - 1, y) === 'W';
      const r = map?.at(x + 1, y) === 'W';
      const BOARD = 12.16;
      const leg = (lx: number) => {
        softShadow(ctx, lx + 0.6, 14.8, 2.6, 0.8, 0.35);
        m.box(lx - 1, 9.6, 0, 3.2, 4.6, 0.8, '#4a5262', { bevel: 0.3, chamfer: 0.4 });
        m.box(lx, 11.2, 0.8, 1.2, 0.8, 5, '#6f7a8c', { chamfer: 0.25 });
      };
      if (!l) leg(1.8);
      if (!r) leg(13);
      if (l && r && x % 3 === 0) leg(7.4);
      m.draw(ctx);
      span(ctx, map, 'W', x, y, (x0, w, jl, jr) => {
        const s = new Mesh(9);
        s.box(x0, 11, 5, w, 1, 14.2, '#8f99a8', { bevel: 0.4, bevelH: 0.4 });
        const sx0 = jl ? x0 : x0 + 0.9;
        const sx1 = jr ? x0 + w : x0 + w - 0.9;
        s.box(sx0, 12, 5.8, sx1 - sx0, 0.15, 12.6, '#eef1f5', { jitter: 0, strength: 0.5, layer: 1 });
        s.box(x0 + 0.4, 12, 4.4, w - 0.8, 1.7, 0.6, '#7a8599', { bevel: 0.2, layer: 2 }); // marker tray
        s.draw(ctx);
      });
      // board content drawn in the old board's coordinates, mapped onto the new board plane
      onPlane(ctx, BOARD, () => {
        ctx.translate(0, -18.4);
        ctx.scale(1, 0.92);
        ctx.translate(0, 8.1);
        // a wide sheen facet across the board
        const sx = (rnd % 5) * 2;
        ctx.save();
        ctx.beginPath();
        ctx.rect(l ? 0 : 0.9, -8.1, (r ? 16 : 15.1) - (l ? 0 : 0.9), 13.7);
        ctx.clip();
        poly(ctx, [[sx, -8.1], [sx + 4, -8.1], [sx - 2, 5.6], [sx - 6, 5.6]], 'rgba(255,255,255,0.45)');
        ctx.restore();
        const ink = ['#e8534a', '#3aa7e0', '#2fb39a'][rnd % 3];
        const kind = (rnd >> 3) % 3;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        if (kind === 0) {
          ctx.strokeStyle = ink;
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.moveTo(2.5, 2.5);
          ctx.lineTo(5.5, -1 - (rnd % 3));
          ctx.lineTo(8.5, 0.5);
          ctx.lineTo(13, -5 + (rnd % 2));
          ctx.stroke();
          bar(ctx, 2.4, 3.6, 11, 0.7, '#9aa0ab');
        } else if (kind === 1) {
          const box = (bx: number, by: number, col: string) => {
            poly(ctx, [[bx, by], [bx + 4.8, by], [bx + 4.8, by + 3.4], [bx, by + 3.4]], col);
            poly(ctx, [[bx + 0.6, by + 0.6], [bx + 4.2, by + 0.6], [bx + 4.2, by + 2.8], [bx + 0.6, by + 2.8]], '#eef1f5');
          };
          box(2.2, -6.4, ink);
          box(9, -1.6, '#555a66');
          poly(ctx, [[6.6, -3.2], [9.2, -0.8], [8.6, -0.3], [6, -2.6]], ink);
          poly(ctx, [[9.6, -1.6], [9.8, 0.4], [7.8, -0.4]], ink);
        } else {
          bar(ctx, 2.4, -6, 8, 1, ink);
          bar(ctx, 2.8, -3.4, 10, 0.8, '#6a707c');
          bar(ctx, 2.8, -1.4, 6, 0.8, '#6a707c');
          bar(ctx, 2.8, 0.6, 8, 0.8, '#6a707c');
        }
      });
      const o = new Mesh(rnd);
      if (rnd % 2) {
        // a sticky note, curling off the board
        o.face([[11, BOARD + 0.05, 16.6], [13.8, BOARD + 0.05, 16.8], [13.9, BOARD + 0.05, 14.2], [11.1, BOARD + 0.5, 14]], ['#f2d13d', '#5fd4e0', '#ffb35a'][rnd % 3]);
      }
      // markers on the tray
      rod(o, [3, 12.9, 5.3], [5.4, 12.8, 5.3], 0.32, ['#e8534a', '#3aa7e0', '#2fb39a'][rnd % 3], {}, 5);
      if (rnd % 3) rod(o, [9, 12.8, 5.3], [11.2, 13, 5.3], 0.32, '#2a2d33', {}, 5);
      o.draw(ctx);
      break;
    }
    case 'K': {
      // coffee machine: bean hopper, display, lit dispenser alcove with a cup
      softShadow(ctx, 8.4, 15.2, 7.4, 1.4, 0.42);
      m.box(2.4, 8.6, 0, 11.2, 5.6, 0.7, '#1c1f26');
      m.box(2, 8, 0.6, 12, 6.5, 16.4, '#474e5e', { chamfer: 0.8, bevel: 0.7 });
      m.box(3.8, 8.8, 17, 5.8, 4.2, 3.4, '#2b2f3a', { chamfer: 0.6, bevel: 0.5, topColor: '#5a3a22' }); // hopper
      m.box(3.6, 14.45, 10.6, 8.8, 0.2, 4.6, '#13161c', { jitter: 0, layer: 1 }); // display bezel
      m.face([[4.3, 14.7, 11.8], [9, 14.7, 11.8], [9, 14.7, 14.4], [4.3, 14.7, 14.4]], '#58e07a', { emissive: true, layer: 2 });
      m.push().translate(10.9, 14.6, 13.1).rotateX(-Math.PI / 2);
      m.cylinder(0, 0, 0, 0.8, 0.65, 0.5, 7, '#e8534a', { topColor: '#ffb0a0', layer: 2 });
      m.pop();
      m.box(4.4, 14.45, 1.4, 7.2, 0.15, 8.4, '#11131a', { jitter: 0, layer: 1 }); // dispenser alcove
      m.box(7, 13.6, 7.6, 2, 1.8, 1.2, '#8a909c', { chamfer: 0.3, layer: 2 }); // spout
      m.box(5, 13.4, 1.2, 6, 2.6, 0.7, '#5a6170', { bevel: 0.25, layer: 2 }); // drip tray
      m.draw(ctx);
      halo(ctx, [8, 14.5, 5], 4.8, '255,170,90', 0.35);
      const cup = new Mesh(rnd + 5);
      if (rnd % 4 !== 0) cup.cylinder(8, 14.6, 1.9, 1.0, 1.2, 2.8, 8, '#e8eaee', { topColor: '#6b3f1d' });
      cup.draw(ctx);
      onPlane(ctx, 14.72, () => bar(ctx, 4.9, -13.6, 2.6, 0.7, '#1d4a2a'));
      if (rnd % 6 === 1) {
        // somebody taped a warning on it
        onPlane(ctx, 14.62, () => {
          poly(ctx, [[2.6, -10.4], [13.4, -9.6], [13.4, -8.2], [2.6, -9]], '#d9a53a');
          bar(ctx, 5, -9.6, 6, 0.6, '#3a2a10');
        });
      }
      break;
    }
    case 'J': {
      // jukebox: arch-topped cabinet, record window, light bands (animated in the evening), grille
      softShadow(ctx, 8.4, 15.2, 7.4, 1.4, 0.42);
      const body = '#7a3b8f';
      // the cabinet is an extruded arch profile: built in (x, -z), extruded along y toward the viewer
      const prof: Array<[number, number]> = [[2, 0], [14, 0], [14, -14]];
      for (let i = 1; i < 8; i++) {
        const a = (i / 8) * Math.PI;
        prof.push([8 + Math.cos(a) * 6, -14 - Math.sin(a) * 6]);
      }
      prof.push([2, -14]);
      m.box(2.4, 9.6, 0, 11.2, 5.4, 0.8, '#1a0d20');
      m.push().translate(0, 9, 0.8).rotateX(-Math.PI / 2);
      m.extrude(prof, 0, JUKE_FRONT - 9, body, { bevel: 1, bevelH: 0.7, noBottom: true });
      m.pop();
      m.draw(ctx);
      const f = new Mesh(rnd + 7);
      const F = JUKE_FRONT;
      // chrome pillars up the front corners
      f.cylinder(3, F - 0.3, 0.8, 0.75, 0.75, 13.6, 6, '#c7ccd6');
      f.cylinder(13, F - 0.3, 0.8, 0.75, 0.75, 13.6, 6, '#c7ccd6');
      f.ball(3, F - 0.3, 14.6, 0.95, 0.95, 0.95, '#e3e7ef');
      f.ball(13, F - 0.3, 14.6, 0.95, 0.95, 0.95, '#e3e7ef');
      // record window, record and tonearm
      f.box(4.4, F - 0.4, 12.8, 7.2, 0.45, 5.8, '#1a0f22', { chamfer: 0.6, jitter: 0 });
      f.push().translate(JUKE_REC[0], F + 0.05, JUKE_REC[2]).rotateX(-Math.PI / 2);
      f.cylinder(0, 0, 0, 2.2, 2.2, 0.3, 12, '#2a2a33', { topColor: '#24242c' });
      f.cylinder(0, 0, 0.3, 0.8, 0.8, 0.1, 7, '#e8534a');
      f.pop();
      rod(f, [10.9, F + 0.4, 17.6], [9, F + 0.45, 15.8], 0.22, '#c7ccd6', {}, 4);
      // light band bezel; the renderer recolours the bands at JUKE_BANDS in the evening
      f.box(3, F - 0.2, 7.9, 10, 0.25, 5, '#2a1433', { jitter: 0 });
      // speaker grille: a recess with slats
      f.box(4, F - 0.2, 1.6, 8, 0.25, 5.4, '#2e1838', { jitter: 0 });
      for (let i = 0; i < 4; i++) f.box(4.8 + i * 1.75, F, 2.1, 0.8, 0.3, 4.4, shade(body, -0.05));
      f.draw(ctx);
      onPlane(ctx, F + 0.06, () => {
        JUKE_BAND_Z.forEach((z, i) => {
          poly(ctx, [[3.4, -z - 0.9], [12.6, -z - 0.9], [12.6, -z], [3.4, -z]], ['#f2d13d', '#e05fae', '#53c7d6'][i]);
        });
      });
      halo(ctx, [8, F, 10.2], 7, '255,120,210', 0.16);
      break;
    }
    case 'Q': {
      // beer taps on a bar counter, with a full mug
      span(ctx, map, 'Q', x, y, (x0, w, l, r) => {
        bandShadow(ctx, l, r, 14.4, 16.4, 0.36);
        const s = new Mesh(13);
        const bx0 = l ? x0 : x0 + 0.3;
        const bx1 = r ? x0 + w : x0 + w - 0.3;
        s.box(bx0 + 0.3, 8.6, 0, bx1 - bx0 - 0.6, 6, 0.8, '#2a1a10');
        s.box(bx0, 8, 0.8, bx1 - bx0, 6.6, 7.6, '#8a5a3a');
        s.box(bx0 + 1, 14.6, 2.8, bx1 - bx0 - 2, 0.25, 3.6, '#6a4228', { bevel: 0.2 }); // panel
        s.box(x0, 7.6, 8.4, w, 7.6, 0.8, '#6e4428', { bevel: 0.4, bevelH: 0.3 });
        rod(s, [bx0 + 0.2, 15.3, 1.6], [bx1 - 0.2, 15.3, 1.6], 0.42, '#e0c084', {}, 6); // brass foot rail
        s.draw(ctx);
      });
      m.box(1.6, 9.2, 9.2, 9, 2.4, 0.4, '#3a3d44', { bevel: 0.15 }); // drip tray
      for (const tx of [4, 8]) {
        m.cylinder(tx, 9.6, 9.6, 0.85, 0.75, 5, 6, '#c9ced8');
        rod(m, [tx, 9.6, 14.2], [tx, 11, 13.8], 0.32, '#9aa0aa', {}, 5);
        rod(m, [tx, 11, 13.9], [tx, 11.1, 12.6], 0.26, '#9aa0aa', {}, 5);
        const handle = tx === 4 ? '#e8534a' : '#3aa7e0';
        m.cylinder(tx, 9.6, 14.6, 0.45, 0.85, 4.4, 5, handle, { topColor: shade(handle, 0.1) });
      }
      m.draw(ctx);
      const beer = rnd % 3 === 0 ? '#5a2e18' : '#f2b13d';
      const g = new Mesh(rnd);
      g.cylinder(13, 11.4, 9.2, 1.55, 1.7, 4.4, 8, beer);
      g.ball(13, 11.4, 13.7, 1.85, 1.85, 0.9, '#fffbe8');
      rod(g, [14.6, 11.5, 12.4], [15.4, 11.5, 11.4], 0.3, '#d8dde6', {}, 4);
      rod(g, [15.4, 11.5, 11.4], [14.6, 11.5, 10.2], 0.3, '#d8dde6', {}, 4);
      g.draw(ctx);
      break;
    }
    case 'F': {
      // fridge: tall chamfered cabinet, two doors, worn corners
      softShadow(ctx, 8.4, 15.2, 7.4, 1.4, 0.38);
      const white = rnd % 2 ? '#e4e6e2' : '#dfe3e8';
      m.box(2.4, 9.4, 0, 11.2, 5.4, 0.8, '#202228');
      m.box(2, 9, 0.7, 12, 6, 20.3, white, { chamfer: 0.7, bevel: 0.8 });
      m.box(2.3, 15, 13.4, 11.4, 0.08, 0.4, shade(white, -0.45), { jitter: 0, layer: 1 }); // door seam
      m.box(10.8, 15, 15, 1.3, 0.7, 4.2, '#9aa3b3', { chamfer: 0.3, layer: 1 }); // handles
      m.box(10.8, 15, 6.4, 1.3, 0.7, 5.6, '#9aa3b3', { chamfer: 0.3, layer: 1 });
      m.face([[3.6, 15.05, 19.3], [4.4, 15.05, 19.3], [4.4, 15.05, 19.9], [3.6, 15.05, 19.9]], '#5fd4e0', { emissive: true, layer: 1 });
      if (rnd % 3 === 0) m.box(4, 15, 16.4, 2.2, 0.25, 2.2, '#5fd4e0', { chamfer: 0.4, layer: 1 }); // a magnet
      if (rnd % 3 === 1) m.box(4.4, 15, 9.6, 2.4, 0.2, 1.8, '#ffb35a', { chamfer: 0.3, layer: 1 });
      m.draw(ctx);
      // grime on a scuffed corner
      onPlane(ctx, 15.02, () => poly(ctx, [[2.4, -3.2], [5.4, -1.8], [4.4, -0.8], [2.4, -0.8]], 'rgba(120,80,50,0.2)'));
      break;
    }
    case 'H': {
      // holo-projector pad: a faint cone of light with a small ringed planet floating in it
      softShadow(ctx, 8, 15, 6.4, 1.4, 0.42);
      m.cylinder(8, 11.4, 0, 4.8, 4.4, 2, 8, '#4a4c54', { rot: 0 });
      m.cylinder(8, 11.4, 2, 3.6, 3.2, 0.5, 8, '#2c4a50', { rot: 0 });
      m.cylinder(8, 11.4, 2.5, 2.6, 2.6, 0.08, 8, '#5fd4e0', { rot: 0, emissive: true });
      m.cylinder(4.3, 13.8, 1.8, 0.5, 0.4, 0.4, 5, '#d9a53a');
      m.cylinder(11.7, 13.8, 1.8, 0.5, 0.4, 0.4, 5, '#d9a53a');
      m.draw(ctx);
      halo(ctx, [8, 11.4, 2.6], 4.2, '95,212,224', 0.35);
      // planet with a ring (ring split into a back half drawn before it and a front half after)
      const pz = 12.4;
      const ring = (front: boolean, mesh: Mesh) => {
        const n = 10;
        for (let i = 0; i < n; i++) {
          const a0 = (front ? 0 : Math.PI) + (i / n) * Math.PI;
          const a1 = (front ? 0 : Math.PI) + ((i + 1) / n) * Math.PI;
          const pt = (a: number, rr: number): V3 => [8 + Math.cos(a) * rr, 11.4 + Math.sin(a) * rr * 0.9, pz + Math.sin(a) * rr * 0.18];
          mesh.face([pt(a0, 3.6), pt(a1, 3.6), pt(a1, 4.6), pt(a0, 4.6)], front ? '#bef5ff' : '#a0f0ff', { emissive: true, alpha: front ? 0.75 : 0.5 });
        }
      };
      const h = new Mesh(rnd + 9);
      ring(false, h);
      h.draw(ctx);
      const p = new Mesh(rnd + 10);
      p.ball(8, 11.4, pz, 2.3, 2.3, 2.3, '#6fd0ff', { alpha: 0.85 });
      p.draw(ctx);
      const fr = new Mesh(rnd + 11);
      ring(true, fr);
      fr.draw(ctx);
      // the light cone (the renderer sweeps a scan band across HOLO_SCAN)
      const cone = new Mesh(rnd + 12);
      cone.cylinder(8, 11.4, 2.6, 2.6, 4.6, 14, 8, '#6fe6ff', { rot: 0, emissive: true, alpha: 0.1 });
      cone.draw(ctx);
      break;
    }
    case 'A': {
      // comm dish on a pole
      softShadow(ctx, 8, 15, 5.4, 1.2, 0.42);
      m.box(4, 10.6, 0, 8, 4.6, 1.6, '#4a5366', { chamfer: 0.6, bevel: 0.5 });
      m.cylinder(8, 12.9, 1.6, 0.95, 0.8, 9, 6, '#7a8599');
      m.cylinder(8, 12.9, 10.4, 1.6, 1.3, 1.2, 6, '#5a6378');
      m.draw(ctx);
      // dish: a shallow faceted bowl tilted up toward the viewer, struts to the feed horn
      const d = new Mesh(rnd + 13);
      d.translate(8, 12.6, 14.6).rotateY(-0.6).rotateX(0.2);
      const n = 10;
      const R = 5.8;
      const rim: V3[] = Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2;
        return [Math.cos(a) * R, Math.sin(a) * R, 1.4] as V3;
      });
      const mid: V3[] = rim.map(([px, py]) => [px * 0.55, py * 0.55, 0.45] as V3);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        d.face([mid[i], mid[j], rim[j], rim[i]], '#c4cbd6');
        d.face([[0, 0, 0], mid[j], mid[i]], '#aab3c2');
      }
      // rim lip
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const o = (p: V3): V3 => [p[0] * 1.08, p[1] * 1.08, p[2] + 0.1];
        d.face([rim[i], rim[j], o(rim[j]), o(rim[i])], '#e1e5ec');
      }
      rod(d, [-4.4, 2.8, 1.2], [0, 0, 5.2], 0.22, '#8a93a3', {}, 4);
      rod(d, [4.4, 2.8, 1.2], [0, 0, 5.2], 0.22, '#6f7888', {}, 4);
      rod(d, [0, -5, 1.2], [0, 0, 5.2], 0.22, '#7a8599', {}, 4);
      d.cylinder(0, 0, 4.8, 0.9, 0.6, 1.4, 6, '#7a8599');
      d.ball(0, 0, 6.6, 0.7, 0.7, 0.7, '#e8534a', { emissive: true, layer: 1 });
      const mount = new Mesh(rnd + 14);
      mount.box(7.1, 12, 11.4, 1.8, 1.8, 1.6, '#5a6378', { chamfer: 0.4 });
      rod(mount, [8, 12.9, 12.6], [8, 12.6, 14.8], 0.5, '#6f7888', {}, 5);
      mount.draw(ctx);
      d.draw(ctx);
      halo(ctx, [4.3, 11.3, 20], 2.4, '232,83,74', 0.4);
      break;
    }
  }
}
