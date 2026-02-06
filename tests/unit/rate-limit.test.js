import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _enforceRateLimit, _rateLimitTimestamps } from '../../src/utils/ai-bundle.js';

describe('rate limiter', () => {
  beforeEach(() => {
    _rateLimitTimestamps.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests within the 10-per-minute limit', async () => {
    for (let i = 0; i < 10; i++) {
      await _enforceRateLimit();
    }
    expect(_rateLimitTimestamps).toHaveLength(10);
  });

  it('delays the 11th request until the window expires', async () => {
    // Fill the window with 10 requests
    for (let i = 0; i < 10; i++) {
      await _enforceRateLimit();
    }

    // Start the 11th request — should block
    let resolved = false;
    const promise = _enforceRateLimit().then(() => { resolved = true; });

    // Flush microtasks — should still be blocked
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);

    // Advance past the 60-second window
    await vi.advanceTimersByTimeAsync(60_000);
    await promise;

    expect(resolved).toBe(true);
  });

  it('cleans up old timestamps after waiting', async () => {
    for (let i = 0; i < 10; i++) {
      await _enforceRateLimit();
    }

    // Advance past window, then make a new request
    await vi.advanceTimersByTimeAsync(61_000);
    await _enforceRateLimit();

    // Old timestamps should have been purged; only the new one remains
    expect(_rateLimitTimestamps.length).toBe(1);
  });
});
