const WebSocket = require('ws')
const wss = new WebSocket.Server({ port: 8080 })

let ping;
let count = 0;

wss.on('connection', function connection(ws) {
  ws.on('close', function close() {
    console.log('bye')
    clearInterval(ping);
    count = 0;
  })
  ws.send('hello client')
  ping = setInterval(() => {
    ws.send('ping ' + count++)
  }, 500);
})
