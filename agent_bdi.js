/*******************************************************************************/
// File:          agent_bdi.js
// Description:   Main entry point for the BDI (Belief-Desire-Intention) agent.
//                Implements the agent's decision-making loop using the BDI model:
//                - Beliefs: Agent's knowledge/perception about the world (position, parcels, map, etc.)
//                - Desires: Agent's goals (pickup parcels, deliver, explore)
//                - Intentions: Agent's selected plans to achieve desires
// Include:       beliefs.js, desires.js, intentions.js       
// 
// TODO 1:    prendre un spritz
// TODO 2:    - Prendre en compte la position des joueurs dans reconsider.
//            - Que faire si l'agent n'arrive pas à réaliser une action? 
//              => Mémoire des actions échoué, puis refaire un plan sans l'action inachevable
//            - Rajouter les tiles fléchés à la logique
//            - Rajouter les crate (boite jaune) à la logique
//            - Faire parler l'agent

//
// TODO 3:    Where do we have to updateProbabilityMap()? 
//                 not in onSensing, take to long
/*******************************************************************************/

import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import 'dotenv/config';
import { Beliefs } from './beliefs.js';
import { Desires } from './desires.js';
import { Intentions } from './intentions.js';

// ─── Configuration ──────────────────────────────────────────────────────────

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
/** @type {boolean} Guard to prevent concurrent action execution */
let isExecuting = false;

// ─── Connection ───────────────────────────────────────────────────────────────
const socket = DjsConnect(HOST, TOKEN);
if (!socket) {
    console.log('[ERROR] Failed to connect to server.');
    process.exit(1);
} else {
    console.log('[INIT] Connected to server.');
}

// ****************************************************************************
// Event listeners 
// ****************************************************************************

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
        myBeliefs.setMyId(me.id);
    }
});

/**
 * Updates visible parcels and agents from sensing data.
 * Then, uses BDI model: generate desires, convert to intentions, filter to create optimal plan.
 */
socket.onSensing(async (data) => {
    // ****************** PERCEPT ***************************************
    // update of perceptions (if something has changed) 
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

    // delta {newParcels, goneParcelIds, newAgents, goneAgentIds} used for reconsidering 
    const delta = myBeliefs.updatePercepts(parcels, agents);
    if (Object.values(delta).some(arr => arr.length > 0)) {
        console.log('Delta:', delta);
    }
    // ***************** CORE OF BDI LOOP  ********************************
    await core_loop(delta);
    
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

    // Normalize tiles to have string type
    myBeliefs.setTiles(tiles.map(t => ({
        x: t.x,
        y: t.y,
        type: typeof t.type === 'number' ? t.type.toString() : t.type
    })));

    console.log(`[MAP] Tiles:`, myBeliefs.getTiles());
    console.log(`[MAP] Map received: ${myBeliefs.getMapWidth()}x${myBeliefs.getMapHeight()}`);

    // define the static data in belief
    myBeliefs.defineDeliveryPoint(myBeliefs.getTiles());
    myBeliefs.defineSpawnPoint(myBeliefs.getTiles());
});

/**
 * THE LOOP
 * @param {{
     *   newParcels: Array<{id: string, x: number, y: number, reward: number}>,
     *   goneParcelIds: Array<string>,
     *   newAgents: Array<{id: string, x: number, y: number}>,
     *   goneAgentIds: Array<string>
     * }} delta
 */
async function core_loop(delta)
{
    // look course n°4: BDI Loop diapo 35, agent control loop v7
    // *********** Line 5 to 9  ******************************    
    if (myIntentions.getPlan().length === 0) 
    {
        myDesires.genOption();
        myIntentions.desiresToIntention();
        myIntentions.filterIntention();
        myIntentions.setPlan();
    }
    

    // *********** Line 10: positive affirmation *************
    // if plan defined AND not succeded AND not impossible
    const shouldContinue =
       myIntentions.getPlan().length > 0  // not empty(π)
    && !myIntentions.succeeded()          // not succeeded(I, B)
    && !myIntentions.impossible();        // not impossible(I, B)

    if (shouldContinue)
    {
        // ******** Line 11+12 Execute action ****************
        // guard, for preventing launching several action in parallel
        // (onSensing is called every server frame, but executeNextAction take much more time)
        if (!isExecuting)
        {  
            isExecuting = true;
            try
            {
                await executeNextAction();
            }
            finally
            {
                isExecuting = false;
            }
        }

        // Belief and perception always update
        // ******** Line 16 Reconsider ***********************
        if (myIntentions.reconsider(delta))
        {
            console.log('[BDI] Reconsidering intention...');
            myDesires.genOption();
            myIntentions.desiresToIntention();
            myIntentions.filterIntention();
        }

        // ******** Line 20: sound (isPlanValid) *************
        // replan if plan invalide
        if (!myIntentions.isPlanValid())
        {
            console.log('[BDI] Plan invalid or empty, replanning...');
            if (myIntentions.getFilteredIntentions().length > 0)
            {
                myIntentions.setPlan();
            }
        }
    }
}

// ****************************************************************************
// Helpers function 
// ****************************************************************************

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

    // Mark non-walkable tiles (type "0")
    myBeliefs.getTiles().forEach(tile => {
        if (tile.type === "0") {
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
    return [];
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
 */async function executeNextAction()
{
    const action = myIntentions.getPlan()[0];
    if (!action) return;

    // ── MOVE ──────────────────────────────────────────────────
    if (action.startsWith('move_'))
    {
        const direction = action.split('_')[1];

        if (!['up','down','left','right'].includes(direction))
        {
            console.log(`[ACTION] Invalid direction: ${direction}`);
            myIntentions.clearPlan();
            return;
        }

        
        const moved = await socket.emitMove(direction);

        if (moved)
        {
            console.log(`[ACTION] Moved ${direction}.`);
            myIntentions.getNextAction(); // shift only on success
        }
        else
        {
            console.log(`[ACTION] Move ${direction} failed, will retry.`);
            // keep memory of the failed action
            if (myIntentions.recordFailedAction(action)) {
                console.log(`[ACTION] 3 consecutive failures for ${action}, triggering smart replan`);
                myIntentions.smartReplan(action);
            }
        }
    }

    // ── PICKUP ────────────────────────────────────────────────
    else if (action.startsWith('pickup_'))
    {
        const picked = await socket.emitPickup();

        if (picked && picked.length > 0)
        {
            for (const p of picked)
            {
                myBeliefs.addCarriedParcel(p.id);
                console.log(`[ACTION] Picked up parcel ${p.id}.`);
            }
            myIntentions.getNextAction(); // shift the pickup action
        }
        else
        {
            console.log(`[ACTION] Pickup failed.`);
            myIntentions.clearPlan();
        }
    }

    // ── PUTDOWN ───────────────────────────────────────────────
    else if (action === 'putdown')
    {
        const putDown = await socket.emitPutdown();

        if (putDown && putDown.length > 0)
        {
            myBeliefs.getCarriedParcels().clear();
            for (const p of putDown)
            {
                console.log(`[ACTION] Put down parcel ${p.id}.`);
            }
            myIntentions.getNextAction(); // shift the putdown action
            myIntentions.clearPlan();     // intention completed
        }
        else
        {
            console.log(`[ACTION] Putdown failed.`);
            myIntentions.clearPlan();
        }
    }
}
