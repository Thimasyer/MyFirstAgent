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
/*******************************************************************************/
export class Intentions {
    /** @type {Array<string>} */
    #plan = [];

    /** @type {Array<string>} */
    #filteredIntention = [];

    /** @type {Array<string>} */
    #intention = [];

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
     * @param {Set<string>} intentionName - The name of intention
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
        this.#intention = [];

        for (const desire of this.#desires.getDesires()) {
            if (desire.startsWith('pickup_')) {
                this.#intention.push(desire);
            } else if (desire.startsWith('deliver_')) {
                if (this.#beliefs.getCarriedParcels().size > 0) {
                    this.#intention.push(desire);
                }
            } else if (desire.startsWith('explore_')) {
                this.#intention.push(desire);
            }
        }

        console.log(`[INTENTION] Converted to intentions: ${this.#intention.join(', ')}`);
    }

    /**
     * Filters intentions to create an optimal sequence of objectives.
     * Strategy: Prioritize pickup -> deliver cycles based on proximity and reward.
     */
    filterIntention() {
        this.#filteredIntention = [];

        if (this.#intention.length === 0) {
            console.log('[FILTER] No intentions to filter');
            return;
        }

        // Separate desires by type
        const pickups = this.#intention.filter(d => d.startsWith('pickup_'));
        const delivers = this.#intention.filter(d => d.startsWith('deliver_'));
        const explores = this.#intention.filter(d => d.startsWith('explore_'));

        // Build objective sequence based on current state and strategy
        const sequence = [];

        // Strategy: If carrying items, deliver first; otherwise, try to pickup
        if (this.#beliefs.getCarriedParcels().size > 0 && delivers.length > 0) {
            const closest = this.#findClosestObjective(delivers, this.#beliefs.getPlayerPosition());
            if (closest) {
                sequence.push(closest);
                delivers.splice(delivers.indexOf(closest), 1);
            }
        }

        // After delivering (or if not carrying), pickup a single parcel rather than a long chain
        if (pickups.length > 0 && this.#beliefs.getCarriedParcels().size === 0) {
            const closestPickup = this.#findClosestObjective(pickups, this.#beliefs.getPlayerPosition());
            if (closestPickup) {
                sequence.push(closestPickup);
            }
        }

        // If already carrying items, do not plan multiple pickups; deliver first.
        // If no pickup is selected and no delivery is needed, fallback to exploration.
        if (sequence.length === 0 && explores.length > 0) {
            const closest = this.#findClosestObjective(explores, this.#beliefs.getPlayerPosition());
            if (closest) {
                // If the closest explore is outside of vision range, go there directly
                if (this.#getObjectiveDistance(closest, this.#beliefs.getPlayerPosition()) > this.#beliefs.getVisionRange()) {
                    // but keep in mind the already visited spawn points to avoid loops
                    if (!this.isSpawnPointVisited(closest)) {
                        console.log('[FILTER] Adding', closest, 'to checked intentions');
                        sequence.push(closest);
                    }
                // if spawn points in vision range, prioritize them to discover new parcels
                // but keep in mind the already visited spawn points to avoid loops
                } else {
                    // Search the closest explore tiles outside vision range
                    const outsideExplores = explores.filter(e => 
                        this.#getObjectiveDistance(e, this.#beliefs.getPlayerPosition()) > this.#beliefs.getVisionRange()
                        // and filter out already visited spawn points to avoid loops
                        && !this.isSpawnPointVisited(e)
                    );
                    const closestOutside = this.#findClosestObjective(outsideExplores, this.#beliefs.getPlayerPosition());
                    if (closestOutside) {
                        console.log('[FILTER] Adding closest and outsider of vision range explore:', closestOutside);
                        sequence.push(closestOutside);
                    } else {
                        console.log('[FILTER] No explore objectives outside vision range, skipping exploration');
                    }
                }
            }
        }

        this.#filteredIntention = sequence;
        console.log(`[FILTER] Filtered intention sequence: ${this.#filteredIntention.join(' -> ')}`);
    }

    /**
     * Finds the closest objective among a list of objectives.
     * Extracts coordinates from objective string (e.g., "pickup_5_3" -> x=5, y=3)
     * @param {Array<string>} objectives - List of objectives
     * @param {{x: number, y: number}} playerPosition - Current player position for distance calculation
     * @returns {string|null} - Closest objective or null
     */
    #findClosestObjective(objectives, playerPosition) {
        if (objectives.length === 0) return null;

        let closest = objectives[0];
        let minDist = this.#getObjectiveDistance(objectives[0], playerPosition);

        for (const obj of objectives) {
            const dist = this.#getObjectiveDistance(obj, playerPosition);
            if (dist < minDist && dist > 0) {
                minDist = dist;
                closest = obj;
            }
        }
        return closest;
    }

    /**
     * Groups objectives by proximity to minimize total distance.
     * @param {Array<string>} objectives - List of objectives
     * @param {{x: number, y: number}} playerPosition - Current player position for distance calculation
     * @returns {Array<string>} - Sorted objectives by proximity
     */
    groupNearbyObjectives(objectives, playerPosition) {
        const sorted = [...objectives].sort((a, b) => {
            const distA = this.#getObjectiveDistance(a, playerPosition);
            const distB = this.#getObjectiveDistance(b, playerPosition);
            return distA - distB;
        });
        return sorted;
    }

    /**
     * Calculates Manhattan distance to an objective.
     * @param {string} objective - Objective string (e.g., "pickup_5_3")
     * @param {{x: number, y: number}} playerPosition - Current player position for distance calculation
     * @returns {number} - Distance in steps
     */
    #getObjectiveDistance(objective, playerPosition) {
        const parts = objective.split('_');
        if (parts.length < 3) return Infinity;

        const x = parseInt(parts[1]);
        const y = parseInt(parts[2]);

        const dist = Math.abs(playerPosition.x - x) + Math.abs(playerPosition.y - y);
        return dist;
    }

    /**
     * Sets the plan from the current objective in filteredIntention.
     * Generates path to the objective and appends appropriate action.
     */
    setPlan() {
        if (this.#filteredIntention.length === 0) {
            console.log('[PLAN] filteredIntention empty, falling back to first intention');
            if (this.#intention.length > 0) {
                this.#filteredIntention = [...this.#intention];
            }
        }

        const objective = this.#filteredIntention.shift();
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
        console.log(`[PLAN] New plan set for objective "${objective}": ${path.length} actions; filteredIntention remaining ${this.#filteredIntention.length}`);
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
        this.#filteredIntention = [];
        this.desiresToIntention();
        this.filterIntention();
        console.log(`[PLAN] Revising filtered intention: ${this.#filteredIntention.join(', ')}`);
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
        return this.#filteredIntention;
    }

    /** @returns {Array<string>} */
    getIntentions() {
        return this.#intention;
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

        // CASE 1: pickup en cours
        if (type === 'pickup')
        {
            // La parcel cible a disparu → reconsider
            const targetGone = delta.goneParcelIds.some(id =>
            {
                const p = this.#beliefs.getVisibleParcels()
                    .find(p => p.id === id);
                return p?.x === obj_x && p?.y === obj_y;
            })
            // Ou plus simplement: cible plus visible
            || !this.#beliefs.getVisibleParcels()
                .some(p => !p.carriedBy && p.x === obj_x && p.y === obj_y);

            if (targetGone)
            {
                console.log('[RECONSIDER] Target parcel gone.');
                return true;
            }

            // Nouvelle parcel BEAUCOUP plus proche apparue
            const currentDist = this.#getObjectiveDistance(
                this.#currentObjective,
                this.#beliefs.getPlayerPosition()
            );
            const betterNew = delta.newParcels.some(p =>
            {
                const d = Math.abs(this.#beliefs.getPlayerPosition().x - p.x)
                        + Math.abs(this.#beliefs.getPlayerPosition().y - p.y);
                return d < currentDist * 0.5;
            });
            if (betterNew)
            {
                console.log('[RECONSIDER] New closer parcel appeared.');
                return true;
            }

            return false; // parcel connue, plan valide → continuer
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
}
