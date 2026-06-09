/*******************************************************************************/
// File:          agent_bdi.js
// Description:   Main entry point for the BDI (Belief-Desire-Intention) agent.
//                Implements the agent's decision-making loop using the BDI model:
//                - Beliefs: Agent's knowledge/perception about the world (position, parcels, map, etc.)
//                - Desires: Agent's goals (pickup parcels, deliver, explore)
//                - Intentions: Agent's selected plans to achieve desires
// Include:       beliefs.js, desires.js, intentions.js, use_LLM.js, tools_LLM.js     
// 
// TODO 1:     prendre une glace
// TODO 2:    - Rajouter les tiles fléchés à la logique
//            - Rajouter les crate (boite jaune) à la logique
//            3. Ajouter les intentions "goto_x_y" (FAIT), "wait_condition", etc pour coller avec le PROMPT_AGENT dans use_LLM.js
//            4. Corriger/simplifier la boucle BDI pour gêrer le blocage lorsque plus aucune intention n'est possible si des cases était bloqué par un agent 
//                  => idée commencé: reset les intentions et les cases bloqué une fois toutes les intentions checker impossibles
//
// TODO 3:    Where do we have to updateProbabilityMap()? 
//                 not in onSensing, take to long
/*******************************************************************************/
import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import { Beliefs } from './beliefs.js';
import { Desires } from './desires.js';
import { Intentions } from './intentions.js';
import { generatePathTo } from "./pathfinding.js";
import { registerTool, runAgentTurn } from "./use_LLM.js";
import { calculate, 
    get_current_time, 
    get_me_info, move, 
    getScoreOfIntention,
    getCurrentObjective,
    setIntention
} from "./tools_LLM.js";


// ─── Configuration ──────────────────────────────────────────────────────────
const TOKEN = process.env.TOKEN;
const HOST = process.env.HOST;
const TIME_COST_PER_TILE = process.env.TIME_COST_PER_TILE
const HEARTBEAT_DELAY_MS = 500;
const DEBUG = true;

// ─── State ──────────────────────────────────────────────────────────────────
const myBeliefs = new Beliefs();
const myDesires = new Desires(myBeliefs);
const myIntentions = new Intentions(myDesires, myBeliefs, generatePathTo);
myDesires.setLinkedIntentions(myIntentions); // create circular reference for dynamic updates
/** @type {boolean} Guard to prevent concurrent action execution */
let isExecuting = false;
/** @type {boolean} Guard to prevent concurrent core_loop */
let isCoreLoopRunning = false;
 
// ─── Storing LLM tools ──────────────────────────────────────────────────────
registerTool("calculate", calculate);
registerTool("get_current_time", get_current_time);
registerTool("get_me_info", get_me_info);
registerTool("move", move);
registerTool("getScoreOfIntention", getScoreOfIntention);
registerTool("getCurrentObjective", getCurrentObjective);
registerTool("setIntention", async (strInput) => {
    const result = await setIntention(strInput);
    if (result.startsWith("accepted")) {
        console.log(`[LLM TOOL] Intention accepted: ${strInput}`);
        return result;
    } else if (result.startsWith("rejected")) {
        console.log(`[LLM TOOL] Intention rejected: ${result}`);
        return result;
    } else {
        console.log(`[LLM TOOL] Error: ${result}`);
        return result;
    }
});
registerTool("getTiles", myBeliefs.getTiles.bind(myBeliefs));

// ─── Heartbeat ──────────────────────────────────────────────────────────────
let lastSensingTime = Date.now();

/**
 * Heartbeat mechanism: if no sensing data arrives for HEARTBEAT_DELAY_MS,
 * trigger core_loop to ensure the BDI cycle continues.
 */
function startHeartbeat() {
    setInterval(() => {
        const now = Date.now();
        if (now - lastSensingTime >= HEARTBEAT_DELAY_MS) {
            console.log('[HEARTBEAT] No sensing data received, triggering core_loop...');
            core_loop({ newParcels: [], goneParcelIds: [], newAgents: [], goneAgentIds: [] });
        }
    }, HEARTBEAT_DELAY_MS);
}

// Start heartbeat on initialization
startHeartbeat();

// ─── Connection ───────────────────────────────────────────────────────────────
const socket = DjsConnect(HOST, TOKEN);
if (!socket) {
    console.log('[ERROR] Failed to connect to server.');
    process.exit(1);
} else {
    console.log('[INIT] Connected to server.');
}

// ****************************************************************************
// Event listeners 
// ****************************************************************************

/**
 * Updates the agent's vision range from game config.
 */
socket.onConfig((config) => {
    myBeliefs.setVisionRange(config.GAME.player.observation_distance);
    console.log(`[CONFIG] Vision range: ${myBeliefs.getVisionRange()}`);
});

/**
 * Updates the agent's position and ID in beliefs.
 */
socket.on('you', (me) => {
    myBeliefs.updatePlayerPosition(me.x ?? 0, me.y ?? 0);
    if (me.id) {
        myBeliefs.setMyId(me.id);
    }
})

/** ───────────────────────────────────────────────────────────────
 * Main logic: triggered once when the map is received.
 * @param {number} height
 * @param {number} width
 * @param {Array<{ x: number, y: number, type: string }>} tiles
 */
socket.on('map', (height, width, tiles) => {
    myBeliefs.setMapWidth(width + 1); // error of map dimension
    myBeliefs.setMapHeight(height + 1);

    // Normalize tiles to have string type
    myBeliefs.setTiles(tiles.map(t => ({
        x: t.x,
        y: t.y,
        type: typeof t.type === 'number' ? t.type.toString() : t.type
    })));

    console.log(`[MAP] Tiles:`, myBeliefs.getTiles());
    console.log(`[MAP] Map received: ${myBeliefs.getMapWidth()}x${myBeliefs.getMapHeight()}`);

    // define the static data in belief
    myBeliefs.defineDeliveryPoint(myBeliefs.getTiles());
    myBeliefs.defineSpawnPoint(myBeliefs.getTiles());
});

/** ───────────────────────────────────────────────────────────────
 * Event onMsg for communicating with LLM
 */
socket.onMsg(async (id, name, msg) =>
{
    console.log("=== MESSAGE FROM DELIVEROOJS CHAT ===");
    console.log(`From: ${name} (${id})`);
    console.log(`Message: ${msg}`);

    // Appel non-bloquant au LLM (ne bloque pas onSensing ou core_loop)
    const response = await runAgentTurn(msg);
    console.log(`LLM Response: ${response}`);

    // Optionnel: Envoyer une réponse dans le chat DeliverooJS
    await socket.emitSay(id, { reply: response });
});


/** ───────────────────────────────────────────────────────────────
 * Updates visible parcels and agents from sensing data.
 * Then, uses BDI model: generate desires, convert to intentions, filter to create optimal plan.
 */
socket.onSensing(async (data) => {
    // Update last sensing time for heartbeat
    lastSensingTime = Date.now();

    // ****************** PERCEPT ***************************************
    // update of perceptions (if something has changed) 
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

    // delta {newParcels, goneParcelIds, newAgents, goneAgentIds} used for reconsidering 
    const delta = myBeliefs.updatePercepts(parcels, agents);
    if (Object.values(delta).some(arr => arr.length > 0)) {
        //console.log('Delta:', delta);
    }
    // ***************** CORE OF BDI LOOP  ********************************
    if(!isCoreLoopRunning) // prevent guard
    { 
        isCoreLoopRunning = true;
        try 
        {
            await core_loop(delta);
        }
        finally 
        {
            isCoreLoopRunning = false;
        }
    }
    
});

// ************************************************************************
// THE LOOP
// ************************************************************************

/** 
 * THE LOOP
 * @param {{
     *   newParcels: Array<{id: string, x: number, y: number, reward: number}>,
     *   goneParcelIds: Array<string>,
     *   newAgents: Array<{id: string, x: number, y: number}>,
     *   goneAgentIds: Array<string>
     * }} delta
 */
async function core_loop(delta)
{
    if (DEBUG) console.log('[CORE_LOOP] ENTER *********************** ');
    // look course n°4: BDI Loop diapo 35, agent control loop v7
    // *********** Line 5 to 9  ******************************    
    if (myIntentions.getPlan().length === 0) // ET SI ON ENLEVE CETTE CONDITON C PTETRE PLUS FACILE?
    {
        myDesires.genOption();
        if (DEBUG) console.log('[DESIRES] Generated desires:', myDesires.getDesires());
        myIntentions.desiresToIntention();
        myIntentions.filterAndSortIntention();
        if (DEBUG) console.log('[INTENTIONS] Generated intentions:', myIntentions.getFilteredIntentions());
        myIntentions.setPlan();
        if (DEBUG) console.log('[PLAN] Generated plan:', myIntentions.getPlan());
        if (DEBUG) console.log('[ImpossibleIntentions] ', myIntentions.getCurrentImpossibleIntentions());
    } else {

        if (DEBUG) console.log('[PLAN] Existing plan for \'' + myIntentions.getCurrentObjective() + '\':', myIntentions.getPlan());
        const currentIntentionBlocked = myIntentions.getCurrentImpossibleIntentions().has(myIntentions.getCurrentObjective());
        if (currentIntentionBlocked) {
            myIntentions.clearPlan();
        }
    }
    

    // *********** Line 10: positive affirmation *************
    // if plan defined AND not succeded AND not impossible
    const shouldContinue =
       myIntentions.getPlan().length > 0  // not empty(π)
    && !myIntentions.succeeded()          // not succeeded(I, B)
    && !myIntentions.impossible();        // not impossible(I, B)

    if (DEBUG) console.log('[ImpossibleIntentions] ', myIntentions.getCurrentImpossibleIntentions());

    if (shouldContinue)
    {
        // ******** Line 11+12 Execute action ****************
        // guard, for preventing launching several action in parallel 
        // (onSensing is called every server frame, but executeNextAction take much more time)
        if (!isExecuting)
        {  
            const score = myIntentions.getScoreOfIntention(myIntentions.getCurrentObjective()); // for debug and analysis, not used for decision
            if (DEBUG) console.log(`[SCORE] Score for current objective '${myIntentions.getCurrentObjective()}': ${score}`);
            if (DEBUG) console.log('[POSITION] x,y:', myBeliefs.getMyPosition())
            isExecuting = true;
            try
            {
                await myIntentions.executeNextAction();
            }
            finally
            {
                isExecuting = false;
            }
        } else {
            //console.log('[CORE_LOOP] shouldContinue, but isExecuting');
        }

        // Belief and perception always update
        // ******** Line 16 Reconsider ***********************
        if (DEBUG) console.log('[RECONSIDER] Checking if reconsideration is needed with delta:');
        if (DEBUG) console.log('Delta.newParcels:', delta.newParcels, 'Delta.goneParcelIds:', delta.goneParcelIds, 
                'Delta.newAgents:', delta.newAgents, 'Delta.goneAgentIds:', delta.goneAgentIds);

        if (myIntentions.reconsider(delta) && !myIntentions.isSmartReplanActive())
        {
            if (DEBUG) console.log('[RECONSIDER] Triggered reconsideration based on delta:', delta);
            myDesires.genOption();
            myIntentions.desiresToIntention();
            myIntentions.filterAndSortIntention();
        }

        // ******** Line 20: sound (isPlanValid) *************
        // replan if plan invalide
        if (!myIntentions.isPlanValid() && !myIntentions.isSmartReplanActive())
        {
            if (DEBUG) console.log('[REPLAN] Plan invalid or empty, replanning...');
            if (myIntentions.getFilteredIntentions().length > 0)
            {
                myIntentions.setPlan();
            }
        }
    }
    else {
        // log for debuging 
        if (myIntentions.getPlan().length === 0) {
            if (DEBUG) console.log('[ShouldNotContinue]: Plan is empty');
        }
        else if (myIntentions.succeeded()) {
            if (DEBUG) console.log('[ShouldNotContinue]: Current intention \'' 
                + myIntentions.getCurrentObjective() + '\' already succeeded');
                myIntentions.clearPlan(); // clear plan to trigger new plan generation on next loop
        }
        else if (myIntentions.impossible()) {
            if (DEBUG) console.log('[ShouldNotContinue]: Current intention \'' 
                + myIntentions.getCurrentObjective() + '\' is impossible');
                
        }
        // if blocked because plan impossible, clear the list of impossible intentions to allow new plan generation
        myIntentions.clearCurrentImpossibleIntentions();
    }
    if (DEBUG) console.log('[CORE_LOOP] EXIT *********************** ');
}

export { 
    DEBUG, 
    TIME_COST_PER_TILE,
    myBeliefs, 
    myIntentions, 
    socket, 
    registerTool 
};
