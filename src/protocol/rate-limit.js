import { AppError, ErrorCategory } from '../errors/error-model.js';

export class EdgeRateLimiter {
  #limit;
  #windowMs;
  #callers;

  constructor(limit = 100, windowMs = 1000) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#callers = new Map();
  }

  checkLimit(callerId) {
    if (!this.#limit) return;

    const now = Date.now();

    // Prevent memory exhaustion DoS by capping map size
    if (this.#callers.size >= 10000 && !this.#callers.has(callerId)) {
      this.cleanup();
      if (this.#callers.size >= 10000) {
        throw new AppError({
          category: ErrorCategory.RATE_LIMITED,
          retryable: true,
          message: 'Server rate limits capacity exceeded. Please try again later.'
        });
      }
    }

    let timestamps = this.#callers.get(callerId) || [];
    
    // Filter timestamps outside current window
    timestamps = timestamps.filter(t => now - t < this.#windowMs);
    
    if (timestamps.length >= this.#limit) {
      throw new AppError({
        category: ErrorCategory.RATE_LIMITED,
        retryable: true,
        message: 'Too many requests. Please slow down.'
      });
    }

    timestamps.push(now);
    this.#callers.set(callerId, timestamps);
  }

  // Bounded memory cleanup
  cleanup() {
    const now = Date.now();
    for (const [callerId, timestamps] of this.#callers.entries()) {
      const active = timestamps.filter(t => now - t < this.#windowMs);
      if (active.length === 0) {
        this.#callers.delete(callerId);
      } else {
        this.#callers.set(callerId, active);
      }
    }
  }
}
