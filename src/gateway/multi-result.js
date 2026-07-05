import { cleanText } from '../errors/sanitizer.js';

/**
 * PI Web API streamset (bulk) endpoints return HTTP 200 even when individual
 * streams fail; a failing item carries a top-level `Errors` array. Per
 * DEVELOPMENT_PLAN §3.3.2 / §B8-B11 these per-stream failures are surfaced as a
 * success-with-errors envelope and never silently dropped (fail loud). HTTP
 * status is the primary signal, the per-item `Errors` shape is best-effort
 * enrichment, so we tolerate its absence and never throw on an odd shape.
 */

/** @param {object} item Raw streamset response item */
export function streamItemFailed(item) {
  return Array.isArray(item?.Errors) && item.Errors.length > 0;
}

/**
 * Build the sanitized per-stream failure list for a streamset response.
 * The upstream reason is scrubbed/redacted before it can leave the process;
 * webId and name are caller-supplied identifiers and are echoed as-is.
 * @param {Array<object>} items Raw streamset response items
 * @returns {Array<{webId: string|null, name: string|null, reason: string}>}
 */
export function collectStreamFailures(items) {
  const failures = [];
  for (const item of items) {
    if (streamItemFailed(item)) {
      failures.push({
        webId: item.WebId ?? null,
        name: item.Name ?? null,
        reason: cleanText(item.Errors.join('; '))
      });
    }
  }
  return failures;
}
