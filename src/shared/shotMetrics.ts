export type CountableShotOutcome = "miss" | "hit" | "sink";

export const isCountableShotOutcome = (outcome: string): outcome is CountableShotOutcome =>
  outcome === "miss" || outcome === "hit" || outcome === "sink";

export interface ShotCounters {
  yourShots: number;
  opponentShots: number;
}

export const incrementShotCounter = (
  counters: ShotCounters,
  outcome: string,
  shooterIsYou: boolean,
): void => {
  if (!isCountableShotOutcome(outcome)) {
    return;
  }
  if (shooterIsYou) {
    counters.yourShots += 1;
  } else {
    counters.opponentShots += 1;
  }
};
