/**
 * Map-backed cache with LRU eviction and per-entry TTL. Insertion order in a
 * Map doubles as recency order: a read re-inserts the entry to mark it as most
 * recently used, and eviction drops the first (oldest) key.
 */
export class LruCache {
  #maxSize;
  #ttlMs;
  #cache;

  constructor(maxSize, ttlSec) {
    this.#maxSize = maxSize > 0 ? maxSize : 1000;
    this.#ttlMs = (ttlSec >= 0 ? ttlSec : 300) * 1000;
    this.#cache = new Map();
  }

  get(key) {
    const entry = this.#cache.get(key);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.#ttlMs) {
      this.#cache.delete(key);
      return null;
    }

    this.#cache.delete(key);
    this.#cache.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.#cache.has(key)) {
      this.#cache.delete(key);
    } else if (this.#cache.size >= this.#maxSize) {
      const oldestKey = this.#cache.keys().next().value;
      this.#cache.delete(oldestKey);
    }
    this.#cache.set(key, { value, timestamp: Date.now() });
  }

  delete(key) {
    this.#cache.delete(key);
  }

  clear() {
    this.#cache.clear();
  }

  get size() {
    return this.#cache.size;
  }
}
