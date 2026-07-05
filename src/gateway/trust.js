import fs from 'node:fs';
import tls from 'node:tls';
import crypto from 'node:crypto';
import process from 'node:process';
import { AppError, ErrorCategory } from '../errors/error-model.js';

export class TrustProvider {
  #config;
  #logger;
  #tlsOptions;

  constructor(config, logger) {
    this.#config = config;
    this.#logger = logger;
    this.#tlsOptions = null;
    
    this.buildTlsOptions();

    if (this.#config.PIWEBAPI_TLS_CA_RELOAD) {
      process.on('SIGHUP', () => {
        this.#logger.info('SIGHUP received, rebuilding TLS trust bundle');
        try {
          this.buildTlsOptions();
        } catch (err) {
          this.#logger.error('Failed to rebuild TLS trust bundle on SIGHUP', { error: err.message });
        }
      });
    }
  }

  buildTlsOptions() {
    // With rejectUnauthorized=false Node never invokes checkServerIdentity,
    // so a configured pin would be silently ignored. Refuse the combination.
    if (this.#config.PIWEBAPI_TLS_PIN_SHA256 && this.#config.PIWEBAPI_TLS_VERIFY === false) {
      throw new AppError({
        category: ErrorCategory.INTERNAL,
        retryable: false,
        message: 'PIWEBAPI_TLS_PIN_SHA256 requires PIWEBAPI_TLS_VERIFY=true: the pin is never checked when TLS verification is disabled'
      });
    }

    const caBundle = [...tls.rootCertificates];

    if (this.#config.PIWEBAPI_TLS_CA_FILE) {
      try {
        const fileContent = fs.readFileSync(this.#config.PIWEBAPI_TLS_CA_FILE, 'utf8');
        // tls accepts a single PEM string holding multiple concatenated certs.
        caBundle.push(fileContent);
        const count = (fileContent.match(/-----BEGIN CERTIFICATE-----/g) || []).length;
        this.#logger.info(`Loaded ${count} certificate(s) from ${this.#config.PIWEBAPI_TLS_CA_FILE}`);
      } catch (err) {
        throw new AppError({
          category: ErrorCategory.INTERNAL,
          retryable: false,
          message: `Failed to load TLS CA file: ${err.message}`
        });
      }
    }

    const checkServerIdentity = (servername, cert) => {
      const hostnameErr = tls.checkServerIdentity(servername, cert);
      if (hostnameErr) {
        return hostnameErr;
      }

      if (this.#config.PIWEBAPI_TLS_PIN_SHA256) {
        const fingerprint = crypto
          .createHash('sha256')
          .update(cert.raw)
          .digest('hex');
        
        if (fingerprint.toLowerCase() !== this.#config.PIWEBAPI_TLS_PIN_SHA256.toLowerCase()) {
          this.#logger.error('Certificate pinning verification failed', {
            expected: this.#config.PIWEBAPI_TLS_PIN_SHA256,
            actual: fingerprint
          });
          return new Error('Certificate pinning verification failed: Fingerprint mismatch');
        }
      }
      return undefined;
    };

    this.#tlsOptions = {
      ca: caBundle,
      minVersion: this.#config.PIWEBAPI_TLS_MIN_VERSION || 'TLSv1.2',
      rejectUnauthorized: this.#config.PIWEBAPI_TLS_VERIFY !== false
    };

    if (this.#config.PIWEBAPI_CLIENT_CERT_FILE) {
      try {
        this.#tlsOptions.cert = fs.readFileSync(this.#config.PIWEBAPI_CLIENT_CERT_FILE, 'utf8');
      } catch (err) {
        throw new AppError({
          category: ErrorCategory.INTERNAL,
          retryable: false,
          message: `Failed to load TLS client cert file: ${err.message}`
        });
      }
    }

    if (this.#config.PIWEBAPI_CLIENT_CERT_KEY_RESOLVED) {
      this.#tlsOptions.key = this.#config.PIWEBAPI_CLIENT_CERT_KEY_RESOLVED;
    }

    if (this.#config.PIWEBAPI_TLS_SERVERNAME) {
      this.#tlsOptions.servername = this.#config.PIWEBAPI_TLS_SERVERNAME;
    }

    if (this.#config.PIWEBAPI_TLS_PIN_SHA256 || this.#config.PIWEBAPI_TLS_SERVERNAME) {
      this.#tlsOptions.checkServerIdentity = (host, cert) => checkServerIdentity(this.#config.PIWEBAPI_TLS_SERVERNAME || host, cert);
    }
  }

  getTlsOptions() {
    return this.#tlsOptions;
  }
}
