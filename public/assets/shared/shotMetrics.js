export const isCountableShotOutcome = (outcome) => outcome === "miss" || outcome === "hit" || outcome === "sink";
export const incrementShotCounter = (counters, outcome, shooterIsYou) => {
    if (!isCountableShotOutcome(outcome)) {
        return;
    }
    if (shooterIsYou) {
        counters.yourShots += 1;
    }
    else {
        counters.opponentShots += 1;
    }
};
