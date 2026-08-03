/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import * as client from 'openid-client';

const CALLBACK_PATH = '/api/login/oidc/callback';
const DEFAULT_RETURN_TO = '/dashboard';
const DISCOVERY_TIMEOUT_SECONDS = 10;

let cachedConfiguration = null;
let cachedConfigurationKey = null;

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('OIDC boolean settings must be either true or false.');
}

function parseHttpsUrl(value, name) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTPS URL without credentials, query, or fragment.`);
  }
  return url;
}

function parseSubjectMap(value) {
  const parsed = JSON.parse(value);
  if (parsed == null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('FREDY_OIDC_SUBJECT_MAP must be a JSON object.');
  }

  const result = new Map();
  const userIds = new Set();
  for (const [subject, userId] of Object.entries(parsed)) {
    if (!subject || typeof userId !== 'string' || !userId.trim()) {
      throw new Error('OIDC subject mappings require non-empty subject and Fredy user ID strings.');
    }
    const normalizedUserId = userId.trim();
    if (userIds.has(normalizedUserId)) {
      throw new Error('Each Fredy user ID may only have one OIDC subject mapping.');
    }
    result.set(subject, normalizedUserId);
    userIds.add(normalizedUserId);
  }

  if (result.size === 0) {
    throw new Error('FREDY_OIDC_SUBJECT_MAP must contain at least one mapping.');
  }
  return result;
}

/**
 * Read and validate OIDC configuration from environment variables.
 * Invalid or incomplete optional configuration disables OIDC without affecting password login.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{enabled:boolean, error?:string, issuer?:URL, clientId?:string, clientSecret?:string, clientAuthMethod?:string, redirectUri?:URL, subjectMap?:Map<string,string>, autoLogin?:boolean}}
 */
export function getOidcConfig(env = process.env) {
  try {
    if (!parseBoolean(env.FREDY_OIDC_ENABLED, false)) return { enabled: false };

    const required = ['FREDY_OIDC_ISSUER', 'FREDY_OIDC_CLIENT_ID', 'FREDY_OIDC_REDIRECT_URI', 'FREDY_OIDC_SUBJECT_MAP'];
    if (required.some((name) => !env[name])) {
      throw new Error(`OIDC requires ${required.join(', ')}.`);
    }

    const issuer = parseHttpsUrl(env.FREDY_OIDC_ISSUER, 'FREDY_OIDC_ISSUER');
    if (issuer.pathname.includes('/.well-known/')) {
      throw new Error('FREDY_OIDC_ISSUER must be an issuer identifier, not a discovery document URL.');
    }
    const redirectUri = parseHttpsUrl(env.FREDY_OIDC_REDIRECT_URI, 'FREDY_OIDC_REDIRECT_URI');
    if (redirectUri.pathname !== CALLBACK_PATH) {
      throw new Error(`FREDY_OIDC_REDIRECT_URI must use the callback path ${CALLBACK_PATH}.`);
    }

    const clientSecret = env.FREDY_OIDC_CLIENT_SECRET || undefined;
    const clientAuthMethod = env.FREDY_OIDC_CLIENT_AUTH_METHOD || (clientSecret ? 'client_secret_post' : 'none');
    if (!['none', 'client_secret_basic', 'client_secret_post'].includes(clientAuthMethod)) {
      throw new Error('FREDY_OIDC_CLIENT_AUTH_METHOD must be none, client_secret_basic, or client_secret_post.');
    }
    if ((clientAuthMethod === 'none') !== (clientSecret == null)) {
      throw new Error('OIDC public clients must omit the client secret; confidential clients must provide one.');
    }

    return {
      enabled: true,
      issuer,
      clientId: env.FREDY_OIDC_CLIENT_ID,
      clientSecret,
      clientAuthMethod,
      redirectUri,
      subjectMap: parseSubjectMap(env.FREDY_OIDC_SUBJECT_MAP),
      autoLogin: parseBoolean(env.FREDY_OIDC_AUTO_LOGIN, false),
    };
  } catch (error) {
    return { enabled: false, error: error.message };
  }
}

/**
 * Restrict post-login redirects to paths on the current Fredy origin.
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return DEFAULT_RETURN_TO;
  if (
    value.includes('\\') ||
    Array.from(value).some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
  ) {
    return DEFAULT_RETURN_TO;
  }

  try {
    const base = new URL('https://fredy.invalid');
    const resolved = new URL(value, base);
    if (resolved.origin !== base.origin) return DEFAULT_RETURN_TO;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}

async function getClientConfiguration(config) {
  const cacheKey = JSON.stringify([
    config.issuer.href,
    config.clientId,
    config.clientSecret || null,
    config.clientAuthMethod,
  ]);
  if (cachedConfiguration != null && cachedConfigurationKey === cacheKey) return cachedConfiguration;

  const authentication =
    config.clientAuthMethod === 'client_secret_basic'
      ? client.ClientSecretBasic(config.clientSecret)
      : config.clientAuthMethod === 'client_secret_post'
        ? client.ClientSecretPost(config.clientSecret)
        : client.None();

  cachedConfigurationKey = cacheKey;
  cachedConfiguration = client
    .discovery(
      config.issuer,
      config.clientId,
      config.clientSecret ? { client_secret: config.clientSecret } : undefined,
      authentication,
      { timeout: DISCOVERY_TIMEOUT_SECONDS },
    )
    .catch((error) => {
      cachedConfiguration = null;
      cachedConfigurationKey = null;
      throw error;
    });
  return cachedConfiguration;
}

/**
 * Build a standards-based OIDC authorization URL using state, nonce, and PKCE.
 * @param {ReturnType<typeof getOidcConfig>} config
 * @param {{state:string, nonce:string, codeVerifier:string}} transaction
 * @returns {Promise<URL>}
 */
export async function buildAuthorizationUrl(config, transaction) {
  const oidcConfig = await getClientConfiguration(config);
  const codeChallenge = await client.calculatePKCECodeChallenge(transaction.codeVerifier);
  return client.buildAuthorizationUrl(oidcConfig, {
    redirect_uri: config.redirectUri.href,
    scope: 'openid profile email',
    state: transaction.state,
    nonce: transaction.nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
}

/**
 * Validate the callback and return the mapped immutable Fredy user ID.
 * @param {ReturnType<typeof getOidcConfig>} config
 * @param {URL} callbackUrl
 * @param {{state:string, nonce:string, codeVerifier:string}} transaction
 * @returns {Promise<string|null>}
 */
export async function exchangeAuthorizationCode(config, callbackUrl, transaction) {
  const oidcConfig = await getClientConfiguration(config);
  const tokens = await client.authorizationCodeGrant(oidcConfig, callbackUrl, {
    expectedState: transaction.state,
    expectedNonce: transaction.nonce,
    pkceCodeVerifier: transaction.codeVerifier,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  // openid-client validates issuer, audience, signature, expiry, and nonce before exposing claims.
  if (typeof claims?.sub !== 'string') return null;
  return config.subjectMap.get(claims.sub) || null;
}

export const oidcRandom = {
  state: client.randomState,
  nonce: client.randomNonce,
  codeVerifier: client.randomPKCECodeVerifier,
  binding: client.randomState,
};
