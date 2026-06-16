/*******************************************************************************
 * @file        tools_LLM.js
 * @author      Thomas Eyer
 * @date        2026-05-31
 * @description Tools specific to the DeliverooJS environment for LLM integration.
 * Note:        
 *******************************************************************************/

import { myBeliefs, socket, myIntentions } from "./agent_bdi.js";
import { Intentions } from './intentions.js';

/**
 * Evaluates a mathematical expression.
 * @param {string} strExpression - Mathematical expression to evaluate.
 * @returns {string} Result of the evaluation or error message.
 */
export function calculate(strExpression)
{
    try
    {
        return String(eval(strExpression));
    }
    catch (error)
    {
        return `Error: ${error.message}`;
    }
}

/**
 * Returns the current local time for a supported location.
 * @param {string} strLocation - Location (e.g., "Rome" or "Roma").
 * @returns {string} Formatted date and time or error message.
 */
export function get_current_time(strLocation)
{
    try
    {
        const normalized = strLocation.trim().toLowerCase();
        const supportedLocations =
        {
            rome: { city: "Rome", timeZone: "Europe/Rome" },
            roma: { city: "Rome", timeZone: "Europe/Rome" },
        };

        const config = supportedLocations[normalized];

        if (!config)
        {
            return "Error: Current time is only supported for Rome/Roma in this demo.";
        }

        const now = new Date();
        const formatter = new Intl.DateTimeFormat("en-GB",
        {
            timeZone: config.timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        });

        const parts = formatter.formatToParts(now);
        const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));

        const formattedDate = `${map.year}-${map.month}-${map.day}`;
        const formattedTime = `${map.hour}:${map.minute}:${map.second}`;

        return `The current local time in ${config.city} is ${formattedDate} ${formattedTime} (${config.timeZone}).`;
    }
    catch (error)
    {
        return `Error: ${error.message}`;
    }
}

/**
 * Returns the agent's information (id, name, position, score).
 * @returns {string} JSON string with agent info or error message.
 */
export function get_me_info()
{
    const pos = myBeliefs.getMyPosition();
    if (!pos)
    {
        return "Error: agent position is not available yet.";
    }

    return JSON.stringify(
    {
        id: myBeliefs.getMyId(),
        name: myBeliefs.getMyName(),
        x: myBeliefs.getMyPosition().x,
        y: myBeliefs.getMyPosition().y,
        score: myBeliefs.getMyScore(),
    });
}

/**
 * Moves the agent in a specified direction.
 * @param {string} strDirection - Direction to move (up, down, left, right).
 * @returns {Promise<string>} Result of the move or error message.
 */
export async function move(strDirection)
{
    const normalized = strDirection.trim().toLowerCase();
    const validDirections = ["up", "down", "left", "right"];

    if (!validDirections.includes(normalized))
    {
        return `Error: invalid direction '${strDirection}'. Valid directions are: up, down, left, right.`;
    }

    try
    {
        const result = await socket.emitMove(normalized);
        if (result)
        {
            return `Successfully moved ${normalized}. New position: ${JSON.stringify(result)}.`;
        }
        return `Error: failed to move ${normalized}.`;
    }
    catch (error)
    {
        return `Error: moving ${normalized} failed: ${error.message}`;
    }
}

/**
 * Returns the score of a given intention.
 * @param {string} strIntention - The intention to evaluate (e.g., "pickup_5_10").
 * @returns {number|null} Score of the intention.
 */
export function getScoreOfIntention(strIntention) {
    // Call methods of myIntentions
    return myIntentions.getScoreOfIntention(strIntention);
}

/** @returns {string} */
export function getCurrentIntention(){
    // Call methods of myIntentions
    return myIntentions.getCurrentIntention();
}


/**
 * Sets the agent's current BDI intention if the new intention has a higher score.
 * Accepts a single string argument in the format: "<intention_string>|<nbrNewScore>".
 * If nbrNewScore is omitted, defaults to 100.
 *
 * Valid intention formats:
 * - goto_X_Y
 * - pickup_X_Y
 * - deliver_X_Y
 * - explore_X_Y
 * - wait_condition
 *
 * @param {string} strInput - Input string in format "<intention_string>|<nbrNewScore>".
 * @returns {string} "accepted" | "rejected: <reason>" | "Error: <reason>"
 */
export function setIntention(strInput)
{
    // Parse input to extract intention and score
    let strIntention, nbrNewScore;
    if (typeof strInput === "string" && strInput.includes("|"))
    {
        const arrParts = strInput.split("|");
        strIntention = arrParts[0].trim();
        nbrNewScore = parseInt(arrParts[1].trim(), 10);

        // Validate nbrNewScore
        if (isNaN(nbrNewScore))
        {
            return `Error: invalid nbrNewScore '${arrParts[1]}'. Must be a number.`;
        }
    }
    else
    {
        // If no "|" is provided, assume the entire input is the intention and use default score
        strIntention = strInput;
        nbrNewScore = 100; // Default score
    }

    // Validate intention format
    const regexValid = /^(goto|pickup|deliver|explore)_(\d+)_(\d+)$|^wait_.+$/;
    if (!regexValid.test(strIntention))
    {
        return `Error: invalid intention format '${strIntention}'. Valid formats: goto_X_Y | pickup_X_Y | deliver_X_Y | explore_X_Y | wait_condition`;
    }

    // Get current intention and score
    const strCurrentObjective = myIntentions.getCurrentIntention();

    // No current intention: always accept
    if (!strCurrentObjective)
    {
        console.log(`[SET INTENTION] No current intention. Accepting '${strIntention}' with score ${nbrNewScore}.`);
        myIntentions.setIntentionInFrontAndPlan(strIntention);
        return "accepted";
    }

    // Compare scores
    const nbrCurrentScore = myIntentions.getScoreOfIntention(strCurrentObjective);
    if (nbrCurrentScore === null)
    {
        return "rejected: no score for current intention";
    }

    if (nbrNewScore > nbrCurrentScore)
    {
        console.log(`[SET INTENTION] New score (${nbrNewScore}) > current score (${nbrCurrentScore}). Accepting '${strIntention}'.`);
        myIntentions.setIntentionInFrontAndPlan(strIntention);
        return "accepted";
    }
    else
    {
        return `rejected: current intention has higher score (${nbrCurrentScore} > ${nbrNewScore})`;
    }
}


/**
 * Returns all known tiles from beliefs.
 * Used by the LLM to identify target tiles (e.g. leftmost delivery tile).
 * @returns {string|false} JSON array of {x, y, type} or false if no tiles.
 */
export function getTiles()
{
    const arrTiles = myBeliefs.getTiles();
    if (!arrTiles || arrTiles.length === 0)
    {
        return false;
    }

    return JSON.stringify(arrTiles);
}



// ══════════════════════════════════════════════════════════════════════════════
// TOOLS for special Mission
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Returns current map tiles and all visible entities from beliefs.
 * Used by LLM to generate plans and identify target tiles.
 * @returns {string|false} JSON string with tiles, parcels, agents, position.
 */
export function getBeliefs()
{
    const arrTiles = myBeliefs.getTiles();
    if (!arrTiles || arrTiles.length === 0)
    {
        return false;
    }

    return JSON.stringify(
    {
        position: myBeliefs.getMyPosition(),
        tiles:    arrTiles,
        parcels:  myBeliefs.getVisibleParcels(),
        agents:   myBeliefs.getVisibleAgents()
    });
}

/**
 * Returns the list of stored special missions as plain strings.
 * Used by LLM before generating a plan, to apply all active rules.
 * @returns {string} JSON array of mission strings, or "no missions stored".
 */
export function getSpecialMissions()
{
    const arrMissions = myBeliefs.getSpecialMissions();
    if (!arrMissions || arrMissions.length === 0)
    {
        return 'no missions stored';
    }
    return JSON.stringify(arrMissions);
}

/**
 * Stores a new special mission as a plain string in beliefs,
 * only if its implicit priority is not lower than the current intention score.
 * Duplicate check is performed by simple string comparison.
 * @param {string} strMission - Plain English description of the rule.
 * @returns {string|false}
 *   "stored"                                    — mission added
 *   "rejected: current intention has higher score" — not stored
 *   false                                        — empty or invalid input
 */
export function addSpecialMission(strMission)
{
    if (!strMission || typeof strMission !== 'string' || strMission.trim() === '')
    {
        return false;
    }

    const strTrimmed = strMission.trim();

    // Duplicate check: exact string match
    const arrExisting = myBeliefs.getSpecialMissions();
    if (arrExisting.includes(strTrimmed))
    {
        return 'rejected: identical mission already stored';
    }

    // Score check: only store if no current intention, or mission is relevant
    // Special missions are persistent rules — they are stored unless
    // the current BDI intention is clearly more urgent (score > 0).
    const strCurrentObjective = myIntentions.getCurrentIntention();
    if (strCurrentObjective)
    {
        const nbrCurrentScore = myIntentions.getScoreOfIntention(strCurrentObjective) ?? 0;
        // Special missions are long-term: only block storage if score is strongly positive
        if (nbrCurrentScore > 100)
        {
            return 'rejected: current intention has higher score';
        }
    }

    myBeliefs.addSpecialMission(strTrimmed);
    console.log(`[addSpecialMission] Stored: "${strTrimmed}"`);
    return 'stored';
}

/** @param  {Array<string>} plan */
export async function setPlanByLLM( plan ) {
    const intention = new Intentions(null, null, null);    
    intention.setForcePlan(plan);
    let isExecuting = false;
    let cnt = 0;
    while (intention.getPlan().length != 0)
    {  
        isExecuting = true;
        try
        {
            const moved = await intention.executeNextAction();
            console.log('Plan: ', intention.getPlan());
            cnt++;
        }
        finally
        {
            isExecuting = false;
        }
    }    
    // return the first n action of plan that were executed
    /** @type {String} */
    let str='';
    for (let i = 0; i<cnt; i++) {
        str += plan[i];
    } 
    if (cnt === plan.length) { 
        return 'Success: plan executed';
    }
    else {
        return 'echec' + str;
    }
}