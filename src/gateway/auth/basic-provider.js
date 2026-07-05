import { AuthProvider } from '../../security/auth-provider-base.js';

export class BasicAuthProvider extends AuthProvider {
  #username;
  #password;
  #authHeader;

  constructor(config, logger) {
    super();
    this.#username = config.PIWEBAPI_BASIC_USER;
    this.#password = config.PIWEBAPI_BASIC_PASSWORD_RESOLVED;
    
    const token = Buffer.from(`${this.#username}:${this.#password}`).toString('base64');
    this.#authHeader = `Basic ${token}`;
    
    logger.warn('Basic authentication enabled. Credentials will be sent over HTTPS.');
  }

  async decorate(headers) {
    headers['Authorization'] = this.#authHeader;
  }

  async healthProbe() {
    if (!this.#username || !this.#password) {
      throw new Error('Basic authentication credentials missing');
    }
    return true;
  }
}
