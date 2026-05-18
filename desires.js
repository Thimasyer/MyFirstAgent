/**
 * Class representing the agent's desires.
 */
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
