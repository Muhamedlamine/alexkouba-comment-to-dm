/**
 * state.js — JSON file persistence for conversation state.
 *
 * Schema:
 * {
 *   "contacts": {
 *     "ig:<senderId>" | "fb:<senderId>": {
 *       platform, name, sender_id, state,
 *       step1_at, last_outbound_at, last_inbound_at, last_inbound_mid,
 *       email, format_asks, email_asks
 *     }
 *   },
 *   "processed_comments": { "<commentId>": "<iso timestamp>" }
 * }
 * States: awaiting_reply, asked_date, asked_format, told_next_date,
 *          collecting_email, done, opted_out  (done / opted_out are terminal)
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { config } from './config.js';

const EMPTY = { contacts: {}, processed_comments: {} };

export function loadState() {
  try {
    if (!existsSync(config.STATE_PATH)) return structuredClone(EMPTY);
    return { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(config.STATE_PATH, 'utf8')) };
  } catch (err) {
    console.error('[state] failed to load, starting empty:', err.message);
    return structuredClone(EMPTY);
  }
}

export function saveState(state) {
  const tmp = config.STATE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, config.STATE_PATH); // atomic-ish replace
}

export const TERMINAL = new Set(['done', 'opted_out']);

export function isTerminal(contact) {
  return !contact || TERMINAL.has(contact.state);
}
