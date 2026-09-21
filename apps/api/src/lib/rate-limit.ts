/**
 * Redis-backed counter for login rate limiting.
 *
 * Pattern: INCR a key on each attempt; if the result is 1 (first hit),
 * set the TTL to the window. Once the counter exceeds `max`, the call is
 * rejected until the window expires.
 *
 * The key namespacing is `login_attempts:<email-lowercased>` so two
 * different users on the same IP don't share a budget.
 */
export interface RedisLike {
  incr(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<number>;
  /** Optional: returns remaining TTL in seconds. -1 if no TTL, -2 if missing. */
  ttl?(key: string): Promise<number>;
  del(key: string): Promise<number>;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export async function hitLoginRateLimit(
  redis: RedisLike,
  email: string,
  max: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const key = `login_attempts:${email.toLowerCase()}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  if (count > max) {
    let retryAfterSeconds = windowSeconds;
    if (typeof redis.ttl === 'function') {
      const ttl = await redis.ttl(key);
      if (ttl > 0) retryAfterSeconds = ttl;
    }
    return { ok: false, remaining: 0, retryAfterSeconds };
  }
  return { ok: true, remaining: max - count, retryAfterSeconds: 0 };
}

export async function resetLoginRateLimit(redis: RedisLike, email: string): Promise<void> {
  await redis.del(`login_attempts:${email.toLowerCase()}`);
}
