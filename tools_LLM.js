/*******************************************************************************
 * @file        tools_LLM.js
 * @author      Thomas Eyer
 * @date        2026-05-31
 * @description Tools specific to the DeliverooJS environment for LLM integration.
 * Note:        
 *******************************************************************************/

import { myBeliefs, socket } from "./agent_bdi.js";
import { myIntentions } from "./agent_bdi.js"; // Importez myIntentions

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
export function getCurrentObjective(){
    // Call methods of myIntentions
    return myIntentions.getCurrentObjective();
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
    const strCurrentObjective = myIntentions.getCurrentObjective();

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
// SPECIAL MISSION TOOLS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Parses and validates a special mission JSON string.
 * Checks required fields and type-specific parameters.
 * @param {string} strJson - Raw JSON string from LLM.
 * @returns {{valid: boolean, mission: Object|null, error: string|null}}
 * JSON structure:
 * {
 *   "id": "<short_unique_snake_case_id>",
 *   "type": "<scoring | constraint | behavior>",
 *   "description": "<human-readable summary of the rule>",
 *   "active": true,
 *   "parameters": { <type-specific fields, see below>}
 * }
 * 
 * // parameters for type "scoring"
 *       {
 *           "condition": {
 *               "tile": {"x": 3, "y": 5},       // optional: specific delivery tile
 *               "stack_size": 3                  // optional: exact number of parcels
 *           },
 *           "reward_modifier": {
 *               "multiplier": 5.0,               // multiply base reward by this
 *               "flat_bonus": 10,                // add flat points
 *               "override": 0                    // replace reward entirely (e.g. 0 pts)
 *           }
 *       }
 * 
 * // parameters for type "constraint"
 * {
 *   "tile": {"x": 4, "y": 2},
 *   "penalty": -50,                    // points lost if violated
 *   "block_navigation": true           // if true, A* avoids this tile entirely
 * }
 * 
 * // parameters for type "behavior"
 * {
 *   "rule": "avoid_tile",               // e.g. "avoid_tile", "prefer_pickup", "wait_condition"
 *   "value": {"x": 1, "y": 1}          // e.g. tile to avoid, or condition to wait for
 * }
 */
function _parseSpecialMission(strJson)
{
    let objMission;
    try
    {
        objMission = JSON.parse(strJson);
    }
    catch (e)
    {
        return { valid: false, mission: null, error: 'invalid JSON: ' + e.message };
    }

    // Required top-level fields
    const arrRequired = ['id', 'type', 'description', 'active', 'parameters'];
    for (const strField of arrRequired)
    {
        if (objMission[strField] === undefined)
        {
            return { valid: false, mission: null, error: `missing field: ${strField}` };
        }
    }

    // Valid types
    const arrValidTypes = ['scoring', 'constraint', 'behavior'];
    if (!arrValidTypes.includes(objMission.type))
    {
        return { valid: false, mission: null, error: `invalid type: ${objMission.type}` };
    }

    // Type-specific validation
    if (objMission.type === 'constraint')
    {
        if (!objMission.parameters.tile ||
            typeof objMission.parameters.tile.x !== 'number' ||
            typeof objMission.parameters.tile.y !== 'number')
        {
            return { valid: false, mission: null, error: 'constraint requires parameters.tile {x, y}' };
        }
    }

    if (objMission.type === 'scoring')
    {
        if (!objMission.parameters.reward_modifier)
        {
            return { valid: false, mission: null, error: 'scoring requires parameters.reward_modifier' };
        }
    }

    if (objMission.type === 'behavior')
    {
        if (!objMission.parameters.rule || objMission.parameters.value === undefined)
        {
            return { valid: false, mission: null, error: 'behavior requires parameters.rule and parameters.value' };
        }
    }

    return { valid: true, mission: objMission, error: null };
}

/**
 * Checks for duplicate missions against an existing list.
 * Detects both exact id duplicates and semantic duplicates by type.
 * @param {Object} objNewMission - Parsed mission object.
 * @param {Object[]} arrExisting - Array of existing mission objects.
 * @returns {"duplicate_id" | "duplicate_semantic" | null}
 */
function _checkDuplicate(objNewMission, arrExisting)
{
    for (const objExisting of arrExisting)
    {
        // Exact id match
        if (objExisting.id === objNewMission.id)
        {
            return 'duplicate_id';
        }

        // Semantic match: same type and same key parameters
        if (objExisting.type === objNewMission.type)
        {
            if (objNewMission.type === 'constraint')
            {
                const tileNew = objNewMission.parameters.tile;
                const tileOld = objExisting.parameters?.tile;
                if (tileOld && tileNew.x === tileOld.x && tileNew.y === tileOld.y)
                {
                    return 'duplicate_semantic';
                }
            }

            if (objNewMission.type === 'scoring')
            {
                const tileNew = objNewMission.parameters?.condition?.tile;
                const tileOld = objExisting.parameters?.condition?.tile;
                if (tileNew && tileOld &&
                    tileNew.x === tileOld.x && tileNew.y === tileOld.y)
                {
                    return 'duplicate_semantic';
                }
            }

            if (objNewMission.type === 'behavior')
            {
                if (objExisting.parameters?.rule === objNewMission.parameters?.rule)
                {
                    return 'duplicate_semantic';
                }
            }
        }
    }
    return null;
}

/**
 * Adds a special mission to beliefs after validation and duplicate check.
 * Automatically applies constraint missions to the navigation system.
 * @param {string} strJson - JSON string representing the special mission.
 * @returns {string|false}
 *   "stored: <id>"           — mission added successfully
 *   "duplicate_id: <id>"     — mission with same id already exists
 *   "duplicate_semantic: <description>" — semantically equivalent mission exists
 *   false                    — invalid JSON or missing fields
 */
export function checkformatAndAddSpecialMission(strJson)
{
    const { valid, mission: objMission, error: strError } = _parseSpecialMission(strJson);
    if (!valid)
    {
        console.warn(`[addSpecialMission] Validation failed: ${strError}`);
        return false;
    }

    // Duplicate check
    const arrExisting = myBeliefs.getSpecialMissions();
    const strDuplicate = _checkDuplicate(objMission, arrExisting);

    if (strDuplicate === 'duplicate_id')
    {
        return `duplicate_id: ${objMission.id}`;
    }
    if (strDuplicate === 'duplicate_semantic')
    {
        const objExisting = arrExisting.find(m =>
            m.type === objMission.type
        );
        return `duplicate_semantic: "${objExisting.description}"`;
    }

    // Store in beliefs
    myBeliefs.addSpecialMission(objMission);

    // Side effect: apply constraint immediately to navigation
    if (objMission.type === 'constraint' && objMission.parameters.block_navigation)
    {
        myBeliefs.addBlockedTile(
            objMission.parameters.tile.x,
            objMission.parameters.tile.y
        );
        console.log(`[addSpecialMission] Constraint applied: tile (${objMission.parameters.tile.x},${objMission.parameters.tile.y}) blocked`);
    }

    return `stored: ${objMission.id}`;
}

/**
 * Returns a summary of all stored special missions (active and inactive).
 * Used for explicit user queries ("what are your active missions?").
 * @returns {string|false} JSON array of {id, type, description, active} or false.
 */
export function listSpecialMissions()
{
    const arrMissions = myBeliefs.getSpecialMissions();
    if (!arrMissions || arrMissions.length === 0)
    {
        return 'no missions stored';
    }

    const arrSummary = arrMissions.map(m => (
    {
        id:          m.id,
        type:        m.type,
        description: m.description,
        active:      m.active
    }));

    return JSON.stringify(arrSummary);
}