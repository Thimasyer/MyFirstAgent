import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

/**
 * Script to run two BDI agents simultaneously
 * This is useful for testing multi-agent scenarios
 */

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const agentScript = path.resolve(__dirname, 'agent_bdi.js');

/**
 * Parse command line arguments
 * Supports both environment variables and command line flags
 */
function parseArgs(argv) {
  const args = {
    token1: process.env.TOKEN1 || '',
    token2: process.env.TOKEN2 || '',
    host: process.env.HOST || 'http://localhost:8080',
    nbrFailedAction1: process.env.MAX_NUMBER_OF_FAILED_ACTION_1 || 2,
    nbrFailedAction2: process.env.MAX_NUMBER_OF_FAILED_ACTION_2 || 3,
  };

  // Parse command line arguments
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--token1=')) {
      args.token1 = arg.slice('--token1='.length).trim();
    } else if (arg.startsWith('--token2=')) {
      args.token2 = arg.slice('--token2='.length).trim();
    } else if (arg.startsWith('--host=')) {
      args.host = arg.slice('--host='.length).trim();
    } else if (arg.startsWith('--nbrFailedAction1=')) {
      args.nbrFailedAction1 = arg.slice('--nbrFailedAction1='.length).trim();
    } else if (arg.startsWith('--nbrFailedAction2=')) {
      args.nbrFailedAction2 = arg.slice('--nbrFailedAction2='.length).trim();
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    }
  }

  return args;
}

/**
 * Print usage instructions
 */
function printUsage() {
  console.log('Usage: node run_two_bdi_agents.js --token1=<token1> --token2=<token2> [--host=<host>]');
  console.log('');
  console.log('You may also set TOKEN1, TOKEN2, and HOST in .env or environment.');
  console.log('');
  console.log('Options:');
  console.log('  --token1=<token>       Token for agent 1');
  console.log('  --token2=<token>       Token for agent 2');
  console.log('  --host=<url>            Game server URL (default: http://localhost:8080)');
  console.log('  --nbrFailedAction1=<n> Max failed actions before giving up for agent 1 (default: 2)');
  console.log('  --nbrFailedAction2=<n> Max failed actions before giving up for agent 2 (default: 3)');
  console.log('  --help, -h             Show this help message');
}

/**
 * Spawn a single BDI agent as a child process
 * @param {string} token - Authentication token for the agent
 * @param {number} index - Agent index (0 or 1)
 * @param {string} host - Game server URL
 * @param {string|number} nrbFailedAction - Max failed actions before giving up
 * @returns {ChildProcess} The spawned child process
 */
function spawnAgent(token, index, host, nrbFailedAction) {
  // Set up environment variables for the agent
  const env = {
    ...process.env,
    HOST: host,
    TOKEN: token,
    AGENT_INDEX: String(index + 1),
    MAX_NUMBER_OF_FAILED_ACTION: nrbFailedAction,
  };

  // Spawn the agent process
  const child = spawn(process.execPath, [agentScript], {
    env,
    stdio: 'inherit',
  });

  // Handle process exit
  child.on('exit', (code, signal) => {
    const label = `agent-${index + 1}`;
    if (signal) {
      console.log(`[${label}] exited by signal ${signal}`);
    } else {
      console.log(`[${label}] exited with code ${code}`);
    }
  });

  // Handle process errors
  child.on('error', (error) => {
    console.error(`[agent-${index + 1}] failed to start: ${error.message}`);
  });

  return child;
}

/**
 * Main function
 * Validates arguments and spawns both agents
 */
function main() {
  // Debug: Check if .env was loaded
  console.log(`[DEBUG] process.env.TOKEN1 exists: ${!!process.env.TOKEN1}`);
  console.log(`[DEBUG] process.env.TOKEN2 exists: ${!!process.env.TOKEN2}`);
  console.log(`[DEBUG] MAX_NUMBER_OF_FAILED_ACTION_1 exists: ${!!process.env.MAX_NUMBER_OF_FAILED_ACTION_1}`);
  console.log(`[DEBUG] MAX_NUMBER_OF_FAILED_ACTION_2 exists: ${!!process.env.MAX_NUMBER_OF_FAILED_ACTION_2}`);
  if (process.env.TOKEN1) {
    console.log(`[DEBUG] TOKEN1 first 20 chars: ${process.env.TOKEN1.slice(0, 20)}`);
  }
  if (process.env.TOKEN2) {
    console.log(`[DEBUG] TOKEN2 first 20 chars: ${process.env.TOKEN2.slice(0, 20)}`);
  }

  const args = parseArgs(process.argv);
  console.log('[DEBUG] Max failed actions agent 1:', args.nbrFailedAction1);
  console.log('[DEBUG] Max failed actions agent 2:', args.nbrFailedAction2);

  // Validate arguments
  if (args.help || !args.token1 || !args.token2 || !args.nbrFailedAction1 || !args.nbrFailedAction2) {
    printUsage();
    if (!args.help) process.exit(1);
    return;
  }

  console.log(`Starting two BDI agents on host=${args.host}`);
  console.log(`Agent 1 token prefix: ${args.token1.slice(0, 8)}`);
  console.log(`Agent 2 token prefix: ${args.token2.slice(0, 8)}`);

  // Agent configurations
  const agents = [
    { token: args.token1, nbrFailedAction: args.nbrFailedAction1 },
    { token: args.token2, nbrFailedAction: args.nbrFailedAction2 },
  ];

  // Spawn both agents
  const children = agents.map(({ token, nbrFailedAction }, index) =>
    spawnAgent(token, index, args.host, nbrFailedAction)
  );

  // Handle Ctrl+C to stop all agents gracefully
  process.on('SIGINT', () => {
    console.log('\nStopping agents...');
    children.forEach((child) => {
      if (child && !child.killed) {
        child.kill('SIGINT');
      }
    });
    process.exit(0);
  });
}

main();
