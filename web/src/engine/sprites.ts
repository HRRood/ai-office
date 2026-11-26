// Procedural low-poly 3D characters. Original sci-fi archetypes, tinted per session.
// Each figure is a real mesh (mesh.ts): a lathed, faceted head, a tapered bevelled torso, low-sided
// cylinder limbs that swing for walking and typing, block hands/feet, and accessories as primitives.
// Every direction is the same mesh yawed around its vertical axis (no mirroring), lit by true 3D normals
// and drawn upright through the office's isometric camera. Baked into a SPRITE_UNITS-square art-unit
// canvas (feet at SPRITE_FEET) once per (archetype, color, skin, direction, frame) and cached.
import { ART_RES, mix } from './lowpoly';
import { ISO_ZSCALE, Mesh, isoOf, type P2, type V3 } from './mesh';

export type Dir = 'down' | 'up' | 'left' | 'right';
/** 0 = standing, 1/2 = walk cycle, 3/4 = typing (left / right hand on the keyboard). */
export type Frame = 0 | 1 | 2 | 3 | 4;
/**
 * What sessions look like: Jedi in the style of Ahsoka, Yoda, Obi-Wan and Anakin, each with a lightsaber
 * glowing in the session colour. The sub-agents working in a session are 'astromech' droids.
 */
export const ARCHETYPES = ['ahsoka', 'yoda', 'obiwan', 'anakin'] as const;
/**
 * Every figure type. Sessions use ARCHETYPES and their sub-agents 'astromech'; 'boss' is the Manager (a
 * Darth Vader style lord), 'captain' is you, 'pilot' the guard, and 'sint' / 'piet' (roetveegpiet) the
 * Sinterklaas visitors. 'droid', 'mystic', 'alien' and 'engineer' are earlier looks, kept available.
 */
export type Archetype =
  | (typeof ARCHETYPES)[number]
  | 'astromech' | 'pilot' | 'droid' | 'mystic' | 'alien' | 'engineer' | 'sint' | 'piet' | 'boss' | 'captain';

/** Session colors, indexed by SessionState.color (server keeps them distinct). */
export const SESSION_COLORS = [
  '#e8534a', '#f39c34', '#f2d13d', '#7bc950', '#2fb39a', '#3aa7e0',
  '#5a6ee8', '#9b5de5', '#e05fae', '#d0d4dc', '#a87850', '#53c7d6',
];
export const SKINS = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'];
/** Alien skin tones, picked by the same index as SKINS. */
const ALIEN_SKINS = ['#7fd67a', '#6fb7d6', '#b58ad6', '#d6a35f', '#8fd6c0'];
/** The wanderer's cloak: sand and brown, with a sash in the session color. */
const CLOAK = '#7a6248';

/** Clothing and skin of the Jedi session figures (robe = the long brown robe's colour, if they wear one). */
const JEDI_LOOK: Partial<Record<string, { body: string; pants: string; belt: string; tabard: string; skin?: string; robe?: string }>> = {
  ahsoka: { body: '#8b3a2e', pants: '#4a3a34', belt: '#6a4a30', tabard: '#a8503e', skin: '#e07a3a' },
  yoda: { body: '#c9b48a', pants: '#8a6a46', belt: '#7a5a3a', tabard: '#b39d74', skin: '#8fae6a', robe: '#8a6a46' },
  obiwan: { body: '#d8c7a0', pants: '#5a3e26', belt: '#6a4a2c', tabard: '#c4b089', robe: '#6a4a2e' },
  anakin: { body: '#3b2c24', pants: '#2a201c', belt: '#1a1412', tabard: '#4e3a2e' },
};

export interface Look {
  archetype: Archetype;
  color: string;
  skin: string;
}

const cache = new Map<string, HTMLCanvasElement>();

// ---- camera placement inside the sprite box ----
/** Head centre height (world z, before CHAR_SCALE) when standing. */
const HEAD_Z = 9.6;
/**
 * Characters are modelled about 13 units tall; the camera foreshortens heights (ISO_ZSCALE), so they are
 * scaled up to read well next to the furniture.
 */
export const CHAR_SCALE = 1.6;
/** Sprite canvas size in screen art units (square). */
export const SPRITE_UNITS = 24;
/** Where the floor point under the figure sits inside the sprite (screen art units). */
export const SPRITE_FEET: P2 = [12, 20.5];
/** Head centre inside the sprite when standing (name tags, bubbles and hats anchor here). */
export const SPRITE_HEAD: P2 = [SPRITE_FEET[0], SPRITE_FEET[1] - HEAD_Z * CHAR_SCALE * ISO_ZSCALE];

const proj = (v: V3): P2 => {
  const [sx, sy] = isoOf(v);
  return [sx * CHAR_SCALE, sy * CHAR_SCALE];
};

export function getSprite(look: Look, dir: Dir, frame: Frame): HTMLCanvasElement {
  const key = `${look.archetype}|${look.color}|${look.skin}|${dir}|${frame}`;
  let c = cache.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = c.height = SPRITE_UNITS * ART_RES;
    const ctx = c.getContext('2d')!;
    ctx.scale(ART_RES, ART_RES);
    buildCharacter(look, dir, frame).draw(ctx, SPRITE_FEET[0], SPRITE_FEET[1], proj);
    cache.set(key, c);
  }
  return c;
}

/** Like lowpoly's shade(), but returns #rrggbb so the result can be shaded / lit again. */
const sh = (hex: string, f: number) => (f >= 0 ? mix(hex, '#ffffff', f) : mix(hex, '#000000', -f));

const YAW: Record<Dir, number> = { down: 0, up: Math.PI, right: -Math.PI / 2, left: Math.PI / 2 };

/** Linear interpolation of a [r, z] profile's radius at height z. */
function radiusAt(profile: [number, number][], z: number): number {
  if (z <= profile[0][1]) return profile[0][0];
  for (let i = 0; i + 1 < profile.length; i++) {
    const [r0, z0] = profile[i];
    const [r1, z1] = profile[i + 1];
    if (z <= z1) return r0 + ((r1 - r0) * (z - z0)) / (z1 - z0 || 1);
  }
  return profile[profile.length - 1][0];
}

// ---------- the figure ----------
// Local frame: the character faces +y (toward the viewer for 'down'), +x is its left hand side on screen,
// z up, feet on z = 0.

function buildCharacter(look: Look, dir: Dir, drawFrame: Frame): Mesh {
  const { archetype: a, color } = look;
  const seed = a.length * 7 + SESSION_COLORS.indexOf(color) + 3;
  const m = new Mesh(seed);
  const typing = drawFrame === 3 || drawFrame === 4;
  const frame: 0 | 1 | 2 = typing ? 0 : drawFrame;

  const metal = '#b8c0cc';
  const gold = '#e5b83b';
  const boots = '#2a2a33';
  const jedi = JEDI_LOOK[a];
  const body = jedi ? jedi.body : a === 'droid' ? metal : a === 'mystic' ? CLOAK : a === 'boss' ? '#121217' : color;
  const pants = jedi
    ? jedi.pants
    : a === 'droid' ? sh(metal, -0.35) : a === 'engineer' ? sh(color, -0.35) : a === 'piet' ? '#f2d13d' : a === 'captain' ? '#1d2b4a' : sh(color, -0.45);
  const skin = jedi?.skin ?? (a === 'alien' ? ALIEN_SKINS[Math.max(0, SKINS.indexOf(look.skin)) % ALIEN_SKINS.length] : a === 'droid' ? metal : look.skin);
  const hand = a === 'pilot' ? '#3a3f4c' : a === 'boss' ? '#2e3038' : a === 'droid' ? sh(metal, -0.2) : skin;
  const robed = a === 'mystic' || a === 'sint' || a === 'boss' || !!jedi?.robe;
  const sleeve = sh(body, -0.08);

  const yaw = YAW[dir];
  /**
   * How far toward the viewer a local point ends up (the isometric camera looks from +x +y), used to
   * layer head attachments.
   */
  const wy = (x: number, y: number) => {
    const X = Math.cos(yaw) * x - Math.sin(yaw) * y;
    const Y = Math.sin(yaw) * x + Math.cos(yaw) * y;
    return (X + Y) / Math.SQRT2;
  };

  // walking: legs and arms swing; the hips drop a touch so the swinging feet stay on the floor
  const swing = frame === 1 ? 0.42 : frame === 2 ? -0.42 : 0;
  const HIP = 3.4;
  const drop = robed ? (frame ? 0.25 : 0) : HIP * (1 - Math.cos(swing));
  m.rotateZ(yaw);
  if (a === 'yoda') m.scale(0.66); // small, with a big head (see the head section)
  if (a === 'astromech') {
    astromech(m, color, drawFrame);
    return m;
  }
  m.translate(0, 0, -drop);

  // ---- legs (or robe) ----
  if (robed) {
    const hem = jedi?.robe ?? (a === 'sint' ? color : a === 'boss' ? '#0d0d11' : '#5a4632');
    for (const s of [-1, 1]) {
      const step = frame === 0 ? 0 : (s < 0) === (frame === 1) ? 0.7 : -0.5;
      const lift = step < 0 ? 0.25 : 0;
      m.box(s * 1.15 - 0.8, -0.4 + step, drop + lift, 1.6, 2.2, 0.85, boots, { chamfer: 0.35, bevel: 0.3 });
    }
    const sw = frame === 1 ? 0.3 : frame === 2 ? -0.3 : 0;
    m.push().translate(sw, 0, drop).rotateY(sw * 0.08);
    const robe: [number, number][] = [[3.05, 0.5], [2.95, 1.3], [2.35, 4.4]];
    m.lathe(0, -0.15, robe, 8, hem, { ry: 0.78, bands: [sh(hem, -0.12), hem] });
    if (a === 'sint') {
      // the white alb shows down the front where the red cope hangs open, with gold edging
      const f = (z: number) => radiusAt(robe, z) * 0.924 * 0.78 - 0.15;
      const strip = (w0: number, w1: number, c: string, d: number) =>
        m.hexa(
          [[-w0, f(0.55) - 0.1, 0.55], [w0, f(0.55) - 0.1, 0.55], [w0, f(0.55) + d, 0.55], [-w0, f(0.55) + d, 0.55]],
          [[-w1, f(4.3) - 0.1, 4.3], [w1, f(4.3) - 0.1, 4.3], [w1, f(4.3) + d, 4.3], [-w1, f(4.3) + d, 4.3]],
          c,
          { jitter: 0.02 },
        );
      strip(1.5, 0.85, gold, 0.12);
      strip(1.1, 0.6, '#f4f6fa', 0.22);
    }
    m.pop();
  } else {
    for (const s of [-1, 1]) {
      const ang = s < 0 ? swing : -swing;
      m.push().translate(s * 1.15, -0.15, HIP).rotateX(ang);
      m.cylinder(0, 0, -HIP + 0.85, 0.78, 0.95, HIP - 0.55, 6, pants);
      m.box(-0.82, -1.0, -HIP, 1.64, 2.0, 0.95, boots, { chamfer: 0.35, bevel: 0.3, jitter: 0.02 });
      m.pop();
    }
  }

  // ---- the manager's cape (frames 1/2 = swaying) ----
  if (a === 'boss') {
    const sw = frame === 1 ? 0.8 : frame === 2 ? -0.8 : 0;
    const capeC = '#0a0a0d';
    const lining = '#16161c';
    // face 0 = bottom, 1 = top, then the sides: index 4 faces the body (+y): the red lining
    const cols = (i: number) => (i === 4 ? lining : capeC);
    // two panels meeting in a fold down the middle of the back
    for (const s of [-1, 1]) {
      const x = (v: number) => s * v;
      const p = (pts: number[][]) => (s < 0 ? pts : [pts[1], pts[0], pts[3], pts[2]]).map(rev);
      m.hexa(
        p([[x(3.6) + sw, -2.0, 0.35], [sw, -2.75, 0.35], [sw, -2.3, 0.35], [x(3.4) + sw, -1.6, 0.35]]),
        p([[x(2.6), -1.35, 7.2], [0, -1.75, 7.25], [0, -1.25, 7.35], [x(2.5), -0.85, 7.3]]),
        cols,
        { layer: dir === 'up' ? 0.5 : -0.5, jitter: 0.03 },
      );
    }
  }

  // ---- torso ----
  const torso: [number, number][] = [[1.95, 3.0], [2.25, 3.75], [2.35, 4.25], [2.7, 6.1], [2.5, 7.0], [1.45, 7.7]];
  const TRY = 0.74;
  /** Front surface (local y) of the torso at height z. */
  const tf = (z: number) => radiusAt(torso, z) * 0.924 * TRY;
  const belt = jedi
    ? jedi.belt
    : a === 'engineer' ? '#7a5230' : a === 'captain' ? '#1d2b4a' : a === 'sint' ? '#f4f6fa' : a === 'boss' ? '#8d939d' : a === 'mystic' ? color : sh(color, -0.4);
  m.lathe(0, 0, torso, 8, body, { ry: TRY, bands: [robed ? body : pants, belt, body, body, sh(body, 0.06)] });
  /** A small plate stuck on the torso front at height z (centre), x offset. */
  const chest = (x: number, z: number, w: number, h: number, c: string, o: { emissive?: boolean; d?: number } = {}) => {
    const d = o.d ?? 0.3;
    m.box(x - w / 2, tf(z) - d * 0.45, z - h / 2, w, d, h, c, { emissive: o.emissive, jitter: 0.015, chamfer: Math.min(w, d) * 0.25 });
  };
  /** Same on the back. */
  const back = (x: number, z: number, w: number, h: number, c: string) => {
    const d = 0.3;
    m.box(x - w / 2, -tf(z) - d * 0.55, z - h / 2, w, d, h, c, { jitter: 0.015 });
  };

  // ---- arms ----
  const SH_Z = 6.7;
  for (const s of [-1, 1]) {
    const cuff = a === 'pilot' || a === 'boss';
    m.push().translate(s * 2.6, 0, SH_Z);
    if (typing) {
      // elbows out to the sides, forearms reaching forward to the keyboard; one hand lifts per frame
      const lifted = (s < 0 && drawFrame === 3) || (s > 0 && drawFrame === 4);
      m.rotateY(-s * 0.6).rotateX(0.3);
      m.cylinder(0, 0, -1.7, 0.7, 0.8, 1.9, 6, sleeve);
      m.translate(0, 0, -1.6).rotateY(s * 0.6).rotateX(lifted ? 2.15 : 1.45);
      m.cylinder(0, 0, -1.7, 0.62, 0.72, 1.8, 6, sh(sleeve, 0.04));
      if (cuff) m.cylinder(0, 0, -1.8, 0.72, 0.72, 0.55, 6, hand, { jitter: 0.02 });
      m.ball(0, 0.05, -2.05, 0.72, 0.72, 0.68, hand, { jitter: 0.02 });
    } else {
      m.rotateY(-s * 0.13).rotateX(s < 0 ? -swing * 0.9 : swing * 0.9);
      m.cylinder(0, 0, -2.5, 0.62, 0.8, 2.9, 6, sleeve);
      if (cuff) m.cylinder(0, 0, -2.6, 0.72, 0.72, 0.6, 6, hand, { jitter: 0.02 }); // glove cuff
      m.ball(0, 0.05, -2.85, 0.72, 0.72, 0.68, hand, { jitter: 0.02 });
    }
    m.pop();
  }

  // ---- Jedi: crossed tunic flaps and a lightsaber on the belt, glowing in the session colour ----
  if (jedi) {
    for (const s of [-1, 1]) {
      m.hexa(
        [[s * 0.1, tf(4.4) - 0.2, 4.3], [s * 1.9, tf(4.4) - 0.2, 4.3], [s * 1.9, tf(4.4) + 0.14, 4.3], [s * 0.1, tf(4.4) + 0.14, 4.3]],
        [[-s * 1.3, tf(6.9) - 0.2, 6.95], [-s * 0.4, tf(6.9) - 0.2, 6.95], [-s * 0.4, tf(6.9) + 0.14, 6.95], [-s * 1.3, tf(6.9) + 0.14, 6.95]],
        jedi.tabard,
        { jitter: 0.02 },
      );
    }
    const sabers = a === 'ahsoka' ? [-1, 1] : [1];
    for (const s of sabers) {
      const hx = s * (robed ? 2.75 : 2.45);
      m.cylinder(hx, 0.35, 2.75, 0.3, 0.3, 1.45, 6, '#c9ced6', { jitter: 0.01 });
      m.cylinder(hx, 0.35, 3.3, 0.33, 0.33, 0.3, 6, '#2a2d33', { jitter: 0 }); // grip
      m.cylinder(hx, 0.35, 4.2, 0.24, 0.24, 0.22, 6, color, { emissive: true }); // emitter glow
    }
  }

  // ---- shoulder / chest details ----
  switch (a) {
    case 'pilot':
      for (const s of [-1, 1]) m.box(s * 1.55 - 0.3, tf(5.4) - 0.2, 4.6, 0.6, 0.35, 2.4, '#3a3d45', { jitter: 0.01 }); // harness straps
      chest(0, 5.5, 3.2, 0.5, '#3a3d45');
      chest(0, 5.5, 0.8, 0.8, '#9aa0aa', { d: 0.45 });
      for (const s of [-1, 1]) {
        m.box(s * 1.7 - 0.6, tf(3.9) - 0.3, 3.2, 1.2, 0.8, 1.1, '#5a4a36', { bevel: 0.2, chamfer: 0.2 }); // pouches
      }
      break;
    case 'droid':
      chest(0, 5.6, 2.8, 1.7, color, { d: 0.35 });
      chest(-0.6, 5.85, 0.8, 0.5, sh(color, 0.55), { emissive: true, d: 0.45 });
      chest(1.7, 6.5, 0.6, 0.5, '#8a4a2a', { d: 0.2 }); // a rust spot
      for (let i = 0; i < 3; i++) back(0, 6.2 - i * 0.8, 2.8, 0.35, sh(metal, -0.35)); // vents
      break;
    case 'engineer':
      chest(0, 7.0, 1.8, 0.7, '#e8e2d0'); // shirt collar
      chest(1.0, 3.95, 0.5, 1.5, '#d9d9d9', { d: 0.4 }); // wrench in the tool belt
      chest(-1.2, 5.6, 0.8, 0.7, '#4a3a2a', { d: 0.15 }); // grease
      break;
    case 'mystic':
      m.hexa(
        [[-2.2, tf(6.6) - 0.2, 6.5], [-1.5, tf(6.6) - 0.2, 6.9], [-1.5, tf(6.6) + 0.12, 6.9], [-2.2, tf(6.6) + 0.12, 6.5]],
        [[1.6, tf(4.4) - 0.2, 4.0], [2.3, tf(4.4) - 0.2, 4.5], [2.3, tf(4.4) + 0.12, 4.5], [1.6, tf(4.4) + 0.12, 4.0]],
        color,
        { jitter: 0.02 },
      ); // sash across the chest
      chest(0, 6.8, 1.6, 0.9, '#c9b48a'); // layered tunic
      break;
    case 'captain':
      for (const s of [-1, 1]) m.box(s * 2.6 - 1.0, -0.75, 6.8, 2.0, 1.5, 0.45, gold, { bevel: 0.15 }); // epaulettes
      chest(0, 5.6, 0.45, 2.6, '#d8dde6');
      chest(0.85, 6.0, 0.45, 0.45, gold, { d: 0.4 });
      chest(0.85, 5.0, 0.45, 0.45, gold, { d: 0.4 });
      break;
    case 'boss':
      for (const s of [-1, 1]) m.box(s * 2.5 - 1.3, -1.0, 6.5, 2.6, 2.0, 1.0, '#1b1c22', { bevel: 0.35, chamfer: 0.3 }); // shoulder armour
      // the chest control box: a grey panel with rows of coloured buttons and slots
      chest(0, 5.7, 2.2, 1.6, '#5c626c', { d: 0.4 });
      chest(-0.55, 6.15, 0.45, 0.32, '#ff3344', { emissive: true, d: 0.55 });
      chest(0.0, 6.15, 0.45, 0.32, '#3ad06a', { emissive: true, d: 0.55 });
      chest(0.55, 6.15, 0.45, 0.32, '#4aa8ff', { emissive: true, d: 0.55 });
      for (const x of [-0.6, -0.2, 0.2, 0.6]) chest(x, 5.45, 0.22, 0.7, '#2a2d33', { d: 0.5 });
      // belt boxes either side of the buckle
      for (const s of [-1, 1]) chest(s * 0.95, 4.0, 0.75, 0.75, '#8d939d', { d: 0.45 });
      chest(0, 4.0, 0.6, 0.6, '#c9ced6', { d: 0.5 });
      break;
    case 'piet':
      chest(0, 5.6, 0.55, 0.55, gold, { d: 0.4 });
      chest(0, 4.8, 0.55, 0.55, gold, { d: 0.4 });
      // white ruff collar
      m.lathe(0, 0, [[1.4, 6.95], [2.9, 7.35], [2.75, 7.85], [1.3, 8.0]], 10, '#f4f6fa', { ry: 0.78, jitter: 0.05 });
      break;
    case 'sint':
      chest(0, 5.4, 1.3, 3.6, '#f4f6fa'); // stole
      chest(0, 5.8, 0.3, 1.7, gold, { d: 0.45 });
      chest(0, 6.05, 1.1, 0.3, gold, { d: 0.45 });
      break;
    case 'alien':
      chest(0, 6.2, 1.3, 0.5, sh(color, 0.35));
      break;
  }

  // ---- head ----
  const hz = HEAD_Z;
  const HL = 1; // head parts draw over the body
  /** Head attachments facing away from the camera tuck under the skull; the rest draw over it. */
  const headLayer = (x: number, y: number, e = 0) => (wy(x, y) / (Math.hypot(x, y) || 1) < -0.2 ? HL - 0.1 - e : HL + 0.1 + e);
  let R = 2.85;
  let RZ = 2.2;
  const HRY = 0.95;
  let prof: [number, number][] = [[0, -1], [0.6, -0.84], [0.95, -0.32], [1.0, 0.18], [0.86, 0.62], [0.46, 0.92], [0, 1]];
  if (a === 'alien') {
    R = 2.95;
    RZ = 2.45;
    prof = [[0, -1], [0.45, -0.88], [0.78, -0.45], [0.98, 0.1], [1.0, 0.55], [0.62, 0.9], [0, 1]];
  }
  if (a === 'pilot' || a === 'boss') R = 3.0;
  if (a === 'yoda') {
    // a big, wide head on a small body
    R = 3.6;
    RZ = 2.35;
    prof = [[0, -1], [0.62, -0.86], [0.95, -0.4], [1.0, 0.05], [0.9, 0.5], [0.5, 0.88], [0, 1]];
  }
  if (a === 'mystic') {
    R = 3.1;
    RZ = 2.3;
  }
  const headProf = (): [number, number][] => prof.map(([r, z]) => [r * R, hz + z * RZ]);
  /** Distance from the head axis to its surface at relative height zr (-1..1) in direction ang (0 = front). */
  const surf = (zr: number, ang: number) => {
    const r = radiusAt(prof, zr) * R * 0.95;
    const ax = r;
    const ay = r * HRY;
    return 1 / Math.hypot(Math.sin(ang) / ax, Math.cos(ang) / ay);
  };
  /**
   * A feature stuck onto the head surface: ang turns it around the head (0 = front, + = toward +x),
   * zr is relative height (-1..1). Built as a thin block so it culls and sorts like a real part.
   */
  const stick = (ang: number, zr: number, w: number, h: number, c: string, o: { emissive?: boolean; d?: number; out?: number; tilt?: number; e?: number } = {}) => {
    const d = o.d ?? 0.3;
    const dist = surf(zr, ang) + (o.out ?? 0);
    m.push().translate(0, 0, hz + zr * RZ).rotateZ(-ang).translate(0, dist - d * 0.4, 0);
    if (o.tilt) m.rotateY(o.tilt);
    m.box(-w / 2, 0, -h / 2, w, d, h, c, { emissive: o.emissive, jitter: 0.015, layer: headLayer(Math.sin(ang), Math.cos(ang), o.e) });
    m.pop();
  };
  const eyes = (zr: number, c = '#141414', w = 0.55, h = 0.75, spread = 0.4) => {
    stick(-spread, zr, w, h, c, { emissive: true });
    stick(spread, zr, w, h, c, { emissive: true });
  };
  const mouth = (zr: number, c = '#b04844') => stick(0, zr, 0.9, 0.3, c, { emissive: true, d: 0.25 });
  const skull = (c: string, bands?: (string | undefined)[]) =>
    m.lathe(0, 0, headProf(), 8, c, { ry: HRY, bands, layer: HL, jitter: 0.04 });
  /** A cap of hair / helmet over the head from relative height zr upward, slightly larger than the head. */
  const dome = (zr: number, grow: number, c: string, bands?: (string | undefined)[], ryk = 1) => {
    const pts: [number, number][] = [[radiusAt(prof, zr) * R + grow, hz + zr * RZ]];
    for (const [r, z] of prof) if (z > zr + 0.05) pts.push([r * R + (r > 0 ? grow : 0), hz + z * RZ + grow * 0.6]);
    m.lathe(0, 0, pts, 8, c, { ry: HRY * ryk, bands, layer: HL + 0.05, jitter: 0.04 });
  };
  /**
   * Hair over the back of the head: a slab hugging the skull's back, plus a cap over the crown.
   * It draws over the skull only when the figure faces away; in profile it tucks under so just the
   * part that sticks out behind the head shows.
   */
  const hair = (c: string, z0 = -0.6, bands?: string[], grow = 0.12) => {
    const z1 = 0.3;
    const ya = surf(z0, Math.PI) + 0.22;
    const yb = surf(z1, Math.PI) + 0.24;
    const za = hz + z0 * RZ;
    const zb = hz + z1 * RZ;
    m.hexa(
      [[-1.5, -ya, za], [1.5, -ya, za], [2.3, -ya + 1.5, za], [-2.3, -ya + 1.5, za]],
      [[-1.75, -yb, zb], [1.75, -yb, zb], [2.6, -yb + 1.5, zb], [-2.6, -yb + 1.5, zb]],
      c,
      { layer: wy(0, -1) > 0.5 ? HL + 0.1 : HL - 0.1, jitter: 0.04 },
    );
    dome(0.15, grow, c, bands);
  };
  /** A part on the head with an explicit layer from its local position. */
  const at = (x: number, y: number) => ({ layer: headLayer(x, y) });

  switch (a) {
    case 'pilot': {
      // original flight helmet: gunmetal shell, a band in the session colour, wraparound visor, antenna
      const helm = '#6a6e78';
      skull(helm, [sh(helm, -0.3), helm, helm, color, helm, sh(helm, 0.08)]);
      stick(-0.55, -0.12, 1.5, 1.45, '#1a2a2e', { d: 0.4 });
      stick(0, -0.12, 1.9, 1.5, '#1a2a2e', { d: 0.4 });
      stick(0.55, -0.12, 1.5, 1.45, '#1a2a2e', { d: 0.4 });
      stick(-0.5, 0.02, 0.9, 0.45, '#5fd4c8', { emissive: true, d: 0.48 });
      stick(0.05, -0.15, 0.35, 0.3, '#2f5458', { emissive: true, d: 0.48 });
      m.push().translate(2.2, -0.6, hz + 1.0).rotateY(0.35);
      m.cylinder(0, 0, 0, 0.22, 0.16, 2.4, 4, '#3a3d45', at(2.2, -0.6));
      m.ball(0, 0, 2.5, 0.42, 0.42, 0.42, '#9aa0aa', at(2.2, -0.6));
      m.pop();
      m.cylinder(0, 0, hz - RZ - 0.3, 1.9, 2.1, 0.7, 8, sh(helm, -0.3), { ry: 0.8 }); // collar ring
      break;
    }
    case 'droid': {
      const fy = 1.55; // front face
      m.cylinder(0, 0, 7.3, 0.9, 0.9, 1.3, 6, '#5a6270'); // neck
      m.box(-2.75, -fy, hz - 1.75, 5.5, fy * 2, 3.6, metal, { chamfer: 0.75, bevel: 0.55, layer: HL, jitter: 0.03 });
      m.box(-2.15, fy - 0.15, hz - 1.0, 4.3, 0.4, 1.6, '#1a1f2b', { chamfer: 0.1, layer: headLayer(0, 1) });
      m.box(-1.4, fy + 0.05, hz - 0.55, 2.8, 0.4, 0.55, '#4ff0ff', { emissive: true, layer: headLayer(0, 1, 0.05) });
      for (const s of [-1, 1]) m.cylinder(s * 2.85, 0, hz - 0.9, 0.55, 0.55, 1.3, 6, sh(metal, -0.25), { ...at(s * 2.8, 0), jitter: 0.02 }); // ear bolts
      m.box(-1.7, -fy - 0.2, hz - 1.1, 3.4, 0.4, 0.35, sh(metal, -0.35), at(0, -fy));
      m.box(-1.7, -fy - 0.2, hz - 0.3, 3.4, 0.4, 0.35, sh(metal, -0.35), at(0, -fy));
      m.cylinder(0, 0, hz + 1.7, 0.2, 0.15, 1.6, 4, '#7a8599', at(0, 0));
      m.ball(0, 0, hz + 3.45, 0.55, 0.55, 0.55, color, { ...at(0, 0.5), emissive: false });
      break;
    }
    case 'mystic': {
      const hood = sh(CLOAK, -0.1);
      m.push().translate(0, -0.9, hz + 1.5).rotateX(-0.75);
      m.cylinder(0, 0, 0, 1.4, 0, 2.0, 6, sh(hood, 0.05), at(0, -1.5)); // hood peak
      m.pop();
      skull(hood, [sh(hood, -0.25), hood, hood, hood, hood, sh(hood, 0.06)]);
      stick(0, -0.22, 3.2, 2.7, '#2a2018', { d: 0.5 });
      const fs = sh(skin, -0.35);
      m.ball(0, surf(-0.25, 0) - 0.4, hz - 0.25 * RZ - 0.1, 1.35, 0.75, 1.0, fs, { layer: headLayer(0, 1, 0.05), jitter: 0.03 });
      m.box(-1.05, surf(-0.25, 0) + 0.2, hz - 0.45, 0.5, 0.25, 0.45, '#141414', { emissive: true, layer: headLayer(-0.4, 1, 0.1) });
      m.box(0.55, surf(-0.25, 0) + 0.2, hz - 0.45, 0.5, 0.25, 0.45, '#141414', { emissive: true, layer: headLayer(0.4, 1, 0.1) });
      m.box(-0.35, -surf(0, Math.PI) - 0.15, hz - RZ, 0.7, 0.3, RZ * 1.8, sh(hood, -0.25), at(0, -1)); // seam
      break;
    }
    case 'alien': {
      const stalk = sh(skin, -0.2);
      for (const s of [-1, 1]) {
        m.push().translate(s * 1.3, -0.3, hz + RZ * 0.75).rotateY(s * 0.55).rotateX(-0.2);
        m.cylinder(0, 0, 0, 0.26, 0.18, 2.1, 5, stalk, at(s * 1.6, -0.3));
        m.ball(0, 0, 2.2, 0.55, 0.55, 0.55, '#f2d13d', { ...at(s * 2.4, -0.4), emissive: false });
        m.pop();
      }
      skull(skin, [sh(skin, -0.15), skin, skin, skin, skin, sh(skin, 0.05)]);
      for (const s of [-1, 1]) {
        stick(s * 0.45, -0.12, 1.35, 1.25, '#101418', { emissive: true, d: 0.35, tilt: s * 0.35 });
        stick(s * 0.42, 0.0, 0.42, 0.38, '#ffffff', { emissive: true, d: 0.42 });
      }
      stick(0, -0.62, 0.6, 0.2, sh(skin, -0.45), { emissive: true, d: 0.2 });
      break;
    }
    case 'captain': {
      // you: navy peaked cap with a gold badge
      const navy = '#1d2b4a';
      skull(skin);
      hair('#4a3020', -0.6);
      eyes(-0.2);
      mouth(-0.62);
      const cz = hz + 0.42 * RZ;
      m.cylinder(0, 0, cz, R * 0.97, R * 1.04, 1.0, 8, navy, { ry: HRY, topColor: '#2c3f6c', layer: HL + 0.05, jitter: 0.03 });
      m.cylinder(0, 0, cz - 0.05, R * 0.99, R * 0.99, 0.35, 8, '#0e1526', { ry: HRY, layer: HL + 0.06 }); // hat band
      m.cylinder(0, 1.05, cz - 0.1, 2.0, 2.0, 0.22, 8, '#101830', { ry: 0.55, layer: headLayer(0, 1, 0.05) }); // brim
      m.box(-0.35, surf(0.6, 0) * 0.97 + 0.05, cz + 0.3, 0.7, 0.3, 0.55, gold, { layer: headLayer(0, 1, 0.1), emissive: true });
      break;
    }
    case 'boss': {
      // Darth Vader style: a glossy black dome helmet whose rim flares out over the shoulders at the back
      // and sides, dark angled eye lenses, a nose ridge and a triangular mouth grille.
      const helm = '#121216';
      const gloss = '#24252d';
      skull(helm, [sh(helm, -0.15), helm, helm, helm, gloss, sh(gloss, 0.08)]);
      // the flared rim: a skirt from the temples down past the jaw (it drapes behind the face mask)
      m.lathe(0, -0.45, [[R * 0.98, hz + 0.2 * RZ], [R * 1.05, hz - 0.35 * RZ], [R * 1.22, hz - 0.95 * RZ], [R * 1.25, hz - 1.08 * RZ]], 10, helm, {
        ry: HRY * 1.05,
        bands: [gloss, helm, sh(helm, -0.2)],
        layer: HL - 0.05,
        jitter: 0.03,
      });
      m.box(-0.22, -1.6, hz + RZ * 0.55, 0.44, 3.2, 0.5, gloss, { bevel: 0.2, layer: HL + 0.12 }); // crown ridge
      // face mask: brow, angled lenses, nose ridge, cheek plates and the triangular grille
      stick(0, 0.12, 2.6, 0.45, '#1d1e25', { d: 0.4 }); // brow
      for (const s of [-1, 1]) {
        stick(s * 0.36, -0.12, 1.25, 0.9, '#020204', { emissive: true, d: 0.42, tilt: s * 0.3 }); // eye lens
        stick(s * 0.3, -0.04, 0.4, 0.2, '#8a92a6', { emissive: true, d: 0.48 }); // glint
        stick(s * 0.72, -0.55, 1.0, 1.0, '#262832', { d: 0.36, tilt: s * 0.25 }); // cheek plate
      }
      stick(0, -0.3, 0.32, 0.8, '#2a2c36', { d: 0.5 }); // nose ridge
      stick(0, -0.72, 1.3, 0.75, '#0b0b0f', { d: 0.45 }); // grille
      for (const x of [-0.28, 0, 0.28]) stick(x * 0.6, -0.74, 0.12, 0.6, '#8d939d', { d: 0.5 }); // grille bars
      break;
    }
    case 'piet': {
      // roetveegpiet: own skin tone with a few soot smudges, a beret with a feather
      skull(skin);
      hair('#3b2a1e', -0.55);
      eyes(-0.15);
      mouth(-0.6);
      const soot = sh(skin, -0.5);
      stick(-0.75, -0.5, 0.8, 0.5, soot, { d: 0.2 });
      stick(0.85, -0.42, 0.6, 0.45, soot, { d: 0.2 });
      stick(0, -0.35, 0.45, 0.35, soot, { d: 0.22 });
      const cap = sh(color, -0.25);
      m.push().translate(0.35, -0.15, hz + 0.45 * RZ).rotateY(-0.22);
      m.lathe(0, 0, [[2.65, 0], [3.25, 0.4], [3.0, 0.85], [1.8, 1.25], [0, 1.4]], 10, cap, { ry: 0.9, bands: [sh(cap, -0.3)], layer: HL + 0.05, jitter: 0.04 });
      m.pop();
      // feather: two thin vanes swept up and back from the left side of the beret
      m.push().translate(2.4, -0.7, hz + 0.5 * RZ + 0.6).rotateY(0.55).rotateX(-0.35);
      m.box(-0.12, -0.45, 0, 0.24, 0.9, 2.6, '#f4f6fa', { chamfer: 0.08, ...at(2.8, -1) });
      m.pop();
      break;
    }
    case 'sint': {
      // white beard, red mitre with a gold band, golden staff
      skull(skin);
      hair('#f4f6fa', -0.75);
      eyes(0.0, '#141414', 0.5, 0.6, 0.38);
      m.ball(0, surf(-0.6, 0) - 0.65, hz - 1.6, 1.95, 1.3, 1.3, '#f4f6fa', { layer: headLayer(0, 1), jitter: 0.05 }); // beard
      stick(0, -0.3, 2.0, 0.45, '#e4e8ef', { d: 0.45, out: 0.15, e: 0.05 }); // moustache
      const mitre = '#c8102e';
      const mz = hz + 0.25 * RZ;
      const mp: [number, number][] = [[2.55, mz], [2.65, mz + 0.8], [2.2, mz + 2.0], [0.9, mz + 2.9]];
      const MRY = 0.8;
      m.lathe(0, 0, mp, 8, mitre, { ry: MRY, bands: [gold], layer: HL + 0.05, jitter: 0.04 });
      const mf = (z: number) => radiusAt(mp, z) * 0.924 * MRY;
      m.box(-0.3, mf(mz + 1.5) - 0.12, mz + 0.85, 0.6, 0.3, 1.4, gold, { layer: headLayer(0, 1, 0.05), jitter: 0.01 });
      m.box(-0.7, mf(mz + 1.6) - 0.1, mz + 1.4, 1.4, 0.3, 0.4, gold, { layer: headLayer(0, 1, 0.05), jitter: 0.01 });
      // staff with a crook, held on the right hand side
      const sl = { layer: wy(3.4, 0.6) > 0.4 ? HL + 0.3 : 0 };
      m.cylinder(3.4, 0.6, 0, 0.3, 0.3, 12.0, 6, gold, sl);
      const crook: V3[] = [[3.4, 12.0, 0], [3.15, 12.9, 0], [2.5, 13.4, 0], [1.75, 13.3, 0], [1.4, 12.7, 0], [1.55, 12.1, 0]].map(([x, z]) => [x, 0.6, z] as V3);
      for (let i = 0; i + 1 < crook.length; i++) {
        const [x0, , z0] = crook[i];
        const [x1, , z1] = crook[i + 1];
        const len = Math.hypot(x1 - x0, z1 - z0);
        m.push().translate(x0, 0.6, z0).rotateY(Math.atan2(x1 - x0, z1 - z0));
        m.cylinder(0, 0, -0.1, 0.3, 0.3, len + 0.2, 6, sh(gold, 0.08), sl);
        m.pop();
      }
      break;
    }
    case 'ahsoka': {
      // Togruta: orange skin with white facial markings, striped montrals and lekku
      const white = '#f2f2ee';
      const blue = '#2f5fc0';
      skull(skin);
      eyes(-0.12, '#1d3a6a', 0.55, 0.7, 0.42);
      mouth(-0.62, '#9a3a2a');
      stick(0, 0.42, 0.7, 0.55, white, { d: 0.32 }); // forehead mark
      for (const s of [-1, 1]) {
        stick(s * 0.42, 0.18, 0.55, 0.28, white, { d: 0.32, tilt: s * 0.4 }); // brows
        stick(s * 0.62, -0.45, 0.5, 0.7, white, { d: 0.3 }); // cheek marks
      }
      stick(0, -0.85, 0.8, 0.35, white, { d: 0.3 }); // chin
      // montrals: two striped horns curving up from the crown
      for (const s of [-1, 1]) {
        m.push().translate(s * 1.45, -0.3, hz + RZ * 0.55).rotateY(s * 0.3).rotateX(-0.2);
        m.lathe(0, 0, [[0.85, 0], [0.75, 0.9], [0.68, 1.25], [0.5, 2.0], [0.3, 2.6], [0, 3.0]], 8, white, { bands: [white, blue, white, white, blue], ...at(s * 1.6, -0.3), jitter: 0.02 });
        m.pop();
      }
      // lekku: two head-tails hanging beside the face over the shoulders, one longer down the back
      const lek = (x: number, y: number, len: number, tip: number) => {
        m.push().translate(x, y, hz - RZ * 0.3).rotateX(tip);
        m.lathe(0, 0, [[0.2, -len], [0.45, -len * 0.7], [0.62, -len * 0.45], [0.7, -len * 0.2], [0.75, 0]], 7, white, { bands: [blue, white, blue, white], ...at(x, y), jitter: 0.02 });
        m.pop();
      };
      for (const s of [-1, 1]) lek(s * 2.05, 0.05, 3.8, 0.2);
      lek(0, -1.7, 4.4, -0.25);
      break;
    }
    case 'yoda': {
      // green, wrinkled, with long pointed ears and a few white wisps of hair
      skull(skin, [sh(skin, -0.12), skin, skin, sh(skin, -0.05), skin, sh(skin, 0.04)]);
      eyes(0.02, '#3a3424', 0.85, 0.75, 0.38);
      for (const s of [-1, 1]) stick(s * 0.38, 0.22, 1.0, 0.25, sh(skin, -0.18), { d: 0.32 }); // heavy brows
      mouth(-0.55, sh(skin, -0.4));
      stick(0, -0.2, 0.45, 0.55, sh(skin, 0.06), { d: 0.42 }); // nose
      for (const s of [-1, 1]) {
        m.push().translate(s * R * 0.82, -0.15, hz + 0.2).rotateY(s * 1.25);
        m.cylinder(0, 0, 0, 1.05, 0, 3.4, 5, skin, { ry: 0.38, ...at(s * 2.6, -0.2), jitter: 0.03 });
        m.pop();
      }
      for (const [x, y, z] of [[-1.6, -0.8, 1.6], [1.7, -0.6, 1.5], [0.2, -1.6, 1.9]] as V3[])
        m.ball(x, y, hz + z, 0.7, 0.6, 0.45, '#e9e6dc', { rough: 0.25, ...at(x, y) });
      break;
    }
    case 'obiwan': {
      // ginger hair and a neat beard
      const ginger = '#8e5430';
      skull(skin);
      hair(ginger, -0.55);
      eyes(-0.08, '#24324a');
      m.ball(0, surf(-0.62, 0) - 0.5, hz - 1.5, 1.6, 1.0, 1.05, ginger, { layer: headLayer(0, 1), jitter: 0.05 }); // beard
      stick(0, -0.38, 1.7, 0.38, sh(ginger, -0.08), { d: 0.42, out: 0.12, e: 0.05 }); // moustache
      break;
    }
    case 'anakin': {
      // shoulder-length brown hair, a scar over the right eye
      const brown = '#5e4028';
      skull(skin);
      hair(brown, -0.95, undefined, 0.18);
      eyes(-0.1, '#2a3a5a');
      mouth(-0.62);
      stick(-0.45, 0.05, 0.12, 0.9, sh(skin, -0.3), { d: 0.32 }); // scar
      break;
    }
    case 'engineer': {
      const hairC = '#3b2a1e';
      skull(skin);
      hair(hairC, -0.5, ['#555b66', hairC, hairC]);
      eyes(-0.22);
      mouth(-0.64);
      stick(0.75, -0.6, 0.7, 0.5, sh(skin, -0.4), { d: 0.2 }); // grease smudge
      for (const s of [-1, 1]) {
        m.push().translate(0, 0, hz + 0.3 * RZ).rotateZ(-s * 0.38).translate(0, surf(0.3, 0) + 0.05, 0).rotateX(-Math.PI / 2);
        m.cylinder(0, 0, 0, 0.72, 0.62, 0.65, 6, '#f2d13d', { ...at(s, 2), topColor: '#c9a520' });
        m.pop();
      }
      break;
    }
  }
  return m;
}

/** Identity helper so cape points read as plain tuples. */
function rev(p: number[]): V3 {
  return [p[0], p[1], p[2]];
}

/**
 * An R2-D2 style astromech droid: a white barrel body with panels in the session colour, a silver domed
 * head with a big black eye lens, two side legs on shoulder hubs and a small centre foot. It rocks a little
 * when it walks (frames 1/2) and reaches a small arm out to the keyboard when it types (frames 3/4).
 * Built in the figure's local frame (front = +y), already yawed by the caller.
 */
function astromech(m: Mesh, color: string, frame: Frame) {
  const white = '#e9edf3';
  const silver = '#c3c9d3';
  const panel = color;
  const deep = sh(color, -0.35);
  const dark = '#20242c';
  const typing = frame === 3 || frame === 4;
  const rock = frame === 1 ? 0.07 : frame === 2 ? -0.07 : 0;
  const R = 2.55;
  const ZB = 1.7; // bottom of the barrel
  const ZT = 7.3; // top of the barrel (dome sits on it)

  // ---- legs: outer struts with big feet, on shoulder hubs ----
  for (const s of [-1, 1]) {
    const lx = s * (R + 0.55);
    m.box(lx - 0.95, -1.35, 0, 1.9, 2.7, 0.9, silver, { chamfer: 0.45, bevel: 0.3, jitter: 0.02 }); // foot
    m.box(lx - 0.5, -0.55, 0.6, 1.0, 1.1, 0.5, dark, { jitter: 0.01 }); // ankle
    m.box(lx - 0.7, -0.75, 1.0, 1.4, 1.5, 5.6, white, { chamfer: 0.35, bevel: 0.25, jitter: 0.02 }); // strut
    m.box(lx - 0.25, 0.75, 2.0, 0.5, 0.12, 3.6, panel, { jitter: 0.01 }); // strut stripe
    m.push().translate(lx, 0, 6.4).rotateY(Math.PI / 2);
    m.cylinder(0, 0, -0.65, 1.15, 1.15, 1.3, 8, white, { jitter: 0.02 }); // shoulder hub
    m.cylinder(0, 0, s > 0 ? 0.65 : -0.75, 0.7, 0.7, 0.1, 8, panel, { jitter: 0 });
    m.pop();
  }
  // centre foot under the barrel
  m.box(-0.8, -0.9, 0, 1.6, 1.8, 0.7, silver, { chamfer: 0.35, bevel: 0.2 });
  m.cylinder(0, 0, 0.7, 0.55, 0.75, ZB - 0.6, 6, dark);

  // ---- barrel body (rocks a touch while walking) ----
  m.push().translate(0, 0, ZB).rotateX(rock).translate(0, 0, -ZB);
  m.lathe(0, 0, [[R * 0.88, ZB], [R, ZB + 0.5], [R, ZT - 0.3], [R * 0.97, ZT]], 12, white, {
    bands: [sh(white, -0.1), white, sh(white, 0.04)],
    jitter: 0.015,
  });
  /** A panel on the barrel surface, facing angle ang (0 = front) at height z. */
  const plate = (ang: number, z: number, w: number, h: number, c: string, o: { emissive?: boolean; d?: number } = {}) => {
    const d = o.d ?? 0.22;
    m.push().translate(0, 0, z).rotateZ(-ang).translate(0, R - 0.05, 0);
    m.box(-w / 2, 0, -h / 2, w, d, h, c, { emissive: o.emissive, jitter: 0.01 });
    m.pop();
  };
  // the front: a big vertical panel, vents and a couple of lights
  plate(0, 4.9, 1.7, 3.4, panel);
  plate(0, 4.9, 1.0, 2.5, deep, { d: 0.3 });
  for (let i = 0; i < 3; i++) plate(0, 4.0 + i * 0.75, 0.75, 0.22, white, { d: 0.36 });
  plate(-0.55, 5.9, 0.9, 1.3, panel);
  plate(0.55, 5.9, 0.9, 1.3, panel);
  plate(-0.55, 3.4, 0.8, 0.8, dark, { d: 0.26 });
  plate(0.55, 3.4, 0.5, 0.5, '#ff4a3a', { emissive: true, d: 0.3 });
  plate(0.35, 6.7, 0.35, 0.35, '#56d4ff', { emissive: true, d: 0.28 });
  // the back and sides: panel bands so the session colour reads from every angle
  for (const ang of [Math.PI, Math.PI * 0.7, -Math.PI * 0.7]) {
    plate(ang, 5.6, 1.5, 2.4, panel);
    plate(ang, 3.2, 1.2, 0.9, deep);
  }
  m.cylinder(0, 0, ZT - 0.35, R + 0.06, R + 0.06, 0.3, 12, silver, { jitter: 0 }); // collar ring

  // ---- the little arm reaching out of the front hatch when typing ----
  if (typing) {
    const lift = frame === 3 ? 0.35 : -0.1;
    m.push().translate(0.5, R - 0.2, 4.6 + lift).rotateX(-Math.PI / 2 + 0.25);
    m.cylinder(0, 0, 0, 0.28, 0.24, 1.9, 6, silver, { jitter: 0.01 });
    m.box(-0.35, -0.2, 1.8, 0.7, 0.4, 0.5, dark, { chamfer: 0.1 }); // gripper
    m.pop();
  }

  // ---- domed head ----
  const yawDome = frame === 1 ? 0.18 : frame === 2 ? -0.18 : 0; // looks around a little while walking
  m.push().rotateZ(yawDome);
  const dome: [number, number][] = [[R * 0.98, ZT], [R * 0.97, ZT + 0.55], [R * 0.86, ZT + 1.55], [R * 0.62, ZT + 2.35], [R * 0.3, ZT + 2.8], [0, ZT + 2.92]];
  m.lathe(0, 0, dome, 12, silver, { bands: [panel, silver, sh(silver, 0.05), silver, sh(silver, 0.12)], jitter: 0.02 });
  /** A part on the dome surface at angle ang (0 = front), at dome-relative height h (0..1). */
  const onDome = (ang: number, t: number, w: number, hh: number, c: string, o: { emissive?: boolean; d?: number } = {}) => {
    const z = ZT + 0.3 + t * 2.3;
    const r = radiusAt(dome, z) - 0.08;
    const d = o.d ?? 0.25;
    m.push().translate(0, 0, z).rotateZ(-ang).translate(0, r, 0).rotateX(-t * 0.7);
    m.box(-w / 2, 0, -hh / 2, w, d, hh, c, { emissive: o.emissive, jitter: 0.01 });
    m.pop();
  };
  // the big eye: a black lens in a silver socket, with a glint
  onDome(0.1, 0.45, 1.25, 1.1, '#6d7480', { d: 0.3 });
  onDome(0.1, 0.45, 0.85, 0.75, '#0b0d12', { emissive: true, d: 0.4 });
  onDome(0.0, 0.5, 0.22, 0.22, '#8fb0ff', { emissive: true, d: 0.48 });
  // a red and blue indicator, and colour panels around the dome
  onDome(-0.5, 0.25, 0.4, 0.4, '#ff4a3a', { emissive: true, d: 0.3 });
  onDome(0.7, 0.35, 0.35, 0.35, '#56d4ff', { emissive: true, d: 0.3 });
  for (const ang of [-1.1, 1.3, 2.3, -2.4, Math.PI]) onDome(ang, 0.4, 1.0, 0.9, panel);
  onDome(-0.35, 0.7, 0.9, 0.55, panel);
  m.cylinder(0, 0, ZT + 2.85, 0.55, 0.45, 0.25, 8, panel, { jitter: 0 }); // top cap
  m.pop();
  m.pop();
}
