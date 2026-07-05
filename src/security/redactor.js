export function scrub(value) {
  return scrubInternal(value, new WeakSet());
}

function scrubInternal(value, visited) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    let scrubbed = value;

    // 1. Authorization headers (Basic, Bearer, Negotiate)
    scrubbed = scrubbed.replace(/(authorization|proxy-authorization)\s*[:=]\s*["']?(bearer|basic|negotiate)\s+[a-zA-Z0-9._~+/-]+=*["']?/gi, '$1=[REDACTED]');

    // 2. Standalone auth tokens or blobs (Bearer, Basic, Negotiate)
    scrubbed = scrubbed.replace(/(bearer|basic|negotiate)\s+[a-zA-Z0-9._~+/-]{15,}=*/gi, '[REDACTED]');

    // 3. JWT tokens
    scrubbed = scrubbed.replace(/eyJ[a-zA-Z0-9-_]+\.eyJ[a-zA-Z0-9-_]+\.[a-zA-Z0-9-_]+/gi, '[REDACTED]');

    // 4. Kerberos SPNs (HTTP/host.domain); the leading letter avoids matching
    //    protocol version tokens such as "HTTP/1.1" or "HTTP/2" in log lines.
    scrubbed = scrubbed.replace(/HTTP\/[a-zA-Z][a-zA-Z0-9.-]*/gi, '[REDACTED]');

    // 5. Key-value password/secret assignments
    scrubbed = scrubbed.replace(/(password|secret|token|credential|client_secret|pass|key)\s*[:=]\s*["']?([^"'\s&,;]{4,})["']?/gi, '$1=[REDACTED]');

    return scrubbed;
  }

  if (typeof value === 'object') {
    if (visited.has(value)) {
      return '[CIRCULAR_REFERENCE]';
    }
    visited.add(value);
  }

  if (value instanceof Error) {
    const scrubbedMessage = scrubInternal(value.message, visited);
    const scrubbedStack = value.stack ? scrubInternal(value.stack, visited) : undefined;
    
    const scrubbedError = new Error(scrubbedMessage);
    if (scrubbedStack) {
      scrubbedError.stack = scrubbedStack;
    }
    return scrubbedError;
  }

  if (Array.isArray(value)) {
    return value.map(item => scrubInternal(item, visited));
  }

  if (typeof value === 'object') {
    const scrubbedObj = {};
    for (const [key, val] of Object.entries(value)) {
      const lowerKey = key.toLowerCase();
      if (['password', 'secret', 'token', 'credential', 'authorization', 'cookie'].some(s => lowerKey.includes(s))) {
        scrubbedObj[key] = '[REDACTED]';
      } else {
        scrubbedObj[key] = scrubInternal(val, visited);
      }
    }
    return scrubbedObj;
  }

  return value;
}
