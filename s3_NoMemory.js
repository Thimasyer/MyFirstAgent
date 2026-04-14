import 'dotenv/config'
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

const socket = DjsConnect();

const beliefset = new Map();

socket.onConfig( config => 
{
    console.log('Config:', config);
    console.log('Agents observation distance:', config.GAME.player.agents_observation_distance);
})

socket.onMap( (x,y,tiles) => 
{
    console.log('Map:', x,y,tiles);
} )

socket.onYou( me => 
{
    // console.log('You:', me);
})

socket.onSensing( ( agents ) => 
{
    // overwrite everytime
    // sensing is an array of agents, each with {id, name, x, y, score}
    for ( let {agent: a} of sensing ) {
        beliefset.set( a.id, a );
}
    // print the beliefset in a nice format
    let prettyPrint = Array
    .from(beliefset.values())
    .map( ({name,x,y,score}) => 
    {
        return `${name}(${score}):${x},${y}`;
    } ).join(' ');
    console.log(prettyPrint)
} )

