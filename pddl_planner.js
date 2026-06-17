import { writeFile, readFile, unlink, access, constants as fsConstants } from 'fs/promises';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * PDDL Planner Module
 * This module handles PDDL planning for the Deliveroo agent.
 * It can use either:
 * 1. Local FastDownward planner (if installed)
 * 2. Remote planning service via MCP protocol
 * 3. Docker PaaS service
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

// MCP (Model Context Protocol) configuration for remote planning
const MCP_ENDPOINT = 'https://solver.planning.domains/mcp';
const MCP_PROTOCOL_VERSION = '2025-11-25';
const MCP_CLIENT_NAME = 'node-pddl-agent';
const DEFAULT_POLL_INTERVAL_S = 0.5; // How often to check for results
const DEFAULT_TIMEOUT_S = 10;        // Max time for planner to solve (seconds)
const FETCH_TIMEOUT_MS = 15000;       // Network timeout for MCP requests
const MAX_RETRIES = 1;                // Retry failed requests once

// Local FastDownward planner configuration (if available)
const LOCAL_FAST_DOWNWARD_ROOT = '/tmp/downward';
const LOCAL_FAST_DOWNWARD_DRIVER = join(LOCAL_FAST_DOWNWARD_ROOT, 'fast-downward.py');
const LOCAL_FAST_DOWNWARD_BUILD = 'release';
const LOCAL_FAST_DOWNWARD_ALIAS = 'lama-first';
const LOCAL_PLANNER_OVERALL_TIME_LIMIT_S = 10;
const LOCAL_PLANNER_TIMEOUT_MS = 20000;

// Docker PaaS configuration (alternative remote planner)
const USE_DOCKER_PAAS = process.env.PDDL_USE_DOCKER === 'true' || process.env.PDDL_USE_DOCKER === '1';
const DOCKER_PAAS_BASE_URL = process.env.PDDL_DOCKER_URL || 'http://localhost:5001';
const DOCKER_PAAS_SOLVER = process.env.PDDL_DOCKER_SOLVER || 'lama-first';
const DOCKER_PAAS_REQUEST_TIMEOUT_MS = Number(process.env.PDDL_DOCKER_REQUEST_TIMEOUT_MS || 30000);
const DOCKER_PAAS_POLL_INTERVAL_MS = Number(process.env.PDDL_DOCKER_POLL_INTERVAL_MS || 500);
const DOCKER_PAAS_MAX_POLL_ATTEMPTS = Number(process.env.PDDL_DOCKER_MAX_POLL_ATTEMPTS || 60);

// ============================================================================
// MAIN EXPORTED FUNCTIONS
// ============================================================================

/**
 * Main function to solve a planning problem
 * Tries local planner first, falls back to remote
 */
export async function solveOnline(domain, problem) {
  if (USE_DOCKER_PAAS) {
    console.log('[PDDL] Using Docker PaaS (PDDL_USE_DOCKER=true)');
    return solveRemote(domain, problem);
  }

  // Try local planner first if available
  try {
    await access(LOCAL_FAST_DOWNWARD_DRIVER, fsConstants.X_OK);
    const localPlan = await solveLocal(domain, problem);
    if (Array.isArray(localPlan) && localPlan.length > 0) {
      console.log('[PDDL] Local planner returned a plan.');
      return localPlan;
    }
    console.warn('[PDDL] Local planner returned no plan, falling back to remote solver.');
  } catch (error) {
    console.warn('[PDDL] Local planner unavailable or failed:', error.message);
    console.warn('[PDDL] Falling back to remote solver.');
  }

  // Fall back to remote solver
  return solveRemote(domain, problem);
}

/**
 * Build a PDDL problem definition from the current game state
 * This creates the problem file that the planner will solve
 */
export function buildProblem(state) {
  const { tiles, agent, parcels = [], goalTile, objective } = state;

  // Create unique names for each tile (t0, t1, t2, ...)
  const tileNames = tiles.map((tile, index) => `t${index}`);
  // Map coordinates to tile names for easy lookup
  const tileLookup = new Map(tiles.map((tile, index) => [`${tile.x},${tile.y}`, tileNames[index]]));

  const lines = [];
  
  // Problem definition header
  lines.push('(define (problem deliveroo-problem)');
  lines.push('  (:domain deliveroo)');
  
  // Define objects: agent, tiles, parcels
  lines.push('  (:objects');
  lines.push(`    ${agent.id} - agent`);
  lines.push(`    ${tileNames.join(' ')} - tile`);
  if (parcels.length > 0) {
    lines.push(`    ${parcels.map(p => p.id).join(' ')} - parcel`);
  }
  lines.push('  )');

  // Initial state definition
  lines.push('  (:init');
  // Agent starting position
  lines.push(`    (at ${agent.id} ${tileLookup.get(`${agent.x},${agent.y}`)})`);

  // Track which tiles are blocked (walls, obstacles)
  const blockedTileNames = new Set();
  if (state.blockedTiles && Array.isArray(state.blockedTiles)) {
    state.blockedTiles.forEach(({ x, y }) => {
      const tileName = tileLookup.get(`${x},${y}`);
      if (tileName) {
        blockedTileNames.add(tileName);
      }
    });
  }

  // Define properties for each tile
  tiles.forEach(tile => {
    const tid = tileLookup.get(`${tile.x},${tile.y}`);
    // Mark tile as free if it's not a wall and not blocked
    if (tile.type !== '0' && !blockedTileNames.has(tid)) {
      lines.push(`    (free ${tid})`);
    }
    // Mark delivery tiles
    if (tile.type === '2') {
      lines.push(`    (delivery-tile ${tid})`);
    }
    // Define allowed entry directions based on tile type
    getAllowedEntries(tile.type).forEach(dir => {
      lines.push(`    (allowed-entry ${tid} ${dir})`);
    });
  });

  // Define connections between adjacent tiles
  const adjacency = buildAdjacency(tiles, tileLookup);
  adjacency.forEach(line => lines.push(`    ${line}`));

  // Define parcel locations
  parcels.forEach(parcel => {
    if (parcel.carried) {
      // Parcels being carried by the agent
      lines.push(`    (has-parcel ${agent.id} ${parcel.id})`);
    } else if (parcel.x != null && parcel.y != null) {
      // Parcels on the map
      const parcelTile = tileLookup.get(`${parcel.x},${parcel.y}`);
      if (parcelTile) {
        lines.push(`    (parcel-at ${parcel.id} ${parcelTile})`);
      }
    }
  });

  // Mark blocked tiles as not free
  blockedTileNames.forEach(tileName => {
    lines.push(`    (not (free ${tileName}))`);
  });

  lines.push('  )');

  // Goal definition
  lines.push('  (:goal (and');
  if (objective) {
    const goalTileName = objective.goalTile
      ? tileLookup.get(`${objective.goalTile.x},${objective.goalTile.y}`)
      : null;

    if (objective.type === 'pickup') {
      // Goal: reach the parcel location and have the parcel
      if (goalTileName) {
        lines.push(`    (at ${agent.id} ${goalTileName})`);
      }
      if (objective.parcelId) {
        lines.push(`    (has-parcel ${agent.id} ${objective.parcelId})`);
      }
    } else if (objective.type === 'deliver') {
      // Goal: reach delivery location and not have parcels anymore
      if (goalTileName) {
        lines.push(`    (at ${agent.id} ${goalTileName})`);
      }
      const carriedIds = objective.carriedParcelIds || [];
      carriedIds.forEach(parcelId => {
        lines.push(`    (not (has-parcel ${agent.id} ${parcelId}))`);
      });
    } else if (objective.type === 'explore') {
      // Goal: reach the exploration target
      if (goalTileName) {
        lines.push(`    (at ${agent.id} ${goalTileName})`);
      }
    }
  } else {
    // Fallback goal definition
    if (goalTile) {
      lines.push(`    (at ${agent.id} ${tileLookup.get(`${goalTile.x},${goalTile.y}`)})`);
    }
    if (parcels.some(p => p.pickup)) {
      parcels.forEach(parcel => {
        if (parcel.pickup) {
          lines.push(`    (has-parcel ${agent.id} ${parcel.id})`);
        }
      });
    }
  }
  lines.push('  ))');
  lines.push(')');

  return lines.join('\n');
}

/**
 * Save PDDL domain and problem to files for debugging
 */
export async function dumpProblem(domain, problem, prefix = 'pddl') {
  await writeFile(`${prefix}_domain.pddl`, domain);
  await writeFile(`${prefix}_problem.pddl`, problem);
}

// ============================================================================
// REMOTE SOLVING FUNCTIONS
// ============================================================================

/**
 * Solve using remote service (MCP or Docker PaaS)
 */
async function solveRemote(domain, problem) {
  if (USE_DOCKER_PAAS) {
    return solveDockerPaaS(domain, problem);
  }

  console.log(`[PDDL] Requesting plan from solver (timeout: ${DEFAULT_TIMEOUT_S}s)...`);
  const startTime = Date.now();
  
  const { sessionId } = await initializeSession();
  const toolResult = await callTool(sessionId, 'paas_lama_first_solve', {
    domain,
    problem,
    timeout_s: DEFAULT_TIMEOUT_S,
    poll_interval_s: DEFAULT_POLL_INTERVAL_S,
  });

  const elapsedMs = Date.now() - startTime;
  console.log(`[PDDL] Planner response received (${(elapsedMs / 1000).toFixed(2)}s)`);

  const parsedOutput = extractPlannerOutput(toolResult);
  if (typeof parsedOutput === 'string') {
    return parsePlan(parsedOutput);
  }
  if (Array.isArray(parsedOutput)) {
    return parsePlan(parsedOutput);
  }

  return [];
}

/**
 * Solve using Docker PaaS service
 * This is an alternative remote planner that runs in Docker containers
 */
async function solveDockerPaaS(domain, problem) {
  const plannerUrl = `${DOCKER_PAAS_BASE_URL}/package/${DOCKER_PAAS_SOLVER}/solve`;
  console.log('[PDDL] Requesting plan from Docker PaaS at', plannerUrl);

  const body = {
    domain,
    problem,
  };

  // Initialize the planning job
  const initResponse = await fetchWithTimeout(plannerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, DOCKER_PAAS_REQUEST_TIMEOUT_MS);

  if (!initResponse.ok) {
    throw new Error(`Docker PaaS request failed ${initResponse.status} ${initResponse.statusText}`);
  }

  const initJson = await initResponse.json();
  const resultPath = initJson.result;
  if (!resultPath) {
    throw new Error('Docker PaaS did not return a result endpoint');
  }

  // Poll for results until we get an answer or timeout
  const retrieveUrl = `${DOCKER_PAAS_BASE_URL}${resultPath}`;
  let attempts = 0;
  while (attempts < DOCKER_PAAS_MAX_POLL_ATTEMPTS) {
    await delay(DOCKER_PAAS_POLL_INTERVAL_MS);
    const resultResponse = await fetchWithTimeout(retrieveUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    }, DOCKER_PAAS_REQUEST_TIMEOUT_MS);

    if (!resultResponse.ok) {
      throw new Error(`Docker PaaS result request failed ${resultResponse.status} ${resultResponse.statusText}`);
    }

    const resultJson = await resultResponse.json();
    if (resultJson.status && resultJson.status !== 'PENDING') {
      if (resultJson.result) {
        const parsedOutput = extractPlannerOutput(resultJson.result);
        if (typeof parsedOutput === 'string') {
          return parsePlan(parsedOutput);
        }
        if (Array.isArray(parsedOutput)) {
          return parsePlan(parsedOutput);
        }
      }
      if (resultJson.status === 'FAILURE' || resultJson.status === 'ERROR') {
        throw new Error(`Docker PaaS planning failed: ${JSON.stringify(resultJson)}`);
      }
    }

    attempts += 1;
  }

  throw new Error('Docker PaaS timed out waiting for result');
}

// ============================================================================
// LOCAL SOLVING FUNCTIONS
// ============================================================================

/**
 * Solve using local FastDownward planner
 * FastDownward is a popular PDDL planner written in Python
 */
async function solveLocal(domain, problem) {
  // Create temporary files for domain and problem
  const domainFile = join(tmpdir(), `pddl_domain_${Date.now()}_${Math.random().toString(36).slice(2)}.pddl`);
  const problemFile = join(tmpdir(), `pddl_problem_${Date.now()}_${Math.random().toString(36).slice(2)}.pddl`);
  const planFile = join(tmpdir(), `pddl_plan_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
  const sasFile = join(tmpdir(), `pddl_sas_${Date.now()}_${Math.random().toString(36).slice(2)}.sas`);

  // Write domain and problem to temp files
  await writeFile(domainFile, domain);
  await writeFile(problemFile, problem);

  // Build command line arguments for FastDownward
  const args = [
    LOCAL_FAST_DOWNWARD_DRIVER,
    '--build', LOCAL_FAST_DOWNWARD_BUILD,
    '--alias', LOCAL_FAST_DOWNWARD_ALIAS,
    '--overall-time-limit', String(LOCAL_PLANNER_OVERALL_TIME_LIMIT_S),
    '--plan-file', planFile,
    '--sas-file', sasFile,
    '--keep-sas-file',
    domainFile,
    problemFile,
  ];

  try {
    await execFileAsync('python3', args, { timeout: LOCAL_PLANNER_TIMEOUT_MS });
    const planText = await readFile(planFile, 'utf8');
    return parsePlan(planText);
  } finally {
    // Clean up temporary files
    for (const file of [domainFile, problemFile, planFile, sasFile]) {
      try {
        await unlink(file);
      } catch {
        // Ignore cleanup failures
      }
    }
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Simple delay function
 * Returns a promise that resolves after ms milliseconds
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch with timeout support
 * Aborts the request if it takes longer than timeoutMs
 */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Execute a command with timeout support
 * Used for running the local FastDownward planner
 */
function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timeoutId;

    if (child.stdout) {
      child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    }
    if (child.stderr) {
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    }

    child.on('error', reject);
    child.on('close', code => {
      if (timeoutId) clearTimeout(timeoutId);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Local planner failed with exit code ${code}: ${stderr.trim() || stdout.trim()}`));
      }
    });

    if (options.timeout) {
      timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Local planner timed out after ${options.timeout}ms`));
      }, options.timeout);
    }
  });
}

/**
 * Extract the actual plan from various possible response formats
 * Different planners return results in different formats, this normalizes them
 */
function extractPlannerOutput(toolResult) {
  if (!toolResult) return null;

  // If it's already a string, return it
  if (typeof toolResult === 'string') {
    return toolResult;
  }

  // Try structuredContent.result.output
  if (toolResult.structuredContent?.result?.output) {
    const output = toolResult.structuredContent.result.output;
    if (typeof output === 'string') {
      return output;
    }
    if (output?.sas_plan) {
      return output.sas_plan;
    }
    if (output?.plan) {
      return output.plan;
    }
    if (Object.keys(output).length === 0) {
      return null;
    }
    return output;
  }

  // Try structuredContent.result.raw.output
  if (toolResult.structuredContent?.result?.raw?.output) {
    const rawOutput = toolResult.structuredContent.result.raw.output;
    if (typeof rawOutput === 'string') {
      return rawOutput;
    }
    if (rawOutput?.sas_plan) {
      return rawOutput.sas_plan;
    }
    if (rawOutput?.plan) {
      return rawOutput.plan;
    }
    if (Object.keys(rawOutput).length === 0) {
      return null;
    }
    return rawOutput;
  }

  // Try content array (MCP format)
  if (toolResult.content?.length) {
    for (const item of toolResult.content) {
      if (item?.type === 'text' && typeof item.text === 'string') {
        try {
          const parsed = JSON.parse(item.text);
          const resultPayload = parsed?.result ?? parsed;
          const output = resultPayload?.output;
          if (typeof output === 'string') return output;
          if (output?.sas_plan) return output.sas_plan;
          if (output?.plan) return output.plan;
          if (resultPayload?.status === 'ok' && output && Object.keys(output).length === 0) {
            return null;
          }
        } catch {
          // Ignore non-JSON text content
        }
      }
    }
  }

  // Try direct output field
  if (toolResult.output) {
    const output = toolResult.output;
    if (typeof output === 'string') {
      return output;
    }
    if (output?.sas_plan) {
      return output.sas_plan;
    }
    if (output?.plan) {
      return output.plan;
    }
    if (Object.keys(output).length === 0) {
      return null;
    }
    return output;
  }

  return null;
}

/**
 * Parse the plan output from the planner
 * Converts various plan formats to a simple array of action names
 * Example input: "1: (move-up)" or "; move-up" or "(move-up)"
 * Example output: "move-up"
 */
export function parsePlan(planLines) {
  // Convert string to array if needed
  if (typeof planLines === 'string') {
    planLines = planLines.split(/\r?\n/);
  }

  // Return empty array if not an array
  if (!Array.isArray(planLines)) {
    return [];
  }

  // Process each line to extract action name:
  // 1. Trim whitespace
  // 2. Remove empty lines
  // 3. Remove comment lines (starting with ;)
  // 4. Remove inline comments
  // 5. Remove step numbers (e.g., "1: move-up")
  // 6. Remove parentheses
  // 7. Extract first token and lowercase it
  return planLines
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .filter(line => !line.startsWith(';'))
    .map(line => {
      const commentIndex = line.indexOf(';');
      if (commentIndex >= 0) {
        line = line.slice(0, commentIndex).trim();
      }
      return line;
    })
    .map(line => line.replace(/^[0-9]+:\s*/, '').trim())
    .map(line => line.replace(/^\(|\)$/g, '').trim())
    .filter(line => line.length > 0)
    .map(line => {
      const tokens = line.split(/\s+/);
      return tokens[0].toLowerCase();
    });
}

// ============================================================================
// MCP PROTOCOL FUNCTIONS
// ============================================================================

/**
 * Initialize an MCP session
 * MCP (Model Context Protocol) is used to communicate with remote planners
 */
async function initializeSession() {
  const message = await sendMcpRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: MCP_CLIENT_NAME,
          version: '1.0.0',
        },
      },
    }
  );

  if (message.error) {
    throw new Error(`MCP initialize error: ${JSON.stringify(message.error)}`);
  }

  const sessionId = message.sessionId;
  if (!sessionId) {
    throw new Error('MCP initialize did not return a session ID');
  }

  return { sessionId, result: message.result };
}

/**
 * Call an MCP tool (planner)
 * Sends a request to the remote planner via MCP protocol
 */
async function callTool(sessionId, toolName, args) {
  const message = await sendMcpRequest(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    },
    sessionId
  );

  if (message.error) {
    throw new Error(`MCP tool error: ${JSON.stringify(message.error)}`);
  }

  return message.result;
}

/**
 * Send an MCP JSON-RPC request
 * Handles retries and SSE (Server-Sent Events) parsing
 * MCP servers send responses as SSE streams
 */
async function sendMcpRequest(jsonRpcMessage, sessionId, retryCount = 0) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    
    const response = await fetch(MCP_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify(jsonRpcMessage),
      signal: controller.signal,
    });
    
    clearTimeout(timeout);

    const text = await response.text();
    const sseMessages = parseSseStream(text);
    
    if (process.env.DEBUG_PDDL) {
      console.debug('[PDDL] MCP raw response text:', JSON.stringify(text));
      console.debug('[PDDL] MCP parsed SSE messages:', JSON.stringify(sseMessages, null, 2));
    }

    if (!response.ok) {
      const errorPayload = sseMessages.find(msg => msg.json)?.json ?? text;
      throw new Error(`MCP request failed ${response.status} ${response.statusText}`);
    }

    if (sseMessages.length === 0) {
      throw new Error('MCP response had no message');
    }

    // Find the final JSON-RPC message or use the last one
    const finalMessage = sseMessages.find(msg => msg.json && msg.json.jsonrpc === '2.0') ?? sseMessages[sseMessages.length - 1];
    const json = finalMessage.json;
    if (!json) {
      throw new Error('Unable to parse MCP response JSON');
    }

    return {
      ...json,
      sessionId: response.headers.get('mcp-session-id') ?? undefined,
    };
  } catch (error) {
    // Retry if we haven't exceeded max retries
    if (retryCount < MAX_RETRIES) {
      const waitMs = 1000 * (retryCount + 1);
      console.warn(`[PDDL] Request failed (attempt ${retryCount + 1}/${MAX_RETRIES + 1}), retrying in ${waitMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      return sendMcpRequest(jsonRpcMessage, sessionId, retryCount + 1);
    }
    throw error;
  }
}

/**
 * Parse Server-Sent Events stream
 * MCP uses SSE for responses, this parses the stream into individual messages
 */
function parseSseStream(streamText) {
  const events = [];
  let currentData = [];
  const lines = streamText.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line === '') {
      // Empty line means end of event
      if (currentData.length > 0) {
        const data = currentData.join('\n');
        try {
          events.push({ data, json: JSON.parse(data) });
        } catch {
          events.push({ data, json: null });
        }
        currentData = [];
      }
      continue;
    }

    // SSE events start with "data:"
    if (line.startsWith('data:')) {
      currentData.push(line.slice(5).trimStart());
    }
  }

  // Handle any remaining data
  if (currentData.length > 0) {
    const data = currentData.join('\n');
    try {
      events.push({ data, json: JSON.parse(data) });
    } catch {
      events.push({ data, json: null });
    }
  }

  // Fallback: try to parse the entire text as JSON
  if (events.length === 0 && streamText.trim()) {
    try {
      const json = JSON.parse(streamText);
      events.push({ data: streamText, json });
    } catch {
      // Ignore
    }
  }

  return events;
}

// ============================================================================
// PDDL DOMAIN HELPERS
// ============================================================================

/**
 * Get allowed entry directions for a tile type
 * Different tiles have different entry restrictions:
 * - One-way arrows only allow entry from one direction
 * - Normal tiles allow entry from all directions
 */
function getAllowedEntries(tileType) {
  if (tileType === '\u2191') return ['up'];    // Up arrow
  if (tileType === '\u2193') return ['down'];  // Down arrow
  if (tileType === '\u2190') return ['left'];  // Left arrow
  if (tileType === '\u2192') return ['right']; // Right arrow
  return ['up', 'down', 'left', 'right'];    // Normal tile
}

/**
 * Build adjacency relationships between tiles
 * Creates (connected from to direction) predicates that define the map graph
 * This tells the planner which tiles are connected and in which direction
 */
function buildAdjacency(tiles, lookup) {
  const lines = [];
  const directions = [
    { dx: 0, dy: 1, dir: 'up' },
    { dx: 0, dy: -1, dir: 'down' },
    { dx: -1, dy: 0, dir: 'left' },
    { dx: 1, dy: 0, dir: 'right' }
  ];

  tiles.forEach(tile => {
    const from = lookup.get(`${tile.x},${tile.y}`);
    directions.forEach(({ dx, dy, dir }) => {
      const neighbor = lookup.get(`${tile.x + dx},${tile.y + dy}`);
      if (neighbor) {
        lines.push(`(connected ${from} ${neighbor} ${dir})`);
      }
    });
  });
  return lines;
}
