import { LruCache } from './lru-cache.js';

/**
 * Caches resolved point/attribute metadata. Entries are handed out by
 * reference and shared across all callers, so the cache stores a frozen
 * shallow copy: a consumer that mutates a metadata object it read cannot
 * poison the shared entry for everyone else.
 *
 * NOTE: keys are the WebID alone (no caller identity). That is correct only
 * because the gateway authenticates to PI Web API with a single configured
 * service identity — metadata is identical for every MCP edge caller. If
 * per-caller upstream delegation/impersonation is ever introduced, this cache
 * (and WebIdCache) MUST incorporate the caller identity into the key.
 */
export class MetadataCache extends LruCache {
  set(key, value) {
    const stored = (value && typeof value === 'object')
      ? Object.freeze({ ...value })
      : value;
    super.set(key, stored);
  }
}
