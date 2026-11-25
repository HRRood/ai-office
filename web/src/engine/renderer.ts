// Canvas renderer: owns worker entities, moves them along A* paths, runs the camera,
// and draws the office in 3/4 perspective.
import { ENTRANCE_ROOM, type RoomId } from '../../../shared/rooms.config';
import type { SessionState, WorkerStatus } from '../../../shared/types';
import { displayName, shorten } from '../../../shared/names';
import { hash, loadMap, type OfficeMap, type Tile } from './map';
import { HOLIDAY_INFO, HolidayDecor, currentDate, currentHoliday, giftsUnderTree, santaHat, type DecorView, type Holiday } from './holidays';
import { findPath } from './pathfinding';
import { ARCHETYPES, SESSION_COLORS, SKINS, getSprite, type Dir, type Frame, type Look } from './sprites';
import { MAX_RISE, RACK_LEDS, WALL_RISE, renderLayers, type MapLayers } from './tiles';

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
const BOSS_SPEAK_MS = 3000; // lights stay dimmed this long after he speaks
/** You: walk around with the arrow keys / WASD and press E to talk to someone. */
export const PLAYER_ID = 'npc:you';
/** Default names of the non-session characters (for the rename card). */
export const NPC_INFO: Record<string, { name: string; role: string }> = {
  'npc:you': { name: 'You', role: 'That\'s you. Walk with the arrow keys / WASD, press E to talk.' },
  'npc:boss': { name: 'The Manager', role: 'Runs the Manager\'s Office and hands out new tasks.' },
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
  /** The name before any nickname you gave them. */
  baseName?: string;
}

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

  // ----- camera (center in map pixels, zoom relative to "whole office fits") -----
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
  /** Called when you press E next to the Manager: open the "start a new session" dialog. */
  onManager?: () => void;
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
    const h = new URLSearchParams(location.search).get('hour');
    this.hourOverride = h !== null && !Number.isNaN(Number(h)) ? Number(h) : null;
    [this.cx, this.cy] = this.homeCenter();
    [this.tcx, this.tcy] = [this.cx, this.cy];
    this.evening = this.isEvening();
    this.bossSeat = this.findBossSeat();
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
    const T = this.map.tileSize;
    this.baseScale = Math.min(this.canvas.width / (this.map.w * T), this.canvas.height / (this.map.h * T + WALL_RISE));
    this.applyCamera();
  }

  setSelection(sel: Selection) {
    this.sel = sel;
  }

  // ---------- camera ----------

  private homeCenter(): [number, number] {
    const T = this.map.tileSize;
    return [(this.map.w * T) / 2, (this.map.h * T - WALL_RISE) / 2];
  }

  private emitCamera() {
    this.onCameraChange?.({ zoom: this.targetZoom, following: this.followId });
  }

  private clampCenter(x: number, y: number, zoom: number): [number, number] {
    const T = this.map.tileSize;
    const s = this.baseScale * zoom;
    const halfW = this.canvas.width / 2 / s;
    const halfH = this.canvas.height / 2 / s;
    const minX = halfW;
    const maxX = this.map.w * T - halfW;
    const minY = -WALL_RISE + halfH;
    const maxY = this.map.h * T - halfH;
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
        const T = this.map.tileSize;
        [this.tcx, this.tcy] = this.clampCenter((w.x + 0.5) * T, (w.y + 0.2) * T, this.targetZoom);
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
    const wpx = (x1 - x0 + 1) * T;
    const hpx = (y1 - y0 + 1) * T + WALL_RISE;
    const z = Math.min(this.canvas.width / (wpx * this.baseScale), this.canvas.height / (hpx * this.baseScale)) * 0.9;
    this.targetZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    [this.tcx, this.tcy] = this.clampCenter(((x0 + x1 + 1) / 2) * T, ((y0 + y1 + 1) / 2) * T - WALL_RISE / 2, this.targetZoom);
    this.emitCamera();
  }

  focusWorker(id: string) {
    const w = this.workers.get(id);
    if (!w) return;
    this.targetZoom = Math.max(this.targetZoom, 3.2);
    const T = this.map.tileSize;
    [this.tcx, this.tcy] = this.clampCenter((w.x + 0.5) * T, (w.y + 0.2) * T, this.targetZoom);
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
      me.action = 'I have a new assignment.';
      target.action = 'Name the project. I will assign the work.';
      this.onManager?.();
    } else if (target.id === SINT_ID) {
      me.action = 'Dag Sinterklaas!';
      target.action = 'Dag kapitein! Ben je wel lief geweest? 🎁';
    } else if (target.id.startsWith('npc:piet')) {
      me.action = 'Hoi Piet!';
      target.action = 'Hier, een pepernoot voor jou! 🍪';
      this.throwPepernoten(target, now);
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
    return this.map.at(Math.floor(me.x + 0.5), Math.floor(me.y + 0.8)) === 'E';
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
    const fx = x + 0.5;
    const fy = y + 0.8;
    const rx = 0.28;
    const ry = 0.16;
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
      me.room = this.map.roomAt(Math.round(me.x), Math.round(me.y + 0.3)) ?? me.room;
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
    const pad = 2 * this.scale;
    // sprites, front-most first
    for (const w of [...visible].sort((a, b) => b.y - a.y)) {
      const b = this.spriteBox(w, t);
      if (x >= b.x - pad && x <= b.x + b.size + pad && y >= b.y - pad && y <= b.y + b.size + pad)
        return { kind: 'worker', sessionId: w.sessionId, workerId: w.id };
    }
    // name tags / bubbles, top-most first
    for (const c of [...this.lastCallouts].reverse()) {
      const b = c.box;
      if (!c.w.leaving && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)
        return { kind: 'worker', sessionId: c.w.sessionId, workerId: c.w.id };
    }
    // room under the pointer (floor or furniture inside its walls)
    const T = this.map.tileSize;
    const tx = Math.floor((x - this.ox) / (T * this.scale));
    const ty = Math.floor((y - this.oy) / (T * this.scale));
    const room = this.map.roomAt(tx, ty);
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
      for (const a of s.subagents) {
        const id = `${s.id}:${a.id}`;
        live.add(id);
        this.upsert(id, s.id, true, a.agentType, { ...look, archetype: 'droid' }, this.displayRoom(a.room, a.status), a.status, a.action, now);
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
    } else if (w.room !== room) {
      this.releaseSpot(w);
      w.room = room;
      w.spot = this.claimSpot(id, room);
      this.walkTo(w, w.spot);
      if (room === BOSS_ROOM && !isSub) this.bossAssigns(name);
    }
    if (w.action !== action || w.status !== status) w.actionAt = now;
    Object.assign(w, { look, status, action });
    w.baseName = name;
    this.applyName(w);
    return w;
  }

  /** Worker is gone from the server: walk to the exit (subagents: back to the meeting room) and vanish. */
  private sendOff(w: Worker) {
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
    const spot =
      (seats.length ? free(seats, hash(id, room, 'seat') % seats.length) : undefined) ??
      free(spots, start) ??
      free(this.map.overflow[room], start) ??
      spots[start]; // full: share
    this.occupied.set(`${spot[0]},${spot[1]}`, id);
    return spot;
  }

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

  /** Someone just came to the manager's office for a new task. */
  private bossAssigns(name: string) {
    const boss = this.workers.get(BOSS_ID);
    if (!boss) return;
    boss.action = BOSS_ASSIGN[Math.floor(Math.random() * BOSS_ASSIGN.length)](name);
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
    this.throws.push({ x: (w.x + 0.5) * T, y: (w.y + 0.3) * T, t0: now, seed: Math.floor(Math.random() * 1e6) });
  }

  /** Pepernoten flying out in little arcs and bouncing on the floor. */
  private drawThrows(now: number) {
    const { ctx, scale: s } = this;
    for (const th of this.throws) {
      const p = (now - th.t0) / 1100;
      if (p > 1.25) continue;
      for (let i = 0; i < 9; i++) {
        const k = hash(th.seed, i);
        const angle = Math.PI * (0.1 + 0.8 * ((k % 100) / 100)) + Math.PI; // upward fan
        const speed = 18 + (k >> 7) % 22;
        const q = Math.min(p, 1);
        const dx = Math.cos(angle) * speed * q;
        const arc = Math.sin(Math.min(q, 1) * Math.PI) * (10 + (k % 8)); // up then down to the floor
        const x = this.ox + (th.x + dx) * s;
        const y = this.oy + (th.y + 6 * q - arc) * s;
        ctx.globalAlpha = p > 1 ? Math.max(0, 1 - (p - 1) * 4) : 1;
        ctx.fillStyle = i % 2 ? '#8a5a30' : '#a06a3a';
        ctx.fillRect(x, y, 1.6 * s, 1.4 * s);
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
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#0b1026';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.layers.floor, this.ox, this.oy, map.w * T * s, map.h * T * s);

    const sorted = [...this.workers.values()].sort((a, b) => a.y - b.y);
    for (const w of sorted) this.drawFloorMarker(w, t);
    this.drawBossAura(t);
    const view: DecorView = {
      ctx, s, dpr: this.dpr, width: this.canvas.width, height: this.canvas.height,
      px: (tx) => this.px(tx), py: (ty) => this.py(ty),
    };

    // Depth: draw standing objects row by row, each row's workers right after it. A worker whose feet
    // are in row y is in front of everything based in rows <= y and behind rows > y.
    const byRow = new Map<number, Worker[]>();
    for (const w of sorted) {
      const row = Math.max(0, Math.min(map.h - 1, Math.floor(w.y + 1e-6)));
      byRow.set(row, [...(byRow.get(row) ?? []), w]);
    }
    for (let y = 0; y < map.h; y++) {
      ctx.drawImage(this.layers.strips[y], this.ox, this.py(y) - MAX_RISE * s, map.w * T * s, (T + MAX_RISE) * s);
      this.drawAnimatedRow(y, t);
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
    this.decor.drawOverlay(this.holiday, view, t);
    this.drawRoomHighlight(t);
    this.drawRoomLabels();

    const callouts = this.layoutCallouts(sorted, t);
    this.lastCallouts = callouts;
    for (const c of callouts) this.drawCallout(c, t);
  }

  private px(tx: number) {
    return this.ox + tx * this.map.tileSize * this.scale;
  }
  private py(ty: number) {
    return this.oy + ty * this.map.tileSize * this.scale;
  }

  private font(px: number, weight = 600) {
    return `${weight} ${px}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  }

  /** Text size in device px: grows with zoom but stays within [min, max] CSS px. */
  private textSize(perScale: number, min: number, max: number) {
    const css = (perScale * this.scale) / this.dpr;
    return Math.round(Math.max(min, Math.min(max, css)) * this.dpr);
  }

  private roomScreenRect(id: RoomId): Rect {
    const [x0, y0, x1, y1] = this.map.rooms[id].rect;
    const x = this.px(x0 + 1);
    const y = this.py(y0 + 1) - WALL_RISE * this.scale * 0.3;
    return { x, y, w: this.px(x1) - x, h: this.py(y1) - y };
  }

  /** Selected room: dim everything else and outline it. Hovered room: soft outline. */
  private drawRoomHighlight(t: number) {
    const { ctx } = this;
    const lw = Math.max(1.5, this.scale * 0.6);
    const sel = this.sel.roomId;
    if (sel) {
      const r = this.roomScreenRect(sel);
      ctx.fillStyle = 'rgba(5,8,20,0.5)';
      ctx.beginPath();
      ctx.rect(0, 0, this.canvas.width, this.canvas.height);
      ctx.roundRect(r.x, r.y, r.w, r.h, 4 * this.scale);
      ctx.fill('evenodd');
      ctx.strokeStyle = '#4ff0ff';
      ctx.lineWidth = lw;
      ctx.setLineDash([6 * this.dpr, 4 * this.dpr]);
      ctx.lineDashOffset = -t / 40;
      ctx.beginPath();
      ctx.roundRect(r.x, r.y, r.w, r.h, 4 * this.scale);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (this.hover?.kind === 'room' && this.hover.roomId !== sel) {
      const r = this.roomScreenRect(this.hover.roomId);
      ctx.strokeStyle = 'rgba(79,240,255,0.45)';
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.roundRect(r.x, r.y, r.w, r.h, 4 * this.scale);
      ctx.stroke();
    }
  }

  private drawRoomLabels() {
    const { ctx, map } = this;
    const size = this.textSize(4.2, 9, 15);
    ctx.font = this.font(size, 700);
    ctx.textBaseline = 'top';
    for (const [id, room] of Object.entries(map.rooms)) {
      if (map.rooms[id as RoomId] !== room) continue; // alias for a missing room
      const [x0, y0] = room.rect;
      // A sign on the room's back wall (the wall cap rises WALL_RISE px above its tile).
      const x = this.px(x0 + 1) + 2 * this.scale;
      const y = this.py(y0) - WALL_RISE * this.scale + 3 * this.scale;
      const cantina = this.evening && id === CANTINA;
      const text = cantina ? '🍺 CANTINA' : room.label.toUpperCase();
      const w = ctx.measureText(text).width;
      const active = this.sel.roomId === id || (this.hover?.kind === 'room' && this.hover.roomId === id);
      ctx.fillStyle = cantina ? 'rgba(40,8,40,0.9)' : active ? 'rgba(20,60,80,0.9)' : 'rgba(8,12,24,0.6)';
      ctx.beginPath();
      ctx.roundRect(x - 3 * this.dpr, y - 2 * this.dpr, w + 6 * this.dpr, size + 4 * this.dpr, 3 * this.dpr);
      ctx.fill();
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

  /** Top-left of the sprite in screen pixels, plus its size. */
  private spriteBox(w: Worker, t: number) {
    const s = this.scale;
    const T = this.map.tileSize;
    const size = (w.isSub ? 12 : 16) * s;
    const moving = w.path.length > 0;
    const bob = !moving && w.status === 'working' && Math.floor(t / 400) % 2 === 0 ? 1 : 0;
    const p0 = this.pokes.get(w.id);
    const p = p0 === undefined ? 1 : (performance.now() - p0) / POKE_MS;
    let hop = p < 1 ? Math.sin(p * Math.PI) * 6 : 0;
    if (p >= 1 && this.partying(w)) hop = Math.abs(Math.sin(((t + (hash(w.id) % 4) * 120) / BEAT_MS) * Math.PI)) * 1.5;
    const x = this.px(w.x) + (T * s - size) / 2;
    const y = this.py(w.y) + (T * s - size) - 3 * s - (bob + hop) * s;
    return { x, y, size, hop };
  }

  /** Selection/hover ring and pulsing red "waiting" ring under the worker's feet. */
  private drawFloorMarker(w: Worker, t: number) {
    const { ctx, scale: s } = this;
    const { x, y, size, hop } = this.spriteBox(w, t);
    const cx = x + size / 2;
    const cy = y + size - 1 * s + hop * s;
    if (w.status === 'waiting') {
      const p = (t % 1200) / 1200;
      ctx.strokeStyle = `rgba(232,60,60,${0.9 * (1 - p)})`;
      ctx.lineWidth = Math.max(1, s * 0.8);
      ctx.beginPath();
      ctx.ellipse(cx, cy, size * (0.35 + p * 0.5), size * (0.15 + p * 0.22), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (this.nearbyId === w.id) {
      const p = 0.5 + 0.5 * Math.sin(t / 220);
      ctx.strokeStyle = `rgba(255,216,77,${0.55 + 0.4 * p})`;
      ctx.lineWidth = Math.max(1.5, s * 0.8);
      ctx.beginPath();
      ctx.ellipse(cx, cy, size * (0.55 + 0.05 * p), size * 0.23, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    const exact = this.sel.workerId === w.id;
    const family = !exact && this.sel.sessionId === w.sessionId;
    const hovered = this.hover?.kind === 'worker' && this.hover.workerId === w.id;
    if (exact || family || hovered) {
      ctx.strokeStyle = w.look.color;
      ctx.globalAlpha = exact ? 1 : family ? 0.45 : 0.7;
      ctx.lineWidth = Math.max(1, s * (exact ? 0.8 : 0.5));
      if (exact) {
        ctx.setLineDash([3 * s, 2 * s]);
        ctx.lineDashOffset = -t / 60;
      }
      ctx.beginPath();
      ctx.ellipse(cx, cy, size * 0.5, size * 0.21, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }

  private drawWorker(w: Worker, t: number, typing = false) {
    const { ctx } = this;
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
    ctx.drawImage(getSprite(w.look, dir, frame), Math.round(x), Math.round(y), size, size);
    ctx.globalAlpha = 1;
    if (this.holiday === 'christmas' && !isNpc(w.id)) santaHat(ctx, Math.round(x), Math.round(y), size, dir === 'left');
    if (party) this.drawBeer(w, t, dir);
  }

  /** A beer mug in hand; every few seconds a sip. */
  private drawBeer(w: Worker, t: number, dir: Dir) {
    const { ctx } = this;
    const { x, y, size } = this.spriteBox(w, t);
    const u = size / 16;
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
    ctx.fillStyle = '#f2b13d';
    ctx.fillRect(mx, my + u, 3 * u, 3 * u); // beer
    ctx.fillStyle = '#fffbe8';
    ctx.fillRect(mx, my, 3 * u, 1.2 * u); // foam
    ctx.fillStyle = '#d8dde6';
    ctx.fillRect(flip ? mx - u : mx + 3 * u, my + 1.5 * u, u, 1.5 * u); // handle
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(mx + 0.5 * u, my + 1.5 * u, 0.6 * u, 2 * u); // glass glint
  }

  /** Seated at a desk in the dev room, working, not walking, not being poked. */
  private isTyping(w: Worker): boolean {
    if (w.path.length || w.status !== 'working' || !TYPING_ROOMS.has(w.room) || this.pokes.has(w.id)) return false;
    const [x, y] = [Math.round(w.x), Math.round(w.y)];
    return this.map.at(x, y - 1) === 'd';
  }

  /** The monitor in front of a typing worker shows code scrolling by. */
  private drawCodeScreen(w: Worker, t: number) {
    const { ctx, scale: s } = this;
    const [dx, dy] = [Math.round(w.x), Math.round(w.y) - 1];
    // screen area of the desk sprite (see tiles.ts 'd'): x 4..12, y -4..2 relative to the desk tile
    const sx = this.px(dx) + 4 * s;
    const sy = this.py(dy) - 4 * s;
    ctx.fillStyle = '#0d1626';
    ctx.fillRect(sx, sy, 8 * s, 6 * s);
    const palette = ['#c792ea', '#82aaff', '#c3e88d', '#f78c6c', '#89ddff', '#ffcb6b'];
    const line = Math.floor(t / 260); // a new line every ~quarter second
    for (let i = 0; i < 3; i++) {
      const n = line + i;
      const indent = hash(w.id, n, 'i') % 3;
      const len = 2 + (hash(w.id, n, 'l') % (6 - indent));
      // the newest (bottom) line grows as it's being typed
      const shown = i === 2 ? Math.min(len, 1 + Math.floor(((t % 260) / 260) * len)) : len;
      ctx.fillStyle = palette[hash(w.id, n, 'c') % palette.length];
      ctx.fillRect(sx + indent * s, sy + (1 + i * 2) * s, shown * s, s);
    }
    // blinking cursor
    if (Math.floor(t / 300) % 2) {
      ctx.fillStyle = '#e8eefc';
      ctx.fillRect(sx + 7 * s, sy + 5 * s, s * 0.6, s);
    }
    // glow on the worker's face side of the desk
    ctx.fillStyle = 'rgba(120,200,255,0.07)';
    ctx.fillRect(sx - 2 * s, sy - 1 * s, 12 * s, 8 * s);
  }

  /** A low red aura pulsing on the floor around the manager's desk. */
  private drawBossAura(t: number) {
    const boss = this.workers.get(BOSS_ID);
    if (!boss) return;
    const { ctx, scale: s } = this;
    const T = this.map.tileSize;
    const cx = this.px(boss.x + 0.5);
    const cy = this.py(boss.y + 1);
    const pulse = 0.75 + 0.25 * Math.sin(t / 900);
    const rad = T * s * 3.2 * (0.92 + 0.08 * pulse);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    g.addColorStop(0, `rgba(200,10,30,${0.32 * pulse})`);
    g.addColorStop(0.6, `rgba(140,0,20,${0.14 * pulse})`);
    g.addColorStop(1, 'rgba(120,0,20,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rad, rad * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  /** When he speaks the office lights dim and only his visor glows. */
  private drawBossPresence(t: number) {
    const boss = this.workers.get(BOSS_ID);
    if (!boss) return;
    const { ctx, scale: s } = this;
    const since = performance.now() - boss.actionAt;
    const k = since < 300 ? since / 300 : since < BOSS_SPEAK_MS ? 1 : Math.max(0, 1 - (since - BOSS_SPEAK_MS) / 800);
    if (k > 0) {
      const [x0, y0, x1, y1] = this.map.rooms[BOSS_ROOM].rect;
      const rx = this.px(x0 + 1);
      const ry = this.py(y0 + 1) - WALL_RISE * s;
      ctx.fillStyle = `rgba(4,2,10,${0.42 * k})`;
      ctx.fillRect(rx, ry, this.px(x1) - rx, this.py(y1) - ry);
    }
    // visor glow (always a little, brighter while speaking)
    const { x, y, size } = this.spriteBox(boss, t);
    const u = size / 16;
    const vx = x + 8 * u;
    const vy = y + 4.5 * u;
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
    const { ctx } = this;
    const { x, y, size } = this.spriteBox(w, t);
    const u = size / 16;
    ctx.fillStyle = '#1c1820';
    ctx.fillRect(x + 2 * u, y - 3 * u, 12 * u, 15 * u);
    ctx.fillStyle = '#3a2a3a';
    ctx.fillRect(x + 3 * u, y - 2 * u, 10 * u, 13 * u);
    ctx.fillStyle = '#4a3a4a';
    ctx.fillRect(x + 3 * u, y - 2 * u, 10 * u, u);
    ctx.fillStyle = '#c9a66b';
    for (const [bx, by] of [[4, 0], [11, 0], [4, 5], [11, 5]]) ctx.fillRect(x + bx * u, y + by * u, u, u); // studs
  }

  /** Office chair back, drawn over the seated worker (we see them from behind). */
  private drawChair(w: Worker, t: number) {
    const { ctx } = this;
    const { x, y, size } = this.spriteBox(w, t);
    const u = size / 16; // one sprite pixel
    // backrest
    ctx.fillStyle = '#2a2f3b';
    ctx.fillRect(x + 4 * u, y + 9 * u, 8 * u, 4 * u);
    ctx.fillStyle = '#444b5c';
    ctx.fillRect(x + 4 * u, y + 9 * u, 8 * u, u);
    ctx.fillStyle = w.look.color; // a stripe in the session color
    ctx.globalAlpha = 0.6;
    ctx.fillRect(x + 5 * u, y + 11 * u, 6 * u, u);
    ctx.globalAlpha = 1;
    // post + wheel base
    ctx.fillStyle = '#1c2029';
    ctx.fillRect(x + 7 * u, y + 13 * u, 2 * u, 2 * u);
    ctx.fillRect(x + 4 * u, y + 15 * u, 8 * u, u);
  }

  /** Little code symbols float up from the keyboard while typing. */
  private drawKeystrokes(w: Worker, t: number) {
    const { ctx, scale: s } = this;
    const period = 900;
    const baseX = this.px(Math.round(w.x)) + 8 * s;
    const baseY = this.py(Math.round(w.y) - 1) + 8 * s; // keyboard row on the desk
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
      const { x, y, size } = this.spriteBox(w, t);
      const head = { x: x + size / 2, y: y - 1 * s };
      const isSel = this.sel.workerId === w.id || this.sel.sessionId === w.sessionId;
      const inSelRoom = roomSel !== null && w.room === roomSel;

      const tfs = this.textSize(w.isSub ? 3.4 : 4.2, w.isSub ? 9 : 10, w.isSub ? 12 : 14);
      ctx.font = this.font(tfs);
      const party = this.partying(w);
      const mail = w.mail ? ` 📨${w.mail}` : '';
      const tagText = (w.status === 'idle' && !party ? `${w.name} · zZ` : w.name) + mail;
      const tag = { text: tagText, fs: tfs, w: ctx.measureText(tagText).width + tfs * 0.8, h: tfs * 1.4 };

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
          w: ctx.measureText(text).width + bfs * 1.1,
          h: bfs * 1.66,
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
      c.w.y * 100 +
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
    if (tagTop + tag.h < head.y - 1) {
      ctx.strokeStyle = w.look.color;
      ctx.lineWidth = Math.max(1, this.dpr);
      ctx.beginPath();
      ctx.moveTo(cx, tagTop + tag.h);
      ctx.lineTo(head.x, head.y);
      ctx.stroke();
    }

    // name tag
    const selected = this.sel.workerId === w.id;
    ctx.font = this.font(tag.fs);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = selected ? 'rgba(30,40,70,0.95)' : 'rgba(12,16,28,0.82)';
    ctx.beginPath();
    ctx.roundRect(cx - tag.w / 2, tagTop, tag.w, tag.h, tag.h / 3);
    ctx.fill();
    if (selected) {
      ctx.strokeStyle = w.look.color;
      ctx.lineWidth = Math.max(1, this.dpr);
      ctx.stroke();
    }
    ctx.fillStyle = w.look.color;
    const bar = Math.max(1, this.dpr);
    ctx.fillRect(cx - tag.w / 2 + tag.h / 3, tagTop + tag.h - bar, tag.w - (tag.h / 3) * 2, bar);
    ctx.fillStyle = '#e8eefc';
    ctx.fillText(tag.text, cx, tagTop + tag.h / 2);
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
    ctx.globalAlpha = (dimmed ? 0.35 : 1) * bubble.alpha;
    ctx.fillStyle = bubble.waiting ? `rgb(${200 + 40 * pulse},${40 + 20 * pulse},48)` : '#f4f6fa';
    ctx.strokeStyle = bubble.waiting ? '#5a0d12' : 'rgba(12,16,28,0.9)';
    ctx.lineWidth = Math.max(1, this.dpr);
    ctx.beginPath();
    ctx.roundRect(left, top, bubble.w, bubble.h, Math.min(bubble.h / 2.5, 8 * this.dpr));
    ctx.fill();
    ctx.stroke();
    // tail pointing down at the name tag
    ctx.beginPath();
    ctx.moveTo(cx - tail, bottom - ctx.lineWidth);
    ctx.lineTo(cx, bottom + tail);
    ctx.lineTo(cx + tail, bottom - ctx.lineWidth);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx - tail, bottom);
    ctx.lineTo(cx, bottom + tail);
    ctx.lineTo(cx + tail, bottom);
    ctx.stroke();
    ctx.fillStyle = bubble.waiting ? '#ffffff' : '#141a2b';
    ctx.font = this.font(bubble.fs, 500);
    ctx.textBaseline = 'middle';
    ctx.fillText(bubble.text, left + bubble.fs * 0.55, top + bubble.h / 2 + 0.5);

    // Big pulsing "!" above waiting workers.
    if (bubble.waiting) {
      const fs = bubble.fs * (1.5 + 0.25 * pulse);
      ctx.globalAlpha = 1;
      ctx.font = this.font(fs, 900);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = Math.max(2, this.dpr * 2);
      ctx.strokeStyle = '#3a0508';
      ctx.strokeText('!', cx, top - 1 * s);
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
          const wallish = (q: string) => q === '#' || q === 'V';
          const face = y < this.map.h - 1 && !wallish(this.map.at(x, y + 1));
          const horiz = wallish(this.map.at(x - 1, y)) || wallish(this.map.at(x + 1, y));
          const g = face
            ? { gx: 1, gy: -WALL_RISE + 3, gw: 14, gh: 14 - (-WALL_RISE + 3) }
            : horiz
              ? { gx: 0, gy: -WALL_RISE + 5, gw: 16, gh: 7 }
              : { gx: 5, gy: -WALL_RISE, gw: 6, gh: 16 };
          windows.set(y, [...(windows.get(y) ?? []), { x, ...g }]);
        }
        if (c === 'J') {
          jukes.push([x, y]);
          lights.push({ t: [x, y - 0.3], color: '255,80,200', r: 1.8 });
        }
        // light sources sit where the glowing part is drawn (monitors and racks stand above their tile)
        if (c === 'd') lights.push({ t: [x, y - 0.35], color: '120,200,255', r: 1.3 });
        if (c === 'H') lights.push({ t: [x, y - 0.2], color: '79,240,255', r: 2 });
        if (c === 'S') lights.push({ t: [x, y - 0.3], color: '90,230,140', r: 0.9 });
        if (c === 'K') lights.push({ t: [x, y - 0.2], color: '255,170,90', r: 1.6 });
        if (c === 'R') lights.push({ t: [x, y], color: '120,190,255', r: 1.2 });
      }
    return { racks, holos, jukes, windows, lights };
  }

  /** Blinking rack LEDs and hologram shimmer for objects based in row `row`. */
  private drawAnimatedRow(row: number, t: number) {
    const { ctx, scale: s } = this;
    const colors = ['#58e07a', '#f2d13d', '#3aa7e0', '#e8534a'];
    for (const [x, y] of this.animated.racks.get(row) ?? []) {
      RACK_LEDS.forEach(([lx, ly], i) => {
        const h = hash(x, y, i);
        const on = Math.floor(t / (180 + (h % 500)) + (h % 7)) % 3 !== 0;
        ctx.fillStyle = on ? colors[h % 4] : '#10141c';
        ctx.fillRect(this.px(x) + lx * s, this.py(y) + ly * s, s, s);
      });
    }
    if (this.evening)
      for (const [x, y] of this.animated.jukes.filter(([, jy]) => jy === row)) {
        const beat = Math.floor(t / BEAT_MS);
        for (let i = 0; i < 3; i++) {
          ctx.fillStyle = `rgb(${DISCO[(beat + i) % DISCO.length]})`;
          ctx.fillRect(this.px(x) + 3 * s, this.py(y) + (-1 + i * 2) * s, 10 * s, s);
        }
        // spinning record
        ctx.fillStyle = beat % 2 ? '#e8534a' : '#f2d13d';
        ctx.fillRect(this.px(x) + 7 * s, this.py(y) - 6 * s, 2 * s, 2 * s);
      }
    // Every couple of minutes the station makes a jump: stars stretch into streaks in every viewport.
    const JUMP_EVERY = 150_000;
    const JUMP_MS = 2600;
    const since = t % JUMP_EVERY;
    if (since < JUMP_MS) {
      const p = since / JUMP_MS;
      const intensity = Math.sin(p * Math.PI); // build up, then settle
      for (const wdw of this.animated.windows.get(row) ?? []) {
        const ox = this.px(wdw.x) + wdw.gx * s;
        const oy = this.py(row) + wdw.gy * s;
        ctx.save();
        ctx.beginPath();
        ctx.rect(ox, oy, wdw.gw * s, wdw.gh * s);
        ctx.clip();
        ctx.fillStyle = `rgba(40,60,120,${0.35 * intensity})`;
        ctx.fillRect(ox, oy, wdw.gw * s, wdw.gh * s);
        for (let i = 0; i < 6; i++) {
          const k = hash(wdw.x, row, i);
          const ly = oy + ((k % 100) / 100) * wdw.gh * s;
          const len = (4 + (k % 10)) * s * (0.4 + 2.6 * intensity);
          const lx = ox + (((k >> 7) % 100) / 100) * wdw.gw * s - len / 2 + p * 6 * s;
          ctx.fillStyle = i % 3 === 0 ? `rgba(190,220,255,${0.9 * intensity})` : `rgba(255,255,255,${0.75 * intensity})`;
          ctx.fillRect(lx, ly, len, Math.max(1, s * 0.6));
        }
        ctx.restore();
      }
    }
    for (const [x, y] of this.animated.holos.get(row) ?? []) {
      const a = 0.25 + 0.2 * Math.sin(t / 300 + x);
      ctx.fillStyle = `rgba(160,255,255,${a})`;
      const scan = Math.floor(t / 120 + x) % 8;
      ctx.fillRect(this.px(x) + 5 * s, this.py(y) + (-6 + scan * 2) * s, 6 * s, s);
    }
  }

  /** Cantina after hours: disco lights on the floor and music notes from the jukebox. */
  private drawParty(t: number) {
    const { ctx, map, scale: s } = this;
    const T = map.tileSize;
    const [x0, y0, x1, y1] = map.rooms[CANTINA].rect;
    const rx = this.px(x0 + 1);
    const ry = this.py(y0 + 1);
    const rw = this.px(x1) - rx;
    const rh = this.py(y1) - ry;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rx, ry - WALL_RISE * s, rw, rh + WALL_RISE * s);
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
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0, `rgba(${color},0.32)`);
      g.addColorStop(1, `rgba(${color},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    });
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();

    // music notes rising from each jukebox
    const fs = this.textSize(5, 10, 22);
    ctx.font = `700 ${fs}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [jx, jy] of this.animated.jukes) {
      const bx = this.px(jx + 0.5);
      const by = this.py(jy) - 12 * s;
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
    ctx.fillStyle = `rgba(8,12,40,${0.5 * dark})`;
    ctx.fillRect(this.ox, this.oy - WALL_RISE * s, map.w * T * s, (map.h * T + WALL_RISE) * s);
    // Screens, holograms and the coffee machine glow at night.
    ctx.globalCompositeOperation = 'lighter';
    for (const { t: [x, y], color, r } of this.animated.lights) {
      const cx = this.px(x + 0.5);
      const cy = this.py(y + 0.4);
      const rad = r * T * s * (0.95 + 0.05 * Math.sin(t / 500 + x * 3));
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0, `rgba(${color},${0.22 * dark})`);
      g.addColorStop(1, `rgba(${color},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    }
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
