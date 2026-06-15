import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import { solveOnline, buildProblem, dumpProblem } from './pddl_planner.js';
import { readFile } from 'fs/promises';

const TOKEN = process.env.TOKEN;
const HOST = process.env.HOST;
const DEBUG = false;

const socket = DjsConnect(HOST, TOKEN);
if (!socket) {
  console.error('[PDDL] Failed to connect');
  process.exit(1);
}

let mapTiles = [];
let agentState = { id: 'agent1', x: 0, y: 0 };
let parcels = [];
let goalTile = {x:3, y:3};
let currentPlan = [];
let isExecuting = false;

async function loadDomain() {
  return await readFile(new URL('./pddl_domain.pddl', import.meta.url), 'utf8');
}

socket.onConfig((config) => {
  if (DEBUG) console.log('[PDDL] Config', config);
});

socket.on('you', (me) => {
  agentState = { id: me.id ?? 'agent1', x: me.x ?? 0, y: me.y ?? 0 };
  if (DEBUG) console.log('[PDDL] You:', agentState);
});

socket.on('map', (height, width, tiles) => {
  mapTiles = tiles.map(t => ({
    x: t.x,
    y: t.y,
    type: typeof t.type === 'number' ? t.type.toString() : t.type
  }));
  console.log('[PDDL] Map received', mapTiles.length, 'tiles');
});

socket.onSensing(async (data) => {
  parcels = (data.parcels ?? []).map(p => ({
    id: p.id,
    x: p.x ?? 0,
    y: p.y ?? 0,
    reward: p.reward ?? 0,
    pickup: true
  }));

  agentState.x = data.agent?.x ?? agentState.x;
  agentState.y = data.agent?.y ?? agentState.y;

  if (!goalTile && mapTiles.length > 0) {
    goalTile = mapTiles.find(t => t.type === '2');
  }

  await planAndExecute();
});

async function planAndExecute() {
  if (isExecuting) return;
  if (!goalTile) return;
  if (mapTiles.length === 0) return;

  const domain = await loadDomain();
  const problem = buildProblem({
    tiles: mapTiles,
    agent: agentState,
    parcels,
    goalTile
  });

  if (DEBUG) {
    await dumpProblem(domain, problem, 'debug_pddl');
  }

  try {
    currentPlan = await solveOnline(domain, problem);
    console.log('[PDDL] Plan received:', currentPlan);
  } catch (error) {
    console.error('[PDDL] Planning failed', error);
    return;
  }

  if (!Array.isArray(currentPlan) || currentPlan.length === 0) {
    console.log('[PDDL] No actions returned; current state already satisfies the PDDL goal or there is nothing to do.');
    return;
  }

  await executePlan();
}

async function executePlan() {
  if (!Array.isArray(currentPlan) || currentPlan.length === 0) {
    return;
  }

  isExecuting = true;

  while (currentPlan.length > 0) {
    const action = currentPlan.shift();
    await executeAction(action);
  }

  isExecuting = false;
}

async function executeAction(action) {
  let moveDir = null;

  if (action.startsWith('move-up')) moveDir = 'up';
  if (action.startsWith('move-down')) moveDir = 'down';
  if (action.startsWith('move-left')) moveDir = 'left';
  if (action.startsWith('move-right')) moveDir = 'right';

  if (moveDir) {
    console.log(`[PDDL] Executing move ${moveDir}`);
    await socket.emitMove(moveDir);
    return;
  }

  if (action.startsWith('pickup')) {
    console.log('[PDDL] Executing pickup');
    await socket.emitPickup();
    return;
  }

  if (action.startsWith('deliver')) {
    console.log('[PDDL] Executing deliver');
    await socket.emitPutdown();
    return;
  }

  console.log('[PDDL] Unknown action', action);
}

console.log('[PDDL] Agent started');
