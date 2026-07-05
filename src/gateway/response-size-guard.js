/**
 * Enforces the maximum response size limit on a result payload.
 * If the payload exceeds maxBytes, it truncates the items or streams array
 * and marks truncated: true.
 * 
 * @param {object} result - The output result object to guard
 * @param {number} maxBytes - Maximum allowed size in bytes
 * @param {function} [pageTokenCreator] - Optional function to generate a nextPageToken based on truncated items count
 * @returns {object} The guarded (potentially truncated) result object
 */
// MCP_MAX_RESPONSE_BYTES is a byte budget, so the payload must be measured in
// UTF-8 bytes. String .length counts UTF-16 code units and undercounts any
// multi-byte character (e.g. °, accented tag names), which would let a response
// slip past the cap.
function payloadBytes(obj) {
  return Buffer.byteLength(JSON.stringify(obj), 'utf8');
}

export function enforceSizeGuard(result, maxBytes, pageTokenCreator = null) {
  if (payloadBytes(result) <= maxBytes) {
    return result;
  }

  // 1. Handle single-level collection arrays (e.g. items)
  if (Array.isArray(result.items)) {
    const originalLength = result.items.length;
    let low = 0;
    let high = originalLength;
    let bestPrefix = [];

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const testResult = {
        ...result,
        items: result.items.slice(0, mid),
        truncated: true
      };
      if (payloadBytes(testResult) <= maxBytes) {
        bestPrefix = result.items.slice(0, mid);
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    result.items = bestPrefix;
    result.truncated = true;

    if (pageTokenCreator && bestPrefix.length > 0 && bestPrefix.length < originalLength) {
      result.nextPageToken = pageTokenCreator(bestPrefix.length);
    }
    return result;
  }

  // 2. Handle multi-stream collection arrays (e.g. streams)
  if (Array.isArray(result.streams)) {
    const originalLength = result.streams.length;
    let low = 0;
    let high = originalLength;
    let bestPrefix = [];

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const testResult = {
        ...result,
        streams: result.streams.slice(0, mid),
        truncated: true
      };
      if (payloadBytes(testResult) <= maxBytes) {
        bestPrefix = result.streams.slice(0, mid);
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    result.streams = bestPrefix;
    result.truncated = true;
    return result;
  }

  // 3. Fallback: single response exceeds the cap on its own
  return {
    ...result,
    items: [],
    truncated: true,
    message: 'Response too large; payload excluded to protect token limit.'
  };
}
