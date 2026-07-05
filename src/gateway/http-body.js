const DEFAULT_LIMIT = 4096;

/**
 * Reads an error response body up to a byte cap and discards the rest.
 *
 * Error bodies are only ever used for diagnostics, so an upstream that returns
 * a multi-megabyte HTML page or stack dump must not be buffered whole into a
 * string. We stop after `limit` bytes and abandon the stream, which lets undici
 * release the connection.
 *
 * @param {object} body - An undici response body (async-iterable).
 * @param {number} [limit] - Maximum number of bytes to retain.
 * @returns {Promise<string>} The captured (possibly truncated) text.
 */
export async function readErrorBody(body, limit = DEFAULT_LIMIT) {
  if (!body) return '';

  let text = '';
  let bytes = 0;
  try {
    for await (const chunk of body) {
      bytes += chunk.length;
      text += chunk.toString('utf8');
      if (bytes >= limit) {
        text = text.slice(0, limit) + '... (truncated)';
        break;
      }
    }
  } catch {
    // A body that cannot be read in full still yields whatever we captured.
  }
  return text;
}
