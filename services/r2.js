import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import config from '../config/index.js';

/**
 * Persist incoming LINE message events to Cloudflare R2, so Muse can read
 * them later through GET /messages. The webhook itself stays the only
 * intake; R2 is the durable store the webhook never had. Attachments
 * (image, video, audio, file) are downloaded from LINE and stored next to
 * the message record.
 *
 * Auth comes from environment variables only (R2_ENDPOINT, R2_BUCKET,
 * R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY). No key or secret is ever written
 * into code or files.
 */

const ATTACHMENT_TYPES = new Set(['image', 'video', 'audio', 'file']);

const CONTENT_TYPE_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'application/pdf': 'pdf',
};

const FALLBACK_EXTENSIONS = {
  image: 'jpg',
  video: 'mp4',
  audio: 'm4a',
  file: 'bin',
};

const isConfigured = () => Boolean(
  config.R2_ENDPOINT
  && config.R2_BUCKET
  && config.R2_ACCESS_KEY_ID
  && config.R2_SECRET_ACCESS_KEY,
);

let client = null;

/**
 * @returns {S3Client|null} The R2 client, or null when R2 is not configured.
 */
const getClient = () => {
  if (!isConfigured()) return null;
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: config.R2_ENDPOINT,
      credentials: {
        accessKeyId: config.R2_ACCESS_KEY_ID,
        secretAccessKey: config.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
};

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
  attachmentKey: null,
  event,
});

/**
 * @param {string} contentType Response content type from LINE
 * @param {string} messageType LINE message type
 * @returns {string} File extension without the dot
 */
const extensionFor = (contentType, messageType) => {
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  return CONTENT_TYPE_EXTENSIONS[type]
    || FALLBACK_EXTENSIONS[messageType]
    || 'bin';
};

/**
 * Download a message attachment from LINE.
 *
 * @param {string} messageId LINE message id
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
const downloadContent = async (messageId) => {
  const response = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      headers: {
        Authorization: `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`LINE content download failed: ${response.status}`);
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'application/octet-stream',
  };
};

/**
 * Save one LINE message event as messages/<messageId>.json in R2. Attachment
 * messages also download the binary from LINE and store it as
 * attachments/<messageId>.<ext>, with the R2 key written into the record.
 * Best effort only: every failure is logged and swallowed, so a persistence
 * problem can never break the webhook (LINE always gets its 200). When R2
 * is not configured, saving is silently skipped. Re-saving the same message
 * id (LINE redelivery) simply overwrites the object.
 *
 * @param {Object} event Raw LINE webhook event
 * @returns {Promise<void>}
 */
const saveMessageEvent = async (event) => {
  const s3 = getClient();
  if (!s3) return;
  const record = buildMessageRecord(event);
  if (!record.messageId) {
    console.error('[r2] message event has no message id, skip saving');
    return;
  }
  try {
    if (ATTACHMENT_TYPES.has(record.messageType)) {
      try {
        const { buffer, contentType } = await downloadContent(record.messageId);
        const key = `attachments/${record.messageId}.${extensionFor(contentType, record.messageType)}`;
        await s3.send(new PutObjectCommand({
          Bucket: config.R2_BUCKET,
          Key: key,
          Body: buffer,
          ContentType: contentType,
        }));
        record.attachmentKey = key;
      } catch (err) {
        console.error(`[r2] failed to save attachment ${record.messageId}:`, err.message);
      }
    }
    await s3.send(new PutObjectCommand({
      Bucket: config.R2_BUCKET,
      Key: `messages/${record.messageId}.json`,
      Body: JSON.stringify(record, null, 2),
      ContentType: 'application/json',
    }));
  } catch (err) {
    console.error(`[r2] failed to save message ${record.messageId}:`, err.message);
  }
};

/**
 * List stored message records, oldest first, capped at the newest `limit`
 * records. Records with an attachment also carry a presigned GET URL for
 * the attachment, valid for one hour. Read only; nothing is written.
 *
 * @param {Object} param
 * @param {string} [param.since] ISO timestamp; only records at or after it
 * @param {number} [param.limit] Maximum records to return
 * @returns {Promise<Array<Object>>}
 */
const listMessages = async ({ since, limit = 50 } = {}) => {
  const s3 = getClient();
  if (!s3) throw new Error('R2 is not configured');
  const listed = await s3.send(new ListObjectsV2Command({
    Bucket: config.R2_BUCKET,
    Prefix: 'messages/',
    MaxKeys: 1000,
  }));
  const keys = (listed.Contents || [])
    .map((item) => item.Key)
    .filter((key) => key && key.endsWith('.json'));
  const records = (await Promise.all(keys.map(async (key) => {
    try {
      const object = await s3.send(new GetObjectCommand({
        Bucket: config.R2_BUCKET,
        Key: key,
      }));
      return JSON.parse(await object.Body.transformToString());
    } catch (err) {
      console.error(`[r2] failed to read ${key}:`, err.message);
      return null;
    }
  }))).filter(Boolean);
  const sinceMs = since ? Date.parse(since) : NaN;
  const filtered = Number.isNaN(sinceMs)
    ? records
    : records.filter((record) => (record.timestamp ?? 0) >= sinceMs);
  filtered.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const page = filtered.slice(-limit);
  return Promise.all(page.map(async (record) => {
    if (!record.attachmentKey) return record;
    try {
      const attachmentUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: config.R2_BUCKET,
          Key: record.attachmentKey,
        }),
        { expiresIn: 3600 },
      );
      return { ...record, attachmentUrl };
    } catch (err) {
      console.error(`[r2] failed to sign ${record.attachmentKey}:`, err.message);
      return record;
    }
  }));
};

export {
  buildMessageRecord,
  isConfigured,
  listMessages,
  saveMessageEvent,
};

export default saveMessageEvent;
