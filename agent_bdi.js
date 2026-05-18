import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import 'dotenv/config';
import { Beliefs } from './beliefs.js';
import { Desires } from './desires.js';
import { Intentions } from './intentions.js';

// ─── Configuration ────────────────────────────────────────────────────────────

const TOKEN = process.env.TOKEN;
const HOST = process.env.HOST;

/** Hard-coded map dimensions for probability calculations. */
const MAX_TIME_HORIZON = 5; // Number of moves ahead to predict
const MAX_AGENTS = 50; // Maximum number of agents to track

// ─── State ──────────────────────────────────────────────────────────────────

const myBeliefs = new Beliefs();
const myDesires = new Desires(myBeliefs);
const myIntentions = new Intentions(myDesires, myBeliefs, generatePathTo);
myDesires.setLinkedIntentions(myIntentions); // create circular reference for dynamic updates

// ─── Connection ───────────────────────────────────────────────────────────────
const socket = DjsConnect(HOST, TOKEN);
if (!socket) {
    console.log('[ERROR] Failed to connect to server.');
    process.exit(1);
} else {
    console.log('[INIT] Connected to server.');
}

// ─── Event listeners ────────────────────────────────────────────────────────

/**
 * Updates the agent's vision range from game config.
 */
socket.onConfig((config) => {
    myBeliefs.setVisionRange(config.GAME.player.observation_distance);
    console.log(`[CONFIG] Vision range: ${myBeliefs.getVisionRange()}`);
});

/**
 * Updates the agent's position and ID in beliefs.
 */
socket.on('you', (me) => {
    myBeliefs.updatePlayerPosition(me.x ?? 0, me.y ?? 0);
    if (me.id) {
        myBeliefs.setAgentId(me.id);
    }
    console.log(`[YOU] Updated position → x:${me.x}, y:${me.y} and carrying ${myBeliefs.getCarriedParcels().size} parcels.`);
});

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

    // ── brf(B, ρ): belief revision avec delta ──────────────────
    const delta = myBeliefs.updatePercepts(parcels, agents);

    // TODO: find solutions because it's creating error...
    // myBelief.updateProbabilityMap();

    // ─── BDI LOOP v7 ──────────────────────────────────────────────────────

    // Step 1: Generate desires from beliefs
    myDesires.genOption(myBeliefs);
    console.log(`[DESIRES] Current desires: ${[...myDesires.getDesires()].join(', ')}`);

    // Step 2: reconsider(I, B) — seulement sur delta
    if (myIntentions.reconsider(delta))
    {
        console.log('[BDI] Reconsidering intention...');
        myIntentions.desiresToIntention();
        myIntentions.filterIntention();
    }

    // Step 3: sound(π, I, B) — replan si plan invalide
    if (myIntentions.getPlan().length === 0 || !myIntentions.isPlanValid())
    {
        console.log('[BDI] Plan invalid or empty, replanning...');
        if (myIntentions.getFilteredIntentions().length > 0)
        {
            myIntentions.setPlan();
        }
        else
        {
            console.log('[BDI] No valid objectives available');
        }
    }

    // ─── EXECUTION ────────────────────────────────────────────────────────────
    // COMMENTED BECAUSE IT INTERFERES WITH PICKUP ACTIONS
    // Reactive part: immediate pickup/delivery if adjacent
    // for (let p of myBeliefs.getVisibleParcels()) {
    //     if (!p.carriedBy) {
    //         if (myBeliefs.getPlayerPosition().x == p.x - 1 && myBeliefs.getPlayerPosition().y == p.y) {
    //             console.log('pickup right');
    //             await socket.emitMove('right');
    //         } else if (myBeliefs.getPlayerPosition().x == p.x + 1 && myBeliefs.getPlayerPosition().y == p.y) {
    //             await socket.emitMove('left');
    //             console.log('pickup left');
    //         } else if (myBeliefs.getPlayerPosition().y == p.y - 1 && myBeliefs.getPlayerPosition().x == p.x) {
    //             await socket.emitMove('up');
    //             console.log('pickup up');
    //         } else if (myBeliefs.getPlayerPosition().y == p.y + 1 && myBeliefs.getPlayerPosition().x == p.x) {
    //             await socket.emitMove('down');
    //             console.log('pickup down');
    //         }
    //         if (myBeliefs.getPlayerPosition().x == p.x && myBeliefs.getPlayerPosition().y == p.y) {
    //             await socket.emitPickup();
    //             console.log('pickup');
    //         }
    //     }
    // }

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
    myBeliefs.setMapWidth(width + 1); // error of map dimension
    myBeliefs.setMapHeight(height + 1);

    // Normalize tiles to have numeric type
    myBeliefs.setTiles(tiles.map(t => ({
        x: t.x,
        y: t.y,
        type: typeof t.type === 'string' ? parseInt(t.type) : t.type
    })));

    console.log(`[MAP] Tiles:`, myBeliefs.getTiles());
    console.log(`[MAP] Map received: ${myBeliefs.getMapWidth()}x${myBeliefs.getMapHeight()}`);

    myBeliefs.defineDeliveryPoint(myBeliefs.getTiles());
    myBeliefs.defineSpawnPoint(myBeliefs.getTiles());
    setTimeout(() => {}, 1000);
    // Planning is now handled in sensing events
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
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
    const walkable = new Array(myBeliefs.getMapWidth());
    for (let x = 0; x < myBeliefs.getMapWidth(); x++) {
        walkable[x] = new Array(myBeliefs.getMapHeight()).fill(true);
    }

    // Mark non-walkable tiles (type 0)
    myBeliefs.getTiles().forEach(tile => {
        if (tile.type == 0) {
            walkable[tile.x][tile.y] = false;
        }
    });

    // A* algorithm
    const openSet = new Set();
    const closedSet = new Set();
    const gScore = new Array(myBeliefs.getMapWidth()).fill(null).map(() => new Array(myBeliefs.getMapHeight()).fill(Infinity));
    const fScore = new Array(myBeliefs.getMapWidth()).fill(null).map(() => new Array(myBeliefs.getMapHeight()).fill(Infinity));
    const cameFrom = new Array(myBeliefs.getMapWidth()).fill(null).map(() => new Array(myBeliefs.getMapHeight()).fill(null));

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
            if (neighbor.x < 0 || neighbor.x >= myBeliefs.getMapWidth() || neighbor.y < 0 || neighbor.y >= myBeliefs.getMapHeight()) {
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
    const action = myIntentions.getNextAction();
    if (!action) return;

    if (action.startsWith('move_')) {
        const direction = action.split('_')[1];
        let validDirection = null;

        if (direction === 'up' || direction === 'down' || direction === 'left' || direction === 'right') {
            validDirection = direction;
        }

        if (!validDirection) {
            console.log(`[ACTION] Invalid direction: ${direction}`);
            myIntentions.clearPlan();
            return;
        }

        const moved = await socket.emitMove(validDirection);
        if (!moved) {
            console.log(`[ACTION] Move ${direction} failed, will retry.`);
            // Le plan reste intact, isPlanValid() le réévaluera
            // si l'objectif devient vraiment inaccessible
        } else {
            console.log(`[ACTION] Moved ${direction}.`);
        }

    } else if (action.startsWith('pickup_')) {
        const picked = await socket.emitPickup();
        if (picked && picked.length > 0) {
            for (const p of picked) {
                myBeliefs.addCarriedParcel(p.id);
                console.log(`[ACTION] Picked up parcel ${p.id}.`);
            }
            // Remove current objective as it's completed
            myIntentions.clearPlan();
        } else {
            console.log(`[ACTION] Pickup failed - parcel may have been taken by another agent`);
            myIntentions.clearPlan();
        }

    } else if (action === 'putdown') {
        const putedDown = await socket.emitPutdown();
        if (putedDown && putedDown.length > 0) {
            myBeliefs.getCarriedParcels().clear();
            for (const p of putedDown) {
                console.log(`[ACTION] Putdown parcel ${p.id}.`);
            }
            // Remove current objective as it's completed
            myIntentions.clearPlan();
        } else {
            console.log(`[ACTION] Putdown failed - no parcels to deliver`);
            myIntentions.clearPlan();
        }
    }

    // Delay before next action
    await new Promise(resolve => setTimeout(resolve, 500));
}
