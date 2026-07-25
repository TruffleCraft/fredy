/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import cron from 'node-cron';
import { getListingsToGeocode, updateListingGeocoordinates } from '../storage/listingsStorage.js';
import { geocodeAddress, isGeocodingPaused } from '../geocoding/geoCodingService.js';
import { getJobs } from '../storage/jobStorage.js';
import { calculateDistanceForJob } from '../geocoding/distanceService.js';
import { getSettings } from '../storage/settingsStorage.js';
import logger from '../logger.js';

export async function runGeoCordTask() {
  const listings = getListingsToGeocode();
  if (listings.length > 0) {
    for (const listing of listings) {
      if (isGeocodingPaused()) {
        break;
      }

      const coords = await geocodeAddress(listing.address);
      // geocodeAddress reports "address not found" as { lat: -1, lng: -1 }, which is
      // truthy. Storing it would be worse than storing nothing: the sentinel is a real
      // point in the South Atlantic, so the listing gets treated as outside every drawn
      // area, and because latitude is no longer NULL getListingsToGeocode() never picks
      // it up again - the bogus coordinate becomes permanent. Skip it and retry next run,
      // matching the guard in FredyPipelineExecutioner._geocode.
      if (coords && coords.lat !== -1 && coords.lng !== -1) {
        updateListingGeocoordinates(listing.id, coords.lat, coords.lng);
      }
    }
  }

  //additional run
  const jobs = getJobs();
  for (const job of jobs) {
    calculateDistanceForJob(job.id, job.userId);
  }
}

export async function initGeocodingCron() {
  const settings = await getSettings();
  if (settings.demoMode) {
    logger.info('Do not start geo service as we are in demo mode');
    return;
  }
  // run directly on start
  await runGeoCordTask();
  // then every 6 hours
  cron.schedule('0 */6 * * *', runGeoCordTask);
}
