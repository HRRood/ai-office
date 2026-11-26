// Tiny low-poly 3D kit: build real meshes (boxes, bevelled extrusions, cylinders/cones, icospheres),
// light every face by its true 3D normal and draw them with an oblique "2.5D" camera.
//
// World axes (art units, 16 per tile):  x → right,  y → toward the viewer (screen down),  z ↑ up.
// Projection: screen = (x + SKEW·z, y − z). The floor (z = 0) maps 1:1 onto the tile grid, so all
// existing layout math stays valid; height rises up the screen exactly like the old MAX_RISE/WALL_RISE art.
// SKEW < 0 tilts tops slightly left, so we look from the front-right and see the shaded right-hand faces.
// That is what makes objects read as solids instead of flat front-on blocks.
//
// Faces are flat-shaded: each one gets a single colour from its normal (warm light from the
// top-left-front, cool shade on the far sides), plus a tiny per-face jitter so surfaces read as facets.

import { mix, shade } from './lowpoly';

type Ctx = CanvasRenderingContext2D;
export type V3 = [number, number, number];
export type P2 = [number, number];

export const SKEW = -0.15;
export const ZK = 1;

function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Direction toward the viewer (projection is constant along it). */
export const VIEW: V3 = norm([-SKEW, ZK, 1]);
/** Direction toward the light: above, from the left, slightly in front. */
export const LIGHT3: V3 = norm([-0.45, 0.3, 0.84]);

const WARM = '#fff1d6';
const COOL = '#141a2e';

/** Project a world point to screen art units. */
export function project(v: V3): P2 {
  return [v[0] + SKEW * v[2], v[1] - ZK * v[2]];
}

/** The flat-shaded colour of a face with outward unit normal `n`. */
export function lit(base: string, n: V3, strength = 1): string {
  const t = dot(n, LIGHT3);
  if (t > 0.55) return mix(base, WARM, Math.min(0.3, (t - 0.55) * 0.55 * strength));
  return mix(base, COOL, Math.min(0.42, (0.55 - t) * 0.5 * strength));
}

// ---- affine transforms (3x4, row-major) ----
type M = number[];
const IDENT: M = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
function mul(a: M, b: M): M {
  const r = new Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      r[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j] + (j === 3 ? a[i * 4 + 3] : 0);
    }
  }
  return r;
}
function apply(m: M, v: V3): V3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2] + m[3],
    m[4] * v[0] + m[5] * v[1] + m[6] * v[2] + m[7],
    m[8] * v[0] + m[9] * v[1] + m[10] * v[2] + m[11],
  ];
}

export interface FaceOpts {
  /** Draw-order bucket; lower buckets are always drawn first (e.g. -1 for floor decals). */
  layer?: number;
  /** Skip lighting: screens, LEDs, flames, glowing tips. */
  emissive?: boolean;
  /** Draw even when facing away (thin cards, leaves, paper). */
  twoSided?: boolean;
  /** Per-face brightness jitter (default 0.035). 0 for clean machined parts. */
  jitter?: number;
  alpha?: number;
  /** Lighting strength multiplier (0.5 = softer contrast). */
  strength?: number;
  /** World-space hint for which way a raw face points (its normal is flipped to agree). */
  toward?: V3;
}

interface Face {
  pts: V3[];
  color: string;
  prim: number;
  center?: V3;
  o: FaceOpts;
}

let seedCounter = 0;

/**
 * A mesh you build up from primitives and then draw at a screen offset. Primitives are convex and
 * back-face culled, then sorted back-to-front by primitive centroid, so two convex objects resting on
 * each other order correctly. Use `layer` when you need to force an order.
 */
export class Mesh {
  private faces: Face[] = [];
  private prims: { depth: number; layer: number }[] = [];
  private m: M = IDENT;
  private stack: M[] = [];
  private seed: number;

  constructor(seed = seedCounter++) {
    this.seed = seed;
  }

  // ---- transform stack ----
  push() {
    this.stack.push(this.m);
    return this;
  }
  pop() {
    this.m = this.stack.pop() ?? IDENT;
    return this;
  }
  translate(x: number, y: number, z: number) {
    this.m = mul(this.m, [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z]);
    return this;
  }
  scale(x: number, y = x, z = x) {
    this.m = mul(this.m, [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0]);
    return this;
  }
  /** Yaw around the vertical axis (radians, positive turns +x toward +y). */
  rotateZ(a: number) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    this.m = mul(this.m, [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0]);
    return this;
  }
  /** Pitch around the x axis (swing a limb forward/back along y). */
  rotateX(a: number) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    this.m = mul(this.m, [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0]);
    return this;
  }
  /** Roll around the y axis (tilt sideways). */
  rotateY(a: number) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    this.m = mul(this.m, [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0]);
    return this;
  }

  // ---- raw faces ----
  private begin(layer = 0) {
    this.prims.push({ depth: 0, layer });
    return this.prims.length - 1;
  }
  private end(prim: number, pts: V3[]) {
    let d = 0;
    for (const p of pts) d += dot(p, VIEW);
    this.prims[prim].depth = d / Math.max(1, pts.length);
  }

  /**
   * A single polygon in local coordinates. Any winding: a lone face is two-sided by default (screens,
   * labels, paper); pass `twoSided: false` to cull it when it faces away.
   */
  face(pts: V3[], color: string, o: FaceOpts = {}) {
    const w = pts.map((p) => apply(this.m, p));
    const prim = this.begin(o.layer);
    this.faces.push({ pts: w, color, prim, o: { twoSided: true, ...o } });
    this.end(prim, w);
    return this;
  }

  /** Add a convex solid from local polygons; normals are oriented away from its centroid. */
  solid(polys: V3[][], color: string | ((i: number) => string), o: FaceOpts = {}) {
    const all: V3[] = [];
    const ws = polys.map((pl) => pl.map((p) => apply(this.m, p)));
    for (const pl of ws) all.push(...pl);
    const c: V3 = [0, 0, 0];
    for (const p of all) {
      c[0] += p[0] / all.length;
      c[1] += p[1] / all.length;
      c[2] += p[2] / all.length;
    }
    const prim = this.begin(o.layer);
    ws.forEach((pts, i) => this.faces.push({ pts, color: typeof color === 'function' ? color(i) : color, prim, center: c, o }));
    this.end(prim, all);
    return this;
  }

  // ---- primitives ----

  /**
   * Extrude a convex floor outline (x, y pairs) from z0 to z1. `bevel` insets the top cap so the upper
   * rim becomes a ring of sloped facets. `topColor` / `sideColor` override per part.
   */
  extrude(
    outline: P2[],
    z0: number,
    z1: number,
    color: string,
    o: FaceOpts & { bevel?: number; bevelH?: number; topColor?: string; sideColor?: string; noBottom?: boolean } = {},
  ) {
    const n = outline.length;
    const bevel = o.bevel ?? 0;
    const bh = bevel > 0 ? Math.min(o.bevelH ?? bevel, (z1 - z0) * 0.6) : 0;
    let cx = 0;
    let cy = 0;
    for (const [x, y] of outline) {
      cx += x / n;
      cy += y / n;
    }
    const inset = (p: P2): P2 => {
      const dx = cx - p[0];
      const dy = cy - p[1];
      const l = Math.hypot(dx, dy) || 1;
      const k = Math.min(bevel, l * 0.9) / l;
      return [p[0] + dx * k, p[1] + dy * k];
    };
    const top = bevel > 0 ? outline.map(inset) : outline;
    const zs = z1 - bh;
    const polys: V3[][] = [];
    const cols: string[] = [];
    const side = o.sideColor ?? color;
    for (let i = 0; i < n; i++) {
      const a = outline[i];
      const b = outline[(i + 1) % n];
      polys.push([[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], zs], [a[0], a[1], zs]]);
      cols.push(side);
      if (bevel > 0) {
        const ta = top[i];
        const tb = top[(i + 1) % n];
        polys.push([[a[0], a[1], zs], [b[0], b[1], zs], [tb[0], tb[1], z1], [ta[0], ta[1], z1]]);
        cols.push(o.topColor ?? color);
      }
    }
    polys.push(top.map(([x, y]) => [x, y, z1] as V3));
    cols.push(o.topColor ?? color);
    if (!o.noBottom) {
      polys.push(outline.map(([x, y]) => [x, y, z0] as V3));
      cols.push(side);
    }
    return this.solid(polys, (i) => cols[i], o);
  }

  /** Axis-aligned box x..x+w, y..y+d, z..z+h; `chamfer` cuts the vertical edges, `bevel` the top rim. */
  box(
    x: number,
    y: number,
    z: number,
    w: number,
    d: number,
    h: number,
    color: string,
    o: FaceOpts & { chamfer?: number; bevel?: number; bevelH?: number; topColor?: string; sideColor?: string } = {},
  ) {
    const c = Math.min(o.chamfer ?? 0, w / 3, d / 3);
    const outline: P2[] =
      c > 0
        ? [[x + c, y], [x + w - c, y], [x + w, y + c], [x + w, y + d - c], [x + w - c, y + d], [x + c, y + d], [x, y + d - c], [x, y + c]]
        : [[x, y], [x + w, y], [x + w, y + d], [x, y + d]];
    return this.extrude(outline, z, z + h, color, o);
  }

  /**
   * Cylinder / frustum / cone around (cx, cy) from z0 up by h. r1 = 0 gives a cone. `ry` squashes the
   * footprint in y (ellipse). `rot` turns the polygon so flat sides don't always face front.
   */
  cylinder(
    cx: number,
    cy: number,
    z0: number,
    r0: number,
    r1: number,
    h: number,
    sides: number,
    color: string,
    o: FaceOpts & { ry?: number; rot?: number; topColor?: string } = {},
  ) {
    const ry = o.ry ?? 1;
    const rot = o.rot ?? Math.PI / sides;
    const ring = (r: number, z: number): V3[] =>
      Array.from({ length: sides }, (_, i) => {
        const a = rot + (i / sides) * Math.PI * 2;
        return [cx + Math.cos(a) * r, cy + Math.sin(a) * r * ry, z] as V3;
      });
    const lo = ring(r0, z0);
    const polys: V3[][] = [];
    const cols: string[] = [];
    if (r1 <= 0.001) {
      const tip: V3 = [cx, cy, z0 + h];
      for (let i = 0; i < sides; i++) {
        polys.push([lo[i], lo[(i + 1) % sides], tip]);
        cols.push(color);
      }
    } else {
      const hi = ring(r1, z0 + h);
      for (let i = 0; i < sides; i++) {
        const j = (i + 1) % sides;
        polys.push([lo[i], lo[j], hi[j], hi[i]]);
        cols.push(color);
      }
      polys.push(hi);
      cols.push(o.topColor ?? color);
    }
    polys.push(lo);
    cols.push(color);
    return this.solid(polys, (i) => cols[i], o);
  }

  /**
   * A low-poly ball (icosahedron, detail 1 = subdivided once: 80 faces) centred at (cx, cy, cz) with radii
   * rx, ry, rz. `rough` jitters the vertices for rocks, bushes and foliage.
   */
  ball(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, color: string, o: FaceOpts & { detail?: 0 | 1; rough?: number } = {}) {
    const t = (1 + Math.sqrt(5)) / 2;
    let verts: V3[] = [
      [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t],
      [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
    ].map((v) => norm(v as V3));
    let tris: number[][] = [
      [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];
    if (o.detail === 1) {
      const cache = new Map<string, number>();
      const midp = (a: number, b: number) => {
        const k = a < b ? `${a},${b}` : `${b},${a}`;
        let i = cache.get(k);
        if (i === undefined) {
          const va = verts[a];
          const vb = verts[b];
          verts.push(norm([(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2]));
          i = verts.length - 1;
          cache.set(k, i);
        }
        return i;
      };
      const next: number[][] = [];
      for (const [a, b, c] of tris) {
        const ab = midp(a, b);
        const bc = midp(b, c);
        const ca = midp(c, a);
        next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
      }
      tris = next;
    }
    const rough = o.rough ?? 0;
    if (rough > 0) {
      let s = this.seed * 9301 + 49297;
      const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280) * 2 - 1;
      verts = verts.map((v) => {
        const k = 1 + rnd() * rough;
        return [v[0] * k, v[1] * k, v[2] * k];
      });
    }
    const pts = verts.map(([x, y, z]) => [cx + x * rx, cy + y * ry, cz + z * rz] as V3);
    return this.solid(tris.map((tr) => tr.map((i) => pts[i])), color, o);
  }

  /**
   * A lathed (revolved) solid around (cx, cy): `profile` lists [radius, z] rings from bottom to top, each
   * ring a `sides`-gon (radius 0 = a single tip point). `ry` squashes it in y. `bands[i]` colours the
   * band between ring i and i+1 (default `color`), so belts, hat bands and hems need no extra parts.
   * Keep the profile convex (heads, torsos, robes, helmets) so the faces orient outward correctly.
   */
  lathe(
    cx: number,
    cy: number,
    profile: [number, number][],
    sides: number,
    color: string,
    o: FaceOpts & { ry?: number; rot?: number; bands?: (string | undefined)[]; topColor?: string; bottomColor?: string } = {},
  ) {
    const ry = o.ry ?? 1;
    const rot = o.rot ?? Math.PI / sides;
    const rings: V3[][] = profile.map(([r, z]) =>
      r <= 0.001
        ? [[cx, cy, z] as V3]
        : Array.from({ length: sides }, (_, i) => {
            const a = rot + (i / sides) * Math.PI * 2;
            return [cx + Math.cos(a) * r, cy + Math.sin(a) * r * ry, z] as V3;
          }),
    );
    const polys: V3[][] = [];
    const cols: string[] = [];
    const bandCol = (i: number) => o.bands?.[i] ?? color;
    for (let k = 0; k + 1 < rings.length; k++) {
      const lo = rings[k];
      const hi = rings[k + 1];
      if (lo.length === 1 && hi.length === 1) continue;
      for (let i = 0; i < sides; i++) {
        const j = (i + 1) % sides;
        if (lo.length === 1) polys.push([lo[0], hi[j], hi[i]]);
        else if (hi.length === 1) polys.push([lo[i], lo[j], hi[0]]);
        else polys.push([lo[i], lo[j], hi[j], hi[i]]);
        cols.push(bandCol(k));
      }
    }
    const first = rings[0];
    const last = rings[rings.length - 1];
    if (first.length > 1) {
      polys.push(first);
      cols.push(o.bottomColor ?? bandCol(0));
    }
    if (last.length > 1) {
      polys.push(last);
      cols.push(o.topColor ?? bandCol(rings.length - 2));
    }
    return this.solid(polys, (i) => cols[i], o);
  }

  /** A convex six-sided block from its four bottom corners and four top corners (same winding). */
  hexa(bottom: V3[], top: V3[], color: string | ((i: number) => string), o: FaceOpts = {}) {
    const polys: V3[][] = [bottom, top];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      polys.push([bottom[i], bottom[j], top[j], top[i]]);
    }
    return this.solid(polys, color, o);
  }

  /** Append another mesh's faces (already in world space) as-is. */
  merge(other: Mesh) {
    const off = this.prims.length;
    this.prims.push(...other.prims);
    for (const f of other.faces) this.faces.push({ ...f, prim: f.prim + off });
    return this;
  }

  // ---- drawing ----

  /** Draw at screen offset (ox, oy) in the context's current units (art units). */
  draw(ctx: Ctx, ox = 0, oy = 0) {
    const items: { f: Face; n: V3; key: number; layer: number; fd: number }[] = [];
    for (let fi = 0; fi < this.faces.length; fi++) {
      const f = this.faces[fi];
      const p = f.pts;
      if (p.length < 3) continue;
      // Newell normal (robust for any planar polygon)
      let nx = 0;
      let ny = 0;
      let nz = 0;
      let fc: V3 = [0, 0, 0];
      for (let i = 0; i < p.length; i++) {
        const a = p[i];
        const b = p[(i + 1) % p.length];
        nx += (a[1] - b[1]) * (a[2] + b[2]);
        ny += (a[2] - b[2]) * (a[0] + b[0]);
        nz += (a[0] - b[0]) * (a[1] + b[1]);
        fc = [fc[0] + a[0] / p.length, fc[1] + a[1] / p.length, fc[2] + a[2] / p.length];
      }
      let n = norm([nx, ny, nz]);
      if (f.center && dot(n, sub(fc, f.center)) < 0) n = [-n[0], -n[1], -n[2]];
      if (f.o.toward && dot(n, f.o.toward) < 0) n = [-n[0], -n[1], -n[2]];
      let facing = dot(n, VIEW);
      if (facing <= 1e-4) {
        if (!f.o.twoSided) continue;
        n = [-n[0], -n[1], -n[2]];
        facing = -facing;
      }
      const pr = this.prims[f.prim];
      items.push({ f, n, key: pr.depth, layer: pr.layer, fd: dot(fc, VIEW) + fi * 1e-9 });
    }
    items.sort((a, b) => a.layer - b.layer || a.key - b.key || a.fd - b.fd);
    for (let i = 0; i < items.length; i++) {
      const { f, n } = items[i];
      let col = f.o.emissive ? f.color : lit(f.color, n, f.o.strength ?? 1);
      const j = f.o.jitter ?? 0.035;
      if (j > 0 && !f.o.emissive) {
        const h = Math.sin((this.seed + 1) * 12.9898 + i * 78.233 + f.prim * 3.1) * 43758.5453;
        col = shade(col, (h - Math.floor(h) - 0.5) * 2 * j);
      }
      ctx.beginPath();
      for (let k = 0; k < f.pts.length; k++) {
        const [sx, sy] = project(f.pts[k]);
        if (k === 0) ctx.moveTo(ox + sx, oy + sy);
        else ctx.lineTo(ox + sx, oy + sy);
      }
      ctx.closePath();
      if (f.o.alpha !== undefined) ctx.globalAlpha = f.o.alpha;
      ctx.fillStyle = col;
      ctx.fill();
      // a hairline in the same colour closes anti-aliasing seams between neighbouring facets
      ctx.strokeStyle = col;
      ctx.lineWidth = 0.12;
      ctx.lineJoin = 'round';
      ctx.stroke();
      if (f.o.alpha !== undefined) ctx.globalAlpha = 1;
    }
  }
}
