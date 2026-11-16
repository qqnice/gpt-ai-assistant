import {
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import { buildMessageRecord } from '../services/github.js';
import { COMMAND_COMMAND } from '../constants/command.js';
import { createEvents, TIMEOUT, USER_ID_01 } from './utils.js';

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

test('buildMessageRecord keeps the fields Muse needs', () => {
  const record = buildMessageRecord(RAW_EVENT);
  expect(record.messageId).toEqual('1234567890');
  expect(record.timestamp).toEqual(1794823000000);
  expect(record.sourceUserId).toEqual('U1234567890abcdef');
  expect(record.sourceType).toEqual('user');
  expect(record.replyToken).toEqual('reply-token');
  expect(record.messageType).toEqual('text');
  expect(record.text).toEqual('hello');
  expect(record.event).toEqual(RAW_EVENT);
});

test('buildMessageRecord tolerates non-text messages', () => {
  const record = buildMessageRecord({
    ...RAW_EVENT,
    message: { id: '1234567891', type: 'image' },
  });
  expect(record.messageId).toEqual('1234567891');
  expect(record.messageType).toEqual('image');
  expect(record.text).toBeNull();
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
