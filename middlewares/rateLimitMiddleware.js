import AppError from '../utils/AppError.js';

const buckets = new Map();
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastSweepAt = Date.now();

const getClientKey = (req, keyPrefix) => {
  const forwardedFor = req.headers['x-forwarded-for'];
  const forwardedIp = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : forwardedFor?.split(',')[0];
  const ip = forwardedIp?.trim() || req.ip || req.socket?.remoteAddress || 'unknown';

  return `${keyPrefix}:${ip}:${req.path}`;
};

const sweepExpiredBuckets = (now) => {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) {
    return;
  }

  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }

  lastSweepAt = now;
};

export const createRateLimiter = ({
  windowMs = 15 * 60 * 1000,
  maxRequests = 20,
  keyPrefix = 'rate-limit',
  message = 'Too many requests. Please try again later.',
} = {}) => (req, res, next) => {
  const now = Date.now();
  sweepExpiredBuckets(now);

  const key = getClientKey(req, keyPrefix);
  const currentBucket = buckets.get(key);

  if (!currentBucket || currentBucket.resetAt <= now) {
    buckets.set(key, {
      count: 1,
      resetAt: now + windowMs,
    });
    return next();
  }

  currentBucket.count += 1;

  if (currentBucket.count > maxRequests) {
    const retryAfterSeconds = Math.ceil((currentBucket.resetAt - now) / 1000);
    res.set('Retry-After', String(retryAfterSeconds));
    return next(new AppError(message, 429));
  }

  return next();
};

export const authRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 30,
  keyPrefix: 'auth',
  message: 'Too many authentication attempts. Please try again after some time.',
});

export const passwordResetRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 6,
  keyPrefix: 'password-reset',
  message: 'Too many password reset attempts. Please try again after some time.',
});
