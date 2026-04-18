# Questions / Points d'attention
Quand arrêté de prendre les probabilités (position des joueur) ?
> après 5 cases

Comment gérer les conflits de Belief si on garde un historique pour chacun des agents?
CF diapo 10-11/56 du cours 10-Belief-Representation...
> définir des règles, pour abandonner un Belief plutôt qu'un autre en fonction des conflits possible

A quel moment gérer les conflits?
> pas tout le temps, attendre un peu



# Structure 
Est ce qu'on reprend la structure de loop asynchrone utilisé par le prof? (dans DeliverooAgents.js\lab4\intention_revision)
ou on garde la structure plus linéaire avec la fonction AgentLoop et tick? (dans mes codes)



## Belief (grosse classe):
Attribut:
- map myAgent: x, y, nbrCarriedPackage, nbrScore, myCurrentIntetion, myCurrentPlan
- map mapOtherAgent: strId, nbrTime, x, y, boolVisible
- map mapPackage: strId, x, y, nbrTimer
- mapProba: une mapTiles par joueur (tableau 2D pour les cases
                                        x temps 
                                        x proba )
Méthode:
- UpdateBeliefAgentProperty(strId, prop, value)         // A chaque
- IsOtherAgentVisible (strId)
- 
- 




## Fonction à créer?

