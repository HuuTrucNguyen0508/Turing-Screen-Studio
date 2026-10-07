export const dashboardSources = ['t3-threads', 'game-resources'] as const;
export function isDashboardSource(source: string | undefined): boolean {
  return dashboardSources.some((entry) => entry === source);
}

export interface ThreadRow { title: string; provider: string; status: string }
export interface GameRow { name: string; resource: string; current: number | null; capacity: number | null; remaining: string; status: string; age: string }
const clean = (input: unknown, maximum = 100) => typeof input === 'string' ? Array.from(input.replace(/[\x00-\x1f\x7f]/g, ' ')).slice(0, maximum).join('') : '';
const whole = (input: unknown, maximum = 10000) => typeof input === 'number' && Number.isInteger(input) && input >= 0 && input <= maximum ? input : null;
const record = (input: unknown): Record<string, unknown> => input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};

/** Only display rows enter the card. Live values never change the saved layout. */
export function dashboardRows(detail: string) {
  let value: Record<string, unknown> = {};
  try { if (detail.length <= 32768) value = record(JSON.parse(detail)); } catch { /* Invalid sample data remains unavailable. */ }
  const working = whole(value.working, 100000);
  const threads: ThreadRow[] = Array.isArray(value.threads) && working !== null ? value.threads.slice(0, 5).filter(row => row !== null && typeof row === 'object' && !Array.isArray(row)).map(record).map(row => ({
    title: clean(row.title) || 'Untitled thread', provider: clean(row.provider, 24), status: clean(row.status, 24),
  })) : [];
  const games: GameRow[] = Array.isArray(value.games) ? value.games.slice(0, 3).filter(row => row !== null && typeof row === 'object' && !Array.isArray(row)).map(record).map(row => ({
    name: clean(row.name), resource: clean(row.resource),
    current: ['estimate', 'full', 'demo'].includes(String(row.status)) ? whole(row.current) : null,
    capacity: whole(row.capacity), remaining: clean(row.remaining), status: clean(row.status, 24), age: clean(row.age, 24),
  })) : [];
  return { working, threads, games, note: clean(value.note) };
}

export function dashboardGeometry(width: number, height: number, source: string) {
  const padding = Math.min(28, Math.max(4, Math.floor(width / 8)));
  const top = source === 't3-threads' ? 168 : 58;
  const stride = source === 't3-threads' ? 46 : Math.min(90, Math.max(1, Math.floor((height - 74) / 3)));
  const capacity = source === 't3-threads' ? Math.max(0, Math.min(5, Math.floor((height - 150) / stride))) : stride >= 44 ? 3 : 0;
  return { padding, top, stride, capacity, available: Math.max(1, width - padding * 2) };
}

export function shortDashboardText(text: string, available: number, size: number, mono = false) {
  const capacity = Math.max(1, Math.floor(available / (size * (mono ? .6 : .55))));
  const characters = Array.from(text);
  return characters.length <= capacity ? text : characters.slice(0, capacity - 1).join('') + '…';
}
