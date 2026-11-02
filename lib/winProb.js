// Rough, transparent win-probability model for a T20 chase.
// Deliberately simple: a stats heuristic, not a trained model, and the UI labels
// it "rough". The LLM never computes this number; it only quotes it.
// Constants were grid-searched against ~2,000 simulated chases from matchEngine.js
// (predicted vs actual win rate within ~5 points per decile). For real matches you
// would refit them on historical ball-by-ball data.

const RUNS_PER_BALL = 1.9;
const WICKET_BASE = 0.6;
const WICKET_STEP = 0.02;

export function winProbability({ runsNeeded, ballsLeft, wicketsLeft }) {
  if (runsNeeded <= 0) return 100;
  if (wicketsLeft <= 0 || ballsLeft <= 0) return 0;

  // Fewer wickets in hand means slower scoring — more so when many balls remain.
  const wicketPenalty = (1 - (WICKET_BASE + WICKET_STEP * wicketsLeft)) * Math.min(1, ballsLeft / 60);
  const expectedRuns = ballsLeft * RUNS_PER_BALL * (1 - wicketPenalty);
  const spread = Math.sqrt(ballsLeft) * 1.6 + 6;
  const z = (expectedRuns - runsNeeded) / spread;
  const p = 1 / (1 + Math.exp(-1.7 * z)); // logistic approximation of a normal CDF

  return Math.max(1, Math.min(99, Math.round(p * 100)));
}
