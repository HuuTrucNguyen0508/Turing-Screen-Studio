import { cardKicker } from './list';

/** Matches the clock sample, "Tuesday, 6 October". */
export const CALENDAR_SAMPLE_DATE = '2026-10-06';
export const calendarWeekStarts = ['monday', 'sunday'] as const;
export type CalendarWeekStart = typeof calendarWeekStarts[number];

const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayNames = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

export interface CalendarMonth {
  title: string; year: string; weekdays: { name: string; weekend: boolean }[];
  weeks: (number | null)[][]; today: number;
}

/** Pure date arithmetic in UTC, so the browser time zone never shifts the grid. */
export function calendarMonth(date: string, weekStart: CalendarWeekStart): CalendarMonth | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > length) return null;
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const shift = weekStart === 'monday' ? 1 : 0;
  const offset = (first - shift + 7) % 7;
  const cells = Array.from({ length: Math.ceil((offset + length) / 7) * 7 }, (_, index) => index - offset + 1)
    .map((value) => value >= 1 && value <= length ? value : null);
  return {
    title: monthNames[month - 1], year: String(year),
    weekdays: Array.from({ length: 7 }, (_, index) => (index + shift) % 7).map((weekday) => ({ name: dayNames[weekday], weekend: weekday === 0 || weekday === 6 })),
    weeks: Array.from({ length: cells.length / 7 }, (_, index) => cells.slice(index * 7, index * 7 + 7)),
    today: day,
  };
}

export function calendarGeometry(width: number, height: number, label: string, weeks: number) {
  const labelled = label !== '';
  const padding = Math.min(29, Math.floor(width / 6));
  const titleSize = Math.max(16, Math.min(28, Math.floor(width / 14)));
  const titleY = labelled ? 50 + titleSize : 24 + titleSize;
  const headerY = titleY + 24;
  const gridTop = headerY + 8;
  const cellWidth = Math.max(1, Math.floor((width - 2 * padding) / 7));
  const cellHeight = Math.max(1, Math.min(cellWidth, Math.floor((height - gridTop - 12) / Math.max(1, weeks))));
  return {
    padding, kicker: cardKicker(label, width), titleSize, titleY, headerY, gridTop, cellWidth, cellHeight,
    gridLeft: Math.floor((width - 7 * cellWidth) / 2),
    daySize: Math.max(10, Math.min(26, Math.floor(Math.min(cellWidth, cellHeight) * .48))),
    showGrid: cellHeight >= 12, todayRadius: Math.min(8, Math.floor(Math.min(cellWidth, cellHeight) / 4)),
  };
}
