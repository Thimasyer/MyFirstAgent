/**
 * @file        s3_NoMemory.js
 * @date        2026-04-15
 * @description BDI agent - Belief layer WITHOUT memory.
 *              Tracks only currently visible agents, without retaining any belief about those that are no longer visible.
 * @note        PAS FORCEMENT UTILE, CODE A VERIFIER ENCORE
 */


import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import 'dotenv/config';

// ─── Configuration ────────────────────────────────────────────────────────────
const TOKEN = process.env.TOKEN;
const URL   = process.env.URL ?? 'ws://localhost:8080';
const DEBUG = process.env.DEBUG;

// ─── State ────────────────────────────────────────────────────────────────────
let myPosition    = { x: 0, y: 0 };
let visibleParcels = [];
let mapTiles       = [];
let carriedParcels = [];

/**
 * Beliefset : état COURANT de chaque agent visible.
 * Clé   : agent id
 * Valeur: { id, name, x, y, score, lastSeen, direction }
 * On écrase à chaque sensing → mémoire O(nb_agents), pas O(temps).
 * @type {Map<string, {id:string, name:string, x:number, y:number, score:number, lastSeen:number, direction:{dx:number,dy:number}|null}>}
 */
const beliefset = new Map();

// ─── Connection ───────────────────────────────────────────────────────────────
const socket = DjsConnect(URL, TOKEN);
if (!socket) {
    console.log('[ERROR] Failed to connect to server.');
    process.exit(1);
}
console.log('[INIT] Connected to server.');

// ─── Events ───────────────────────────────────────────────────────────────────

socket.on('you', (me) => {
    myPosition = { x: me.x, y: me.y };
});

socket.onSensing((data) => {
    visibleParcels = data.parcels ?? [];
    dbg(`[SENSING] ${visibleParcels.length} parcel(s) visible, ${(data.agents ?? []).length} agent(s) visible.`);

    const now = Date.now();

    for (let a of data.agents ?? []) {

        const previous = beliefset.get(a.id);

        // Calcul de la direction de déplacement depuis la croyance précédente
        const direction = previous
            ? { dx: a.x - previous.x, dy: a.y - previous.y }
            : null;

        // Écrasement de la croyance courante (O(1) mémoire par agent)
        beliefset.set(a.id, {
            id:       a.id,
            name:     a.name,
            x:        a.x,
            y:        a.y,
            score:    a.score,
            lastSeen: now,
            direction
        });

        dbg(`[BELIEF] ${a.name} at (${a.x},${a.y}) score=${a.score} dir=${JSON.stringify(direction)}`);
    }

    // Nettoyage : retirer les agents qui ne sont plus visibles
    // (optionnel selon la sémantique souhaitée : open-world vs closed-world)
    const visibleIds = new Set((data.agents ?? []).map(a => a.id));
    for (const [id] of beliefset) {
        if (!visibleIds.has(id)) {
            beliefset.delete(id);
            dbg(`[BELIEF] Agent ${id} left observation range, belief removed.`);
        }
    }
});

socket.on('map', (x, y, t) => {
    mapTiles = t;
    dbg(`[MAP] ${x}x${y} — ${t.length} tile(s) loaded.`);
    agentLoop();
});

// ─── Main loop ────────────────────────────────────────────────────────────────

async function agentLoop() 
{
    while (true) 
    {
        await tick();
        await delay(100); // laisse le temps au events de se finir
    }
}

async function tick() {
    // Replanification BDI : à compléter avec désirs et intentions
    dbg(`[TICK] pos=(${myPosition.x},${myPosition.y}) carrying=${carriedParcels.length} beliefs=${beliefset.size}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isOnDeliveryTile() {
    return mapTiles.find(t => t.x === myPosition.x && t.y === myPosition.y)?.type == 2;
}

function getParcelOnCurrentTile() {
    return visibleParcels.find(p => p.x === myPosition.x && p.y === myPosition.y);
}

function isAlreadyCarried(id) {
    return carriedParcels.some(p => p.id === id);
}

async function waitUntil(condition, timeoutMs) {
    const start = Date.now();
    while (!condition() && Date.now() - start < timeoutMs) {
        await delay(50);
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Renommé 'dbg' pour éviter le conflit avec la variable locale 'log' dans onSensing
function dbg(...args) {
    if (DEBUG === 'true' || DEBUG === true) {
        console.log(...args);
    }
}