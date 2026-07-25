/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import * as userStorage from '../../services/storage/userStorage.js';
import * as hasher from '../../services/security/hash.js';
import { trackDemoAccessed } from '../../services/tracking/Tracker.js';
import logger from '../../services/logger.js';
import { getSettings } from '../../services/storage/settingsStorage.js';
import { isUnauthorized } from '../security.js';
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  getOidcConfig,
  oidcRandom,
  sanitizeReturnTo,
} from '../../services/security/oidc.js';

const MAX_LOGIN_ATTEMPTS = 10;
const MAX_OIDC_ATTEMPTS = 20;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const OIDC_TRANSACTION_MAX_AGE = 10 * 60 * 1000;
const MAX_OIDC_TRANSACTIONS = 1000;
const OIDC_ERROR_LOCATION = '/#/login?oidcError=1';
const OIDC_BINDING_COOKIE = 'fredy-oidc-binding';
const loginAttempts = new Map();
const oidcAttempts = new Map();

function getClientIp(request) {
  return request.ip || request.socket?.remoteAddress || 'unknown';
}

function isRateLimited(attempts, ip, maximumAttempts) {
  const now = Date.now();
  for (const [key, rec] of attempts) {
    if (now - rec.firstAttempt > LOGIN_WINDOW_MS) attempts.delete(key);
  }
  const record = attempts.get(ip);
  if (!record || now - record.firstAttempt > LOGIN_WINDOW_MS) {
    attempts.set(ip, { count: 1, firstAttempt: now });
    return false;
  }
  record.count++;
  return record.count > maximumAttempts;
}

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function loginPlugin(fastify, options = {}) {
  const oidcTransactions = new Map();

  function pruneOidcTransactions(now = Date.now()) {
    for (const [state, transaction] of oidcTransactions) {
      if (now - transaction.createdAt > OIDC_TRANSACTION_MAX_AGE) oidcTransactions.delete(state);
    }
    while (oidcTransactions.size >= MAX_OIDC_TRANSACTIONS) {
      oidcTransactions.delete(oidcTransactions.keys().next().value);
    }
  }

  async function establishSession(request, user) {
    await request.session.regenerate();
    request.session.currentUser = user.id;
    // createdAt alone drives expiry: security.js treats it as a rolling idle
    // window that touchSession() moves forward on every authenticated request.
    // An absolute expiry stored here would silently reintroduce the fixed-window
    // logouts that upstream removed in 22.10.1.
    request.session.createdAt = Date.now();
    await request.session.save();
    userStorage.setLastLoginToNow({ userId: user.id });
  }

  fastify.get('/user', async (request) => {
    // Honor the same hard-expiry check the authenticated routes use. Without this the
    // session cookie keeps rolling and this public endpoint would keep reporting the user
    // as logged in after the session expired, so the client never redirects to login.
    if (isUnauthorized(request)) {
      return {};
    }
    const currentUserId = request.session?.currentUser;
    const currentUser = currentUserId == null ? null : userStorage.getUser(currentUserId);
    if (currentUser == null) {
      return {};
    }
    return {
      userId: currentUser.id,
      isAdmin: currentUser.isAdmin,
    };
  });

  fastify.post('/', async (request, reply) => {
    const ip = getClientIp(request);
    if (isRateLimited(loginAttempts, ip, MAX_LOGIN_ATTEMPTS)) {
      logger.error(`Login rate limit exceeded for IP ${ip}`);
      return reply.code(429).send();
    }
    const settings = await getSettings();
    const { username, password } = request.body;
    const user = userStorage.getUsers(true).find((u) => u.username === username);
    if (user == null) {
      return reply.code(401).send();
    }
    if (user.password === hasher.hash(password)) {
      if (settings.demoMode) {
        await trackDemoAccessed();
      }
      await establishSession(request, user);
      loginAttempts.delete(ip);
      return reply.code(200).send();
    } else {
      logger.error(`User ${username} tried to login, but password was wrong.`);
    }
    return reply.code(401).send();
  });

  fastify.get('/oidc/status', async () => {
    const config = getOidcConfig();
    return { enabled: config.enabled, autoLogin: config.enabled && config.autoLogin };
  });

  fastify.get('/oidc/start', async (request, reply) => {
    const ip = getClientIp(request);
    if (isRateLimited(oidcAttempts, ip, MAX_OIDC_ATTEMPTS)) {
      return reply.redirect(OIDC_ERROR_LOCATION);
    }
    const config = getOidcConfig();
    if (!config.enabled) return reply.code(404).send();

    const binding = request.cookies[OIDC_BINDING_COOKIE] || oidcRandom.binding();
    const transaction = {
      state: oidcRandom.state(),
      nonce: oidcRandom.nonce(),
      codeVerifier: oidcRandom.codeVerifier(),
      createdAt: Date.now(),
      returnTo: sanitizeReturnTo(request.query?.returnTo),
      binding,
    };
    pruneOidcTransactions();
    oidcTransactions.set(transaction.state, transaction);

    try {
      const authorizationUrl = await buildAuthorizationUrl(config, transaction);
      reply.setCookie(OIDC_BINDING_COOKIE, binding, {
        path: '/api/login/oidc',
        httpOnly: true,
        secure: options.sessionCookieSecure === true,
        sameSite: 'lax',
        expires: new Date(Date.now() + OIDC_TRANSACTION_MAX_AGE),
      });
      return reply.redirect(authorizationUrl.href);
    } catch {
      oidcTransactions.delete(transaction.state);
      logger.error('Could not start OIDC login.');
      return reply.redirect(OIDC_ERROR_LOCATION);
    }
  });

  fastify.get('/oidc/callback', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');

    const config = getOidcConfig();
    pruneOidcTransactions();
    const state = typeof request.query?.state === 'string' ? request.query.state : null;
    const transaction = state == null ? null : oidcTransactions.get(state);
    const binding = request.cookies[OIDC_BINDING_COOKIE];
    if (
      !config.enabled ||
      !transaction ||
      !binding ||
      binding !== transaction.binding ||
      Date.now() - transaction.createdAt > OIDC_TRANSACTION_MAX_AGE
    ) {
      return reply.redirect(OIDC_ERROR_LOCATION);
    }
    oidcTransactions.delete(state);

    try {
      const callbackUrl = new URL(config.redirectUri.href);
      const queryStart = request.raw.url.indexOf('?');
      callbackUrl.search = queryStart === -1 ? '' : request.raw.url.slice(queryStart);
      const userId = await exchangeAuthorizationCode(config, callbackUrl, transaction);
      const user = userId == null ? null : userStorage.getUser(userId);
      if (user == null) throw new Error('OIDC identity is not mapped to a Fredy user.');
      if (Date.now() - transaction.createdAt > OIDC_TRANSACTION_MAX_AGE) {
        throw new Error('OIDC transaction expired during token exchange.');
      }

      await establishSession(request, user);
      return reply.redirect(`/#${sanitizeReturnTo(transaction.returnTo)}`);
    } catch {
      logger.error('OIDC login failed.');
      return reply.redirect(OIDC_ERROR_LOCATION);
    }
  });

  fastify.post('/logout', async (request, reply) => {
    await request.session.destroy();
    return reply.code(200).send({ redirect: '/#/login?manual=1' });
  });
}
