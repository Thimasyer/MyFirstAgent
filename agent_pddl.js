// @ts-nocheck
/**
 * PDDL Agent for Deliveroo Game
 * This agent uses PDDL planning to solve delivery tasks in a grid-based game.
 * It follows the BDI (Beliefs, Desires, Intentions) architecture.
 *
 * Beliefs: What the agent knows about the world (map, parcels, agents)
 * Desires: What the agent wants to achieve (pickup parcels, deliver, explore)
 * Intentions: The current plan to achieve desires
 */

import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import { Beliefs } from './beliefs.js';
import { Desires } from './desires.js';
import { heuristic, setBeliefs } from './pathfinding.js';
import { solveOnline, buildProblem, dumpProblem } from './pddl_planner.js';
import { readFile } from 'fs/promises';

// Configuration from environment variables
const TOKEN = process.env.TOKEN;
const HOST = process.env.HOST;
const HEARTBEAT_DELAY_MS = 500; // How often to check if we need to plan again
const DEBUG = false; // Set to true for detailed logging

// Initialize BDI components
const myBeliefs = new Beliefs();
setBeliefs(myBeliefs);
const myDesires = new Desires(myBeliefs);
let myIntentions;

// State flags to prevent concurrent execution
let isExecuting = false; // True when executing an action
let isCoreLoopRunning = false; // True when the main planning loop is running
let lastSensingTime = Date.now(); // Last time we received sensory data

// Connect to the game server
const socket = DjsConnect(HOST, TOKEN);
if (!socket) {
    console.error('[PDDL] Failed to connect to game server');
    process.exit(1);
}

/**
 * Start the heartbeat timer
 * This triggers the core loop periodically if no sensing data is received
 */
function startHeartbeat() {
    setInterval(() => {
        const now = Date.now();
        // Only trigger if we haven't received sensing data recently
        if (now - lastSensingTime >= HEARTBEAT_DELAY_MS) {
            if (DEBUG) console.log('[PDDL] Heartbeat triggered core_loop');
            void core_loop();
        }
    }, HEARTBEAT_DELAY_MS);
}

startHeartbeat();

// Handle configuration from server
socket.onConfig((config) => {
    if (DEBUG) console.log('[PDDL] Config received', config);
});

// Update agent's own position when server sends 'you' event
socket.on('you', (me) => {
    myBeliefs.updatePlayerPosition(me.x ?? 0, me.y ?? 0);
    if (me.id) {
        myBeliefs.setMyId(me.id);
    }
    if (DEBUG) console.log('[PDDL] You:', myBeliefs.getMyPosition());
});

// Handle map initialization from server
socket.on('map', (height, width, tiles) => {
    myBeliefs.setMapWidth(width + 1);
    myBeliefs.setMapHeight(height + 1);

    // Normalize tile types to strings
    myBeliefs.setTiles(
        tiles.map((t) => ({
            x: t.x,
            y: t.y,
            type: typeof t.type === 'number' ? t.type.toString() : t.type
        }))
    );

    // Identify special tiles on the map
    myBeliefs.defineDeliveryPoint(myBeliefs.getTiles());
    myBeliefs.defineSpawnPoint(myBeliefs.getTiles());

    console.log(`[PDDL] Map received: ${myBeliefs.getTiles().length} tiles`);
});

/**
 * Handle sensing data from server
 * This is the main way we get updates about the game state
 */
socket.onSensing(async (data) => {
    lastSensingTime = Date.now();

    // Parse parcels data - things we can pick up and deliver
    const parcels = (data.parcels ?? []).map((p) => ({
        id: p.id,
        x: p.x ?? 0,
        y: p.y ?? 0,
        carriedBy: p.carriedBy ?? '',
        reward: p.reward ?? 0
    }));

    // Parse agents data - other players in the game
    const agents = (data.agents ?? []).map((a) => ({
        id: a.id,
        x: a.x ?? 0,
        y: a.y ?? 0
    }));

    // Update our knowledge of the world
    myBeliefs.updatePercepts(parcels, agents);

    // Trigger the core loop if it's not already running
    if (!isCoreLoopRunning) {
        isCoreLoopRunning = true;
        try {
            await core_loop();
        } finally {
            isCoreLoopRunning = false;
        }
    }
});

/**
 * Load the PDDL domain file
 * This defines the actions and rules of our planning domain
 */
async function loadDomain() {
    return await readFile(
        new URL('./pddl_domain.pddl', import.meta.url),
        'utf8'
    );
}

/**
 * Main planning and execution loop
 * This is the heart of the BDI agent:
 * 1. If no plan, generate one based on current desires
 * 2. If plan exists, execute actions
 * 3. Reconsider plan if situation changes
 * 4. Handle plan completion or failure
 */
async function core_loop() {
    // If we have no plan, create one
    if (myIntentions.getPlan().length === 0) {
        myDesires.genOption(); // Generate options from desires
        myIntentions.desiresToIntention(); // Convert desires to intentions
        myIntentions.filterAndSortIntention(); // Filter and prioritize intentions
        await myIntentions.setPlan(); // Generate a plan for the best intention
        if (DEBUG)
            console.log('[PDDL] Generated plan:', myIntentions.getPlan());
    } else {
        // Check if current intention is blocked (impossible to achieve)
        const currentIntentionBlocked = myIntentions
            .getCurrentImpossibleIntentions()
            .has(myIntentions.getCurrentObjective());
        if (currentIntentionBlocked) {
            console.log('[PDDL] Current intention blocked, clearing plan');
            myIntentions.clearPlan();
            myIntentions.clearCurrentImpossibleIntentions();
        }
    }

    // Check if we should continue with the current plan
    const shouldContinue =
        myIntentions.getPlan().length > 0 &&
        !myIntentions.succeeded() &&
        !myIntentions.impossible();

    if (shouldContinue) {
        // Execute the next action in the plan
        if (!isExecuting) {
            isExecuting = true;
            try {
                await myIntentions.executeNextAction();
            } finally {
                isExecuting = false;
            }
        }

        // Check if we need to reconsider our plan
        let planInvalidAfterReconsider = 0;
        if (myIntentions.reconsider()) {
            // Situation changed, regenerate options
            myDesires.genOption();
            myIntentions.desiresToIntention();
            myIntentions.filterAndSortIntention();
            planInvalidAfterReconsider = 1;
        }

        // If plan is invalid or we reconsidered, generate a new plan
        if (!myIntentions.isPlanValid() || planInvalidAfterReconsider) {
            if (myIntentions.getFilteredIntentions().length > 0) {
                myIntentions.clearPlan();
                await myIntentions.setPlan();
            }
        }
    } else {
        // Handle plan completion or failure
        if (myIntentions.getPlan().length === 0) {
            if (DEBUG) console.log('[PDDL] Plan is empty');
        } else if (myIntentions.succeeded()) {
            console.log(
                '[PDDL] Current intention succeeded',
                myIntentions.getCurrentObjective()
            );
            myIntentions.clearPlan();
        } else if (myIntentions.impossible()) {
            console.log(
                '[PDDL] Current intention impossible',
                myIntentions.getCurrentObjective()
            );
            myIntentions.clearPlan();
            myIntentions.setCurrentImpossibleIntentions(
                myIntentions.getCurrentObjective()
            );
        }
    }
}

/**
 * PDDLIntentions class
 * Manages the agent's intentions and plans
 * This is the "I" in BDI - what the agent intends to do
 */
class PDDLIntentions {
    #plan = []; // Current plan of actions
    #filteredSortedIntentions = []; // Intentions after filtering and sorting
    #nonFilteredIntentions = []; // All possible intentions before filtering
    #currentObjective = null; // The intention we're currently working on
    #desires; // Reference to the agent's desires
    #beliefs; // Reference to the agent's beliefs
    #currentImpossibleIntentions = new Set(); // Intentions we know are impossible
    #failedActionsQueue = []; // Track failed actions to detect blocks

    constructor(desires, beliefs) {
        this.#desires = desires;
        this.#beliefs = beliefs;
    }

    /**
     * Mark an intention as impossible to achieve
     */
    setCurrentImpossibleIntentions(impossibleIntention) {
        this.#currentImpossibleIntentions.add(impossibleIntention);
    }

    /**
     * Clear the list of impossible intentions
     */
    clearCurrentImpossibleIntentions() {
        this.#currentImpossibleIntentions.clear();
    }

    /**
     * Convert desires to intentions
     * Only keep desires that make sense in the current context:
     * - pickup: Always valid
     * - deliver: Only if carrying a parcel
     * - explore: Only if not carrying a parcel
     */
    desiresToIntention() {
        this.#nonFilteredIntentions = [];
        for (const desire of this.#desires.getDesires()) {
            if (desire.startsWith('pickup_')) {
                this.#nonFilteredIntentions.push(desire);
            } else if (
                desire.startsWith('deliver_') &&
                this.#beliefs.getCarriedParcels().length > 0
            ) {
                this.#nonFilteredIntentions.push(desire);
            } else if (
                desire.startsWith('explore_') &&
                this.#beliefs.getCarriedParcels().length === 0
            ) {
                this.#nonFilteredIntentions.push(desire);
            }
        }
    }

    /**
     * Filter and sort intentions based on current state
     * Priority order:
     * 1. Pickup visible parcels
     * 2. Deliver if carrying parcels (closest first)
     * 3. Explore if no parcels visible (closest first, outside vision range first)
     */
    filterAndSortIntention() {
        this.#filteredSortedIntentions = [];
        if (this.#nonFilteredIntentions.length === 0) {
            return;
        }

        // Filter out intentions we know are impossible
        const possibleIntentions = this.#nonFilteredIntentions.filter(
            (intention) => !this.#currentImpossibleIntentions.has(intention)
        );

        // If all intentions are impossible, reset the impossible list
        if (possibleIntentions.length === 0) {
            this.clearCurrentImpossibleIntentions();
        }

        const pickups = possibleIntentions.filter((d) =>
            d.startsWith('pickup_')
        );
        const delivers = possibleIntentions.filter((d) =>
            d.startsWith('deliver_')
        );
        const explores = possibleIntentions.filter((d) =>
            d.startsWith('explore_')
        );
        const playerPos = this.#beliefs.getMyPosition();

        // Priority 1: Pickup visible parcels
        if (this.#beliefs.getVisibleParcels().length > 0) {
            for (const p of pickups) {
                this.#filteredSortedIntentions.push(p);
            }
        }

        // Priority 2: Deliver if carrying parcels (choose closest delivery point)
        if (
            this.#beliefs.getCarriedParcels().length > 0 &&
            delivers.length > 0
        ) {
            const closestDeliver = this.#findClosestIntention(
                delivers,
                playerPos
            );
            if (closestDeliver) {
                this.#filteredSortedIntentions.push(closestDeliver);
            }
        }

        // Priority 3: Explore if no parcels visible
        if (
            explores.length > 0 &&
            this.#beliefs.getVisibleParcels().length === 0
        ) {
            // Filter to only explorations outside our vision range
            const outsideExplores = explores.filter((e) => {
                const parts = e.split('_');
                const x = parseInt(parts[1]);
                const y = parseInt(parts[2]);
                const dist = heuristic({ x, y }, playerPos);
                return dist > this.#beliefs.getVisionRange();
            });

            // Sort by distance to player (closest first)
            const sortedExplores = outsideExplores.sort((a, b) => {
                const aParts = a.split('_');
                const bParts = b.split('_');
                const aDist = heuristic(
                    { x: parseInt(aParts[1]), y: parseInt(aParts[2]) },
                    playerPos
                );
                const bDist = heuristic(
                    { x: parseInt(bParts[1]), y: parseInt(bParts[2]) },
                    playerPos
                );
                return aDist - bDist;
            });

            this.#filteredSortedIntentions.push(...sortedExplores);
        }
    }

    /**
     * Find the closest intention to the player's position
     */
    #findClosestIntention(intentions, playerPosition) {
        if (intentions.length === 0) return null;
        let closest = intentions[0];
        let minDist = this.#getIntentionDistance(intentions[0], playerPosition);
        for (const intention of intentions) {
            const dist = this.#getIntentionDistance(intention, playerPosition);
            if (dist < minDist) {
                minDist = dist;
                closest = intention;
            }
        }
        return closest;
    }

    /**
     * Get the distance from an intention location to the player
     */
    #getIntentionDistance(intention, playerPosition) {
        const parts = intention.split('_');
        if (parts.length < 3) return Infinity;
        const x = parseInt(parts[1]);
        const y = parseInt(parts[2]);
        return heuristic({ x, y }, playerPosition);
    }

    /**
     * Generate a plan for the current objective using PDDL planning
     */
    async setPlan() {
        // If no filtered intentions, use all non-filtered ones
        if (this.#filteredSortedIntentions.length === 0) {
            if (this.#nonFilteredIntentions.length > 0) {
                this.#filteredSortedIntentions = [
                    ...this.#nonFilteredIntentions
                ];
            }
        }

        const objective = this.#filteredSortedIntentions[0];
        if (!objective) {
            this.clearPlan();
            return;
        }

        this.#currentObjective = objective;
        this.#plan = await this.#generatePlanFromObjective(objective);
        if (!Array.isArray(this.#plan)) {
            this.#plan = [];
        }

        if (this.#plan.length > 0) {
            console.log('[PDDL] Plan received:', this.#plan);
        }

        // If no plan found, mark objective as impossible
        if (this.#plan.length === 0) {
            this.setCurrentImpossibleIntentions(objective);
        }
    }

    /**
     * Generate a PDDL plan for a specific objective
     * Creates a PDDL problem based on current state and uses the planner
     */
    async #generatePlanFromObjective(objective) {
        const domain = await loadDomain();
        const { x, y } = this.#parseObjectiveLocation(objective);
        const objectiveType = objective.split('_')[0];
        const agent = {
            id: this.#beliefs.getMyId() ?? 'agent1',
            x: this.#beliefs.getMyPosition().x,
            y: this.#beliefs.getMyPosition().y
        };

        // Prepare parcel information for the problem
        const visibleParcels = this.#beliefs.getVisibleParcels().map((p) => ({
            id: p.id,
            x: p.x,
            y: p.y,
            carried: false
        }));

        const carriedParcels = this.#beliefs.getCarriedParcels().map((p) => ({
            id: p.id,
            carried: true
        }));

        // Define the objective specification
        const objectiveSpec = {
            type: objectiveType,
            goalTile: { x, y },
            parcelId:
                objectiveType === 'pickup'
                    ? this.#parcelIdAtPosition(x, y)
                    : undefined,
            carriedParcelIds: carriedParcels.map((p) => p.id)
        };

        // Get blocked tiles (walls, obstacles, etc.)
        const blockedTiles = [...this.#beliefs.blockedTiles].map((entry) => {
            const [x, y] = entry.split('_').map(Number);
            return { x, y };
        });

        // Also block tiles occupied by other agents
        const visibleAgentBlockedTiles = this.#beliefs
            .getVisibleAgents()
            .filter((a) => a.id !== this.#beliefs.getMyId())
            .map((agentInfo) => ({ x: agentInfo.x, y: agentInfo.y }));

        // Build the state for planning
        const state = {
            tiles: this.#beliefs.getTiles(),
            agent,
            parcels: [...visibleParcels, ...carriedParcels],
            objective: objectiveSpec,
            blockedTiles: [...blockedTiles, ...visibleAgentBlockedTiles]
        };

        try {
            const problem = buildProblem(state);
            if (DEBUG) {
                await dumpProblem(domain, problem, 'debug_pddl');
            }
            const plan = await solveOnline(domain, problem);
            return plan;
        } catch (error) {
            console.error(
                '[PDDL] Planner error for objective',
                objective,
                error
            );
            return [];
        }
    }

    /**
     * Find the parcel ID at a specific position
     */
    #parcelIdAtPosition(x, y) {
        const parcel = this.#beliefs
            .getVisibleParcels()
            .find((p) => p.x === x && p.y === y);
        return parcel ? parcel.id : undefined;
    }

    /**
     * Parse the location from an objective string (e.g., "pickup_5_3" -> {x: 5, y: 3})
     */
    #parseObjectiveLocation(objective) {
        const parts = objective.split('_');
        return { x: parseInt(parts[1]), y: parseInt(parts[2]) };
    }

    /**
     * Execute the next action in the plan
     * Handles move, pickup, and deliver actions
     */
    async executeNextAction() {
        const action = this.getPlan()[0];
        if (!action) return;

        // Handle move actions
        if (action.startsWith('move-')) {
            const direction = action.slice('move-'.length);
            const moved = await socket.emitMove(direction);
            if (moved) {
                // Move succeeded, remove from plan
                this.#plan.shift();
            } else {
                // Move failed
                console.log('[PDDL] Move failed:', direction);

                // Check if this action failed multiple times
                if (this.recordFailedAction(action)) {
                    // Calculate which tile is blocked
                    const pos = this.#beliefs.getMyPosition();
                    let blockedX = pos.x;
                    let blockedY = pos.y;
                    switch (direction) {
                        case 'up':
                            blockedY += 1;
                            break;
                        case 'down':
                            blockedY -= 1;
                            break;
                        case 'right':
                            blockedX += 1;
                            break;
                        case 'left':
                            blockedX -= 1;
                            break;
                    }
                    // Remember this tile is blocked
                    this.#beliefs.addBlockedTile(blockedX, blockedY);
                    this.setCurrentImpossibleIntentions(this.#currentObjective);
                }
                this.clearPlan();
            }
            return;
        }

        // Handle pickup action
        if (action === 'pickup') {
            const picked = await socket.emitPickup();
            if (picked && picked.length > 0) {
                this.#plan.shift();
            } else {
                console.log('[PDDL] Pickup failed');
                this.clearPlan();
            }
            return;
        }

        // Handle deliver action
        if (action === 'deliver') {
            const delivered = await socket.emitPutdown();
            if (delivered && delivered.length > 0) {
                this.#plan.shift();
            } else {
                console.log('[PDDL] Deliver failed');
                this.clearPlan();
            }
            return;
        }

        // Unknown action
        console.log('[PDDL] Unknown action', action);
        this.clearPlan();
    }

    /**
     * Track failed actions
     * Returns true if the same action failed twice in a row
     */
    recordFailedAction(action) {
        this.#failedActionsQueue.push(action);
        if (this.#failedActionsQueue.length >= 2) {
            const lastTwo = this.#failedActionsQueue.slice(-2);
            if (lastTwo.every((a) => a === action)) {
                this.#failedActionsQueue = [];
                return true;
            }
        }
        return false;
    }

    /**
     * Check if the current plan is still valid
     * For pickup: Is the parcel still there?
     * For deliver: Are we still carrying parcels?
     * For explore: Is the target tile still unexplored?
     */
    isPlanValid() {
        if (!this.#currentObjective) return false;
        if (this.#currentObjective.startsWith('pickup_')) {
            const { x, y } = this.#parseObjectiveLocation(
                this.#currentObjective
            );
            return this.#beliefs
                .getVisibleParcels()
                .some((p) => p.x === x && p.y === y);
        }
        if (this.#currentObjective.startsWith('deliver_')) {
            return this.#beliefs.getCarriedParcels().length > 0;
        }
        if (this.#currentObjective.startsWith('explore_')) {
            const { x, y } = this.#parseObjectiveLocation(
                this.#currentObjective
            );
            const tile = this.#beliefs
                .getTiles()
                .find((t) => t.x === x && t.y === y);
            return tile?.type !== '0'; // '0' means explored/known
        }
        return false;
    }

    /**
     * Check if we should reconsider our plan
     * This happens when the situation changes in a way that makes our plan obsolete
     */
    reconsider() {
        if (!this.#currentObjective) return true;
        const type = this.#currentObjective.split('_')[0];
        if (type === 'pickup') {
            const { x, y } = this.#parseObjectiveLocation(
                this.#currentObjective
            );
            // Reconsider if the parcel we wanted to pick up is gone
            return !this.#beliefs
                .getVisibleParcels()
                .some((p) => p.x === x && p.y === y);
        }
        if (type === 'deliver') {
            // Reconsider if we no longer have parcels to deliver
            return this.#beliefs.getCarriedParcels().length === 0;
        }
        if (type === 'explore') {
            // Reconsider if we now see parcels (should pickup instead of explore)
            return this.#beliefs.getVisibleParcels().length > 0;
        }
        return false;
    }

    /**
     * Check if the current intention has succeeded
     */
    succeeded() {
        if (!this.#currentObjective) return false;
        const type = this.#currentObjective.split('_')[0];
        const { x, y } = this.#parseObjectiveLocation(this.#currentObjective);
        const pos = this.#beliefs.getMyPosition();

        if (type === 'pickup') {
            // Success: we're carrying a parcel and the target parcel is gone
            return (
                this.#beliefs.getCarriedParcels().length > 0 &&
                !this.#beliefs
                    .getVisibleParcels()
                    .some((p) => p.x === x && p.y === y)
            );
        }
        if (type === 'deliver') {
            // Success: we have no parcels and we're at the delivery location
            return (
                this.#beliefs.getCarriedParcels().length === 0 &&
                pos.x === x &&
                pos.y === y
            );
        }
        if (type === 'explore') {
            // Success: we reached the target location
            return pos.x === x && pos.y === y;
        }
        return false;
    }

    /**
     * Check if the current intention is impossible
     */
    impossible() {
        if (!this.#currentObjective) return false;

        // If we previously marked this as impossible, it still is
        if (this.#currentImpossibleIntentions.has(this.#currentObjective)) {
            return true;
        }

        const type = this.#currentObjective.split('_')[0];
        if (type === 'pickup') {
            const { x, y } = this.#parseObjectiveLocation(
                this.#currentObjective
            );
            // Impossible if the parcel is no longer there
            return !this.#beliefs
                .getVisibleParcels()
                .some((p) => p.x === x && p.y === y);
        }
        if (type === 'deliver') {
            // Impossible if we have no parcels to deliver
            return this.#beliefs.getCarriedParcels().length === 0;
        }
        if (type === 'explore') {
            const { x, y } = this.#parseObjectiveLocation(
                this.#currentObjective
            );
            const tile = this.#beliefs
                .getTiles()
                .find((t) => t.x === x && t.y === y);
            // Impossible if the tile is a wall ('0')
            return tile?.type === '0';
        }
        return false;
    }

    // Getters
    getPlan() {
        return this.#plan;
    }

    getCurrentObjective() {
        return this.#currentObjective ?? 'undefined';
    }

    getFilteredIntentions() {
        return this.#filteredSortedIntentions;
    }

    getCurrentImpossibleIntentions() {
        return this.#currentImpossibleIntentions;
    }

    /**
     * Clear the current plan
     */
    clearPlan() {
        this.#plan = [];
        this.#currentObjective = null;
    }
}

// Initialize and link the intentions
myIntentions = new PDDLIntentions(myDesires, myBeliefs);
myDesires.setLinkedIntentions(myIntentions);

console.log('[PDDL] Agent started');
