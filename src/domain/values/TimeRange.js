const refTimePattern = '^(?:\\*|t|y|now|sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)';
const offsetPattern = '(?:[-+]\\d+(?:\\.\\d+)?(?:ms|s|m|h|d|w|mo|y))';
const relativeTimeRegex = new RegExp(`${refTimePattern}(?:${offsetPattern})*$|^${offsetPattern}+$`, 'i');

export class TimeRange {
  #startTime;
  #endTime;

  constructor(startTime = '*-1d', endTime = '*') {
    this.#startTime = this.#validateTime(startTime, 'startTime');
    this.#endTime = this.#validateTime(endTime, 'endTime');
    Object.freeze(this);
  }

  #validateTime(val, fieldName) {
    if (typeof val !== 'string' || val.trim() === '') {
      throw new TypeError(`${fieldName} must be a non-empty string`);
    }

    const trimmed = val.trim();
    
    // Check if it is a relative PI time syntax
    if (relativeTimeRegex.test(trimmed)) {
      return trimmed;
    }

    // Check if it parses as a standard JS Date (absolute time)
    const timestamp = Date.parse(trimmed);
    if (isNaN(timestamp)) {
      throw new Error(`Invalid time format for ${fieldName}: "${trimmed}"`);
    }

    return new Date(timestamp).toISOString();
  }

  get startTime() {
    return this.#startTime;
  }

  get endTime() {
    return this.#endTime;
  }

  toString() {
    return `[${this.#startTime} to ${this.#endTime}]`;
  }
}
