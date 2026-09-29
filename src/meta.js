/**
 * meta.js — thin client for Meta's official Graph API.
 *
 * Endpoints used (verified against Meta developer docs):
 *
 * Instagram private reply (one per comment, within 7 days of the comment):
 *   POST /{IG_USER_ID}/messages
 *   { "recipient": { "comment_id": "<COMMENT_ID>" },
 *     "message": { "text": "<TEXT>" } }
 *   Doc: https://developers.facebook.com/documentation/instagram-platform/private-replies/
 *
 * Instagram follow-up DM (only inside the 24h user-initiated window):
 *   POST /{IG_USER_ID}/messages
 *   { "recipient": { "id": "<IGSID>" }, "message": { "text": "<TEXT>" } }
 *
 * Facebook private reply to a comment:
 *   POST /{COMMENT_ID}/private_replies
 *   { "message": "<TEXT>" }
 *   Doc: https://developers.facebook.com/docs/messenger-platform/reference/private-replies
 *
 * Facebook follow-up message (only inside the 24h window):
 *   POST /{PAGE_ID}/messages
 *   { "recipient": { "id": "<PSID>" }, "messaging_type": "RESPONSE",
 *     "message": { "text": "<TEXT>" } }
 *
 * Auth: Page access token in the Authorization header.
 * Throughput ceilings (official, NOT a permission to send unsolicited
 * messages — https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview/rate-limiting):
 *   private replies to IG post/reel comments: 750 calls/hour per Page and
 *   per Instagram Professional account.
 */
import { config, GRAPH } from './config.js';

// --- simple rolling-window send pacing (safety, not a Meta guarantee) -------
const sendTimes = [];
function pacingAllows() {
  const now = Date.now();
  while (sendTimes.length && now - sendTimes[0] > 60_000) sendTimes.shift();
  if (sendTimes.length >= config.SENDS_PER_MINUTE_LIMIT) return false;
  sendTimes.push(now);
  return true;
}

async function graphCall(label, path, body) {
  if (!pacingAllows()) {
    console.warn(`[meta] pacing limit hit, dropping ${label}`);
    return { ok: false, error: 'pacing_limit' };
  }
  if (config.DRY_RUN) {
    console.log(`[DRY_RUN] would POST ${GRAPH}${path}`);
    console.log(`[DRY_RUN] body: ${JSON.stringify(body)}`);
    return { ok: true, dry_run: true };
  }
  const res = await fetch(`${GRAPH}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.PAGE_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || { message: `HTTP ${res.status}` };
    console.error(`[meta] ${label} failed:`, e.message, `(code ${e.code || '?'})`);
    if (e.code === 190) console.error('[meta] token invalid/expired — regenerate PAGE_ACCESS_TOKEN');
    return { ok: false, data: undefined };
  }
  return { ok: true, data };
}

async function graphGet(path) {
  const res = await fetch(`${GRAPH}${path}`, {
    headers: { Authorization: `Bearer ${config.PAGE_ACCESS_TOKEN}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return data;
}

// --- Instagram ---------------------------------------------------------------
export async function igPrivateReply({ igUserId, commentId, text }) {
  return graphCall('igPrivateReply', `/${igUserId}/messages`, {
    recipient: { comment_id: commentId },
    message: { text },
  });
}

export async function igSendMessage({ igUserId, recipientId, text }) {
  return graphCall('igSendMessage', `/${igUserId}/messages`, {
    recipient: { id: recipientId },
    message: { text },
  });
}

/** Fetch a comment's creation timestamp to enforce the 7-day private-reply window. */
export async function igCommentTimestamp(commentId) {
  if (config.DRY_RUN) {
    console.log('[DRY_RUN] skipping comment-timestamp fetch, assuming fresh');
    return Date.now();
  }
  const data = await graphGet(`/${commentId}?fields=timestamp`);
  return new Date(data.timestamp).getTime();
}

// --- Facebook ----------------------------------------------------------------
export async function fbPrivateReply({ commentId, text }) {
  return graphCall('fbPrivateReply', `/${commentId}/private_replies`, { message: text });
}

export async function fbSendMessage({ pageId, recipientId, text }) {
  return graphCall('fbSendMessage', `/${pageId}/messages`, {
    recipient: { id: recipientId },
    messaging_type: 'RESPONSE',
    message: { text },
  });
}

export async function fbCommentTimestamp(commentId) {
  if (config.DRY_RUN) {
    console.log('[DRY_RUN] skipping comment-timestamp fetch, assuming fresh');
    return Date.now();
  }
  const data = await graphGet(`/${commentId}?fields=created_time`);
  return new Date(data.created_time).getTime() * 1; // created_time is ISO-8601
}

// --- optional public reply under the triggering comment (off by default) ------
export async function fbPublicReply({ commentId, text }) {
  return graphCall('fbPublicReply', `/${commentId}/comments`, { message: text });
}
export async function igPublicReply({ commentId, text }) {
  return graphCall('igPublicReply', `/${commentId}/replies`, { text });
}
