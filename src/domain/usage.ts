import type { LayoutDocument } from './layout';

export const usageSources = [
  'codex-tokens', 'codex-cost', 'codex-weekly', 'codex-reset', 'codex-models',
  'claude-tokens', 'claude-cost', 'claude-session', 'claude-weekly', 'claude-reset', 'claude-models', 'storage',
] as const;

export function isUsageSource(source: string | undefined): boolean {
  return usageSources.some((item) => item === source);
}

export function dashboardHeading(document: LayoutDocument): string {
  if (document.widgets.some((widget) => widget.type !== 'text' && /^(codex|claude)-/.test(widget.settings.source ?? ''))) return 'AI usage';
  if (document.widgets.some((widget) => widget.type === 'storage' || (widget.type !== 'text' && widget.settings.source === 'storage'))) return 'Storage overview';
  return 'System overview';
}
