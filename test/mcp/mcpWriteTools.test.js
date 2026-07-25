/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// The write tools are thin wrappers around storage functions, so the storage
// layer is mocked and we assert on the wiring: the opt-in gate, the access
// check, and that the persisted value is read back and reported.

const storage = {
  listings: new Map(),
  statusCalls: [],
  notesCalls: [],
  watchCreates: [],
  watchDeletes: [],
};

vi.mock('../../lib/services/storage/listingsStorage.js', () => ({
  getListingById: (id, userId, isAdmin) => {
    const listing = storage.listings.get(id);
    if (!listing) return null;
    // Mirror the SQL scoping: non-admins only see their own job's listings.
    if (!isAdmin && listing.ownerId !== userId) return null;
    return listing;
  },
  setListingStatus: (id, status) => {
    storage.statusCalls.push({ id, status });
    const listing = storage.listings.get(id);
    if (listing) listing.status = status == null ? null : { status, setAt: 1772008362564 };
    return 1;
  },
  setListingNotes: (id, notes) => {
    storage.notesCalls.push({ id, notes });
    const listing = storage.listings.get(id);
    if (listing) listing.notes = notes && notes.length > 0 ? notes : null;
    return 1;
  },
}));

vi.mock('../../lib/services/storage/watchListStorage.js', () => ({
  createWatch: (listingId, userId) => {
    storage.watchCreates.push({ listingId, userId });
    return { created: true };
  },
  deleteWatch: (listingId, userId) => {
    storage.watchDeletes.push({ listingId, userId });
    return { deleted: true };
  },
}));

const USERS = [
  { id: 'user-michel', username: 'michel', isAdmin: true },
  { id: 'user-alina', username: 'alina', isAdmin: true },
  // Non-admin with his own jobs: must not be able to touch other people's listings.
  { id: 'user-johannes', username: 'johannes', isAdmin: false },
  { id: 'svc-hermes', username: 'hermes-mcp', isAdmin: true },
];

vi.mock('../../lib/services/storage/userStorage.js', () => ({
  getUsers: () => USERS,
  getUser: (id) => USERS.find((u) => u.id === id) ?? null,
}));

/** Collect tools registered on a fake MCP server. */
function fakeServer() {
  const tools = new Map();
  return {
    tools,
    tool: (name, _desc, _schema, handler) => tools.set(name, handler),
  };
}

/** MCP `extra` carrying an authenticated user id. */
const asUser = (userId) => ({ authInfo: { userId } });

/** Extract the markdown text out of an MCP tool result. */
const textOf = (result) => result.content.map((c) => c.text).join('\n');

describe('mcpWriteTools', () => {
  let mod;

  beforeEach(async () => {
    storage.listings = new Map([
      ['listing-1', { id: 'listing-1', title: 'Rigaer Str. 71', ownerId: 'user-michel', status: null, notes: null }],
      ['listing-foreign', { id: 'listing-foreign', title: 'Not yours', ownerId: 'user-someone', status: null }],
    ]);
    storage.statusCalls = [];
    storage.notesCalls = [];
    storage.watchCreates = [];
    storage.watchDeletes = [];
    vi.resetModules();
    // getUser is mocked to always return an admin, so authenticateToolCall
    // resolves; per-test admin behaviour is driven through resolveWatchTarget.
    mod = await import('../../lib/mcp/mcpWriteTools.js');
  });

  describe('opt-in gate', () => {
    it('registers nothing when FREDY_MCP_WRITE_ENABLED is unset', () => {
      const server = fakeServer();
      const registered = mod.registerWriteTools(server, {});
      expect(registered).toBe(false);
      expect(server.tools.size).toBe(0);
    });

    it('registers nothing when the flag is not exactly "true"', () => {
      const server = fakeServer();
      mod.registerWriteTools(server, { FREDY_MCP_WRITE_ENABLED: '1' });
      expect(server.tools.size).toBe(0);
    });

    it('registers the three write tools when enabled', () => {
      const server = fakeServer();
      const registered = mod.registerWriteTools(server, { FREDY_MCP_WRITE_ENABLED: 'true' });
      expect(registered).toBe(true);
      expect([...server.tools.keys()].sort()).toEqual(['set_listing_notes', 'set_listing_status', 'set_listing_watch']);
    });
  });

  describe('set_listing_status', () => {
    let handler;
    beforeEach(() => {
      const server = fakeServer();
      mod.registerWriteTools(server, { FREDY_MCP_WRITE_ENABLED: 'true' });
      handler = server.tools.get('set_listing_status');
    });

    it('persists the status and reports the stored value back', async () => {
      const res = await handler({ listingId: 'listing-1', status: 'rejected' }, asUser('user-michel'));
      expect(storage.statusCalls).toEqual([{ id: 'listing-1', status: 'rejected' }]);
      expect(textOf(res)).toContain('**Status:** rejected');
      expect(res.isError).toBeUndefined();
    });

    it('maps "none" to a cleared status', async () => {
      await handler({ listingId: 'listing-1', status: 'none' }, asUser('user-michel'));
      expect(storage.statusCalls).toEqual([{ id: 'listing-1', status: null }]);
    });

    it('is idempotent: setting the same status twice both succeed', async () => {
      await handler({ listingId: 'listing-1', status: 'applied' }, asUser('user-michel'));
      const second = await handler({ listingId: 'listing-1', status: 'applied' }, asUser('user-michel'));
      expect(second.isError).toBeUndefined();
      expect(storage.statusCalls).toHaveLength(2);
    });

    it('refuses a non-admin writing to someone else\'s listing, without writing', async () => {
      // Johannes is a non-admin with his own jobs; listing-1 belongs to Michel.
      const res = await handler({ listingId: 'listing-1', status: 'rejected' }, asUser('user-johannes'));
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('Listing not found');
      expect(storage.statusCalls).toEqual([]);
    });

    it('lets an admin write to any listing', async () => {
      const res = await handler({ listingId: 'listing-foreign', status: 'rejected' }, asUser('user-michel'));
      expect(res.isError).toBeUndefined();
      expect(storage.statusCalls).toEqual([{ id: 'listing-foreign', status: 'rejected' }]);
    });

    it('reports an unknown listing the same way as a forbidden one', async () => {
      const unknown = await handler({ listingId: 'does-not-exist', status: 'rejected' }, asUser('user-johannes'));
      const forbidden = await handler({ listingId: 'listing-1', status: 'rejected' }, asUser('user-johannes'));
      // Identical shape on purpose: a write tool must not confirm that a
      // listing outside the caller's scope exists.
      expect(textOf(unknown).replace('does-not-exist', 'X')).toBe(textOf(forbidden).replace('listing-1', 'X'));
    });

    it('rejects an unauthenticated call', async () => {
      const res = await handler({ listingId: 'listing-1', status: 'rejected' }, {});
      expect(res.isError).toBe(true);
      expect(storage.statusCalls).toEqual([]);
    });
  });

  describe('set_listing_notes', () => {
    let handler;
    beforeEach(() => {
      const server = fakeServer();
      mod.registerWriteTools(server, { FREDY_MCP_WRITE_ENABLED: 'true' });
      handler = server.tools.get('set_listing_notes');
    });

    it('stores the note and reports it back', async () => {
      const res = await handler({ listingId: 'listing-1', notes: 'Besichtigung Fr 15:00' }, asUser('user-michel'));
      expect(storage.notesCalls).toEqual([{ id: 'listing-1', notes: 'Besichtigung Fr 15:00' }]);
      expect(textOf(res)).toContain('Besichtigung Fr 15:00');
    });

    it('clears the note on an empty string', async () => {
      await handler({ listingId: 'listing-1', notes: '' }, asUser('user-michel'));
      expect(storage.notesCalls).toEqual([{ id: 'listing-1', notes: '' }]);
    });

    it('refuses a non-admin writing to someone else\'s listing', async () => {
      const res = await handler({ listingId: 'listing-1', notes: 'nope' }, asUser('user-johannes'));
      expect(res.isError).toBe(true);
      expect(storage.notesCalls).toEqual([]);
    });
  });

  describe('set_listing_watch', () => {
    let handler;
    beforeEach(() => {
      const server = fakeServer();
      mod.registerWriteTools(server, { FREDY_MCP_WRITE_ENABLED: 'true' });
      handler = server.tools.get('set_listing_watch');
    });

    it('watches for the authenticated user by default', async () => {
      const res = await handler({ listingId: 'listing-1', watched: true }, asUser('user-michel'));
      expect(storage.watchCreates).toEqual([{ listingId: 'listing-1', userId: 'user-michel' }]);
      expect(textOf(res)).toContain('**Watched:** yes');
    });

    it('unwatches when watched is false', async () => {
      await handler({ listingId: 'listing-1', watched: false }, asUser('user-michel'));
      expect(storage.watchDeletes).toEqual([{ listingId: 'listing-1', userId: 'user-michel' }]);
      expect(storage.watchCreates).toEqual([]);
    });

    it('lets an admin write to another user\'s list via forUser', async () => {
      const res = await handler(
        { listingId: 'listing-1', watched: true, forUser: 'michel' },
        asUser('svc-hermes'),
      );
      expect(storage.watchCreates).toEqual([{ listingId: 'listing-1', userId: 'user-michel' }]);
      expect(textOf(res)).toContain('**Watch list of:** michel');
    });

    it('resolves forUser by user ID as well as username', async () => {
      await handler({ listingId: 'listing-1', watched: true, forUser: 'user-alina' }, asUser('svc-hermes'));
      expect(storage.watchCreates).toEqual([{ listingId: 'listing-1', userId: 'user-alina' }]);
    });

    it('rejects an unknown forUser without writing', async () => {
      const res = await handler({ listingId: 'listing-1', watched: true, forUser: 'nobody' }, asUser('svc-hermes'));
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('Unknown user');
      expect(storage.watchCreates).toEqual([]);
    });
  });

  describe('resolveWatchTarget', () => {
    it('defaults to the authenticated user', () => {
      const t = mod.resolveWatchTarget({ id: 'user-michel', isAdmin: false }, undefined);
      expect(t).toEqual({ userId: 'user-michel', label: 'you', error: null });
    });

    it('refuses a non-admin targeting someone else', () => {
      const t = mod.resolveWatchTarget({ id: 'user-johannes', isAdmin: false }, 'michel');
      expect(t.userId).toBeNull();
      expect(t.error).toMatch(/Only admins/);
    });

    it('matches usernames case-insensitively', () => {
      const t = mod.resolveWatchTarget({ id: 'svc-hermes', isAdmin: true }, 'MICHEL');
      expect(t.userId).toBe('user-michel');
    });
  });

  describe('isWriteEnabled', () => {
    it('is false by default and true only for the exact string "true"', () => {
      expect(mod.isWriteEnabled({})).toBe(false);
      expect(mod.isWriteEnabled({ FREDY_MCP_WRITE_ENABLED: 'false' })).toBe(false);
      expect(mod.isWriteEnabled({ FREDY_MCP_WRITE_ENABLED: 'TRUE' })).toBe(false);
      expect(mod.isWriteEnabled({ FREDY_MCP_WRITE_ENABLED: 'true' })).toBe(true);
    });
  });
});
