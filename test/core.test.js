import { test } from 'node:test';
import assert from 'node:assert/strict';
import { winProbability } from '../lib/winProb.js';
import { MatchEngine } from '../lib/matchEngine.js';
import { buildUserPrompt } from '../lib/prompt.js';
import { fallbackRecap } from '../lib/fallback.js';
import { Room, REACTIONS, hashIp } from '../lib/room.js';
import { westernDigits } from '../lib/catchup.js';

test('win probability handles finished states and is monotonic in runs needed', () => {
  assert.equal(winProbability({ runsNeeded: 0, ballsLeft: 10, wicketsLeft: 3 }), 100);
  assert.equal(winProbability({ runsNeeded: 20, ballsLeft: 0, wicketsLeft: 3 }), 0);
  assert.equal(winProbability({ runsNeeded: 20, ballsLeft: 10, wicketsLeft: 0 }), 0);
  const easy = winProbability({ runsNeeded: 40, ballsLeft: 60, wicketsLeft: 8 });
  const hard = winProbability({ runsNeeded: 110, ballsLeft: 60, wicketsLeft: 8 });
  assert.ok(easy > hard);
});

test('engine is deterministic for a seed and produces unique event ids', () => {
  const a = new MatchEngine({ startAtOver: 20 });
  const b = new MatchEngine({ startAtOver: 20 });
  a.newMatch(1234);
  b.newMatch(1234);
  assert.deepEqual(a.snapshot().score, b.snapshot().score);
  assert.equal(a.status, 'done');
  const ids = a.events.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('prompt wraps feed in delimiters and quotes the stats-model win chance', () => {
  const e = new MatchEngine({ startAtOver: 8 });
  e.newMatch(99);
  const now = e.snapshot();
  const events = e.eventsSince(5);
  const prompt = buildUserPrompt(
    { mode: 'sim', sinceOver: 5, now, then: e.stateAtOver(5), events, stats: { runs: 1, wickets: 0, fours: 0, sixes: 0 }, biggestSwing: null },
    { fanType: 'beginner', language: 'mr' },
  );
  assert.match(prompt, /<feed>[\s\S]*<\/feed>/);
  assert.ok(prompt.includes(`${now.wp}%`));
  assert.ok(prompt.includes(`[${events[0].id}]`));
});

test('fallback recap only cites events from the window', () => {
  const e = new MatchEngine({ startAtOver: 12 });
  e.newMatch(7);
  const events = e.eventsSince(6);
  const ids = new Set(events.map((x) => x.id));
  const out = fallbackRecap(
    { mode: 'sim', now: e.snapshot(), then: e.stateAtOver(6), events, biggestSwing: events.find((x) => x.kind === 'wicket') ?? null },
    { language: 'hinglish' },
  );
  for (const t of out.three_things) for (const id of t.event_ids) assert.ok(ids.has(id));
});

test('room: votes are capped per network and paste-mode polls cannot be shared', () => {
  const room = new Room();
  const ip = hashIp('203.0.113.7');
  const poll = room.createPoll('Who wins?', ['A', 'B'], { shareable: true });
  for (let i = 0; i < 5; i++) assert.ok(room.vote(poll.id, 0, `voter-${i}`, ip).poll);
  assert.equal(room.vote(poll.id, 1, 'voter-extra', ip).error, 'ip_limit');
  assert.ok(room.vote(poll.id, 1, 'voter-0', ip).poll, 'an existing voter can change their vote');
  assert.deepEqual(room.vote(poll.id, 0, 'other', hashIp('198.51.100.1')).poll.counts, [5, 1]);

  const pastePoll = room.createPoll('Q', ['A', 'B'], { shareable: false });
  assert.equal(room.sharePoll(pastePoll.id), null);
  assert.ok(room.sharePoll(poll.id));
  assert.deepEqual(room.sharePoll(poll.id), { alreadyShared: true });
});

test('room: reactions only accept the preset list', () => {
  const room = new Room();
  const item = room.react(0);
  assert.equal(item.text, REACTIONS[0]);
  assert.equal(room.feed.length, 1);
});

test('numbers are always shown with Western digits', () => {
  assert.equal(westernDigits('SAH ९८/२, ४२ चेंडूत ६6 धावा'), 'SAH 98/2, 42 चेंडूत 66 धावा');
  assert.equal(westernDigits('no digits here'), 'no digits here');
});

test('a finished match is replaced by a new one within 15 seconds', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const engine = new MatchEngine({ overIntervalMs: 1000, startAtOver: 0 });
  const resets = [];
  engine.on('reset', (s) => resets.push(s));
  engine.start();
  t.after(() => engine.stop());

  for (let i = 0; i < 25 && engine.status === 'live'; i++) t.mock.timers.tick(1000);
  assert.equal(engine.status, 'done');
  const finished = engine.matchId;
  const { restartInMs } = engine.snapshot();
  assert.ok(restartInMs > 0 && restartInMs <= 15_000, `restartInMs=${restartInMs}`);

  t.mock.timers.tick(restartInMs - 1);
  assert.equal(engine.matchId, finished, 'not restarted early');
  t.mock.timers.tick(1);
  assert.notEqual(engine.matchId, finished);
  assert.equal(engine.status, 'live');
  assert.equal(resets.at(-1).matchId, engine.matchId, 'listeners are told about the new match');
});

test('restart delay is capped at 15 seconds', () => {
  assert.equal(new MatchEngine({ restartDelayMs: 60_000 }).restartDelayMs, 15_000);
  assert.equal(new MatchEngine().restartDelayMs, 10_000);
});
