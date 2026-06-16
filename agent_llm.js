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
// TODO 2:    - Rajouter les crate (boite jaune) à la logique
//            2. Tenir compte des specialMission dans la stratégie de l'agent_bdi
//            3. Ajouter le traitement des intentions type "wait_condition"
//
//
// TODO 3:    Where do we have to updateProbabilityMap()? 
//                 not in onSensing, take to long
/*******************************************************************************/
import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import { Beliefs } from './beliefs.js';
import { Desires } from './desires.js';
import { Intentions } from './intentions.js';
import { generatePathTo, setBeliefs } from "./pathfinding.js";
import { registerTool, runAgentTurn } from "./use_LLM.js";
import { calculate, 
    get_current_time, 
    get_me_info, move, 
    getScoreOfIntention,
    getCurrentIntention,
    setIntention,
    getTiles,
    //checkformatAndAddSpecialMission,
} from "./tools_LLM.js";


// ─── Configuration ──────────────────────────────────────────────────────────
const TOKEN = process.env.TOKEN;
const HOST = process.env.HOST;
const TIME_COST_PER_TILE = process.env.TIME_COST_PER_TILE;
const TIME_COST_PER_DELIVERY_TILE = process.env.TIME_COST_PER_DELIVERY_TILE;
const HEARTBEAT_DELAY_MS = 500;
const DEBUG = false;

// ─── State ──────────────────────────────────────────────────────────────────
const myBeliefs = new Beliefs();
setBeliefs(myBeliefs);
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
registerTool("getCurrentObjective", getCurrentIntention);
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
registerTool("getTiles", getTiles);
registerTool("checkformatAndAddSpecialMission", async (strJSON) =>
    {
        // Appel de la fonction de validation et d'ajout
        const result = await checkformatAndAddSpecialMission(strJSON);

        // Vérification du résultat et affichage des missions stockées
        if (result === false)
        {
            console.error("[checkformatAndAddSpecialMission] Invalid mission format.");
            return "Error: Invalid mission format. Check JSON structure and required fields.";
        }
        else if (result.startsWith("duplicate_id:"))
        {
            const strMissionId = result.split(":")[1];
            console.warn(`[checkformatAndAddSpecialMission] Duplicate mission ID: ${strMissionId}`);
            return `Warning: Mission with ID "${strMissionId}" already exists.`;
        }
        else if (result.startsWith("duplicate_semantic:"))
        {
            const strDescription = result.split(":")[1].replace(/"/g, "");
            console.warn(`[checkformatAndAddSpecialMission] Duplicate semantic mission: ${strDescription}`);
            return `Warning: A similar mission already exists: "${strDescription}".`;
        }
        else if (result.startsWith("stored:"))
        {
            const strMissionId = result.split(":")[1];
            console.log(`[checkformatAndAddSpecialMission] Mission stored: ${strMissionId}`);

            // Affichage des missions stockées dans les beliefs
            const arrSpecialMissions = myBeliefs.getSpecialMissions();
            console.log("[Special Missions in Beliefs]:", JSON.stringify(arrSpecialMissions, null, 2));

            return `Success: Mission "${strMissionId}" stored. Waiting for confirmation to apply changes.`;
        }
        else
        {
            console.error(`[checkformatAndAddSpecialMission] Unexpected result: ${result}`);
            return `Error: Unexpected result from mission validation.`;
        }
    }
);

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
            core_loop();
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
   // myBeliefs.defineCratesPosition(myBeliefs.getTiles());
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

    console.log('-- Crates --', data.crates);
    // used later for reconsider()
    myBeliefs.updatePercepts(parcels, agents);

    // ***************** CORE OF BDI LOOP  ********************************
    if(!isCoreLoopRunning) // prevent guard
    { 
        isCoreLoopRunning = true;
        try 
        {
            await core_loop();
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
 */
async function core_loop()
{
    if (DEBUG) console.log("[IfBlock1] Special Mission: ", myBeliefs.getSpecialMissions());
    if (1) console.log('[IfBlock1] Crates Position: ', myBeliefs.cratesPosition)
    // look course n°4: BDI Loop diapo 35, agent control loop v7
    // *********** Line 5 to 9  ******************************    
    if (myIntentions.getPlan().length === 0) // ET SI ON ENLEVE CETTE CONDITON C PTETRE PLUS FACILE?
    {
        if (DEBUG) console.log(' [IfBlock1] Generated desires:', myDesires.getDesires());
        myDesires.genOption();
        myIntentions.desiresToIntention();
        myIntentions.filterAndSortIntention();
        if (1) console.log('[IfBlock1] Filtered intentions:', myIntentions.getFilteredIntentions());
        myIntentions.setPlan();
        if (DEBUG) console.log('[IfBlock1] Generated plan:', myIntentions.getPlan());
        if (DEBUG) console.log('[IfBlock1] ImpossibleIntentions: ', myIntentions.getCurrentImpossibleIntentions());
    } 
    else {

        if (1) console.log('[ElseBlock1] Existing plan for \'' + myIntentions.getCurrentIntention() + '\':', myIntentions.getPlan());
        const currentIntentionBlocked = myIntentions.getCurrentImpossibleIntentions().has(myIntentions.getCurrentIntention());
        if (currentIntentionBlocked) {
            console.log('[ElseBlock1] ERROR: All intentions blocked, cleaning plan...')
            myIntentions.clearPlan();
            myIntentions.clearCurrentImpossibleIntentions();
        }
    }
    

    // *********** Line 10: positive affirmation *************
    // if plan defined AND not succeded AND not impossible
    const shouldContinue =
       myIntentions.getPlan().length > 0  // not empty(π)
    && !myIntentions.succeeded()          // not succeeded(I, B)
    && !myIntentions.impossible();        // not impossible(I, B)

    if (shouldContinue)
    {
        const score = myIntentions.getScoreOfIntention(myIntentions.getCurrentIntention()); // for debug and analysis, not used for decision
        if (1) console.log(`[IfBlock2] Score for current objective '${myIntentions.getCurrentIntention()}': ${score}`);
        
        // ******** Line 11+12 Execute action ****************
        // guard, for preventing launching several action in parallel 
        // (onSensing is called every server frame, but executeNextAction take much more time)
        if (!isExecuting)
        {  
            isExecuting = true;
            try
            {
                const moved = await myIntentions.executeNextAction();
            }
            finally
            {
                isExecuting = false;
            }
        } else {
            console.log('   [ElseBlock2.1] ShouldContinue, but isExecuting');
        }

        // Belief and perception always update
        // ******** Line 16 Reconsider ***********************
        if (1) console.log('[IfBlock3] Trigger reconsideration based on delta: nAgent, nParcels, goneAgents, goneParcles',
             myBeliefs.newAgents, myBeliefs.newParcels, myBeliefs.goneAgentsIds, myBeliefs.goneParcelsIDs);
        let planInvalidAfterReconsider = 0;
        if (myIntentions.reconsider())
        {
            myDesires.genOption();
            if (1) console.log('   [IfBlock3.1] Desires:', myDesires.getDesires());
            myIntentions.desiresToIntention();
            myIntentions.filterAndSortIntention();
            if (1) console.log('   [IfBlock3.1] Filtered and sorted intention:', myIntentions.getFilteredIntentions());
            planInvalidAfterReconsider = 1
        }

        // ******** Line 20: sound (isPlanValid) *************
        // replan if plan invalide
        if (!myIntentions.isPlanValid() || planInvalidAfterReconsider)
        {
            if (1) console.log('[IfBlock4] Plan invalid, replanning...');
            if (myIntentions.getFilteredIntentions().length > 0)
            {
                if (1) console.log('   [IfBlock4.1] SetPlan');
                myIntentions.clearPlan();
                myIntentions.setPlan();
            }
        }
    }
    else {
        // log for debuging 
        if (myIntentions.getPlan().length === 0) {
            if (DEBUG) console.log('[EsleBlock2]: Plan is empty');
        }
        else if (myIntentions.succeeded()) {
            if (1) console.log('[ElseBlock2] Current intention \'' 
                + myIntentions.getCurrentIntention() + '\' already succeeded');
            if (myIntentions.getCurrentIntention().startsWith('explore')) {
                myIntentions.shiftIntention();
                myIntentions.setPlan();
            } else {
                myIntentions.clearPlan();
            }
        }
        else if (myIntentions.impossible()) {
            if (DEBUG) console.log('[ElseBlock2]: Current intention \'' 
                + myIntentions.getCurrentIntention() + '\' is impossible');
                myIntentions.clearPlan();
                // if blocked because plan impossible, clear the list of impossible intentions to allow new plan generation
                myIntentions.setCurrentImpossibleIntentions(myIntentions.getCurrentIntention());
                
        }
    }
}

export { 
    DEBUG, 
    TIME_COST_PER_TILE,
    TIME_COST_PER_DELIVERY_TILE,
    myBeliefs, 
    myIntentions, 
    socket, 
    registerTool 
};
