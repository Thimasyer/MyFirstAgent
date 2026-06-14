/*******************************************************************************
 * @file        pathfinding.js
 * @author      Thomas Eyer
 * @date        2026-06-02
 * @description Utility functions for pathfinding (e.g., A*, Dijkstra).
 * Note: 
 *******************************************************************************/
import { myBeliefs } from "./agent_bdi.js";
import { myIntentions} from "./agent_bdi.js";

/**
 * Generates a path from start to goal using A* algorithm, avoiding non-walkable tiles (type 0) and dynamic obstacles
 * @param {{x: number, y: number}} start
 * @param {{x: number, y: number}} goal
 * @returns {Array<string>} List of move actions (move_up, move_down, move_left, move_right)
 */
export function generatePathTo(start, goal) {
    const startPos = { x: Math.round(start.x), y: Math.round(start.y) };
    const goalPos = { x: Math.round(goal.x), y: Math.round(goal.y) };

    // Create a walkability grid from tiles
    const walkable = new Array(myBeliefs.getMapWidth());
    for (let x = 0; x < myBeliefs.getMapWidth(); x++) {
        walkable[x] = new Array(myBeliefs.getMapHeight()).fill(true);
    }

    // Mark non-walkable tiles (type "0") and build a tile lookup for directional rules
    const tilesByPosition = new Map();
    myBeliefs.getTiles().forEach(tile => {
        tilesByPosition.set(`${tile.x},${tile.y}`, tile);
        if (tile.type === "0") {
            walkable[tile.x][tile.y] = false;
        }
    });

     // Mark dynamic obstacles as non-walkable
    if (myBeliefs.blockedTiles.size > 0)
    {
        myBeliefs.blockedTiles.forEach(pos => {
            const [x, y] = pos.split('_').map(Number); // Convertit 'x_y' en {x, y}
            if (x >= 0 && x < myBeliefs.getMapWidth() &&
                y >= 0 && y < myBeliefs.getMapHeight()) {
                walkable[x][y] = false;
            }
        });
    }
    
    // A* algorithm
    const openSet = new Set();
    const closedSet = new Set();
    const gScore = new Array(myBeliefs.getMapWidth()).fill(null).map(() => new Array(myBeliefs.getMapHeight()).fill(Infinity));
    const fScore = new Array(myBeliefs.getMapWidth()).fill(null).map(() => new Array(myBeliefs.getMapHeight()).fill(Infinity));
    const cameFrom = new Array(myBeliefs.getMapWidth()).fill(null).map(() => new Array(myBeliefs.getMapHeight()).fill(null));

    gScore[startPos.x][startPos.y] = 0;
    fScore[startPos.x][startPos.y] = heuristic(startPos, goalPos);
    openSet.add(`${startPos.x},${startPos.y}`);

    const directions = [
        { dx: 0, dy: -1, action: 'move_down' },
        { dx: 0, dy: 1, action: 'move_up' },
        { dx: -1, dy: 0, action: 'move_left' },
        { dx: 1, dy: 0, action: 'move_right' }
    ];

    while (openSet.size > 0) {
        // Find node with lowest fScore
        let current = null;
        let minFScore = Infinity;

        for (const node of openSet) {
            const [x, y] = node.split(',').map(Number);
            if (fScore[x][y] < minFScore) {
                minFScore = fScore[x][y];
                current = { x, y };
            }
        }

        if (!current) {
            break; // No valid path found
        }

        
        if (current.x === goalPos.x && current.y === goalPos.y) {
            // Reconstruct path
            return reconstructPath(cameFrom, current);
        }

        openSet.delete(`${current.x},${current.y}`);
        closedSet.add(`${current.x},${current.y}`);

        for (const dir of directions) {
            const neighbor = { x: current.x + dir.dx, y: current.y + dir.dy };

            // Check boundaries
            if (neighbor.x < 0 || neighbor.x >= myBeliefs.getMapWidth() || neighbor.y < 0 || neighbor.y >= myBeliefs.getMapHeight()) {
                continue;
            }

            // Check if walkable
            if (!walkable[neighbor.x][neighbor.y]) {
                continue;
            }

            // Directional tiles may restrict traversal based on the destination tile only.
            // Example: cannot move into a tile "↓" from above, only from below.
            const neighborTile = tilesByPosition.get(`${neighbor.x},${neighbor.y}`);
            if (!isTraversalAllowed(neighborTile?.type, dir.action)) {
                continue;
            }

            // Check if already evaluated
            if (closedSet.has(`${neighbor.x},${neighbor.y}`)) {
                continue;
            }

            const tentativeGScore = gScore[current.x][current.y] + 1;

            if (!openSet.has(`${neighbor.x},${neighbor.y}`)) {
                openSet.add(`${neighbor.x},${neighbor.y}`);
            } else if (tentativeGScore >= gScore[neighbor.x][neighbor.y]) {
                continue;
            }

            cameFrom[neighbor.x][neighbor.y] = { ...current, action: dir.action };
            gScore[neighbor.x][neighbor.y] = tentativeGScore;
            fScore[neighbor.x][neighbor.y] = tentativeGScore + heuristic(neighbor, goalPos);
        }
    }

    // No path found
    console.log(`[PATHFINDING] CurrentIntention impossible : aucun chemin valide vers (${goalPos.x},${goalPos.y})`);
    myIntentions.setCurrentImpossibleIntentions(myIntentions.getCurrentObjective());
    myIntentions.clearPlan(); // clear plan to trigger re-planning
    return [];
}

/**
 * Manhattan distance heuristic for A*
 * @param {{x: number, y: number}} a
 * @param {{x: number, y: number}} b
 * @returns {number}
 */
export function heuristic(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Returns the A* move action for a directional tile.
 * @param {string|null|undefined} type
 * @returns {string|null}
 */
function getArrowAction(type) {
    switch (type) {
        case '→': return 'move_right';
        case '←': return 'move_left';
        case '↑': return 'move_up';
        case '↓': return 'move_down';
        default: return null;
    }
}

/**
 * Checks whether a move is allowed into a tile with a directional constraint.
 * @param {string|null|undefined} tileType
 * @param {string} action
 * @returns {boolean}
 */
function isTraversalAllowed(tileType, action) {
    const arrowAction = getArrowAction(tileType);
    if (arrowAction && arrowAction !== action) {
        return false;
    }
    return true;
}

/**
 * Reconstructs the path from cameFrom map
 * @param {Array<Array<{x: number, y: number, action: string}|null>>} cameFrom
 * @param {{x: number, y: number}} current
 * @returns {Array<string>}
 */
export function reconstructPath(cameFrom, current) {
    const path = [];
    while (cameFrom[current.x][current.y] !== null) {
        const parent = cameFrom[current.x][current.y];
        if (parent && parent.action) {
            path.unshift(parent.action);
        }
        if (!parent) break; // Stop if no parent
        current = parent;
    }
    return path;
}

/**
 * Euclidean distance between two points.
 * @param {{x: number, y: number}} a
 * @param {{x: number, y: number}} b
 * @returns {number}
 */
export function euclideanDistance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}