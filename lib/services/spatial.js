/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';

/** @import { SpatialFilter } from '../types/filter.js' */

/**
 * Extract the Polygon features from a job's spatial filter (GeoJSON FeatureCollection).
 *
 * @param {SpatialFilter | null | undefined} spatialFilter
 * @returns {object[]} Array of GeoJSON Polygon features (empty if none).
 */
export function getPolygonFeatures(spatialFilter) {
  return spatialFilter?.features?.filter((f) => f.geometry?.type === 'Polygon') ?? [];
}

/**
 * Decide whether a single listing lies within a job's spatial filter.
 *
 * Single source of truth for the point-in-polygon decision, shared by the crawl
 * pipeline (_filterByArea) and the read path (queryListings via the MCP adapter).
 *
 * @param {{ latitude?: number|null, longitude?: number|null }} listing
 * @param {SpatialFilter | null | undefined} spatialFilter
 * @param {{ failOpenNoCoord?: boolean }} [options] failOpenNoCoord keeps listings
 *        without coordinates (default true) instead of dropping them.
 * @returns {boolean} true if the listing should be kept.
 */
export function isListingInSpatialFilter(listing, spatialFilter, { failOpenNoCoord = true } = {}) {
  const polygonFeatures = getPolygonFeatures(spatialFilter);
  // No polygon set -> no spatial constraint, keep everything.
  if (!polygonFeatures.length) {
    return true;
  }
  // No coordinates -> cannot test; keep or drop based on failOpenNoCoord.
  if (listing.latitude == null || listing.longitude == null) {
    return failOpenNoCoord;
  }
  const point = [listing.longitude, listing.latitude]; // GeoJSON format: [lon, lat]
  return polygonFeatures.some((feature) => booleanPointInPolygon(point, feature));
}
