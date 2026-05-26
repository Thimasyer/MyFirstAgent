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
// TODO: Améliorer la fonction filterIntention pour rammaser des parcels pas loin du chemin
//         -> utiliser les helpers déjà en place, l'idée est d'attribuer un score à chaque intention.

/*******************************************************************************/
export class Intentions {
    /** @type {Array<string>} */
    #plan = [];

    /** @type {Array<string>} */
    #filteredIntentions = [];

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

    /** @type {Array<string>} Queue of 3 element containing failed action */
    #failedActionsQueue = [];

    /** @type {Array<string>} Actions currently blocked */
    #blockedActions = [];

    /** @type {Set<string>} Intentions currently impossible */
    #currentImpossibleIntentions = new Set();

    /** @type {boolean} Flag to prevent normal replanning from overriding smartReplan */
    #smartReplanActive = false;

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
     * @param {String} intentionName - The name of intention
     */
    markSpawnPointsAsVisited(intentionName) {
        this.#visitedSpawnPoints.add(intentionName);
    }

    /**
     * Checks if a spawn point has been visited.
     * @param {string} intentionName - The name of the intention.
     * @returns {boolean} - True if the spawn point has been visited, false otherwise.
     */
    isSpawnPointVisited(intentionName) {
        return this.#visitedSpawnPoints.has(intentionName);
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

            } else if (desire.startsWith('deliver_') && this.#beliefs.getCarriedParcels().size > 0) {
                // deliver only when player carried parcel
                this.#nonFilteredIntentions.push(desire);
                
            } else if (desire.startsWith('explore_') && this.#beliefs.getCarriedParcels().size === 0) {
                this.#nonFilteredIntentions.push(desire);
            }
        }
        // log only if intention changed
        if (JSON.stringify(oldIntentions) !== JSON.stringify(this.#nonFilteredIntentions)) {
            console.log(`[INTENTION] Desire converted in intentions: ${this.#nonFilteredIntentions.join(', ')}`);
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

        const playerPos = this.#beliefs.getPlayerPosition();
        const returnIntention = [];

        // If a parcel is visible 
        if (this.#beliefs.getVisibleParcels().length > 0)
            for (const p of pickups) {
                returnIntention.push(p)
                // Reset the explore logic (when at least 1 parcels are visible)
                this.#visitedSpawnPoints.clear();
            }

        // If carrying parcels, consider deliver
        if (this.#beliefs.getCarriedParcels().size > 0) {
            if (delivers.length > 0) {
                const closestDeliver = this.#findClosestIntention(delivers, playerPos);
                if (closestDeliver) {
                    returnIntention.push(closestDeliver);
                    console.log(`[FILTER] Prioritizing deliver: ${closestDeliver}`);
                }
            }
        }

        // Fallback to exploration if no pickup or deliver is available
        if (returnIntention.length === 0 && explores.length > 0) {
            const closest = this.#findClosestIntention(explores, playerPos);
            if (closest) {
                // If the closest explore is outside of vision range, go there directly
                if (this.#getIntentionDistance(closest, playerPos) >= this.#beliefs.getVisionRange()) {
                    // but keep in mind the already visited spawn points to avoid loops
                    if (!this.isSpawnPointVisited(closest)) {
                        console.log('[FILTER] Closest explore already outside vision range. Adding', closest);
                        returnIntention.push(closest);
                    }
                    
                // if closest explore is in vision range (stil no parcel visible)
                } else {
                    // mark this explore as visited
                    this.markSpawnPointsAsVisited(closest);
                    // Search the closest explore tiles outside vision range
                    const outsideExplores = explores.filter(e => 
                        this.#getIntentionDistance(e, playerPos) > this.#beliefs.getVisionRange()
                        // and filter out already visited spawn points to avoid loops
                        && !this.isSpawnPointVisited(e)
                    );
                    // Search the closest in set of explore outside vision range
                    const closestOutsideVisionRange = this.#findClosestIntention(outsideExplores, playerPos);
                    if (closestOutsideVisionRange) {
                        console.log('[FILTER] Closest explore in range of vision. Add one not visible:', closestOutsideVisionRange);
                        returnIntention.push(closestOutsideVisionRange);
                    }
                    else {
                        console.log('[FILTER] All explore possibility was try')
                    }
                }
            } else {
                console.log('[FILTER] ERROR, closest found')
            }
        }

        this.#filteredIntentions = returnIntention;
        console.log(`[FILTER] Filtered intention: ${this.#filteredIntentions.join(' -> ')}`);
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
     * @param {string} intentions - Objective string (e.g., "pickup_5_3")
     * @param {{x: number, y: number}} playerPosition - Current player position for distance calculation
     * @returns {number} - Distance in steps
     */
    #getIntentionDistance(intentions, playerPosition) {
        const parts = intentions.split('_');
        if (parts.length < 3) return Infinity;

        const x = parseInt(parts[1]);
        const y = parseInt(parts[2]);

        const dist = this.#generatePathTo(playerPosition, {x, y}).length
        return dist;
    }

    /**
     * Sets the plan from the current objective in filteredIntention.
     * Generates path to the objective and appends appropriate action.
     */
    setPlan() {
        if (this.#filteredIntentions.length === 0) {
            console.log('[PLAN] filteredIntention empty, falling back to first intention');
            if (this.#nonFilteredIntentions.length > 0) {
                this.#filteredIntentions = [...this.#nonFilteredIntentions];
            }
        }

        const objective = this.#filteredIntentions[0];
        this.#filteredIntentions.shift();
        if (!objective) {
            console.log('[PLAN] No objectives to plan');
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
        const path = this.#generatePathTo(this.#beliefs.getPlayerPosition(), { x, y });

        // Add action at destination
        if (type === 'pickup') {
            path.push(objective);
        } else if (type === 'deliver') {
            path.push('putdown');
        }
        // No action needed for explore, just reach the location

        this.#plan = path;
        console.log(`[PLAN] New plan set for objective "${objective}": ${path.length} actions; filteredIntention remaining ${this.#filteredIntentions.length}`);
    }

    /**
     * Store the failed action in a queue of 3 element
     * @param {string} action - failed action
     * @return {boolean} True if the 3 element are identical
     */
    recordFailedAction(action) {
        this.#failedActionsQueue.push(action);

        // Si 3 échecs identiques consécutifs
        if (this.#failedActionsQueue.every(a => a === action) && this.#failedActionsQueue.length >= 1) {
            this.#blockedActions.push(this.#failedActionsQueue[0]);
            this.#failedActionsQueue = [];
            return true; // Déclenche replanification
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
            return this.#beliefs.getCarriedParcels().size > 0;
        }
        if (type === 'explore')
        {
            // explore, plan valide si l'agent ne porte aucun parcel
            return this.#beliefs.getCarriedParcels().size === 0; 
        }
        return false;
    }

    /**
     * Revises the plan: clears current plan and generates a new one.
     */
    revisePlan() {
        console.log('[PLAN] Revising plan...');
        this.#plan = [];
        this.#currentObjective = null;
        this.#filteredIntentions = [];
        this.desiresToIntention();
        this.filterIntention();
        console.log(`[PLAN] Revising filtered intention: ${this.#filteredIntentions.join(', ')}`);
        this.setPlan();
    }

    /**
     * Replan when 3 times action failed
     * @param {string} blockedAction - Action to avoid
     * Strategy: find one connexe tiles that is walkable and reachable (action not blocked)
     *           then find a path from this new tile, and set the plan
     */
    smartReplan(blockedAction) {
        
        this.clearPlan();
        // Set flag to prevent normal replanning from overriding this
        this.#smartReplanActive = true;
        // necessary for using it impossible() and reconsider()
        this.#blockedActions.push(blockedAction);
        console.log('[SMART_REPLAN]: BockedAction', this.#blockedActions);

        const possibleStartTiles = []

        const playerPos = this.#beliefs.getPlayerPosition();
        const directions = [
            { dx: 0, dy: -1, action: 'move_down' },
            { dx: 0, dy: 1, action: 'move_up' },
            { dx: -1, dy: 0, action: 'move_left' },
            { dx: 1, dy: 0, action: 'move_right' }
        ];

        // Random choice of next dir
        

        // Find a walkable adjacent tile whose access action is not blocked
        for (let dir of directions) 
        {
            const randomIndex = Math.floor(Math.random() * directions.length);
            const randomDir = directions[randomIndex];
            dir = randomDir;
            const nx = Math.round(playerPos.x) + dir.dx;
            const ny = Math.round(playerPos.y) + dir.dy;

            // Check boundaries of map
            if (nx < 0 || nx >= this.#beliefs.getMapWidth() || 
                ny < 0 || ny >= this.#beliefs.getMapHeight()) {
                continue; // saute une itération de la boucle for
            }

            // Check if walkable
            const tile = this.#beliefs.getTiles().find(t => t.x === nx && t.y === ny);
            if (!tile || tile.type === "0") {
                continue; // saute une itération de la boucle for
            }

            // Check if action to reach it is not blocked
            if (dir.action === blockedAction) {
                continue; // saute une itération de la boucle for
            }

            // Found valid adjacent tile
            console.log(`[SMART_REPLAN] Found alternative path via (${nx},${ny}), dir: ${dir.action}`);
            
            // Build new plan: first action is the direction to the valid tile
            const newPlan = [dir.action];
            
            // If we have a current objective, calculate path from adjacent tile to objective
            console.log('[SMART_REPLAN]: current objectif', this.#currentObjective)
            console.log('[SMART_REPLAN]: Filtered intention', this.#filteredIntentions)
            if (this.#currentObjective) {
                const parts = this.#currentObjective.split('_');
                const type = parts[0];
                const objX = parseInt(parts[1]);
                const objY = parseInt(parts[2]);
                
                // Generate path from adjacent tile (nx, ny) to objective (objX, objY)
                const pathToObjective = this.#generatePathTo({x: nx, y: ny}, {x: objX, y: objY});
                console.log('[SMART_REPLAN]: Generate path:', pathToObjective)
                // Dans smartReplan, après generation du path :
                if (pathToObjective.length === 0) {
                    console.log(`[SMART_REPLAN] No path from (${nx},${ny}) to objective`);
                    continue; // Essayer un autre tile adjacent
                }

                newPlan.push(...pathToObjective);
                
                // Add final action based on intention type
                if (type === 'pickup') {
                    newPlan.push(this.#currentObjective);
                } else if (type === 'deliver') {
                    newPlan.push('putdown');
                }
                // explore has no final action, just reach the location
            }
            
            this.#plan = newPlan;
            console.log(`[SMART_REPLAN] New plan: ${newPlan.join(' -> ')}`);
            return;
        }

        // If no adjacent tile is reachable, mark current intention as impossible
        if (this.#currentObjective) {
            this.#currentImpossibleIntentions.add(this.#currentObjective);
            console.log(`[SMART_REPLAN] All adjacent tiles blocked. Marking intention as impossible: ${this.#currentObjective}`);
        }
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
     * @returns {string|null}
     */
    getCurrentObjective() {
        return this.#currentObjective;
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

    /**
     * Clears the plan.
     */
    clearPlan() {
        this.#plan = [];
        this.#currentObjective = null;
        console.log('[PLAN] Cleared')
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
        if (!this.#currentObjective) return true;

        const parts  = this.#currentObjective.split('_');
        const type   = parts[0];
        const obj_x  = parseInt(parts[1]);
        const obj_y  = parseInt(parts[2]);

        // CASE 1: pickup in progress
        if (type === 'pickup')
        {
            // When parcel disapear: reconsider
            const targetGone = delta.goneParcelIds.some(id =>
            {
                const p = this.#beliefs.getVisibleParcels()
                    .find(p => p.id === id);
                return p?.x === obj_x && p?.y === obj_y;
            })
            // Or simplier 
            || !this.#beliefs.getVisibleParcels()
                .some(p => !p.carriedBy && p.x === obj_x && p.y === obj_y);

            if (targetGone)
            {
                console.log('[RECONSIDER] Target parcel gone.');
                return true;
            }

            // When parcel is NEAREST
            const currentDist = this.#getIntentionDistance(
                this.#currentObjective,
                this.#beliefs.getPlayerPosition()
            );
            const betterParcel = delta.newParcels.some(p =>
            {
                const d = Math.abs(this.#beliefs.getPlayerPosition().x - p.x)
                        + Math.abs(this.#beliefs.getPlayerPosition().y - p.y);
                return d < currentDist * 1;
            });
            if (betterParcel)
            {
                console.log('[RECONSIDER] New closer parcel appeared.');
                return true;
            }

            return false;
        }

        // CASE 2: deliver en cours
        if (type === 'deliver') 
        {
            if (this.#beliefs.getCarriedParcels().size === 0) {
                console.log('[RECONSIDER] Nothing to deliver.');
                return true;
            }
            // Reconsider if a parcel pop-up
            const playerPos = this.#beliefs.getPlayerPosition();
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
        const pos   = this.#beliefs.getPlayerPosition();

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
            const pos = this.#beliefs.getPlayerPosition();
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
