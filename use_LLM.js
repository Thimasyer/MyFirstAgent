/*******************************************************************************
 * @file        use_LLM.js
 * @author      Thomas Eyer
 * @date        2026-05-29
 * @description Centralized LLM interaction library for DeliverooJS agent.
 *              Handles prompting, tool execution, and response parsing.
 * Note:           
 *******************************************************************************/

import OpenAI from "openai";
import dotenv from "dotenv/config";

 // ==========================================
 // 1. Configuration LiteLLM/OpenAI
 // ==========================================

const baseURL = process.env.LITELLM_BASE_URL || "https://llm.bears.disi.unitn.it/v1";
const apiKey = process.env.LITELLM_API_KEY;
const MODEL = process.env.LOCAL_MODEL || "llama-3.3-70b-lmstudio";

if (!apiKey)
{
    console.error("Error: missing LITELLM_API_KEY in .env file");
    process.exit(1);
}

const client = new OpenAI(
{
    baseURL,
    apiKey,
});

 // ==========================================
 // 2. Tool Registry
 // use registerTool in tools_LLM.js for more modularity
 // ==========================================

/**
 * @type {Object.<string, function>}
 * @description Registry of available tools for the LLM.
 */
const TOOLS = {};

/**
 * Register a tool in the LLM's tool registry.
 * @param {string} strName - Name of the tool.
 * @param {function} funcTool - Function implementing the tool.
 */
function registerTool(strName, funcTool)
{
    TOOLS[strName] = funcTool;
}

 // ==========================================
 // 3. Reusable LLM Call
 // ==========================================

/**
 * Call the LLM with a list of messages.
 * @param {Array<{role: string, content: string}>} arrMessages - Conversation history.
 * @param {Object} [options] - Options for the LLM call.
 * @param {number} [options.temperature=0] - Temperature for the LLM.
 * @returns {Promise<string>} - LLM's response.
 */
async function callModel(arrMessages, { temperature = 0 } = {})
{
    const response = await client.chat.completions.create(
    {
        model: MODEL,
        messages: arrMessages,
        temperature,
    });

    return response.choices?.[0]?.message?.content ?? "";
}

 // ==========================================
 // 4. Output Parsing
 // ==========================================

/**
 * Extract an action and its input from the LLM's response.
 * @param {string} strText - LLM's response.
 * @returns {Object|null} - { action: string, actionInput: string } or null.
 */
function extractAction(strText)
{
    const actionMatch = strText.match(/^Action:\s*(.+)$/im);
    const actionInputMatch = strText.match(/^Action Input:\s*(.+)$/im);

    if (!actionMatch || !actionInputMatch)
    {
        return null;
    }

    return {
        action: actionMatch[1].trim(),
        actionInput: actionInputMatch[1].trim(),
    };
}

/**
 * Extract a final answer from the LLM's response.
 * @param {string} strText - LLM's response.
 * @returns {string|null} - Final answer or null.
 */
function extractFinalAnswer(strText)
{
    const match = strText.match(/^Final Answer:\s*([\s\S]*)$/im);
    return match ? match[1].trim() : null;
}

 // ==========================================
 // 5. Agent Prompt
 // ==========================================

const AGENT_PROMPT = `
You are an AI agent connected to a DeliverooJS environment.
You receive natural language requests from the user and must handle them correctly.

════════════════════════════════════════════
AVAILABLE TOOLS
════════════════════════════════════════════

Navigation & state:
- get_me_info()                      : returns agent id, name, x, y, score
- getMyPosition()                    : returns current x, y coordinates
- move(direction)                    : moves one step: up | down | left | right
- getTiles()                         : returns all tiles [{x, y, type}]
                                       types: "0"=wall "1"=spawn "2"=delivery "3"=walkable


Action:
- calculate(expression)              : evaluates a math expression, e.g. "4*2"
- get_current_time(location)         : returns local time for a given city
- setIntention(input_string):
  - Sets the agent's current BDI intention if the new intention has a higher score.
  - input_string: Must be in format "<intention_string>|<nbrNewScore>".
    Example: "goto_4_7|50" or "pickup_2_5|100".
    If nbrNewScore is omitted (e.g., "goto_4_7"), defaults to 100.
  - Valid intention formats: goto_X_Y | pickup_X_Y | deliver_X_Y | explore_X_Y | wait_condition.
  - Returns: "accepted" or "rejected: <reason>" or "Error: <reason>".

Special missions:
- checkformatAndAddSpecialMission(json_string)     : validates and stores a persistent rule in the agent's beliefs
                                       returns "stored: <id>" or "error: <reason>"
- listSpecialMissions()              : lists active missions [{id, type, description, active}]

════════════════════════════════════════════
CLASSIFICATION — read this before responding
════════════════════════════════════════════

Step 1: classify the request as EXECUTABLE or SPECIAL MISSION.

EXECUTABLE — a one-time action that ends when completed:
  - moving to a position
  - picking up or delivering a specific parcel
  - any action described as a single event
  Keywords that suggest executable: "go to", "move to", "pick up", "drop"

SPECIAL MISSION — a persistent rule that applies to future actions:
  - a rule about scoring, navigation, or behavior that applies repeatedly
  - any rule that modifies how the agent acts from now on
  Keywords that suggest special mission:
  "every time", "always", "never", "each time", "from now on",
  "whenever", "do not", "avoid", "double", "exactly N"

If unsure, prefer SPECIAL MISSION for rules and EXECUTABLE for single actions.

════════════════════════════════════════════
OUTPUT FORMATS — use exactly one per message
════════════════════════════════════════════

FORMAT 1 — executable request, use one tool:

Thought: <brief reasoning>
Action: <tool name>
Action Input: <tool input>

FORMAT 2 — final answer (no more tools needed):

Thought: I have enough information to answer.
Final Answer: <clear answer for the user>

FORMAT 3 — special mission (persistent rule):

Thought: <reasoning explaining why this is a persistent rule>
Special Mission:
{
  "id": "<short_unique_snake_case_id>",
  "type": "<scoring | constraint | behavior>",
  "description": "<human-readable summary>",
  "active": true,
  "parameters": <type-specific object, see rules below>
}

════════════════════════════════════════════
PARAMETERS STRUCTURE FOR FORMAT 3
════════════════════════════════════════════

type "scoring" — modifies points received on delivery:
{
  "condition": {
    "tile": {"x": <number>, "y": <number>},   // optional: specific delivery tile
    "stack_size": <number>                     // optional: exact parcel count required
  },
  "reward_modifier": {
    "multiplier": <number>,                    // multiply base reward (e.g. 2.0 = double)
    "flat_bonus": <number>,                    // add flat points (e.g. 10)
    "override": <number>                       // replace reward entirely (e.g. 0)
  }
}

type "constraint" — restricts navigation through a tile:
{
  "tile": {"x": <number>, "y": <number>},
  "penalty": <negative number>,               // points lost if violated (e.g. -50)
  "block_navigation": <boolean>               // if true, A* avoids this tile entirely
}

type "behavior" — modifies agent strategy:
{
  "rule": "<behavior_identifier>",            // e.g. "deliver_stack_size"
  "value": <number>,                          // associated value (e.g. 3)
  "reward_modifier": {                        // optional
    "multiplier": <number>
  }
}

════════════════════════════════════════════
STRICT RULES
════════════════════════════════════════════

General:
- Output exactly one format per message, never mix formats.
- Never output Action and Final Answer in the same message.
- Never write Action: None.
- Do not invent tool results, positions, tile data, or scores.
- Do not calculate arithmetic yourself — always call calculate().
- Do not invent the current time — always call get_current_time().
- Do not invent agent position — always call getMyPosition() or get_me_info().
- Do not invent tile information — always call getTiles() for tile data.

For EXECUTABLE requests:
- To set an intention, call setIntention with a single string in format "<intention_string>|<nbrNewScore>".
  Example: "goto_4_7|50" or "pickup_2_5".
- If the user mentions a score (e.g., "for 10 points"), include it in the input string (e.g., "goto_4_7|10").
- If the user does NOT mention a score, omit it (e.g., "goto_4_7"). The default score (100) will be used.
- If coordinates involve math (e.g. "x=4*2"), call calculate() first, then setIntention().
- If the request mentions a tile type (e.g. "leftmost delivery tile"), call getTiles() first.
- To move the agent, call setIntention() with goto_X_Y and the nbrNewScore given in the requests- do not call move() directly
  unless the request is conversational (e.g. "move one step up").
- After setIntention(), give a Final Answer confirming the result.

For SPECIAL MISSION requests:
- If a similar mission already exists, report it in Final Answer instead of adding a duplicate.
- If no duplicate, output Format 3 to structure the mission.
- After Format 3, call checkformatAndAddSpecialMission() with the JSON as a single-line string.
- After checkformatAndAddSpecialMission() returns a success message, give a Final Answer confirming storage.
- If checkformatAndAddSpecialMission() returns an error, correct the JSON and retry once.

Movement rules (for move() only):
- move(up)    increases y by 1
- move(down)  decreases y by 1
- move(right) increases x by 1
- move(left)  decreases x by 1
- move() moves only one step at a time.

════════════════════════════════════════════
EXAMPLES
════════════════════════════════════════════
---
User: "Go to (4,7)"
→ EXECUTABLE
Thought: No score mentioned, use default.
Action: setIntention
Action Input: goto_4_7

---
User: "Go to (4,7) for 10 points"
→ EXECUTABLE
Thought: Score mentioned (10), include it in the input.
Action: setIntention
Action Input: goto_4_7|10

---
User: "Pick up the parcel at (2,5) to get 50 points"
→ EXECUTABLE
Thought: Score mentioned (50), include it in the input.
Action: setIntention
Action Input: pickup_2_5|50

---
User: "Deliver at (1,3)"
→ EXECUTABLE
Thought: No score mentioned, use default.
Action: setIntention
Action Input: deliver_1_3

---
User: "Move to x=4*2 y=(1+3)*3"
→ EXECUTABLE, requires calculate() first
Thought: Coordinates involve math, I must resolve them before calling setIntention.
Action: calculate
Action Input: 4*2
[Observation: 8]
Action: calculate
Action Input: (1+3)*3
[Observation: 12]
Action: setIntention
Action Input: goto_8_12

---

User: "Drop a package in the leftmost delivery tile"
→ EXECUTABLE, requires getTiles() first
Thought: I need to find the leftmost delivery tile (type "2").
Action: getTiles
Action Input:
[Observation: [{x:1,y:2,type:"2"},{x:5,y:3,type:"2"},...]]
Thought: Leftmost delivery tile is x=1,y=2.
Action: setIntention
Action Input: deliver_1_2

---

User: "Every time you deliver in (3,5) you get 5x pts"
→ SPECIAL MISSION
Thought: Recurring scoring rule on a specific tile, persistent.
Action: listSpecialMissions
Action Input:
[Observation: []]
Thought: No duplicate found. Structuring the mission.
Special Mission:
{
  "id": "bonus_tile_3_5",
  "type": "scoring",
  "description": "Delivering at (3,5) gives 5x points",
  "active": true,
  "parameters": {
    "condition": { "tile": {"x": 3, "y": 5} },
    "reward_modifier": { "multiplier": 5.0 }
  }
}
Action: addSpecialMission
Action Input: {"id":"bonus_tile_3_5","type":"scoring","description":"Delivering at (3,5) gives 5x points","active":true,"parameters":{"condition":{"tile":{"x":3,"y":5}},"reward_modifier":{"multiplier":5.0}}}
[Observation: stored: bonus_tile_3_5]
Thought: I have enough information to answer.
Final Answer: Mission stored. From now on, delivering at (3,5) will give 5x points.

---

User: "Do not go through tile (2,3) otherwise you lose 50 pts"
→ SPECIAL MISSION
Thought: Persistent navigation constraint with penalty.
Action: listSpecialMissions
Action Input:
[Observation: []]
Special Mission:
{
  "id": "avoid_tile_2_3",
  "type": "constraint",
  "description": "Avoid tile (2,3), -50 pts penalty if violated",
  "active": true,
  "parameters": {
    "tile": {"x": 2, "y": 3},
    "penalty": -50,
    "block_navigation": true
  }
}
Action: addSpecialMission
Action Input: {"id":"avoid_tile_2_3","type":"constraint","description":"Avoid tile (2,3), -50 pts penalty if violated","active":true,"parameters":{"tile":{"x":2,"y":3},"penalty":-50,"block_navigation":true}}
[Observation: stored: avoid_tile_2_3]
Thought: I have enough information to answer.
Final Answer: Constraint stored. Tile (2,3) will now be avoided during navigation.
`.trim();

 // ==========================================
 // 6. Conversation Memory
 // ==========================================

const messages = [
{
    role: "system",
    content: AGENT_PROMPT,
}];

 // ==========================================
 // 7. Agent Turn Logic
 // ==========================================

/**
 * Execute one turn of the LLM agent.
 * @param {string} strUserInput - User's request.
 * @param {number} [nbrMaxIterations=12] - Maximum iterations for the LLM loop.
 * @returns {Promise<string>} - Final answer or fallback.
 */
async function runAgentTurn(strUserInput, nbrMaxIterations = 12)
{
    const turnMessages = [
    {
        role: "user",
        content: strUserInput,
    }];

    for (let i = 0; i < nbrMaxIterations; i++)
    {
        const assistantMessage = await callModel(
        [
            ...messages,
            ...turnMessages,
        ],
        { temperature: 0 });

        console.log(`Assistant: ${assistantMessage}\n`);
        const parsedAction = extractAction(assistantMessage);

        if (parsedAction)
        {
            const { action, actionInput } = parsedAction;
            let strObservation;

            if (TOOLS[action])
            {
                console.log(`[System executing tool: ${action}("${actionInput}")]`);
                strObservation = await TOOLS[action](actionInput);
            }
            else
            {
                strObservation = `Error: unknown tool '${action}'. Available tools: ${Object.keys(TOOLS).join(", ")}`;
            }
            console.log(`[Observation: ${strObservation}]\n`);
            turnMessages.push(
            {
                role: "assistant",
                content: assistantMessage,
            });

            turnMessages.push(
            {
                role: "user",
                content: `Observation: ${strObservation}`,
            });

            continue;
        }

        const finalAnswer = extractFinalAnswer(assistantMessage);
        if (finalAnswer)
        {
            console.log(`Assistant: ${finalAnswer}\n`);
            messages.push(
            {
                role: "user",
                content: strUserInput,
            });

            messages.push(
            {
                role: "assistant",
                content: finalAnswer,
            });

            return finalAnswer;
        }

        const observation = "Error: invalid format. You must output either one Action or one Final Answer.";
        console.log(`[Observation: ${observation}]\n`);
        turnMessages.push(
        {
            role: "user",
            content: `Observation: ${observation}`,
        });
    }

    const fallbackAnswer = "I could not complete the request within the maximum number of iterations.";
    console.log(`Assistant: ${fallbackAnswer}\n`);
    messages.push(
    {
        role: "user",
        content: strUserInput,
    });

    messages.push(
    {
        role: "assistant",
        content: fallbackAnswer,
    });

    return fallbackAnswer;
}

 // ==========================================
 // 8. Exports
 // ==========================================

export
{
    registerTool,
    runAgentTurn,
    TOOLS,
    callModel,
    extractAction,
    extractFinalAnswer,
};


