/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

const MANUAL_LOGOUT_KEY = 'fredy-manual-logout';

export function markManualLogout(storage = window.sessionStorage) {
  storage.setItem(MANUAL_LOGOUT_KEY, '1');
}

export function clearManualLogout(storage = window.sessionStorage) {
  storage.removeItem(MANUAL_LOGOUT_KEY);
}

export function consumeManualLogout(storage = window.sessionStorage) {
  const isManualLogout = storage.getItem(MANUAL_LOGOUT_KEY) === '1';
  if (isManualLogout) clearManualLogout(storage);
  return isManualLogout;
}
