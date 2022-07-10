// Read env variables
import 'dotenv/config'
const SERVICE_ACCOUNT_KEY = Buffer.from(process.env.SERVICE_ACCOUNT_KEY, 'base64').toString('utf8')
const SOCKET_PORT = parseInt(process.env.SOCKET_PORT)

// Create server
import { WebSocketServer } from 'ws'
const wss = new WebSocketServer({ port: process.env.PORT || SOCKET_PORT })
console.log('listening at ' + SOCKET_PORT)

// Initialize necessary constants
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'
import { nanoid } from 'nanoid'
import ApiSocket from './src/api-socket.js'

const serviceAccount = JSON.parse(SERVICE_ACCOUNT_KEY)
initializeApp({
  credential: cert(serviceAccount),
})
const db = getFirestore()
const auth = getAuth()
const connectionPool = new Map()

// Bind connection handler
wss.on('connection', async function connection(ws) {
  const id = newConnectionId()
  connectionPool.set(id, new ApiSocket(id, ws, auth, db, () => {
    connectionPool.delete(id)
  }))
})

function newConnectionId() {
  let id
  do {
    id = nanoid()
  } while (connectionPool.has(id))
  return id
}