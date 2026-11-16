import { timingSafeEqual } from 'node:crypto';
import config from '../config/index.js';
import { isConfigured, listMessages } from '../services/r2.js';

/**
 * GET /messages — read-only listing of the LINE messages stored in R2.
 * The caller must send header X-Muse-Secret equal to MUSE_READ_SECRET,
 * otherwise the endpoint answers 401. Query parameters: since (ISO
 * timestamp, optional) and limit (default 50, clamped to 1..200).
 */

const secretsMatch = (provided, expected) => {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

const handleListMessages = async (req, res) => {
  if (!secretsMatch(req.headers['x-muse-secret'], config.MUSE_READ_SECRET)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (!isConfigured()) {
    res.status(503).json({ error: 'message store is not configured' });
    return;
  }
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
  try {
    const messages = await listMessages({ since: req.query.since, limit });
    res.json({ messages });
  } catch (err) {
    console.error('[messages] failed to list messages:', err.message);
    res.status(500).json({ error: 'failed to list messages' });
  }
};

export default handleListMessages;
