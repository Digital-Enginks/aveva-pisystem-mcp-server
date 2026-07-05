import fs from 'node:fs';
import { configSchema, configObjectSchema } from './schema.js';

function resolveSecret(value, file, ref) {
  if (value !== undefined) {
    return value;
  }
  if (file !== undefined) {
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch (err) {
      throw new Error(`Failed to read secret from file "${file}": ${err.message}`);
    }
  }
  if (ref !== undefined) {
    const envVal = process.env[ref];
    if (envVal !== undefined) {
      return envVal;
    }
    throw new Error(`Failed to resolve secret reference "${ref}" from environment`);
  }
  return undefined;
}

export function loadConfig(env = process.env) {
  const rawConfig = {};

  // Treat empty strings as absent so that an env file copied from .env.example
  // (where every key is present but blank) falls through to schema defaults and
  // optional handling instead of failing enum/secret validation on "".
  for (const key of Object.keys(configObjectSchema.shape)) {
    const value = env[key];
    rawConfig[key] = value === '' ? undefined : value;
  }

  const parsed = configSchema.safeParse(rawConfig);
  if (!parsed.success) {
    const formatted = parsed.error.format();
    const errorMsg = JSON.stringify(formatted, null, 2);
    throw new Error(`Configuration validation failed:\n${errorMsg}`);
  }

  const config = { ...parsed.data };

  if (config.PIWEBAPI_AUTH_MODE === 'basic') {
    config.PIWEBAPI_BASIC_PASSWORD_RESOLVED = resolveSecret(
      config.PIWEBAPI_BASIC_PASSWORD,
      config.PIWEBAPI_BASIC_PASSWORD_FILE,
      config.PIWEBAPI_BASIC_PASSWORD_REF
    );
  }

  if (config.PIWEBAPI_AUTH_MODE === 'bearer') {
    config.PIWEBAPI_BEARER_CLIENT_SECRET_RESOLVED = resolveSecret(
      config.PIWEBAPI_BEARER_CLIENT_SECRET,
      config.PIWEBAPI_BEARER_CLIENT_SECRET_FILE,
      config.PIWEBAPI_BEARER_CLIENT_SECRET_REF
    );
  }

  if (config.PIWEBAPI_CLIENT_CERT_KEY_FILE) {
    config.PIWEBAPI_CLIENT_CERT_KEY_RESOLVED = resolveSecret(
      undefined,
      config.PIWEBAPI_CLIENT_CERT_KEY_FILE,
      config.PIWEBAPI_CLIENT_CERT_KEY_FILE_REF
    );
  }

  return Object.freeze(config);
}
