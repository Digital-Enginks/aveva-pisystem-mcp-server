import { LruCache } from './lru-cache.js';

export class WebIdCache extends LruCache {
  static buildKey(baseUrl, path, webIdType) {
    // Normalise inputs so equivalent paths map to the same cache entry.
    const cleanUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
    const cleanPath = String(path || '').trim().toLowerCase();
    const cleanType = String(webIdType || 'IDOnly').trim();
    return `${cleanUrl}:${cleanPath}:${cleanType}`;
  }
}
