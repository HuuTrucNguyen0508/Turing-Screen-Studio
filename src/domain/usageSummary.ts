export interface ProviderUsageRow { provider: string; value: string; state: string }
export interface QuotaUsageRow { provider: string; window: string; remainingPercent: number | null; reset: string; state: string }

/** Display rows are transient; the saved card contains only its source and demo settings. */
export function usageSummaryRows(detail: string) {
  const lines = detail.slice(0, 4096).split('\n');
  const clean = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 100);
  const providers: ProviderUsageRow[] = [];
  const quotas: QuotaUsageRow[] = [];
  for (const line of lines.slice(1, 9)) {
    const fields = line.split('\t');
    if (!['Codex', 'Claude', 'Cursor'].includes(fields[0])) continue;
    if (fields.length === 3 && providers.length < 3) {
      providers.push({ provider: fields[0], value: clean(fields[1]), state: clean(fields[2]) });
    } else if (fields.length === 5 && fields[0] !== 'Cursor' && quotas.length < 4) {
      const percent = fields[2].trim() ? Number(fields[2]) : NaN;
      quotas.push({ provider: fields[0], window: clean(fields[1]),
        remainingPercent: !fields[3].includes('reset time passed') && Number.isFinite(percent) && percent >= 0 && percent <= 100 ? 100 - percent : null,
        reset: clean(fields[3]), state: clean(fields[4]) });
    }
  }
  return { note: clean(lines[0] ?? ''), providers, quotas };
}
