# Missed It? 🏏

**A 20-second catch-up for cricket fans who stepped away mid-match.**

You went to get chai or answer the door, and now the group chat has moved on. Tell *Missed It?* when you last watched, and in about 20 seconds you get:

- a **headline**
- the **3 things that happened**, each linked to the ball it came from
- a rough **win-chance bar**, then vs now
- the **turning point**
- **one thing to watch next**
- a **one-liner to send to your group chat**
- a **just-for-fun prediction poll** you can share in the watch room
- a **copy/share recap**

It adapts to **fan type** (beginner / casual / hardcore) and **language** (English, Hinglish, Marathi).

> The live match is **simulated** with fictional teams and players (Sahyadri Sixers vs Ganga Gliders), and the app says so on screen. To recap a real match, use **Paste commentary**.
> There is no betting, no odds, no fantasy and no money anywhere in the app.

---

## Setup

Requirements: Node 24 (pinned in `.node-version`) and, for AI recaps, a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).

```bash
npm install
cp .env.example .env      # then put your key after GEMINI_API_KEY=
npm start                 # http://localhost:3000
```

The startup log tells you which mode you're in. It never prints the key.

```
Missed It? listening on port 3000
AI mode: ON (model gemini-flash-lite-latest, daily cap 300)
```

**Without a key the app still works.** It shows a basic recap built straight from the match feed, labelled "Basic recap · no AI".

| Command | What it does |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Run and restart on file changes |
| `npm test` | Unit tests (no API calls, free) |
| `npm run smoke` | Real end-to-end check: 3 small Gemini requests (English, Hinglish, Marathi). Prints timing, grounding and language checks, then **PASS** or **FAIL** (exit code 1 on failure). |

### Settings (`.env` locally, Environment tab on Render)

| Variable | Default | What it does |
|---|---|---|
| `GEMINI_API_KEY` | — | Server-side only. Sent only to Google in the `X-goog-api-key` header; never to the browser or the logs. |
| `AI_DAILY_CAP` | `300` | Max AI calls per day, reset at midnight India time. After that, everyone gets the basic recap. `0` turns AI off. |
| `GEMINI_MODEL` | `gemini-flash-lite-latest` | Gemini model used for recaps. Fast and cheap; `gemini-flash-latest` writes a bit richer but is often overloaded at peak times. |
| `OVER_INTERVAL_MS` | `7000` | One simulated over every N ms |
| `START_AT_OVER` | `6` | Overs to fast-forward on start, so there's history to catch up on |
| `RESTART_DELAY_MS` | `10000` | Pause between a match finishing and the next one starting (capped at 15000) |
| `PORT` | `3000` | HTTP port (Render sets this for you) |

## Deploy on Render

1. Push this repo to GitHub. `.env` and `node_modules/` are git-ignored.
2. In the Render dashboard, choose **New → Blueprint**, connect GitHub, and pick the repo. Render reads `render.yaml`: free web service, `npm ci`, `npm start`, health check `/api/health`, Node 24.14.1, `AI_DAILY_CAP=300`.
3. When Render asks for `GEMINI_API_KEY`, paste the key. Click **Apply**.
4. When the deploy is live, open `https://<your-service>.onrender.com/api/health`. It should show `{"ok":true,"ai":true}`.

The free plan sleeps after about 15 idle minutes, so the first visit after that takes 30–60 seconds. Keep it to **one instance**: the match, room and polls live in memory.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Log says `AI mode: OFF (no GEMINI_API_KEY set)` | `.env` is missing or misnamed. It must be exactly `.env` in the project folder (not `.env.txt`). On Render, check the Environment tab. |
| Log says `AI mode: OFF (API key was rejected)` | Key mistyped or deleted. Create a new one in Google AI Studio. |
| Log says `model "…" not found` | `GEMINI_MODEL` names a model that doesn't exist. Remove it to use the default. |
| `npm run smoke` fails with `Daily AI cap reached` | `AI_DAILY_CAP` is `0` or very low. Raise it. |
| `npm run smoke` fails on language | The model replied in the wrong script. Run it again. If it keeps failing, check `LANG_GUIDE` in `lib/prompt.js`. |
| Every recap says "Basic recap · no AI" | Check the server log for an `AI fallback:` line. `Gemini API error 429` means the quota or rate limit was hit (common on the free tier): wait, or enable billing in AI Studio. A `5xx` means Google-side trouble. Other lines: timeout or invalid output. |
| `/api/health` shows `"ai":false` on Render | `GEMINI_API_KEY` isn't set in the Render Environment tab, or the key was rejected. Fix it and click **Manual Deploy → Restart**. |
| Live score updates slowly (every ~5 s) or only after ~15 s | The live stream is being buffered or dropped by something in between, so the page has switched to polling. It still works; check that no extra proxy or CDN sits in front of Render. |
| "Too many …" errors | Per-IP rate limits (below). Wait a minute. |

---

## Design decisions

### 1. The AI can only talk about balls that actually happened (grounding check)
Every line in the match feed has an id. `12.4` is the 4th ball of the 13th over, and `L7` is line 7 of pasted commentary. The model has to attach those ids to each of the "3 things" and to the turning point. Before anything reaches the screen, the server checks every id against the real feed:
- A claim with no real id is **dropped**.
- If the turning point has no real id, it's **replaced** with the ball that moved the win chance most.
- If nothing survives, the fan gets the basic recap instead.

On screen, each claim shows its ball number. Tap it to see the original commentary line. `npm run smoke` reports how many claims the server had to drop.

### 2. Win chance comes from maths, not the AI
The bar uses a small formula in `lib/winProb.js`: expected runs from balls left, reduced for wickets lost, turned into a percentage. Its constants were tuned on about 2,000 simulated chases, and predictions land within about 5 points of the real outcome rate. The AI is given the number and told to quote it. The app always displays the formula's value, whatever the AI writes. It's labelled "rough" on purpose. Pasted real matches have no stats feed, so there the AI may give a rough estimate. The app shows it only when the AI says it's confident, and labels it "rough AI estimate".

### 3. Caching keeps costs flat when many fans miss the same over
If ten friends all ask "what happened since over 8?" with the same fan type and language, Gemini is called once. The other nine get the saved answer. Only successful AI answers are cached, so a temporary failure doesn't stick. A daily cap (`AI_DAILY_CAP`, default 300) is a hard ceiling on spend. Once it's reached, everyone gets the basic recap with a label saying so.

### 4. A fallback is always ready
If there's no key, the key is rejected, the daily cap is reached, the API times out (30 s), Gemini returns 429 (quota) or a 5xx error, the model blocks the request, or the output isn't valid JSON in the right shape, the server builds a recap from the feed with simple rules. It picks the wickets, sixes and biggest swings and fills fixed sentence templates in English, Hinglish or Marathi. It's less lively, but it can't invent anything, and it's clearly labelled "Basic recap · no AI". The live score, polls and room keep working either way.

### 5. Safe on a public link
- **No free text between strangers.** The watch room only has preset reaction buttons, plus polls shared from simulated-match catch-ups. Polls from pasted commentary stay private, so pasted text never reaches other viewers.
- **Prompts are built only on the server.** The browser sends choices (over number, fan type, language) or pasted commentary, never prompt text. Pasted text is wrapped as data, and the model is told to ignore instructions inside it.
- **Limits.** Per IP, per minute: 8 catch-ups, 20 reactions, 30 votes, 4 poll shares, and at most 6 open live connections. Each poll accepts at most 5 voters per network, enough for a family on one Wi-Fi but not for ballot stuffing. Requests are capped at 16 KB, pasted commentary at 6,000 characters. IPs are kept only as salted hashes in memory.
- **Display.** Everything is rendered as plain text (no HTML injection), with a strict Content-Security-Policy and no third-party scripts.
- **Key handling.** The key is read from the environment on the server only. It's never sent to the browser, written to logs, or included in error messages. `/api/health` reports only `ai: true/false`.

### 6. Live updates that survive proxies
The page gets overs, new matches and room activity over a server-sent event stream. The server sends headers that tell proxies not to buffer it (`Cache-Control: no-cache`, `X-Accel-Buffering: no`) and a heartbeat comment every 15 s so idle timeouts don't cut it. If the stream errors, closes, or delivers nothing for 15 s anyway, the page polls `/api/state` every 5 s and keeps reopening the stream in the background; polling stops as soon as the stream delivers again. Either way the page recognises a new match by its id, so it switches without a reload even if a "new match" message was lost.

### 7. The simulator
`lib/matchEngine.js` plays a seeded T20 chase ball by ball. It models scoring that varies by phase, pressure when the required rate climbs, strike rotation, bowler quotas and milestones, and it emits one over per tick. A given seed always plays out the same way, so before each match the engine quietly pre-plays candidate seeds and keeps one that stays close to the end. A new match starts 10 seconds after one finishes (on its own timer, so never more than 15 s), and the page counts down to it.

---

## Plugging into a real live feed

`MatchEngine` is the only part that knows the data is fake. The rest of the app depends on this contract:

```js
engine.snapshot()        // score, wickets, overs, target, rrr, wp, batters, bowler, lastOver, overHistory
engine.eventsSince(n)    // [{ id, over, kind, runs, text, score, wpBefore, wpAfter, swing }, ...]
engine.stateAtOver(n)    // { score, wp } at the end of over n
engine.on('over' | 'reset', ...)
```

To go live:
1. **Write a `LiveFeedAdapter`** with the same interface. It subscribes to a licensed ball-by-ball provider (check the licence covers display and AI use), turns each delivery into the event shape above, and computes win chance with `winProbability()`.
2. **Use the provider's ball ids** as event ids so the grounding check keeps working. Upsert by id, because providers sometimes correct a ball.
3. **Support many matches** by keying the engine, cache and live channels by `matchId`.
4. **Scale out** by moving the room, polls, cache and daily counter to Redis and running several instances.
5. **First innings and Tests**: the win-chance formula is chase-only. Add a first-innings par-score model, and keep the feature off for Tests.

## Project layout
```
server.js            Express app: routes, validation, rate limits, live stream (SSE)
lib/env.js           Loads .env before anything else reads it
lib/matchEngine.js   Simulated T20 chase (seeded, one over per tick)
lib/winProb.js       Rough win-chance formula
lib/prompt.js        Instructions, JSON output shape, prompt builder
lib/ai.js            Gemini REST call (fetch), key check, daily cap
lib/catchup.js       Builds context, calls Gemini, grounding check, cache, fallback
lib/fallback.js      Rule-based recap in EN / Hinglish / Marathi
lib/room.js          Watch room: preset reactions, polls, vote limits
public/              index.html, styles.css, app.js (no framework, no build step)
scripts/smoke.js     npm run smoke
test/                Unit tests (node:test)
```
