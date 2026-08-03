/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

let db;

vi.mock('../../lib/services/storage/SqliteConnection.js', () => ({
  default: {
    query: (sql, params) => db.prepare(sql).all(params ?? {}),
    execute: (sql, params) => db.prepare(sql).run(params ?? {}),
    withTransaction: (fn) => db.transaction(fn)(db),
  },
}));
vi.mock('../../lib/services/similarity-check/similarityCache.js', () => ({ removeEntry: vi.fn() }));

const USER = 'user-1';
const BERLIN_BOX = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [13.2, 52.4],
            [13.7, 52.4],
            [13.7, 52.7],
            [13.2, 52.7],
            [13.2, 52.4],
          ],
        ],
      },
    },
  ],
};

describe('queryListings spatialFilter against real SQLite', () => {
  let listingsStorage;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(
      "CREATE TABLE jobs (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, shared_with_user TEXT DEFAULT '[]', deal_type TEXT);" +
        'CREATE TABLE listings (id TEXT PRIMARY KEY, job_id TEXT, title TEXT, address TEXT, provider TEXT, link TEXT, status TEXT, distances TEXT, created_at INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, manually_deleted INTEGER DEFAULT 0, latitude REAL, longitude REAL);' +
        'CREATE TABLE watch_list (id TEXT PRIMARY KEY, listing_id TEXT, user_id TEXT);' +
        'CREATE TABLE listing_travel_times (listing_id TEXT NOT NULL, label TEXT NOT NULL, transit_minutes INTEGER, transit_transfers INTEGER, car_minutes INTEGER, car_distance_meters INTEGER, car_geometry TEXT, bike_minutes INTEGER, walk_minutes INTEGER, is_estimate INTEGER NOT NULL DEFAULT 1, reference_time INTEGER, computed_at INTEGER, transit_legs TEXT, via_stops TEXT, PRIMARY KEY (listing_id, label));',
    );
    db.prepare("INSERT INTO jobs (id, user_id, name, shared_with_user, deal_type) VALUES (?, ?, ?, '[]', 'rent')").run(
      'job-1',
      USER,
      'Berlin',
    );
    const insert = db.prepare(
      'INSERT INTO listings (id, job_id, title, created_at, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run('inside', 'job-1', 'Inside', 3, 52.52, 13.4);
    insert.run('outside', 'job-1', 'Outside', 2, 48.14, 11.58);
    insert.run('unknown', 'job-1', 'Unknown', 1, null, null);

    vi.resetModules();
    listingsStorage = await import('../../lib/services/storage/listingsStorage.js');
  });

  afterEach(() => db.close());

  it('hides out-of-area rows, keeps ungeocoded rows retryable, and paginates after filtering', () => {
    const firstPage = listingsStorage.queryListings({
      userId: USER,
      page: 1,
      pageSize: 1,
      spatialFilter: BERLIN_BOX,
    });
    const secondPage = listingsStorage.queryListings({
      userId: USER,
      page: 2,
      pageSize: 1,
      spatialFilter: BERLIN_BOX,
    });

    expect(firstPage.totalNumber).toBe(2);
    expect(firstPage.result.map((row) => row.id)).toEqual(['inside']);
    expect(secondPage.result.map((row) => row.id)).toEqual(['unknown']);
  });
});
