import { AppError, ErrorCategory } from '../errors/error-model.js';

export function validateAuthPolicy(config) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new AppError({
      category: ErrorCategory.INTERNAL,
      retryable: false,
      message: 'NODE_TLS_REJECT_UNAUTHORIZED=0 is forbidden and rejects startup'
    });
  }

  if (config.MCP_TRANSPORT === 'http') {
    if (config.PIWEBAPI_TLS_VERIFY === false) {
      throw new AppError({
        category: ErrorCategory.INTERNAL,
        retryable: false,
        message: 'TLS verification cannot be disabled when running in HTTP transport mode'
      });
    }

    if (config.MCP_EDGE_AUTH_MODE === 'none') {
      const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(config.MCP_HTTP_BIND);
      if (!isLoopback) {
        throw new AppError({
          category: ErrorCategory.INTERNAL,
          retryable: false,
          message: "Inbound edge authentication mode cannot be 'none' unless binding to a loopback address"
        });
      }
    }
  }

  const mode = config.PIWEBAPI_AUTH_MODE;

  if (mode === 'kerberos') {
    if (!config.PIWEBAPI_KERBEROS_SPN) {
      throw new AppError({
        category: ErrorCategory.INTERNAL,
        retryable: false,
        message: "PIWEBAPI_KERBEROS_SPN is required when PIWEBAPI_AUTH_MODE is 'kerberos'"
      });
    }
  }

  if (mode === 'bearer') {
    if (!config.PIWEBAPI_BEARER_ISSUER) {
      throw new AppError({
        category: ErrorCategory.INTERNAL,
        retryable: false,
        message: "PIWEBAPI_BEARER_ISSUER is required when PIWEBAPI_AUTH_MODE is 'bearer'"
      });
    }
    if (!config.PIWEBAPI_BEARER_CLIENT_ID) {
      throw new AppError({
        category: ErrorCategory.INTERNAL,
        retryable: false,
        message: "PIWEBAPI_BEARER_CLIENT_ID is required when PIWEBAPI_AUTH_MODE is 'bearer'"
      });
    }
    if (!config.PIWEBAPI_BEARER_CLIENT_SECRET_RESOLVED) {
      throw new AppError({
        category: ErrorCategory.INTERNAL,
        retryable: false,
        message: 'Bearer client secret must be supplied and resolved'
      });
    }
  }

  if (mode === 'basic') {
    if (!config.PIWEBAPI_BASIC_USER) {
      throw new AppError({
        category: ErrorCategory.INTERNAL,
        retryable: false,
        message: "PIWEBAPI_BASIC_USER is required when PIWEBAPI_AUTH_MODE is 'basic'"
      });
    }
    if (!config.PIWEBAPI_BASIC_PASSWORD_RESOLVED) {
      throw new AppError({
        category: ErrorCategory.INTERNAL,
        retryable: false,
        message: 'Basic password must be supplied and resolved'
      });
    }
    if (!config.PIWEBAPI_BASE_URL.startsWith('https://')) {
      throw new AppError({
        category: ErrorCategory.INTERNAL,
        retryable: false,
        message: 'Basic authentication is only permitted over secure HTTPS transport'
      });
    }
  }

  if (mode === 'anonymous') {
    if (!config.PIWEBAPI_ALLOW_ANONYMOUS) {
      throw new AppError({
        category: ErrorCategory.INTERNAL,
        retryable: false,
        message: "PIWEBAPI_ALLOW_ANONYMOUS must be explicitly true when PIWEBAPI_AUTH_MODE is 'anonymous'"
      });
    }
    if (!config.MCP_READ_ONLY) {
      throw new AppError({
        category: ErrorCategory.INTERNAL,
        retryable: false,
        message: "MCP_READ_ONLY must be true when PIWEBAPI_AUTH_MODE is 'anonymous'"
      });
    }
  }

  if (config.MCP_WRITE_TOOLS_ENABLED) {
    if (config.MCP_READ_ONLY) {
      throw new AppError({
        category: ErrorCategory.INTERNAL,
        retryable: false,
        message: 'Cannot enable write tools when MCP_READ_ONLY is set to true'
      });
    }
    if (config.MCP_TRANSPORT === 'http') {
      if (config.MCP_EDGE_AUTH_MODE === 'none') {
        throw new AppError({
          category: ErrorCategory.INTERNAL,
          retryable: false,
          message: 'Edge authentication is required to enable write tools over HTTP transport'
        });
      }
      if (!config.MCP_EDGE_WRITE_ROLES || config.MCP_EDGE_WRITE_ROLES.trim() === '') {
        throw new AppError({
          category: ErrorCategory.INTERNAL,
          retryable: false,
          message: 'MCP_EDGE_WRITE_ROLES must be specified to enable write tools over HTTP transport'
        });
      }
    }
  }

  return true;
}
