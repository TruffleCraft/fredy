/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * MCP Write Tools
 *
 * Exposes the listing triage actions that already exist in the storage and REST
 * layers (status, notes, watch list) to MCP clients, so an assistant can record
 * decisions without falling back to the UI or raw SQL.
 *
 * Two safety properties hold for every tool in here:
 *
 * 1. Opt-in. Nothing is registered unless `FREDY_MCP_WRITE_ENABLED=true`. An
 *    existing deployment therefore keeps its read-only MCP surface across an
 *    upgrade, and a leaked token stays read-only until an operator decides
 *    otherwise.
 * 2. Scoped. Every tool resolves the listing through `getListingById(id, userId,
 *    isAdmin)`, which applies the job ownership/sharing filter in SQL. A user who
 *    cannot see a listing cannot write to it, and the tools report "not found"
 *    rather than confirming the ID exists.
 *
 * Every tool re-reads the listing after writing and reports the persisted value,
 * so callers can verify the outcome instead of trusting a bare acknowledgement.
 */

import { z } from 'zod';
import { getListingById, setListingNotes, setListingStatus } from '../services/storage/listingsStorage.js';
import { createWatch, deleteWatch } from '../services/storage/watchListStorage.js';
import { getUsers } from '../services/storage/userStorage.js';
import { authenticateToolCall } from './mcpAuthentication.js';
import { formatDate, normalizeError, normalizeWriteResult } from './mcpNormalizer.js';

/** Status values accepted by the storage layer, plus `none` to clear. */
const STATUS_VALUES = ['applied', 'rejected', 'accepted', 'none'];

/**
 * Whether the MCP write tools should be registered.
 *
 * Defaults to false: enabling writes is an explicit operator decision, never a
 * side effect of upgrading.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean}
 */
export function isWriteEnabled(env = process.env) {
  return env.FREDY_MCP_WRITE_ENABLED === 'true';
}

/**
 * Load a listing the user is allowed to act on.
 *
 * `getListingById` scopes non-admins to their own and shared jobs, so a missing
 * result covers both "no such listing" and "not yours". Both are reported
 * identically on purpose - a write tool should not confirm the existence of
 * listings outside the caller's scope.
 *
 * @param {string} listingId
 * @param {{ id: string, isAdmin: boolean }} user
 * @returns {object|null}
 */
function loadAccessibleListing(listingId, user) {
  if (!listingId) return null;
  return getListingById(listingId, user.id, user.isAdmin);
}

/**
 * Resolve which user a watch entry belongs to.
 *
 * The watch list is per user, while status and notes live on the listing itself.
 * A service account acting on someone's behalf therefore needs to name the
 * target, otherwise the entry lands on the service account's own list where no
 * human will ever see it. Only admins may write to another user's list.
 *
 * @param {{ id: string, isAdmin: boolean }} user The authenticated user.
 * @param {string|undefined} forUser Username or user ID; empty means "self".
 * @returns {{ userId: string, label: string, error: string|null }}
 */
export function resolveWatchTarget(user, forUser) {
  if (!forUser) {
    return { userId: user.id, label: 'you', error: null };
  }
  if (!user.isAdmin) {
    return { userId: null, label: null, error: 'Only admins can manage the watch list of another user.' };
  }
  const needle = String(forUser).trim().toLowerCase();
  const match = getUsers(false).find((u) => u.id.toLowerCase() === needle || u.username.toLowerCase() === needle);
  if (!match) {
    return { userId: null, label: null, error: `Unknown user: ${forUser}` };
  }
  return { userId: match.id, label: match.username, error: null };
}

/**
 * Register the write tools on an MCP server instance.
 *
 * No-op unless `FREDY_MCP_WRITE_ENABLED=true`, which keeps the default MCP
 * surface read-only.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean} Whether the tools were registered.
 */
export function registerWriteTools(server, env = process.env) {
  if (!isWriteEnabled(env)) {
    return false;
  }

  // ── set_listing_status ──────────────────────────────────────────────
  server.tool(
    'set_listing_status',
    'Record a decision about a single listing: applied, rejected or accepted. ' +
      'Use "none" to clear a previously set status. ' +
      'Setting the same status again is safe; only the timestamp changes. ' +
      'Returns the stored status so you can confirm the write landed.',
    {
      listingId: z.string().describe('The listing ID to update (from list_listings or get_listing)'),
      status: z
        .enum(STATUS_VALUES)
        .describe('applied, rejected, accepted, or none to clear the current status'),
    },
    async ({ listingId, status }, extra) => {
      const { user, error } = authenticateToolCall(extra);
      if (error) return normalizeError(error, 'set_listing_status');

      const listing = loadAccessibleListing(listingId, user);
      if (!listing) return normalizeError(`Listing not found: ${listingId}`, 'set_listing_status');

      const next = status === 'none' ? null : status;
      try {
        setListingStatus(listingId, next);
      } catch (err) {
        return normalizeError(err.message, 'set_listing_status');
      }

      const after = loadAccessibleListing(listingId, user);
      return normalizeWriteResult('set_listing_status', `Status updated for "${listing.title || listingId}".`, {
        'Listing ID': listingId,
        Title: listing.title,
        Status: after?.status?.status ?? 'none',
        'Status set at': after?.status?.setAt ? formatDate(after.status.setAt) : null,
      });
    },
  );

  // ── set_listing_notes ───────────────────────────────────────────────
  server.tool(
    'set_listing_notes',
    'Attach a free-text note to a single listing, or clear it by passing an empty string. ' +
      'Notes replace the previous text rather than appending to it. ' +
      'Returns the stored note so you can confirm the write landed.',
    {
      listingId: z.string().describe('The listing ID to update (from list_listings or get_listing)'),
      notes: z.string().describe('The note text to store. An empty string clears the note.'),
    },
    async ({ listingId, notes }, extra) => {
      const { user, error } = authenticateToolCall(extra);
      if (error) return normalizeError(error, 'set_listing_notes');

      const listing = loadAccessibleListing(listingId, user);
      if (!listing) return normalizeError(`Listing not found: ${listingId}`, 'set_listing_notes');

      setListingNotes(listingId, notes);

      const after = loadAccessibleListing(listingId, user);
      return normalizeWriteResult('set_listing_notes', `Notes updated for "${listing.title || listingId}".`, {
        'Listing ID': listingId,
        Title: listing.title,
        Notes: after?.notes ?? 'none',
      });
    },
  );

  // ── set_listing_watch ───────────────────────────────────────────────
  server.tool(
    'set_listing_watch',
    'Add a listing to the watch list, or remove it. ' +
      'The watch list is per user: without forUser the entry belongs to the authenticated account, ' +
      'which for a service token is usually not what a human wants to see. ' +
      'Admins can pass forUser (username or user ID) to manage someone else\'s list. ' +
      'Calling this twice with the same value is safe.',
    {
      listingId: z.string().describe('The listing ID to watch or unwatch'),
      watched: z.boolean().describe('true adds the listing to the watch list, false removes it'),
      forUser: z
        .string()
        .optional()
        .describe('Admin only: username or user ID whose watch list to modify. Defaults to the authenticated user.'),
    },
    async ({ listingId, watched, forUser }, extra) => {
      const { user, error } = authenticateToolCall(extra);
      if (error) return normalizeError(error, 'set_listing_watch');

      const listing = loadAccessibleListing(listingId, user);
      if (!listing) return normalizeError(`Listing not found: ${listingId}`, 'set_listing_watch');

      const target = resolveWatchTarget(user, forUser);
      if (target.error) return normalizeError(target.error, 'set_listing_watch');

      const result = watched ? createWatch(listingId, target.userId) : deleteWatch(listingId, target.userId);
      // createWatch reports whether the row exists now; deleteWatch reports
      // whether a row was removed. Neither is an error when the list was
      // already in the requested state, so report the resulting state.
      const nowWatched = watched ? Boolean(result.created) : false;

      return normalizeWriteResult(
        'set_listing_watch',
        `Watch list for ${target.label} updated for "${listing.title || listingId}".`,
        {
          'Listing ID': listingId,
          Title: listing.title,
          'Watch list of': target.label,
          Watched: nowWatched ? 'yes' : 'no',
        },
      );
    },
  );

  return true;
}
