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