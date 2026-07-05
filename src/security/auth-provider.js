import { BasicAuthProvider } from '../gateway/auth/basic-provider.js';
import { AnonymousAuthProvider } from '../gateway/auth/anonymous-provider.js';
import { BearerAuthProvider } from '../gateway/auth/bearer-provider.js';
import { KerberosAuthProvider } from '../gateway/auth/kerberos-provider.js';
import { AuthProvider } from './auth-provider-base.js';
import { AppError, ErrorCategory } from '../errors/error-model.js';

export { AuthProvider };

export function createAuthProvider(config, logger, trustProvider) {
  const mode = config.PIWEBAPI_AUTH_MODE;

  switch (mode) {
    case 'basic':
      return new BasicAuthProvider(config, logger);
    case 'anonymous':
      return new AnonymousAuthProvider(config, logger);
    case 'bearer':
      return new BearerAuthProvider(config, logger, trustProvider);
    case 'kerberos':
      return new KerberosAuthProvider(config, logger);
    default:
      throw new AppError({
        category: ErrorCategory.INTERNAL,
        retryable: false,
        message: `Unsupported authentication mode: ${mode}`
      });
  }
}
