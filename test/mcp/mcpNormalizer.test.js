/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect } from 'vitest';
import { normalizeGetListing, normalizeWriteResult } from '../../lib/mcp/mcpNormalizer.js';

const textOf = (result) => result.content.map((c) => c.text).join('\n');

describe('normalizeGetListing', () => {
  const listing = {
    id: 'abc123',
    title: 'Rigaer Str. 71',
    address: 'Rigaer Str. 71, Berlin',
    price: 1175,
    size: 49,
    provider: 'kleinanzeigen',
    is_active: 1,
    created_at: 1772008362564,
  };

  it('reports the stored note so a caller can append to it', () => {
    // set_listing_notes replaces the note, so the read path must expose the
    // current text - otherwise appending feedback to an existing note is
    // impossible without direct DB access.
    const md = textOf(normalizeGetListing({ ...listing, notes: 'Besichtigung Fr 15:00' }));
    expect(md).toContain('**Notes:** Besichtigung Fr 15:00');
  });

  it('renders a placeholder when no note is set', () => {
    const md = textOf(normalizeGetListing({ ...listing, notes: null }));
    expect(md).toContain('**Notes:** –');
  });

  it('reports status and the time it was set', () => {
    const md = textOf(normalizeGetListing({ ...listing, status: { status: 'rejected', setAt: 1772008362564 } }));
    expect(md).toContain('**Status:** rejected');
    expect(md).toMatch(/\*\*Status set at:\*\* \d{4}-\d{2}-\d{2}/);
  });
});

describe('normalizeWriteResult', () => {
  it('marks the response OK and lists the persisted fields', () => {
    const md = textOf(normalizeWriteResult('set_listing_status', 'Status updated.', { Status: 'applied' }));
    expect(md).toContain('**Tool:** set_listing_status | **Status:** OK');
    expect(md).toContain('Status updated.');
    expect(md).toContain('- **Status:** applied');
  });

  it('renders null and empty values as a placeholder instead of "null"', () => {
    const md = textOf(normalizeWriteResult('set_listing_notes', 'Cleared.', { Notes: null, Other: '' }));
    expect(md).toContain('- **Notes:** –');
    expect(md).toContain('- **Other:** –');
  });

  it('escapes pipes so a value cannot break the markdown layout', () => {
    const md = textOf(normalizeWriteResult('set_listing_notes', 'Saved.', { Notes: 'a | b' }));
    expect(md).toContain('a \\| b');
  });
});
