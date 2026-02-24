#!/usr/bin/env node
// Verify TLC locality coverage
// This script checks that all localities from the TLC website are mapped

import fetch from 'node-fetch';
import { getAllLocalities } from './scrapers/tlc-localities.js';

async function verifyLocalityCoverage() {
  console.log('🔍 Verifying TLC Locality Coverage\n');

  // Fetch homepage to extract localities
  const response = await fetch('https://ifstlc.tvd.co.nz/');
  const html = await response.text();
  
  // Extract localities from the dropdown menus
  const localityMatches = html.matchAll(/locality=([^"&]+)/g);
  const websiteLocalities = [...new Set([...localityMatches].map(m => decodeURIComponent(m[1])))].sort();
  
  // Get mapped localities
  const mappedLocalities = getAllLocalities().sort();
  
  console.log(`📍 Localities from website: ${websiteLocalities.length}`);
  console.log(`🗺️  Localities mapped: ${mappedLocalities.length}\n`);
  
  // Check for missing localities
  const missing = websiteLocalities.filter(l => !mappedLocalities.includes(l));
  const extra = mappedLocalities.filter(l => !websiteLocalities.includes(l));
  
  if (missing.length === 0 && extra.length === 0) {
    console.log('✅ Perfect match! All localities are mapped.\n');
  } else {
    if (missing.length > 0) {
      console.log('❌ Missing localities (need to add):');
      missing.forEach(l => console.log(`   - ${l}`));
      console.log();
    }
    if (extra.length > 0) {
      console.log('⚠️  Extra localities (not on website):');
      extra.forEach(l => console.log(`   - ${l}`));
      console.log();
    }
  }
  
  // List all localities
  console.log('📋 Complete list of TLC localities:');
  websiteLocalities.forEach((l, i) => {
    const status = mappedLocalities.includes(l) ? '✅' : '❌';
    console.log(`   ${i + 1}. ${status} ${l}`);
  });
  
  return missing.length === 0;
}

// Run verification
verifyLocalityCoverage()
  .then(success => process.exit(success ? 0 : 1))
  .catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
