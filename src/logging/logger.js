import pino from 'pino';

const defaultRedactPaths = [
  'headers.authorization',
  'headers.Authorization',
  'headers.cookie',
  'headers.Cookie',
  'headers["proxy-authorization"]',
  'headers["Proxy-Authorization"]',
  'req.headers.authorization',
  'req.headers.Authorization',
  'req.headers.cookie',
  'req.headers.Cookie',
  'req.headers["proxy-authorization"]',
  'req.headers["Proxy-Authorization"]',
  'password',
  'Password',
  'secret',
  'Secret',
  'token',
  'Token',
  'credential',
  'Credential',
  'client_secret',
  'clientSecret',
  'PIWEBAPI_BASIC_PASSWORD',
  'PIWEBAPI_BASIC_PASSWORD_RESOLVED',
  'PIWEBAPI_BEARER_CLIENT_SECRET',
  'PIWEBAPI_BEARER_CLIENT_SECRET_RESOLVED'
];

export function createLogger(config) {
  const level = config.MCP_LOG_LEVEL || 'info';
  const extraRedact = config.MCP_LOG_REDACT_EXTRA 
    ? config.MCP_LOG_REDACT_EXTRA.split(',').map(s => s.trim()) 
    : [];

  const redactPaths = [...new Set([...defaultRedactPaths, ...extraRedact])];

  return pino({
    level,
    redact: {
      paths: redactPaths,
      censor: '[REDACTED]'
    }
  }, pino.destination(2)); // Force stderr (file descriptor 2)
}
