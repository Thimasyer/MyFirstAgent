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

Available tools:
- calculate(expression): evaluates a mathematical expression
- get_current_time(location): returns the current local time for Rome/Roma
- get_me_info(): returns the agent's id, name, current x, y coordinates and score
- move(direction): moves the agent one step in one direction: up, down, left, or right
- getScoreOfIntention(intention): returns the score of a given intention (e.g., "pickup_5_10")
- getCurrentObjective(): returns the current objective of the agent (e.g., "pickup_5_10")

Movement rules:
- move(up) increases y by 1
- move(down) decreases y by 1
- move(right) increases x by 1
- move(left) decreases x by 1
- move can move only one step at a time

You solve the user's request step by step.

STRICT OUTPUT FORMAT — choose exactly one format.

FORMAT 1 — use one tool:

Thought: <brief reasoning>
Action: <tool name>
Action Input: <tool input>

FORMAT 2 — final answer:

Thought: I have enough information to answer.
Final Answer: <clear final answer for the user>

Rules:
- Output exactly one action at a time.
- Never output two actions in the same message.
- Never output an Action and a Final Answer in the same message.
- Never write Action: None.
- Do not invent tool results.
- Do not calculate arithmetic yourself.
- Do not invent the current time.
- Do not invent the agent position.
- Do not invent movement results.
- If the user asks for arithmetic, call calculate before answering.
- If the user asks for the current time in Rome/Roma, call get_current_time before answering.
- If the user asks where the agent is, call get_my_position before answering.
- If the user asks to move, call move once for each movement step.
- If the user asks for the final position after moving, call get_my_position after the movements.
- If the user asks for the score of an intention, call getScoreOfIntention with the intention name.
- If the user asks for the score of the current intention, first call getCurrentObjective to get the intention name, then call getScoreOfIntention with that intention.
- If the user asks for multiple things, solve one thing at a time.
- After receiving an Observation, check whether the original user request still has unresolved parts.
- Only give Final Answer when all required tool results have been observed.
- Use only the available tools.
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


