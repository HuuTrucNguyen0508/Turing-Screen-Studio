import type { CalendarWidget } from './domain/layout';
import { CALENDAR_SAMPLE_DATE, calendarGeometry, calendarMonth } from './domain/calendar';
import './sensor-card-styles.css';

export default function CalendarContent({ widget }: { widget: CalendarWidget }) {
  const { width, height, settings } = widget;
  const month = calendarMonth(CALENDAR_SAMPLE_DATE, settings.weekStart);
  const g = calendarGeometry(width, height, settings.label, month?.weeks.length ?? 6);
  if (!month) return null;
  return <div className="sensor-card" data-sensor-card="calendar">
    <svg width={width} height={height} role="img" aria-label={`${settings.label || 'Calendar'}: ${month.title} ${month.year}, today ${month.today}, sample date`}>
      {g.kicker && <text className="sensor-kicker" x={g.padding} y={42}>{g.kicker}</text>}
      <text x={g.padding} y={g.titleY} fill="var(--text)" fontSize={g.titleSize}>{month.title}</text>
      <text className="sensor-mono" x={width - g.padding} y={g.titleY} textAnchor="end" fill="var(--muted)" fontSize={15}>{month.year}</text>
      {g.showGrid && <>
        {month.weekdays.map((weekday, column) => <text key={weekday.name} className="sensor-note" x={g.gridLeft + column * g.cellWidth + Math.floor(g.cellWidth / 2)} y={g.headerY} textAnchor="middle" fontSize={12}>{weekday.name}</text>)}
        {month.weeks.map((week, row) => week.map((day, column) => {
          if (day === null) return null;
          const cellLeft = g.gridLeft + column * g.cellWidth, top = g.gridTop + row * g.cellHeight;
          const today = day === month.today;
          return <g key={`${row}-${column}`} data-calendar-today={today || undefined}>
            {today && <rect className="calendar-today" x={cellLeft + 2} y={top + 2} width={g.cellWidth - 4} height={g.cellHeight - 4} rx={g.todayRadius} fill="var(--primary)" />}
            <text className="sensor-mono" x={cellLeft + Math.floor(g.cellWidth / 2)} y={top + Math.floor(g.cellHeight / 2) + Math.floor(g.daySize * .36)} textAnchor="middle" fontSize={g.daySize}
              fill={today ? 'var(--surface)' : month.weekdays[column].weekend ? 'var(--muted)' : 'var(--text)'}>{day}</text>
          </g>;
        }))}
      </>}
    </svg>
  </div>;
}
