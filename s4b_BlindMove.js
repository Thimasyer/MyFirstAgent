/**
 * @file        s4b_BlindMove.js
 * @author      Thomas Eyer
 * @date        2026-04-15
 * @description Blind move agent for Deliveroo.js.
 *              Moves blindly towards a target position provided as command-line arguments.
 *              Based on s4 structure, with blind movement logic.
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
 * Map of tiles, indexed by their coordinates.
 * @type {Map<string, {x: number, y: number, type: string}>}
 */
const map = new Map();

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
 * Fired whenever a tile is updated or received.
 */
socket.onTile(({ x, y, type }) =>
{
    const key = `${x}_${y}`;
    map.set(key, { x, y, type });
    // dbg(`[TILE] Added tile at (${x}, ${y}) with type: ${type}`);
});

// ─── Main Logic ────────────────────────────────────────────────────────────────

/**
 * Waits for the agent's initial position to be set.
 * @returns {Promise<void>}
 */
async function waitForInitialPosition()
{
    return new Promise((resolve) =>
    {
        socket.on('you', ({ x, y }) =>
        {
            if (x !== undefined && y !== undefined)
            {
                myPosition = { x, y };
                dbg(`[INIT] Initial position set: (${x}, ${y})`);
                resolve();
            }
        });
    });
}

/**
 * Moves the agent blindly towards the target position.
 * @param {{ x: number, y: number }} target
 */
async function moveToTarget(target)
{
    dbg(`[TARGET] Moving from (${myPosition.x}, ${myPosition.y}) to (${target.x}, ${target.y}).`);

    while (myPosition.x !== target.x || myPosition.y !== target.y)
    {
        // Wait for the agent's position to be updated (integer coordinates)
        await new Promise((resolve) =>
        {
            socket.on('you', ({ x, y }) =>
            {
                if (x % 1 === 0 && y % 1 === 0)
                {
                    myPosition = { x, y };
                    resolve();
                }
            });
        });

        // Move towards the target
        if (myPosition.x < target.x) 
        {
            dbg(`[MOVE] Attempting to move right.`);
            const moveResult = await socket.emitMove('right');
            dbg(`[MOVE] Move right result: ${moveResult ? 'success' : 'failed'}`);
        }
        else if (myPosition.x > target.x) 
        {
            dbg(`[MOVE] Attempting to move left.`);
            const moveResult = await socket.emitMove('left');
            dbg(`[MOVE] Move left result: ${moveResult ? 'success' : 'failed'}`);
        }

        if (myPosition.y < target.y) 
        {
            dbg(`[MOVE] Attempting to move up.`);
            const moveResult = await socket.emitMove('up');
            dbg(`[MOVE] Move up result: ${moveResult ? 'success' : 'failed'}`);
        }
        else if (myPosition.y > target.y) 
        {
            dbg(`[MOVE] Attempting to move down.`);
            const moveResult = await socket.emitMove('down');
            dbg(`[MOVE] Move down result: ${moveResult ? 'success' : 'failed'}`);
        }
    }

    dbg(`[TARGET] Reached target position: (${myPosition.x}, ${myPosition.y}).`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Start ────────────────────────────────────────────────────────────────────

(async () =>
{
    await waitForInitialPosition();

    const target = {
        x: parseInt(process.argv[2]),
        y: parseInt(process.argv[3])
    };

    if (isNaN(target.x) || isNaN(target.y))
    {
        console.error('[ERROR] Invalid target coordinates. Usage: node s4b_BlindMove.js <x> <y>');
        process.exit(1);
    }

    dbg(`[START] ${myPosition.name} goes from (${myPosition.x}, ${myPosition.y}) to (${target.x}, ${target.y}).`);
    await moveToTarget(target);
})();