/**
 * @file        s4_ReactiveAgent.js
 * @author      Thomas Eyer
 * @date        2026-04-15
 * @description Reactive agent for Deliveroo.js.
 *              Reacts to visible parcels, moves towards them, and picks them up.
 *              Based on s3b structure, with reactive logic from the provided code.
 * @version     1.0.0
 */

import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import 'dotenv/config';

// ─── Configuration ────────────────────────────────────────────────────────────
const TOKEN = process.env.TOKEN;
const URL   = process.env.URL;
/** Set DEBUG=true in your .env to enable verbose logging. */
const DEBUG = process.env.DEBUG;

// ─── State ────────────────────────────────────────────────────────────────────
/**
 * Current position of the agent, confirmed by the server.
 * @type {{ x: number, y: number }}
 */
let myPosition = { x: 0, y: 0 };

/**
 * Parcels currently visible to the agent (within sensing range).
 * @type {Array<{ id: string, x: number, y: number, reward: number, carriedBy?: string }>}
 */
let visibleParcels = [];

/**
 * Flag to control movement and avoid overlapping actions.
 * @type {boolean}
 */
let control = false;

// ─── Connection ───────────────────────────────────────────────────────────────
const socket = DjsConnect(URL, TOKEN);

if (!socket)
{
    console.log('[ERROR] Failed to connect to server.');
    process.exit(1);
}
else
{
    console.log('[INIT] Connected to server.');
}

// ─── Events ───────────────────────────────────────────────────────────────────

/**
 * Fired by the server whenever the agent's position is confirmed.
 */
socket.on('you', (me) =>
{
    myPosition = { x: me.x, y: me.y };
    dbg(`[YOU] Updated position: (${myPosition.x}, ${myPosition.y})`);
});

/**
 * Fired periodically with all entities in the agent's sensing range.
 * Updates visibleParcels and reacts to visible parcels.
 */
socket.onSensing((data) =>
{
    visibleParcels = data.parcels ?? [];
    dbg(`[SENSING] ${visibleParcels.length} parcel(s) visible.`);

    // React to visible parcels
    reactToParcels();
});

/**
 * Fired once when the map is loaded.
 */
socket.on('map', (x, y, t) =>
{
    dbg(`[MAP] ${x}x${y} — ${t.length} tile(s) loaded.`);
});

// ─── Reactive Logic ────────────────────────────────────────────────────────────

/**
 * Reacts to visible parcels: moves towards the nearest parcel and picks it up.
 */
async function reactToParcels()
{
    if (control)
    {
        dbg(`[REACT] Skipping: already in control.`);
        return;
    }

    control = true;

    for (let p of visibleParcels)
    {
        if (!p.carriedBy)
        {
            dbg(`[REACT] Targeting parcel ${p.id} at (${p.x}, ${p.y})`);

            // Move towards the parcel
            if      (myPosition.x == p.x-1 && myPosition.y == p.y)
                await socket.emitMove('right');
            else if (myPosition.x == p.x+1 && myPosition.y == p.y)
                await socket.emitMove('left');
            else if (myPosition.y == p.y-1 && myPosition.x == p.x)
                await socket.emitMove('up');
            else if (myPosition.y == p.y+1 && myPosition.x == p.x)
                await socket.emitMove('down');

            // Pick up the parcel if on the same tile
            if (myPosition.x == p.x && myPosition.y == p.y)
            {
                await socket.emitPickup();
                dbg(`[REACT] Picked up parcel ${p.id}`);
            }
        }
    }

    control = false;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Computes the Manhattan distance between two positions.
 * @param {{ x: number, y: number }} objA
 * @param {{ x: number, y: number }} objB
 * @returns {number}
 */
function manhattanDist(objA, objB)
{
    return Math.abs(objA.x - objB.x) + Math.abs(objA.y - objB.y);
}

/**
 * Waits for the given number of milliseconds.
 * @param {number} nbrMs
 * @returns {Promise<void>}
 */
function delay(nbrMs)
{
    return new Promise((resolve) => setTimeout(resolve, nbrMs));
}

/**
 * Logs a message only when DEBUG mode is enabled.
 * @param {...any} args
 */
function dbg(...args)
{
    if (DEBUG === 'true' || DEBUG === true)
    {
        console.log(...args);
    }
}