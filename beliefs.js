/*******************************************************************************/
// File:          beliefs.js
// Description:   Represents the agent's knowledge and perceptions about the world.
//                Stores and manages:
//                - Player position and state (carried parcels)
//                - Visible parcels and agents
//                - Map information (tiles, delivery points, spawn points)
//                - Probability maps for predicting agent movements
// Include:       
// Notes:         Beliefs are updated through sensing data from the server and serve
//                as the foundation for the BDI model's decision-making process.
// TODO:          
/*******************************************************************************/
export class Beliefs {
    /** @type {{ x: number, y: number }} */
    #myPosition = { x: 0, y: 0 };

    /** @type {Array<{ id: string, reward: number }>} */
    #carriedParcel = [];

    /** @type {Array<{ id: string, x: number, y: number, carriedBy: string, reward: number }>} */
    #visibleParcels = [];

    /** @type {Array<{ id: string, x: number, y: number }>} */
    #visibleAgents = [];

    /** @type {Array<Array<Array<Array<number>>>>} */
    #probabilityMap = [];

    /** @type {Array<{ x: number, y: number, distance: number }>} */
    #deliveryPoint = [];

    /** @type {Array<{ x: number, y: number }>} */
    #spawnPoint = [];

    /** @type {Array<{ x: number, y: number, type: string }>} */
    #tiles = [];

     /** @type {Set<string>} type x_y, Dynamic obstacles to avoid */
    blockedTiles = new Set();

    /** @type {number} */
    #mapWidth = 0;

    /** @type {number} */
    #mapHeight = 0;

    /** @type {number} */
    #visionRange = 0;

    /** @type {string|null} */
    #myId = null;

    /** @type {string|null} */
    #myName = null;

    /** @type {number|null} */
    #myScore = null;

    /** @type {Set<string>} IDs des parcelles connues au sensing précédent */
    #knownParcelIds = new Set();

    /** @type {Set<string>} IDs des agents connus au sensing précédent */
    #knownAgentIds = new Set();

    /** @type {Object[]} Special missions received from the server */
    #specialMissions= [];

    /** @type {Array<{id: string, x: number, y: number, reward: number}>} */
    newParcels = []

    /** @type {Array<string>} */
    goneParcelsIDs = []

    /** @type { Array<{id: string, x: number, y: number}>} */
    newAgents = []

    /** @type {Array<string>} */
    goneAgentsIds = []


    constructor() {
        this.#probabilityMap = Array.from({ length: this.#mapWidth }, () =>
            Array.from({ length: this.#mapHeight }, () =>
                Array.from({ length: 5 }, () =>
                    Array(50).fill(0)
                )
            )
        );
    }

    // ****************************************************************************
    // Getter fonction (qui lis les attributs)
    // ****************************************************************************

    /**
     * Getter for player position.
     * @returns {{ x: number, y: number }}
     */
    getMyPosition() {
        return this.#myPosition;
    }

    /**
     * Getter for carried parcels.
     * @returns {Array<{ id: string, reward: number }>}
     */
    getCarriedParcels() {
        return this.#carriedParcel;
    }

    /**
     * Getter for visible parcels.
     * @returns {Array<{ id: string, x: number, y: number, carriedBy: string, reward: number }>}
     */
    getVisibleParcels() {
        return this.#visibleParcels;
    }

    /**
     * Getter for visible agents.
     * @returns {Array<{ id: string, x: number, y: number }>}
     */
    getVisibleAgents() {
        return this.#visibleAgents;
    }

    /**
     * Getter for probability map.
     * @returns {Array<Array<Array<Array<number>>>>}
     */
    getProbabilityMap() {
        return this.#probabilityMap;
    }

    /**
     * Getter for delivery points.
     * @returns {Array<{ x: number, y: number, distance: number }>}
     */
    getDeliveryPoints() {
        return this.#deliveryPoint;
    }

    /**
     * Getter for spawn points.
     * @returns {Array<{ x: number, y: number }>}
     */
    getSpawnPoints() {
        return this.#spawnPoint;
    }

    /**
     * Getter for tiles.
     * @returns {Array<{ x: number, y: number, type: string }>}
     */
    getTiles() {
        return this.#tiles;
    }

    /**
     * Getter for map width.
     * @returns {number}
     */
    getMapWidth() {
        return this.#mapWidth;
    }

    /**
     * Getter for map height.
     * @returns {number}
     */
    getMapHeight() {
        return this.#mapHeight;
    }

    /**
     * Getter for vision range.
     * @returns {number}
     */
    getVisionRange() {
        return this.#visionRange-1;
    }

    /**
     * Gets the agent's ID.
     * @returns {string|null}
     */
    getMyId() {
        return this.#myId;
    }

    /**
     * Gets the agent's name.
     * @returns {string|null}
     */
    getMyName() {
        return this.#myName;
    }

    /**
     * Gets the agent's score.
     * @returns {number|null}
     */
    getMyScore() {
        return this.#myScore;
    }

    /**
     * Gets the special missions.
     * @returns {Object[]} see format at _parseSpecialMission in tools_LLM.js
     */
    getSpecialMissions() {
        return this.#specialMissions;
    }

    // ****************************************************************************
    // Setter fonction (qui modifie les attributs)
    // ****************************************************************************

    /**
     * Updates the player's position.
     * @param {number} x
     * @param {number} y
     */
    updatePlayerPosition(x, y) {
        this.#myPosition = { x, y };
    }

    /**
     * Adds a parcel to the carried set.
     * @param {string} parcelID
     */
    addCarriedParcel(parcelID) {
        this.#carriedParcel.push({ id: parcelID, 
            reward: this.#visibleParcels.find(p => p.id === parcelID)?.reward ?? 0 });
    }

    /** Clear CarreidParcels   */
    clearCarriedParcels() {
        this.#carriedParcel = [];
    }

    /**
     * Updates visible parcels.
     * @param {Array<{ id: string, x: number, y: number, carriedBy: string, reward: number }>} parcels
     */
    setVisibleParcels(parcels) {
        this.#visibleParcels = parcels.filter(p => !p.carriedBy);
    }

    /**
     * Updates visible agents.
     * @param {Array<{ id: string, x: number, y: number }>} agents
     */
    setVisibleAgents(agents) {
        this.#visibleAgents = agents;
    }

    /**
     * Updates percepts and returns the delta (new/removed entities).
     * Implements brf(B, ρ): belief revision from new percept.
     * @param {Array<{id: string, x: number, y: number, carriedBy: string, reward: number}>} parcels
     * @param {Array<{id: string, x: number, y: number}>} agents
     */
    updatePercepts(parcels, agents) {
        // ── Parcels delta ──────────────────────────────────────────
        // actual visible parcels
        const currentParcelIds = new Set(
            parcels.filter(p => !p.carriedBy).map(p => p.id)
        );

        // Parcel that was on the last onSensing not visible
        const newParcels = parcels.filter(
            p => !p.carriedBy && !this.#knownParcelIds.has(p.id)
        );

        // Parcel that disappear from the last onSensing
        const goneParcelIds = [...this.#knownParcelIds].filter(
            id => !currentParcelIds.has(id) 
        );

        // Store actual visible parcel for next time
        this.#knownParcelIds = currentParcelIds;

        // ── Agents delta ───────────────────────────────────────────
        const currentAgentIds = new Set(agents.map(a => a.id));

        const newAgents = agents.filter(
            a => !this.#knownAgentIds.has(a.id)
        );

        const goneAgentIds = [...this.#knownAgentIds].filter(
            id => !currentAgentIds.has(id)
        );

        this.#knownAgentIds = currentAgentIds;

        // ── Update carried parcels, server given
        if (this.#myId) {
            const carriedByMe = parcels.filter(p => p.carriedBy === this.#myId);
            this.#carriedParcel = carriedByMe.map(p => ({ id: p.id, reward: p.reward }));
        }

        // ── Update beliefs ─────────────────────────────────────────
        this.setVisibleParcels(parcels);
        this.setVisibleAgents(agents);

        this.newParcels = newParcels;
        this.newAgents = newAgents;
        this.goneParcelsIDs = goneParcelIds;
        this.goneAgentsIds = goneAgentIds;
    }

    /**
     * Updates probability map based on current beliefs.
     */
    updateProbabilityMap() {
        const MAX_TIME_HORIZON = 5;
        const MAX_AGENTS = 50;

        // Reset map
        for (let x = 0; x < this.#mapWidth; x++) {
            for (let y = 0; y < this.#mapHeight; y++) {
                for (let t = 0; t < MAX_TIME_HORIZON; t++) {
                    for (let a = 0; a < Math.min(this.#visibleAgents.length, MAX_AGENTS); a++) {
                        this.#probabilityMap[x][y][t][a] = 0;
                    }
                }
            }
        }

        // For each agent, predict positions
        this.#visibleAgents.slice(0, MAX_AGENTS).forEach((agent, index) => {
            let currentX = agent.x;
            let currentY = agent.y;
            this.#probabilityMap[Math.floor(currentX)][Math.floor(currentY)][0][index] = 1;

            for (let t = 1; t < MAX_TIME_HORIZON; t++) {
                const directions = [
                    { dx: 0, dy: 1 },
                    { dx: 0, dy: -1 },
                    { dx: 1, dy: 0 },
                    { dx: -1, dy: 0 }
                ];
                directions.forEach(dir => {
                    const nx = Math.floor(currentX) + dir.dx;
                    const ny = Math.floor(currentY) + dir.dy;
                    if (nx >= 0 && nx < this.#mapWidth && ny >= 0 && ny < this.#mapHeight) {
                        this.#probabilityMap[nx][ny][t][index] += 0.25;
                    }
                });
            }
        });
    }

    /**
     * Defines delivery tiles (type = "2") based on map tiles.
     * @param {Array<{x: number, y: number, type: string}>} tiles
     */
    defineDeliveryPoint(tiles) {
        this.#deliveryPoint = tiles
            .filter(t => t.type === "2")
            .map(t => ({
                x: t.x,
                y: t.y,
                distance: Math.abs(this.#myPosition.x - t.x) + Math.abs(this.#myPosition.y - t.y)
            }));
        console.log(`[MAP] Delivery points found: ${this.#deliveryPoint.length}`);
    }

    /**
     * Defines spawn points (type = "1") based on map tiles.
     * @param {Array<{x: number, y: number, type: string}>} tiles
     */
    defineSpawnPoint(tiles) {
        this.#spawnPoint = tiles
            .filter(t => t.type === "1")
            .map(t => ({
                x: t.x,
                y: t.y
            }));
        console.log(`[MAP] Spawn points found: ${this.#spawnPoint.length}`);
    }

    // ****************************************************************************
    // Setter fonction for map properties
    // ****************************************************************************

    /**
     * Sets the map width.
     * @param {number} width
     */
    setMapWidth(width) {
        this.#mapWidth = width;
        this.#reinitializeProbabilityMap();
    }

    /**
     * Sets the map height.
     * @param {number} height
     */
    setMapHeight(height) {
        this.#mapHeight = height;
        this.#reinitializeProbabilityMap();
    }

    /**
     * Sets the tiles.
     * @param {Array<{ x: number, y: number, type: string }>} tiles
     */
    setTiles(tiles) {
        this.#tiles = tiles;
    }

    /**
     * Sets the vision range.
     * @param {number} range
     */
    setVisionRange(range) {
        this.#visionRange = range;
    }

    /**
     * Sets the agent's ID for tracking carried parcels.
     * @param {string} agentId
     */
    setMyId(agentId) {
        this.#myId = agentId;
    }

    /**
     * Sets the agent's name.
     * @param {string} name
     */
    setMyName(name) {
        this.#myName = name;
    }

    /**
     * Sets the agent's score.
     * @param {number} score
     */
    setMyScore(score) {
        this.#myScore = score;
    }

    /** Set new blockedTile to the set blockedTile
     * @param {number} x
     * @param {number} y
     */
    addBlockedTile(x, y)
    {
        const key = `${(x)}_${(y)}`;
        this.blockedTiles.add(key);
    }

    addSpecialMission(specialMission) {
        this.#specialMissions.push(specialMission);
    }

    /**
     * Reinitializes the probability map with current dimensions.
     */
    #reinitializeProbabilityMap() {
        this.#probabilityMap = Array.from({ length: this.#mapWidth }, () =>
            Array.from({ length: this.#mapHeight }, () =>
                Array.from({ length: 5 }, () =>
                    Array(50).fill(0)
                )
            )
        );
    }
}
