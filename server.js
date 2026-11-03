import './lib/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { MatchEngine } from './lib/matchEngine.js';
import { Room, REACTIONS, hashIp } from './lib/room.js';
import { generateCatchup, MAX_COMMENTARY_CHARS } from './lib/catchup.js';
import { aiEnabled, verifyKey } from './lib/ai.js';
import { FAN_TYPES, LANGUAGES } from './lib/prompt.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const MAX_STREAMS_PER_IP = 6;
const MAX_STREAMS = 2000;
const HEARTBEAT_MS = 15_000;

const engine = new MatchEngine({
  overIntervalMs: Number(process.env.OVER_INTERVAL_MS) || 7000,
  startAtOver: Number(process.env.START_AT_OVER ?? 6),
  restartDelayMs: Number(process.env.RESTART_DELAY_MS ?? 10_000), // capped at 15 s by the engine
});
const room = new Room();

engine.on('over', (data) => room.broadcast('over', data));
engine.on('reset', (snapshot) => room.broadcast('reset', snapshot));
engine.start();

const app = express();
app.set('trust proxy', 1); // Render/Railway sit behind one proxy; needed for per-IP limits
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  });
  next();
});
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(here, 'public'), { maxAge: 0 }));

const limiter = (limit, message) =>
  rateLimit({ windowMs: 60_000, limit, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: message } });

const catchupSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('sim'),
    sinceOver: z.number().int().min(0).max(20),
    fanType: z.enum(FAN_TYPES),
    language: z.enum(LANGUAGES),
  }),
  z.object({
    source: z.literal('paste'),
    commentary: z.string().trim().min(20, 'Paste a bit more commentary (at least a couple of lines).').max(MAX_COMMENTARY_CHARS, `Keep it under ${MAX_COMMENTARY_CHARS} characters.`),
    fanType: z.enum(FAN_TYPES),
    language: z.enum(LANGUAGES),
  }),
]);
const reactSchema = z.object({ reaction: z.number().int().min(0).max(REACTIONS.length - 1) });
const voteSchema = z.object({ option: z.number().int().min(0).max(5), voterId: z.string().min(4).max(64) });

function badRequest(res, err) {
  res.status(400).json({ error: err.issues?.[0]?.message ?? 'Invalid request' });
}

app.get('/api/health', (req, res) => res.json({ ok: true, ai: aiEnabled() }));

app.get('/api/state', (req, res) => {
  res.json({ snapshot: engine.snapshot(), room: room.currentFeed(), reactions: REACTIONS, ai: aiEnabled(), limits: { commentary: MAX_COMMENTARY_CHARS } });
});

// Server-sent events: overs, resets, room reactions and poll updates.
const streamsByIp = new Map();
app.get('/api/live', (req, res) => {
  const ip = hashIp(req.ip);
  const open = streamsByIp.get(ip) ?? 0;
  if (open >= MAX_STREAMS_PER_IP || room.clients.size >= MAX_STREAMS) {
    return res.status(429).json({ error: 'Too many open live connections.' });
  }
  streamsByIp.set(ip, open + 1);

  // Headers that stop proxies (Render, nginx, CDNs) from buffering or rewriting the stream.
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  res.flushHeaders();
  // retry: tells the browser to reconnect after 3 s if the stream drops.
  res.write(`retry: 3000\nevent: snapshot\ndata: ${JSON.stringify(engine.snapshot())}\n\n`);
  const remove = room.addClient(res);
  // Heartbeat comment so idle-connection timeouts never close a quiet stream.
  const ping = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(ping);
    remove();
    const left = (streamsByIp.get(ip) ?? 1) - 1;
    if (left > 0) streamsByIp.set(ip, left);
    else streamsByIp.delete(ip);
  });
});

app.post('/api/catchup', limiter(8, 'Too many catch-ups. Try again in a minute.'), async (req, res) => {
  const parsed = catchupSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  try {
    res.json(await generateCatchup({ engine, room, input: parsed.data }));
  } catch (err) {
    console.error(`[catchup] unexpected error: ${err?.name ?? 'Error'}`);
    res.status(500).json({ error: 'Something went wrong building your catch-up.' });
  }
});

app.post('/api/react', limiter(20, 'Easy there! Too many reactions.'), (req, res) => {
  const parsed = reactSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  res.json(room.react(parsed.data.reaction));
});

app.post('/api/polls/:id/share', limiter(4, 'Too many polls shared. Try again in a minute.'), (req, res) => {
  const item = room.sharePoll(req.params.id);
  if (!item) return res.status(404).json({ error: 'This poll can’t be shared.' });
  if (item.alreadyShared) return res.status(409).json({ error: 'This poll is already in the room.' });
  res.json(item);
});

app.post('/api/polls/:id/vote', limiter(30, 'Too many votes. Try again in a minute.'), (req, res) => {
  const parsed = voteSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  const out = room.vote(req.params.id, parsed.data.option, parsed.data.voterId, hashIp(req.ip));
  if (out.error === 'not_found') return res.status(404).json({ error: 'Poll not found (it may have expired).' });
  if (out.error === 'ip_limit') return res.status(429).json({ error: 'Vote limit reached for this poll on your network.' });
  res.json(out.poll);
});

app.listen(PORT, async () => {
  console.log(`Missed It? listening on port ${PORT}`);
  const { on, why } = await verifyKey();
  console.log(`AI mode: ${on ? 'ON' : 'OFF'} (${why})`);
});
