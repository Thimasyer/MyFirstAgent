/*******************************************************************************/
// File:          intentions.js
// Description:   Represents the agent's committed plans to achieve its desires.
//                Implements the BDI model's intention component with:
//                - Plan generation from desires
//                - Plan filtering and prioritization
//                - Plan validation and reconsideration
//                - Execution of actions (move, pickup, putdown)
// Include:       desires.js, beliefs.js
// Notes:         Intentions bridge the gap between desires (what the agent wants)
//                and actions (what the agent actually does).
// TODO:      


import { 
    myBeliefs, 
    socket,
    DEBUG,
    TIME_COST_PER_TILE, 
    myIntentions
} from './agent_bdi.js';

/*******************************************************************************/
export class Intentions {
    /** @type {Array<string>} */
    #plan = [];

    /** @type {Array<string>} */
    #filteredIntentions = [];

    // /** @type {Array<{intention: string, score: number}>} */
    // #scoredIntentions = []

    /** @type {Array<string>} */
    #nonFilteredIntentions = [];

    /** @type {string|null} */
    #currentObjective = null;

    /** @type {import('./desires.js').Desires} */
    #desires;

    /** @type {import('./beliefs.js').Beliefs} */
    #beliefs;

    /** @type {Function} */
    #generatePathTo;

    /** @type {Set<string>} */
    #visitedSpawnPoints = new Set();

    /** @type {Set<string>} Intentions currently impossible */
    #currentImpossibleIntentions = new Set();
    
    /** @type {Array<string>} */
    #failedActionsQueue = [];

    /** @type {boolean} */
    #smartReplanActive = false

    /**
     * @param {import('./desires.js').Desires} desires - Reference to desires
     * @param {import('./beliefs.js').Beliefs} beliefs - Reference to beliefs
     * @param {Function} generatePathTo - Function to generate paths
     */
    constructor(desires, beliefs, generatePathTo) {
        this.#desires = desires;
        this.#beliefs = beliefs;
        this.#generatePathTo = generatePathTo;
    }

    /**  @param {string} impossibleIntentions - The list of impossible intentions. */
    setCurrentImpossibleIntentions(impossibleIntentions) {
        this.#currentImpossibleIntentions.add(impossibleIntentions);
    }

    /** Clear the list of impossible intentions. */
    clearCurrentImpossibleIntentions() {
        this.#currentImpossibleIntentions.clear();
    }
    /**
     * Checks if smartReplan is currently active
     * @returns {boolean}
     */
    isSmartReplanActive() {
        return this.#smartReplanActive;
    }

    /**
     * Resets the smartReplan flag (call after plan is consumed)
     */
    resetSmartReplanFlag() {
        this.#smartReplanActive = false;
    }

    /**
     * Marks a spawn point as visited.
     * @param {Array<String>} intentionName - The name of intention
     */
    markSpawnPointsAsVisited(intentionName) {
        intentionName.forEach(e => {
            this.#visitedSpawnPoints.add(e);
        });
        
    }

    /**
     * Checks if a spawn point has been visited.
     * @param {string} intentionName - The name of the intention.
     * @returns {boolean} - True if the spawn point has been visited, false otherwise.
     */
    isSpawnPointVisited(intentionName) {
        return this.#visitedSpawnPoints.has(intentionName);
    }

    /** Getter function for visitedSpawnPoint */
    getSpawnPointVisited() {
        return this.#visitedSpawnPoints;
    }


    /**
     * Converts desires to intentions by filtering feasible ones.
     * Only desires that are currently achievable are added to intention.
     */
    desiresToIntention() {
        this.#nonFilteredIntentions = [];
        // save oldIntentions to log only on change
        const oldIntentions = [...this.#nonFilteredIntentions];

        for (const desire of this.#desires.getDesires()) {
            // Assume that pickup always achievable
            if (desire.startsWith('pickup_')) {
                this.#nonFilteredIntentions.push(desire);

            } else if (desire.startsWith('deliver_') && this.#beliefs.getCarriedParcels().length > 0) {
                // deliver only when player carried parcel
                this.#nonFilteredIntentions.push(desire);
                
            } else if (desire.startsWith('explore_') && this.#beliefs.getCarriedParcels().length === 0) {
                this.#nonFilteredIntentions.push(desire);
            }
        }
        // log only if intention changed
        if (JSON.stringify(oldIntentions) !== JSON.stringify(this.#nonFilteredIntentions)) {
            if (DEBUG) console.log(`[INTENTION] Desire converted in intentions: ${this.#nonFilteredIntentions.join(', ')}`);
        }  
    }

    /**
     * Filters intentions to create an sequence of objectives.
     * Strategy: Prioritize the closest intention
     * If not carrying any parcels, only pickup objectives are considered.
     * Exploration is used as fallback when no pickup or deliver is available.
     */
    filterIntention() {
        this.#filteredIntentions = [];

        if (this.#nonFilteredIntentions.length === 0) {
            console.log('[FILTER] No intentions to filter');
            return;
        }

        // Exclude impossible intentions
        const possibleIntentions = this.#nonFilteredIntentions.filter(
            intention => !this.#currentImpossibleIntentions.has(intention)
        );

        // Separate desires by type
        const pickups = possibleIntentions.filter(d => d.startsWith('pickup_'));
        const delivers = possibleIntentions.filter(d => d.startsWith('deliver_'));
        const explores = possibleIntentions.filter(d => d.startsWith('explore_'));

        const playerPos = this.#beliefs.getMyPosition();
        const returnIntention = [];

        // CASE 1: If a parcel is visible
        if (this.#beliefs.getVisibleParcels().length > 0)
            for (const p of pickups) {
                returnIntention.push(p)
                // Reset the explore logic (when at least 1 parcels are visible)
                this.#visitedSpawnPoints.clear();
            }

        // CASE 2: If carrying parcels, consider deliver
        if (this.#beliefs.getCarriedParcels().length > 0) {
            if (delivers.length > 0) {
                const closestDeliver = this.#findClosestIntention(delivers, playerPos);
                if (closestDeliver) {
                    returnIntention.push(closestDeliver);
                   // console.log(`[FILTER] Prioritizing deliver: ${closestDeliver}`);
                }
            }
        }

        // CASE 3: Fallback to exploration if no pickup or deliver is available
        if (returnIntention.length === 0 && explores.length > 0) {
            const closest = this.#findClosestIntention(explores, playerPos);
            if (closest) {
                // If the closest explore outside of vision range is not already visited, go there directly
                if ((this.#getIntentionDistance(closest, playerPos) >= this.#beliefs.getVisionRange()) 
                        && !this.isSpawnPointVisited(closest)) {
                    // but keep in mind the already visited spawn points to avoid loops
                    if (!this.isSpawnPointVisited(closest)) {
                       // console.log('[FILTER] Closest explore already outside vision range. Adding', closest);
                        returnIntention.push(closest);
                    }
                    
                // if closest explore is in vision range (stil no parcel visible)
                } else {
                    // mark visible explores as visited
                   const visibleSpawnPoints = explores.filter(e => 
                        this.#getIntentionDistance(e, playerPos) < this.#beliefs.getVisionRange()
                   )
                    this.markSpawnPointsAsVisited(visibleSpawnPoints);
                    // Search the closest explore tiles outside vision range
                    const outsideExplores = explores.filter(e => 
                        this.#getIntentionDistance(e, playerPos) > this.#beliefs.getVisionRange()
                        // and filter out already visited spawn points to avoid loops
                        && !this.isSpawnPointVisited(e)
                    );
                    //console.log('[FILTER] visitedSpanwPoints:', this.getVisitedSpawnPoints());
                    // Search the closest in set of explore outside vision range
                    const closestOutsideVisionRange = this.#findClosestIntention(outsideExplores, playerPos);
                    if (closestOutsideVisionRange) {
                        //console.log('[FILTER] Closest explore in range of vision. Add one not visible:', closestOutsideVisionRange);
                        returnIntention.push(closestOutsideVisionRange);
                    }
                    else {
                        console.log('[FILTER] All explore possibility was try')
                        myBeliefs.blockedTiles.clear();
                        myIntentions.clearCurrentImpossibleIntentions();
                        myIntentions.clearFailedActionsQueue();
                    }
                }
            } else {
                console.log('[FILTER] ERROR, closest not found')
            }
        }

        this.#filteredIntentions = returnIntention;
        if (DEBUG) console.log(`[FILTER] Filtered intention: ${this.#filteredIntentions.join(' -> ')}`);
    }

    /**
     * Finds the closest objective among a list of objectives.
     * Extracts coordinates from objective string (e.g., "pickup_5_3" -> x=5, y=3)
     * @param {Array<string>} intentions - List of objectives
     * @param {{x: number, y: number}} playerPosition - Current player position for distance calculation
     * @returns {string|null} - Closest objective or null
     */
    #findClosestIntention(intentions, playerPosition) {
        if (intentions.length === 0) return null;

        let closest = intentions[0];
        let minDist = this.#getIntentionDistance(intentions[0], playerPosition);

        for (const i of intentions) {
            const dist = this.#getIntentionDistance(i, playerPosition);
            if (dist < minDist && dist > 0) {
                minDist = dist;
                closest = i;
            }
        }
        return closest;
    }

    /**
     * Sort the filtered intention, by giving a score.
     * Score is the distance to achieve intention. Then sort from lowest score to biggest. 
     * @param {Array<string>} filteredIntentions 
     */
    #sortIntentions(filteredIntentions) {

    }

    /**
     * Groups objectives by proximity to minimize total distance.
     * @param {Array<string>} intentions - List of objectives
     * @param {{x: number, y: number}} playerPosition - Current player position for distance calculation
     * @returns {Array<string>} - Sorted objectives by proximity
     */
    groupNearbyIntention(intentions, playerPosition) {
        const sorted = [...intentions].sort((a, b) => {
            const distA = this.#getIntentionDistance(a, playerPosition);
            const distB = this.#getIntentionDistance(b, playerPosition);
            return distA - distB;
        });
        return sorted;
    }

    /**
     * Calculates reel distance to an objective, base on generatePathTo (algo A*)
     * @param {string} intentions - Intention string (e.g., "pickup_5_3")
     * @param {{x: number, y: number}} playerPosition - Current player position for distance calculation
     * @returns {number} - Distance in steps
     */
    #getIntentionDistance(intentions, playerPosition) {
        const parts = intentions.split('_');
        if (parts.length < 3) return Infinity;

        const x = parseInt(parts[1]);
        const y = parseInt(parts[2]);

        if (playerPosition.x != x && playerPosition.y != y)
        {
            const dist = this.#generatePathTo(playerPosition, {x, y}).length
            return dist;
        } // ERrror
        else 
        {
            return -0.1;
        }
    }

    /**
     * Sets the plan from the current objective in filteredIntention.
     * Generates path to the objective and appends appropriate action.
    **/
    setPlan() {

        if (this.#filteredIntentions.length === 0) {
            //console.log('[PLAN] filteredIntention empty, falling back to first intention');
            if (this.#nonFilteredIntentions.length > 0) {
                this.#filteredIntentions = [...this.#nonFilteredIntentions];
            }
        }

        const objective = this.#filteredIntentions[0];

        // When there is no intention, clear the plan
        if (!objective) {
            //console.log('[PLAN] No objectives to plan');
            this.#plan = [];
            this.#currentObjective = null;
            return;
        }

        this.#currentObjective = objective;

        // Parse objective
        const parts = objective.split('_');
        const type = parts[0];
        const x = parseInt(parts[1]);
        const y = parseInt(parts[2]);

        // Generate path to objective location
        const path = this.#generatePathTo(this.#beliefs.getMyPosition(), 
            { x, y });

        // Add action at destination
        if (type === 'pickup') {
            path.push('pickup');
        } else if (type === 'deliver') {
            path.push('putdown');
        }
        // No action needed for explore, just reach the location
        this.#plan = path;
    }
    
    /**
     * Executes the next action in the intentions plan.
     * Handles movement, pickup, and putdown actions.
     * Clears plan on failure to trigger re-planning.
     */
    async executeNextAction()
    {
        if (this.getFilteredIntentions().length) {
            if (DEBUG) console.log('[EXECUTENEXTECTION]: Filtered intention', this.getFilteredIntentions()) }
        const action = this.getPlan()[0];
        if (!action) return;

        // ── MOVE ──────────────────────────────────────────────────
        if (action.startsWith('move_'))
        {
            const direction = action.split('_')[1];

            if (!['up','down','left','right'].includes(direction))
            {
                console.log(`[ACTION] Invalid direction: ${direction}`);
                this.clearPlan();
                return;
            }

            
            const moved = await socket.emitMove(direction);

            if (moved)
            {
                // When the last action of plan is executed shift intention
                if (this.getPlan().length === 1) {
                    this.shiftIntention();
                    myBeliefs.blockedTiles.clear();
                    if (DEBUG) console.log('[EXECUTENEXTACTION] blockedTiles cleared')
                }
                if (DEBUG) console.log(`[ACTION] Moved ${direction}.`);
                this.getNextAction(); // shift only on success
                
            }
            else
            {
                if (DEBUG) console.log(`[ACTION] Move ${direction} failed, will retry.`);
                
                // after 3 failed action, replan  with blocked tiles
                if(this.recordFailedAction(action))
                {
                    if (DEBUG) console.log('[FAILED ACTION] 3 action recorded')
                    // get the blocked tiles
                    let x = myBeliefs.getMyPosition().x;
                    let y = myBeliefs.getMyPosition().y;

                    switch (action)
                    {
                        case 'move_up':    y += 1; break;
                        case 'move_down':  y -= 1; break;
                        case 'move_right': x += 1; break;
                        case 'move_left':  x -= 1; break;
                    }

                   if (DEBUG) console.log('[PLAYER POS] ', myBeliefs.getMyPosition());
                    myBeliefs.addBlockedTile(x, y);
                    if (DEBUG) console.log('[ACTION FAILED]: blockedTiles', myBeliefs.blockedTiles);
                    this.setPlan();
                }
            
            }
        }

        // ── PICKUP ────────────────────────────────────────────────
        else if (action === 'pickup')
        {
            const picked = await socket.emitPickup();

            if (picked && picked.length > 0)
            {
                for (const p of picked)
                {
                    myBeliefs.addCarriedParcel(p.id);
                    if (DEBUG) console.log(`[ACTION] Picked up parcel ${p.id}.`);
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
                myBeliefs.clearCarriedParcels();
                for (const p of putDown)
                {
                    if (DEBUG) console.log(`[ACTION] Put down parcel ${p.id}.`);
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
        if (DEBUG) console.log('[ACTION] living executeNexAction');
    }

    /**
     * Store the failed action in a queue of 3 element
     * @param {string} action - failed action
     * @return {boolean} True if the 3 element are identical
     */
    recordFailedAction(action) {
        this.#failedActionsQueue.push(action);
        console.log('[FAILED ACTION] Recorded: ', this.#failedActionsQueue);
        // Si 3 échecs identiques consécutifs, retourne vrai puis clear l'array
        if (this.#failedActionsQueue.length >= 2) {
            const lastThree = this.#failedActionsQueue.slice(-2);
            if (lastThree.every(a => a === action)) {
                this.#failedActionsQueue = []; // Clear l'array
                return true; // Déclenche replanification
            }
        }

        return false;
    }

    /**
     * Checks if current plan is still valid.
     * Returns false if the target location is now unreachable or objective is no longer valid.
     * @returns {boolean}
     */
    isPlanValid() {
        if (!this.#currentObjective) return false;

        // Plan vide temporairement: on garde l'objectif,
        // reconsider() décidera si on doit changer
        // (ne pas confondre plan vide et objectif invalide)

        const parts = this.#currentObjective.split('_');
        const type  = parts[0];
        const x     = parseInt(parts[1]);
        const y     = parseInt(parts[2]);

        if (type === 'pickup')
        {
            return this.#beliefs.getVisibleParcels()
                .some(p => !p.carriedBy && p.x === x && p.y === y);
        }
        if (type === 'deliver')
        {
            return this.#beliefs.getCarriedParcels().length > 0;
        }
        if (type === 'explore')
        {
            // explore, plan valide si l'agent ne porte aucun parcel
            return this.#beliefs.getCarriedParcels().length === 0; 
        }
        return false;
    }

    /**
     * Gets the next action.
     * @returns {string|null}
     */
    getNextAction() {
        const action = this.#plan.shift() || null;
        // Reset smartReplan flag once we start consuming the plan
        if (this.#smartReplanActive && this.#plan.length === 0) {
            this.resetSmartReplanFlag();
        }
        return action;
    }

    /**
     * Gets the current plan.
     * @returns {Array<string>}
     */
    getPlan() {
        return this.#plan;
    }

    /**
     * Gets the current objective.
     * @returns {string}
     */
    getCurrentObjective() {
        return this.#currentObjective;
    }

    /**
     * Calculates the score of a given intention based on its type, distance, and associated rewards.
     * The score estimates the net reward after accounting for time and distance costs.
     *
     * @param {string} intention - The intention to score (e.g., 'pickup_5_3', 'deliver_2_4', 'explore').
     * @returns {number|null} The estimated score, or null if the intention is invalid.
     */
    getScoreOfIntention(intention) {
        if (!intention) return null;

        const parts = intention.split('_');
        const type = parts[0];
        const obj_x = parseInt(parts[1]);
        const obj_y = parseInt(parts[2]);

        // CASE 1: Explore
        if (type === 'explore') {
            return 0; // No direct reward for exploration
        }

        // CASE 2: Pickup - calcule the possible reward of picking up and deliver only this parcel
        else if (type === 'pickup') {
            // Distance to reach the parcel (estimated by plan length)
            const dist_obj = this.#getIntentionDistance(intention, this.#beliefs.getMyPosition());
            // Find the closest deliver intention after pickup
            const next_deliver = this.#findClosestIntention(
                Array.from(this.#desires.getDesires()).filter(d => d.startsWith('deliver_')),
                { x: obj_x, y: obj_y }
            );

            if (!next_deliver) {
                console.log('[SCORE] No deliver found for pickup intention:', intention);
                return 0;
            }
            else {
                if (DEBUG) console.log('[SCORE]: next_deliver:', next_deliver, '|obj_x_y:', { x: obj_x, y: obj_y });
            }

            // Distance from parcel to deliver location
            const dist_deliver = this.#getIntentionDistance(next_deliver, { x: obj_x, y: obj_y });
            
            // Reward of the target parcel
            const parcelReward = this.#beliefs.getVisibleParcels() 
                .find(p => p.x === obj_x && p.y === obj_y)?.reward ?? 0;

            // Net reward: parcel reward minus time cost (0.3 points per tile)
            const possibleReward = parcelReward - (dist_deliver + dist_obj) * TIME_COST_PER_TILE;
            if (DEBUG) console.log(`[SCORE] Intention: ${intention} dist_obj: ${dist_obj}, 
                    dist_deliver: ${dist_deliver}, parcelReward: ${parcelReward}, possibleReward: ${possibleReward} `);
            return possibleReward;
        }

        // CASE 3: Deliver
        else if (type === 'deliver') {
            // Distance to reach the delivery location
            const dist_deliver = this.#getIntentionDistance(intention, this.#beliefs.getMyPosition());
            // Sum of rewards for all carried parcels
            const carriedParcels = this.#beliefs.getCarriedParcels();
            let totalReward = 0;
            carriedParcels.forEach(p => {
                totalReward += p.reward;
            });
            if (DEBUG) console.log(`[SCORE] Futur Reward: ${totalReward}`);

            // Net reward: total reward minus time cost (0.3 points per tile)
            return totalReward - dist_deliver * 0.3;
        }

        // --- Invalid intention ---
        else {
            console.log('[SCORE] Invalid intention type:', type);
            return null;
        }
    }

    /**
     * Gets the filtered intentions.
     * @returns {Array<string>}
     */
    getFilteredIntentions() {
        return this.#filteredIntentions;
    }

    /** @returns {Array<string>} */
    getIntentions() {
        return this.#nonFilteredIntentions;
    }

    /** @returns {Set<string>} */ 
    getVisitedSpawnPoints() {
        return this.#visitedSpawnPoints;
    }

    /** @returns {Set<string>} */
    getCurrentImpossibleIntentions() {
        return this.#currentImpossibleIntentions;
    }

    /**
     * Clears the plan.
     */
    clearPlan() {
        this.#plan = [];
        this.#currentObjective = null;
        console.log('[PLAN] Cleared')
    }

    /** clear failedActionsQueue */
    clearFailedActionsQueue() {
        this.#failedActionsQueue=[];
    }

    shiftIntention() {
        this.#filteredIntentions.shift();
    }

    /** 
     * Sets the current intention.
     * @param {string} intention - The intention to set.
     */
    setIntentionInFrontAndPlan(intention) {
        this.#filteredIntentions.unshift(intention);
        this.#currentObjective = intention;
        this.setPlan();
    }

    /**
     * Decides whether the agent should reconsider its current intention.
     * Only reacts to NEW percepts (delta), not known ones.
     * Faithful implementation of reconsider(I, B) from BDI loop v7.
     * @param {{
     *   newParcels: Array<{id: string, x: number, y: number, reward: number}>,
     *   goneParcelIds: Array<string>,
     *   newAgents: Array<{id: string, x: number, y: number}>,
     *   goneAgentIds: Array<string>
     * }} delta - Changes since last sensing
     * @returns {boolean} True if reconsideration is needed
     */
    reconsider(delta = { newParcels: [], goneParcelIds: [], newAgents: [], goneAgentIds: [] }) {
        // No objective: always reconsider
        if (!this.#currentObjective || this.#currentImpossibleIntentions.has(this.#currentObjective)) return true;

        const parts  = this.#currentObjective.split('_');
        const type   = parts[0];
        const obj_x  = parseInt(parts[1]);
        const obj_y  = parseInt(parts[2]);

        // CASE 1: pickup in progress
        if (type === 'pickup')
        {
            // CASE 1.1: parcel disapear because pickup by another agent or reward timeout
            const targetGone = delta.goneParcelIds.some(id =>
            {
                const p = this.#beliefs.getVisibleParcels()
                    .find(p => p.id === id);
                return p?.x === obj_x && p?.y === obj_y;
            })
            // Or simplier 

            if (targetGone)
            {
                console.log('[RECONSIDER] Target parcel gone.');
                return true;
            }

            // When parcel is NEAREST
            const currentDist = this.#getIntentionDistance(
                this.#currentObjective,
                this.#beliefs.getMyPosition()
            );
            const betterParcel = delta.newParcels.some(p =>
            {
                const d = Math.abs(this.#beliefs.getMyPosition().x - p.x)
                        + Math.abs(this.#beliefs.getMyPosition().y - p.y);
                return d < currentDist * 1;
            });
            if (betterParcel)
            {
                console.log('[RECONSIDER] New closer parcel appeared.');
                return true;
            }

            return false;
        }

        // CASE 2: deliver in progress
        if (type === 'deliver') 
        {
            if (this.#beliefs.getCarriedParcels().length === 0) {
                console.log('[RECONSIDER] Nothing to deliver.');
                return true;
            }
            // Reconsider if a parcel pop-up
            const playerPos = this.#beliefs.getMyPosition();
            const closeParcel = delta.newParcels.some(p => {
                const dist = Math.abs(playerPos.x - p.x) + Math.abs(playerPos.y - p.y);
                return dist <= 5; // Seuil de distance (ex: 2 tiles)
            });
            if (closeParcel) {
                console.log('[RECONSIDER] New close parcel appeared during deliver.');
                return true;
            }
            return false;
        }

        // CASE 3: explore en cours
        if (type === 'explore')
        {
            // Reconsidère SEULEMENT si une NOUVELLE parcel apparaît
            // (pas si elle était déjà connue au sensing précédent)
            if (delta.newParcels.length > 0)
            {
                console.log('[RECONSIDER] New parcel appeared during explore.');
                return true;
            }
            return false; // aucun nouveau percept → continuer l'exploration
        }

        return false;
    }

    /**
     * Checks if current intention has been achieved.
     * Implements succeeded(I, B) from BDI loop v7.
     * @returns {boolean}
     */
    succeeded()
    {
        if (!this.#currentObjective) return false;

        const parts = this.#currentObjective.split('_');
        const type  = parts[0];
        const x     = parseInt(parts[1]);
        const y     = parseInt(parts[2]);
        const pos   = this.#beliefs.getMyPosition();

        if (type === 'pickup')
        {
            // Success: parcel is carried by agent
            return this.#beliefs.getCarriedParcels().size > 0
                && !this.#beliefs.getVisibleParcels()
                    .some(p => !p.carriedBy && p.x === x && p.y === y);
        }
        if (type === 'deliver')
        {
            // success: agent is on a delivery parcel AND carry no parcel anymore
            const pos = this.#beliefs.getMyPosition();
            const tile = this.#beliefs.getTiles().find(
                t => t.x === Math.round(pos.x) && t.y === Math.round(pos.y)
            );
            return this.#beliefs.getCarriedParcels().size === 0 && tile?.type === "2";
        }
        if (type === 'explore')
        {
            // Success: agent is on goal
            return Math.round(pos.x) === x && Math.round(pos.y) === y;
        }

        return false;
    }

    /**
     * Checks if current intention
     * Implements impossible(I, B) from BDI loop v7.
     * @returns {boolean}
     */
    impossible()
    {
        if (!this.#currentObjective) return false;

        // Check if intention is marked as impossible
        if (this.#currentImpossibleIntentions.has(this.#currentObjective)) {
            return true;
        }

        const parts = this.#currentObjective.split('_');
        const type  = parts[0];
        const x     = parseInt(parts[1]);
        const y     = parseInt(parts[2]);

        if (type === 'pickup')
        {
            // Impossible: parcel disapear OR carried by another agent
            const parcelGone = !this.#beliefs.getVisibleParcels()
                .some(p => !p.carriedBy && p.x === x && p.y === y);
            const notCarried = this.#beliefs.getCarriedParcels().size === 0;
            return parcelGone && notCarried;

            
        }
        if (type === 'deliver')
        {
            // Impossible: nothing to deliver
            return this.#beliefs.getCarriedParcels().size === 0;
        }
        if (type === 'explore')
        {
            // Impossible: the goal tile is non-walkable
            const tile = this.#beliefs.getTiles()
                .find(t => t.x === x && t.y === y);
            return tile?.type === "0";
        }
        return false;
    }
}
