import { AuthProvider } from '../../security/auth-provider-base.js';

export class AnonymousAuthProvider extends AuthProvider {
  constructor(config, logger) {
    super();
    logger.warn('Anonymous authentication enabled. Access will be determined by server guest/host accounts.');
  }

  async decorate(headers) {
    // No-op: Anonymous does not send credentials
  }

  async healthProbe() {
    return true;
  }
}
