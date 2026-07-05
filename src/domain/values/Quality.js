export class Quality {
  #good;
  #questionable;
  #substituted;
  #annotated;

  constructor({ good = true, questionable = false, substituted = false, annotated = false } = {}) {
    this.#good = Boolean(good);
    this.#questionable = Boolean(questionable);
    this.#substituted = Boolean(substituted);
    this.#annotated = Boolean(annotated);
    Object.freeze(this);
  }

  get good() {
    return this.#good;
  }

  get questionable() {
    return this.#questionable;
  }

  get substituted() {
    return this.#substituted;
  }

  get annotated() {
    return this.#annotated;
  }

  toJSON() {
    return {
      good: this.#good,
      questionable: this.#questionable,
      substituted: this.#substituted,
      annotated: this.#annotated
    };
  }
}
