/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// geocodeAddress reports "not found" as { lat: -1, lng: -1 } rather than null.
// The cron must not persist that sentinel: it is a real coordinate in the South
// Atlantic, so it silently pushes the listing outside every spatial filter, and
// it also makes the row invisible to getListingsToGeocode() (which selects on
// latitude IS NULL), so the bad value would never be corrected.

const calls = { updates: [] };
let geocodeResults = new Map();

vi.mock('../../../lib/services/storage/listingsStorage.js', () => ({
  getListingsToGeocode: () => [
    { id: 'found', address: 'Rigaer Str. 71, Berlin' },
    { id: 'not-found', address: 'Nowhere Street 999' },
    { id: 'null-result', address: '' },
  ],
  updateListingGeocoordinates: (id, latitude, longitude) => {
    calls.updates.push({ id, latitude, longitude });
  },
}));

vi.mock('../../../lib/services/geocoding/geoCodingService.js', () => ({
  geocodeAddress: async (address) => geocodeResults.get(address) ?? null,
  isGeocodingPaused: () => false,
}));

vi.mock('../../../lib/services/storage/jobStorage.js', () => ({
  getJobs: () => [],
}));

vi.mock('../../../lib/services/geocoding/distanceService.js', () => ({
  calculateDistanceForJob: () => {},
}));

vi.mock('../../../lib/services/storage/settingsStorage.js', () => ({
  getSettings: async () => ({ demoMode: false }),
}));

vi.mock('../../../lib/services/logger.js', () => ({
  default: { info: () => {}, error: () => {} },
}));

describe('geocoding-cron runGeoCordTask', () => {
  let cron;

  beforeEach(async () => {
    calls.updates = [];
    geocodeResults = new Map([
      ['Rigaer Str. 71, Berlin', { lat: 52.5163, lng: 13.4577 }],
      ['Nowhere Street 999', { lat: -1, lng: -1 }],
      ['', null],
    ]);
    vi.resetModules();
    cron = await import('../../../lib/services/crons/geocoding-cron.js');
  });

  it('stores real coordinates', async () => {
    await cron.runGeoCordTask();
    expect(calls.updates).toContainEqual({ id: 'found', latitude: 52.5163, longitude: 13.4577 });
  });

  it('does not persist the -1/-1 not-found sentinel', async () => {
    await cron.runGeoCordTask();
    expect(calls.updates.map((u) => u.id)).not.toContain('not-found');
    expect(calls.updates.some((u) => u.latitude === -1 || u.longitude === -1)).toBe(false);
  });

  it('does not write anything when geocoding returns null', async () => {
    await cron.runGeoCordTask();
    expect(calls.updates.map((u) => u.id)).not.toContain('null-result');
  });

  it('leaves the not-found listing retryable by writing no coordinates at all', async () => {
    await cron.runGeoCordTask();
    // Exactly one listing was geocodable, so exactly one row may be touched.
    // Anything more means a sentinel or null leaked into the DB and the row
    // would drop out of the latitude IS NULL retry set.
    expect(calls.updates).toHaveLength(1);
  });
});
