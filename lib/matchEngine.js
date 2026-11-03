// Simulated "live" T20 chase between two FICTIONAL teams.
// Plays one over every OVER_INTERVAL_MS and emits it, so the demo feels live.
// Swap this module for a real data adapter (see README → Architecture) and
// nothing else in the app has to change: it only needs the same event shape.

import { EventEmitter } from 'node:events';
import { winProbability } from './winProb.js';

const BATTING = {
  name: 'Sahyadri Sixers',
  short: 'SAH',
  players: [
    'Aarav Kulkarni', 'Rohan Deshpande', 'Kabir Shetty', 'Vihaan Patil', 'Ishaan Joshi',
    'Arjun Rane', 'Dev Gaikwad', 'Neel Bhosale', 'Om Salunkhe', 'Yash More', 'Tanay Pawar',
  ],
};
const BOWLING = {
  name: 'Ganga Gliders',
  short: 'GAN',
  bowlers: ['Rahul Tiwari', 'Faiz Ansari', 'Manav Mishra', 'Sameer Yadav', 'Kunal Pandey'],
  fielders: ['Aditya Srivastava', 'Harsh Dubey', 'Varun Chauhan', 'Nikhil Rawat', 'Pranav Shukla'],
  keeper: 'Siddharth Rai',
};

// Outcome weights: dot, 1, 2, 3, 4, 6, wicket, wide
const PHASE_WEIGHTS = {
  powerplay: [33, 30, 8, 1, 15, 5.5, 4.5, 3.5],
  middle: [32, 38, 9, 1, 10, 5, 4, 2.5],
  death: [26, 30, 8, 1, 14, 9, 7, 3],
};
const OUTCOMES = ['0', '1', '2', '3', '4', '6', 'W', 'wd'];

const LINES = {
  0: ['no run, defended solidly off a good length.', 'dot ball, beaten outside off!', 'no run, pushed straight to cover.', 'dot, a sharp bouncer, ducked under.'],
  1: ['1 run, worked to deep square leg.', 'single, dabbed down to third man.', '1 run, tapped into the off side and they scamper through.'],
  2: ['2 runs, driven into the gap at long-off, back for the second.', '2 runs, flicked off the pads to deep midwicket.'],
  3: ['3 runs, superb running between the wickets.'],
  4: ['FOUR! Cracking cover drive.', 'FOUR! Pulled hard through midwicket.', 'FOUR! Edged, and it flies past slip to the rope.', 'FOUR! Late cut, beats short third.'],
  6: ['SIX! Launched over long-on.', 'SIX! Slog-swept into the stands.', 'SIX! Picked the slower ball and sent it over midwicket.', 'SIX! Straight down the ground, huge hit.'],
  wd: ['wide, sprayed down the leg side.', 'wide, too far outside off.'],
};

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_RESTART_DELAY_MS = 15_000; // a finished match is replaced within 15 s

export class MatchEngine extends EventEmitter {
  constructor({ overIntervalMs = 7000, startAtOver = 6, restartDelayMs = 10_000 } = {}) {
    super();
    this.overIntervalMs = overIntervalMs;
    this.startAtOver = startAtOver;
    this.restartDelayMs = Math.min(Math.max(0, restartDelayMs), MAX_RESTART_DELAY_MS);
    this.running = false;
    this.timer = null;
    this.restartTimer = null;
  }

  start() {
    this.running = true;
    this.newMatch();
    this.timer = setInterval(() => this.tick(), this.overIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  // The sim is deterministic per seed, so we can pre-play candidates and keep one
  // that stays close (lead changes, decided late) — a better demo than a rout.
  static pickDramaticSeed(tries = 40) {
    let seed;
    for (let i = 0; i < tries; i++) {
      seed = (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
      const probe = new MatchEngine({ startAtOver: 20 });
      probe.newMatch(seed, { silent: true });
      const wps = probe.overHistory.map((o) => o.wpAfter);
      const swings = wps.slice(1).filter((wp, j) => (wp - 50) * (wps[j] - 50) < 0).length;
      const late = probe.balls >= 112 || probe.result === 'Match tied';
      const close = Math.abs(probe.target - 1 - probe.score) <= 12 || probe.score >= probe.target;
      if (swings >= 2 && late && close) return seed;
    }
    return seed;
  }

  newMatch(seed = MatchEngine.pickDramaticSeed(), { silent = false } = {}) {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.rng = mulberry32(seed);
    this.matchId = seed.toString(36);
    this.target = 160 + Math.floor(this.rng() * 36) + 1;
    this.score = 0;
    this.wickets = 0;
    this.balls = 0; // legal balls bowled
    this.overIndex = 0; // completed overs
    this.events = [];
    this.overHistory = [];
    this.status = 'live';
    this.result = null;
    this.endedAt = null;
    this.batters = BATTING.players.map((name) => ({ name, runs: 0, balls: 0, fours: 0, sixes: 0, out: false }));
    this.bowlers = BOWLING.bowlers.map((name) => ({ name, balls: 0, runs: 0, wickets: 0 }));
    this.striker = 0;
    this.nonStriker = 1;
    this.nextBatter = 2;
    this.lastBowler = -1;
    this.currentBowler = null;
    this.partnership = 0;
    this.initialWp = this.wp();

    for (let i = 0; i < this.startAtOver && this.status === 'live'; i++) this.playOver();
    if (!silent) this.emit('reset', this.snapshot());
    this.scheduleRestart();
  }

  tick() {
    if (this.status === 'done') return; // the restart timer brings the next match
    const over = this.playOver();
    this.emit('over', { over, snapshot: this.snapshot() });
    this.scheduleRestart();
  }

  // Runs its own timer from the moment the match ends, rather than waiting for the
  // next over tick, so the next match always starts restartDelayMs later.
  scheduleRestart() {
    if (!this.running || this.status !== 'done' || this.restartTimer) return;
    this.restartTimer = setTimeout(() => this.newMatch(), this.restartDelayMs);
    this.restartTimer.unref?.();
  }

  wp() {
    return winProbability({
      runsNeeded: this.target - this.score,
      ballsLeft: 120 - this.balls,
      wicketsLeft: 10 - this.wickets,
    });
  }

  pick(list) {
    return list[Math.floor(this.rng() * list.length)];
  }

  pickBowler() {
    const eligible = this.bowlers
      .map((b, i) => ({ b, i }))
      .filter(({ b, i }) => b.balls < 24 && i !== this.lastBowler);
    const fewest = Math.min(...eligible.map(({ b }) => b.balls));
    const options = eligible.filter(({ b }) => b.balls === fewest);
    return this.pick(options).i;
  }

  playOver() {
    const o = this.overIndex;
    const bi = this.pickBowler();
    this.currentBowler = bi;
    const startEvents = this.events.length;
    let legal = 0;
    let wides = 0;
    let runs = 0;
    let wkts = 0;

    while (legal < 6 && this.status === 'live') {
      const ev = this.playBall(o, legal, bi, wides);
      runs += ev.runs;
      if (ev.kind === 'wicket') wkts++;
      if (ev.kind === 'wide') wides++;
      else legal++;
    }

    const bowler = this.bowlers[bi];
    const summary = {
      overIndex: o,
      bowler: bowler.name,
      runs,
      wickets: wkts,
      scoreAfter: `${this.score}/${this.wickets}`,
      wpAfter: this.wp(),
      balls: this.events.slice(startEvents).map((e) => e.code),
    };
    this.events.push({
      id: `${o + 1}.0`,
      over: o,
      kind: 'over_end',
      runs: 0,
      code: '|',
      text: `End of over ${o + 1}: ${runs} run${runs === 1 ? '' : 's'}${wkts ? `, ${wkts} wicket${wkts > 1 ? 's' : ''}` : ''}. ${BATTING.short} ${this.score}/${this.wickets}. ${bowler.name} ${fmtFigures(bowler)}.`,
      score: summary.scoreAfter,
      wpBefore: summary.wpAfter,
      wpAfter: summary.wpAfter,
      swing: 0,
    });
    this.overHistory.push(summary);
    this.lastBowler = bi;
    this.overIndex++;
    [this.striker, this.nonStriker] = [this.nonStriker, this.striker];
    if (this.status === 'live' && this.balls >= 120) this.finish();
    return summary;
  }

  playBall(o, legal, bi, wides) {
    const wpBefore = this.wp();
    const bowler = this.bowlers[bi];
    const bat = this.batters[this.striker];
    const phase = o < 6 ? 'powerplay' : o < 15 ? 'middle' : 'death';
    const weights = [...PHASE_WEIGHTS[phase]];
    const ballsLeft = 120 - this.balls;
    const rrr = ((this.target - this.score) / Math.max(1, ballsLeft)) * 6;
    if (rrr > 11) { weights[5] += 3; weights[6] += 2.5; weights[0] -= 3; }
    if (10 - this.wickets <= 3) { weights[5] -= 2; weights[6] += 1; }

    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.rng() * total;
    let outcome = OUTCOMES[OUTCOMES.length - 1];
    for (let i = 0; i < weights.length; i++) {
      if ((r -= weights[i]) <= 0) { outcome = OUTCOMES[i]; break; }
    }

    const ballNo = legal + 1;
    const prefix = `${bowler.name} to ${bat.name},`;
    const ev = { over: o, runs: 0, batter: bat.name, bowler: bowler.name };
    const milestones = [];

    if (outcome === 'wd') {
      Object.assign(ev, { id: `${o}.${ballNo}wd${wides ? wides + 1 : ''}`, kind: 'wide', runs: 1, code: 'wd' });
      ev.text = `${prefix} ${this.pick(LINES.wd)}`;
      this.score += 1;
      bowler.runs += 1;
      this.partnership += 1;
    } else if (outcome === 'W') {
      Object.assign(ev, { id: `${o}.${ballNo}`, kind: 'wicket', code: 'W' });
      bat.balls++;
      bat.out = true;
      bowler.balls++;
      this.balls++;
      this.wickets++;
      const how = this.rng();
      const fielder = this.pick(BOWLING.fielders);
      const fig = `${bat.runs}(${bat.balls})`;
      let line;
      if (how < 0.08) {
        line = `OUT! Run out! A mix-up and ${fielder} hits direct. ${bat.name} goes for ${fig}.`;
      } else {
        bowler.wickets++;
        if (how < 0.3) line = `OUT! Bowled! ${bowler.name} knocks back the off stump. ${bat.name} ${fig}.`;
        else if (how < 0.45) line = `OUT! LBW, plumb in front. ${bat.name} ${fig}.`;
        else if (how < 0.6) line = `OUT! Thin edge and ${BOWLING.keeper} takes it behind. ${bat.name} ${fig}.`;
        else line = `OUT! ${bat.name} holes out to ${fielder} in the deep. ${fig}.`;
      }
      ev.text = `${prefix} ${line}`;
      ev.dismissed = bat.name;
      this.partnership = 0;
      if (this.wickets < 10) {
        this.striker = this.nextBatter++;
        ev.text += ` ${this.batters[this.striker].name} walks in.`;
      }
    } else {
      const runs = Number(outcome);
      Object.assign(ev, { id: `${o}.${ballNo}`, kind: runs === 4 ? 'four' : runs === 6 ? 'six' : runs === 0 ? 'dot' : 'runs', runs, code: runs === 0 ? '•' : String(runs) });
      ev.text = `${prefix} ${this.pick(LINES[runs])}`;
      const before = bat.runs;
      const pBefore = this.partnership;
      bat.runs += runs;
      bat.balls++;
      if (runs === 4) bat.fours++;
      if (runs === 6) bat.sixes++;
      bowler.balls++;
      bowler.runs += runs;
      this.balls++;
      this.score += runs;
      this.partnership += runs;
      for (const m of [50, 100]) if (before < m && bat.runs >= m) milestones.push(`${m} up for ${bat.name} off ${bat.balls} balls.`);
      if (pBefore < 50 && this.partnership >= 50) milestones.push(`50 partnership up.`);
      if (runs % 2 === 1) [this.striker, this.nonStriker] = [this.nonStriker, this.striker];
    }

    if (milestones.length) ev.text += ` ${milestones.join(' ')}`;
    ev.score = `${this.score}/${this.wickets}`;
    ev.wpBefore = wpBefore;

    if (this.score >= this.target) this.finish();
    else if (this.wickets >= 10) this.finish();

    ev.wpAfter = this.status === 'done' ? (this.score >= this.target ? 100 : 0) : this.wp();
    ev.swing = ev.wpAfter - wpBefore;
    this.events.push(ev);
    return ev;
  }

  finish() {
    this.status = 'done';
    this.endedAt = Date.now();
    if (this.score >= this.target) {
      const w = 10 - this.wickets;
      this.result = `${BATTING.name} won by ${w} wicket${w === 1 ? '' : 's'} (${120 - this.balls} balls left)`;
    } else if (this.score === this.target - 1) {
      this.result = 'Match tied';
    } else {
      const margin = this.target - 1 - this.score;
      this.result = `${BOWLING.name} won by ${margin} run${margin === 1 ? '' : 's'}`;
    }
  }

  // Score + win probability as it stood after `overs` completed overs.
  stateAtOver(overs) {
    if (overs <= 0) return { score: '0/0', wp: this.initialWp };
    const h = this.overHistory[Math.min(overs, this.overHistory.length) - 1];
    return { score: h.scoreAfter, wp: h.wpAfter };
  }

  eventsSince(overs) {
    return this.events.filter((e) => e.over >= overs);
  }

  snapshot() {
    const ballsLeft = 120 - this.balls;
    const runsNeeded = Math.max(0, this.target - this.score);
    const bowler = this.currentBowler != null ? this.bowlers[this.currentBowler] : null;
    const batter = (i) => {
      const b = this.batters[i];
      return b && !b.out ? { name: b.name, runs: b.runs, balls: b.balls } : null;
    };
    return {
      matchId: this.matchId,
      simulated: true,
      battingTeam: BATTING.name,
      battingShort: BATTING.short,
      bowlingTeam: BOWLING.name,
      bowlingShort: BOWLING.short,
      target: this.target,
      score: this.score,
      wickets: this.wickets,
      overs: `${Math.floor(this.balls / 6)}.${this.balls % 6}`,
      completedOvers: this.overIndex,
      runsNeeded,
      ballsLeft,
      rrr: ballsLeft ? +((runsNeeded / ballsLeft) * 6).toFixed(2) : null,
      crr: this.balls ? +((this.score / this.balls) * 6).toFixed(2) : 0,
      wp: this.status === 'done' ? (this.score >= this.target ? 100 : 0) : this.wp(),
      status: this.status,
      result: this.result,
      restartInMs: this.status === 'done' && this.running ? Math.max(0, this.endedAt + this.restartDelayMs - Date.now()) : null,
      striker: batter(this.striker),
      nonStriker: batter(this.nonStriker),
      bowler: bowler ? { name: bowler.name, figures: fmtFigures(bowler) } : null,
      lastOver: this.overHistory.at(-1) ?? null,
      overHistory: this.overHistory.map(({ overIndex, runs, wickets, wpAfter, scoreAfter }) => ({ overIndex, runs, wickets, wpAfter, scoreAfter })),
      overIntervalMs: this.overIntervalMs,
    };
  }
}

function fmtFigures(b) {
  return `${b.wickets}/${b.runs} (${Math.floor(b.balls / 6)}.${b.balls % 6} ov)`;
}
