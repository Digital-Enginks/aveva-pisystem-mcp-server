export class WebId {
  #value;

  constructor(value) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new TypeError('WebId must be a non-empty string');
    }
    // WebID 2.0 identifiers are alphanumeric, URL-safe base64, usually starting with W1 or similar prefixes
    if (!/^[a-zA-Z0-9_\-]+$/.test(value)) {
      throw new Error('WebId must be a URL-safe Base64 encoded string');
    }
    this.#value = value;
    Object.freeze(this);
  }

  toString() {
    return this.#value;
  }

  get value() {
    return this.#value;
  }

  equals(other) {
    return other instanceof WebId && this.#value === other.value;
  }
}
