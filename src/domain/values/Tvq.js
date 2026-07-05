import { Quality } from './Quality.js';

export class Tvq {
  #timestamp;
  #value;
  #valueKind;
  #unitsAbbreviation;
  #quality;

  constructor({ timestamp, value, unitsAbbreviation = null, quality }) {
    if (!timestamp || isNaN(Date.parse(timestamp))) {
      throw new Error('Tvq must have a valid timestamp');
    }
    if (!(quality instanceof Quality)) {
      throw new TypeError('Tvq quality must be an instance of Quality');
    }

    this.#timestamp = new Date(timestamp).toISOString();
    this.#unitsAbbreviation = unitsAbbreviation;
    this.#quality = quality;

    // Discriminate the value kind
    if (typeof value === 'number') {
      this.#value = value;
      this.#valueKind = 'numeric';
    } else if (typeof value === 'string') {
      this.#value = value;
      this.#valueKind = 'string';
    } else if (value !== null && typeof value === 'object') {
      if (value.isSystem === true) {
        this.#value = {
          name: value.name,
          value: value.value,
          isSystem: true
        };
        this.#valueKind = 'systemState';
        // Enforce the coupling rule: system state implies good=false
        if (quality.good) {
          this.#quality = new Quality({
            good: false,
            questionable: quality.questionable,
            substituted: quality.substituted,
            annotated: quality.annotated
          });
        }
      } else {
        this.#value = {
          name: value.name,
          value: value.value,
          isSystem: false
        };
        this.#valueKind = 'digitalState';
      }
    } else {
      this.#value = value;
      this.#valueKind = 'string'; // Fallback
    }

    Object.freeze(this);
  }

  get timestamp() {
    return this.#timestamp;
  }

  get value() {
    return this.#value;
  }

  get valueKind() {
    return this.#valueKind;
  }

  get unitsAbbreviation() {
    return this.#unitsAbbreviation;
  }

  get quality() {
    return this.#quality;
  }

  toJSON() {
    return {
      timestamp: this.#timestamp,
      value: this.#value,
      valueKind: this.#valueKind,
      unitsAbbreviation: this.#unitsAbbreviation,
      good: this.#quality.good,
      questionable: this.#quality.questionable,
      substituted: this.#quality.substituted,
      annotated: this.#quality.annotated
    };
  }
}
