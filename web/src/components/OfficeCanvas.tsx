import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { RoomId } from '../../../shared/rooms.config';
import type { SessionState } from '../../../shared/types';
import { OfficeRenderer, type CameraState, type Pick, type Selection } from '../engine/renderer';

/** Camera controls the side panel can call. */
export interface OfficeApi {
  focusRoom(id: RoomId): void;
  focusWorker(id: string): void;
  follow(id: string | null): void;
  resetView(): void;
  poke(id: string): void;
  setVisitors(on: boolean): void;
  visitorsEnabled(): boolean;
}

interface Props {
  sessions: SessionState[];
  /** The first server snapshot has arrived; until then there's nothing to sync. */
  ready: boolean;
  selection: Selection;
  onPick: (p: Pick) => void;
  apiRef: MutableRefObject<OfficeApi | null>;
  onCamera: (c: CameraState) => void;
  workerName: (workerId: string) => string | undefined;
  /** You pressed E next to a session's worker. */
  onTalk: (workerId: string) => void;
  /** Names you gave people (worker id -> name). */
  nicknames: Record<string, string>;
  /** You pressed E next to the Manager. */
  onManager: () => void;
  /** Reports on the Manager's desk you haven't read. */
  unreadReports: number;
  /** Claude's questions waiting at the Manager's desk. */
  openQuestions: number;
}

const DRAG_THRESHOLD = 5; // px before a press becomes a pan

export function OfficeCanvas({ sessions, ready, selection, onPick, apiRef, onCamera, workerName, onTalk, nicknames, onManager, unreadReports, openQuestions }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<OfficeRenderer | null>(null);
  const [camera, setCamera] = useState<CameraState>({ zoom: 1, following: null });
  const [away, setAway] = useState(false);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const onCameraRef = useRef(onCamera);
  onCameraRef.current = onCamera;
  const onTalkRef = useRef(onTalk);
  onTalkRef.current = onTalk;
  const onManagerRef = useRef(onManager);
  onManagerRef.current = onManager;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const renderer = new OfficeRenderer(canvas);
    rendererRef.current = renderer;
    if (import.meta.env.DEV) (window as unknown as { __office: OfficeRenderer }).__office = renderer; // debugging aid
    renderer.onTalk = (id) => onTalkRef.current(id);
    renderer.onManager = () => onManagerRef.current();
    renderer.onPlayerAway = setAway;
    setAway(renderer.isPlayerAway);
    renderer.onCameraChange = (c) => {
      setCamera(c);
      onCameraRef.current(c);
    };
    apiRef.current = {
      focusRoom: (id) => renderer.focusRoom(id),
      focusWorker: (id) => renderer.focusWorker(id),
      follow: (id) => renderer.follow(id),
      resetView: () => renderer.resetView(),
      poke: (id) => renderer.poke(id),
      setVisitors: (on) => renderer.setVisitors(on),
      visitorsEnabled: () => renderer.visitorsEnabled,
    };

    const wrap = wrapRef.current!;
    const ro = new ResizeObserver(() => renderer.resize(wrap.clientWidth, wrap.clientHeight));
    ro.observe(wrap);
    renderer.resize(wrap.clientWidth, wrap.clientHeight);
    renderer.start();

    // ---- pointer input: drag to pan, pinch to zoom, click to select ----
    const pointers = new Map<number, { x: number; y: number }>();
    let press: { x: number; y: number; dragged: boolean } | null = null;
    let pinchDist = 0;

    const down = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) press = { x: e.clientX, y: e.clientY, dragged: false };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        if (press) press.dragged = true; // a pinch is never a click
      }
    };
    const move = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) {
        // hovering
        const p = renderer.pick(e.clientX, e.clientY);
        renderer.setHover(p);
        canvas.style.cursor = p ? 'pointer' : 'grab';
        return;
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0) renderer.zoomBy(d / pinchDist, (a.x + b.x) / 2, (a.y + b.y) / 2);
        pinchDist = d;
        return;
      }
      if (press && !press.dragged && Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_THRESHOLD) {
        press.dragged = true;
        canvas.style.cursor = 'grabbing';
      }
      if (press?.dragged) renderer.panBy(e.clientX - prev.x, e.clientY - prev.y);
    };
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (pointers.size === 0 && press) {
        if (!press.dragged) {
          const p = renderer.pick(e.clientX, e.clientY);
          if (p?.kind === 'worker') renderer.poke(p.workerId);
          onPickRef.current(p);
        }
        press = null;
        canvas.style.cursor = 'grab';
      }
    };
    const leave = () => renderer.setHover(null);
    const dbl = (e: MouseEvent) => {
      const p = renderer.pick(e.clientX, e.clientY);
      if (p?.kind === 'room') renderer.focusRoom(p.roomId);
      else if (p?.kind === 'worker') renderer.follow(p.workerId);
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      // trackpad pinch arrives as ctrl+wheel with small deltas; mouse wheels give big ones
      const k = e.ctrlKey ? 0.012 : 0.0018;
      renderer.zoomBy(Math.exp(-e.deltaY * k), e.clientX, e.clientY);
    };
    const typing = (e: KeyboardEvent) =>
      e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey;
    const key = (e: KeyboardEvent) => {
      if (typing(e)) return;
      // you: arrow keys / WASD walk, E / Enter talks to whoever is next to you
      if (renderer.keyDown(e.key)) {
        e.preventDefault();
        return;
      }
      if ((e.key === 'e' || e.key === 'E' || e.key === 'Enter') && !(e.target instanceof HTMLButtonElement)) {
        renderer.interact();
        e.preventDefault();
        return;
      }
      switch (e.key) {
        case '+':
        case '=':
          renderer.zoomBy(1.25);
          break;
        case '-':
        case '_':
          renderer.zoomBy(0.8);
          break;
        case '0':
          renderer.resetView();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    const keyUp = (e: KeyboardEvent) => renderer.keyUp(e.key);
    const blur = () => renderer.clearKeys();

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', leave);
    canvas.addEventListener('dblclick', dbl);
    canvas.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('keydown', key);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', blur);
    return () => {
      ro.disconnect();
      renderer.stop();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('dblclick', dbl);
      canvas.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', key);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', blur);
      rendererRef.current = null;
      apiRef.current = null;
    };
  }, [apiRef]);

  useEffect(() => {
    if (ready) rendererRef.current?.setSessions(sessions);
  }, [sessions, ready]);

  useEffect(() => {
    rendererRef.current?.setUnreadReports(unreadReports);
  }, [unreadReports]);

  useEffect(() => {
    rendererRef.current?.setOpenQuestions(openQuestions);
  }, [openQuestions]);

  useEffect(() => {
    rendererRef.current?.setSelection(selection);
  }, [selection]);

  useEffect(() => {
    rendererRef.current?.setNicknames(nicknames);
  }, [nicknames]);

  const r = rendererRef.current;
  const followingName = camera.following ? workerName(camera.following) : undefined;

  return (
    <div ref={wrapRef} className="office-canvas">
      <canvas ref={canvasRef} style={{ cursor: 'grab', touchAction: 'none' }} />
      <div className="zoom-controls" role="toolbar" aria-label="Camera">
        <button onClick={() => r?.zoomBy(1.25)} aria-label="Zoom in" title="Zoom in (+)">
          +
        </button>
        <button onClick={() => r?.zoomBy(0.8)} aria-label="Zoom out" title="Zoom out (−)">
          −
        </button>
        <button onClick={() => r?.resetView()} aria-label="Show whole office" title="Whole office (0)">
          ⤢
        </button>
        <span className="zoom-level">{Math.round(camera.zoom * 100)}%</span>
      </div>
      {away && (
        <button className="enter-office" onClick={() => rendererRef.current?.enterOffice()}>
          🚪 Enter the office
        </button>
      )}
      {followingName && (
        <div className="follow-chip">
          Following <b>{followingName}</b>
          <button onClick={() => r?.follow(null)} aria-label="Stop following">
            ×
          </button>
        </div>
      )}
      <div className="canvas-hint">
        Arrow keys / WASD: walk · E: talk · scroll: zoom · drag: pan · click a room or person
      </div>
    </div>
  );
}
