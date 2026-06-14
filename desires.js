/*******************************************************************************/
// File:          desires.js
// Description:   Represents the agent's goals and motivations.
//                Generates desires based on current beliefs:
//                - pickup_X_Y: Desire to pick up a parcel at (X, Y)
//                - deliver_X_Y: Desire to deliver parcels at a delivery point (X, Y)
//                - explore_X_Y: Desire to explore spawn points (X, Y)
// Include:       beliefs.js
// Notes:         Desires are dynamically generated from the agent's perceptions and
//                serve as input for the intention formation process.
// TODO:          
/*******************************************************************************/
import { DEBUG } from './agent_bdi.js';
import { Beliefs } from './beliefs.js';

export class Desires {
    /** @type {Beliefs} */
    #beliefs;

    /** @type {import('./intentions.js').Intentions|null} */
    #intentions = null;

    /** @type {Set<string>} */
    #setDesires = new Set();

    /**
     * @param {Beliefs} beliefs - Reference to beliefs
     */
    constructor(beliefs) {
        this.#beliefs = beliefs;
    }

    /**
     * Sets the reference to Intentions for dynamic updates.
     * @param {import('./intentions.js').Intentions} intentions
     */
    setLinkedIntentions(intentions) {
        this.#intentions = intentions;
    }

    /**
     * Generates desires based on current beliefs.
     */
    genOption() {
        if (DEBUG) console.log('  --> [DESIRES] Generation of desires...');
        this.#setDesires.clear();

        // Add pickup desires for visible parcels
        for (const parcel of this.#beliefs.getVisibleParcels()) {
            this.#setDesires.add(`pickup_${parcel.x}_${parcel.y}`);
        }

        // Add explore desires for spawn points
        for (const spawn of this.#beliefs.getSpawnPoints()) {
            this.#setDesires.add(`explore_${spawn.x}_${spawn.y}`);
        }

        // Add deliver desires for delivery points
        for (const delivery of this.#beliefs.getDeliveryPoints()) {
            this.#setDesires.add(`deliver_${delivery.x}_${delivery.y}`);
        }
    }

    /**
     * Gets the desires set.
     * @returns {Set<string>} Set of desires.
     */
    getDesires() {
        return this.#setDesires;
    }
}
