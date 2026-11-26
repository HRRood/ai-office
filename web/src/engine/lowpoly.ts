// Shared low-poly 2.5D drawing kit for all office art (tiles, furniture, characters, decor).
//
// Coordinates are in ART UNITS: a map tile is 16 x 16 units, exactly like the old pixel art, so
// existing layout math keeps working. Canvases are allocated at ART_RES device pixels per unit and
// pre-scaled, so fractional coordinates and diagonal edges render crisply. Draw with polygons and
// flat-shaded facets (no pixel grid, no gradients across a facet).
//
// Light comes from the top-left (and slightly in front): faces pointing up/left are lit, faces pointing
// down/right are in shade. Use `facet()` / `litBy()` so every artist shades the same way.

type Ctx = CanvasRenderingContext2D;
export type Pt = [number, number];

/** Device pixels per art unit for baked art (layers and sprites). */
export const ART_RES = 4;

/** 2D light direction (unit vector the light travels *from*): top-left. */
export const LIGHT: Pt = normalize([-0.55, -0.83]);

function normalize([x, y]: Pt): Pt {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
}

/** Parse '#rrggbb' or 'rgb(r,g,b)' (shade()'s own output) into a 0xrrggbb number. */
function toRgb(c: string): number {
  if (c[0] === '#') {
    const h = c.length === 4 ? c[1] + c[1] + c[2] + c[2] + c[3] + c[3] : c.slice(1, 7);
    return parseInt(h, 16);
  }
  const m = c.match(/\d+(\.\d+)?/g);
  if (!m || m.length < 3) return 0;
  const [r, g, b] = m.map((v) => Math.max(0, Math.min(255, Math.round(Number(v)))));
  return (r << 16) | (g << 8) | b;
}

export function shade(hex: string, f: number): string {
  // accepts its own rgb() output too, so shaded colours can be shaded again (bevels on tinted plates)
  const n = toRgb(hex);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(f >= 0 ? v + (255 - v) * f : v * (1 + f))));
  return `rgb(${ch(n >> 16)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

/** Mix two #rrggbb colors (t = 0 -> a, 1 -> b). Returns #rrggbb. */
export function mix(a: string, b: string, t: number): string {
  const pa = toRgb(a);
  const pb = toRgb(b);
  const c = (s: number) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return `#${((1 << 24) | (c(16) << 16) | (c(8) << 8) | c(0)).toString(16).slice(1)}`;
}

/**
 * Brightness factor for a face whose outward 2D normal is `n` (screen space, y down).
 * Returns a value for `shade()`: about +0.22 facing the light, -0.32 facing away.
 */
export function litBy(n: Pt): number {
  const [nx, ny] = normalize(n);
  const d = nx * LIGHT[0] + ny * LIGHT[1]; // 1 = facing the light (LIGHT points toward the source)
  return d >= 0 ? d * 0.22 : d * 0.32;
}

/** Fill a polygon. */
export function poly(ctx: Ctx, pts: Pt[], fill: string, stroke?: string, lineWidth = 0.35) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

/** A flat-shaded facet: `base` lit according to the outward normal `n`. */
export function facet(ctx: Ctx, pts: Pt[], base: string, n: Pt) {
  poly(ctx, pts, shade(base, litBy(n)));
}

/**
 * A chamfered box seen in 3/4 view: top surface (y .. y+topH) then front face (.. +faceH).
 * Like the old `box()`, but with bevelled top edges, a lit left side sliver and a shaded right side.
 * `chamfer` (art units) bevels the top corners.
 */
export function prism(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  topH: number,
  faceH: number,
  base: string,
  chamfer = Math.min(1.2, w / 6, topH / 2),
) {
  const c = chamfer;
  const top = shade(base, 0.12);
  const front = shade(base, -0.12);
  const fy = y + topH; // where the front face starts
  // top surface, bevelled at the back corners
  poly(ctx, [[x + c, y], [x + w - c, y], [x + w, y + c], [x + w, fy], [x, fy], [x, y + c]], top);
  // back bevel catches the light
  poly(ctx, [[x + c, y], [x + w - c, y], [x + w - c * 0.6, y + c * 0.6], [x + c * 0.6, y + c * 0.6]], shade(base, 0.3));
  // front face
  poly(ctx, [[x, fy], [x + w, fy], [x + w, fy + faceH], [x, fy + faceH]], front);
  // front top edge highlight (a thin facet, not a line)
  poly(ctx, [[x, fy], [x + w, fy], [x + w - c * 0.5, fy + c * 0.5], [x + c * 0.5, fy + c * 0.5]], shade(base, 0.04));
  // right side in shade, left side lit
  poly(ctx, [[x + w - c * 0.8, y + c], [x + w, y + c], [x + w, fy + faceH], [x + w - c * 0.8, fy + faceH]], shade(base, -0.3));
  poly(ctx, [[x, y + c], [x + c * 0.6, y + c], [x + c * 0.6, fy + faceH], [x, fy + faceH]], shade(base, 0.18));
}

/**
 * A faceted ellipse ("gem"): a ring of `sides` triangles around a slightly offset centre, each shaded
 * by its own direction. Good for heads, rocks, bushes, planets, round lamps.
 * `seed` jitters the outline a little so repeated shapes don't look stamped.
 */
export function gem(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, base: string, sides = 7, seed = 0) {
  const pts: Pt[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2 - Math.PI / 2 + (seed % 7) * 0.07;
    const j = 1 + (((seed * 31 + i * 17) % 9) - 4) * 0.012;
    pts.push([cx + Math.cos(a) * rx * j, cy + Math.sin(a) * ry * j]);
  }
  const hub: Pt = [cx + LIGHT[0] * rx * 0.25, cy + LIGHT[1] * ry * 0.25]; // ridge leans toward the light
  for (let i = 0; i < sides; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % sides];
    const mid: Pt = [(a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cy];
    facet(ctx, [hub, a, b], base, mid);
  }
}

/** Soft contact shadow on the floor (an ellipse, darker in the middle). */
export function softShadow(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, alpha = 0.35) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, ry / rx);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, `rgba(0,0,0,${alpha})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Allocate a canvas for baked art of `w` x `h` art units, pre-scaled to ART_RES. */
export function artCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: Ctx } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w * ART_RES);
  canvas.height = Math.ceil(h * ART_RES);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(ART_RES, ART_RES);
  return { canvas, ctx };
}
