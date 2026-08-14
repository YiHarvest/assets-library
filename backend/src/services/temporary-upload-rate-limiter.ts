export type RateLimitDimension = "ip" | "user";

export class TemporaryUploadRateLimitError extends Error {
  constructor(public readonly dimension: RateLimitDimension) {
    super(`临时上传${dimension === "ip" ? "来源IP" : "用户"}请求速率超过限制。`);
    this.name = "TemporaryUploadRateLimitError";
  }
}

interface Bucket { startedAt: number; count: number }

/** IP与user HMAC使用完全独立的桶，轮换user_id不能绕过IP上限。 */
export class TemporaryUploadRateLimiter {
  private readonly ipBuckets = new Map<string, Bucket>();
  private readonly userBuckets = new Map<string, Bucket>();

  constructor(
    private readonly ipLimit: number,
    private readonly userLimit: number,
    private readonly maximumKeys = 10_000,
  ) {}

  consume(ip: string, userHash: string, now = Date.now()) {
    this.consumeIp(ip, now);
    this.consumeUser(userHash, now);
  }

  consumeIp(ip: string, now = Date.now()) {
    this.consumeBucket(this.ipBuckets, ip, this.ipLimit, "ip", now);
  }

  consumeUser(userHash: string, now = Date.now()) {
    this.consumeBucket(this.userBuckets, userHash, this.userLimit, "user", now);
  }

  private consumeBucket(buckets: Map<string, Bucket>, key: string, limit: number, dimension: RateLimitDimension, now: number) {
    this.prune(buckets, now);
    const bucket = this.bucket(buckets, key, now);
    if (bucket.count >= limit) throw new TemporaryUploadRateLimitError(dimension);
    bucket.count += 1;
  }

  private bucket(buckets: Map<string, Bucket>, key: string, now: number) {
    const current = buckets.get(key);
    if (current) return current;
    if (buckets.size >= this.maximumKeys) {
      const oldest = [...buckets].sort((left, right) => left[1].startedAt - right[1].startedAt)[0];
      if (oldest) buckets.delete(oldest[0]);
    }
    const created = { startedAt: now, count: 0 };
    buckets.set(key, created);
    return created;
  }

  private prune(buckets: Map<string, Bucket>, now: number) {
    for (const [key, value] of buckets) if (now - value.startedAt >= 60_000) buckets.delete(key);
  }
}
