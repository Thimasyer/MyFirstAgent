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
         * @type {Array<number>}
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
    constructor() {
        /** @type {Array<string>} Sequence of actions. */
        this.plan = [];

        /**
         * Intention
         * @type {Array<string>}
         */
        this.FilteredIntention = []; 

        /**
         * Intention
         * @type {Array<string>}
         */
        this.Intention = []; 
    }

    /** 
    *@param {Set<string>} setDesired
    */
    fiterIntention(setDesired) {
        /*à partir des desired qui sont pas trié :
        - regarder ceux réalisable
        - les trier d'une manière non indépendante 
        - met à jour FIlteredIntention
        - mettre à jour plan, la 1ere intention*/
    }

    /**
     * Sets a new plan.
     * @param {Array<string>} FilteredItention
     */
    setPlan(FilteredItention) {
        this.plan = FilteredItention[0];
        /* supprimer la 1ere attention*/
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
    // --------- Update beliefs ---------
    beliefs.updateVisibleParcels(data.parcels ?? []);
    beliefs.updateVisibleAgents(data.agents ?? []);

    //TODO: find solutions becasue it's creating error...
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

        } else if (desires.setDesires.has('go_to_spawn_point')) {
            // Simple path finding
            const spawnPoint = findNearestSpawnPoint(beliefs.playerPosition, beliefs.spawnPoint);
            if (spawnPoint) {
                const plan = generatePathTo(beliefs.playerPosition, spawnPoint);
                intentions.setPlan(plan);
                console.log(`[PLAN] Moving to spawn point at (${spawnPoint.x}, ${spawnPoint.y})`);
                console.log('[PLAN IS]', intentions.plan);
            }
        }
    }

    // Reactive part
    for ( let p of beliefs.visibleParcels) {
        if ( ! p.carriedBy ) {
            if      ( beliefs.playerPosition.x == p.x-1 && beliefs.playerPosition.y == p.y )
                await socket.emitMove('right');
            else if ( beliefs.playerPosition.x == p.x+1 && beliefs.playerPosition.y == p.y )
                await socket.emitMove('left')
            else if ( beliefs.playerPosition.y == p.y-1 && beliefs.playerPosition.x == p.x )
                await socket.emitMove('up')
            else if ( beliefs.playerPosition.y == p.y+1 && beliefs.playerPosition.x == p.x )
                await socket.emitMove('down')

            if ( beliefs.playerPosition.x == p.x && beliefs.playerPosition.y == p.y ) {
                await socket.emitPickup();
            }
        }
    }
    // Execute next action if available
    await executeNextAction();
});

/**
 * Main logic: triggered once when the map is received.
 * @param {Array<{x: number, y: number, type: number}>} tiles
 */
socket.on('map', (height, width, tiles) => {
    beliefs.mapWidth = width+1; // error of map dimension
    beliefs.mapHeight = height+1;
    beliefs.tiles = tiles; // store tiles in beliefs for later use in pathfinding
    console.log(`[MAP] Tiles:`, tiles);
    console.log(`[MAP] Map received: ${beliefs.mapWidth}x${beliefs.mapHeight}`);
 
    beliefs.defineDeliveryPoint(tiles);
    beliefs.defineSpawnPoint(tiles);
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
 * 
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
 */
function heuristic(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Reconstructs the path from cameFrom map
 * @returns {Array<string>} List of actions to take from start to goal.
 * @param {Array<Array<{x: number, y: number, action: string}>>} cameFrom
 * @param {x: number, y: number} current
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
 */
async function executeNextAction() {
    const action = intentions.getNextAction();
    if (!action) return;

    if (action.startsWith('move_')) {
        const direction = action.split('_')[1];
        const moved = await socket.emitMove(direction);
        if (!moved) {
            console.log(`[ACTION] Move ${direction} failed.`);
            intentions.plan = []; // Clear the remaining plan if move fails
        } else {
            console.log(`[ACTION] Moved ${direction}.`);
        }

    } else if (action.startsWith('pickup_')) {
        const parcelId = action.substring('pickup_'.length); 
        const picked = await socket.emitPickup();
        for (const p of picked){
            beliefs.addCarriedParcel(p.id); // only if confirmed by the server
            desires.setDesires.delete('pickup_'); // after pickup, we should not desire to pickup anymore
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