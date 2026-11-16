import config from '../config/index.js';
import { saveMessageEvent } from '../services/github.js';
import { EVENT_TYPE_MESSAGE } from '../services/line.js';
import { replyMessage } from '../utils/index.js';
import {
  execActivateCommand,
  execCallCommand,
  execCommandCommand,
  execConfigureCommand,
  execContinueCommand,
  execDeactivateCommand,
  execDeployCommand,
  execDocCommand,
  execDrawCommand,
  execSummarizeCommand,
  execTalkCommand,
  execVersionCommand,
  isActivateCommand,
  isCallCommand,
  isCommand,
  isConfigureCommand,
  isContinueCommand,
  isDeactivateCommand,
  isDeployCommand,
  isDocCommand,
  isDrawCommand,
  isSummarizeCommand,
  isTalkCommand,
  isVersionCommand,
} from './commands/index.js';
import Context from './context.js';
import Event from './event.js';

/**
 * @param {Context} context
 * @returns {Promise<Context>}
 */
const handleContext = async (context) => (
  (isActivateCommand(context) && execActivateCommand(context))
    || (isCommand(context) && execCommandCommand(context))
    || (isConfigureCommand(context) && execConfigureCommand(context))
    || (isContinueCommand(context) && execContinueCommand(context))
    || (isDeactivateCommand(context) && execDeactivateCommand(context))
    || (isDeployCommand(context) && execDeployCommand(context))
    || (isDocCommand(context) && execDocCommand(context))
    || (isDrawCommand(context) && execDrawCommand(context))
    || (isSummarizeCommand(context) && execSummarizeCommand(context))
    || (isVersionCommand(context) && execVersionCommand(context))
    || (await isCallCommand(context) && execCallCommand(context))
    || (await isTalkCommand(context) && execTalkCommand(context))
    || context
);

const handleEvents = async (events = []) => {
  const messageEvents = events.filter((event) => event.type === EVENT_TYPE_MESSAGE);
  // Persist every incoming message before anything else. Saving is best
  // effort: failures are logged inside saveMessageEvent and never break
  // the webhook, so LINE always gets its 200.
  await Promise.all(messageEvents.map((event) => saveMessageEvent(event)));

  // When Muse has taken over, messages are stored only; the GPT bot stays silent.
  if (config.MUSE_TAKEOVER) return [];

  return Promise.all(
    (await Promise.all(
      (await Promise.all(
        events
          .map((event) => new Event(event))
          .filter((event) => event.isMessage)
          .map((event) => new Context(event))
          .map((context) => context.initialize()),
      ))
        .map((context) => handleContext(context)),
    ))
      .filter((context) => context.messages.length > 0)
      .map((context) => replyMessage(context)),
  );
};

export default handleEvents;
