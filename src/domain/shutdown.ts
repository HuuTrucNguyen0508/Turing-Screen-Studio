export function shutdownFailure(status: number | null): string {
  if (status === 403) return 'Studio refused the shutdown request. Open Studio at its localhost or 127.0.0.1 address and try again.';
  if (status !== null) return `Studio could not shut down. The server returned HTTP ${status}. Try again.`;
  return 'Could not confirm shutdown. Studio may already be stopped. Try again, or reload after starting Studio.';
}
