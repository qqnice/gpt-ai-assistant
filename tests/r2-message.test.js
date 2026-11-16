import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import { buildMessageRecord } from '../services/r2.js';
import { COMMAND_COMMAND } from '../constants/command.js';
import { createEvents, TIMEOUT, USER_ID_01 } from './utils.js';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(function S3ClientMock() {
    this.send = mockSend;
  }),
  PutObjectCommand: jest.fn().mockImplementation(function PutObjectCommandMock(input) {
    this.input = input;
  }),
  GetObjectCommand: jest.fn().mockImplementation(function GetObjectCommandMock(input) {
    this.input = input;
  }),
  ListObjectsV2Command: jest.fn().mockImplementation(function ListObjectsV2CommandMock(input) {
    this.input = input;
  }),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(async () => 'https://presigned.example/attachments/2.jpg'),
}));

const RAW_EVENT = {
  type: 'message',
  mode: 'active',
  timestamp: 1794823000000,
  source: { type: 'user', userId: 'U1234567890abcdef' },
  replyToken: 'reply-token',
  message: {
    id: '1234567890', type: 'text', quoteToken: 'quote-token', text: 'hello',
  },
};

const IMAGE_EVENT = {
  ...RAW_EVENT,
  message: { id: '1234567891', type: 'image' },
};

const setR2Env = () => {
  process.env.R2_ENDPOINT = 'https://test-account.r2.cloudflarestorage.com';
  process.env.R2_BUCKET = 'test-bucket';
  process.env.R2_ACCESS_KEY_ID = 'test-key-id';
  process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
};

const clearR2Env = () => {
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_BUCKET;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.MUSE_READ_SECRET;
};

const originalFetch = global.fetch;

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
});

afterEach(() => {
  clearR2Env();
  global.fetch = originalFetch;
  jest.resetModules();
});

test('buildMessageRecord keeps the fields Muse needs', () => {
  const record = buildMessageRecord(RAW_EVENT);
  expect(record.messageId).toEqual('1234567890');
  expect(record.timestamp).toEqual(1794823000000);
  expect(record.sourceUserId).toEqual('U1234567890abcdef');
  expect(record.sourceType).toEqual('user');
  expect(record.replyToken).toEqual('reply-token');
  expect(record.messageType).toEqual('text');
  expect(record.text).toEqual('hello');
  expect(record.attachmentKey).toBeNull();
  expect(record.event).toEqual(RAW_EVENT);
});

test('buildMessageRecord tolerates non-text messages', () => {
  const record = buildMessageRecord(IMAGE_EVENT);
  expect(record.messageId).toEqual('1234567891');
  expect(record.messageType).toEqual('image');
  expect(record.text).toBeNull();
});

describe('saveMessageEvent', () => {
  test('text message is stored as messages/<messageId>.json', async () => {
    setR2Env();
    const { saveMessageEvent } = await import('../services/r2.js');
    await saveMessageEvent(RAW_EVENT);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const put = mockSend.mock.calls[0][0];
    expect(put.input.Bucket).toEqual('test-bucket');
    expect(put.input.Key).toEqual('messages/1234567890.json');
    expect(put.input.ContentType).toEqual('application/json');
    const stored = JSON.parse(put.input.Body);
    expect(stored.messageId).toEqual('1234567890');
    expect(stored.text).toEqual('hello');
    expect(stored.attachmentKey).toBeNull();
  });

  test('image message downloads the attachment and records its R2 key', async () => {
    setR2Env();
    global.fetch = jest.fn(async () => ({
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => new ArrayBuffer(8),
    }));
    const { saveMessageEvent } = await import('../services/r2.js');
    await saveMessageEvent(IMAGE_EVENT);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api-data.line.me/v2/bot/message/1234567891/content',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Bearer /),
        }),
      }),
    );
    const puts = mockSend.mock.calls.map((call) => call[0].input);
    expect(puts).toHaveLength(2);
    const attachment = puts.find((input) => input.Key.startsWith('attachments/'));
    expect(attachment.Key).toEqual('attachments/1234567891.jpg');
    expect(attachment.ContentType).toEqual('image/jpeg');
    const record = puts.find((input) => input.Key.startsWith('messages/'));
    expect(JSON.parse(record.Body).attachmentKey).toEqual('attachments/1234567891.jpg');
  });

  test('attachment download failure still saves the message record', async () => {
    setR2Env();
    global.fetch = jest.fn(async () => ({ ok: false, status: 404 }));
    const { saveMessageEvent } = await import('../services/r2.js');
    await saveMessageEvent(IMAGE_EVENT);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const put = mockSend.mock.calls[0][0];
    expect(put.input.Key).toEqual('messages/1234567891.json');
    expect(JSON.parse(put.input.Body).attachmentKey).toBeNull();
  });

  test('when R2 is not configured, saving is silently skipped', async () => {
    const { saveMessageEvent } = await import('../services/r2.js');
    await saveMessageEvent(RAW_EVENT);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('listMessages', () => {
  const storedRecords = {
    'messages/1.json': {
      messageId: '1', timestamp: 1000, messageType: 'text', text: 'first', attachmentKey: null,
    },
    'messages/2.json': {
      messageId: '2', timestamp: 2000, messageType: 'image', text: null, attachmentKey: 'attachments/2.jpg',
    },
    'messages/3.json': {
      messageId: '3', timestamp: 3000, messageType: 'text', text: 'third', attachmentKey: null,
    },
  };

  const mockListAndGet = () => {
    mockSend.mockImplementation(async (command) => {
      const input = command.input || {};
      if (input.Prefix) {
        return {
          Contents: [
            { Key: 'messages/3.json' },
            { Key: 'messages/1.json' },
            { Key: 'messages/2.json' },
          ],
        };
      }
      return {
        Body: {
          transformToString: async () => JSON.stringify(storedRecords[input.Key]),
        },
      };
    });
  };

  test('returns records sorted by timestamp with presigned attachment URLs', async () => {
    setR2Env();
    mockListAndGet();
    const { listMessages } = await import('../services/r2.js');
    const messages = await listMessages({});
    expect(messages.map((record) => record.messageId)).toEqual(['1', '2', '3']);
    expect(messages[1].attachmentUrl).toEqual('https://presigned.example/attachments/2.jpg');
    expect(messages[0].attachmentUrl).toBeUndefined();
  });

  test('since filters out older records', async () => {
    setR2Env();
    mockListAndGet();
    const { listMessages } = await import('../services/r2.js');
    const messages = await listMessages({ since: new Date(1500).toISOString() });
    expect(messages.map((record) => record.messageId)).toEqual(['2', '3']);
  });

  test('limit keeps the newest records', async () => {
    setR2Env();
    mockListAndGet();
    const { listMessages } = await import('../services/r2.js');
    const messages = await listMessages({ limit: 1 });
    expect(messages.map((record) => record.messageId)).toEqual(['3']);
  });
});

describe('GET /messages handler', () => {
  const makeRes = () => {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
  };

  test('wrong secret answers 401', async () => {
    process.env.MUSE_READ_SECRET = 'correct-secret';
    const { default: handleListMessages } = await import('../api/messages.js');
    const res = makeRes();
    await handleListMessages(
      { headers: { 'x-muse-secret': 'wrong-secret' }, query: {} },
      res,
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'unauthorized' });
  });

  test('missing secret answers 401', async () => {
    process.env.MUSE_READ_SECRET = 'correct-secret';
    const { default: handleListMessages } = await import('../api/messages.js');
    const res = makeRes();
    await handleListMessages({ headers: {}, query: {} }, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('correct secret lists messages', async () => {
    setR2Env();
    process.env.MUSE_READ_SECRET = 'correct-secret';
    mockSend.mockImplementation(async (command) => {
      const input = command.input || {};
      if (input.Prefix) return { Contents: [{ Key: 'messages/1.json' }] };
      return {
        Body: {
          transformToString: async () => JSON.stringify({
            messageId: '1', timestamp: 1000, messageType: 'text', text: 'first', attachmentKey: null,
          }),
        },
      };
    });
    const { default: handleListMessages } = await import('../api/messages.js');
    const res = makeRes();
    await handleListMessages(
      { headers: { 'x-muse-secret': 'correct-secret' }, query: {} },
      res,
    );
    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      messages: [expect.objectContaining({ messageId: '1', text: 'first' })],
    });
  });

  test('correct secret but unconfigured R2 answers 503', async () => {
    process.env.MUSE_READ_SECRET = 'correct-secret';
    const { default: handleListMessages } = await import('../api/messages.js');
    const res = makeRes();
    await handleListMessages(
      { headers: { 'x-muse-secret': 'correct-secret' }, query: {} },
      res,
    );
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

describe('MUSE_TAKEOVER', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('when true, message events are stored only and get no GPT reply', async () => {
    process.env.MUSE_TAKEOVER = 'true';
    const { handleEvents } = await import('../app/index.js');
    const results = await handleEvents(createEvents([COMMAND_COMMAND.text], USER_ID_01));
    expect(results).toEqual([]);
    delete process.env.MUSE_TAKEOVER;
  }, TIMEOUT);

  test('when false, command events still get a GPT reply', async () => {
    delete process.env.MUSE_TAKEOVER;
    const { handleEvents } = await import('../app/index.js');
    const results = await handleEvents(createEvents([COMMAND_COMMAND.text], USER_ID_01));
    expect(results.length).toEqual(1);
    expect(results[0].messages.length).toBeGreaterThan(0);
  }, TIMEOUT);
});
