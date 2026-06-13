import { writeFile } from 'fs/promises';

const MCP_ENDPOINT = 'https://solver.planning.domains/mcp';
const MCP_PROTOCOL_VERSION = '2025-11-25';
const MCP_CLIENT_NAME = 'node-pddl-agent';
const DEFAULT_POLL_INTERVAL_S = 0.5;
const DEFAULT_TIMEOUT_S = 30;

export async function solveOnline(domain, problem) {
  const { sessionId } = await initializeSession();
  const toolResult = await callTool(sessionId, 'paas_lama_first_solve', {
    domain,
    problem,
    timeout_s: DEFAULT_TIMEOUT_S,
    poll_interval_s: DEFAULT_POLL_INTERVAL_S,
  });

  const parsedOutput = extractPlannerOutput(toolResult);
  if (typeof parsedOutput === 'string') {
    return parsePlan(parsedOutput);
  }
  if (Array.isArray(parsedOutput)) {
    return parsePlan(parsedOutput);
  }

  return [];
}

function extractPlannerOutput(toolResult) {
  if (!toolResult) return null;

  if (typeof toolResult === 'string') {
    return toolResult;
  }

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
          // ignore non-JSON text content
        }
      }
    }
  }

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

export function parsePlan(planLines) {
  if (typeof planLines === 'string') {
    planLines = planLines.split(/\r?\n/);
  }

  if (!Array.isArray(planLines)) {
    return [];
  }

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
    .map(line => line.replace(/^\(|\)$/g, '').trim())
    .filter(line => line.length > 0)
    .map(line => line.toLowerCase());
}

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

async function sendMcpRequest(jsonRpcMessage, sessionId) {
  const response = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(jsonRpcMessage),
  });

  const text = await response.text();
  const sseMessages = parseSseStream(text);
  if (process.env.DEBUG_PDDL) {
    console.debug('[PDDL] MCP raw response text:', JSON.stringify(text));
    console.debug('[PDDL] MCP parsed SSE messages:', JSON.stringify(sseMessages, null, 2));
  }

  if (!response.ok) {
    const errorPayload = sseMessages.find(msg => msg.json)?.json ?? text;
    throw new Error(`MCP request failed ${response.status} ${response.statusText}: ${JSON.stringify(errorPayload)}`);
  }

  if (sseMessages.length === 0) {
    throw new Error(`MCP response had no message: ${text}`);
  }

  const finalMessage = sseMessages.find(msg => msg.json && msg.json.jsonrpc === '2.0') ?? sseMessages[sseMessages.length - 1];
  const json = finalMessage.json;
  if (!json) {
    throw new Error(`Unable to parse MCP response JSON: ${text}`);
  }

  return {
    ...json,
    sessionId: response.headers.get('mcp-session-id') ?? undefined,
  };
}

function parseSseStream(streamText) {
  const events = [];
  let currentData = [];
  const lines = streamText.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line === '') {
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

    if (line.startsWith('data:')) {
      currentData.push(line.slice(5).trimStart());
    }
  }

  if (currentData.length > 0) {
    const data = currentData.join('\n');
    try {
      events.push({ data, json: JSON.parse(data) });
    } catch {
      events.push({ data, json: null });
    }
  }

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

export function buildProblem(state) {
  const { tiles, agent, parcels, goalTile } = state;

  const tileNames = tiles.map((tile, index) => `t${index}`);
  const tileLookup = new Map(tiles.map((tile, index) => [`${tile.x},${tile.y}`, tileNames[index]]));

  const lines = [];
  lines.push('(define (problem deliveroo-problem)');
  lines.push('  (:domain deliveroo)');
  lines.push('  (:objects');
  lines.push(`    ${agent.id} - agent`);
  lines.push(`    ${tileNames.join(' ')} - tile`);
  if (parcels.length > 0) {
    lines.push(`    ${parcels.map(p => p.id).join(' ')} - parcel`);
  }
  lines.push('  )');

  lines.push('  (:init');
  lines.push(`    (at ${agent.id} ${tileLookup.get(`${agent.x},${agent.y}`)})`);

  tiles.forEach(tile => {
    const tid = tileLookup.get(`${tile.x},${tile.y}`);
    if (tile.type !== '0') {
      lines.push(`    (free ${tid})`);
    }
    if (tile.type === '2') {
      lines.push(`    (delivery-tile ${tid})`);
    }
    getAllowedEntries(tile.type).forEach(dir => {
      lines.push(`    (allowed-entry ${tid} ${dir})`);
    });
  });

  const adjacency = buildAdjacency(tiles, tileLookup);
  adjacency.forEach(line => lines.push(`    ${line}`));

  parcels.forEach(parcel => {
    const parcelTile = tileLookup.get(`${parcel.x},${parcel.y}`);
    if (parcelTile) {
      lines.push(`    (parcel-at ${parcel.id} ${parcelTile})`);
    }
  });

  lines.push('  )');

  lines.push('  (:goal (and');
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
  lines.push('  ))');
  lines.push(')');

  return lines.join('\n');
}

function getAllowedEntries(tileType) {
  if (tileType === '↑') return ['up'];
  if (tileType === '↓') return ['down'];
  if (tileType === '←') return ['left'];
  if (tileType === '→') return ['right'];
  return ['up', 'down', 'left', 'right'];
}

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

export async function dumpProblem(domain, problem, prefix = 'pddl') {
  await writeFile(`${prefix}_domain.pddl`, domain);
  await writeFile(`${prefix}_problem.pddl`, problem);
}
