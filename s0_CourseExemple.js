import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import 'dotenv/config';

// ─── Configuration ────────────────────────────────────────────────────────────

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjRlZmMxMyIsIm5hbWUiOiJ0ZXN0NCIsInJvbGUiOiJ1c2VyIiwiaWF0IjoxNzc1ODMwNTM2fQ.2X7TEM8xtFXi_Bkm0rWLB8mGVH4LEmRh3Ablx_Z0ge0';
const URL = 'ws://localhost:8080';

/** Sequence of directions the agent will follow. */
const PATH = ['right', 'right', 'right', 'down', 'down', 'down', 'left', 'left', 'left', 'up', 'up', 'up'];

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {{ x: number, y: number }} Current position of the agent. */
let myPosition = { x: 5, y: 5 };

/**
 * List of parcels currently visible to the agent.
 * Each parcel has at least { id: string, x: number, y: number }.
 * @type {Array<{ id: string, x: number, y: number }>}
 */
let visibleParcels = [];

// ─── Connection ───────────────────────────────────────────────────────────────

console.log('[INIT] Connecting to server...');
const socket = DjsConnect(URL, TOKEN);

// ─── Event listeners ──────────────────────────────────────────────────────────

/**
 * Updates the agent's position whenever the server confirms it.
 */
socket.on('you', (x, y) => {
    myPosition = { x, y };
    console.log(`[POSITION] Updated position → x:${x}, y:${y}`);
});

/**
 * Updates the list of visible parcels from sensing data.
 * Sensing data shape: { agents: [...], parcels: [...] }
 */
socket.onSensing((data) => {
    visibleParcels = data.parcels ?? [];
    console.log(`[SENSING] ${visibleParcels.length} parcel(s) detected.`);
});

/**
 * Main logic: triggered once when the map is received.
 * Moves the agent step by step along PATH and attempts pickup on parcel tiles.
 */
socket.on('map', async (width, height, tiles) => 
{
    console.log(`[MAP] Received map: ${width}x${height}, ${tiles.length} tiles.`);

    for (const direction of PATH) 
    {
        console.log(`[MOVE] Attempting to move: ${direction}`);

        const moved = await socket.emitMove(direction);

        if (!moved) 
        {
            console.log(`[MOVE] Move "${direction}" failed. Waiting before next step...`);
            await delay(100);
            continue;
        }

        console.log(`[MOVE] Move "${direction}" succeeded. Current position: x:${myPosition.x}, y:${myPosition.y}`);
        await tryPickupAtCurrentPosition();
    }

    console.log('[DONE] Path completed.');
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Checks if there is a parcel at the agent's current position.
 * If yes, attempts a pickup action.
 */
async function tryPickupAtCurrentPosition() {
    console.log(`[PICKUP] Checking for parcels at x:${myPosition.x}, y:${myPosition.y}...`);

    const parcelHere = visibleParcels.find(
        (parcel) => parcel.x === myPosition.x && parcel.y === myPosition.y
    );

    if (!parcelHere) 
    {
        console.log('[PICKUP] No parcel at current position. Skipping.');
        return;
    }

    console.log(`[PICKUP] Parcel found (id: ${parcelHere.id}). Attempting pickup...`);
    const result = await socket.emitPickup();
    console.log(`[PICKUP] Result:`, result);
}

/**
 * Returns a promise that resolves after the given number of milliseconds.
 * @param {number} ms - Duration to wait in milliseconds.
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}