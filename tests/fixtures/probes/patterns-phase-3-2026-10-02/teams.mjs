// The phase-3 demo teams' wording, as docs/plans/patterns-phase-3.md specifies it (its "Guidance wording" and
// "Exceptions"): each member's description, prompt, selected tools and its one full-text document, word for word.
// The premise probe (probe.mjs) builds every member's persona from this, since the team folders are built only once
// the plan is ready (PRINCIPLES §19); the plan's A1 then checks the built folders against the plan, and A7 checks
// that the built request of every probed turn equals the request recorded here.

const FILE_TOOLS = ['list_files', 'read_file', 'write_file', 'append_file'];

// The tools last, after `extra`: spread after them, `extra.tools` replaced the four file tools (corrected 2026-10-02, see
// README.md, "The file tools left out of P16's and P23's turns").
const member = (name, description, prompt, doc, extra = {}) => ({ name, description, prompt, doc, ...extra, tools: [...FILE_TOOLS, ...(extra.tools ?? [])] });

export const TEAMS = {
  // P14 · supervisor restart
  restart: [member('worker', 'Says the words it is asked to say.', 'you say the words you are asked to say.', '1. Call reply with exactly the words you are asked to say, and nothing else.\n')],
  // P18 · budgets
  budget: [
    member(
      'ping',
      'Answers every message with ping.',
      'you answer every message by sending ping to pong-1; you never reply to the user.',
      '1. Whatever message you receive — from the user or from pong-1 — call send_message to pong-1 with exactly "ping", and nothing else.\n2. Never call reply.\n',
    ),
    member(
      'pong',
      'Answers every message with pong.',
      'you answer every message by sending pong to ping-1; you never reply to the user.',
      '1. Whatever message you receive — from ping-1 — call send_message to ping-1 with exactly "pong", and nothing else.\n2. Never call reply.\n',
    ),
  ],
  // P22 · publish / subscribe
  topics: [
    member('weather-desk', 'Reports weather news.', 'you report weather news.', '1. For every message you receive, call reply with your handle, then " noted: ", then the message word for word — for example "weather-desk-1 noted: Sunny today." — and nothing else.\n', { topics: ['weather'] }),
    member('sports-desk', 'Reports sports news.', 'you report sports news.', '1. For every message you receive, call reply with your handle, then " noted: ", then the message word for word — for example "sports-desk-1 noted: The race starts at noon." — and nothing else.\n', { topics: ['sports'] }),
    member('front-page', 'Reports all news.', 'you report all news.', '1. For every message you receive, call reply with your handle, then " noted: ", then the message word for word — for example "front-page-1 noted: Sunny today." — and nothing else.\n', { topics: ['weather', 'sports'] }),
  ],
  // P16 · human approval gate
  approval: [
    member(
      'clerk',
      "Posts announcements to the board, only with the user's approval.",
      'you post announcements to the blackboard, each only after the user approves it.',
      "1. When the user writes to you (a message that starts \"The user wrote to you\") asking you to post an announcement, call ask_user with this text, both of its sentences: Approve posting \"<the announcement>\"? Answer yes or no. Call nothing else in that turn: an announcement is never posted before the user answers yes.\n2. When the user's answer comes back (a message that starts \"The user answered\") and it is yes, call blackboard_post with the announcement from your question, word for word; once it is posted, call reply with \"Posted.\" and nothing else.\n3. When the answer is no, call reply with \"Not posted.\" and nothing else; never call blackboard_post.\n",
      { tools: ['blackboard_post', 'ask_user'] },
    ),
  ],
  // P23 · escalation (phase 1's team; phase 3 changes step 2's tool and step 3, for p23-b)
  escalation: [
    member(
      'helper',
      'Converts lengths between metres and centimetres.',
      'you convert lengths between metres and centimetres; when a request also asks for anything else, you escalate it to the user as your guidance says.',
      "1. If every part of a request is a length conversion, call reply with the answers.\n2. If any part is something else, call ask_user with \"ESCALATE: done: \" and the conversions you did, then \"; left: \" and what is left, and nothing more.\n3. When the user answers your escalation (a message that starts \"The user answered\"), call pass, whatever the answer asks: you have handed the conversation to the user.\n",
      { tools: ['ask_user'] },
    ),
  ],
  // P20 · dynamic spawning ("helper" is no member: the lead launches it from the team's folder)
  spawner: [
    member(
      'lead',
      'Brings in a helper when it needs one.',
      'you bring in a helper agent when you need one, and tell the user what it says.',
      '1. When the user writes to you (a message that starts "The user wrote to you") asking for the helper\'s word, call launch_agent with the recipe "helper".\n2. When launch_agent returns the helper\'s handle, call consult with one request, to that handle: "What is your word?"\n3. When its answer comes back (a message that starts "You consulted"), call reply with the word only.\n',
      { launch: { recipes: ['helper'], maxPerConversation: 1 } },
    ),
    member('helper', 'Holds a word.', 'you hold a word.', '1. Your word is marigold. Asked for your word, call reply with "marigold" only.\n', { launched: true }),
  ],
  // P7 · hierarchical teams
  hierarchy: [
    member(
      'top',
      'Asks the two leads and combines their answers.',
      "you ask the two leads for their colours' numbers and combine their answers.",
      '1. When the user writes to you (a message that starts "The user wrote to you"), call consult once, with one request to lead-warm-1 and one to lead-cool-1, both "What are your colours\' numbers?"\n2. When their answers come back (a message that starts "You consulted"), call reply with "warm: " and lead-warm-1\'s answer, then "; cool: " and lead-cool-1\'s answer, and nothing else.\n',
    ),
    member(
      'lead-warm',
      'Leads the warm-colour workers.',
      'you lead the warm-colour workers, red-1 and orange-1.',
      '1. When top-1 asks you (a message that starts "Agent top-1 asks you"), call consult once, with one request to red-1 and one to orange-1, both "What is your number?" Never answer top-1 before they have answered you.\n2. When their answers come back (a message that starts "You consulted"), call reply with the two numbers, red-1\'s first, separated by a comma and a space, and nothing else.\n',
      { nestedCalls: true },
    ),
    member(
      'lead-cool',
      'Leads the cool-colour workers.',
      'you lead the cool-colour workers, blue-1 and violet-1.',
      '1. When top-1 asks you (a message that starts "Agent top-1 asks you"), call consult once, with one request to blue-1 and one to violet-1, both "What is your number?" Never answer top-1 before they have answered you.\n2. When their answers come back (a message that starts "You consulted"), call reply with the two numbers, blue-1\'s first, separated by a comma and a space, and nothing else.\n',
      { nestedCalls: true },
    ),
    member('red', "Knows one colour's number.", "you know one colour's number.", '1. You know one fact: the number 4 stands for red. Asked for your number, call reply with "4" only.\n'),
    member('orange', "Knows one colour's number.", "you know one colour's number.", '1. You know one fact: the number 7 stands for orange. Asked for your number, call reply with "7" only.\n'),
    member('blue', "Knows one colour's number.", "you know one colour's number.", '1. You know one fact: the number 3 stands for blue. Asked for your number, call reply with "3" only.\n'),
    member('violet', "Knows one colour's number.", "you know one colour's number.", '1. You know one fact: the number 2 stands for violet. Asked for your number, call reply with "2" only.\n'),
  ],
};

// ------------------------------------------------------------------ the planned tools and frames

/** ask_user (R23): a channel tool a recipe selects, offered right after reply. */
export const ASK_USER_TOOL = {
  type: 'function',
  function: {
    name: 'ask_user',
    description: 'Ask the user a question and wait for their answer, which comes back to you in this conversation. The user sees your question as your reply.',
    parameters: { type: 'object', properties: { text: { type: 'string', description: 'The question, as the user will read it' } }, required: ['text'] },
  },
};

/** launch_agent (R29, R30): offered after the selected tools when the recipe has a launch grant. */
export const launchAgentTool = (recipes) => ({
  type: 'function',
  function: {
    name: 'launch_agent',
    description: "Bring a new agent onto the channel, from a recipe in your team's folder. Returns its handle, which you can then consult.",
    parameters: { type: 'object', properties: { recipe: { type: 'string', enum: [...recipes], description: 'The recipe to launch' } }, required: ['recipe'] },
  },
});

/** The frame of the user's answer to an ask (R26): f5 is the plan's (wording set 3); f1 was its first wording and f2–f4 the others tried for p23-b. */
export const ANSWER_FRAMES = {
  f1: (asked, answered) => `You asked the user:\n${asked}\nThe user answered:\n${answered}`,
  f2: (asked, answered) => `The user answered your question.\nYour question was:\n${asked}\nThe user's answer:\n${answered}`,
  f3: (asked, answered) => `The user wrote to you, answering what you asked them:\n${answered}\nWhat you asked them:\n${asked}`,
  f4: (asked, answered) => `You asked the user, and this conversation waited for their answer:\n${asked}\nThe user answered:\n${answered}`,
  f5: (asked, answered) => `The user answered what you asked them:\n${answered}\nWhat you asked them:\n${asked}`,
};
export const answerFrame = ANSWER_FRAMES.f5;

/** The call-turn line of an agent granted nested calls (R33). */
export const nestedCallLine = (asker) => `Agent ${asker} has asked you something. Answer with a tool call: reply to answer ${asker}, consult to ask other agents first (their answers come back to you, and then you answer ${asker}), or pass if you cannot.`;

/** The first line of a message the channel re-delivers to a restarted agent (R12), as RETRY_LINE is a re-send's. */
export const RESTART_LINE = 'This message was sent before you were restarted; some of its work may already be done.';
