export class TagPath {
  #server;
  #path;
  #isAf;

  constructor(value) {
    if (typeof value !== 'string' || !value.startsWith('\\\\')) {
      throw new Error('TagPath must start with double backslashes (\\\\)');
    }
    
    // Normalize path by replacing forward slashes if any (though usually backslashes are standard)
    const normalized = value.replace(/\//g, '\\');
    const parts = normalized.slice(2).split('\\').filter(Boolean);
    
    if (parts.length < 2) {
      throw new Error('TagPath must contain at least a server name and a resource path');
    }

    this.#server = parts[0];
    this.#path = normalized;
    // If it contains a database partition (typically 3+ parts or pipe symbol |), it is AF
    this.#isAf = normalized.includes('|') || parts.length > 2;
    Object.freeze(this);
  }

  get server() {
    return this.#server;
  }

  get path() {
    return this.#path;
  }

  get isAf() {
    return this.#isAf;
  }

  toString() {
    return this.#path;
  }

  equals(other) {
    return other instanceof TagPath && this.#path === other.path;
  }
}
