/**
 * @file        s3b_Memory.js
 * @date        2026-04-15
 * @description BDI agent - Belief layer with memory.
 *              Tracks agent positions over time, computes movement direction,
 *              and evaluates whether agents are within observation range.
 *              MEMORY: can see several agent, but do not keep in memory if agent is not visible anymore.
 * 
 * @Todo        Correct carryingParcels, because is equal to 0 even if I have a parcel...
 */


import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import 'dotenv/config';

// ─── Configuration ────────────────────────────────────────────────────────────

const TOKEN = process.env.TOKEN;
const URL   = process.env.URL ?? 'ws://localhost:8080';

/** Set DEBUG=true in your .env to enable verbose logging. */
const DEBUG = process.env.DEBUG;

/** Timestamp de démarrage, utilisé pour les timestamps relatifs dans le beliefset. */
const nbrStart = Date.now();

/** Maximum number of log entries kept per agent in the beliefset. */
const NBR_MAX_BELIEFSET_ENTRIES = 10;

// ─── State ────────────────────────────────────────────────────────────────────
/**
 * Current position of the agent, confirmed by the server.
 * @type {{ x: number, y: number }}
 */
let myPosition = { x: 0, y: 0 };

/**
 * Agent observation distance, received from server config.
 * Used to determine whether a sensed agent is within perceiving area.
 * @type {number}
 */
let nbrAgentObservationDistance = 0;

/**
 * Full map tiles received once at startup.
 * Known types: 1 = parcel spawner, 2 = delivery zone, 3 = walkable.
 * @type {Array<{ x: number, y: number, type: number }>}
 */
let mapTiles = [];

/**
 * Parcels currently visible to the agent (within sensing range).
 * @type {Array<{ id: string, x: number, y: number, reward: number, carriedBy?: string }>}
 */
let visibleParcels = [];

/**
 * Parcels currently carried by the agent.
 * @type {Array<{ id: string, reward: number }>}
 */
let carriedParcels = [];

/**
 * Beliefset tracking the history of each sensed agent.
 * Key   : agent id
 * Value : array of log entries (capped at NBR_MAX_BELIEFSET_ENTRIES)
 *         Each entry: { id, name, x, y, score, timestamp, visible, direction }
 * @type {Map<string, Array<{ id: string, name: string, x: number, y: number, score: number, timestamp: number, visible: boolean, direction: string }>>}
 */
const mapBeliefset = new Map();

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
 * Fired once when server sends configuration.
 * Extracts agent observation distance.
 */
socket.onConfig((config) =>
{
    nbrAgentObservationDistance = config.GAME.player.observation_distance;
    dbg(`[CONFIG] Observation distance: ${nbrAgentObservationDistance}`);
});

/**
 * Fired by the server whenever the agent's position is confirmed.
 */
socket.on('you', (me) =>
{
    myPosition = { x: me.x, y: me.y };
});

/**
 * Fired periodically with all entities in the agent's sensing range.
 * Updates visibleParcels and the beliefset for each visible agent.
 */
socket.onSensing((data) =>
{
    // ── Parcels ───────────────────────────────────────────────────────────────
    visibleParcels = data.parcels ?? [];
    // dbg(`[SENSING] ${visibleParcels.length} parcel(s) visible.`);

    // ── Agents beliefset update ───────────────────────────────────────────────
    const nbrTimestamp = Date.now() - nbrStart;
    for (let a of data.agents ?? [])
    {
        if (!mapBeliefset.has(a.id))
        {
            mapBeliefset.set(a.id, []);
        }

        const arrLogs = mapBeliefset.get(a.id);

        // Compute direction from previous entry
        let strDirection = 'none';
        if (arrLogs.length > 0)
        {
            const objPrevious = arrLogs[arrLogs.length - 1];

            if      (objPrevious.x < a.x) strDirection = 'right';
            else if (objPrevious.x > a.x) strDirection = 'left';
            else if (objPrevious.y < a.y) strDirection = 'up';
            else if (objPrevious.y > a.y) strDirection = 'down';
            else                          strDirection = 'none';
        }

        const objEntry = {
            id:        a.id,
            name:      a.name,
            x:         a.x,
            y:         a.y,
            score:     a.score,
            timestamp: nbrTimestamp,
            direction: strDirection
        };

        arrLogs.push(objEntry);

        // Cap memory: keep only the last NBR_MAX_BELIEFSET_ENTRIES entries
        if (arrLogs.length > NBR_MAX_BELIEFSET_ENTRIES)
        {
            arrLogs.shift();
        }
    }

    // ── Update no more visible agents (open-world assumption, limited memory) ─────────────
    const setVisibleIds = new Set((data.agents ?? []).map(a => a.id));
    for (const [strId] of mapBeliefset)
    {
        if (!setVisibleIds.has(strId))
        {
            mapBeliefset.set(strId, { ...mapBeliefset.get(strId), visible: false });
            dbg(`[BELIEF] Agent ${strId} left range, belief updated.`);
        }
    }

    // ── Pretty print beliefset ────────────────────────────────────────────────
    const strPrettyPrint = Array.from(mapBeliefset.values())
        .map((arrLogs) =>
        {
            const { timestamp, name, x, y, direction } = arrLogs[arrLogs.length - 1];
            const nbrDist = manhattanDist(myPosition, { x, y });
            // [QUESTION] why boolInRange is usefull ? 
            const boolInRange = nbrDist < nbrAgentObservationDistance;

            return `${name}(${direction},inRange=${boolInRange})@${timestamp}:${x},${y}`;
        })
        .join(' ');

    console.log('[BELIEFS]', strPrettyPrint);
});

/**
 * Fired once when the map is loaded.
 * Stores the tile layout and starts the main agent loop.
 */
socket.on('map', (x, y, t) =>
{
    mapTiles = t;
    dbg(`[MAP] ${x}x${y} — ${t.length} tile(s) loaded. Starting loop...`);
    agentLoop();
});

// ─── Main loop ────────────────────────────────────────────────────────────────

/**
 * Main agent loop. Runs indefinitely, one tick at a time.
 * The delay(100) is mandatory: it yields control back to the event loop,
 * allowing onSensing and other callbacks to fire between ticks.
 */
async function agentLoop()
{
    while (true)
    {
        await tick();
        await delay(100);
    }
}

/**
 * One decision cycle. Currently idle — to be extended with desires and intentions.
 */
async function tick()
{
    dbg(`[TICK] pos=(${myPosition.x},${myPosition.y}) carrying=${carriedParcels.length} beliefs=${mapBeliefset.size}`);
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
 * Polls a condition every 50ms until it returns true or the timeout expires.
 * @param {() => boolean} fnCondition
 * @param {number} nbrTimeoutMs
 * @returns {Promise<void>}
 */
async function waitUntil(fnCondition, nbrTimeoutMs)
{
    const nbrStart = Date.now();
    while (!fnCondition() && Date.now() - nbrStart < nbrTimeoutMs)
    {
        await delay(50);
    }
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
 * Named 'dbg' to avoid naming conflict with local variables named 'log'.
 * @param {...any} args
 */
function dbg(...args)
{
    if (DEBUG === 'true' || DEBUG === true)
    {
        console.log(...args);
    }
}
