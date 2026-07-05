import { z } from 'zod';

const envBooleanSchema = z.preprocess(val => {
  if (typeof val === 'string') {
    const lower = val.toLowerCase().trim();
    if (lower === 'true' || lower === '1') return true;
    if (lower === 'false' || lower === '0') return false;
  }
  return val;
}, z.coerce.boolean());

const secretSchema = z.object({
  value: z.string().optional(),
  file: z.string().optional(),
  ref: z.string().optional()
}).refine(data => {
  const present = [data.value, data.file, data.ref].filter(v => v !== undefined && v !== '').length;
  return present === 1;
}, {
  message: "Exactly one of direct value, _FILE, or _REF must be supplied for secrets"
});

export const configObjectSchema = z.object({
  PIWEBAPI_BASE_URL: z.string().url().refine(val => {
    const url = new URL(val);
    if (url.protocol !== 'https:') return false;
    if (!url.pathname.endsWith('/piwebapi') && !url.pathname.endsWith('/piwebapi/')) return false;
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return process.env.NODE_ENV === 'test' || process.env.ALLOW_LOOPBACK_PIWEBAPI === 'true';
    }
    return true;
  }, { message: "Base URL must be an absolute https:// URL ending with /piwebapi, and loopback hosts are rejected in production" }),

  MCP_TRANSPORT: z.enum(['stdio', 'http']),
  MCP_HTTP_BIND: z.string().optional(),
  MCP_HTTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),

  MCP_EDGE_AUTH_MODE: z.enum(['bearer', 'mtls', 'none']).default('none'),
  MCP_EDGE_JWKS_URL: z.string().url().optional(),
  MCP_EDGE_AUDIENCE: z.string().optional(),
  MCP_EDGE_ISSUER: z.string().optional(),
  MCP_EDGE_MTLS_CA_FILE: z.string().optional(),
  MCP_EDGE_MTLS_ROLES: z.string().optional(),
  MCP_EDGE_WRITE_ROLES: z.string().optional(),
  MCP_EDGE_RATE_LIMIT: z.coerce.number().int().positive().optional(),

  PIWEBAPI_AUTH_MODE: z.enum(['kerberos', 'bearer', 'basic', 'anonymous']),

  PIWEBAPI_KERBEROS_SPN: z.string().refine(val => val.startsWith('HTTP/'), {
    message: "Kerberos SPN must start with HTTP/"
  }).optional(),
  KRB5_CONFIG: z.string().optional(),
  KRB5_CLIENT_KTNAME: z.string().optional(),

  PIWEBAPI_BASIC_USER: z.string().optional(),
  PIWEBAPI_BASIC_PASSWORD: z.string().optional(),
  PIWEBAPI_BASIC_PASSWORD_FILE: z.string().optional(),
  PIWEBAPI_BASIC_PASSWORD_REF: z.string().optional(),

  PIWEBAPI_BEARER_ISSUER: z.string().url().refine(val => val !== 'OSIsoft.Invalid.ChangeMe', {
    message: "Bearer issuer must be a valid configuration and cannot equal the default ChangeMe sentinel"
  }).optional(),
  PIWEBAPI_BEARER_CLIENT_ID: z.string().optional(),
  PIWEBAPI_BEARER_CLIENT_SECRET: z.string().optional(),
  PIWEBAPI_BEARER_CLIENT_SECRET_FILE: z.string().optional(),
  PIWEBAPI_BEARER_CLIENT_SECRET_REF: z.string().optional(),
  PIWEBAPI_BEARER_SCOPE: z.string().optional(),
  PIWEBAPI_BEARER_AUDIENCE: z.string().optional(),
  PIWEBAPI_BEARER_GRANT: z.enum(['client_credentials', 'password']).default('client_credentials'),
  PIWEBAPI_BEARER_SKEW_SEC: z.coerce.number().int().nonnegative().default(60),
  PIWEBAPI_BEARER_REFRESH_LEAD_SEC: z.coerce.number().int().nonnegative().default(30),

  PIWEBAPI_ALLOW_ANONYMOUS: envBooleanSchema.default(false),

  PIWEBAPI_TLS_VERIFY: envBooleanSchema.default(true),
  PIWEBAPI_TLS_CA_FILE: z.string().optional(),
  PIWEBAPI_TLS_MIN_VERSION: z.enum(['TLSv1.2', 'TLSv1.3']).default('TLSv1.2'),
  PIWEBAPI_TLS_SERVERNAME: z.string().optional(),
  PIWEBAPI_TLS_PIN_SHA256: z.string().length(64).regex(/^[a-fA-F0-9]+$/).optional(),
  PIWEBAPI_TLS_CA_RELOAD: envBooleanSchema.default(false),

  PIWEBAPI_CLIENT_CERT_FILE: z.string().optional(),
  PIWEBAPI_CLIENT_CERT_KEY_FILE: z.string().optional(),
  PIWEBAPI_CLIENT_CERT_KEY_FILE_REF: z.string().optional(),

  PIWEBAPI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  PIWEBAPI_POOL_SIZE: z.coerce.number().int().positive().default(10),
  PIWEBAPI_MAX_CONCURRENT: z.coerce.number().int().positive().default(50),
  PIWEBAPI_MAX_CONCURRENT_SEARCH: z.coerce.number().int().positive().optional(),
  PIWEBAPI_MAX_CONCURRENT_DA_QUERIES: z.coerce.number().int().positive().max(200).optional(),
  PIWEBAPI_RETRY_MAX_ATTEMPTS: z.coerce.number().int().nonnegative().default(3),
  PIWEBAPI_RETRY_BASE_MS: z.coerce.number().int().positive().default(1000),
  PIWEBAPI_RETRY_MAX_MS: z.coerce.number().int().positive().default(10000),

  PIWEBAPI_WEBID_TYPE: z.string().default('IDOnly'),
  PIWEBAPI_WEBID_CACHE_TTL_SEC: z.coerce.number().int().nonnegative().default(300),
  PIWEBAPI_WEBID_CACHE_MAX: z.coerce.number().int().positive().default(1000),
  PIWEBAPI_META_CACHE_TTL_SEC: z.coerce.number().int().nonnegative().default(300),
  PIWEBAPI_META_CACHE_MAX: z.coerce.number().int().positive().default(1000),
  PIWEBAPI_SEND_CSRF_HEADER: envBooleanSchema.default(true),

  MCP_READ_ONLY: envBooleanSchema.default(true),
  MCP_WRITE_TOOLS_ENABLED: envBooleanSchema.default(false),
  MCP_ADMIN_IDENTITY_CONFIGURED: envBooleanSchema.default(false),
  MCP_MAX_RESPONSE_BYTES: z.coerce.number().int().positive().default(1048576),

  MCP_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  MCP_LOG_REDACT_EXTRA: z.string().optional(),
  MCP_SERVER_NAME: z.string().min(1).default('aveva-pisystem-mcp-server'),
  MCP_SERVER_VERSION: z.string().min(1).optional(),
});

export const configSchema = configObjectSchema.superRefine((data, ctx) => {
  if (data.MCP_TRANSPORT === 'http') {
    if (!data.MCP_HTTP_BIND) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MCP_HTTP_BIND'],
        message: "MCP_HTTP_BIND is required when MCP_TRANSPORT is 'http'"
      });
    }
    if (!data.MCP_HTTP_PORT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MCP_HTTP_PORT'],
        message: "MCP_HTTP_PORT is required when MCP_TRANSPORT is 'http'"
      });
    }
    if (data.PIWEBAPI_TLS_VERIFY === false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PIWEBAPI_TLS_VERIFY'],
        message: "TLS verification cannot be disabled when running in HTTP transport mode"
      });
    }
    if (data.MCP_EDGE_AUTH_MODE === 'none') {
      const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(data.MCP_HTTP_BIND);
      if (!isLoopback) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MCP_EDGE_AUTH_MODE'],
          message: "Inbound edge authentication mode cannot be 'none' unless binding to a loopback address"
        });
      }
    }
    // Without an expected audience, any valid token from the issuer — minted
    // for a different relying party — would be accepted.
    if (data.MCP_EDGE_AUTH_MODE === 'bearer' && !data.MCP_EDGE_AUDIENCE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MCP_EDGE_AUDIENCE'],
        message: "MCP_EDGE_AUDIENCE is required when MCP_EDGE_AUTH_MODE is 'bearer'"
      });
    }
  }

  if (data.PIWEBAPI_TLS_VERIFY === false && process.env.NODE_ENV === 'production') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PIWEBAPI_TLS_VERIFY'],
      message: "TLS verification cannot be disabled when NODE_ENV is 'production'"
    });
  }

  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['NODE_TLS_REJECT_UNAUTHORIZED'],
      message: "NODE_TLS_REJECT_UNAUTHORIZED=0 is forbidden and rejects startup"
    });
  }

  if (data.PIWEBAPI_AUTH_MODE === 'kerberos') {
    if (!data.PIWEBAPI_KERBEROS_SPN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PIWEBAPI_KERBEROS_SPN'],
        message: "PIWEBAPI_KERBEROS_SPN is required when PIWEBAPI_AUTH_MODE is 'kerberos'"
      });
    }
    if (data.PIWEBAPI_BEARER_ISSUER || data.PIWEBAPI_BEARER_CLIENT_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PIWEBAPI_AUTH_MODE'],
        message: "Bearer options cannot be configured when authentication mode is 'kerberos'"
      });
    }
  }

  if (data.PIWEBAPI_AUTH_MODE === 'bearer') {
    if (!data.PIWEBAPI_BEARER_ISSUER) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PIWEBAPI_BEARER_ISSUER'],
        message: "PIWEBAPI_BEARER_ISSUER is required when PIWEBAPI_AUTH_MODE is 'bearer'"
      });
    }
    if (!data.PIWEBAPI_BEARER_CLIENT_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PIWEBAPI_BEARER_CLIENT_ID'],
        message: "PIWEBAPI_BEARER_CLIENT_ID is required when PIWEBAPI_AUTH_MODE is 'bearer'"
      });
    }
    const secretCheck = secretSchema.safeParse({
      value: data.PIWEBAPI_BEARER_CLIENT_SECRET,
      file: data.PIWEBAPI_BEARER_CLIENT_SECRET_FILE,
      ref: data.PIWEBAPI_BEARER_CLIENT_SECRET_REF
    });
    if (!secretCheck.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PIWEBAPI_BEARER_CLIENT_SECRET'],
        message: "Bearer client secret must be supplied via exactly one of PIWEBAPI_BEARER_CLIENT_SECRET, _FILE, or _REF"
      });
    }
  }

  if (data.PIWEBAPI_AUTH_MODE === 'basic') {
    if (!data.PIWEBAPI_BASIC_USER) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PIWEBAPI_BASIC_USER'],
        message: "PIWEBAPI_BASIC_USER is required when PIWEBAPI_AUTH_MODE is 'basic'"
      });
    }
    const secretCheck = secretSchema.safeParse({
      value: data.PIWEBAPI_BASIC_PASSWORD,
      file: data.PIWEBAPI_BASIC_PASSWORD_FILE,
      ref: data.PIWEBAPI_BASIC_PASSWORD_REF
    });
    if (!secretCheck.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PIWEBAPI_BASIC_PASSWORD'],
        message: "Basic password must be supplied via exactly one of PIWEBAPI_BASIC_PASSWORD, _FILE, or _REF"
      });
    }
  }

  if (data.PIWEBAPI_AUTH_MODE === 'anonymous') {
    if (!data.PIWEBAPI_ALLOW_ANONYMOUS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PIWEBAPI_ALLOW_ANONYMOUS'],
        message: "PIWEBAPI_ALLOW_ANONYMOUS must be explicitly true when PIWEBAPI_AUTH_MODE is 'anonymous'"
      });
    }
    if (!data.MCP_READ_ONLY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MCP_READ_ONLY'],
        message: "MCP_READ_ONLY must be true when PIWEBAPI_AUTH_MODE is 'anonymous'"
      });
    }
  }

  if (data.MCP_WRITE_TOOLS_ENABLED) {
    if (data.MCP_READ_ONLY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MCP_WRITE_TOOLS_ENABLED'],
        message: "Cannot enable write tools when MCP_READ_ONLY is set to true"
      });
    }
    if (data.MCP_TRANSPORT === 'http') {
      if (data.MCP_EDGE_AUTH_MODE === 'none') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MCP_EDGE_AUTH_MODE'],
          message: "Edge authentication is required to enable write tools over HTTP transport"
        });
      }
      if (!data.MCP_EDGE_WRITE_ROLES || data.MCP_EDGE_WRITE_ROLES.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MCP_EDGE_WRITE_ROLES'],
          message: "MCP_EDGE_WRITE_ROLES must be specified to enable write tools over HTTP transport"
        });
      }
    }
  }
});
