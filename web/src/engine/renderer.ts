// Canvas renderer: owns worker entities, moves them along A* paths, runs the camera,
// and draws the office through the angled orthographic camera of mesh.ts. All camera math goes through
// its constants (ISO_MATRIX, SKEW, ZK, ISO_ZSCALE) and iso()/unIso()/isoOf(); nothing here assumes an angle.
//
// Spaces used below:
//   plan      art units, project() of a world point: (x + SKEW·z, y − ZK·z); the floor is the tile grid
//             (16 per tile).
//   screen    art units, iso(u, v) (= ISO_MATRIX). The camera centre (cx, cy) lives here.
//   device    canvas pixels: ox + screenX * s, oy + screenY * s, with s = the zoom scale.
// World-plane things (floor glows, highlights, animated furniture) are drawn in "plan mode": the canvas
// transform maps plan * s (what px()/py() return) to device px. Billboards (sprites, text, bubbles) are
// drawn in "screen mode" (identity transform) at device points from toScreen()/worldScreen().
import { ENTRANCE_ROOM, SLEEP_ROOM, type RoomId } from '../../../shared/rooms.config';
import { REPORT_ACTION, type SessionState, type WorkerStatus } from '../../../shared/types';
import { displayName, shorten } from '../../../shared/names';
import { hash, loadMap, type OfficeMap, type Tile } from './map';
import { HOLIDAY_INFO, HolidayDecor, currentDate, currentHoliday, giftsUnderTree, santaHat, type DecorView, type Holiday } from './holidays';
import { findPath } from './pathfinding';
import { ARCHETYPES, CHAR_SCALE, SESSION_COLORS, SKINS, SPRITE_FEET, SPRITE_HEAD, SPRITE_UNITS, getSprite, type Dir, type Frame, type Look } from './sprites';
import { DOOR_BOX, DOOR_STEPS, MAX_RISE, RACK_LEDS, STRIP_PAD, WALL_IN, WALL_RISE, doorImage, renderLayers, windowGlass, type MapLayers } from './tiles';
import { JUKE_BANDS, JUKE_RECORD } from './furniture';
import { ART_RES, poly, shade, softShadow, type Pt } from './lowpoly';
import { ISO_MATRIX, ISO_ZSCALE, Mesh, SKEW, ZK, iso, isoOf, unIso, type V3 } from './mesh';

/** UI font stack for every bit of canvas text. */
const UI_FONT = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

/**
 * Cached radial glow sprites ("r,g,b" + falloff), drawn with drawImage + globalAlpha instead of creating
 * a gradient per light per frame. `soft` falls off linearly; `hot` has a bright core.
 */
const glowCache = new Map<string, HTMLCanvasElement>();
function glowSprite(rgb: string, kind: 'soft' | 'hot' = 'soft'): HTMLCanvasElement {
  const key = `${rgb}|${kind}`;
  let c = glowCache.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = c.height = 128;
    const g2 = c.getContext('2d')!;
    const g = g2.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, `rgba(${rgb},1)`);
    if (kind === 'hot') {
      g.addColorStop(0.18, `rgba(${rgb},0.7)`);
      g.addColorStop(0.5, `rgba(${rgb},0.18)`);
    }
    g.addColorStop(1, `rgba(${rgb},0)`);
    g2.fillStyle = g;
    g2.fillRect(0, 0, 128, 128);
    glowCache.set(key, c);
  }
  return c;
}

/** One cached contact shadow (full alpha), scaled and faded per character. */
let shadowSprite: HTMLCanvasElement | null = null;
function contactShadow(): HTMLCanvasElement {
  if (!shadowSprite) {
    shadowSprite = document.createElement('canvas');
    shadowSprite.width = 128;
    shadowSprite.height = 64;
    softShadow(shadowSprite.getContext('2d')!, 64, 32, 64, 32, 1);
  }
  return shadowSprite;
}

/** Map sprite-unit coordinates (0..16 across the sprite box) to screen points. */
function unitPts(x: number, y: number, u: number, pts: Array<[number, number]>): Pt[] {
  return pts.map(([a, b]) => [x + a * u, y + b * u]);
}

function hexRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${n >> 16},${(n >> 8) & 255},${n & 255}`;
}

/** Where a worker's feet stand inside its tile (fraction of a tile, plan x / y). */
const FOOT_X = 0.5;
const FOOT_Y = 0.5;
/** Sub-agent helpers are drawn at 12/16 of full size. */
const SUB_SCALE = 12 / 16;

/**
 * Plan-space lean of a point `z` art units up: (SKEW·z, −ZK·z), as in mesh.ts project(). In this camera
 * both components are negative (things lean up and left in plan).
 */
const leanU = (z: number) => SKEW * z;
const leanV = (z: number) => -ZK * z;
/**
 * A circle of radius r on the floor shows on screen as an axis-aligned ellipse r wide and r·FLOOR_RY
 * tall: ISO_MATRIX is a turn about the vertical followed by a vertical squash, so its top row has unit
 * length and the bottom row's length is the squash. (Drawing it as a screen ellipse keeps line widths
 * and dashes even, which a stroke in plan mode wouldn't.)
 */
const FLOOR_RY = Math.hypot(ISO_MATRIX[1], ISO_MATRIX[3]);
/** Screen-space depth of a tile position (larger = nearer the viewer), for front-most-first ordering. */
const depthOf = (x: number, y: number) => {
  const [, sy] = iso(x, y);
  return sy;
};

/** World → screen for the props built around a character (scaled like the characters themselves). */
const charProj = (v: V3): [number, number] => {
  const [sx, sy] = isoOf(v);
  return [sx * CHAR_SCALE, sy * CHAR_SCALE];
};

/**
 * Bake a mesh built around a character's feet (world origin) into a SPRITE_UNITS canvas aligned like
 * the character sprites (origin at SPRITE_FEET), so it can be drawn with the same box.
 */
const propCache = new Map<string, HTMLCanvasElement>();
function propSprite(key: string, build: (m: Mesh) => void): HTMLCanvasElement {
  let c = propCache.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = c.height = SPRITE_UNITS * ART_RES;
    const g = c.getContext('2d')!;
    g.scale(ART_RES, ART_RES);
    const m = new Mesh(7);
    build(m);
    m.draw(g, SPRITE_FEET[0], SPRITE_FEET[1], charProj);
    if (propCache.size > 64) propCache.clear();
    propCache.set(key, c);
  }
  return c;
}

/** Office chair seen from behind a typing worker (who faces -y): backrest, post and star base at +y. */
function officeChair(color: string): HTMLCanvasElement {
  return propSprite(`chair:${color}`, (m) => {
    const back = '#2a2f3b';
    m.cylinder(0, 2.6, 0, 2.7, 2.4, 0.45, 5, '#232833', { rot: 0.3, topColor: '#3a4150' });
    m.cylinder(0, 2.6, 0.45, 0.4, 0.4, 3.6, 6, '#1c2029');
    m.box(-3, 2.2, 3.6, 6, 1.3, 5.4, back, { chamfer: 0.5, bevel: 0.45, bevelH: 0.35, topColor: '#444b5c' });
    // a stripe in the session colour across the back of the backrest
    m.face([[-2.1, 3.52, 6.6], [2.1, 3.52, 6.6], [2.1, 3.52, 7.3], [-2.1, 3.52, 7.3]], color, { emissive: true, layer: 1, alpha: 0.75 });
  });
}

/** The manager's high-backed leather chair, behind him (he faces +y). */
function bossChair(): HTMLCanvasElement {
  return propSprite('bosschair', (m) => {
    const frame = '#1c1820';
    const leather = '#3a2a3a';
    m.box(-3.6, -2.6, 0, 7.2, 6, 3.4, frame, { chamfer: 0.6 });
    m.box(-4.6, -4.4, 0, 9.2, 1.8, 15, frame, { chamfer: 0.5, bevel: 0.5, bevelH: 0.4, topColor: '#4a3a4a' });
    // tufted cushions on the front of the back, lit by the room
    for (const [z0, z1] of [[3.6, 7.6], [7.8, 11.4], [11.6, 14.2]]) {
      m.box(-3.8, -2.7, z0, 3.7, 0.5, z1 - z0, leather, { chamfer: 0.2, layer: 1 });
      m.box(0.1, -2.7, z0, 3.7, 0.5, z1 - z0, shade(leather, -0.05), { chamfer: 0.2, layer: 1 });
    }
    for (const [bx, bz] of [[-2, 7.7], [2, 7.7], [-2, 11.5], [2, 11.5]])
      m.ball(bx, -2.1, bz, 0.45, 0.3, 0.45, '#c8a96a', { layer: 2, jitter: 0 });
  });
}

const WALK_SPEED = 4.2; // tiles per second
const STEP_FRAMES = [1, 0, 2, 0] as const; // walk cycle
const FRESH_BUBBLE_MS = 8000; // bubbles fade back after this long
const MIN_ZOOM = 0.5; // 1 = whole office fits; below that you get space around it
const MAX_ZOOM = 6;
const POKE_MS = 650;
/** Rooms where seated workers type at their desk (the code-writing room). */
const TYPING_ROOMS: ReadonlySet<RoomId> = new Set<RoomId>(['workshop']);
const CODE_CHARS = ['{', '}', ';', '<', '>', '(', ')', '=', '/', '[', ']', '*'];
/** After hours, workers with nothing to do head to the cantina (the lounge, transformed). */
const CANTINA: RoomId = 'lounge';
const CANTINA_FROM = 16.5; // 16:30
const CANTINA_UNTIL = 24; // midnight
const BEAT_MS = 480; // ~125 bpm
const NOTE_CHARS = ['♪', '♫', '♩', '♬'];
const DISCO = ['255,80,160', '80,200,255', '255,220,80', '140,255,120'];
/** The Sinterklaas visitor: a non-session character who strolls around during the Sinterklaas period. */
const SINT_ID = 'npc:sint';
/** Roetveegpieten: helpers who stroll around with Sinterklaas and hand out pepernoten. */
const PIETEN = [
  { id: 'npc:piet:0', name: 'Piet', color: '#2f6fd6', skin: '#f1c27d' },
  { id: 'npc:piet:1', name: 'Piet', color: '#d42a2a', skin: '#c68642' },
];
const PIET_LINES = ['Pepernoten! 🍪', 'Wie wil er een cadeautje? 🎁', 'Hup hup! 🏃', 'Waar is de Sint gebleven?', 'Even door de schoorsteen…'];
const PIET_SPEED = 1.1; // a touch quicker than everyone else
/** Holiday visitors keep to the background: short bubbles, long pauses, one hello per worker per 10 min. */
const NPC_BUBBLE_MS = 3200;
const GREET_COOLDOWN_MS = 10 * 60_000;
const VISITORS_KEY = 'claude-office.visitors';
/** The manager: an original armored station commander who sits behind the desk in the manager's office. */
const BOSS_ID = 'npc:boss';
const BOSS_ROOM: RoomId = 'reception';
const BOSS_ASSIGN = [
  (n: string) => `${n}. You have your orders.`,
  (n: string) => `${n}, this task will be finished. On time.`,
  (n: string) => `Report to me when it is done, ${n}.`,
  (n: string) => `${n}… I expect nothing less than perfection.`,
];
const BOSS_IDLE = [
  'Your progress is… insufficient.',
  'This sprint will not slip.',
  'I expect a green build. Today.',
  'The deadline is not a suggestion.',
  'Excuses are not deliverables.',
  'Silence. I am reviewing the metrics.',
];
const BOSS_RECEIVE = [
  (n: string) => `Your report is noted, ${n}.`,
  (n: string) => `${n}. I will review this personally.`,
  (n: string) => `Finally. Leave it on the desk, ${n}.`,
  (n: string) => `Adequate work, ${n}. Dismissed.`,
];
const BOSS_SPEAK_MS = 3000; // lights stay dimmed this long after he speaks
/** The guard: keeps watch over the Sleeping Quarters and fetches sleepers when the Manager asks. */
const GUARD_ID = 'npc:guard';
const GUARD_IDLE = ['All quiet.', 'Lights out means lights out.', 'Nobody sleeps on my watch… except them.', 'Shh. They’re resting.'];
/** You: walk around with the arrow keys / WASD and press E to talk to someone. */
export const PLAYER_ID = 'npc:you';
/** Default names of the non-session characters (for the rename card). */
export const NPC_INFO: Record<string, { name: string; role: string }> = {
  'npc:you': { name: 'You', role: 'That\'s you. Walk with the arrow keys / WASD, press E to talk.' },
  'npc:boss': { name: 'The Manager', role: 'Runs the Manager\'s Office, hands out new tasks and collects the reports. Press E next to him to read them, or to wake a sleeper.' },
  'npc:guard': { name: 'The Guard', role: 'Watches the Sleeping Quarters and fetches sleepers when the Manager sends him.' },
  'npc:sint': { name: 'Sinterklaas', role: 'Holiday visitor (15 Nov – 5 Dec).' },
  'npc:piet:0': { name: 'Piet', role: 'Holiday visitor (15 Nov – 5 Dec).' },
  'npc:piet:1': { name: 'Piet', role: 'Holiday visitor (15 Nov – 5 Dec).' },
};
const PLAYER_SPEED = 4.8; // tiles per second
const TALK_RANGE = 1.8; // tiles
const MOVE_KEYS: Record<string, [number, number]> = {
  ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0], W: [0, -1], S: [0, 1], A: [-1, 0], D: [1, 0],
};
const isNpc = (id: string) => id.startsWith('npc:');
const SINT_LINES = ['Dag allemaal! 🎁', 'Pepernoten, iemand? 🍪', 'Wat een harde werkers!', 'Heb je je schoen al gezet? 👞'];

export interface Worker {
  id: string;
  sessionId: string;
  isSub: boolean;
  name: string;
  look: Look;
  room: RoomId;
  spot: Tile;
  /** Position in tiles (fractional while walking). */
  x: number;
  y: number;
  path: Tile[];
  dir: Dir;
  /** Distance walked, drives the walk cycle. */
  walked: number;
  status: WorkerStatus;
  action: string;
  actionAt: number;
  /** Walking out; removed on arrival. */
  leaving: boolean;
  /** Moving under keyboard control (the player). */
  moving?: boolean;
  /** Prompts from you waiting in this session's mailbox. */
  mail?: number;
  /** Asleep, and the guard is on the way to wake them. */
  waking?: boolean;
  /** The name before any nickname you gave them. */
  baseName?: string;
  /**
   * Fetching a new task from the Manager: they finish the walk to his desk and stand there for a moment
   * before following the session to its next room (`pendingRoom`). `briefedAt` is when they arrived.
   */
  errand?: { pendingRoom?: RoomId; briefedAt?: number };
}

/** How long a worker stands at the Manager's desk to get their new task before heading off. */
const BRIEFING_MS = 2200;

/** What's under the pointer. Worker ids: session id for the main worker, `${sessionId}:${agentId}` for helpers. */
export type Pick = { kind: 'worker'; sessionId: string; workerId: string } | { kind: 'room'; roomId: RoomId } | null;

export interface Selection {
  sessionId: string | null;
  workerId: string | null;
  roomId: RoomId | null;
}

export interface CameraState {
  zoom: number;
  following: string | null;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a worker's name tag and bubble go this frame (after overlap avoidance). */
interface Callout {
  w: Worker;
  head: { x: number; y: number };
  tag: { text: string; fs: number; w: number; h: number };
  bubble?: { text: string; fs: number; w: number; h: number; waiting: boolean; alpha: number };
  box: Rect;
}

export class OfficeRenderer {
  readonly map: OfficeMap;
  private readonly layers: MapLayers;
  private readonly ctx: CanvasRenderingContext2D;
  private workers = new Map<string, Worker>();
  /** Sliding doors, by row: how far open each one is (0 = shut, 1 = open). */
  private doors = new Map<number, Array<{ x: number; y: number; open: number }>>();
  private doorClock = 0;
  /** "x,y" -> worker id */
  private occupied = new Map<string, string>();
  private raf = 0;
  private last = 0;
  private dpr = 1;
  private synced = false;
  private sel: Selection = { sessionId: null, workerId: null, roomId: null };
  private hover: Pick = null;
  private pokes = new Map<string, number>();
  private readonly animated: {
    racks: Map<number, Tile[]>;
    holos: Map<number, Tile[]>;
    jukes: Tile[];
    windows: Map<number, Array<{ x: number; gx: number; gy: number; gw: number; gh: number }>>;
    lights: Array<{ t: Tile; color: string; r: number }>;
  };
  /** Optional fixed hour for testing lighting (?hour=22). */
  private readonly hourOverride: number | null;
  private lastCallouts: Callout[] = [];
  private lastSessions: SessionState[] = [];
  private evening = false;
  private eveningCheckAt = 0;
  private holiday: Holiday = null;
  private readonly decor: HolidayDecor;
  /** Sinterklaas: when to pick the next stroll, and who he's walking up to. */
  /** Holiday visitors (Sinterklaas + pieten): when each picks its next stroll, and who it's walking up to. */
  private npcs = new Map<string, { nextAt: number; greeting: string | null }>();
  /** Handfuls of pepernoten in flight: thrown from (x, y) in map pixels at time t0. */
  private throws: Array<{ x: number; y: number; t0: number; seed: number }> = [];

  // ----- camera (center in screen art units, zoom relative to "whole office fits") -----
  private baseScale = 1;
  private zoom = 1;
  private targetZoom = 1;
  private cx = 0;
  private cy = 0;
  private tcx = 0;
  private tcy = 0;
  private followId: string | null = null;
  /** Derived each frame from the camera. */
  private scale = 1;
  private ox = 0;
  private oy = 0;
  onCameraChange?: (c: CameraState) => void;
  /** Called when you press E next to a session's worker (helpers included): open the prompt dialog. */
  onTalk?: (workerId: string) => void;
  /** Called when you press E next to the Manager: open his desk (reports, new sessions). */
  onManager?: () => void;
  /** Reports on the Manager's desk you haven't read yet (shown on his name tag). */
  private unreadReports = 0;
  /** Claude's questions waiting at the Manager's desk (shown on his name tag). */
  private openQuestions = 0;
  /** Called when you walk out through the airlock (true) or come back in (false). */
  onPlayerAway?: (away: boolean) => void;
  /** You left the office through the airlock; remembered per browser. */
  private playerAway = readAway();
  private keys = new Set<string>();
  /** Names you gave people (worker id -> name). */
  private nicknames: Record<string, string> = {};
  /** Who you're close enough to talk to. */
  private nearbyId: string | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.map = loadMap();
    this.layers = renderLayers(this.map);
    this.ctx = canvas.getContext('2d')!;
    this.animated = this.findAnimatedTiles();
    for (let y = 0; y < this.map.h; y++)
      for (let x = 0; x < this.map.w; x++) {
        const c = this.map.at(x, y);
        if (c === 'D' || c === 'E') this.doors.set(y, [...(this.doors.get(y) ?? []), { x, y, open: 0 }]);
      }
    const h = new URLSearchParams(location.search).get('hour');
    this.hourOverride = h !== null && !Number.isNaN(Number(h)) ? Number(h) : null;
    [this.cx, this.cy] = this.homeCenter();
    [this.tcx, this.tcy] = [this.cx, this.cy];
    this.evening = this.isEvening();
    this.bossSeat = this.findBossSeat();
    this.guardPost = this.findGuardPost();
    this.decor = new HolidayDecor(this.map, this.bossTiles());
    this.applyHoliday();
  }

  /** Pick up the season (and today's gift count); decorations block the tiles they stand on. */
  private applyHoliday() {
    const h = currentHoliday();
    this.decor.giftCount = giftsUnderTree(currentDate());
    if (h === this.holiday && this.synced) return;
    this.holiday = h;
    this.map.setBlocked([...this.decor.blockedTiles(h), ...this.bossTiles()]);
    // anyone standing where a decoration now is gets a new spot
    for (const w of this.workers.values()) {
      if (w.leaving || isNpc(w.id) || this.map.isWalkable(w.spot[0], w.spot[1])) continue;
      this.releaseSpot(w);
      w.spot = this.claimSpot(w.id, w.room);
      this.walkTo(w, w.spot);
    }
  }

  // ---------- time of day ----------

  /** Local hour as a fraction (17.5 = 17:30), or the ?hour= override. */
  private hour(): number {
    const d = new Date();
    return this.hourOverride ?? d.getHours() + d.getMinutes() / 60;
  }

  isEvening(): boolean {
    const h = this.hour();
    return h >= CANTINA_FROM && h < CANTINA_UNTIL;
  }

  /** Where a worker should be shown: after hours, anyone not working goes to the cantina. */
  private displayRoom(room: RoomId, status: WorkerStatus): RoomId {
    if (room === SLEEP_ROOM) return room; // sleepers don't go partying
    return this.evening && (status === 'resting' || status === 'idle') ? CANTINA : room;
  }

  /** In the cantina with nothing to do: dance, drink, enjoy the music. */
  private partying(w: Worker): boolean {
    return (
      this.evening && w.room === CANTINA && !w.path.length && !w.leaving && !isNpc(w.id) && (w.status === 'resting' || w.status === 'idle')
    );
  }

  start() {
    const loop = (t: number) => {
      const dt = this.last ? Math.min((t - this.last) / 1000, 0.1) : 0;
      this.last = t;
      this.update(dt);
      this.updateCamera(dt);
      this.draw(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  /** Fit the canvas to its CSS box. */
  resize(cssW: number, cssH: number) {
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    const b = this.mapBounds();
    this.baseScale = Math.min(this.canvas.width / (b.x1 - b.x0), this.canvas.height / (b.y1 - b.y0));
    this.applyCamera();
  }

  setSelection(sel: Selection) {
    this.sel = sel;
  }

  // ---------- camera ----------

  /**
   * Screen-space bounding box (art units) of a plan rectangle's floor, raised by `rise` art units on top
   * (heights point straight up the screen, scaled by ISO_ZSCALE).
   */
  private screenBounds(u0: number, v0: number, u1: number, v1: number, rise: number) {
    const pts = [iso(u0, v0), iso(u1, v0), iso(u0, v1), iso(u1, v1)];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys) - rise * ISO_ZSCALE, y1: Math.max(...ys) };
  }

  /** The map's screen-space bounding box (art units): the floor plus whatever stands on it. */
  private mapBounds() {
    const T = this.map.tileSize;
    return this.screenBounds(0, 0, this.map.w * T, this.map.h * T, MAX_RISE);
  }

  private homeCenter(): [number, number] {
    const b = this.mapBounds();
    return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
  }

  /** Screen-space point (art units) the camera centres on to look at a worker. */
  private workerCenter(w: Worker): [number, number] {
    const T = this.map.tileSize;
    // about the middle of the figure
    return isoOf([(w.x + FOOT_X) * T, (w.y + FOOT_Y) * T, 6 * CHAR_SCALE]);
  }

  private emitCamera() {
    this.onCameraChange?.({ zoom: this.targetZoom, following: this.followId });
  }

  private clampCenter(x: number, y: number, zoom: number): [number, number] {
    const b = this.mapBounds();
    const s = this.baseScale * zoom;
    const halfW = this.canvas.width / 2 / s;
    const halfH = this.canvas.height / 2 / s;
    const minX = b.x0 + halfW;
    const maxX = b.x1 - halfW;
    const minY = b.y0 + halfH;
    const maxY = b.y1 - halfH;
    const [hx, hy] = this.homeCenter();
    return [minX > maxX ? hx : Math.max(minX, Math.min(maxX, x)), minY > maxY ? hy : Math.max(minY, Math.min(maxY, y))];
  }

  private applyCamera() {
    this.scale = this.baseScale * this.zoom;
    this.ox = this.canvas.width / 2 - this.cx * this.scale;
    this.oy = this.canvas.height / 2 - this.cy * this.scale;
  }

  private updateCamera(dt: number) {
    if (this.followId) {
      const w = this.workers.get(this.followId);
      if (w && !w.leaving) {
        const [fx, fy] = this.workerCenter(w);
        [this.tcx, this.tcy] = this.clampCenter(fx, fy, this.targetZoom);
      } else this.follow(null);
    }
    const k = Math.min(1, dt * 10);
    this.zoom += (this.targetZoom - this.zoom) * k;
    this.cx += (this.tcx - this.cx) * k;
    this.cy += (this.tcy - this.cy) * k;
    this.applyCamera();
  }

  private toCanvas(clientX: number, clientY: number): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [(clientX - r.left) * (this.canvas.width / r.width), (clientY - r.top) * (this.canvas.height / r.height)];
  }

  /** Zoom by `factor`, keeping the point under the cursor fixed (or the view center). */
  zoomBy(factor: number, clientX?: number, clientY?: number) {
    const nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.targetZoom * factor));
    let [ax, ay] = [this.canvas.width / 2, this.canvas.height / 2];
    if (clientX !== undefined && clientY !== undefined && !this.followId) [ax, ay] = this.toCanvas(clientX, clientY);
    // map point under the anchor, using the camera we're heading to
    const curScale = this.baseScale * this.targetZoom;
    const mx = this.tcx + (ax - this.canvas.width / 2) / curScale;
    const my = this.tcy + (ay - this.canvas.height / 2) / curScale;
    const ns = this.baseScale * nz;
    this.targetZoom = nz;
    [this.tcx, this.tcy] = this.clampCenter(mx - (ax - this.canvas.width / 2) / ns, my - (ay - this.canvas.height / 2) / ns, nz);
    this.emitCamera();
  }

  /** Pan by a drag delta in client pixels. Cancels follow. */
  panBy(dxClient: number, dyClient: number) {
    if (this.followId) this.follow(null);
    const r = this.canvas.getBoundingClientRect();
    const s = this.baseScale * this.targetZoom * (r.width / this.canvas.width);
    [this.tcx, this.tcy] = this.clampCenter(this.tcx - dxClient / s, this.tcy - dyClient / s, this.targetZoom);
    // dragging should feel attached to the pointer: skip smoothing for position
    [this.cx, this.cy] = [this.tcx, this.tcy];
  }

  resetView() {
    this.follow(null);
    this.targetZoom = 1;
    [this.tcx, this.tcy] = this.homeCenter();
    this.emitCamera();
  }

  focusRoom(id: RoomId) {
    this.follow(null);
    const T = this.map.tileSize;
    const [x0, y0, x1, y1] = this.map.rooms[id].rect;
    // the room's floor on screen, plus its back walls rising above it
    const { x0: left, x1: right, y0: top, y1: bottom } = this.screenBounds(x0 * T, y0 * T, (x1 + 1) * T, (y1 + 1) * T, WALL_RISE);
    const z = Math.min(this.canvas.width / ((right - left) * this.baseScale), this.canvas.height / ((bottom - top) * this.baseScale)) * 0.9;
    this.targetZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    [this.tcx, this.tcy] = this.clampCenter((left + right) / 2, (top + bottom) / 2, this.targetZoom);
    this.emitCamera();
  }

  focusWorker(id: string) {
    const w = this.workers.get(id);
    if (!w) return;
    this.targetZoom = Math.max(this.targetZoom, 3.2);
    const [fx, fy] = this.workerCenter(w);
    [this.tcx, this.tcy] = this.clampCenter(fx, fy, this.targetZoom);
    this.emitCamera();
  }

  /** Keep the camera on a worker as it walks (null to stop). */
  follow(id: string | null) {
    this.followId = id && this.workers.has(id) ? id : null;
    if (this.followId) this.focusWorker(this.followId);
    this.emitCamera();
  }

  /** Little hop when you click someone. */
  poke(workerId: string) {
    this.pokes.set(workerId, performance.now());
  }

  // ---------- nicknames ----------

  setNicknames(n: Record<string, string>) {
    this.nicknames = n;
    for (const w of this.workers.values()) this.applyName(w);
  }

  private applyName(w: Worker) {
    w.baseName ??= w.name;
    const nick = this.nicknames[w.id];
    w.name = nick ? shorten(nick, 22) : w.baseName;
  }

  // ---------- you (keyboard-controlled) ----------

  /** Returns true if the key is a movement key (so the caller can preventDefault). */
  keyDown(key: string): boolean {
    if (!MOVE_KEYS[key]) return false;
    this.keys.add(key);
    return true;
  }

  keyUp(key: string) {
    this.keys.delete(key);
  }

  clearKeys() {
    this.keys.clear();
  }

  /** E / Enter: talk to whoever is next to you. */
  interact() {
    const target = this.nearbyId ? this.workers.get(this.nearbyId) : undefined;
    const me = this.workers.get(PLAYER_ID);
    if (!target || !me) return;
    const now = performance.now();
    this.poke(target.id); // they hop and turn to you
    if (target.id === BOSS_ID) {
      if (this.openQuestions) {
        me.action = 'Someone has a question?';
        target.action = this.openQuestions > 1 ? `${this.openQuestions} questions. Answer them.` : 'One question. Answer it.';
      } else if (this.unreadReports) {
        me.action = 'Any reports for me?';
        target.action = `${this.unreadReports} on my desk. Read them.`;
      } else {
        me.action = 'I have a new assignment.';
        target.action = 'Name the project. I will assign the work.';
      }
      this.onManager?.();
    } else if (target.id === SINT_ID) {
      me.action = 'Dag Sinterklaas!';
      target.action = 'Dag kapitein! Ben je wel lief geweest? 🎁';
    } else if (target.id.startsWith('npc:piet')) {
      me.action = 'Hoi Piet!';
      target.action = 'Hier, een pepernoot voor jou! 🍪';
      this.throwPepernoten(target, now);
    } else if (target.id === GUARD_ID) {
      me.action = 'Evening, officer.';
      target.action = this.guardTarget ? 'Busy. Manager’s orders.' : 'Need someone woken? Ask the Manager.';
    } else {
      me.action = `Hey ${target.name}, I have a task for you.`;
      me.actionAt = now;
      this.onTalk?.(target.id);
      return;
    }
    me.actionAt = now;
    target.actionAt = now;
  }

  get talkTarget(): string | null {
    return this.nearbyId;
  }

  get isPlayerAway() {
    return this.playerAway;
  }

  /** The "Enter the office" button: come back in through the airlock. */
  enterOffice() {
    if (!this.playerAway) return;
    this.setAway(false);
    const now = performance.now();
    const [ex, ey] = this.map.entrance;
    this.spawnPlayer(now, [ex, ey]);
    const me = this.workers.get(PLAYER_ID)!;
    me.dir = 'right';
    me.action = "I'm back!";
    this.follow(PLAYER_ID);
  }

  private setAway(away: boolean) {
    this.playerAway = away;
    writeAway(away);
    this.onPlayerAway?.(away);
  }

  /** Standing in the airlock doorway? */
  private onAirlock(me: Worker) {
    return this.map.at(Math.floor(me.x + FOOT_X), Math.floor(me.y + FOOT_Y)) === 'E';
  }

  private spawnPlayer(now: number, at?: Tile) {
    const spot = at ?? this.map.spots.reception.find(([x, y]) => this.map.isWalkable(x, y)) ?? this.map.entrance;
    const me: Worker = {
      id: PLAYER_ID, sessionId: PLAYER_ID, isSub: false, name: 'You',
      look: { archetype: 'captain', color: '#f4f6fa', skin: '#f1c27d' },
      room: 'reception', spot, x: spot[0], y: spot[1], path: [], dir: 'down', walked: 0,
      status: 'resting', action: 'Arrow keys / WASD to walk, E to talk', actionAt: now, leaving: false,
    };
    this.workers.set(PLAYER_ID, me);
    this.applyName(me);
  }

  /** Can your feet be at (x, y)? Checks a small box around the feet against walkable tiles. */
  private playerFits(x: number, y: number) {
    const fx = x + FOOT_X;
    const fy = y + FOOT_Y;
    const rx = 0.24;
    const ry = 0.24;
    for (const [px, py] of [[fx - rx, fy - ry], [fx + rx, fy - ry], [fx - rx, fy + ry], [fx + rx, fy + ry]])
      if (!this.map.isWalkable(Math.floor(px), Math.floor(py))) return false;
    return true;
  }

  private updatePlayer(dt: number) {
    const me = this.workers.get(PLAYER_ID);
    if (!me) return;
    let dx = 0;
    let dy = 0;
    for (const k of this.keys) {
      dx += MOVE_KEYS[k][0];
      dy += MOVE_KEYS[k][1];
    }
    dx = Math.sign(dx);
    dy = Math.sign(dy);
    me.moving = dx !== 0 || dy !== 0;
    if (me.moving) {
      const len = Math.hypot(dx, dy);
      const step = (PLAYER_SPEED * dt) / len;
      // slide along walls: try each axis on its own
      const nx = me.x + dx * step;
      if (this.playerFits(nx, me.y)) me.x = nx;
      const ny = me.y + dy * step;
      if (this.playerFits(me.x, ny)) me.y = ny;
      me.walked += PLAYER_SPEED * dt;
      me.dir = Math.abs(dx) >= Math.abs(dy) && dx !== 0 ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
      me.room = this.map.roomAt(Math.floor(me.x + FOOT_X), Math.floor(me.y + FOOT_Y)) ?? me.room;
      if (this.followId !== PLAYER_ID) this.follow(PLAYER_ID);
      // Walking out through the airlock (pushing against the outer edge) leaves the office.
      const edge = this.map.entrance[0] === 0 ? dx < 0 && me.x <= 0.05 : dx > 0 && me.x >= this.map.w - 1.05;
      if (this.onAirlock(me) && edge) {
        this.workers.delete(PLAYER_ID);
        this.nearbyId = null;
        this.follow(null);
        this.keys.clear();
        this.setAway(true);
        return;
      }
    }
    // who's close enough to talk to?
    let best: string | null = null;
    let bestD = Infinity;
    for (const w of this.workers.values()) {
      if (w.id === PLAYER_ID || w.leaving) continue;
      const d = Math.hypot(w.x - me.x, (w.y - me.y) * 1.2);
      // the Manager sits behind his desk: you can talk to him from the other side of it
      const range = w.id === BOSS_ID ? 3.2 : TALK_RANGE;
      if (d < range && d < bestD) {
        bestD = d;
        best = w.id;
      }
    }
    this.nearbyId = best;
  }

  // ---------- picking ----------

  pick(clientX: number, clientY: number): Pick {
    const [x, y] = this.toCanvas(clientX, clientY);
    const t = performance.now();
    const visible = [...this.workers.values()].filter((w) => !w.leaving);
    const pad = 1.5 * this.scale;
    // sprites (the figure inside the sprite box), front-most first
    for (const w of [...visible].sort((a, b) => depthOf(b.x, b.y) - depthOf(a.x, a.y))) {
      const b = this.spriteBox(w, t);
      const half = 4.5 * CHAR_SCALE * b.u; // about the figure's half width
      const [l, r] = [b.hx - half, b.hx + half];
      const top = b.hy - 5 * CHAR_SCALE * ISO_ZSCALE * b.u - half * 0.3;
      const bot = b.y + (SPRITE_FEET[1] + 1.5) * b.u;
      if (x >= l - pad && x <= r + pad && y >= top - pad && y <= bot + pad)
        return { kind: 'worker', sessionId: w.sessionId, workerId: w.id };
    }
    // name tags / bubbles, top-most first
    for (const c of [...this.lastCallouts].reverse()) {
      const b = c.box;
      if (!c.w.leaving && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)
        return { kind: 'worker', sessionId: c.w.sessionId, workerId: c.w.id };
    }
    // room under the pointer: the floor tile there (furniture inside a room picks that room's floor too)
    const T = this.map.tileSize;
    const [u, v] = unIso((x - this.ox) / this.scale, (y - this.oy) / this.scale);
    const room = this.map.roomAt(Math.floor(u / T), Math.floor(v / T));
    return room ? { kind: 'room', roomId: room } : null;
  }

  setHover(p: Pick) {
    this.hover = p;
  }

  // ---------- server sync ----------

  setSessions(sessions: SessionState[]) {
    this.lastSessions = sessions;
    const live = new Set<string>();
    const now = performance.now();
    for (const s of sessions) {
      const look: Look = {
        archetype: ARCHETYPES[hash(s.id, 'arch') % ARCHETYPES.length],
        color: SESSION_COLORS[s.color % SESSION_COLORS.length],
        skin: SKINS[hash(s.id, 'skin') % SKINS.length],
      };
      live.add(s.id);
      const main = this.upsert(s.id, s.id, false, shorten(displayName(s), 22), look, this.displayRoom(s.room, s.status), s.status, s.action, now);
      main.mail = s.mailbox ?? 0;
      main.waking = !!s.waking;
      for (const a of s.subagents) {
        const id = `${s.id}:${a.id}`;
        live.add(id);
        this.upsert(id, s.id, true, a.agentType, { ...look, archetype: 'astromech' }, this.displayRoom(a.room, a.status), a.status, a.action, now);
      }
    }
    for (const w of this.workers.values()) if (!live.has(w.id) && !w.leaving && !isNpc(w.id)) this.sendOff(w);
    this.synced = true;
  }

  private upsert(
    id: string,
    sessionId: string,
    isSub: boolean,
    name: string,
    look: Look,
    room: RoomId,
    status: WorkerStatus,
    action: string,
    now: number,
  ): Worker {
    let w = this.workers.get(id);
    if (!w || w.leaving) {
      if (w) this.workers.delete(id);
      const spot = this.claimSpot(id, room);
      // On first load put everyone straight at their spot. Afterwards sessions walk in through the
      // airlock and subagents walk out of the meeting room.
      let from: Tile = spot;
      if (this.synced) {
        const meeting = this.map.spots.meeting;
        from = isSub && meeting.length ? meeting[hash(id) % meeting.length] : this.map.entrance;
      }
      w = {
        id, sessionId, isSub, name, look, room, spot,
        x: from[0], y: from[1], path: [], dir: 'down', walked: 0,
        status, action, actionAt: now, leaving: false,
      };
      this.workers.set(id, w);
      this.walkTo(w, spot);
      if (room === BOSS_ROOM && !isSub && this.synced && status === 'working' && action !== REPORT_ACTION) {
        w.errand = {};
        this.bossAssigns(name);
      }
    } else if (w.errand && room !== BOSS_ROOM) {
      // still on the way to (or at) the Manager's desk: go there next, once briefed
      w.errand.pendingRoom = room;
    } else if (w.room !== room || (w.errand && w.errand.pendingRoom)) {
      if (w.errand) w.errand.pendingRoom = undefined;
      if (w.room !== room) {
        this.moveTo(w, room);
        if (room === BOSS_ROOM && !isSub) {
          if (action === REPORT_ACTION) this.bossReceives(name);
          else if (status === 'waiting') this.bossSays(`${name} has a question for you. Come to my desk.`);
          else {
            w.errand = {};
            this.bossAssigns(name);
          }
        }
      }
    }
    if (w.action !== action || w.status !== status) w.actionAt = now;
    Object.assign(w, { look, status, action });
    w.baseName = name;
    this.applyName(w);
    return w;
  }

  /** Walk a worker to a free spot in another room. */
  private moveTo(w: Worker, room: RoomId) {
    this.releaseSpot(w);
    w.room = room;
    w.spot = this.claimSpot(w.id, room);
    this.walkTo(w, w.spot);
  }

  /** Errands: once at the Manager's desk, wait BRIEFING_MS, then head for the session's current room. */
  private tickErrand(w: Worker, now: number) {
    const e = w.errand;
    if (!e || w.leaving) return;
    if (w.path.length) return;
    if (e.briefedAt === undefined) {
      e.briefedAt = now;
      return;
    }
    if (now - e.briefedAt < BRIEFING_MS) return;
    w.errand = undefined;
    if (e.pendingRoom && e.pendingRoom !== w.room) this.moveTo(w, e.pendingRoom);
  }

  /** Worker is gone from the server: walk to the exit (subagents: back to the meeting room) and vanish. */
  private sendOff(w: Worker) {
    w.errand = undefined;
    this.releaseSpot(w);
    w.leaving = true;
    w.status = 'resting';
    w.action = w.isSub ? 'Done!' : 'Heading home';
    w.actionAt = performance.now();
    const target = w.isSub ? (this.map.spots.meeting.at(-1) ?? this.map.entrance) : this.map.entrance;
    if (!this.walkTo(w, target)) this.workers.delete(w.id);
  }

  private tileOf(w: Worker): Tile {
    return w.path.length ? w.path[0] : [Math.round(w.x), Math.round(w.y)];
  }

  /** Plan a path from where the worker is (or the tile it's stepping onto) to `goal`. */
  private walkTo(w: Worker, goal: Tile): boolean {
    const path = findPath(this.map, this.tileOf(w), goal);
    if (path.length === 0) {
      // Unreachable (map edit?) -> teleport rather than get stuck.
      [w.x, w.y] = goal;
      w.path = [];
      return false;
    }
    w.path = path;
    return true;
  }

  private claimSpot(id: string, room: RoomId): Tile {
    const spots = this.map.spots[room];
    if (spots.length === 0) return this.map.spots[ENTRANCE_ROOM][0] ?? this.map.entrance;
    const start = hash(id, room) % spots.length;
    const free = (list: Tile[], from: number) => {
      for (let i = 0; i < list.length; i++) {
        const s = list[(from + i) % list.length];
        if (!this.occupied.has(`${s[0]},${s[1]}`) && this.map.isWalkable(s[0], s[1])) return s;
      }
      return undefined;
    };
    const seats = this.map.seats[room];
    // in the Manager's office you come to stand in front of his desk, nearest him first
    const front = room === BOSS_ROOM ? this.deskFront() : [];
    const spot =
      (front.length ? free(front, 0) : undefined) ??
      (seats.length ? free(seats, hash(id, room, 'seat') % seats.length) : undefined) ??
      free(spots, start) ??
      free(this.map.overflow[room], start) ??
      spots[start]; // full: share
    this.occupied.set(`${spot[0]},${spot[1]}`, id);
    return spot;
  }

  /** Floor tiles right in front of (below) the Manager's desk, nearest his seat first. */
  private deskFront(): Tile[] {
    if (this.deskFrontCache) return this.deskFrontCache;
    const [x0, y0, x1, y1] = this.map.rooms[BOSS_ROOM].rect;
    const bx = this.bossSeat?.[0] ?? (x0 + x1) / 2;
    const out: Tile[] = [];
    for (let y = y0 + 1; y < y1; y++)
      for (let x = x0 + 1; x < x1; x++) if (this.map.at(x, y) === '.' && this.map.at(x, y - 1) === 'R') out.push([x, y]);
    out.sort((a, b) => Math.abs(a[0] - bx) - Math.abs(b[0] - bx) || a[0] - b[0]);
    this.deskFrontCache = out;
    return out;
  }
  private deskFrontCache: Tile[] | null = null;

  private releaseSpot(w: Worker) {
    const k = `${w.spot[0]},${w.spot[1]}`;
    if (this.occupied.get(k) === w.id) this.occupied.delete(k);
  }

  // ---------- simulation ----------

  private update(dt: number) {
    for (const w of [...this.workers.values()]) {
      if (w.id === PLAYER_ID) continue; // moved by the keyboard in updatePlayer
      let budget = WALK_SPEED * dt * (w.id.startsWith('npc:piet') ? PIET_SPEED : 1);
      while (budget > 0 && w.path.length) {
        const [tx, ty] = w.path[0];
        const dx = tx - w.x;
        const dy = ty - w.y;
        const dist = Math.abs(dx) + Math.abs(dy);
        if (dist < 1e-6) {
          w.path.shift();
          continue;
        }
        if (Math.abs(dx) > Math.abs(dy)) w.dir = dx > 0 ? 'right' : 'left';
        else w.dir = dy > 0 ? 'down' : 'up';
        const step = Math.min(budget, dist);
        // Move along one axis at a time (paths are 4-directional).
        if (Math.abs(dx) > 1e-6) w.x += Math.sign(dx) * Math.min(step, Math.abs(dx));
        else w.y += Math.sign(dy) * Math.min(step, Math.abs(dy));
        w.walked += step;
        budget -= step;
      }
      if (!w.path.length) {
        if (w.leaving) {
          this.workers.delete(w.id);
          continue;
        }
        // Turn to face you while being poked, otherwise face your furniture (the manager faces his visitors).
        w.dir = this.pokes.has(w.id) ? 'down' : w.id === BOSS_ID ? this.bossDir : this.restingDir(w);
      }
      this.tickErrand(w, performance.now());
    }
    const now = performance.now();
    for (const [id, t0] of this.pokes) if (now - t0 > POKE_MS * 2) this.pokes.delete(id);
    // When the clock crosses 16:30 or midnight, send people to (or back from) the cantina.
    if (now > this.eveningCheckAt) {
      this.eveningCheckAt = now + 5000;
      const ev = this.isEvening();
      if (ev !== this.evening) {
        this.evening = ev;
        if (this.synced) this.setSessions(this.lastSessions);
      }
      this.applyHoliday();
    }
    this.tickSint(now);
    this.tickBoss(now);
    this.tickGuard(now);
    if (this.synced && !this.playerAway && !this.workers.has(PLAYER_ID)) this.spawnPlayer(now);
    this.updatePlayer(dt);
  }

  /** Behind the manager's desk: the floor tile north of a desk tile, away from doors, rightmost first. */
  private findBossSeat(): Tile | null {
    const [x0, y0, x1, y1] = this.map.rooms[BOSS_ROOM].rect;
    const nearDoor = (x: number, y: number) =>
      [-1, 0, 1].some((dx) => [-1, 0, 1].some((dy) => 'DE'.includes(this.map.at(x + dx, y + dy))));
    for (let x = x1 - 1; x > x0; x--)
      for (let y = y0 + 1; y < y1; y++)
        if (this.map.at(x, y) === '.' && this.map.at(x, y + 1) === 'R' && !nearDoor(x, y)) return [x, y];
    return null;
  }

  /** The guard's post: the Sleeping Quarters floor tile closest to its door (but not in the doorway). */
  private findGuardPost(): Tile | null {
    const room = this.map.rooms[SLEEP_ROOM];
    if (!room) return null;
    const [x0, y0, x1, y1] = room.rect;
    const doors: Tile[] = [];
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if (this.map.at(x, y) === 'D') doors.push([x, y]);
    const near = (x: number, y: number) => doors.some(([dx, dy]) => Math.abs(dx - x) <= 1 && Math.abs(dy - y) <= 1);
    let best: Tile | null = null;
    let bestD = Infinity;
    for (let y = y0 + 1; y < y1; y++)
      for (let x = x0 + 1; x < x1; x++) {
        if (this.map.at(x, y) !== '.' || near(x, y)) continue;
        const d = Math.min(...doors.map(([dx, dy]) => Math.abs(dx - x) + Math.abs(dy - y)), 99);
        if (d < bestD) [best, bestD] = [[x, y], d];
      }
    return best;
  }

  /** The guard stands watch; when someone is being woken he walks over, shakes them awake, and goes back. */
  private tickGuard(now: number) {
    if (!this.guardPost || !this.synced) return;
    const post = this.guardPost;
    let guard = this.workers.get(GUARD_ID);
    if (!guard) {
      const [x, y] = post;
      guard = {
        id: GUARD_ID, sessionId: GUARD_ID, isSub: false, name: 'The Guard',
        look: { archetype: 'pilot', color: '#8a2a2a', skin: '#c68642' },
        room: SLEEP_ROOM, spot: [x, y], x, y, path: [], dir: 'down', walked: 0,
        status: 'resting', action: 'All quiet.', actionAt: now, leaving: false,
      };
      this.occupied.set(`${x},${y}`, GUARD_ID); // nobody sleeps on his post
      this.workers.set(GUARD_ID, guard);
      this.applyName(guard);
    }
    const target = [...this.workers.values()].find((w) => w.waking && !w.leaving);
    if (target && this.guardTarget !== target.id) {
      // Off to fetch them: stand on a free floor tile next to where they sleep.
      this.guardTarget = target.id;
      this.guardArrived = false;
      const [tx, ty] = target.spot;
      const next = ([[0, 1], [-1, 0], [1, 0], [0, -1]] as const)
        .map(([dx, dy]): Tile => [tx + dx, ty + dy])
        .find(([x, y]) => this.map.isWalkable(x, y) && !this.occupied.has(`${x},${y}`));
      this.walkTo(guard, next ?? post);
      guard.action = `On my way, ${target.name}.`;
      guard.actionAt = now;
    } else if (target && !this.guardArrived && !guard.path.length) {
      this.guardArrived = true;
      guard.action = `Up, ${target.name}! The Manager wants you.`;
      guard.actionAt = now;
      guard.dir = target.x < guard.x ? 'left' : target.x > guard.x ? 'right' : target.y < guard.y ? 'up' : 'down';
      this.poke(target.id); // they jolt awake
    } else if (!target && this.guardTarget) {
      this.guardTarget = null;
      this.guardArrived = false;
      this.walkTo(guard, post);
      guard.action = 'Back to my post.';
      guard.actionAt = now;
    } else if (!target && !guard.path.length && now - guard.actionAt > 30000) {
      guard.action = GUARD_IDLE[Math.floor(Math.random() * GUARD_IDLE.length)];
      guard.actionAt = now;
    }
  }

  private bossTiles(): Tile[] {
    return this.bossSeat ? [this.bossSeat] : [];
  }

  /** The manager sits at his desk; he greets anyone who comes in with a new task. */
  private tickBoss(now: number) {
    if (!this.bossSeat || !this.synced) return;
    let boss = this.workers.get(BOSS_ID);
    if (!boss) {
      const [x, y] = this.bossSeat;
      boss = {
        id: BOSS_ID, sessionId: BOSS_ID, isSub: false, name: 'The Manager',
        look: { archetype: 'boss', color: '#16171c', skin: '#f1c27d' },
        room: BOSS_ROOM, spot: [x, y], x, y, path: [], dir: 'down', walked: 0,
        status: 'resting', action: 'Status report.', actionAt: now, leaving: false,
      };
      this.workers.set(BOSS_ID, boss);
      this.applyName(boss);
      this.bossNextLine = now + 15000;
    }
    if (now > this.bossNextLine) {
      boss.action = BOSS_IDLE[Math.floor(Math.random() * BOSS_IDLE.length)];
      boss.actionAt = now;
      this.bossNextLine = now + 20000 + Math.random() * 20000;
    }
    if (now > this.bossTurnAt) {
      const next: Dir = this.bossDir !== 'down' ? 'down' : Math.random() < 0.5 ? 'left' : 'right';
      this.bossDir = next;
      this.bossSwayUntil = now + 700;
      this.bossTurnAt = now + (next === 'down' ? 5000 + Math.random() * 6000 : 1500 + Math.random() * 1500);
    }
  }

  /** How many reports you haven't read yet; shown as 📄 on the Manager's name tag. */
  setUnreadReports(n: number) {
    this.unreadReports = n;
  }

  /** How many of Claude's questions wait at the Manager's desk; shown as ❓ on his name tag. */
  setOpenQuestions(n: number) {
    this.openQuestions = n;
  }

  /** Someone just came to the manager's office for a new task. */
  private bossAssigns(name: string) {
    this.bossSays(BOSS_ASSIGN[Math.floor(Math.random() * BOSS_ASSIGN.length)](name));
  }

  /** Someone walked their finished turn's report over. */
  private bossReceives(name: string) {
    this.bossSays(BOSS_RECEIVE[Math.floor(Math.random() * BOSS_RECEIVE.length)](name));
  }

  private bossSays(line: string) {
    const boss = this.workers.get(BOSS_ID);
    if (!boss) return;
    boss.action = line;
    boss.actionAt = performance.now();
    this.bossNextLine = boss.actionAt + 15000;
    if (this.bossDir !== 'down') this.bossSwayUntil = boss.actionAt + 700;
    this.bossDir = 'down';
    this.bossTurnAt = boss.actionAt + 6000;
  }

  /** Sinterklaas and his pieten stroll around during his season and stop by workers to say hello. */
  private tickSint(now: number) {
    const visitors = [
      { id: SINT_ID, name: 'Sinterklaas', look: { archetype: 'sint', color: '#c8102e', skin: '#f1c27d' } as Look, delay: 0 },
      ...PIETEN.map((p, i) => ({ id: p.id, name: p.name, look: { archetype: 'piet', color: p.color, skin: p.skin } as Look, delay: 2500 + i * 2200 })),
    ];
    if (this.holiday !== 'sinterklaas' || !this.visitorsOn) {
      // season over (or switched off): everyone heads home through the airlock
      for (const v of visitors) {
        const w = this.workers.get(v.id);
        if (w && !w.leaving) {
          w.leaving = true;
          if (!this.walkTo(w, this.map.entrance)) this.workers.delete(v.id);
        }
      }
      this.npcs.clear();
      return;
    }
    if (!this.synced) return;
    if (!this.npcStart) this.npcStart = now;
    for (const v of visitors) {
      let w = this.workers.get(v.id);
      if (!w) {
        if (now - this.npcStart < v.delay) continue; // pieten follow the Sint in one by one
        const [ex, ey] = this.map.entrance;
        const isPiet = v.look.archetype === 'piet';
        w = {
          id: v.id, sessionId: v.id, isSub: false, name: v.name, look: v.look,
          room: 'reception', spot: [ex, ey], x: ex, y: ey, path: [], dir: 'right', walked: 0,
          status: 'resting', action: isPiet ? '' : 'Dag allemaal! 🎁', actionAt: now, leaving: false,
        };
        this.workers.set(v.id, w);
        this.applyName(w);
        this.npcs.set(v.id, { nextAt: now, greeting: null });
      }
      this.tickVisitor(w, now);
    }
    this.throws = this.throws.filter((th) => now - th.t0 < 1400);
  }

  private npcStart = 0;
  /** Last time a visitor said hello to each worker. */
  private greeted = new Map<string, number>();
  /** Holiday visitors on/off (the header toggle); remembered per browser. */
  private visitorsOn = readFlag(VISITORS_KEY, true);
  /** Where the manager sits (behind the desk) and when he next says something. */
  private bossSeat: Tile | null = null;
  /** Where the guard stands in the Sleeping Quarters when nobody needs waking. */
  private guardPost: Tile | null = null;
  /** Worker the guard is fetching. */
  private guardTarget: string | null = null;
  private guardArrived = false;
  private bossNextLine = 0;
  /** He looks around the room now and then; the cape sways while he turns. */
  private bossDir: Dir = 'down';
  private bossTurnAt = 0;
  private bossSwayUntil = 0;

  private tickVisitor(w: Worker, now: number) {
    const st = this.npcs.get(w.id);
    if (!st || w.path.length || w.leaving) return;
    const isPiet = w.look.archetype === 'piet';
    if (st.greeting) {
      // arrived next to someone: a short hello
      w.action = isPiet ? `Hoi ${st.greeting}! 🍪` : `Dag ${st.greeting}! 🎁`;
      w.actionAt = now;
      if (isPiet && Math.random() < 0.3) this.throwPepernoten(w, now);
      st.greeting = null;
      st.nextAt = now + 12_000 + Math.random() * 10_000;
      return;
    }
    if (now < st.nextAt) return;
    // Only visit people who aren't busy (and not twice in a row): never someone working or
    // waiting for your permission.
    const people = [...this.workers.values()].filter(
      (p) =>
        !isNpc(p.id) &&
        !p.leaving &&
        !p.path.length &&
        (p.status === 'resting' || p.status === 'idle') &&
        now - (this.greeted.get(p.id) ?? -Infinity) > GREET_COOLDOWN_MS,
    );
    const target = people.length && Math.random() < 0.35 ? people[Math.floor(Math.random() * people.length)] : null;
    if (target) {
      const [tx, ty] = [Math.round(target.x), Math.round(target.y)];
      const next = ([[0, 1], [-1, 0], [1, 0], [0, -1]] as const)
        .map(([dx, dy]) => [tx + dx, ty + dy] as Tile)
        .find(([x, y]) => this.map.at(x, y) === '.' && this.map.isWalkable(x, y));
      if (next && this.walkTo(w, next)) {
        w.room = target.room;
        st.greeting = target.name;
        this.greeted.set(target.id, now);
        return;
      }
    }
    // wander somewhere, mostly quietly
    const rooms = Object.keys(this.map.spots) as RoomId[];
    const room = rooms[Math.floor(Math.random() * rooms.length)];
    const spots = this.map.spots[room].filter(([x, y]) => this.map.isWalkable(x, y));
    if (spots.length && this.walkTo(w, spots[Math.floor(Math.random() * spots.length)])) {
      w.room = room;
      if (Math.random() < 0.2) {
        const lines = isPiet ? PIET_LINES : SINT_LINES;
        w.action = lines[Math.floor(Math.random() * lines.length)];
        w.actionAt = now;
      }
    }
    st.nextAt = now + (isPiet ? 15_000 : 25_000) + Math.random() * 15_000;
  }

  /** Header toggle: holiday visitors on or off. */
  setVisitors(on: boolean) {
    this.visitorsOn = on;
    writeFlag(VISITORS_KEY, on);
    if (on) this.npcStart = 0; // walk in again, one by one
  }

  get visitorsEnabled() {
    return this.visitorsOn;
  }

  private throwPepernoten(w: Worker, now: number) {
    const T = this.map.tileSize;
    this.throws.push({ x: (w.x + FOOT_X) * T, y: (w.y + FOOT_Y) * T, t0: now, seed: Math.floor(Math.random() * 1e6) });
  }

  /** Pepernoten flying out in little arcs and bouncing on the floor. */
  private drawThrows(now: number) {
    const { ctx, scale: s } = this;
    this.screenMode();
    for (const th of this.throws) {
      // launched from about hand height above the thrower's feet
      const [bx, by] = this.toScreen(th.x * s, th.y * s);
      const p = (now - th.t0) / 1100;
      if (p > 1.25) continue;
      for (let i = 0; i < 9; i++) {
        const k = hash(th.seed, i);
        const angle = Math.PI * (0.1 + 0.8 * ((k % 100) / 100)) + Math.PI; // upward fan
        const speed = 18 + (k >> 7) % 22;
        const q = Math.min(p, 1);
        const dx = Math.cos(angle) * speed * q;
        const arc = Math.sin(Math.min(q, 1) * Math.PI) * (10 + (k % 8)); // up then down to the floor
        const x = bx + dx * s;
        const y = by + (-8 + 6 * q - arc) * s;
        ctx.globalAlpha = p > 1 ? Math.max(0, 1 - (p - 1) * 4) : 1;
        // a little round cookie: body plus a lit top-left facet
        const base = i % 2 ? '#8a5a30' : '#a06a3a';
        ctx.fillStyle = base;
        ctx.beginPath();
        ctx.ellipse(x + 0.8 * s, y + 0.7 * s, 0.8 * s, 0.7 * s, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = shade(base, 0.25);
        ctx.beginPath();
        ctx.ellipse(x + 0.6 * s, y + 0.5 * s, 0.4 * s, 0.32 * s, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Face the furniture next to your spot (desk above you -> face up, etc.). */
  private restingDir(w: Worker): Dir {
    const [x, y] = [Math.round(w.x), Math.round(w.y)];
    const furniture = (c: string) => !'.DE#V'.includes(c);
    if (furniture(this.map.at(x, y - 1))) return 'up';
    if (furniture(this.map.at(x - 1, y))) return 'left';
    if (furniture(this.map.at(x + 1, y))) return 'right';
    return 'down';
  }

  // ---------- drawing ----------

  private draw(t: number) {
    const { ctx, map, scale: s } = this;
    const T = map.tileSize;
    // Baked art is high-res low-poly now: smooth scaling, not the old pixel grid.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    this.screenMode();
    ctx.fillStyle = '#0b1026';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.planMode();
    ctx.drawImage(this.layers.floor, 0, 0, map.w * T * s, map.h * T * s);

    // back to front: by row, then along the row
    const sorted = [...this.workers.values()].sort((a, b) => a.y - b.y || a.x - b.x);
    for (const w of sorted) this.drawContactShadow(w, t);
    this.drawBossAura(t);
    for (const w of sorted) this.drawFloorMarker(w, t);
    const view: DecorView = {
      ctx, s, dpr: this.dpr, width: this.canvas.width, height: this.canvas.height,
      px: (tx) => this.px(tx), py: (ty) => this.py(ty),
    };

    // Depth: draw standing objects row by row, each row's workers right after it. A worker whose feet
    // are in row y is in front of everything based in rows <= y and behind rows > y.
    const byRow = new Map<number, Worker[]>();
    for (const w of sorted) {
      const row = Math.max(0, Math.min(map.h - 1, Math.floor(w.y + FOOT_Y + 1e-6)));
      byRow.set(row, [...(byRow.get(row) ?? []), w]);
    }
    this.updateDoors(t, sorted);
    for (let y = 0; y < map.h; y++) {
      this.planMode();
      ctx.drawImage(this.layers.strips[y], -STRIP_PAD * s, this.py(y) - MAX_RISE * s, (STRIP_PAD + map.w * T) * s, (T + MAX_RISE) * s);
      this.drawDoorsRow(y);
      this.drawAnimatedRow(y, t);
      this.planMode();
      this.decor.drawRow(this.holiday, y, view, t);
      for (const w of byRow.get(y) ?? []) {
        if (w.id === BOSS_ID) this.drawBossChair(w, t);
        const typing = this.isTyping(w);
        if (typing) this.drawCodeScreen(w, t);
        this.drawWorker(w, t, typing);
        if (typing) {
          this.drawChair(w, t);
          this.drawKeystrokes(w, t);
        }
      }
    }

    this.drawLighting(t);
    if (this.evening) this.drawParty(t);
    this.drawBossPresence(t);
    this.drawThrows(performance.now());
    this.screenMode();
    this.decor.drawOverlay(this.holiday, view, t);
    this.drawRoomHighlight(t);
    this.drawRoomLabels();

    this.screenMode();
    const callouts = this.layoutCallouts(sorted, t);
    this.lastCallouts = callouts;
    for (const c of callouts) this.drawCallout(c, t);
  }

  /** Plan x of a tile column, in plan-mode units (plan art units * scale). */
  private px(tx: number) {
    return tx * this.map.tileSize * this.scale;
  }
  /** Plan y of a tile row, in plan-mode units. */
  private py(ty: number) {
    return ty * this.map.tileSize * this.scale;
  }

  /** Draw in plan space: (px, py)-style coordinates map onto the isometric floor. */
  private planMode() {
    // px()/py() already include the zoom scale, so the camera's plan → screen matrix applies as is
    const [a, b, c, d] = ISO_MATRIX;
    this.ctx.setTransform(a, b, c, d, this.ox, this.oy);
  }

  /** Draw in device pixels (billboards, text). */
  private screenMode() {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Device point of a plan-mode point (plan art units * scale). */
  private toScreen(pu: number, pv: number): [number, number] {
    const [sx, sy] = iso(pu, pv);
    return [this.ox + sx, this.oy + sy];
  }

  /** Device point of a world point: tile coordinates on the floor, plus a height z in art units. */
  private worldScreen(tx: number, ty: number, z = 0): [number, number] {
    const zs = z * this.scale;
    return this.toScreen(this.px(tx) + leanU(zs), this.py(ty) + leanV(zs));
  }

  /**
   * Plan-mode path around a plan rectangle (plan-mode units) and everything standing in it up to `rise`
   * art units tall: height leans things by (leanU, leanV) in plan (both ≤ 0), so the hull is the rect
   * swept along that lean, a hexagon.
   */
  private hullPath(x: number, y: number, w: number, h: number, rise: number) {
    const { ctx } = this;
    const dx = leanU(rise * this.scale);
    const dy = leanV(rise * this.scale);
    ctx.moveTo(x + dx, y + dy);
    ctx.lineTo(x + w + dx, y + dy);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x + dx, y + h + dy);
    ctx.closePath();
  }

  /** A room's floor inside its walls, as a plan-mode rect. `pad` (art units) widens it under the walls. */
  private roomPlanRect(id: RoomId, pad = 0): Rect {
    const [x0, y0, x1, y1] = this.map.rooms[id].rect;
    const p = pad * this.scale;
    const x = this.px(x0 + 1) - p;
    const y = this.py(y0 + 1) - p;
    return { x, y, w: this.px(x1) - x, h: this.py(y1) - y };
  }

  private font(px: number, weight = 600) {
    return `${weight} ${px}px ${UI_FONT}`;
  }

  /** Text size in device px: grows with zoom but stays within [min, max] CSS px. */
  private textSize(perScale: number, min: number, max: number) {
    const css = (perScale * this.scale) / this.dpr;
    return Math.round(Math.max(min, Math.min(max, css)) * this.dpr);
  }

  /**
   * Selected room: dim everything else and outline its floor. Hovered room: soft outline.
   * Paths are built in plan mode (so they follow the iso floor) and stroked in screen mode (even lines).
   */
  private drawRoomHighlight(t: number) {
    const { ctx } = this;
    const lw = Math.max(1.5, this.scale * 0.6);
    const sel = this.sel.roomId;
    const outline = (id: RoomId) => {
      const r = this.roomPlanRect(id);
      this.planMode();
      ctx.beginPath();
      ctx.roundRect(r.x, r.y, r.w, r.h, 4 * this.scale);
      this.screenMode();
    };
    if (sel) {
      // the hole keeps the room's floor and its own back walls bright
      const r = this.roomPlanRect(sel, WALL_IN);
      this.screenMode();
      ctx.fillStyle = 'rgba(5,8,20,0.5)';
      ctx.beginPath();
      ctx.rect(0, 0, this.canvas.width, this.canvas.height);
      this.planMode();
      this.hullPath(r.x, r.y, r.w, r.h, WALL_RISE);
      this.screenMode();
      ctx.fill('evenodd');
      ctx.strokeStyle = '#4ff0ff';
      ctx.lineWidth = lw;
      ctx.setLineDash([6 * this.dpr, 4 * this.dpr]);
      ctx.lineDashOffset = -t / 40;
      outline(sel);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (this.hover?.kind === 'room' && this.hover.roomId !== sel) {
      ctx.strokeStyle = 'rgba(79,240,255,0.45)';
      ctx.lineWidth = lw;
      outline(this.hover.roomId);
      ctx.stroke();
    }
  }

  private drawRoomLabels() {
    const { ctx, map } = this;
    this.screenMode();
    const size = this.textSize(4.2, 9, 15);
    ctx.font = this.font(size, 700);
    ctx.textBaseline = 'top';
    for (const [id, room] of Object.entries(map.rooms)) {
      if (map.rooms[id as RoomId] !== room) continue; // alias for a missing room
      const [x0, y0] = room.rect;
      const cantina = this.evening && id === CANTINA;
      const text = cantina ? '🍺 CANTINA' : room.label.toUpperCase();
      const w = ctx.measureText(text).width;
      // A sign hanging just inside the room's back corner (the top of its floor diamond), level with the
      // wall caps there.
      const [ax, ay] = this.worldScreen(x0 + 1, y0 + 1, WALL_RISE);
      const x = ax - w / 2;
      const y = ay + 6 * this.scale;
      const active = this.sel.roomId === id || (this.hover?.kind === 'room' && this.hover.roomId === id);
      const ph = size + 6 * this.dpr;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.3)';
      ctx.shadowBlur = 6 * this.dpr;
      ctx.shadowOffsetY = 1.5 * this.dpr;
      ctx.fillStyle = cantina ? 'rgba(44,10,48,0.86)' : active ? 'rgba(18,58,80,0.88)' : 'rgba(12,16,30,0.62)';
      ctx.beginPath();
      ctx.roundRect(x - ph * 0.45, y - 3 * this.dpr, w + ph * 0.9, ph, ph / 2);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = active ? 'rgba(120,240,255,0.55)' : 'rgba(255,255,255,0.08)';
      ctx.lineWidth = Math.max(1, this.dpr * 0.8);
      ctx.stroke();
      if (cantina) {
        // flickering neon
        const on = Math.floor(performance.now() / 90) % 37 !== 0;
        ctx.shadowColor = '#ff4fd8';
        ctx.shadowBlur = on ? 10 * this.dpr : 0;
        ctx.fillStyle = on ? '#ff8ae6' : '#7a3b6e';
      } else ctx.fillStyle = active ? '#9ff7ff' : 'rgba(220,235,255,0.85)';
      ctx.fillText(text, x, y);
      ctx.shadowBlur = 0;
    }
  }

  /** Device point of a worker's feet on the floor. */
  private feetOf(w: Worker): [number, number] {
    return this.toScreen(this.px(w.x + FOOT_X), this.py(w.y + FOOT_Y));
  }

  /**
   * The sprite box in device px: top-left (x, y), side `size` (= SPRITE_UNITS drawn), `u` = device px per
   * sprite unit; feet (fx, fy) on the floor; head (hx, hy) where tags and bubbles anchor; `foot` = the
   * size of the old 16-unit sprite, for floor rings and shadows.
   */
  private spriteBox(w: Worker, t: number) {
    const s = this.scale;
    const k = w.isSub ? SUB_SCALE : 1;
    const size = SPRITE_UNITS * s * k;
    const u = size / SPRITE_UNITS;
    const moving = w.path.length > 0;
    // a smooth breathing bob while working (same 800 ms rhythm as the old 1-unit hop)
    const bob = !moving && w.status === 'working' ? (1 - Math.cos((t / 400) * Math.PI)) / 2 : 0;
    const p0 = this.pokes.get(w.id);
    const p = p0 === undefined ? 1 : (performance.now() - p0) / POKE_MS;
    let hop = p < 1 ? Math.sin(p * Math.PI) * 6 : 0;
    if (p >= 1 && this.partying(w)) hop = Math.abs(Math.sin(((t + (hash(w.id) % 4) * 120) / BEAT_MS) * Math.PI)) * 1.5;
    const [fx, fy] = this.feetOf(w);
    const x = fx - SPRITE_FEET[0] * u;
    const y = fy - SPRITE_FEET[1] * u - (bob + hop) * s;
    return { x, y, size, u, fx, fy, hx: x + SPRITE_HEAD[0] * u, hy: y + SPRITE_HEAD[1] * u, foot: 16 * s * k, hop, lift: bob + hop };
  }

  /**
   * A frame for 2D overlays drawn in the old 16-unit sprite coordinates (head at (8, 4.4)), scaled like the
   * characters: returns the device position of that box's origin and its unit.
   */
  private legacyBox(b: { hx: number; hy: number; u: number }) {
    // the old box had its feet at (8, 15), so match the head-to-feet span of the current sprites
    const u = (b.u * (SPRITE_FEET[1] - SPRITE_HEAD[1])) / (15 - 4.4);
    return { x: b.hx - 8 * u, y: b.hy - 4.4 * u, u };
  }

  /** Soft contact shadow on the floor under the feet; shrinks and fades as they hop. */
  private drawContactShadow(w: Worker, t: number) {
    const { ctx } = this;
    this.screenMode();
    const { fx: cx, fy: cy, foot: size, lift } = this.spriteBox(w, t);
    const k = 1 - Math.min(0.45, lift / 10);
    // a circle on the floor (see FLOOR_RY)
    const rx = size * 0.36 * k;
    const ry = rx * FLOOR_RY;
    const idle = w.status === 'idle' && !w.path.length && !this.partying(w);
    ctx.globalAlpha = 0.42 * k * (idle ? 0.6 : 1);
    ctx.drawImage(contactShadow(), cx - rx, cy - ry, rx * 2, ry * 2);
    ctx.globalAlpha = 1;
  }

  /** A soft glowing floor ring: wide faint halo plus a crisp core line. */
  private glowRing(cx: number, cy: number, rx: number, ry: number, color: string, alpha: number, lw: number, dash?: number[], dashOffset = 0) {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.globalAlpha = alpha * 0.22;
    ctx.lineWidth = lw * 3.2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = alpha;
    ctx.lineWidth = lw;
    if (dash) {
      ctx.setLineDash(dash);
      ctx.lineDashOffset = dashOffset;
    }
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** Selection/hover ring and pulsing red "waiting" ring under the worker's feet. */
  private drawFloorMarker(w: Worker, t: number) {
    const { ctx, scale: s } = this;
    this.screenMode();
    // floor rings are circles on the floor: ellipses around the feet (see FLOOR_RY)
    const { fx: cx, fy: cy, foot: size } = this.spriteBox(w, t);
    if (w.status === 'waiting') {
      const p = (t % 1200) / 1200;
      const rx = size * (0.35 + p * 0.5);
      const ry = rx * FLOOR_RY;
      // a soft red pool under the feet plus an expanding ripple
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.35 * (1 - p * 0.5);
      ctx.drawImage(glowSprite('232,60,60'), cx - size * 0.5, cy - size * 0.5 * FLOOR_RY, size, size * FLOOR_RY);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      this.glowRing(cx, cy, rx, ry, '#ff4a4a', 0.9 * (1 - p), Math.max(1, s * 0.7));
    }
    if (this.nearbyId === w.id) {
      const p = 0.5 + 0.5 * Math.sin(t / 220);
      const rx = size * (0.55 + 0.05 * p);
      this.glowRing(cx, cy, rx, rx * FLOOR_RY, '#ffd84d', 0.55 + 0.4 * p, Math.max(1.5, s * 0.7));
    }
    const exact = this.sel.workerId === w.id;
    const family = !exact && this.sel.sessionId === w.sessionId;
    const hovered = this.hover?.kind === 'worker' && this.hover.workerId === w.id;
    if (exact || family || hovered) {
      const alpha = exact ? 1 : family ? 0.45 : 0.7;
      const lw = Math.max(1, s * (exact ? 0.7 : 0.45));
      if (exact) {
        // a faint filled disc in the session color under the selected worker
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = w.look.color;
        ctx.beginPath();
        ctx.ellipse(cx, cy, size * 0.5, size * 0.5 * FLOOR_RY, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      this.glowRing(cx, cy, size * 0.5, size * 0.5 * FLOOR_RY, w.look.color, alpha, lw, exact ? [2.2 * s, 1.6 * s] : undefined, -t / 60);
    }
  }

  private drawWorker(w: Worker, t: number, typing = false) {
    const { ctx } = this;
    this.screenMode();
    const { x, y, size } = this.spriteBox(w, t);
    let frame: Frame = w.path.length || w.moving ? STEP_FRAMES[Math.floor(w.walked * 4) % 4] : 0;
    // Typing rhythm: hands alternate at a slightly uneven, per-worker pace.
    if (typing) frame = (Math.floor(t / (95 + (hash(w.id) % 40))) + (hash(w.id) % 2)) % 2 ? 3 : 4;
    let dir = typing ? 'up' : w.dir;
    if (w.id === BOSS_ID && performance.now() < this.bossSwayUntil) frame = Math.floor(t / 110) % 2 ? 1 : 2;
    const party = this.partying(w);
    if (party && !this.pokes.has(w.id)) {
      // dance: step on the beat, turn every two beats
      const beat = Math.floor(t / BEAT_MS) + (hash(w.id) % 4);
      frame = beat % 2 ? 1 : 2;
      dir = (['down', 'left', 'down', 'right'] as const)[Math.floor(beat / 2) % 4];
    }
    ctx.globalAlpha = w.status === 'idle' && !w.path.length && !party ? 0.6 : 1;
    // no pixel snapping: the baked sprite is high-res and smoothly scaled
    ctx.drawImage(getSprite(w.look, dir, frame), x, y, size, size);
    ctx.globalAlpha = 1;
    if (this.holiday === 'christmas' && !isNpc(w.id)) santaHat(ctx, x, y, size, dir === 'left');
    if (party) this.drawBeer(w, t, dir);
  }

  /** A beer mug in hand; every few seconds a sip. */
  private drawBeer(w: Worker, t: number, dir: Dir) {
    const { ctx } = this;
    this.screenMode();
    const { x, y, u } = this.legacyBox(this.spriteBox(w, t));
    const sipping = (t + (hash(w.id) % 4000)) % 4000 < 700;
    const flip = dir === 'left';
    // hand position (sprite pixels): by the side, or up at the mouth while sipping
    let hx = dir === 'right' ? 9 : 12;
    let hy = sipping ? 5 : 9;
    if (dir === 'up') hx = 12;
    if (sipping && dir !== 'up') hx = 10; // mug up at the mouth
    if (flip) hx = 16 - hx - 3;
    const mx = x + hx * u;
    const my = y + hy * u;
    const P = (pts: Array<[number, number]>) => unitPts(mx, my, u, pts);
    // handle: a rounded loop on the outer side
    ctx.strokeStyle = '#d8dde6';
    ctx.lineWidth = 0.55 * u;
    ctx.lineCap = 'round';
    ctx.beginPath();
    const hxc = flip ? mx : mx + 3 * u;
    ctx.ellipse(hxc, my + 2.3 * u, 0.85 * u, 0.9 * u, 0, flip ? Math.PI / 2 : -Math.PI / 2, flip ? (Math.PI * 3) / 2 : Math.PI / 2);
    ctx.stroke();
    // glass body: slightly tapered, lit on the left, shaded on the right
    poly(ctx, P([[0, 0.9], [3, 0.9], [2.85, 4], [0.15, 4]]), '#f2b13d');
    poly(ctx, P([[2.1, 0.9], [3, 0.9], [2.85, 4], [2.05, 4]]), shade('#f2b13d', -0.22));
    poly(ctx, P([[0, 0.9], [0.7, 0.9], [0.75, 4], [0.15, 4]]), shade('#f2b13d', 0.2));
    poly(ctx, P([[0.15, 3.6], [2.85, 3.6], [2.85, 4], [0.15, 4]]), shade('#f2b13d', -0.35)); // thick base
    // foam: a few faceted puffs
    ctx.fillStyle = '#fffbe8';
    ctx.beginPath();
    ctx.ellipse(mx + 1.5 * u, my + 0.75 * u, 1.65 * u, 0.7 * u, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(mx + 0.9 * u, my + 0.35 * u, 0.6 * u, 0, Math.PI * 2);
    ctx.moveTo(mx + 2.55 * u, my + 0.3 * u);
    ctx.arc(mx + 2.0 * u, my + 0.3 * u, 0.55 * u, 0, Math.PI * 2);
    ctx.fill();
    poly(ctx, P([[1.6, 0.8], [3.1, 0.7], [2.7, 1.3], [1.4, 1.35]]), '#e9e0c4'); // foam underside in shade
    poly(ctx, P([[0.45, 1.4], [0.95, 1.4], [0.85, 3.4], [0.45, 3.4]]), 'rgba(255,255,255,0.45)'); // glint
  }

  /** Seated at a desk in the dev room, working, not walking, not being poked. */
  private isTyping(w: Worker): boolean {
    if (w.path.length || w.status !== 'working' || !TYPING_ROOMS.has(w.room) || this.pokes.has(w.id)) return false;
    const [x, y] = [Math.round(w.x), Math.round(w.y)];
    return this.map.at(x, y - 1) === 'd';
  }

  /** The monitor in front of a typing worker shows code scrolling by. */
  private drawCodeScreen(w: Worker, t: number) {
    const { ctx } = this;
    const [dx, dy] = [Math.round(w.x), Math.round(w.y) - 1];
    // The desk monitor's glass (furniture.ts 'd') is the plane y = 11.02 of the desk tile, x 3.8..12.2,
    // z 8.8..14.2. Draw on that plane (x along it, -z down it), then work in an 8 x 6 box over the glass.
    this.planMode();
    ctx.save();
    ctx.translate(this.px(dx), this.py(dy));
    ctx.scale(this.scale, this.scale);
    ctx.transform(1, 0, -SKEW, 1, 0, 11.05); // face plane: x along it, -z down it (like furniture.ts onPlane)
    ctx.translate(3.8, -14.2);
    ctx.scale(8.4 / 8, 5.4 / 6);
    const s = 1;
    const sx = 0;
    const sy = 0;
    ctx.fillStyle = '#0d1626';
    ctx.beginPath();
    ctx.roundRect(sx, sy, 8 * s, 6 * s, 0.6 * s);
    ctx.fill();
    // a faint diagonal sheen across the glass
    poly(ctx, [[sx + 0.6 * s, sy], [sx + 3.2 * s, sy], [sx + 1.2 * s, sy + 6 * s], [sx, sy + 6 * s], [sx, sy + 0.6 * s]], 'rgba(130,170,255,0.06)');
    const palette = ['#c792ea', '#82aaff', '#c3e88d', '#f78c6c', '#89ddff', '#ffcb6b'];
    const line = Math.floor(t / 260); // a new line every ~quarter second
    const lh = 0.8 * s;
    for (let i = 0; i < 3; i++) {
      const n = line + i;
      const indent = hash(w.id, n, 'i') % 3;
      const len = 2 + (hash(w.id, n, 'l') % (6 - indent));
      // the newest (bottom) line grows as it's being typed
      const shown = i === 2 ? Math.min(len, 1 + Math.floor(((t % 260) / 260) * len)) : len;
      ctx.fillStyle = palette[hash(w.id, n, 'c') % palette.length];
      ctx.beginPath();
      ctx.roundRect(sx + (indent + 0.5) * s, sy + (1.1 + i * 2) * s, (shown - 0.2) * s, lh, lh / 2);
      ctx.fill();
    }
    // blinking cursor
    if (Math.floor(t / 300) % 2) {
      ctx.fillStyle = '#e8eefc';
      ctx.beginPath();
      ctx.roundRect(sx + 7 * s, sy + 4.9 * s, s * 0.5, s * 0.9, s * 0.2);
      ctx.fill();
    }
    // soft screen glow spilling onto the desk and the worker
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.16;
    ctx.drawImage(glowSprite('120,200,255'), sx - 4 * s, sy - 3 * s, 16 * s, 13 * s);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }

  /** A low red aura pulsing on the floor around the manager's desk. */
  private drawBossAura(t: number) {
    const boss = this.workers.get(BOSS_ID);
    if (!boss) return;
    const { ctx, scale: s } = this;
    const T = this.map.tileSize;
    // a disc on the floor around him and his desk (plan mode: it lies flat on the iso floor)
    this.planMode();
    const cx = this.px(boss.x + FOOT_X);
    const cy = this.py(boss.y + 1);
    const pulse = 0.75 + 0.25 * Math.sin(t / 900);
    const rad = T * s * 2.4 * (0.92 + 0.08 * pulse);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    g.addColorStop(0, `rgba(200,10,30,${0.32 * pulse})`);
    g.addColorStop(0.6, `rgba(140,0,20,${0.14 * pulse})`);
    g.addColorStop(1, 'rgba(120,0,20,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  /** When he speaks the office lights dim and only his visor glows. */
  private drawBossPresence(t: number) {
    const boss = this.workers.get(BOSS_ID);
    if (!boss) return;
    const { ctx } = this;
    const since = performance.now() - boss.actionAt;
    const k = since < 300 ? since / 300 : since < BOSS_SPEAK_MS ? 1 : Math.max(0, 1 - (since - BOSS_SPEAK_MS) / 800);
    if (k > 0) {
      // his office's floor and everything standing in it
      const r = this.roomPlanRect(BOSS_ROOM, WALL_IN);
      this.planMode();
      ctx.fillStyle = `rgba(4,2,10,${0.42 * k})`;
      ctx.beginPath();
      this.hullPath(r.x, r.y, r.w, r.h, WALL_RISE);
      ctx.fill();
    }
    // visor glow (always a little, brighter while speaking)
    this.screenMode();
    const b = this.spriteBox(boss, t);
    const u = b.u * CHAR_SCALE;
    const vx = b.hx;
    const vy = b.hy;
    const glow = 0.25 + 0.55 * k + 0.1 * Math.sin(t / 500);
    const g = ctx.createRadialGradient(vx, vy, 0, vx, vy, 7 * u);
    g.addColorStop(0, `rgba(255,40,60,${glow})`);
    g.addColorStop(1, 'rgba(255,40,60,0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.fillRect(vx - 7 * u, vy - 7 * u, 14 * u, 14 * u);
    ctx.globalCompositeOperation = 'source-over';
  }

  /** The manager's high-backed leather chair, behind him. */
  private drawBossChair(w: Worker, t: number) {
    this.screenMode();
    const b = this.spriteBox(w, t);
    // on the floor: the chair doesn't bob or hop with him
    this.ctx.drawImage(bossChair(), b.x, b.y + b.lift * this.scale, b.size, b.size);
  }

  /** Office chair back, drawn over the seated worker (we see them from behind). */
  private drawChair(w: Worker, t: number) {
    this.screenMode();
    const b = this.spriteBox(w, t);
    this.ctx.drawImage(officeChair(w.look.color), b.x, b.y + b.lift * this.scale, b.size, b.size);
  }

  /** Little code symbols float up from the keyboard while typing. */
  private drawKeystrokes(w: Worker, t: number) {
    const { ctx, scale: s } = this;
    this.screenMode();
    const period = 900;
    // keyboard on the desk top (furniture.ts 'd': around x 7, y 13, z 5.6 of the desk tile)
    const [baseX, baseY] = this.worldScreen(Math.round(w.x) + 7.2 / 16, Math.round(w.y) - 1 + 13 / 16, 5.6);
    const fs = Math.max(6, Math.round(3.6 * s));
    ctx.font = this.font(fs, 700);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < 3; i++) {
      const phase = (t / period + i / 3 + (hash(w.id) % 100) / 100) % 1;
      const n = Math.floor(t / period + i / 3 + (hash(w.id) % 100) / 100);
      const ch = CODE_CHARS[hash(w.id, n, i) % CODE_CHARS.length];
      const drift = ((hash(w.id, n, i, 'x') % 9) - 4) * s;
      ctx.globalAlpha = Math.max(0, 1 - phase) * 0.9;
      ctx.fillStyle = w.look.color;
      ctx.fillText(ch, baseX + drift + phase * drift, baseY - phase * 14 * s);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'start';
  }

  // ----- callouts (name tag + speech bubble) with overlap avoidance -----

  private layoutCallouts(sorted: Worker[], t: number): Callout[] {
    const { ctx, scale: s } = this;
    const now = performance.now();
    const out: Callout[] = [];
    const roomSel = this.sel.roomId;
    for (const w of sorted) {
      const b = this.spriteBox(w, t);
      // just above the top of the head (head centre is SPRITE_HEAD; the head is ~5 units tall above it)
      // (a Santa hat adds a good bit on top)
      const hat = this.holiday === 'christmas' && !isNpc(w.id) ? 5 * CHAR_SCALE : 0;
      const head = { x: b.hx, y: b.hy - (5 * CHAR_SCALE * ISO_ZSCALE + hat) * b.u };
      const isSel = this.sel.workerId === w.id || this.sel.sessionId === w.sessionId;
      const inSelRoom = roomSel !== null && w.room === roomSel;

      const tfs = this.textSize(w.isSub ? 3.4 : 4.2, w.isSub ? 9 : 10, w.isSub ? 12 : 14);
      ctx.font = this.font(tfs);
      const party = this.partying(w);
      const mail =
        (w.mail ? ` 📨${w.mail}` : '') +
        (w.id === BOSS_ID && this.openQuestions ? ` ❓${this.openQuestions}` : '') +
        (w.id === BOSS_ID && this.unreadReports ? ` 📄${this.unreadReports}` : '');
      const tagText = (w.status === 'idle' && !party ? `${w.name} · zZ` : w.name) + mail;
      // pill: color dot + text, with room for the rounded ends
      const tag = { text: tagText, fs: tfs, w: ctx.measureText(tagText).width + tfs * 1.85, h: tfs * 1.6 };

      let bubble: Callout['bubble'];
      const waiting = w.status === 'waiting';
      const npcVisitor = w.id === SINT_ID || w.id.startsWith('npc:piet');
      const fresh = now - w.actionAt < (npcVisitor ? NPC_BUBBLE_MS : FRESH_BUBBLE_MS);
      const cheers = party && (t + (hash(w.id) % 9000)) % 9000 < 1800;
      const atDoor = w.id === PLAYER_ID && this.nearbyId === null && this.onAirlock(w);
      const hint = w.id === PLAYER_ID && (this.nearbyId !== null || atDoor);
      const show = hint
        ? true
        : party
        ? cheers || isSel || inSelRoom
        : w.action && w.status !== 'idle' && (w.status !== 'resting' || fresh || w.leaving || isSel || inSelRoom);
      if (show) {
        const bfs = this.textSize(w.isSub ? 3.6 : 4.4, w.isSub ? 10 : 11, w.isSub ? 13 : 15);
        ctx.font = this.font(bfs, 500);
        // More room for text when zoomed in or selected.
        const maxChars = isSel || this.zoom > 2.5 ? 40 : 22;
        const lines = this.holiday ? HOLIDAY_INFO[this.holiday].cheers : ['Cheers! 🍺'];
        const toast = lines[Math.floor((t + (hash(w.id) % 9000)) / 9000) % lines.length];
        let label = party ? (cheers ? toast : 'Having a beer') : waiting ? `! ${w.action}` : w.action;
        if (w.id === PLAYER_ID && this.nearbyId && !fresh) {
          const who = this.workers.get(this.nearbyId);
          if (who) label = `[E] Talk to ${who.name}`;
        }
        if (atDoor && !fresh) label = '← Keep walking to leave the office';
        const text = truncate(ctx, label, bfs * maxChars * 0.62);
        bubble = {
          text,
          fs: bfs,
          w: Math.max(ctx.measureText(text).width + bfs * 1.5, bfs * 3),
          h: bfs * 1.8,
          waiting,
          alpha: waiting || fresh || isSel || inSelRoom ? 1 : 0.65,
        };
      }
      const gap = 2 * s;
      const tail = bubble ? bubble.fs * 0.45 : 0;
      const bw = Math.max(tag.w, bubble?.w ?? 0);
      const bh = tag.h + (bubble ? gap + tail + bubble.h : 0);
      out.push({ w, head, tag, bubble, box: { x: head.x - bw / 2, y: head.y - bh, w: bw, h: bh } });
    }

    // Priority: waiting > selected > in selected room > front-most. Higher keep their spot; others move up.
    const prio = (c: Callout) =>
      (c.w.id === SINT_ID || c.w.id.startsWith('npc:piet') ? -1e7 : 0) +
      (c.w.status === 'waiting' ? 4e6 : 0) +
      (this.sel.workerId === c.w.id ? 2e6 : this.sel.sessionId === c.w.sessionId ? 1e6 : 0) +
      (roomSel && c.w.room === roomSel ? 5e5 : 0) +
      depthOf(c.w.x, c.w.y) * 100 + // front-most (screen depth)
      (c.w.isSub ? 0 : 1);
    const order = [...out].sort((a, b) => prio(b) - prio(a));
    const placed: Rect[] = [];
    const margin = 2 * this.dpr;
    for (const c of order) {
      c.box.x = Math.max(4, Math.min(this.canvas.width - c.box.w - 4, c.box.x));
      for (let i = 0; i < 12; i++) {
        const hit = placed.find((p) => overlaps(p, c.box, margin));
        if (!hit) break;
        c.box.y = hit.y - c.box.h - margin;
      }
      placed.push(c.box);
    }
    return order.reverse(); // low priority first so important ones draw on top
  }

  private drawCallout(c: Callout, t: number) {
    const { ctx, scale: s } = this;
    const { w, box, tag, bubble, head } = c;
    const cx = box.x + box.w / 2;
    const tagTop = box.y + box.h - tag.h;
    const visitor = w.id === SINT_ID || w.id.startsWith('npc:piet');
    const dimmed =
      (visitor && this.nearbyId !== w.id) ||
      (this.sel.roomId !== null && w.room !== this.sel.roomId && this.sel.workerId !== w.id);
    ctx.globalAlpha = dimmed ? 0.35 : 1;

    // Leader line when the callout had to move away from the head.
    const baseAlpha = dimmed ? 0.35 : 1;
    if (tagTop + tag.h < head.y - 1) {
      ctx.strokeStyle = w.look.color;
      ctx.lineWidth = Math.max(1, this.dpr);
      ctx.lineCap = 'round';
      ctx.globalAlpha = baseAlpha * 0.7;
      ctx.beginPath();
      ctx.moveTo(cx, tagTop + tag.h);
      ctx.lineTo(head.x, head.y);
      ctx.stroke();
      ctx.fillStyle = w.look.color;
      ctx.beginPath();
      ctx.arc(head.x, head.y, Math.max(1.5, this.dpr * 1.6), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = baseAlpha;
    }

    // name tag: a translucent dark pill with a soft drop shadow and a session-color dot
    const selected = this.sel.workerId === w.id;
    const tl = cx - tag.w / 2;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 6 * this.dpr;
    ctx.shadowOffsetY = 1.5 * this.dpr;
    ctx.fillStyle = selected ? 'rgba(30,42,74,0.92)' : 'rgba(14,18,32,0.76)';
    ctx.beginPath();
    ctx.roundRect(tl, tagTop, tag.w, tag.h, tag.h / 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = selected ? w.look.color : 'rgba(255,255,255,0.12)';
    ctx.lineWidth = Math.max(1, this.dpr * (selected ? 1.2 : 0.8));
    ctx.stroke();
    ctx.fillStyle = w.look.color;
    ctx.beginPath();
    ctx.arc(tl + tag.fs * 0.78, tagTop + tag.h / 2, tag.fs * 0.26, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = this.font(tag.fs);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#eef2fb';
    ctx.fillText(tag.text, tl + tag.fs * 1.25, tagTop + tag.h / 2 + 0.5);
    ctx.textAlign = 'start';

    if (!bubble) {
      ctx.globalAlpha = 1;
      return;
    }
    const tail = bubble.fs * 0.45;
    const top = box.y;
    const left = cx - bubble.w / 2;
    const bottom = top + bubble.h;
    const pulse = bubble.waiting ? 0.5 + 0.5 * Math.sin(t / 160) : 0;
    ctx.globalAlpha = baseAlpha * bubble.alpha;
    // one outline: rounded bubble with the tail pointing down at the name tag (no seams)
    const bw = bubble.w;
    const r = Math.max(0, Math.min(bubble.h * 0.42, bw / 2 - tail));
    const right = left + bw;
    ctx.beginPath();
    ctx.moveTo(left + r, top);
    ctx.arcTo(right, top, right, bottom, r);
    ctx.arcTo(right, bottom, left, bottom, r);
    ctx.lineTo(cx + tail, bottom);
    ctx.lineTo(cx, bottom + tail);
    ctx.lineTo(cx - tail, bottom);
    ctx.arcTo(left, bottom, left, top, r);
    ctx.arcTo(left, top, right, top, r);
    ctx.closePath();
    ctx.save();
    ctx.shadowColor = bubble.waiting ? 'rgba(120,0,10,0.45)' : 'rgba(0,0,0,0.38)';
    ctx.shadowBlur = (bubble.waiting ? 10 + 6 * pulse : 8) * this.dpr;
    ctx.shadowOffsetY = 2 * this.dpr;
    ctx.fillStyle = bubble.waiting ? `rgba(${200 + 40 * pulse},${40 + 20 * pulse},52,0.95)` : 'rgba(20,25,42,0.84)';
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = bubble.waiting ? 'rgba(255,190,190,0.45)' : 'rgba(255,255,255,0.14)';
    ctx.lineWidth = Math.max(1, this.dpr * 0.8);
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.fillStyle = bubble.waiting ? '#ffffff' : '#f2f5fc';
    ctx.font = this.font(bubble.fs, 500);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(bubble.text, cx, top + bubble.h / 2 + 0.5);
    ctx.textAlign = 'start';

    // Big pulsing "!" above waiting workers.
    if (bubble.waiting) {
      const fs = bubble.fs * (1.5 + 0.25 * pulse);
      ctx.globalAlpha = 1;
      ctx.font = this.font(fs, 800);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = Math.max(2, this.dpr * 2.4);
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#3a0508';
      ctx.save();
      ctx.shadowColor = `rgba(255,60,60,${0.5 + 0.4 * pulse})`;
      ctx.shadowBlur = (6 + 6 * pulse) * this.dpr;
      ctx.strokeText('!', cx, top - 1 * s);
      ctx.restore();
      ctx.fillStyle = '#ff4d4d';
      ctx.fillText('!', cx, top - 1 * s);
      ctx.textAlign = 'start';
    }
    ctx.globalAlpha = 1;
  }

  // ----- ambience -----

  private findAnimatedTiles() {
    const racks = new Map<number, Tile[]>();
    const holos = new Map<number, Tile[]>();
    const jukes: Tile[] = [];
    /** viewport glass rects per row (map px, relative to the tile), for the star-streak jump */
    const windows = new Map<number, Array<{ x: number; gx: number; gy: number; gw: number; gh: number }>>();
    const add = (m: Map<number, Tile[]>, x: number, y: number) => m.set(y, [...(m.get(y) ?? []), [x, y]]);
    const lights: Array<{ t: Tile; color: string; r: number }> = [];
    for (let y = 0; y < this.map.h; y++)
      for (let x = 0; x < this.map.w; x++) {
        const c = this.map.at(x, y);
        if (c === 'S') add(racks, x, y);
        if (c === 'H') add(holos, x, y);
        if (c === 'V') {
          windows.set(y, [...(windows.get(y) ?? []), { x, ...windowGlass(this.map, x, y) }]);
        }
        // Light sources sit where the glowing part is: a world point in the tile (art units, z up), stored
        // as its plan position in tiles.
        const at = (lx: number, ly: number, z: number): Tile => [x + (lx + leanU(z)) / 16, y + (ly + leanV(z)) / 16];
        if (c === 'J') {
          jukes.push([x, y]);
          lights.push({ t: at(8, 15, 12), color: '255,80,200', r: 1.8 });
        }
        if (c === 'd') lights.push({ t: at(8, 11, 11.5), color: '120,200,255', r: 1.3 });
        if (c === 'H') lights.push({ t: at(8, 11.4, 8), color: '79,240,255', r: 2 });
        if (c === 'S') lights.push({ t: at(8, 12, 10), color: '90,230,140', r: 0.9 });
        if (c === 'K') lights.push({ t: at(8, 11, 7), color: '255,170,90', r: 1.6 });
        if (c === 'R') lights.push({ t: at(8, 10, 5), color: '120,190,255', r: 1.2 });
      }
    return { racks, holos, jukes, windows, lights };
  }

  /**
   * Draw `draw` on a vertical face that looks toward +y (the lower left on screen), with the origin at
   * plan-mode point (x, y): local x runs along the face, local y down it (like furniture.ts onPlane).
   */
  private onFrontFace(x: number, y: number, draw: () => void) {
    const { ctx } = this;
    ctx.save();
    ctx.translate(x, y);
    ctx.transform(1, 0, -SKEW, 1, 0, 0); // going down the face (−z) moves by (−SKEW, 1) in plan
    draw();
    ctx.restore();
  }

  /** Blinking rack LEDs and hologram shimmer for objects based in row `row` (plan mode). */
  /** Doors slide open when someone comes close (within DOOR_REACH tiles) and close again behind them. */
  private updateDoors(t: number, workers: Worker[]) {
    const dt = this.doorClock ? Math.min(0.1, Math.max(0, (t - this.doorClock) / 1000)) : 0;
    this.doorClock = t;
    const DOOR_REACH = 1.6;
    for (const row of this.doors.values())
      for (const d of row) {
        const near = workers.some((w) => Math.hypot(w.x - d.x, w.y - d.y) < DOOR_REACH);
        // opens quickly (0.25 s), closes a little slower (0.45 s)
        d.open = near ? Math.min(1, d.open + dt * 4) : Math.max(0, d.open - dt * 2.2);
      }
    // the two tiles of a wide doorway are one door: they open and close together
    const at = (x: number, y: number) => this.doors.get(y)?.find((d) => d.x === x);
    for (const row of this.doors.values())
      for (const d of row)
        for (const n of [at(d.x + 1, d.y), at(d.x, d.y + 1)]) {
          if (!n) continue;
          const o = Math.max(d.open, n.open);
          d.open = o;
          n.open = o;
        }
  }

  private drawDoorsRow(row: number) {
    const doors = this.doors.get(row);
    if (!doors) return;
    const { ctx, scale: s } = this;
    this.planMode();
    for (const d of doors) {
      const img = doorImage(this.map, d.x, d.y, Math.round(d.open * DOOR_STEPS));
      ctx.drawImage(img, this.px(d.x) + DOOR_BOX.x * s, this.py(d.y) + DOOR_BOX.y * s, DOOR_BOX.w * s, DOOR_BOX.h * s);
    }
  }

  private drawAnimatedRow(row: number, t: number) {
    const { ctx, scale: s } = this;
    this.planMode();
    const colors = ['88,224,122', '242,209,61', '58,167,224', '232,83,74'];
    for (const [x, y] of this.animated.racks.get(row) ?? []) {
      RACK_LEDS.forEach(([lx, ly], i) => {
        const h = hash(x, y, i);
        const on = Math.floor(t / (180 + (h % 500)) + (h % 7)) % 3 !== 0;
        // LED centred in its 1x1 anchor cell, on the rack's front face
        this.onFrontFace(this.px(x) + (lx + 0.5) * s, this.py(y) + (ly + 0.5) * s, () => {
        const cx = 0;
        const cy = 0;
        if (on) {
          const c = colors[h % 4];
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.5;
          ctx.drawImage(glowSprite(c, 'hot'), cx - 2.2 * s, cy - 2.2 * s, 4.4 * s, 4.4 * s);
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = 'source-over';
          ctx.fillStyle = `rgb(${c})`;
          ctx.beginPath();
          ctx.arc(cx, cy, 0.42 * s, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.75)';
          ctx.beginPath();
          ctx.arc(cx - 0.1 * s, cy - 0.1 * s, 0.17 * s, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = 'rgba(16,20,28,0.85)';
          ctx.beginPath();
          ctx.arc(cx, cy, 0.4 * s, 0, Math.PI * 2);
          ctx.fill();
        }
        });
      });
    }
    if (this.evening)
      for (const [x, y] of this.animated.jukes.filter(([, jy]) => jy === row)) {
        const beat = Math.floor(t / BEAT_MS);
        const pulse = 1 - (t % BEAT_MS) / BEAT_MS;
        // bands and record are on the jukebox's front face
        JUKE_BANDS.forEach(([jx, jy, jw, jh], i) => {
          const c = DISCO[(beat + i) % DISCO.length];
          this.onFrontFace(this.px(x) + jx * s, this.py(y) + jy * s, () => {
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = 0.35 + 0.25 * pulse;
            ctx.drawImage(glowSprite(c), -1.5 * s, -1.2 * s, (jw + 3) * s, (jh + 2.4) * s);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = `rgb(${c})`;
            ctx.beginPath();
            ctx.roundRect(0, 0, jw * s, jh * s, (jh / 2) * s);
            ctx.fill();
          });
        });
        // spinning record label: a disc with a sweeping highlight wedge
        ctx.save();
        ctx.translate(this.px(x) + JUKE_RECORD[0] * s, this.py(y) + JUKE_RECORD[1] * s);
        ctx.transform(1, 0, -SKEW, 1, 0, 0); // front face
        const rcx = 0;
        const rcy = 0;
        const rr = JUKE_RECORD[2] * s;
        ctx.fillStyle = beat % 2 ? '#e8534a' : '#f2d13d';
        ctx.beginPath();
        ctx.arc(rcx, rcy, rr, 0, Math.PI * 2);
        ctx.fill();
        const spin = t / 180;
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.beginPath();
        ctx.moveTo(rcx, rcy);
        ctx.arc(rcx, rcy, rr, spin, spin + 0.9);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#1a1420';
        ctx.beginPath();
        ctx.arc(rcx, rcy, rr * 0.28, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    // Every couple of minutes the station makes a jump: stars stretch into streaks in every viewport.
    const JUMP_EVERY = 150_000;
    const JUMP_MS = 2600;
    const since = t % JUMP_EVERY;
    if (since < JUMP_MS) {
      const p = since / JUMP_MS;
      const intensity = Math.sin(p * Math.PI); // build up, then settle
      for (const wdw of this.animated.windows.get(row) ?? []) {
        // windowGlass() gives the glass's plan bounding box, and the glass is a parallelogram in it. Height
        // h leans by (|SKEW|·h, h) in plan, so on a front wall (facing +y) the box is (x extent + |SKEW|·h)
        // by h, and on a side wall (facing +x) it is |SKEW|·h by (y extent + h): the wider box is a front
        // window. Work in the glass's own plane from here: local x along the window, local y down it, the
        // glass is (0, 0) .. (lw, lh), and going down the glass moves by (−SKEW, 1) in plan.
        const k = -SKEW;
        const front = wdw.gw >= wdw.gh;
        const lh = front ? wdw.gh : wdw.gw / k; // glass height
        const lw = front ? wdw.gw - k * lh : wdw.gh - lh; // along the window
        ctx.save();
        ctx.translate(this.px(wdw.x) + wdw.gx * s, this.py(row) + wdw.gy * s);
        if (front) ctx.transform(1, 0, k, 1, 0, 0);
        else ctx.transform(0, 1, k, 1, 0, 0);
        const gw = lw;
        const gh = lh;
        const ox = 0;
        const oy = 0;
        ctx.beginPath();
        ctx.rect(ox, oy, gw * s, gh * s);
        ctx.clip();
        ctx.fillStyle = `rgba(40,60,120,${0.35 * intensity})`;
        ctx.fillRect(ox, oy, gw * s, gh * s);
        ctx.globalCompositeOperation = 'lighter';
        // a soft blue-white flash in the glass at the peak of the jump
        ctx.globalAlpha = 0.35 * intensity;
        ctx.drawImage(glowSprite('150,190,255'), ox - gw * 0.25 * s, oy - gh * 0.25 * s, gw * 1.5 * s, gh * 1.5 * s);
        ctx.globalAlpha = 1;
        for (let i = 0; i < 6; i++) {
          const k = hash(wdw.x, row, i);
          const ly = oy + ((k % 100) / 100) * gh * s;
          const len = (4 + (k % 10)) * s * (0.4 + 2.6 * intensity);
          const lx = ox + (((k >> 7) % 100) / 100) * gw * s - len / 2 + p * 6 * s;
          const th = Math.max(0.5, s * 0.32);
          // tapered streak: thin tail on the left, bright rounded head on the right
          ctx.fillStyle = i % 3 === 0 ? `rgba(190,220,255,${0.9 * intensity})` : `rgba(255,255,255,${0.75 * intensity})`;
          ctx.beginPath();
          ctx.moveTo(lx, ly);
          ctx.lineTo(lx + len - th, ly - th);
          ctx.arc(lx + len - th, ly, th, -Math.PI / 2, Math.PI / 2);
          ctx.closePath();
          ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
        ctx.restore();
      }
    }
    for (const [x, y] of this.animated.holos.get(row) ?? []) {
      const a = 0.25 + 0.2 * Math.sin(t / 300 + x);
      // A scan ring gliding down the light cone (same speed as before). The cone (furniture.ts 'H') stands
      // on (8, 11.4) from z 2.6 to 16.6, widening from r 2.6 to 4.6; a level ring at height z is a circle
      // in plan, shifted by the height lean.
      const scan = ((t / 120 + x) % 7) / 7;
      const z = 16.6 - scan * 14;
      const r = (2.6 + (2 * (z - 2.6)) / 14) * s;
      const cx = this.px(x) + (8 + leanU(z)) * s;
      const cy = this.py(y) + (11.4 + leanV(z)) * s;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = a;
      ctx.drawImage(glowSprite('160,255,255'), cx - r * 1.5, cy - r * 1.5, r * 3, r * 3);
      ctx.globalAlpha = Math.min(1, a * 1.6);
      ctx.strokeStyle = 'rgba(200,255,255,0.8)';
      ctx.lineWidth = 0.4 * s;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  /** Cantina after hours: disco lights on the floor and music notes from the jukebox. */
  private drawParty(t: number) {
    const { ctx, map, scale: s } = this;
    const T = map.tileSize;
    const { x: rx, y: ry, w: rw, h: rh } = this.roomPlanRect(CANTINA, WALL_IN);
    this.planMode();
    ctx.save();
    ctx.beginPath();
    this.hullPath(rx, ry, rw, rh, WALL_RISE);
    ctx.clip();
    // dim the room a little so the lights pop
    ctx.fillStyle = 'rgba(20,0,40,0.18)';
    ctx.fillRect(rx, ry, rw, rh);
    // sweeping disco spots
    ctx.globalCompositeOperation = 'lighter';
    const beat = (t % BEAT_MS) / BEAT_MS;
    DISCO.forEach((color, i) => {
      const a = t / (1400 + i * 300) + i * 1.7;
      const cx = rx + rw * (0.5 + 0.38 * Math.cos(a));
      const cy = ry + rh * (0.5 + 0.35 * Math.sin(a * 1.3));
      const rad = T * s * (1.6 + 0.25 * (1 - beat));
      ctx.globalAlpha = 0.32;
      // round spots on the floor (plan mode lays them flat)
      ctx.drawImage(glowSprite(color), cx - rad, cy - rad, rad * 2, rad * 2);
    });
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();

    // music notes rising from each jukebox
    this.screenMode();
    const fs = this.textSize(5, 10, 22);
    ctx.font = this.font(fs, 700);
    ctx.shadowColor = 'rgba(255,120,220,0.6)';
    ctx.shadowBlur = 6 * this.dpr;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [jx, jy] of this.animated.jukes) {
      const [bx, by] = this.worldScreen(jx + 0.5, jy + 0.6, 17); // just above the jukebox's top
      for (let i = 0; i < 5; i++) {
        const period = 2600;
        const phase = (t / period + i / 5) % 1;
        const n = Math.floor(t / period + i / 5);
        const wobble = Math.sin(phase * Math.PI * 3 + i) * 6 * s;
        const drift = phase * (16 + (hash(n, i) % 24)) * s;
        ctx.globalAlpha = Math.min(1, (1 - phase) * 1.4) * Math.min(1, phase * 6);
        ctx.fillStyle = `rgb(${DISCO[(n + i) % DISCO.length]})`;
        ctx.fillText(NOTE_CHARS[hash(n, i, 'n') % NOTE_CHARS.length], bx + wobble + drift, by - phase * 34 * s);
      }
    }
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.globalAlpha = 1;
    ctx.textAlign = 'start';
  }

  /** 0 = full day, 1 = deep night, from local time (or ?hour= override). */
  darkness(): number {
    const d = new Date();
    const h = this.hourOverride ?? d.getHours() + d.getMinutes() / 60;
    if (h >= 8 && h < 18) return 0;
    if (h >= 21 || h < 5) return 1;
    if (h >= 18) return (h - 18) / 3; // dusk
    return 1 - (h - 5) / 3; // dawn
  }

  private drawLighting(t: number) {
    const dark = this.darkness();
    if (dark <= 0) return;
    const { ctx, map, scale: s } = this;
    const T = map.tileSize;
    // the whole map and everything standing on it
    this.planMode();
    ctx.fillStyle = `rgba(8,12,40,${0.5 * dark})`;
    ctx.beginPath();
    this.hullPath(0, 0, this.px(map.w), this.py(map.h), MAX_RISE);
    ctx.fill();
    // Screens, holograms and the coffee machine glow at night (round pools in plan, around the source).
    ctx.globalCompositeOperation = 'lighter';
    for (const { t: [x, y], color, r } of this.animated.lights) {
      const cx = this.px(x);
      const cy = this.py(y);
      const rad = r * T * s * (0.95 + 0.05 * Math.sin(t / 500 + x * 3));
      // cached sprite instead of a gradient per light per frame (same linear falloff)
      ctx.globalAlpha = 0.22 * dark;
      ctx.drawImage(glowSprite(color), cx - rad, cy - rad, rad * 2, rad * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

function overlaps(a: Rect, b: Rect, m: number) {
  return a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}

const AWAY_KEY = 'claude-office.playerAway';

function readAway(): boolean {
  try {
    return localStorage.getItem(AWAY_KEY) === '1';
  } catch {
    return false;
  }
}

function writeAway(away: boolean) {
  try {
    if (away) localStorage.setItem(AWAY_KEY, '1');
    else localStorage.removeItem(AWAY_KEY);
  } catch {
    /* storage unavailable: just don't remember */
  }
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}
