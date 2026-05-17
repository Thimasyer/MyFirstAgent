import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import 'dotenv/config'

// ─── Configuration ────────────────────────────────────────────────────────────

const TOKEN = process.env.TOKEN;
const HOST = process.env.HOST;

/** Hard-coded map dimensions for probability calculations. */
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
        this.probabilityMap = Array.from({ length: this.mapWidth }, () =>
            Array.from({ length: this.mapHeight }, () =>
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
         * Spawn point location, set on map event.
         * @type {Array<{ x: number, y: number }>}
         */
        this.spawnPoint = []; // Spawn point, will be set on map event

        /**
         * Tiles of the map, set on map event.
         * @type {Array<{ x: number, y: number, type: number }>}
         */
        this.tiles = []; // Map tiles, will be set on map event

        /** Map dimensions, set on map event.
         * @type {number} 
         */
        this.mapWidth = 0; 

        /** Map dimensions, set on map event.
         * @type {number} 
         */
        this.mapHeight = 0; 
        
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
        this.carried.add({ id: parcelID });
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
        for (let x = 0; x < this.mapWidth; x++) {
            for (let y = 0; y < this.mapHeight; y++) {
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
                    if (nx >= 0 && nx < this.mapWidth && ny >= 0 && ny < this.mapHeight) {
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

    /**
     * Defines spawn points (type = 1) based on map tiles.
     * @param {Array<{x: number, y: number, type: number}>} tiles
     */
    defineSpawnPoint(tiles)
    {
        this.spawnPoint = tiles
            .filter(t => t.type == 1)
            .map(t => ({
                x: t.x,
                y: t.y
            }));
        console.log(`[MAP] Spawn points found: ${this.spawnPoint.length}`);
    }

    // /**
    //  * Calculates the actual map width from tiles
    //  * @param {Array<{x: number, y: number, type: number}> | Object} tiles
    //  * @returns {number} Maximum x coordinate + 1
    //  */
    // getMapWidth(tiles) {

    //     if (!tiles) return 0;
    //     const tilesArray = Array.isArray(tiles) ? tiles : Object.values(tiles);
    //     if (tilesArray.length === 0) return 0;
    //     const maxX = tilesArray.reduce((max, tile) => Math.max(max, tile.x), 0);
    //     return maxX + 1;
    // }

    // /**
    //  * Calculates the actual map height from tiles
    //  * @param {Array<{x: number, y: number, type: number}> | Object} tiles
    //  * @returns {number} Maximum y coordinate + 1
    //  */
    // getMapHeight(tiles) {
    //     if (!tiles) return 0;
    //     const tilesArray = Array.isArray(tiles) ? tiles : Object.values(tiles);
    //     if (tilesArray.length === 0) return 0;
    //     const maxY = tilesArray.reduce((max, tile) => Math.max(max, tile.y), 0);
    //     return maxY + 1;
    // }
}

// ─── Desires ──────────────────────────────────────────────────────────────────

/**
 * Simple desires: pick up nearest parcel, deliver carried parcels.
 */
class Desires {
    /**
     * @param {object} beliefs - Reference to beliefs
     */
    constructor(beliefs) {
        /**
         * Reference to beliefs, used to generate desires based on current state.
         * @type {object}
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
        for (let i = 0; i < this.beliefs.visibleParcels.length; i++) {
            this?.setDesires.add('pickup_'+this.beliefs.visibleParcels[i].x+'_'+this.beliefs.visibleParcels[i].y); // we can encode the parcel id in the desire for later reference
        }
        for (let i = 0; i < this.beliefs.spawnPoint.length; i++) {
            this?.setDesires.add('explore_'+this.beliefs.spawnPoint[i].x+'_'+this.beliefs.spawnPoint[i].y); // we can encode the spawn point id in the desire for later reference
        }
        for (let i = 0; i < this.beliefs.deliveryPoint.length; i++) {
            this?.setDesires.add('deliver_'+this.beliefs.deliveryPoint[i].x+'_'+this.beliefs.deliveryPoint[i].y); // we can encode the delivery point id in the desire for later reference
        }
        



        /* modfied, we put everything into desired and precise desiered
        if (this.beliefs.visibleParcels.length > 0) { // Only desire to pickup if there are parcels not already carried
            this.setDesires.add('pickup_parcel'); // TODO: precise parcel ID
        }
        console.log('[CARRIED]', this.beliefs.carried.size);
        if (this.beliefs.carried.size > 0) {
            this.setDesires.add('deliver_parcel');
        }
        if (this.beliefs.visibleParcels.length === 0 && this.beliefs.carried.size === 0
            && this.beliefs.deliveryPoint.length > 0
        ) {
            this.setDesires.add('go_to_spawn_point');
        }*/
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
    /**
     * @param {object} beliefs - Reference to beliefs
     */
    constructor(beliefs) {
        /** @type {object} Reference to beliefs */
        this.beliefs = beliefs;

        /** @type {Array<string>} Sequence of actions. */
        this.plan = [];

        /**
         * Filtered Intentions: optimal sequence of objectives
         * @type {Array<string>}
         */
        this.filteredIntention = []; 

        /**
         * Intentions: feasible desires (unordered)
         * @type {Array<string>}
         */
        this.intention = []; 

        /**
         * Current objective being executed
         * @type {string|null}
         */
        this.currentObjective = null;
    }

    /**
     * Converts desires to intentions by filtering feasible ones.
     * Only desires that are currently achievable are added to intention.
     * @param {Set<string>} setDesires - Set of desires (pickup_x_y, deliver_x_y, explore_x_y)
     */
    desiresToIntention(setDesires) {
        this.intention = [];
        
        for (const desire of setDesires) {
            if (desire.startsWith('pickup_')) {
                // Always feasible if we can see the parcel
                this.intention.push(desire);
            } else if (desire.startsWith('deliver_')) {
                // Only feasible if we carry at least one parcel
                if (this.beliefs.carried.size > 0) {
                    this.intention.push(desire);
                }
            } else if (desire.startsWith('explore_')) {
                // Always feasible
                this.intention.push(desire);
            }
        }
        
        console.log(`[INTENTION] Converted to intentions: ${this.intention.join(', ')}`);
    }

    /**
     * Filters intentions to create an optimal sequence of objectives.
     * This is the CORE of the game logic.
     * Strategy: Prioritize pickup -> deliver cycles based on proximity and reward.
     * @param {object} beliefs - Current beliefs about the environment
     */
    filterIntention(beliefs) {
        this.filteredIntention = [];
        
        if (this.intention.length === 0) {
            console.log('[FILTER] No intentions to filter');
            return;
        }

        // Separate desires by type
        const pickups = this.intention.filter(d => d.startsWith('pickup_'));
        const delivers = this.intention.filter(d => d.startsWith('deliver_'));
        const explores = this.intention.filter(d => d.startsWith('explore_'));

        // Build objective sequence based on current state and strategy
        const sequence = [];

        // Strategy: If carrying items, deliver first; otherwise, try to pickup
        if (beliefs.carried.size > 0 && delivers.length > 0) {
            // Prioritize delivery of carried parcels
            // Select closest delivery point
            const closest = this.findClosestObjective(delivers, beliefs);
            if (closest) {
                sequence.push(closest);
                // Remove from delivers to avoid duplicates
                delivers.splice(delivers.indexOf(closest), 1);
            }
        }

        // After delivering (or if not carrying), pickup a single parcel rather than a long chain
        if (pickups.length > 0 && beliefs.carried.size === 0) {
            const closestPickup = this.findClosestObjective(pickups, beliefs);
            if (closestPickup) {
                sequence.push(closestPickup);
            }
        }

        // If already carrying items, do not plan multiple pickups; deliver first.
        // If no pickup is selected and no delivery is needed, fallback to exploration.
        if (sequence.length === 0 && explores.length > 0) {
            const closest = this.findClosestObjective(explores, beliefs);
            if (closest) {
                sequence.push(closest);
            }
        }

        this.filteredIntention = sequence;
        console.log(`[FILTER] Filtered intention sequence: ${this.filteredIntention.join(' -> ')}`);
    }

    /**
     * Finds the closest objective among a list of objectives.
     * Extracts coordinates from objective string (e.g., "pickup_5_3" -> x=5, y=3)
     * @param {Array<string>} objectives - List of objectives
     * @param {Beliefs} beliefs - Current beliefs
     * @returns {string|null} - Closest objective or null
     */
    findClosestObjective(objectives, beliefs) {
        if (objectives.length === 0) return null;

        let closest = objectives[0];
        let minDist = this.getObjectiveDistance(objectives[0], beliefs);

        for (const obj of objectives) {
            const dist = this.getObjectiveDistance(obj, beliefs);
            if (dist < minDist) {
                minDist = dist;
                closest = obj;
            }
        }
        return closest;
    }

    /**
     * Groups objectives by proximity to minimize total distance.
     * @param {Array<string>} objectives - List of objectives
     * @param {Beliefs} beliefs - Current beliefs
     * @returns {Array<string>} - Sorted objectives by proximity
     */
    groupNearbyObjectives(objectives, beliefs) {
        const sorted = [...objectives].sort((a, b) => {
            const distA = this.getObjectiveDistance(a, beliefs);
            const distB = this.getObjectiveDistance(b, beliefs);
            return distA - distB;
        });
        return sorted;
    }

    /**
     * Calculates Manhattan distance to an objective.
     * @param {string} objective - Objective string (e.g., "pickup_5_3")
     * @param {Beliefs} beliefs - Current beliefs
     * @returns {number} - Distance in steps
     */
    getObjectiveDistance(objective, beliefs) {
        const parts = objective.split('_');
        if (parts.length < 3) return Infinity;
        
        const x = parseInt(parts[1]);
        const y = parseInt(parts[2]);
        
        const dist = Math.abs(beliefs.playerPosition.x - x) + Math.abs(beliefs.playerPosition.y - y);
        return dist;
    }

    /**
     * Sets the plan from the current objective in filteredIntention.
     * Generates path to the objective and appends appropriate action.
     */
    setPlan() {
        if (this.filteredIntention.length === 0) {
            console.log('[PLAN] filteredIntention empty, falling back to first intention');
            if (this.intention.length > 0) {
                this.filteredIntention = [...this.intention];
            }
        }

        const objective = this.filteredIntention.shift();
        if (!objective) {
            console.log('[PLAN] No objectives to plan');
            this.plan = [];
            this.currentObjective = null;
            return;
        }

        this.currentObjective = objective;
        
        // Parse objective
        const parts = objective.split('_');
        const type = parts[0];
        const x = parseInt(parts[1]);
        const y = parseInt(parts[2]);
        
        // Generate path to objective location
        const path = generatePathTo(this.beliefs.playerPosition, { x, y });
        
        // Add action at destination
        if (type === 'pickup') {
            path.push(objective); // Use full objective string with id for later
        } else if (type === 'deliver') {
            path.push('putdown');
        } else if (type === 'explore') {
            // No action needed for explore, just reach the location
        }
        
        this.plan = path;
        console.log(`[PLAN] New plan set for objective "${objective}": ${path.length} actions; filteredIntention remaining ${this.filteredIntention.length}`);
    }

    /**
     * Checks if current plan is still valid.
     * Returns false if the target location is now unreachable or objective is no longer valid.
     * @returns {boolean}
     */
    isPlanValid() {
        if (this.plan.length === 0) return false;
        if (!this.currentObjective) return false;

        // Check if objective target is still reachable
        const parts = this.currentObjective.split('_');
        const type = parts[0];
        const x = parseInt(parts[1]);
        const y = parseInt(parts[2]);
        
        // For pickup objectives, check if parcel still exists
        if (type === 'pickup') {
            const parcelId = parts[3]; // if stored
            const still_visible = this.beliefs.visibleParcels.some(p => !p.carriedBy && p.x === x && p.y === y);
            if (!still_visible) {
                console.log(`[PLAN] Plan invalidated: parcel at (${x}, ${y}) no longer visible`);
                return false;
            }
        }

        // For deliver objectives, check if we still carry items
        if (type === 'deliver') {
            if (this.beliefs.carried.size === 0) {
                console.log(`[PLAN] Plan invalidated: no longer carrying parcels`);
                return false;
            }
        }

        return true;
    }

    /**
     * Revises the plan: clears current plan and generates a new one.
     * @param {Set<string>} desires - Current desires
     */
    revisePlan(desires) {
        console.log('[PLAN] Revising plan...');
        this.plan = [];
        this.currentObjective = null;
        this.filteredIntention = [];
        this.desiresToIntention(desires);
        this.filterIntention(this.beliefs);
        console.log(`[PLAN] Revising filtered intention: ${this.filteredIntention.join(', ')}`);
        this.setPlan();
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
const intentions = new Intentions(beliefs);

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
    beliefs.updatePlayerPosition(me.x ?? 0, me.y ?? 0);
    console.log(`[YOU] Updated position → x:${me.x}, y:${me.y}`);
});

// TODO: many action in parallel can happen here
/**
 * Updates visible parcels and agents from sensing data.
 * Then, uses BDI model: generate desires, convert to intentions, filter to create optimal plan.
 */
socket.onSensing(async (data) => {
    // Normalize data to handle undefined properties
    const parcels = (data.parcels ?? []).map(p => ({
        id: p.id,
        x: p.x ?? 0,
        y: p.y ?? 0,
        carriedBy: p.carriedBy ?? '',
        reward: p.reward ?? 0
    }));
    
    const agents = (data.agents ?? []).map(a => ({
        id: a.id,
        x: a.x ?? 0,
        y: a.y ?? 0
    }));

    beliefs.updateVisibleParcels(parcels);
    beliefs.updateVisibleAgents(agents);
    //TODO: find solutions becasue it's creating error...
    // beliefs.updateProbabilityMap();

    // ─── BDI LOOP ────────────────────────────────────────────────────────────

    // Step 1: Generate desires from beliefs
    desires.genOption();
    console.log(`[DESIRES] Current desires: ${[...desires.setDesires].join(', ')}`);

    // Step 2: Check if current plan is still valid
    if (intentions.plan.length > 0 && !intentions.isPlanValid()) {
        console.log('[BDI] Current plan is no longer valid, revising...');
        intentions.revisePlan(desires.setDesires);
    }

    // Step 3: If no plan, create one from BDI deliberation
    if (intentions.plan.length === 0) {
        // Convert desires to intentions (filter feasible ones)
        intentions.desiresToIntention(desires.setDesires);

        // Filter intentions to create optimal sequence
        intentions.filterIntention(beliefs);

        // Set plan for first objective
        if (intentions.filteredIntention.length > 0) {
            intentions.setPlan();
        } else {
            console.log('[BDI] No valid objectives available');
        }
    }

    // ─── EXECUTION ────────────────────────────────────────────────────────────

    // Reactive part: immediate pickup/delivery if adjacent
    for (let p of beliefs.visibleParcels) {
        if (!p.carriedBy) {
            if (beliefs.playerPosition.x == p.x - 1 && beliefs.playerPosition.y == p.y)
                await socket.emitMove('right');
            else if (beliefs.playerPosition.x == p.x + 1 && beliefs.playerPosition.y == p.y)
                await socket.emitMove('left')
            else if (beliefs.playerPosition.y == p.y - 1 && beliefs.playerPosition.x == p.x)
                await socket.emitMove('up')
            else if (beliefs.playerPosition.y == p.y + 1 && beliefs.playerPosition.x == p.x)
                await socket.emitMove('down')

            if (beliefs.playerPosition.x == p.x && beliefs.playerPosition.y == p.y) {
                await socket.emitPickup();
            }
        }
    }

    // Execute next action from plan
    await executeNextAction();
});

/**
 * Main logic: triggered once when the map is received.
 * @param {number} height
 * @param {number} width
 * @param {Array<{ x: number, y: number, type: string }>} tiles
 */
socket.on('map', (height, width, tiles) => {
    beliefs.mapWidth = width + 1; // error of map dimension
    beliefs.mapHeight = height + 1;
    
    // Normalize tiles to have numeric type
    beliefs.tiles = tiles.map(t => ({
        x: t.x,
        y: t.y,
        type: typeof t.type === 'string' ? parseInt(t.type) : t.type
    }));
    
    console.log(`[MAP] Tiles:`, beliefs.tiles);
    console.log(`[MAP] Map received: ${beliefs.mapWidth}x${beliefs.mapHeight}`);
 
    beliefs.defineDeliveryPoint(beliefs.tiles);
    beliefs.defineSpawnPoint(beliefs.tiles);
    setTimeout(() => {}, 1000);
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

/**
 * Finds the nearest delivery point to the given position.
 * @param {{x: number, y: number} position
 * @param {Array<{x: number, y: number, distance: number}>} deliveryPoints
 * @returns {{x: number, y: number}|null}
 */
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

/**
 * Finds the nearest spawn point to the given position.
 * @param {{x: number, y: number}} position
 * @param {Array<{x: number, y: number}>} spawnPoints
 * @returns {{x: number, y: number}|null}
 */
function findNearestSpawnPoint(position, spawnPoints) {
    if (spawnPoints.length === 0) return null;
    let nearest = spawnPoints[0];
    let minDist = Math.abs(position.x - nearest.x) + Math.abs(position.y - nearest.y);
    for (const point of spawnPoints) {
        const dist = Math.abs(position.x - point.x) + Math.abs(position.y - point.y);
        if (dist < minDist) {
            minDist = dist;
            nearest = point;
        }
    }
    return nearest;
}


/**
 * Generates a path from start to goal using A* algorithm, avoiding non-walkable tiles (type 0)
 * @param {{x: number, y: number}} start
 * @param {{x: number, y: number}} goal
 * @returns {Array<string>} List of move actions (move_up, move_down, move_left, move_right)
 */
function generatePathTo(start, goal) {
    const startPos = { x: Math.round(start.x), y: Math.round(start.y) };
    const goalPos = { x: Math.round(goal.x), y: Math.round(goal.y) };

    // Create a walkability grid from tiles
    const walkable = new Array(beliefs.mapWidth);
    for (let x = 0; x < beliefs.mapWidth; x++) {
        walkable[x] = new Array(beliefs.mapHeight).fill(true);
    }
    
    // Mark non-walkable tiles (type 0)
    beliefs.tiles.forEach(tile => {
        if (tile.type == 0) {
            walkable[tile.x][tile.y] = false;
        }
    });

    // A* algorithm
    const openSet = new Set();
    const closedSet = new Set();
    const gScore = new Array(beliefs.mapWidth).fill(null).map(() => new Array(beliefs.mapHeight).fill(Infinity));
    const fScore = new Array(beliefs.mapWidth).fill(null).map(() => new Array(beliefs.mapHeight).fill(Infinity));
    const cameFrom = new Array(beliefs.mapWidth).fill(null).map(() => new Array(beliefs.mapHeight).fill(null));

    gScore[startPos.x][startPos.y] = 0;
    fScore[startPos.x][startPos.y] = heuristic(startPos, goalPos);
    openSet.add(`${startPos.x},${startPos.y}`);

    const directions = [
        { dx: 0, dy: -1, action: 'move_down' },
        { dx: 0, dy: 1, action: 'move_up' },
        { dx: -1, dy: 0, action: 'move_left' },
        { dx: 1, dy: 0, action: 'move_right' }
    ];

    while (openSet.size > 0) {
        // Find node with lowest fScore
        let current = null;
        let minFScore = Infinity;
        
        for (const node of openSet) {
            const [x, y] = node.split(',').map(Number);
            if (fScore[x][y] < minFScore) {
                minFScore = fScore[x][y];
                current = { x, y };
            }
        }

        if (!current) {
            break; // No valid path found
        }

        if (current.x === goalPos.x && current.y === goalPos.y) {
            // Reconstruct path
            return reconstructPath(cameFrom, current);
        }

        openSet.delete(`${current.x},${current.y}`);
        closedSet.add(`${current.x},${current.y}`);

        for (const dir of directions) {
            const neighbor = { x: current.x + dir.dx, y: current.y + dir.dy };
            
            // Check boundaries
            if (neighbor.x < 0 || neighbor.x >= beliefs.mapWidth || neighbor.y < 0 || neighbor.y >= beliefs.mapHeight) {
                continue;
            }

            // Check if walkable
            if (!walkable[neighbor.x][neighbor.y]) {
                continue;
            }

            // Check if already evaluated
            if (closedSet.has(`${neighbor.x},${neighbor.y}`)) {
                continue;
            }

            const tentativeGScore = gScore[current.x][current.y] + 1;

            if (!openSet.has(`${neighbor.x},${neighbor.y}`)) {
                openSet.add(`${neighbor.x},${neighbor.y}`);
            } else if (tentativeGScore >= gScore[neighbor.x][neighbor.y]) {
                continue;
            }

            cameFrom[neighbor.x][neighbor.y] = { ...current, action: dir.action };
            gScore[neighbor.x][neighbor.y] = tentativeGScore;
            fScore[neighbor.x][neighbor.y] = tentativeGScore + heuristic(neighbor, goalPos);
        }
    }
    
    // No path found - fall back to blind path
    console.log('[PATHFINDING] No valid path found, falling back to blind path');
    return generatePathTo_blind(start, goal);
}

/**
 * Manhattan distance heuristic for A*
 * @param {{x: number, y: number}} a
 * @param {{x: number, y: number}} b
 * @returns {number}
 */
function heuristic(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Reconstructs the path from cameFrom map
 * @param {Array<Array<{x: number, y: number, action: string}|null>>} cameFrom
 * @param {{x: number, y: number}} current
 * @returns {Array<string>}
 */
function reconstructPath(cameFrom, current) {
    const path = [];
    while (cameFrom[current.x][current.y] !== null) {
        const parent = cameFrom[current.x][current.y];
        if (parent && parent.action) {
            path.unshift(parent.action);
        }
        if (!parent) break; // Stop if no parent
        current = parent;
    }
    return path;
}

// Attention: don't take care about non-walkable tiles 
/**
 * Generates a simple path from start to goal, avoiding obstacles
 * @param {{x: number, y: number}} start
 * @param {{x: number, y: number}} goal
 * @returns {Array<string>} List of actions.
 */
function generatePathTo_blind(start, goal) {
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
 * Handles movement, pickup, and putdown actions.
 * Clears plan on failure to trigger re-planning.
 */
async function executeNextAction() {
    const action = intentions.getNextAction();
    if (!action) return;

    if (action.startsWith('move_')) {
        const direction = action.split('_')[1];
        let validDirection = null;
        
        if (direction === 'up' || direction === 'down' || direction === 'left' || direction === 'right') {
            validDirection = direction;
        }
        
        if (!validDirection) {
            console.log(`[ACTION] Invalid direction: ${direction}`);
            intentions.plan = [];
            intentions.currentObjective = null;
            return;
        }
        
        const moved = await socket.emitMove(validDirection);
        if (!moved) {
            console.log(`[ACTION] Move ${direction} failed - plan blocked, will revise on next sensing.`);
            intentions.plan = []; // Clear plan to trigger re-planning
            intentions.currentObjective = null;
        } else {
            console.log(`[ACTION] Moved ${direction}.`);
        }

    } else if (action.startsWith('pickup_')) {
        const picked = await socket.emitPickup();
        if (picked && picked.length > 0) {
            for (const p of picked) {
                beliefs.addCarriedParcel(p.id);
                console.log(`[ACTION] Picked up parcel ${p.id}.`);
            }
            // Remove current objective as it's completed
            intentions.currentObjective = null;
        } else {
            console.log(`[ACTION] Pickup failed - parcel may have been taken by another agent`);
            intentions.plan = []; // Clear plan to trigger re-planning
            intentions.currentObjective = null;
        }

    } else if (action === 'putdown') {
        const putedDown = await socket.emitPutdown();
        if (putedDown && putedDown.length > 0) {
            beliefs.carried.clear();
            for (const p of putedDown) {
                console.log(`[ACTION] Putdown parcel ${p.id}.`);
            }
            // Remove current objective as it's completed
            intentions.currentObjective = null;
        } else {
            console.log(`[ACTION] Putdown failed - no parcels to deliver`);
            intentions.plan = []; // Clear plan to trigger re-planning
        }
    }
    
    // Delay before next action
    await new Promise(resolve => setTimeout(resolve, 500));
}