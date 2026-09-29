/**
 * webhook.js — normalize Meta webhook payloads into internal events.
 *
 * Shapes handled (per Meta's webhook docs):
 *
 * 1) Instagram comment  — object "instagram", field "comments":
 *      entry[].field === 'comments'
 *      entry[].value = { id, from: { id, username }, text,
 *                        media: { id, media_product_type } }
 *    Doc: https://developers.facebook.com/documentation/instagram-platform/webhooks/examples
 *
 * 2) Instagram DM — object "instagram", field "messages":
 *      entry[].messaging[] = { sender: { id }, recipient: { id },
 *                              timestamp, message: { mid, text, is_echo, ... } }
 *
 * 3) Facebook comment — object "page", changes[].field === "feed":
 *      change.value = { item: 'comment', verb: 'add', comment_id, post_id,
 *                       from: { id, name }, message, created_time }
 *
 * 4) Facebook message — object "page":
 *      entry[].messaging[] = { sender: { id }, recipient: { id },
 *                              timestamp, message: { mid, text, is_echo } }
 *
 * Normalized events:
 *   { kind: 'comment', platform: 'ig'|'fb', commentId, senderId, name,
 *     text, ts, ownerId }
 *   { kind: 'message', platform: 'ig'|'fb', senderId, name, mid,
 *     text, ts, ownerId }
 *
 * Echoes (our own sends), deleted and non-text messages are dropped.
 */

function toMs(ts) {
  if (ts == null) return Date.now();
  const n = Number(ts);
  if (!Number.isFinite(n)) return Date.now();
  return n > 1e12 ? n : n * 1000; // Meta mixes seconds and ms
}

export function parseWebhook(body) {
  const events = [];
  if (!body || !Array.isArray(body.entry)) return events;

  for (const entry of body.entry) {
    const ownerId = entry.id;

    if (body.object === 'instagram') {
      // --- IG comment (field/value directly on entry) ---
      if (entry.field === 'comments' || entry.field === 'live_comments') {
        const v = entry.value || {};
        if (entry.field === 'live_comments') {
          console.log('[webhook] ignoring live_comments event (not supported by funnel)');
          continue;
        }
        events.push({
          kind: 'comment',
          platform: 'ig',
          commentId: v.id,
          senderId: v.from?.id,
          name: v.from?.username,
          text: v.text,
          ts: toMs(entry.time),
          ownerId,
        });
        continue;
      }
      // --- IG DM ---
      for (const m of entry.messaging || []) {
        const msg = m.message || {};
        if (msg.is_echo || msg.is_deleted || typeof msg.text !== 'string') continue;
        events.push({
          kind: 'message',
          platform: 'ig',
          senderId: m.sender?.id,
          mid: msg.mid,
          text: msg.text,
          ts: toMs(m.timestamp),
          ownerId,
        });
      }
    } else if (body.object === 'page') {
      // --- FB comment via feed changes ---
      for (const change of entry.changes || []) {
        if (change.field !== 'feed') continue;
        const v = change.value || {};
        if (v.item !== 'comment' || v.verb !== 'add' || !v.comment_id) continue;
        events.push({
          kind: 'comment',
          platform: 'fb',
          commentId: v.comment_id,
          senderId: v.from?.id,
          name: v.from?.name,
          text: v.message,
          ts: toMs(v.created_time),
          ownerId,
        });
      }
      // --- FB Messenger DM ---
      for (const m of entry.messaging || []) {
        const msg = m.message || {};
        if (msg.is_echo || msg.is_deleted || typeof msg.text !== 'string') continue;
        events.push({
          kind: 'message',
          platform: 'fb',
          senderId: m.sender?.id,
          mid: msg.mid,
          text: msg.text,
          ts: toMs(m.timestamp),
          ownerId,
        });
      }
    } else {
      console.log('[webhook] ignoring object:', body.object);
    }
  }
  return events;
}
