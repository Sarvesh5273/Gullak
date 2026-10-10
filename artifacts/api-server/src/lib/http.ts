import type { NextFunction, Request, Response } from "express";
import type { Address } from "viem";

export function sendError(res: Response, status: number, code: string, error: string): void {
  res.status(status).json({ error, code });
}

type Bucket = { count: number; resetAt: number };

/**
 * Fixed-window, in-memory rate limiter. Adequate for a single instance; each
 * limiter keeps at most `maxKeys` buckets and sweeps expired ones.
 */
export function rateLimit(options: {
  name: string;
  limit: number;
  windowMs: number;
  key: (req: Request, res: Response) => string | null;
  maxKeys?: number;
}) {
  const buckets = new Map<string, Bucket>();
  const maxKeys = options.maxKeys ?? 20_000;
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, options.windowMs);
  sweep.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = options.key(req, res);
    if (!key) {
      next();
      return;
    }
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (buckets.size >= maxKeys) buckets.clear();
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > options.limit) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      req.log.warn({ limiter: options.name }, "Rate limited");
      sendError(res, 429, "rate_limited", `Too many requests. Try again in ${retryAfter}s.`);
      return;
    }
    next();
  };
}

export const byIp = (req: Request): string => req.ip ?? "unknown";
export const byAccount = (_req: Request, res: Response): string | null =>
  (res.locals["address"] as Address | undefined) ?? null;

/** Postgres unique-violation check (drizzle wraps the pg error as `cause`). */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}
