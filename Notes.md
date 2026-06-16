# Questions / Points d'attention
Quand arrêté de prendre les probabilités (position des joueur) ?
> après 5 cases

Comment gérer les conflits de Belief si on garde un historique pour chacun des agents?
CF diapo 10-11/56 du cours 10-Belief-Representation...
> définir des règles, pour abandonner un Belief plutôt qu'un autre en fonction des conflits possible

A quel moment gérer les conflits?
> pas tout le temps, attendre un peu

# Discussion entre nous


# Structure 
Est ce qu'on reprend la structure de loop asynchrone utilisé par le prof? (dans DeliverooAgents.js\lab4\intention_revision)
ou on garde la structure plus linéaire avec une fonction AgentLoop et tick? (dans mes codes)

En tout cas pour le moment ça fonctionne même si on lance plusieurs action en parallèmle parfois.


## Belief (grosse classe):
### Attributs:
- **playerPosition**: `{ x: number, y: number }` - Position actuelle du joueur
- **carried**: `Set<{ id: string }>` - Ensemble des colis actuellement transportés (évite les doublons)
- **visibleParcels**: `Array<{ id: string, x: number, y: number, carriedBy: string, reward: number }>` - Liste des colis visibles sur la carte (non portés par un agent)
- **visibleAgents**: `Array<{ id: string, x: number, y: number }>` - Liste des agents visibles sur la carte
- **probabilityMap**: `Array<Array<Array<Array<number>>>>` - Carte de probabilité [x][y][time][agentIndex] pour prédire les positions des agents
- **deliveryPoint**: `Array<{ x: number, y: number, distance: number }>` - Points de livraison (tiles de type 2)
- **spawnPoint**: `Array<{ x: number, y: number }>` - Points de spawn (tiles de type 1)
- **tiles**: `Array<{x: number, y: number, type: number}>` - Tiles de la carte reçues du serveur
- **mapWidth**: `number` - Largeur de la carte
- **mapHeight**: `number` - Hauteur de la carte

### Méthodes:
- **updatePlayerPosition(x, y)** - Met à jour la position du joueur
- **addCarriedParcel(parcelID)** - Ajoute un colis à l'ensemble des colis transportés
- **updateVisibleParcels(parcels)** - Met à jour la liste des colis visibles (filtre ceux déjà portés)
- **updateVisibleAgents(agents)** - Met à jour la liste des agents visibles
- **updateProbabilityMap()** - Met à jour la carte de probabilité pour prédire les mouvements des agents (horizon temporel MAX_TIME_HORIZON)
- **defineDeliveryPoint(tiles)** - Définit les points de livraison à partir des tiles de type 2
- **defineSpawnPoint(tiles)** - Définit les points de spawn à partir des tiles de type 1
- **getMapWidth(tiles)** - Calcule la largeur réelle de la carte à partir des tiles
- **getMapHeight(tiles)** - Calcule la hauteur réelle de la carte à partir des tiles 
- 


node agent_pddl.js -> use fast-downward planner
PDDL_USE_DOCKER=true node agent_pddl.js -> use docker


to use docker (ubuntu) : 
- sudo apt install -y docker.io docker-compose
- sudo systemctl enable docker
- sudo systemctl start docker
- git clone https://github.com/AI-Planning/planning-as-a-service.git
- cd planning-as-a-service/server
- cp .env.example .env
- sudo make