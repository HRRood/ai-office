import raw from '../map.json';
import { DEFAULT_ROOM, ROOM_IDS, type RoomId } from '../../../shared/rooms.config';

export type Tile = [x: number, y: number];

export interface RoomDef {
  label: string;
  /** Inclusive wall rectangle [x0, y0, x1, y1]; the interior is strictly inside. */
  rect: [number, number, number, number];
}

export interface OfficeMap {
  w: number;
  h: number;
  tileSize: number;
  tiles: string[];
  rooms: Record<RoomId, RoomDef>;
  entrance: Tile;
  /** Tiles where workers stand in each room: next to furniture (desks, shelves, racks...). */
  spots: Record<RoomId, Tile[]>;
  /** Desk chairs: floor tiles with a desk directly above. Workers sit here first, facing the monitor. */
  seats: Record<RoomId, Tile[]>;
  /** Other free floor in each room, used when every furniture spot is taken. */
  overflow: Record<RoomId, Tile[]>;
  at(x: number, y: number): string;
  isWalkable(x: number, y: number): boolean;
  /** Temporarily block floor tiles (holiday decorations), replacing any earlier set. */
  setBlocked(tiles: Tile[]): void;
  roomAt(x: number, y: number): RoomId | undefined;
}

const FURNITURE_FREE = new Set(['.', 'D', 'E', '#', 'V']);
/** Furniture tall enough to hide someone standing just north of it. */
const TALL = new Set(['B', 'S', 'M', 'K', 'F', 'J', 'W', 'A', 'R', '#', 'V']); // walls rise too

export function loadMap(): OfficeMap {
  const tiles: string[] = raw.tiles;
  const h = tiles.length;
  const w = tiles[0].length;
  tiles.forEach((row, y) => {
    if (row.length !== w) throw new Error(`map.json: row ${y} has ${row.length} tiles, expected ${w}`);
  });
  const walkable = new Set<string>(raw.walkable);
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? tiles[y][x] : '#');
  let blocked = new Set<string>();
  const isWalkable = (x: number, y: number) => walkable.has(at(x, y)) && !blocked.has(`${x},${y}`);
  const setBlocked = (tiles: Tile[]) => {
    blocked = new Set(tiles.map(([x, y]) => `${x},${y}`));
  };

  const rooms = {} as Record<RoomId, RoomDef>;
  const rawRooms = raw.rooms as unknown as Record<string, RoomDef>;
  for (const id of ROOM_IDS) {
    if (rawRooms[id]) rooms[id] = rawRooms[id];
    else console.warn(`map.json has no room "${id}"; those workers will use "${DEFAULT_ROOM}"`);
  }
  if (!rooms[DEFAULT_ROOM]) throw new Error(`map.json must define the default room "${DEFAULT_ROOM}"`);
  for (const id of ROOM_IDS) rooms[id] ??= rooms[DEFAULT_ROOM];

  const roomAt = (x: number, y: number): RoomId | undefined => {
    for (const id of ROOM_IDS) {
      const [x0, y0, x1, y1] = rawRooms[id]?.rect ?? [];
      if (x0 === undefined) continue;
      if (x > x0 && x < x1 && y > y0 && y < y1) return id;
    }
    return undefined;
  };

  const nearDoor = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const c = at(x + dx, y + dy);
        if (c === 'D' || c === 'E') return true;
      }
    return false;
  };
  const nextToFurniture = (x: number, y: number) =>
    [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !FURNITURE_FREE.has(at(x + dx, y + dy)));

  const spots = {} as Record<RoomId, Tile[]>;
  const overflow = {} as Record<RoomId, Tile[]>;
  const seats = {} as Record<RoomId, Tile[]>;
  for (const id of ROOM_IDS) {
    const [x0, y0, x1, y1] = rooms[id].rect;
    const good: Tile[] = [];
    const other: Tile[] = [];
    for (let y = y0 + 1; y < y1; y++)
      for (let x = x0 + 1; x < x1; x++) {
        if (at(x, y) !== '.' || nearDoor(x, y)) continue;
        // Standing right behind something tall hides you (3/4 view), so those tiles are a last resort.
        const hidden = TALL.has(at(x, y + 1));
        (nextToFurniture(x, y) && !hidden ? good : other).push([x, y]);
      }
    seats[id] = good.filter(([x, y]) => at(x, y - 1) === 'd');
    spots[id] = good.length ? good : other;
    overflow[id] = good.length ? other : [];
  }

  return { w, h, tileSize: raw.tileSize, tiles, rooms, entrance: raw.entrance as Tile, spots, seats, overflow, at, isWalkable, setBlocked, roomAt };
}

/** Small deterministic hash, used for stable per-tile / per-worker variation. */
export function hash(...parts: Array<string | number>): number {
  let h = 2166136261;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    h = Math.imul(h ^ 0x9e3779b9, 16777619);
  }
  return h >>> 0;
}
