import axios from 'axios';
import config from '../config/index.js';

/**
 * Persist incoming LINE message events to the GitHub repository as one JSON
 * file per message, so Muse can read them later. The webhook itself stays
 * the only intake; this is the durable store the webhook never had.
 *
 * Auth comes from the GITHUB_TOKEN environment variable only. No token or
 * secret is ever written into code or files.
 */

const instance = axios.create({
  baseURL: 'https://api.github.com',
  timeout: 9 * 1000,
  headers: {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  },
});

/**
 * @param {Object} event Raw LINE webhook event
 * @returns {Object} The record stored as messages/<messageId>.json
 */
const buildMessageRecord = (event) => ({
  messageId: event.message?.id ?? null,
  timestamp: event.timestamp ?? null,
  sourceUserId: event.source?.userId ?? null,
  sourceType: event.source?.type ?? null,
  replyToken: event.replyToken ?? null,
  messageType: event.message?.type ?? null,
  text: event.message?.type === 'text' ? (event.message.text ?? null) : null,
  event,
});

/**
 * Save one LINE message event as messages/<messageId>.json via the GitHub
 * Contents API. Best effort only: every failure is logged and swallowed,
 * so a persistence problem can never break the webhook (LINE always gets
 * its 200). If the file already exists (LINE redelivered the event), the
 * existing blob SHA is fetched and the file is overwritten.
 *
 * @param {Object} event Raw LINE webhook event
 * @returns {Promise<void>}
 */
const saveMessageEvent = async (event) => {
  if (!config.GITHUB_TOKEN) return;
  const [owner, repo] = (config.GITHUB_REPO || '').split('/');
  if (!owner || !repo) {
    console.error('[github] GITHUB_REPO is not in "owner/repo" format');
    return;
  }
  const record = buildMessageRecord(event);
  if (!record.messageId) {
    console.error('[github] message event has no message id, skip saving');
    return;
  }
  const path = `messages/${encodeURIComponent(record.messageId)}.json`;
  const url = `/repos/${owner}/${repo}/contents/${path}`;
  const headers = { Authorization: `Bearer ${config.GITHUB_TOKEN}` };
  const params = config.GITHUB_BRANCH ? { ref: config.GITHUB_BRANCH } : undefined;
  const content = Buffer.from(JSON.stringify(record, null, 2)).toString('base64');
  const body = {
    message: `Save LINE message ${record.messageId}`,
    content,
  };
  if (config.GITHUB_BRANCH) body.ref = config.GITHUB_BRANCH;
  try {
    await instance.put(url, body, { headers, params });
  } catch (err) {
    if (err.response?.status !== 422) {
      console.error(`[github] failed to save message ${record.messageId}:`, err.message);
      return;
    }
    try {
      const { data } = await instance.get(url, { headers, params });
      await instance.put(url, { ...body, sha: data.sha }, { headers, params });
    } catch (retryErr) {
      console.error(`[github] failed to save message ${record.messageId}:`, retryErr.message);
    }
  }
};

export {
  buildMessageRecord,
  saveMessageEvent,
};

export default saveMessageEvent;
