import { WebSocket } from 'ws';
const ws = new WebSocket('ws://localhost:4444');
ws.on('open', () => {
    console.log('Connected to bridge!');
    ws.close();
});
ws.on('error', (err) => {
    console.error('Connection error:', err);
});
