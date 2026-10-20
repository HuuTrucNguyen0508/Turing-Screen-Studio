import { describe, expect, it } from 'vitest';
import { shutdownFailure } from './shutdown';

describe('shutdown failures', () => {
  it('explains the loopback restriction for a rejected request', () => {
    expect(shutdownFailure(403)).toContain('localhost or 127.0.0.1');
  });
  it('keeps the HTTP status for server failures', () => {
    expect(shutdownFailure(500)).toContain('HTTP 500');
  });
  it('does not claim the server is running after a lost response', () => {
    expect(shutdownFailure(null)).toContain('may already be stopped');
  });
});
