// Each song lives in a y-websocket room on loopback (openDAW's own YSync): the conductor populates it, the booth page
// joins it and plays every applied program the moment it lands. The truth stays on disk, never in the room.
import {createServer} from "node:http"
import * as Y from "yjs"
import {WebSocket, WebSocketServer} from "ws"
import {WebsocketProvider} from "y-websocket"
import {setupWSConnection} from "y-websocket/bin/utils"
import {YSync} from "./node_modules/@opendaw/studio-core/dist/ysync/YSync.js"
export const startRooms = (port = 0, host = "127.0.0.1") => new Promise(resolve => {
  const wss = new WebSocketServer({noServer: true})
  wss.on("connection", setupWSConnection)
  const server = createServer((_request, response) => {response.writeHead(404); response.end()})
  server.on("upgrade", (request, socket, head) => wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws, request)))
  server.listen(port, host, () => resolve({server, url: `ws://${host}:${server.address().port}`}))
})
// Put one song's graph in a room of its own; the handle ends it.
export const openRoom = async (url, name, boxGraph) => {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(url, name, doc, {WebSocketPolyfill: WebSocket})
  await new Promise(resolve => provider.on("sync", synced => synced && resolve()))
  const sync = await YSync.populateRoom({boxGraph, boxes: doc.getMap("boxes")})
  return {name, close: () => {sync.terminate(); provider.destroy(); doc.destroy()}}
}
