/**
 * config.js — all configuration comes from environment variables.
 * No secrets are hardcoded anywhere in this project.
 */
import 'node:process';

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var: ${name}`);
  return v.trim();
}
function optional(name, fallback = '') {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

export const config = {
  APP_SECRET: required('APP_SECRET'),
  VERIFY_TOKEN: required('VERIFY_TOKEN'),
  // Page token is not needed in DRY_RUN preview mode.
  PAGE_ACCESS_TOKEN: process.env.DRY_RUN === 'true' ? optional('PAGE_ACCESS_TOKEN') : required('PAGE_ACCESS_TOKEN'),
  IG_BUSINESS_ACCOUNT_ID: optional('IG_BUSINESS_ACCOUNT_ID'),
  PAGE_ID: optional('PAGE_ID'),
  API_VERSION: optional('API_VERSION', 'v24.0'),
  PORT: parseInt(optional('PORT', '3000'), 10),
  DRY_RUN: process.env.DRY_RUN === 'true',
  SENDS_PER_MINUTE_LIMIT: parseInt(optional('SENDS_PER_MINUTE_LIMIT', '30'), 10),
  // Platform toggles — set to 'false' to disable a platform entirely.
  // (Instagram funnel runs on InstantDM; this server handles Facebook.)
  ENABLE_IG: optional('ENABLE_IG', 'true') !== 'false',
  ENABLE_FB: optional('ENABLE_FB', 'true') !== 'false',
  PUBLIC_REPLY_TEXT: optional('PUBLIC_REPLY_TEXT'),
  STATE_PATH: optional('STATE_PATH', new URL('../state.json', import.meta.url).pathname),
  LEADS_PATH: optional('LEADS_PATH', new URL('../leads.jsonl', import.meta.url).pathname),
};

export const GRAPH = `https://graph.facebook.com/${config.API_VERSION}`;
