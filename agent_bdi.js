import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import 'dotenv/config'

// ─── Configuration ────────────────────────────────────────────────────────────

const TOKEN = process.env.TOKEN;
const HOST = process.env.HOST;

/** Hard-coded map dimensions for probability calculations. */
let MAP_WIDTH = 0; // Now set on map event
let MAP_HEIGHT = 0; // Now set on map event
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

        /** Set (instead a list) of parcels currently carried.  
         * @type {Set<{ id: string }>} Items the player is carrying. */
        this.carried = new Set();

        /**
         * List of parcels seen on the map.
         * @type {Array<{ id: string, x: number, y: number, carriedBy: string, reward: number }>}
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

        /**
         * Delivery point location, set on map event.
         * @type {Array<{ x: number, y: number, distance: number }>}
         */
        this.deliveryPoint = []; // Delivery point, will be set on map event

        /**
         * Tiles of the map, set on map event.
         * @type {Array<number>}
         */
        this.tiles = []; // Map tiles, will be set on map event
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
     * Adds a parcel to the carried set. (set is used to avoid duplicates)
     * @param {string} parcelID
     */
    addCarriedParcel(parcelID) {
        // add the just picked up new parcel ids to the carried set
        this.carried.add(parcelID);
    }

    /**
     * Updates visible parcels.
     * @param {Array<{ id: string, x: number, y: number, carriedBy: string, reward: number }>} parcels
     */
    updateVisibleParcels(parcels) {
        // visible parcels = not already carried-parcels
        this.visibleParcels = parcels.filter(p => !p.carriedBy);
        console.log('VISIBLE PARCELS', this.visibleParcels);
    }

    /**
     * Updates visible agents.
     * @param {Array<{ id: string, x: number, y: number }>} agents
     */
    updateVisibleAgents(agents) {
        this.visibleAgents = agents;
    }

    // TODO: find problems, creat error
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

    /**
     * Defines delivery tiles (type = 2) based on map tiles.
     * @param {Array<{x: number, y: number, type: number}>} tiles
     */
    defineDeliveryPoint(tiles)
    {
        this.deliveryPoint = tiles
            .filter(t => t.type == 2)
            .map(t => ({
                x: t.x,
                y: t.y,
                distance: Math.abs(this.playerPosition.x - t.x) + Math.abs(this.playerPosition.y - t.y)
            }));
        console.log(`[MAP] Delivery points found: ${this.deliveryPoint.length}`);
    }
}

// ─── Desires ──────────────────────────────────────────────────────────────────

/**
 * Simple desires: pick up nearest parcel, deliver carried parcels.
 */
class Desires {
    constructor(beliefs) {
        /**
         * Reference to beliefs, used to generate desires based on current state.
         * @type {Beliefs}
         */
        this.beliefs = beliefs;

        /**
         * Current desires, generated from beliefs. (set is used to avoid duplicates)
         * @type {Set<string>}
         */
        this.setDesires = new Set(); // to avoid duplicates
        
    }

    /**
     * Gets the current desires based on beliefs.
     */
    genOption() { // here we generate options, based on beliefs and intentions (if there are any)
                                                            // do we have to put a first intention at the begining? (like explore)
        this.setDesires.clear(); 
        if (this.beliefs.visibleParcels.length > 0) { // Only desire to pickup if there are parcels not already carried
            this.setDesires.add('pickup_parcel');
        }
        console.log('[CARRIED]', this.beliefs.carried.size);
        if (this.beliefs.carried.size > 0) {
            this.setDesires.add('deliver_parcel');
        }
        if (this.beliefs.visibleParcels.length === 0 && this.beliefs.carried.size === 0) {
            this.setDesires.add('explore');
        }
    }

    filterDesires() {
        // TODO: filter the setDesires based on current intentions
        // (if we have a plan to pickup, we should not desire to explore)
    
    }

    /**
     * Gets the desires set
     * @returns {Set<string>} Set of desires.
     */
    getDesires() {
        return this.setDesires;
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

        /**
         * Current intention
         */
        this.currentIntention = null; // could be 'pickup', 'deliver', 'explore', etc

        /**
         * Last intention, useful for debugging and filtering desires.
         * @type {Array<string>}
         */
        this.lastIntention = []; 
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

    /**
     * Generates a new intention based on desires and beliefs.
     * 
     */
    genIntention() {

    }
}

// ─── State ────────────────────────────────────────────────────────────────────

const beliefs = new Beliefs();
const desires = new Desires(beliefs);
const intentions = new Intentions();

// ─── Connection ───────────────────────────────────────────────────────────────
const socket = DjsConnect(HOST, TOKEN);
if (!socket) {
    console.log('[ERROR] Failed to connect to server.');
    process.exit(1);
} else {
    console.log('[INIT] Connected to server.');
}

// ─── Event listeners ──────────────────────────────────────────────────────────

/**
 * Updates the agent's position in beliefs.
 */
socket.on('you', (me) => {
    beliefs.updatePlayerPosition(me.x, me.y);
    console.log(`[YOU] Updated position → x:${me.x}, y:${me.y}`);
});

// TODO: many action in parallel can happen here
/**
 * Updates visible parcels and agents from sensing data.
 * Then, updates desires and intentions if needed.
 */
socket.onSensing(async (data) => {
    beliefs.updateVisibleParcels(data.parcels ?? []);
    beliefs.updateVisibleAgents(data.agents ?? []);
    //TODO: find solutions, create error...
    // beliefs.updateProbabilityMap();

    // Update desires
    desires.genOption();
    console.log(`[DESIRES] Current desires: ${[...desires.setDesires].join(', ')}`);

    // TODO: put it in planning function after revising the genIntention function
    if (intentions.plan.length === 0) {
        if (desires.setDesires.has('deliver_parcel')) {
            //const deliveryPoint = { x: 0, y: 0 }; // Not anymore fixed, now set on map event
            // search for the closest delivery point
            const deliveryPoint = findNearestDeliveryPoint(beliefs.playerPosition, beliefs.deliveryPoint);
            const plan = generatePathTo(beliefs.playerPosition, deliveryPoint);
            plan.push('putdown');
            intentions.setPlan(plan);
            console.log(`[PLAN] Delivering to (${deliveryPoint.x}, ${deliveryPoint.y})`);
        
        } else if (desires.setDesires.has('pickup_parcel')) {
            const nearestParcel = findNearestParcel(beliefs.playerPosition, beliefs.visibleParcels);
            if (nearestParcel) {
                const plan = generatePathTo(beliefs.playerPosition, { x: nearestParcel.x, y: nearestParcel.y });
                plan.push('pickup_'+nearestParcel.id); // we can encode the parcel id in the action for later reference
                intentions.setPlan(plan);
                console.log(`[PLAN] Moving to parcel ${nearestParcel.id} at (${nearestParcel.x}, ${nearestParcel.y})`);
            }

        } else if (desires.setDesires.has('explore')) {
            // Simple exploration: move randomly
            const directions = ['move_up', 'move_down', 'move_left', 'move_right'];
            const randomDirection = directions[Math.floor(Math.random() * directions.length)];
            intentions.setPlan([randomDirection]);
            console.log(`[PLAN] Exploring: ${randomDirection}`);
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
    console.log(`[MAP] Tiles:`, tiles);
    MAP_HEIGHT = height;
    MAP_WIDTH = width;

    beliefs.defineDeliveryPoint(tiles);
    setTimeout(() => {}, 4000);
    // Planning is now handled in sensing events
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Finds the nearest parcel to the given position.
 * @param {{x: number, y: number}} position
 * @param {Array<{id: string, x: number, y: number, carriedBy: string, reward: number}>} parcels
 * @returns {{id: string, x: number, y: number}|null}
 */
function findNearestParcel(position, parcels) {
    if (parcels.length === 0) return null;
    let nearest = parcels[0];
    let minDist = Math.abs(position.x - nearest.x) + Math.abs(position.y - nearest.y);
    for (const parcel of parcels) {
        if (!parcel.carriedBy) { // Only consider parcels not carried by others
            const dist = Math.abs(position.x - parcel.x) + Math.abs(position.y - parcel.y);
            if (dist < minDist) {
                minDist = dist;
                nearest = parcel;
            }
        }
    }
    return nearest;
}

 function findNearestDeliveryPoint(position, deliveryPoints) {
    if (deliveryPoints.length === 0) return null;
    let nearest = deliveryPoints[0];
    let minDist = Math.abs(position.x - nearest.x) + Math.abs(position.y - nearest.y);
    for (const point of deliveryPoints) {
        const dist = Math.abs(position.x - point.x) + Math.abs(position.y - point.y);
        if (dist < minDist) {
            minDist = dist;
            nearest = point;
        }
    }
    return nearest;
}


// [TODO] take care about non walkable tiles
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

    } else if (action.startsWith('pickup_')) {
        const parcelId = action.substring('pickup_'.length); 
        const picked = await socket.emitPickup();
        for (const p of picked){
            beliefs.addCarriedParcel(p.id); // only if confirmed by the server
            desires.setDesires.delete('pickup_parcel'); // after pickup, we should not desire to pickup anymore
            console.log(`[ACTION] Picked up parcel ${p.id}.`);
        }


    } else if (action === 'putdown') {
        const putedDown = await socket.emitPutdown();
        for (const p of putedDown){
            beliefs.carried.clear(); // we assume we put down all carried parcels
            desires.setDesires.delete('deliver_parcel'); // after putdown, we should not desire to deliver anymore
            console.log(`[ACTION] Putdown parcel ${p.id}.`);
        }
    }
    
    // Delay before next action
    await new Promise(resolve => setTimeout(resolve, 500));
}