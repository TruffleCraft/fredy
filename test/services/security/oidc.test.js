/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect } from 'vitest';
import { getOidcConfig, sanitizeReturnTo } from '../../../lib/services/security/oidc.js';

const VALID_CONFIG = {
  FREDY_OIDC_ENABLED: 'true',
  FREDY_OIDC_ISSUER: 'https://id.example.test',
  FREDY_OIDC_CLIENT_ID: 'fredy',
  FREDY_OIDC_REDIRECT_URI: 'https://fredy.example.test/api/login/oidc/callback',
  FREDY_OIDC_SUBJECT_MAP: JSON.stringify({ 'subject-1': 'user-1' }),
};

describe('OIDC configuration', () => {
  it('keeps OIDC opt-in by default', () => {
    expect(getOidcConfig({})).toEqual({ enabled: false });
  });

  it('accepts a public PKCE client with a mapped subject', () => {
    const config = getOidcConfig(VALID_CONFIG);
    expect(config.enabled).toBe(true);
    expect(config.clientAuthMethod).toBe('none');
    expect(config.subjectMap.get('subject-1')).toBe('user-1');
  });

  it('refuses an insecure callback URL rather than starting a partial login flow', () => {
    const config = getOidcConfig({
      ...VALID_CONFIG,
      FREDY_OIDC_REDIRECT_URI: 'http://fredy.example.test/api/login/oidc/callback',
    });
    expect(config.enabled).toBe(false);
    expect(config.error).toMatch(/HTTPS/);
  });

  it('accepts only same-origin-looking return paths', () => {
    expect(sanitizeReturnTo('/listings?job=abc#new')).toBe('/listings?job=abc#new');
    expect(sanitizeReturnTo('https://attacker.example')).toBe('/dashboard');
    expect(sanitizeReturnTo('//attacker.example')).toBe('/dashboard');
  });
});
