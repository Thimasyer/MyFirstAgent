import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import 'dotenv/config';

// ─── Configuration ────────────────────────────────────────────────────────────

const TOKEN = process.env.TOKEN;
const URL = 'ws://' + process.env.HOST;

/** Hard-coded map dimensions for probability calculations. */
const MAP_WIDTH = 24;
const MAP_HEIGHT = 24;
const MAX_TIME_HORIZON = 5; // Number of moves ahead to predict
const MAX_AGENTS = 50; // Maximum number of agents to track

// ─── Beliefs Class ────────────────────────────────────────────────────────────

/**
 * Class representing the agent's beliefs.
 */
class Beliefs {
    constructor() {
        /** @type {{ x: number, y: number }} Player's current position. */
        this.playerPosition = { x: 0, y: 0 };

        /** @type {Array<{ id: string }>} Items the player is carrying. */
        this.carried = [];

        /**
         * List of parcels seen on the map.
         * @type {Array<{ id: string, x: number, y: number }>}
         */
        this.visibleParcels = [];

        /**
         * List of agents seen on the map.
         * @type {Array<{ id: string, x: number, y: number }>}
         */
        this.visibleAgents = [];

        /**
         * Probability map: for each position, time step, and agent, probability of being there.
         * Dimensions: [x][y][time][agentIndex]
         * @type {Array<Array<Array<Array<number>>>>}
         */
        this.probabilityMap = Array.from({ length: MAP_WIDTH }, () =>
            Array.from({ length: MAP_HEIGHT }, () =>
                Array.from({ length: MAX_TIME_HORIZON }, () =>
                    Array(MAX_AGENTS).fill(0)
                )
            )
        );
    }

    /**
     * Updates the player's position.
     * @param {number} x
     * @param {number} y
     */
    updatePlayerPosition(x, y) {
        this.playerPosition = { x, y };
    }

    /**
     * Updates the carried items.
     * @param {Array<{ id: string }>} carried
     */
    updateCarried(carried) {
        this.carried = carried;
    }

    /**
     * Updates visible parcels.
     * @param {Array<{ id: string, x: number, y: number }>} parcels
     */
    updateVisibleParcels(parcels) {
        this.visibleParcels = parcels;
    }

    /**
     * Updates visible agents.
     * @param {Array<{ id: string, x: number, y: number }>} agents
     */
    updateVisibleAgents(agents) {
        this.visibleAgents = agents;
    }

    /**
     * Updates probability map based on current beliefs.
     * Simplified: for each agent, assume random movement.
     */
    updateProbabilityMap() {
        // Reset map
        for (let x = 0; x < MAP_WIDTH; x++) {
            for (let y = 0; y < MAP_HEIGHT; y++) {
                for (let t = 0; t < MAX_TIME_HORIZON; t++) {
                    for (let a = 0; a < Math.min(this.visibleAgents.length, MAX_AGENTS); a++) {
                        this.probabilityMap[x][y][t][a] = 0;
                    }
                }
            }
        }

        // For each agent, predict positions
        this.visibleAgents.slice(0, MAX_AGENTS).forEach((agent, index) => {
            let currentX = agent.x;
            let currentY = agent.y;
            this.probabilityMap[Math.floor(currentX)][Math.floor(currentY)][0][index] = 1; // At time 0, certain

            for (let t = 1; t < MAX_TIME_HORIZON; t++) {
                // Simple prediction: equal probability to adjacent cells
                const directions = [
                    { dx: 0, dy: 1 }, // up
                    { dx: 0, dy: -1 }, // down
                    { dx: 1, dy: 0 }, // right
                    { dx: -1, dy: 0 } // left
                ];
                directions.forEach(dir => {
                    const nx = Math.floor(currentX) + dir.dx;
                    const ny = Math.floor(currentY) + dir.dy;
                    if (nx >= 0 && nx < MAP_WIDTH && ny >= 0 && ny < MAP_HEIGHT) {
                        this.probabilityMap[nx][ny][t][index] += 0.25; // Equal prob
                    }
                });
            }
        });
    }
}

// ─── Desires ──────────────────────────────────────────────────────────────────

/**
 * Simple desires: pick up nearest parcel, deliver carried parcels.
 */
class Desires {
    constructor(beliefs) {
        this.beliefs = beliefs;
    }

    /**
     * Gets the current desires based on beliefs.
     * @returns {Array<string>} List of desires.
     */
    getDesires() {
        const desires = [];
        if (this.beliefs.visibleParcels.length > 0) {
            desires.push('pickup_parcel');
        }
        if (this.beliefs.carried.length > 0) {
            desires.push('deliver_parcel');
        }
        return desires;
    }
}

// ─── Intentions ───────────────────────────────────────────────────────────────

/**
 * Current intention: the plan being executed.
 */
class Intentions {
    constructor() {
        /** @type {Array<string>} Sequence of actions. */
        this.plan = [];
    }

    /**
     * Sets a new plan.
     * @param {Array<string>} plan
     */
    setPlan(plan) {
        this.plan = plan;
    }

    /**
     * Gets the next action.
     * @returns {string|null}
     */
    getNextAction() {
        return this.plan.shift() || null;
    }
}

// ─── State ────────────────────────────────────────────────────────────────────

const beliefs = new Beliefs();
const desires = new Desires(beliefs);
const intentions = new Intentions();

// ─── Connection ───────────────────────────────────────────────────────────────

console.log('[INIT] Connecting to server...');
const socket = DjsConnect(URL, TOKEN);

// ─── Event listeners ──────────────────────────────────────────────────────────

/**
 * Updates the agent's position in beliefs.
 */
socket.on('you', (me) => {
    beliefs.updatePlayerPosition(me.x, me.y);
    console.log(`[POSITION] Updated position → x:${me.x}, y:${me.y}`);
});

/**
 * Updates visible parcels and agents from sensing data.
 * Then, updates desires and intentions if needed.
 */
socket.onSensing(async (data) => {
    beliefs.updateVisibleParcels(data.parcels ?? []);
    beliefs.updateVisibleAgents(data.agents ?? []);
    beliefs.updateProbabilityMap();
    console.log(`[SENSING] ${beliefs.visibleParcels.length} parcel(s), ${beliefs.visibleAgents.length} agent(s) detected.`);

    // Update desires
    const currentDesires = desires.getDesires();
    console.log(`[DESIRES] Current desires: ${currentDesires.join(', ')}`);

    // If no current plan, generate one
    if (intentions.plan.length === 0) {
        if (currentDesires.includes('pickup_parcel')) {
            const nearestParcel = findNearestParcel(beliefs.playerPosition, beliefs.visibleParcels);
            if (nearestParcel) {
                const plan = generatePathTo(beliefs.playerPosition, { x: nearestParcel.x, y: nearestParcel.y });
                plan.push('pickup');
                intentions.setPlan(plan);
                console.log(`[PLAN] Moving to parcel at (${nearestParcel.x}, ${nearestParcel.y})`);
            }
        } else if (currentDesires.includes('deliver_parcel')) {
            // For delivery, assume deliver to a fixed point, e.g., (0,0) or something
            const deliveryPoint = { x: 0, y: 0 }; // Placeholder
            const plan = generatePathTo(beliefs.playerPosition, deliveryPoint);
            plan.push('putdown');
            intentions.setPlan(plan);
            console.log(`[PLAN] Delivering to (${deliveryPoint.x}, ${deliveryPoint.y})`);
        }
    }

    // Execute next action if available
    await executeNextAction();
});

/**
 * Main logic: triggered once when the map is received.
 */
socket.on('map', (width, height, tiles) => {
    console.log(`[MAP] Map received: ${width}x${height}`);
    // Planning is now handled in sensing events
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Finds the nearest parcel to the given position.
 * @param {{x: number, y: number}} position
 * @param {Array<{x: number, y: number}>} parcels
 * @returns {{x: number, y: number}|null}
 */
function findNearestParcel(position, parcels) {
    if (parcels.length === 0) return null;
    let nearest = parcels[0];
    let minDist = Math.abs(position.x - nearest.x) + Math.abs(position.y - nearest.y);
    for (const parcel of parcels) {
        const dist = Math.abs(position.x - parcel.x) + Math.abs(position.y - parcel.y);
        if (dist < minDist) {
            minDist = dist;
            nearest = parcel;
        }
    }
    return nearest;
}

/**
 * Generates a simple path from start to goal (straight line, no obstacles).
 * @param {{x: number, y: number}} start
 * @param {{x: number, y: number}} goal
 * @returns {Array<string>} List of actions.
 */
function generatePathTo(start, goal) {
    const actions = [];
    let current = { x: Math.round(start.x), y: Math.round(start.y) };
    const target = { x: Math.round(goal.x), y: Math.round(goal.y) };

    // Move horizontally
    while (current.x !== target.x) {
        if (current.x < target.x) {
            actions.push('move_right');
            current.x++;
        } else {
            actions.push('move_left');
            current.x--;
        }
    }

    // Move vertically
    while (current.y !== target.y) {
        if (current.y < target.y) {
            actions.push('move_up');
            current.y++;
        } else {
            actions.push('move_down');
            current.y--;
        }
    }

    return actions;
}

/**
 * Executes the next action in the intentions plan.
 */
async function executeNextAction() {
    const action = intentions.getNextAction();
    if (!action) return;

    if (action.startsWith('move_')) {
        const direction = action.split('_')[1];
        const moved = await socket.emitMove(direction);
        if (!moved) {
            console.log(`[ACTION] Move ${direction} failed.`);
        } else {
            console.log(`[ACTION] Moved ${direction}.`);
        }
    } else if (action === 'pickup') {
        await socket.emitPickup();
        console.log(`[ACTION] Attempted pickup.`);
    } else if (action === 'putdown') {
        await socket.emitPutdown();
        console.log(`[ACTION] Attempted putdown.`);
    }

    // Delay before next action
    await new Promise(resolve => setTimeout(resolve, 500));
}