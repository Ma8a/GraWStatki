import { coordToKey, inBounds } from "./game.js";
export const createAiState = () => ({
    mode: "IDLE",
    targetQueue: [],
    hitBuffer: [],
    paritySeed: Math.floor(Math.random() * 2),
});
const coordEquals = (a, b) => a.row === b.row && a.col === b.col;
const randomCoord = (board) => ({
    row: Math.floor(Math.random() * board.height),
    col: Math.floor(Math.random() * board.width),
});
const isAvailable = (board, coord) => inBounds(board, coord) && !board.shots.has(coordToKey(coord));
const addUnique = (list, coord) => {
    if (!list.some((item) => coordEquals(item, coord))) {
        list.push(coord);
    }
};
export const neighbors = (coord) => [
    { row: coord.row - 1, col: coord.col },
    { row: coord.row + 1, col: coord.col },
    { row: coord.row, col: coord.col - 1 },
    { row: coord.row, col: coord.col + 1 },
];
const inferDirection = (hits) => {
    if (hits.length < 2)
        return undefined;
    const first = hits[0];
    const last = hits[hits.length - 1];
    if (first.row === last.row && first.col !== last.col) {
        return { dr: 0, dc: last.col > first.col ? 1 : -1 };
    }
    if (first.col === last.col && first.row !== last.row) {
        return { dr: last.row > first.row ? 1 : -1, dc: 0 };
    }
    return undefined;
};
const lineCandidates = (board, state) => {
    if (!state.lineDirection || state.hitBuffer.length < 2)
        return [];
    const dr = state.lineDirection.dr;
    const dc = state.lineDirection.dc;
    const sorted = [...state.hitBuffer].sort((a, b) => {
        if (dr === 0)
            return a.col - b.col;
        return a.row - b.row;
    });
    const forward = dr === 0 ? { row: sorted[sorted.length - 1].row + dr, col: sorted[sorted.length - 1].col + dc } : {
        row: sorted[sorted.length - 1].row + dr,
        col: sorted[sorted.length - 1].col + dc,
    };
    const backward = dr === 0 ? { row: sorted[0].row + dr, col: sorted[0].col - dc } : {
        row: sorted[0].row - dr,
        col: sorted[0].col - dc,
    };
    const candidates = [];
    if (isAvailable(board, forward))
        candidates.push(forward);
    if (isAvailable(board, backward))
        candidates.push(backward);
    return candidates;
};
const pickAvailableFromQueue = (board, queue) => {
    while (queue.length > 0) {
        const first = queue.shift();
        if (!first)
            return null;
        if (isAvailable(board, first))
            return first;
    }
    return null;
};
export const nextShot = (board, state) => {
    if (state.mode === "TRACK" && state.lineDirection) {
        const candidates = lineCandidates(board, state);
        if (candidates.length > 0) {
            const chosen = candidates[Math.floor(Math.random() * candidates.length)];
            state.lastTrackAttempt = coordEquals(chosen, candidates[0]) ? "forward" : "backward";
            return chosen;
        }
        state.mode = "TARGET";
        state.lineDirection = undefined;
        state.blocked = undefined;
        state.lastTrackAttempt = undefined;
    }
    const queueHit = pickAvailableFromQueue(board, state.targetQueue);
    if (queueHit) {
        return queueHit;
    }
    const isParityCandidate = (coord) => (coord.row + coord.col + state.paritySeed) % 2 === 0;
    const maxAttempts = board.height * board.width * 2;
    for (let i = 0; i < maxAttempts; i += 1) {
        const rand = randomCoord(board);
        if (isAvailable(board, rand) && isParityCandidate(rand)) {
            return rand;
        }
    }
    for (let row = 0; row < board.height; row += 1) {
        for (let col = 0; col < board.width; col += 1) {
            const coord = { row, col };
            if (isParityCandidate(coord) && isAvailable(board, coord)) {
                return coord;
            }
        }
    }
    for (let row = 0; row < board.height; row += 1) {
        for (let col = 0; col < board.width; col += 1) {
            const coord = { row, col };
            if (isAvailable(board, coord))
                return coord;
        }
    }
    return { row: -1, col: -1 };
};
export const registerAiShot = (board, state, coord, outcome) => {
    if (!Number.isInteger(coord.row) || !Number.isInteger(coord.col)) {
        return;
    }
    board.shots.add(coordToKey(coord));
    if (outcome === "invalid" || outcome === "already_shot") {
        return;
    }
    if (outcome === "miss") {
        if (state.mode === "TRACK" && state.blocked) {
            if (state.lastTrackAttempt === "forward") {
                state.blocked.forward = true;
            }
            else if (state.lastTrackAttempt === "backward") {
                state.blocked.backward = true;
            }
            if (state.blocked.forward && state.blocked.backward) {
                state.mode = "TARGET";
                state.lineDirection = undefined;
                state.lastTrackAttempt = undefined;
                state.blocked = undefined;
            }
        }
        return;
    }
    if (!state.hitBuffer.some((item) => coordEquals(item, coord))) {
        state.hitBuffer.push({ ...coord });
    }
    for (const n of neighbors(coord)) {
        if (isAvailable(board, n))
            addUnique(state.targetQueue, n);
    }
    const direction = inferDirection(state.hitBuffer);
    if (direction) {
        state.mode = "TRACK";
        state.lineDirection = direction;
        state.blocked = { forward: false, backward: false };
    }
    else {
        state.mode = "TARGET";
    }
    if (outcome === "sink") {
        state.mode = "IDLE";
        state.targetQueue = [];
        state.hitBuffer = [];
        state.lineDirection = undefined;
        state.blocked = undefined;
        state.lastTrackAttempt = undefined;
    }
};
