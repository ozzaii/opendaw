// Each song lives in a y-websocket room on loopback (openDAW's own YSync): the conductor populates it, the booth page
// joins it and plays every applied program the moment it lands. The truth stays on disk, never in the room.
import {createServer} from "node:http"
import * as Y from "yjs"
import {WebSocket, WebSocketServer} from "ws"
import {WebsocketProvider} from "y-websocket"
import {docs, setPersistence, setupWSConnection} from "y-websocket/bin/utils"
import {YSync} from "./node_modules/@opendaw/studio-core/dist/ysync/YSync.js"
// A ROOM GOES WHEN ITS LAST CLIENT LEAVES. y-websocket 1.5.4 (bin/utils.js closeConn) forgets a room's doc only when a
// persistence is set; with none, every room ever opened stayed in its module map for the life of the process, and every
// replace and undo opens a new one (song.mjs #attach). Measured 11-14 (heap-proof.mjs): 4 MB of Y structs held per
// attach on an 8-lane song, and the store died of a full heap 62 minutes after a start. The truth is on disk, so a room
// keeps nothing: this persistence only lets an empty room go.
setPersistence({bindState: () => {}, writeState: async () => {}})
// Who is in a room: the store's own client and each page joined to it.
export const clientsIn = name => docs.get(name)?.conns.size ?? 0
export const startRooms = (port = 0, host = "127.0.0.1") => new Promise(resolve => {
  const wss = new WebSocketServer({noServer: true})
  wss.on("connection", setupWSConnection)
  const server = createServer((_request, response) => {response.writeHead(404); response.end()})
  server.on("upgrade", (request, socket, head) => wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws, request)))
  // a page outside this host joins through the engine's own port (server.mjs `/rooms/<name>`, bearer-checked)
  const join = (request, socket, head, docName) => wss.handleUpgrade(request, socket, head, ws => setupWSConnection(ws, request, {docName}))
  server.listen(port, host, () => resolve({server, join, url: `ws://${host}:${server.address().port}`}))
})
// Put one song's graph in a room of its own; the handle ends it.
export const openRoom = async (url, name, boxGraph) => {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(url, name, doc, {WebSocketPolyfill: WebSocket})
  await new Promise(resolve => provider.on("sync", synced => synced && resolve()))
  const sync = await YSync.populateRoom({boxGraph, boxes: doc.getMap("boxes")})
  return {name, close: () => {sync.terminate(); provider.destroy(); doc.destroy()}}
}
