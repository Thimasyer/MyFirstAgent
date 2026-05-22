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

        // Separate desires by type
        const pickups = this.#nonFilteredIntentions.filter(d => d.startsWith('pickup_'));
        const delivers = this.#nonFilteredIntentions.filter(d => d.startsWith('deliver_'));
        const explores = this.#nonFilteredIntentions.filter(d => d.startsWith('explore_'));

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

        const objective = this.#filteredIntentions.shift();
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
     * Gets the next action.
     * @returns {string|null}
     */
    getNextAction() {
        return this.#plan.shift() || null;
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
            if (this.#beliefs.getCarriedParcels().size === 0)
            {
                console.log('[RECONSIDER] Nothing to deliver.');
                return true;
            }
            return false; // continuer vers la livraison
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
            // Succès: la parcel est maintenant portée par l'agent
            return this.#beliefs.getCarriedParcels().size > 0
                && !this.#beliefs.getVisibleParcels()
                    .some(p => !p.carriedBy && p.x === x && p.y === y);
        }
        if (type === 'deliver')
        {
            // Succès: l'agent ne porte plus rien
            return this.#beliefs.getCarriedParcels().size === 0;
        }
        if (type === 'explore')
        {
            // Succès: l'agent est sur la tile cible
            return Math.round(pos.x) === x && Math.round(pos.y) === y;
        }

        return false;
    }

    /**
     * Checks if current intention has become impossible.
     * Implements impossible(I, B) from BDI loop v7.
     * @returns {boolean}
     */
    impossible()
    {
        if (!this.#currentObjective) return false;

        const parts = this.#currentObjective.split('_');
        const type  = parts[0];
        const x     = parseInt(parts[1]);
        const y     = parseInt(parts[2]);

        if (type === 'pickup')
        {
            // Impossible: parcel disparue et non portée
            const parcelGone = !this.#beliefs.getVisibleParcels()
                .some(p => !p.carriedBy && p.x === x && p.y === y);
            const notCarried = this.#beliefs.getCarriedParcels().size === 0;
            return parcelGone && notCarried;
        }
        if (type === 'deliver')
        {
            // Impossible: rien à livrer
            return this.#beliefs.getCarriedParcels().size === 0;
        }
        if (type === 'explore')
        {
            // Impossible: tile cible non-walkable
            const tile = this.#beliefs.getTiles()
                .find(t => t.x === x && t.y === y);
            return tile?.type === 0;
        }

        return false;
    }
}
