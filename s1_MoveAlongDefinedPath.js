import { DjsConnect, DjsClientSocket} from '@unitn-asa/deliveroo-js-sdk'
import 'dotenv/config'

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjRlZmMxMyIsIm5hbWUiOiJ0ZXN0NCIsInJvbGUiOiJ1c2VyIiwiaWF0IjoxNzc1ODMwNTM2fQ.2X7TEM8xtFXi_Bkm0rWLB8mGVH4LEmRh3Ablx_Z0ge0';
const URL = 'ws://localhost:8080';

console.log("*Connexion*");
const socket =  DjsConnect(URL, TOKEN);
let myPosition = { x: 3, y: 3 };

socket.on('you', (id, name, x, y) => {
    //console.log(`Sono ${name} (ID: ${id}) in positiono ${x},${y}`);
    myPosition = { x, y };
});

socket.on('map', async (width, height, tiles) => 
{
    console.log("Map received! Dimension:", width, "x", height);
    const path = ['right', 'down', 'down', 'left', 'up', 'right', 'down', 'down', 'left', 'up', 'right', 'down', 'down', 'left', 'up','right', 'down', 'down', 'left', 'up','right', 'down', 'down', 'left', 'up'];
    for (const direction of path) 
    {
        const result = await  socket.emitMove(direction);
        console.log(`Move ${direction}:`, result);
        if (!result)
        {
            console.log("Move failed, retrying");
            await new Promise(resolve => setTimeout(resolve, 100)); // Wait before retrying
        }
    }
  
    // await socket.emitPickup();
});

    