function abortError(signal) {
  if (signal && signal.reason instanceof Error) {
    return signal.reason;
  }
  return new DOMException('The operation was aborted', 'AbortError');
}

export class Semaphore {
  #capacity;
  #current;
  #queue;

  constructor(capacity) {
    this.#capacity = capacity > 0 ? capacity : 1;
    this.#current = 0;
    this.#queue = [];
  }

  get capacity() {
    return this.#capacity;
  }

  setCapacity(newCapacity) {
    this.#capacity = newCapacity > 0 ? newCapacity : 1;
    this.#dispatch();
  }

  /**
   * Acquires a slot, queueing if none are free. When a signal is supplied and
   * fires while the caller is still queued, the waiter is removed from the
   * queue and the promise rejects with an AbortError, so abandoned requests
   * never occupy a slot once one frees up.
   *
   * @param {AbortSignal} [signal]
   */
  async acquire(signal) {
    if (signal?.aborted) {
      throw abortError(signal);
    }

    if (this.#current < this.#capacity) {
      this.#current++;
      return;
    }

    return new Promise((resolve, reject) => {
      const waiter = { resolve, signal: null, onAbort: null };

      if (signal) {
        waiter.onAbort = () => {
          const idx = this.#queue.indexOf(waiter);
          if (idx !== -1) {
            this.#queue.splice(idx, 1);
          }
          reject(abortError(signal));
        };
        waiter.signal = signal;
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }

      this.#queue.push(waiter);
    });
  }

  release() {
    if (this.#current > 0) {
      this.#current--;
    }
    this.#dispatch();
  }

  #dispatch() {
    while (this.#queue.length > 0 && this.#current < this.#capacity) {
      this.#current++;
      const waiter = this.#queue.shift();
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.resolve();
    }
  }
}
