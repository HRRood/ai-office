/**
 * Room mapping: the single place that decides which room an activity sends a worker to,
 * and what their speech bubble says. Shared by the server and the frontend.
 *
 * To change where a tool goes, edit TOOL_ROOMS / TOOL_PREFIX_ROOMS below.
 * Room ids must match the room ids in web/src/map.json.
 */

export const ROOM_IDS = [
  'reception',
  'library',
  'workshop',
  'serverRoom',
  'research',
  'whiteboard',
  'meeting',
  'mailroom',
  'lounge',
  'openOffice',
] as const;

export type RoomId = (typeof ROOM_IDS)[number];

export const ROOM_LABELS: Record<RoomId, string> = {
  reception: "Manager's Office", // new prompts land here: the manager hands out the task
  library: 'Library',
  workshop: 'Dev Room', // where code gets written: workers sit at a desk and type
  serverRoom: 'Server Room',
  research: 'Research',
  whiteboard: 'Whiteboard',
  meeting: 'Meeting Room',
  mailroom: 'Mailroom',
  lounge: 'Lounge',
  openOffice: 'Open Office',
};

/** Exact tool name -> room. */
export const TOOL_ROOMS: Record<string, RoomId> = {
  // Reading & searching
  Read: 'library',
  Grep: 'library',
  Glob: 'library',
  LS: 'library',
  ToolSearch: 'library',
  // Writing code
  Edit: 'workshop',
  Write: 'workshop',
  MultiEdit: 'workshop',
  NotebookEdit: 'workshop',
  // Shell
  Bash: 'serverRoom',
  PowerShell: 'serverRoom',
  Monitor: 'serverRoom',
  // Web
  WebSearch: 'research',
  WebFetch: 'research',
  // Planning
  TodoWrite: 'whiteboard',
  TaskCreate: 'whiteboard',
  TaskUpdate: 'whiteboard',
  EnterPlanMode: 'whiteboard',
  ExitPlanMode: 'whiteboard',
  // Delegating to subagents
  Agent: 'meeting',
  Task: 'meeting',
  SendMessage: 'meeting',
  // Talking to the user
  AskUserQuestion: 'reception',
};

/** Tool name prefix -> room (checked after TOOL_ROOMS). */
export const TOOL_PREFIX_ROOMS: Array<[prefix: string, room: RoomId]> = [['mcp__', 'mailroom']];

/** Where lifecycle events send a worker. */
export const EVENT_ROOMS = {
  SessionStart: 'lounge',
  UserPromptSubmit: 'reception',
  SubagentStart: 'meeting',
  Stop: 'lounge',
  StopFailure: 'lounge',
} satisfies Record<string, RoomId>;

/** Unknown tools go here. */
export const DEFAULT_ROOM: RoomId = 'openOffice';

/** The room new workers enter through. */
export const ENTRANCE_ROOM: RoomId = 'reception';

export function roomForTool(tool: string | undefined): RoomId {
  if (!tool) return DEFAULT_ROOM;
  if (TOOL_ROOMS[tool]) return TOOL_ROOMS[tool];
  for (const [prefix, room] of TOOL_PREFIX_ROOMS) if (tool.startsWith(prefix)) return room;
  return DEFAULT_ROOM;
}

export interface ToolInfo {
  tool?: string;
  file?: string;
  cmd?: string;
  subagent_type?: string;
}

/** Speech-bubble text for a tool call. */
export function describeTool({ tool, file, cmd, subagent_type }: ToolInfo): string {
  const f = file ?? 'a file';
  switch (tool) {
    case 'Read':
      return `Reading ${f}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Editing ${f}`;
    case 'Write':
      return `Writing ${f}`;
    case 'Grep':
      return 'Searching code';
    case 'Glob':
      return 'Finding files';
    case 'LS':
      return 'Listing files';
    case 'Bash':
    case 'PowerShell':
      return cmd ? `Running ${cmd}` : 'Running a command';
    case 'WebSearch':
      return 'Searching the web';
    case 'WebFetch':
      return 'Reading a web page';
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return 'Updating the plan';
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return 'Planning';
    case 'Agent':
    case 'Task':
      return `Briefing ${subagent_type ?? 'a helper'}`;
    case 'AskUserQuestion':
      return 'Asking you a question';
    case undefined:
      return 'Working';
  }
  if (tool.startsWith('mcp__')) {
    const [, server, ...rest] = tool.split('__');
    return `Calling ${server}${rest.length ? `: ${rest.join('__')}` : ''}`;
  }
  return `Using ${tool}`;
}

/** Human-readable reasons someone ends up in a room (for the room card). */
export function roomPurpose(room: RoomId): string[] {
  const out: string[] = [];
  const events: Record<string, string> = {
    SessionStart: 'clocking in',
    UserPromptSubmit: 'a new prompt',
    SubagentStart: 'new helpers',
    Stop: 'finished turns',
    StopFailure: 'errors',
  };
  for (const [ev, r] of Object.entries(EVENT_ROOMS)) if (r === room) out.push(events[ev] ?? ev);
  const tools = Object.entries(TOOL_ROOMS)
    .filter(([, r]) => r === room)
    .map(([t]) => t);
  if (tools.length) out.push(tools.join(', '));
  for (const [prefix, r] of TOOL_PREFIX_ROOMS) if (r === room) out.push(`${prefix}* tools`);
  if (room === DEFAULT_ROOM) out.push('any other tool');
  return out;
}
