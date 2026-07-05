import crypto from 'node:crypto';

export class Paging {
  #startIndex;
  #pageSize;
  #queryHash;
  #cursor;

  constructor({ startIndex = 0, pageSize = 100, queryHash = '', cursor = null } = {}) {
    const parsedIndex = parseInt(startIndex, 10);
    this.#startIndex = Number.isFinite(parsedIndex) ? Math.max(0, parsedIndex) : 0;
    // Tokens are forgeable (hash is not an HMAC), so clamp pageSize server-side.
    const parsedSize = parseInt(pageSize, 10);
    this.#pageSize = Number.isFinite(parsedSize) ? Math.min(1000, Math.max(1, parsedSize)) : 100;
    this.#queryHash = queryHash;
    this.#cursor = typeof cursor === 'string' && cursor.length > 0 ? cursor : null;
    Object.freeze(this);
  }

  get startIndex() {
    return this.#startIndex;
  }

  get pageSize() {
    return this.#pageSize;
  }

  get queryHash() {
    return this.#queryHash;
  }

  get cursor() {
    return this.#cursor;
  }

  static generateQueryHash(queryParams) {
    const serialized = JSON.stringify(queryParams || {});
    return crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 16);
  }

  static parseToken(token, expectedQueryHash) {
    if (!token) {
      return new Paging({ startIndex: 0, queryHash: expectedQueryHash });
    }

    try {
      const decoded = Buffer.from(token, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      
      if (expectedQueryHash && parsed.queryHash !== expectedQueryHash) {
        throw new Error('Paging token query hash mismatch');
      }

      return new Paging({
        startIndex: parsed.startIndex,
        pageSize: parsed.pageSize,
        queryHash: parsed.queryHash,
        cursor: parsed.cursor
      });
    } catch (err) {
      throw new Error(`Invalid pagination token: ${err.message}`);
    }
  }

  toToken() {
    const payload = {
      startIndex: this.#startIndex,
      pageSize: this.#pageSize,
      queryHash: this.#queryHash
    };
    if (this.#cursor !== null) {
      payload.cursor = this.#cursor;
    }
    return Buffer.from(JSON.stringify(payload)).toString('base64');
  }

  next(itemsReturned) {
    return new Paging({
      startIndex: this.#startIndex + itemsReturned,
      pageSize: this.#pageSize,
      queryHash: this.#queryHash
    });
  }

  // Time-cursor pagination for endpoints without startIndex (GetRecorded):
  // the cursor is the raw PI timestamp of the last item already returned.
  nextWithCursor(cursor) {
    return new Paging({
      startIndex: this.#startIndex,
      pageSize: this.#pageSize,
      queryHash: this.#queryHash,
      cursor
    });
  }
}
