// @ts-nocheck
import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import { Beliefs } from './beliefs.js';
import { Desires } from './desires.js';
import { heuristic, setBeliefs } from './pathfinding.js';
import { solveOnline, buildProblem, dumpProblem } from './pddl_planner.js';
import { readFile } from 'fs/promises';

const TOKEN = process.env.TOKEN;
const HOST = process.env.HOST;
const HEARTBEAT_DELAY_MS = 500;
const DEBUG = false;

const myBeliefs = new Beliefs();
setBeliefs(myBeliefs);
const myDesires = new Desires(myBeliefs);
let myIntentions;

let isExecuting = false;
let isCoreLoopRunning = false;
let lastSensingTime = Date.now();

const socket = DjsConnect(HOST, TOKEN);
if (!socket) {
  console.error('[PDDL] Failed to connect');
  process.exit(1);
}

function startHeartbeat() {
  setInterval(() => {
    const now = Date.now();
    if (now - lastSensingTime >= HEARTBEAT_DELAY_MS) {
      if (DEBUG) console.log('[PDDL] Heartbeat triggered core_loop');
      void core_loop();
    }
  }, HEARTBEAT_DELAY_MS);
}

startHeartbeat();

socket.onConfig((config) => {
  if (DEBUG) console.log('[PDDL] Config', config);
});

socket.on('you', (me) => {
  myBeliefs.updatePlayerPosition(me.x ?? 0, me.y ?? 0);
  if (me.id) {
    myBeliefs.setMyId(me.id);
  }
  if (DEBUG) console.log('[PDDL] You:', myBeliefs.getMyPosition());
});

socket.on('map', (height, width, tiles) => {
  myBeliefs.setMapWidth(width + 1);
  myBeliefs.setMapHeight(height + 1);
  myBeliefs.setTiles(tiles.map(t => ({
    x: t.x,
    y: t.y,
    type: typeof t.type === 'number' ? t.type.toString() : t.type
  })));

  myBeliefs.defineDeliveryPoint(myBeliefs.getTiles());
  myBeliefs.defineSpawnPoint(myBeliefs.getTiles());

  console.log(`[PDDL] Map received ${myBeliefs.getTiles().length} tiles`);
});

socket.onSensing(async (data) => {
  lastSensingTime = Date.now();

  const parcels = (data.parcels ?? []).map(p => ({
    id: p.id,
    x: p.x ?? 0,
    y: p.y ?? 0,
    carriedBy: p.carriedBy ?? '',
    reward: p.reward ?? 0
  }));

  const agents = (data.agents ?? []).map(a => ({
    id: a.id,
    x: a.x ?? 0,
    y: a.y ?? 0
  }));

  myBeliefs.updatePercepts(parcels, agents);

  if (!isCoreLoopRunning) {
    isCoreLoopRunning = true;
    try {
      await core_loop();
    } finally {
      isCoreLoopRunning = false;
    }
  }
});

async function loadDomain() {
  return await readFile(new URL('./pddl_domain.pddl', import.meta.url), 'utf8');
}

async function core_loop() {
  if (myIntentions.getPlan().length === 0) {
    myDesires.genOption();
    myIntentions.desiresToIntention();
    myIntentions.filterAndSortIntention();
    await myIntentions.setPlan();
    if (DEBUG) console.log('[PDDL] Generated plan:', myIntentions.getPlan());
  } else {
    const currentIntentionBlocked = myIntentions.getCurrentImpossibleIntentions().has(myIntentions.getCurrentObjective());
    if (currentIntentionBlocked) {
      console.log('[PDDL] Current intention blocked, clearing plan');
      myIntentions.clearPlan();
      myIntentions.clearCurrentImpossibleIntentions();
    }
  }

  const shouldContinue =
    myIntentions.getPlan().length > 0 &&
    !myIntentions.succeeded() &&
    !myIntentions.impossible();

  if (shouldContinue) {
    if (!isExecuting) {
      isExecuting = true;
      try {
        await myIntentions.executeNextAction();
      } finally {
        isExecuting = false;
      }
    }

    let planInvalidAfterReconsider = 0;
    if (myIntentions.reconsider()) {
      myDesires.genOption();
      myIntentions.desiresToIntention();
      myIntentions.filterAndSortIntention();
      planInvalidAfterReconsider = 1;
    }

    if (!myIntentions.isPlanValid() || planInvalidAfterReconsider) {
      if (myIntentions.getFilteredIntentions().length > 0) {
        myIntentions.clearPlan();
        await myIntentions.setPlan();
      }
    }
  } else {
    if (myIntentions.getPlan().length === 0) {
      if (DEBUG) console.log('[PDDL] Plan is empty');
    } else if (myIntentions.succeeded()) {
      console.log('[PDDL] Current intention succeeded', myIntentions.getCurrentObjective());
      myIntentions.clearPlan();
    } else if (myIntentions.impossible()) {
      console.log('[PDDL] Current intention impossible', myIntentions.getCurrentObjective());
      myIntentions.clearPlan();
      myIntentions.setCurrentImpossibleIntentions(myIntentions.getCurrentObjective());
    }
  }
}

class PDDLIntentions {
  #plan = [];
  #filteredSortedIntentions = [];
  #nonFilteredIntentions = [];
  #currentObjective = null;
  #desires;
  #beliefs;
  #currentImpossibleIntentions = new Set();
  #failedActionsQueue = [];

  constructor(desires, beliefs) {
    this.#desires = desires;
    this.#beliefs = beliefs;
  }

  setCurrentImpossibleIntentions(impossibleIntention) {
    this.#currentImpossibleIntentions.add(impossibleIntention);
  }

  clearCurrentImpossibleIntentions() {
    this.#currentImpossibleIntentions.clear();
  }

  desiresToIntention() {
    this.#nonFilteredIntentions = [];
    for (const desire of this.#desires.getDesires()) {
      if (desire.startsWith('pickup_')) {
        this.#nonFilteredIntentions.push(desire);
      } else if (desire.startsWith('deliver_') && this.#beliefs.getCarriedParcels().length > 0) {
        this.#nonFilteredIntentions.push(desire);
      } else if (desire.startsWith('explore_') && this.#beliefs.getCarriedParcels().length === 0) {
        this.#nonFilteredIntentions.push(desire);
      }
    }
  }

  filterAndSortIntention() {
    this.#filteredSortedIntentions = [];
    if (this.#nonFilteredIntentions.length === 0) {
      return;
    }

    const possibleIntentions = this.#nonFilteredIntentions.filter(
      intention => !this.#currentImpossibleIntentions.has(intention)
    );

    if (possibleIntentions.length === 0) {
      this.clearCurrentImpossibleIntentions();
    }

    const pickups = possibleIntentions.filter(d => d.startsWith('pickup_'));
    const delivers = possibleIntentions.filter(d => d.startsWith('deliver_'));
    const explores = possibleIntentions.filter(d => d.startsWith('explore_'));
    const playerPos = this.#beliefs.getMyPosition();

    if (this.#beliefs.getVisibleParcels().length > 0) {
      for (const p of pickups) {
        this.#filteredSortedIntentions.push(p);
      }
    }

    if (this.#beliefs.getCarriedParcels().length > 0 && delivers.length > 0) {
      const closestDeliver = this.#findClosestIntention(delivers, playerPos);
      if (closestDeliver) {
        this.#filteredSortedIntentions.push(closestDeliver);
      }
    }

    if (explores.length > 0 && this.#beliefs.getVisibleParcels().length === 0) {
      const outsideExplores = explores.filter(e => {
        const parts = e.split('_');
        const x = parseInt(parts[1]);
        const y = parseInt(parts[2]);
        const dist = heuristic({ x, y }, playerPos);
        return dist > this.#beliefs.getVisionRange();
      });

      const sortedExplores = outsideExplores.sort((a, b) => {
        const aParts = a.split('_');
        const bParts = b.split('_');
        const aDist = heuristic({ x: parseInt(aParts[1]), y: parseInt(aParts[2]) }, playerPos);
        const bDist = heuristic({ x: parseInt(bParts[1]), y: parseInt(bParts[2]) }, playerPos);
        return aDist - bDist;
      });

      this.#filteredSortedIntentions.push(...sortedExplores);
    }
  }

  #findClosestIntention(intentions, playerPosition) {
    if (intentions.length === 0) return null;
    let closest = intentions[0];
    let minDist = this.#getIntentionDistance(intentions[0], playerPosition);
    for (const intention of intentions) {
      const dist = this.#getIntentionDistance(intention, playerPosition);
      if (dist < minDist) {
        minDist = dist;
        closest = intention;
      }
    }
    return closest;
  }

  #getIntentionDistance(intention, playerPosition) {
    const parts = intention.split('_');
    if (parts.length < 3) return Infinity;
    const x = parseInt(parts[1]);
    const y = parseInt(parts[2]);
    return heuristic({ x, y }, playerPosition);
  }

  async setPlan() {
    if (this.#filteredSortedIntentions.length === 0) {
      if (this.#nonFilteredIntentions.length > 0) {
        this.#filteredSortedIntentions = [...this.#nonFilteredIntentions];
      }
    }

    const objective = this.#filteredSortedIntentions[0];
    if (!objective) {
      this.clearPlan();
      return;
    }

    this.#currentObjective = objective;
    this.#plan = await this.#generatePlanFromObjective(objective);
    if (!Array.isArray(this.#plan)) {
      this.#plan = [];
    }

    if (this.#plan.length === 0) {
      this.setCurrentImpossibleIntentions(objective);
    }
  }

  async #generatePlanFromObjective(objective) {
    const domain = await loadDomain();
    const { x, y } = this.#parseObjectiveLocation(objective);
    const objectiveType = objective.split('_')[0];
    const agent = {
      id: this.#beliefs.getMyId() ?? 'agent1',
      x: this.#beliefs.getMyPosition().x,
      y: this.#beliefs.getMyPosition().y
    };

    const visibleParcels = this.#beliefs.getVisibleParcels().map(p => ({
      id: p.id,
      x: p.x,
      y: p.y,
      carried: false
    }));

    const carriedParcels = this.#beliefs.getCarriedParcels().map(p => ({
      id: p.id,
      carried: true
    }));

    const objectiveSpec = {
      type: objectiveType,
      goalTile: { x, y },
      parcelId: objectiveType === 'pickup' ? this.#parcelIdAtPosition(x, y) : undefined,
      carriedParcelIds: carriedParcels.map(p => p.id)
    };

    const blockedTiles = [...this.#beliefs.blockedTiles].map(entry => {
      const [x, y] = entry.split('_').map(Number);
      return { x, y };
    });

    const state = {
      tiles: this.#beliefs.getTiles(),
      agent,
      parcels: [...visibleParcels, ...carriedParcels],
      objective: objectiveSpec,
      blockedTiles
    };

    try {
      const problem = buildProblem(state);
      if (DEBUG) {
        await dumpProblem(domain, problem, 'debug_pddl');
      }
      const plan = await solveOnline(domain, problem);
      return plan;
    } catch (error) {
      console.error('[PDDL] Planner error for objective', objective, error);
      return [];
    }
  }

  #parcelIdAtPosition(x, y) {
    const parcel = this.#beliefs.getVisibleParcels().find(p => p.x === x && p.y === y);
    return parcel ? parcel.id : undefined;
  }

  #parseObjectiveLocation(objective) {
    const parts = objective.split('_');
    return { x: parseInt(parts[1]), y: parseInt(parts[2]) };
  }

  async executeNextAction() {
    const action = this.getPlan()[0];
    if (!action) return;

    if (action.startsWith('move-')) {
      const direction = action.slice('move-'.length);
      const moved = await socket.emitMove(direction);
      if (moved) {
        this.#plan.shift();
      } else {
        console.log('[PDDL] Move failed:', direction);
        if (this.recordFailedAction(action)) {
          const pos = this.#beliefs.getMyPosition();
          let blockedX = pos.x;
          let blockedY = pos.y;
          switch (direction) {
            case 'up': blockedY += 1; break;
            case 'down': blockedY -= 1; break;
            case 'right': blockedX += 1; break;
            case 'left': blockedX -= 1; break;
          }
          this.#beliefs.addBlockedTile(blockedX, blockedY);
          this.setCurrentImpossibleIntentions(this.#currentObjective);
        }
        this.clearPlan();
      }
      return;
    }

    if (action === 'pickup') {
      const picked = await socket.emitPickup();
      if (picked && picked.length > 0) {
        this.#plan.shift();
      } else {
        console.log('[PDDL] Pickup failed');
        this.clearPlan();
      }
      return;
    }

    if (action === 'deliver') {
      const delivered = await socket.emitPutdown();
      if (delivered && delivered.length > 0) {
        this.#plan.shift();
      } else {
        console.log('[PDDL] Deliver failed');
        this.clearPlan();
      }
      return;
    }

    console.log('[PDDL] Unknown action', action);
    this.clearPlan();
  }

  recordFailedAction(action) {
    this.#failedActionsQueue.push(action);
    if (this.#failedActionsQueue.length >= 2) {
      const lastTwo = this.#failedActionsQueue.slice(-2);
      if (lastTwo.every(a => a === action)) {
        this.#failedActionsQueue = [];
        return true;
      }
    }
    return false;
  }

  isPlanValid() {
    if (!this.#currentObjective) return false;
    if (this.#currentObjective.startsWith('pickup_')) {
      const { x, y } = this.#parseObjectiveLocation(this.#currentObjective);
      return this.#beliefs.getVisibleParcels().some(p => p.x === x && p.y === y);
    }
    if (this.#currentObjective.startsWith('deliver_')) {
      return this.#beliefs.getCarriedParcels().length > 0;
    }
    if (this.#currentObjective.startsWith('explore_')) {
      const { x, y } = this.#parseObjectiveLocation(this.#currentObjective);
      const tile = this.#beliefs.getTiles().find(t => t.x === x && t.y === y);
      return tile?.type !== '0';
    }
    return false;
  }

  reconsider() {
    if (!this.#currentObjective) return true;
    const type = this.#currentObjective.split('_')[0];
    if (type === 'pickup') {
      const { x, y } = this.#parseObjectiveLocation(this.#currentObjective);
      return !this.#beliefs.getVisibleParcels().some(p => p.x === x && p.y === y);
    }
    if (type === 'deliver') {
      return this.#beliefs.getCarriedParcels().length === 0;
    }
    if (type === 'explore') {
      return this.#beliefs.getVisibleParcels().length > 0;
    }
    return false;
  }

  succeeded() {
    if (!this.#currentObjective) return false;
    const type = this.#currentObjective.split('_')[0];
    const { x, y } = this.#parseObjectiveLocation(this.#currentObjective);
    const pos = this.#beliefs.getMyPosition();
    if (type === 'pickup') {
      return this.#beliefs.getCarriedParcels().length > 0 &&
        !this.#beliefs.getVisibleParcels().some(p => p.x === x && p.y === y);
    }
    if (type === 'deliver') {
      return this.#beliefs.getCarriedParcels().length === 0 && pos.x === x && pos.y === y;
    }
    if (type === 'explore') {
      return pos.x === x && pos.y === y;
    }
    return false;
  }

  impossible() {
    if (!this.#currentObjective) return false;
    if (this.#currentImpossibleIntentions.has(this.#currentObjective)) {
      return true;
    }
    const type = this.#currentObjective.split('_')[0];
    if (type === 'pickup') {
      const { x, y } = this.#parseObjectiveLocation(this.#currentObjective);
      return !this.#beliefs.getVisibleParcels().some(p => p.x === x && p.y === y);
    }
    if (type === 'deliver') {
      return this.#beliefs.getCarriedParcels().length === 0;
    }
    if (type === 'explore') {
      const { x, y } = this.#parseObjectiveLocation(this.#currentObjective);
      const tile = this.#beliefs.getTiles().find(t => t.x === x && t.y === y);
      return tile?.type === '0';
    }
    return false;
  }

  getPlan() {
    return this.#plan;
  }

  getCurrentObjective() {
    return this.#currentObjective ?? 'undefined';
  }

  getFilteredIntentions() {
    return this.#filteredSortedIntentions;
  }

  getCurrentImpossibleIntentions() {
    return this.#currentImpossibleIntentions;
  }

  clearPlan() {
    this.#plan = [];
    this.#currentObjective = null;
  }
}

myIntentions = new PDDLIntentions(myDesires, myBeliefs);
myDesires.setLinkedIntentions(myIntentions);

console.log('[PDDL] Agent started');
