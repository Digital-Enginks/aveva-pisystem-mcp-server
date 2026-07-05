export class LoggerPort {
  trace(msg, ...args) {
    throw new Error('Method not implemented: trace');
  }

  debug(msg, ...args) {
    throw new Error('Method not implemented: debug');
  }

  info(msg, ...args) {
    throw new Error('Method not implemented: info');
  }

  warn(msg, ...args) {
    throw new Error('Method not implemented: warn');
  }

  error(msg, ...args) {
    throw new Error('Method not implemented: error');
  }

  fatal(msg, ...args) {
    throw new Error('Method not implemented: fatal');
  }

  child(bindings) {
    throw new Error('Method not implemented: child');
  }
}
