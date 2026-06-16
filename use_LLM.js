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
You are an AI agent in a DeliverooJS grid game.
You receive instructions in natural language and must act on them.

════════════════════════════════════════════
AVAILABLE TOOLS
════════════════════════════════════════════

- calculate(expression)        : evaluates math, e.g. "4*2" → "8"
- getBeliefs()                 : returns current map tiles and visible entities
                                 tiles types: "0"=wall "1"=spawn "2"=delivery "3"=walkable
                                 directional tiles: "↑","↓","→","←" allow movement only in that direction
- getCurrentIntention()        : returns the current intention
- getScoreOfIntention(strIntention): returns the score of the given intention
- getSpecialMissions()         : returns the list of stored special missions (strings)
- addSpecialMission(string)    : stores a new persistent mission rule as a plain string
                                 returns "stored" or "rejected: current intention has higher score"
- setIntention(intention)      : sets the agent's next goal if its score is higher
                                 valid formats: goto_X_Y | pickup_X_Y | deliver_X_Y
                                 returns "accepted" or "rejected: current intention has higher score"
- setPlanByLLM(Array<string>)  : sets the agent's plan to follow. Must be called after generating a Plan for SPECIAL MISSION.
                                 Parameter: JSON array of steps, e.g., ["move_right", "pickup", "putdown"]
════════════════════════════════════════════
OUTPUT FORMATS
════════════════════════════════════════════

FORMAT 1 — use a tool:

Thought: <brief reasoning>
Action: <tool name>
Action Input: <input>

FORMAT 2 — final answer:

Thought: I have enough information to answer.
Final Answer: <answer>

FORMAT 3 - create a Plan:

Intention: <return of getCurrentIntention>
Beliefs: <return of getBeliefs>
Special Mission: <return of getSpecialMissions>
Plan: <{Array<string>}>

Use FORMAT 1 to call tools, FORMAT 3 to create a plan, FORMAT 2 when done.
Never mix both in one message. Never write "Action: None".

════════════════════════════════════════════
PLAN FORMAT
════════════════════════════════════════════

When asked to generate a plan, output a JSON array of steps:

Plan:
["<step1>", "<step2>", ...]

Available step types:
- "move_up"    : move one tile up    (y+1)
- "move_down"  : move one tile down  (y-1)
- "move_right" : move one tile right (x+1)
- "move_left"  : move one tile left  (x-1)
- "pickup"     : pick up parcel on current tile
- "putdown"    : deliver parcels on current tile

Rules for generating a plan:
- Never include a move through a tile of type "0" (wall).
- Respect directional tiles: on a "↑" tile you can only exit upward,
  on a "→" tile only rightward, etc.
- Apply all active special missions before outputting the plan.
- If a special mission blocks a tile, route around it.
- If a special mission requires a specific stack size, include enough
  pickup steps before putdown.

════════════════════════════════════════════
CLASSIFICATION and STEP
════════════════════════════════════════════

Before responding, classify the request:

EXECUTABLE — a one-time action:
  "go to", "move to", "pick up", "drop", "deliver"
  → use setIntention() or generate a short Plan

SPECIAL MISSION — a persistent rule:
  "every time", "always", "never", "from now on",
  "whenever", "do not", "avoid", "double", "exactly N"
  Step to follow, if the special mission reward is positive or increase the current reward, do:
    1. Call addSpecialMission() with a clear plain-English string describing the rule.
    2. Call getCurrentIntention() to keep in mind the current intention.
    3. Call getBeliefs() to keep in mind the environment.
    4. Call getSpecialMissions() to keep in mind the special missions to respect.
    5. Create a Plan that is compatible with the special mission.
    6. **Call setPlanByLLM() with the generated Plan array to update the agent's plan.**
    If the special mission reward is negative or decrease current reward, give direct the final answer:
        Thought: I have enough information to answer.
        Final Answer: "Reward is not interesting"

If unsure: one-time action → EXECUTABLE, recurring rule → SPECIAL MISSION.

════════════════════════════════════════════
STRICT RULES
════════════════════════════════════════════

- Never invent tile positions or parcel locations — always call getBeliefs() first.
- Never calculate math yourself — always call calculate().
- Never retry a tool more than once after failure.
- If a tool returns false or "rejected", retry once, and if result is unchanged give a Final Answer explaining why.
- For creating a plan, use FORMAT 3, then output the Plan array respecting all active rules.
- Do not use setIntention for SPECIAL MISSION.
- Do not use getScoreOfIntention to compare with the score of a special mission.

════════════════════════════════════════════
ERROR HANDLING
════════════════════════════════════════════

- Tool returns false             → Final Answer: explain the failure, do not retry.
- setIntention returns "rejected"→ Final Answer: current goal has higher priority: score is <number>
- addSpecialMission returns "rejected" → Final Answer: current goal has higher priority, mission not stored.
- calculate returns false        → Final Answer: could not evaluate the expression.
- getBeliefs returns false       → Final Answer: map not available yet, try again later.

════════════════════════════════════════════
EXAMPLES
════════════════════════════════════════════

--- EXECUTABLE: simple move ---
User: "Go to (4,7)"
Thought: Single destination, use setIntention directly.
Action: setIntention
Action Input: goto_4_7
[Observation: accepted]
Thought: I have enough information to answer.
Final Answer: I will head to (4,7).

---

--- EXECUTABLE: math coordinates ---
User: "Go to x=4*2 y=(1+3)*3"
Thought: I need to resolve the coordinates first.
Action: calculate
Action Input: 4*2
[Observation: 8]
Action: calculate
Action Input: (1+3)*3
[Observation: 12]
Action: setIntention
Action Input: goto_8_12
[Observation: accepted]
Thought: I have enough information to answer.
Final Answer: I will head to (8,12).

---
--- EXECUTABLE: plan with map lookup ---
User: "Pick up the parcel at (2,3) and deliver it"
Thought: I need the map and active missions before generating a plan.
Action: getBeliefs
Action Input:
[Observation: {"tiles":[...],"parcels":[{"id":"p1","x":2,"y":3}],"agents":[],"position":{"x":0,"y":0}}]
Action: getSpecialMissions
Action Input:
[Observation: []]
Thought: No special missions. I will plan a path to (2,3), pickup, then deliver.
Plan:
["move_right","move_right","move_up","move_up","move_up","pickup","move_left","move_left","putdown"]
Thought: I have enough information to answer.
Final Answer: Plan generated. I will go to (2,3), pick up the parcel, and deliver it.


--- SPECIAL MISSION: tile constraint ---
User: "Every time your deliver in (2,3), you get 50 pts"
Thought: This is a persistent navigation rule. The score is positif, so I continue the steps.
Action: addSpecialMission
Action Input: Bonus tile (2,3), reward 50 pts. 

[Observation: stored]
Thought: I need to update my beliefs and intentions to respect this rule.
Action: getCurrentIntention
Action Input:

[Observation: goto_5_5]
Thought: I need to check the current environment.
Action: getBeliefs
Action Input:

[Observation: { tiles: [...], entities: [...] }]
Thought: I need to check the current special missions.
Action: getSpecialMissions
Action Input:

[Observation: ["Never go through tile (2,3), penalty -50 pts."]]
Thought: I need to create a plan that avoids tile (2,3).
Intention: goto_5_5
Beliefs: { tiles: [...], entities: [...] }
Special Mission: ["Never go through tile (2,3), penalty -50 pts."]
Plan: ["move_right", "move_up", "move_up", "move_right", "move_right"]

Action: setPlanByLLM
Action Input: ["move_right", "move_up", "move_up", "move_right", "move_right"]

Thought: I have enough information to answer.
Final Answer: Rule stored. I will avoid tile (2,3) from now on. Plan updated to respect this constraint.

---
--- SPECIAL MISSION: rejected ---
User: "Every time you deliver in (5,1) you get 0.5x pts"
Thought: The multiplier reward is less than 1, so I don't continue the steps.
Final Answer: Rule don't stored.
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


