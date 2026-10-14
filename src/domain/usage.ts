import type { LayoutDocument } from './layout';

export const usageSources = [
  'usage-tokens-30d', 'usage-cost-30d', 'usage-limits',
  'codex-tokens', 'codex-cost', 'codex-weekly', 'codex-reset', 'codex-models',
  'claude-tokens', 'claude-cost', 'claude-session', 'claude-weekly', 'claude-reset', 'claude-models', 'storage',
] as const;

export const usageSummarySources = ['usage-tokens-30d', 'usage-cost-30d', 'usage-limits'] as const;

export function isUsageSummary(source: string | undefined): boolean {
  return usageSummarySources.some((item) => item === source);
}

export function isUsageSource(source: string | undefined): boolean {
  return usageSources.some((item) => item === source);
}

export function dashboardHeading(document: LayoutDocument): string {
  const sources = document.widgets.map((widget) => 'source' in widget.settings ? widget.settings.source ?? '' : '');
  if (sources.some((source) => /^(codex|claude|usage)-/.test(source))) return 'AI usage';
  if (sources.includes('storage') || document.widgets.some((widget) => widget.type === 'storage')) return 'Storage overview';
  return 'System overview';
}
