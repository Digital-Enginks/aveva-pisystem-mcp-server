import process from 'node:process';
import { AuthProvider } from '../../security/auth-provider-base.js';
import { AppError, ErrorCategory } from '../../errors/error-model.js';

// The `kerberos` package is a native addon; loading it eagerly crashes
// deployments (e.g. Linux containers) that run in basic/bearer/anonymous mode
// without the addon installed. Load it lazily, only when kerberos auth is used.
let kerberosModule = null;

export function overrideKerberos(mockKerberos) {
  kerberosModule = mockKerberos;
}

async function loadKerberos() {
  if (!kerberosModule) {
    kerberosModule = (await import('kerberos')).default;
  }
  return kerberosModule;
}

export class KerberosAuthProvider extends AuthProvider {
  #config;
  #logger;
  #spn;

  constructor(config, logger) {
    super();
    this.#config = config;
    this.#logger = logger;
    this.#spn = config.PIWEBAPI_KERBEROS_SPN;

    // Apply Kerberos realm/keytab environment overrides for MIT GSSAPI
    if (config.KRB5_CONFIG) {
      process.env.KRB5_CONFIG = config.KRB5_CONFIG;
    }
    if (config.KRB5_CLIENT_KTNAME) {
      process.env.KRB5_CLIENT_KTNAME = config.KRB5_CLIENT_KTNAME;
    }
  }

  async decorate(headers) {
    // Standard Kerberos SPNEGO loop starts with no Authorization header (or uses faked ticket if pre-negotiated)
    // to trigger the 401 Challenge on the target connection.
  }

  async createNegotiateHeader(wwwAuthHeader, existingClient = null) {
    let serverToken = '';
    if (wwwAuthHeader) {
      const parts = wwwAuthHeader.trim().split(/\s+/);
      if (parts.length > 1 && parts[0].toLowerCase() === 'negotiate') {
        serverToken = parts[1];
      }
    }

    try {
      let client = existingClient;
      if (!client) {
        this.#logger.debug('Initializing Kerberos client', { spn: this.#spn });
        const krb = await loadKerberos();
        client = await krb.initializeClient(this.#spn);
      }

      this.#logger.debug('Generating Kerberos SPNEGO step token');
      const stepResponse = await client.step(serverToken);
      
      return {
        headerValue: `Negotiate ${stepResponse}`,
        client,
        isComplete: client.complete
      };
    } catch (err) {
      throw new AppError({
        category: ErrorCategory.UNAUTHORIZED,
        retryable: false,
        message: `Kerberos ticket generation failed: ${err.message}`
      });
    }
  }

  async healthProbe() {
    if (!this.#spn) {
      throw new Error('Kerberos SPN config missing');
    }
    
    try {
      this.#logger.debug('Kerberos health probe: initializing test client', { spn: this.#spn });
      const krb = await loadKerberos();
      const client = await krb.initializeClient(this.#spn);
      if (!client) {
        throw new Error('Failed to initialize Kerberos client instance');
      }
      return true;
    } catch (err) {
      throw new AppError({
        category: ErrorCategory.INTERNAL,
        retryable: false,
        message: `Kerberos health probe failed: ${err.message}`
      });
    }
  }
}
