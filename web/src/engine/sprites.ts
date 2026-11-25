// Procedural 16x16 pixel-art characters. Original sci-fi archetypes, tinted per session.
// Sprites are drawn once per (archetype, color, skin, direction, frame) and cached.
import { shade } from './tiles';

export type Dir = 'down' | 'up' | 'left' | 'right';
/** 0 = standing, 1/2 = walk cycle, 3/4 = typing (left / right hand on the keyboard). */
export type Frame = 0 | 1 | 2 | 3 | 4;
export const ARCHETYPES = ['pilot', 'droid', 'mystic', 'alien', 'engineer'] as const;
/** Random archetypes for sessions, plus the Sinterklaas visitors (holiday NPCs): 'sint' and 'piet' (roetveegpiet). */
export type Archetype = (typeof ARCHETYPES)[number] | 'sint' | 'piet' | 'boss' | 'captain';

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

export interface Look {
  archetype: Archetype;
  color: string;
  skin: string;
}

const cache = new Map<string, HTMLCanvasElement>();

export function getSprite(look: Look, dir: Dir, frame: Frame): HTMLCanvasElement {
  const key = `${look.archetype}|${look.color}|${look.skin}|${dir}|${frame}`;
  let c = cache.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = c.height = 16;
    const ctx = c.getContext('2d')!;
    if (dir === 'left') {
      // left = mirrored right
      ctx.translate(16, 0);
      ctx.scale(-1, 1);
    }
    drawCharacter(ctx, look, dir === 'left' ? 'right' : dir, frame);
    cache.set(key, c);
  }
  return c;
}

type P = (x: number, y: number, w: number, h: number, c: string) => void;

function drawCharacter(ctx: CanvasRenderingContext2D, look: Look, dir: 'down' | 'up' | 'right', drawFrame: Frame) {
  const typing = drawFrame === 3 || drawFrame === 4;
  const frame: 0 | 1 | 2 = typing ? 0 : drawFrame; // legs stand still while typing
  const r: P = (x, y, w, h, c) => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  };
  const { archetype: a, color } = look;
  const side = dir === 'right';
  const metal = '#b8c0cc';

  const body = a === 'droid' ? metal : a === 'mystic' ? CLOAK : color;
  const bodyDark = shade(body, -0.3);
  const bodyLight = shade(body, 0.2);
  const pants =
    a === 'droid' ? shade(metal, -0.3) : a === 'engineer' ? shade(color, -0.35) : a === 'piet' ? '#f2d13d' : a === 'captain' ? '#1d2b4a' : shade(color, -0.45);
  const boots = '#2a2a33';
  const skin = a === 'alien' ? ALIEN_SKINS[Math.max(0, SKINS.indexOf(look.skin)) % ALIEN_SKINS.length] : a === 'droid' ? metal : look.skin;
  const outline = 'rgba(15,18,28,0.85)';

  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(4, 15, 8, 1);
  ctx.fillRect(5, 14, 6, 1);

  // ---- the manager's cape, behind everything (frames 1/2 = swaying while he turns) ----
  if (a === 'boss') {
    const capeC = '#0c0c10';
    const lining = '#a01830';
    const sway = frame === 1 ? 1 : frame === 2 ? -1 : 0;
    if (dir === 'up') {
      r(3, 7, 10, 7, capeC);
      r(3 + sway, 14, 10, 1, capeC);
      r(3, 8, 1, 6, lining);
      r(12, 8, 1, 6, lining);
    } else if (side) {
      r(2, 8, 4, 6, capeC);
      r(1 + sway, 14, 5, 1, capeC);
      r(5, 9, 1, 5, lining);
    } else {
      r(2, 8, 2, 6, capeC);
      r(12, 8, 2, 6, capeC);
      r(2 + sway, 14, 3, 1, capeC);
      r(11 + sway, 14, 3, 1, capeC);
      r(3, 9, 1, 5, lining);
      r(12, 9, 1, 5, lining);
    }
  }

  // ---- legs (or robe hem) ----
  if (a === 'mystic' || a === 'sint' || a === 'boss') {
    const hem = a === 'sint' ? '#f4f6fa' : a === 'boss' ? '#7a1424' : a === 'mystic' ? '#5a4632' : shade(color, -0.35);
    r(4, 11, 8, 3, hem);
    r(3, 13, 10, 1, hem);
    if (frame === 1) r(4, 14, 3, 1, boots);
    else if (frame === 2) r(9, 14, 3, 1, boots);
    else {
      r(5, 14, 2, 1, boots);
      r(9, 14, 2, 1, boots);
    }
  } else if (side) {
    if (frame === 0) {
      r(6, 12, 4, 2, pants);
      r(6, 14, 4, 1, boots);
    } else {
      const [front, back] = frame === 1 ? [9, 5] : [5, 9];
      r(back, 12, 2, 2, shade(pants, -0.2));
      r(back, 14, 2, 1, boots);
      r(front, 12, 2, 2, pants);
      r(front, 14, 2, 1, boots);
      r(7, 12, 2, 1, pants);
    }
  } else {
    const lUp = frame === 1 ? 1 : 0;
    const rUp = frame === 2 ? 1 : 0;
    r(5, 12, 2, 2 - lUp, pants);
    r(5, 14 - lUp, 2, 1, boots);
    r(9, 12, 2, 2 - rUp, pants);
    r(9, 14 - rUp, 2, 1, boots);
  }

  // ---- torso ----
  if (side) {
    r(5, 8, 6, 4, body);
    r(5, 8, 1, 4, bodyLight);
    r(10, 8, 1, 4, bodyDark);
  } else {
    r(4, 8, 8, 4, body);
    r(4, 8, 1, 4, bodyLight);
    r(11, 8, 1, 4, bodyDark);
  }
  if (a === 'droid') {
    r(6, 9, 4, 2, color); // chest panel in session color
    r(4, 11, 8, 1, 'rgba(150,115,70,0.5)'); // dust from a long day
    r(10, 8, 1, 1, '#8a4a2a'); // rust spot
    r(7, 9, 1, 1, shade(color, 0.5));
  } else if (a === 'engineer') {
    r(4, 11, 8, 1, '#7a5230'); // tool belt
    r(5, 9, 1, 1, 'rgba(40,30,20,0.45)'); // grease on the overalls
    r(9, 11, 1, 1, '#d9d9d9');
    if (dir === 'down') r(6, 8, 4, 1, '#e8e2d0');
  } else if (a === 'mystic') {
    r(side ? 5 : 4, 10, side ? 6 : 8, 1, color); // sash in the session color
    if (dir === 'down') r(5, 8, 2, 2, '#c9b48a'); // layered tunic under the cloak
  } else if (a === 'captain') {
    // white uniform: gold epaulettes, gold buttons, navy belt
    r(side ? 5 : 4, 11, side ? 6 : 8, 1, '#1d2b4a');
    if (!side) {
      r(3, 8, 2, 1, '#e5b83b');
      r(11, 8, 2, 1, '#e5b83b');
    }
    if (dir === 'down') {
      r(7, 8, 1, 3, '#d8dde6');
      r(8, 9, 1, 1, '#e5b83b');
      r(8, 10, 1, 1, '#e5b83b');
    }
  } else if (a === 'boss') {
    // black armor: angular shoulder plates, crimson belt, a seam of red light down the front
    r(side ? 5 : 4, 10, side ? 6 : 8, 1, '#5a0d18');
    if (!side) {
      r(3, 7, 3, 2, '#2e3038');
      r(10, 7, 3, 2, '#2e3038');
      r(3, 7, 3, 1, '#4a4e5a');
      r(10, 7, 3, 1, '#4a4e5a');
    } else {
      r(6, 7, 4, 2, '#2e3038');
      r(6, 7, 4, 1, '#4a4e5a');
    }
    if (dir === 'down') {
      r(7, 8, 2, 4, shade(color, 0.15));
      r(7, 9, 2, 1, '#ff3344'); // armor seam glow
    }
  } else if (a === 'piet') {
    // velvet doublet with puffed sleeves and gold buttons, white ruff collar
    if (dir === 'down') {
      r(7, 9, 1, 1, '#e5b83b');
      r(7, 11, 1, 1, '#e5b83b');
    }
    r(4, 11, 8, 1, shade(color, -0.35));
    r(side ? 5 : 4, 7, side ? 6 : 8, 2, '#f4f6fa'); // kraag
    r(side ? 5 : 4, 8, side ? 6 : 8, 1, '#d8dde6');
  } else if (a === 'sint') {
    r(side ? 5 : 4, 11, side ? 6 : 8, 1, '#f4f6fa'); // white trim
    if (dir === 'down') r(7, 8, 2, 3, '#f4f6fa'); // stole
    if (dir === 'down') r(7, 9, 2, 1, '#e5b83b');
  } else if (a === 'pilot') {
    r(4, 11, 8, 1, shade(color, -0.4));
    if (dir === 'down') {
      r(5, 8, 1, 3, '#3a3d45'); // dark utility harness straps
      r(10, 8, 1, 3, '#3a3d45');
      r(6, 9, 4, 1, '#3a3d45');
    }
    if (!side) {
      r(4, 11, 2, 1, '#5a4a36'); // utility pouches
      r(10, 11, 2, 1, '#5a4a36');
    }
  } else {
    r(4, 11, 8, 1, shade(color, -0.4));
  }

  // ---- arms (swing while walking) ----
  const sway = frame === 0 ? 0 : 1;
  const hand = a === 'pilot' ? '#3a3f4c' : skin;
  if (side) {
    const ay = 8 + (frame === 1 ? 1 : 0);
    r(7, ay, 2, 3, bodyDark);
    r(7, ay + 3, 2, 1, hand);
  } else if (typing) {
    // Arms reach forward to the keyboard; one hand lifts higher each frame.
    const lUp = drawFrame === 3 ? 2 : 1;
    const rUp = drawFrame === 4 ? 2 : 1;
    r(3, 8, 1, 2, bodyDark);
    r(4, 8 - lUp, 1, 2, bodyDark);
    r(4, 7 - lUp, 1, 1, hand);
    r(12, 8, 1, 2, bodyDark);
    r(11, 8 - rUp, 1, 2, bodyDark);
    r(11, 7 - rUp, 1, 1, hand);
  } else {
    const ly = 8 + (frame === 1 ? sway : 0);
    const ry = 8 + (frame === 2 ? sway : 0);
    r(3, ly, 1, 3, bodyDark);
    r(3, ly + 3, 1, 1, hand);
    r(12, ry, 1, 3, bodyDark);
    r(12, ry + 3, 1, 1, hand);
  }

  // ---- head ----
  switch (a) {
    case 'pilot': {
      // original flight helmet: gunmetal shell, wraparound tinted visor, side antenna
      const helm = '#6a6e78';
      r(5, 1, 6, 7, helm);
      r(4, 2, 8, 5, helm);
      r(5, 1, 6, 1, shade(helm, 0.25));
      r(4, 2, 8, 1, color); // thin band in the session color
      r(12, 1, 1, 3, '#3a3d45'); // antenna
      r(12, 0, 1, 1, '#9aa0aa');
      r(9, 2, 1, 1, '#8a8e98'); // scuffed paint
      if (dir === 'down') {
        r(4, 4, 8, 2, '#1a2a2e');
        r(5, 4, 2, 1, '#5fd4c8');
      } else if (side) {
        r(8, 4, 4, 2, '#1a2a2e');
        r(10, 4, 1, 1, '#5fd4c8');
      }
      r(4, 6, 8, 1, shade(helm, -0.3));
      break;
    }
    case 'droid': {
      r(5, 2, 6, 6, metal);
      r(5, 2, 6, 1, shade(metal, 0.3));
      r(5, 7, 6, 1, shade(metal, -0.25));
      r(8, 0, 1, 2, '#7a8599'); // antenna
      r(8, 0, 1, 1, color);
      if (dir === 'down') {
        r(6, 4, 4, 2, '#1a1f2b');
        r(7, 4, 2, 1, '#4ff0ff');
      } else if (side) {
        r(8, 4, 3, 2, '#1a1f2b');
        r(9, 4, 2, 1, '#4ff0ff');
      } else {
        r(6, 4, 4, 1, shade(metal, -0.2)); // vent
        r(6, 6, 4, 1, shade(metal, -0.2));
      }
      break;
    }
    case 'mystic': {
      const hood = shade(CLOAK, -0.1);
      r(5, 1, 6, 7, hood);
      r(4, 2, 8, 6, hood);
      r(5, 1, 6, 1, shade(hood, 0.15));
      if (dir === 'down') {
        r(6, 4, 4, 3, shade(skin, -0.35));
        r(6, 5, 1, 1, '#141414');
        r(9, 5, 1, 1, '#141414');
      } else if (side) {
        r(9, 4, 2, 3, shade(skin, -0.35));
        r(10, 5, 1, 1, '#141414');
      }
      break;
    }
    case 'alien': {
      r(4, 2, 8, 6, skin);
      r(5, 1, 6, 1, skin);
      r(4, 2, 8, 1, shade(skin, 0.2));
      // head ridges
      r(6, 1, 1, 2, shade(skin, -0.25));
      r(9, 1, 1, 2, shade(skin, -0.25));
      // antennae
      r(4, 0, 1, 2, shade(skin, -0.2));
      r(11, 0, 1, 2, shade(skin, -0.2));
      r(4, 0, 1, 1, '#f2d13d');
      r(11, 0, 1, 1, '#f2d13d');
      if (dir === 'down') {
        r(5, 4, 2, 2, '#101418');
        r(9, 4, 2, 2, '#101418');
        r(5, 4, 1, 1, '#ffffff');
        r(9, 4, 1, 1, '#ffffff');
      } else if (side) {
        r(9, 4, 2, 2, '#101418');
        r(10, 4, 1, 1, '#ffffff');
      }
      break;
    }
    case 'captain': {
      // you: navy peaked cap with a gold badge
      r(5, 2, 6, 6, skin);
      r(4, 1, 8, 2, '#1d2b4a');
      r(5, 0, 6, 1, '#1d2b4a');
      r(4, 1, 8, 1, '#2a3c66');
      r(7, 1, 2, 1, '#e5b83b'); // badge
      if (dir === 'down') {
        r(4, 3, 8, 1, '#0e1526'); // brim
        r(6, 5, 1, 1, '#141414');
        r(9, 5, 1, 1, '#141414');
        r(7, 7, 2, 1, '#c0504a');
      } else if (side) {
        r(8, 3, 5, 1, '#0e1526');
        r(10, 5, 1, 1, '#141414');
      } else {
        r(5, 3, 6, 3, '#4a3020'); // hair under the cap
      }
      break;
    }
    case 'boss': {
      // original angular helmet: black plates, swept-back horn fins, a glowing red visor slit
      const helm = '#1c1d24';
      const edge = '#3a3c48';
      r(5, 1, 6, 7, helm);
      r(4, 2, 8, 5, helm);
      r(5, 1, 6, 1, edge);
      r(7, 0, 2, 2, edge); // ridge crest
      // horn fins sweeping up and out
      r(3, 2, 1, 3, helm);
      r(2, 0, 1, 3, helm);
      r(12, 2, 1, 3, helm);
      r(13, 0, 1, 3, helm);
      r(2, 0, 1, 1, edge);
      r(13, 0, 1, 1, edge);
      if (dir === 'down') {
        r(5, 4, 6, 1, '#ff2a3a');
        r(6, 4, 4, 1, '#ff8a94');
        r(5, 6, 1, 1, edge); // cheek plates, angled
        r(10, 6, 1, 1, edge);
        r(6, 7, 4, 1, '#121318');
      } else if (side) {
        r(8, 4, 4, 1, '#ff2a3a');
        r(10, 4, 1, 1, '#ff8a94');
        r(10, 6, 2, 1, edge);
      } else {
        r(5, 3, 6, 1, edge);
        r(6, 5, 4, 1, edge);
      }
      break;
    }
    case 'piet': {
      // roetveegpiet: own skin tone with a few soot smudges, beret with a feather
      r(5, 2, 6, 6, skin);
      const soot = 'rgba(40,36,36,0.75)';
      if (dir === 'down') {
        r(6, 4, 1, 1, '#141414');
        r(9, 4, 1, 1, '#141414');
        r(5, 5, 2, 1, soot); // cheek
        r(9, 6, 1, 1, soot); // other cheek
        r(7, 6, 1, 1, soot); // nose
        r(7, 7, 2, 1, '#c0504a'); // smile
      } else if (side) {
        r(9, 4, 1, 1, '#141414');
        r(8, 5, 2, 1, soot);
        r(10, 6, 1, 1, soot);
      } else {
        r(5, 3, 6, 4, '#3b2a1e'); // hair from behind
        r(6, 5, 2, 1, soot);
      }
      // beret, tilted, with a long feather
      const cap = shade(color, -0.25);
      r(4, 1, 8, 2, cap);
      r(5, 0, 6, 1, cap);
      r(4, 3, 8, 1, shade(cap, -0.3));
      r(10, -1, 1, 2, '#f4f6fa');
      r(11, -3, 1, 3, '#f4f6fa');
      r(12, -4, 1, 2, '#e8e8e8');
      break;
    }
    case 'sint': {
      // white beard, red mitre with a gold band, golden staff
      r(5, 3, 6, 4, skin);
      const mitre = '#c8102e';
      r(6, -1 + 1, 4, 1, mitre);
      r(5, 1, 6, 2, mitre);
      r(5, 3, 6, 1, '#e5b83b');
      r(7, 0, 2, 3, '#e5b83b');
      if (dir === 'down') {
        r(6, 4, 1, 1, '#141414');
        r(9, 4, 1, 1, '#141414');
        r(5, 5, 6, 3, '#f4f6fa'); // beard
        r(6, 8, 4, 1, '#f4f6fa');
        r(7, 5, 2, 1, '#e4e8ef'); // moustache
      } else if (side) {
        r(9, 4, 1, 1, '#141414');
        r(8, 5, 4, 3, '#f4f6fa');
      } else {
        r(5, 3, 6, 3, '#f4f6fa'); // hair from behind
      }
      // staff
      const sx = side ? 12 : 13;
      r(sx, 2, 1, 12, '#e5b83b');
      r(sx - 1, 0, 2, 1, '#e5b83b');
      r(sx - 2, 1, 1, 2, '#e5b83b');
      break;
    }
    case 'engineer': {
      const hair = '#3b2a1e';
      r(5, 2, 6, 6, skin);
      if (dir === 'down') r(9, 6, 1, 1, 'rgba(40,30,20,0.55)'); // grease smudge
      r(5, 1, 6, 2, hair);
      r(4, 2, 1, 3, hair);
      r(11, 2, 1, 3, hair);
      if (dir === 'up') r(5, 2, 6, 4, hair);
      r(4, 3, 8, 1, '#555b66'); // goggles strap
      if (dir === 'down') {
        r(5, 3, 2, 1, '#f2d13d');
        r(9, 3, 2, 1, '#f2d13d');
        r(6, 5, 1, 1, '#141414');
        r(9, 5, 1, 1, '#141414');
      } else if (side) {
        r(9, 3, 2, 1, '#f2d13d');
        r(10, 5, 1, 1, '#141414');
      }
      break;
    }
  }

  // subtle outline under the head for readability
  ctx.fillStyle = outline;
  ctx.globalAlpha = 0.25;
  ctx.fillRect(5, 8, 6, 1);
  ctx.globalAlpha = 1;
}
