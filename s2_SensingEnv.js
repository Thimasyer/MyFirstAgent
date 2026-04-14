import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import 'dotenv/config';

// ─── Configuration ────────────────────────────────────────────────────────────

const TOKEN = process.env.TOKEN;
const URL   = process.env.URL   ?? 'ws://localhost:8080';
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
 * A parcel disappears from this list once it is picked up.
 * Each entry: { id: string, x: number, y: number, reward: number, carriedBy?: string }
 * @type {Array<{ id: string, x: number, y: number, reward: number, carriedBy?: string }>}
 */
let visibleParcels = [];

/**
 * Full map tiles received once at startup.
 * Used to determine tile types (delivery zone, walkable, etc.)
 * Each tile: { x: number, y: number, type: number }
 * Known types: 1 = parcel spawner, 2 = delivery zone, 3 = walkable, 4 = base.
 * @type {Array<{ x: number, y: number, type: number }>}
 */
let mapTiles = [];

/**
 * Parcels currently carried by the agent.
 * A parcel is added after a confirmed pickup and the list is cleared after delivery.
 * Using the parcel id to avoid duplicate pickup attempts on the same parcel.
 * @type {Array<{ id: string, reward: number }>}
 */
let carriedParcels = [];

// ─── Connection ───────────────────────────────────────────────────────────────

const socket = DjsConnect(URL, TOKEN);
if (!socket) 
{
        log('[ERROR] Failed to connect to server.');
        process.exit(1);
}
else
{
    console.log('[INIT] Connected to server.');
}

// ─── Events ───────────────────────────────────────────────────────────────────

/**
 * Fired by the server whenever the agent's position is confirmed.
 * Always updates myPosition, even if unchanged, to stay in sync with the server.
 */
socket.on('you', (me) =>
{
    myPosition = { x: me.x, y: me.y };
});

/**
 * Fired periodically with all entities in the agent's sensing range.
 * Replaces the full visibleParcels list on each update.
 */
socket.onSensing((data) =>
{
    visibleParcels = data.parcels ?? [];
    log(`[SENSING] ${visibleParcels.length} parcel(s) visible.`);
});

/**
 * Fired once when the map is loaded.
 * Stores the tile layout and starts the main agent loop.
 */
socket.on('map', (width, height, tiles) =>
{
    mapTiles = tiles;
    log(`[MAP] ${width}x${height} — ${tiles.length} tile(s) loaded. Starting loop...`);
    agentLoop();
});

// ─── Main loop ────────────────────────────────────────────────────────────────

/**
 * Main agent loop. Runs indefinitely, one tick at a time.
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
 * One decision cycle:
 * 1. Delivery: if carrying parcels and standing on a delivery tile → deliver all.
 * 2. Pickup: if a parcel is on the current tile and not already carried → pick it up.
 * 3. Idle: nothing to do, wait quietly.
 */
async function tick()
{
    log(`\n [TICK] Starting tick. \n
            Carrying ${carriedParcels.length} parcel(s). \n
            Is on delivery tile: ${isOnDeliveryTile()}`);
    // ── 1. Delivery ───────────────────────────────────────────────────────────
    if (carriedParcels.length > 0 && isOnDeliveryTile())
    {
        log(`[DELIVERY] Delivering ${carriedParcels.length} parcel(s)...`);
        const result = await socket.emitPutdown(); // put down all parcels
        if (result)
        {
            log(`[DELIVERY] ✓ Delivered successfully.`);
            carriedParcels = [];
        }
        else
        {
            log(`[DELIVERY] ✗ Delivery failed.`);
        }
        return;
    }

    // ── 2. Pickup ─────────────────────────────────────────────────────────────
    const parcelHere = getParcelOnCurrentTile();
    // If a parcel is on this tile and not already carrying it 
    if (parcelHere && !isAlreadyCarried(parcelHere.id))
    {
        log(`[PICKUP] Parcel "${parcelHere.id}" found. Picking up...`);
        await socket.emitPickup();

        // Wait for the server to confirm: the parcel disappears from visibleParcels.
        await waitUntil(() => !getParcelOnCurrentTile(), 2000);

        if (!getParcelOnCurrentTile())
        {
            carriedParcels.push({ id: parcelHere.id, reward: parcelHere.reward });
            log(`[PICKUP] ✓ Carrying ${carriedParcels.length} parcel(s).`);
        }
        else
        {
            log(`[PICKUP] ✗ Pickup failed or parcel already taken by another agent.`);
        }   

    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true if the agent's current tile is a delivery zone (type === 2).
 * @returns {boolean}
 */
function isOnDeliveryTile()
{
    const tile = mapTiles.find(
        (t) => t.x === myPosition.x && t.y === myPosition.y
    );
    return tile?.type == 2;
}

/**
 * Returns the first visible parcel located on the agent's current tile.
 * Returns undefined if no parcel is present.
 * @returns {{ id: string, x: number, y: number, reward: number } | undefined}
 */
function getParcelOnCurrentTile()
{
    return visibleParcels.find(
        (parcel) => parcel.x === myPosition.x && parcel.y === myPosition.y
    );
}

/**
 * Returns true if a parcel with the given id is already in carriedParcels.
 * Prevents duplicate pickup attempts on the same parcel.
 * @param {string} id - The parcel id to check.
 * @returns {boolean}
 */
function isAlreadyCarried(id)
{
    return carriedParcels.some((p) => p.id === id);
}

/**
 * Polls a condition every 50ms until it returns true or the timeout expires.
 * @param {() => boolean} condition
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function waitUntil(condition, timeoutMs)
{
    const start = Date.now();
    while (!condition() && Date.now() - start < timeoutMs)
    {
        await delay(50);
    }
}

/**
 * Waits for the given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms)
{
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Logs a message only when DEBUG mode is enabled.
 * Use for verbose output that would flood the console in production.
 * @param {...any} args
 */
function log(...args)
{
    if (DEBUG === 'true' || DEBUG === true)
    {
        console.log(...args);
    }
}
