/** How sessions are named in the office. */
import type { SessionState } from './types';

/** The session's title (as in Claude Code's /resume list) if it has one, else the project folder. */
export function displayName(s: Pick<SessionState, 'title' | 'project'>): string {
  return s.title?.trim() || s.project;
}

/**
 * Shorten a name to at most `max` characters: cut at a word boundary when there's one reasonably
 * close, otherwise mid-word, and end with an ellipsis.
 */
export function shorten(name: string, max = 22): string {
  const clean = name.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  const base = space >= max * 0.55 ? cut.slice(0, space) : cut;
  return base.replace(/[\s,.;:–-]+$/, '') + '…';
}
