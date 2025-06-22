// main.ts

/**
 * A signaling server for WebRTC clients, rewritten in Deno.
 * This server facilitates the connection between one "server" peer and multiple "client" peers
 * by creating rooms and relaying messages between them.
 */

// A map to hold all our active rooms, with the room ID as the key.
const rooms = new Map<string, Room>();
const port = Number(Deno.env.get("PORT") ?? 8080);

console.log(`Signaling server starting on port ${port}...`);

/**
 * The main HTTP server handler. It routes requests to either create a room
 * or establish a WebSocket connection.
 */
Deno.serve({ port }, (req) => {
  const url = new URL(req.url);

  if (req.method === "POST" && url.pathname === "/rooms") {
    return handleCreateRoom();
  }

  if (req.method === "GET" && url.pathname === "/ws") {
    return handleWebSocket(req);
  }

  return new Response("Not Found", { status: 404 });
});

/**
 * Handles the creation of a new room.
 * Responds with the new unique room ID.
 */
function handleCreateRoom(): Response {
  const roomId = crypto.randomUUID();
  const room = new Room(roomId);
  rooms.set(roomId, room);

  console.log(`[Server] Created room ${roomId}`);
  return new Response(roomId, { status: 200 });
}

/**
 * Handles incoming WebSocket connection requests.
 * It validates the request and hands off the connection to the appropriate room.
 */
function handleWebSocket(req: Request): Response {
  const url = new URL(req.url);
  const roomId = url.searchParams.get("room-id");
  const role = url.searchParams.get("role");

  if (!roomId || !role) {
    return new Response("Missing 'room-id' or 'role' query parameters", {
      status: 400,
    });
  }

  if (role !== "client" && role !== "server") {
    return new Response("Role must be 'client' or 'server'", { status: 400 });
  }

  const room = rooms.get(roomId);
  if (!room) {
    return new Response(`Room with ID '${roomId}' not found`, { status: 404 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);

  console.log(`[Server] Adding ${role} ws conn to room ${room.id.substring(0, 6)}...`);

  // Hand the connection over to the room.
  if (role === "client") {
    room.handleClientConn(socket);
  } else {
    room.handleServerConn(socket);
  }

  return response;
}

/**
 * Represents a single signaling room.
 * It manages one server (host) connection and multiple client (guest) connections.
 */
class Room {
  public readonly id: string;
  private serverConn: WebSocket | null = null;
  private clientConns = new Map<string, WebSocket>(); // Map<clientID, WebSocket>

  constructor(id: string) {
    this.id = id;
    console.log(`[Room ${this.id.substring(0, 6)}] Initialized`);
  }

  /**
   * Registers the "server" (host) peer's WebSocket connection.
   * A room can only have one server peer.
   */
  handleServerConn(ws: WebSocket) {
    if (this.serverConn) {
      console.log(`[Room ${this.id.substring(0, 6)}] Rejected server conn. Server conn already exists.`);
      ws.send(JSON.stringify({
        type: "error",
        data: "server conn already exists",
      }));
      ws.close();
      return;
    }

    this.serverConn = ws;
    console.log(`[Room ${this.id.substring(0, 6)}] Registered server conn.`);

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        // Messages from the server peer MUST specify which client they are for.
        if (message.clientID) {
          this.sendMessageToClient(message.clientID, message);
        }
      } catch (e) {
        console.error(`[Room ${this.id.substring(0, 6)}] Error processing message from server:`, e);
      }
    };

    ws.onclose = () => {
      console.log(`[Room ${this.id.substring(0, 6)}] Server conn closed.`);
      this.serverConn = null;
      // Optional: Inform all clients the server has disconnected.
      this.clientConns.forEach(clientWs => clientWs.close());
      this.clientConns.clear();
      // Optional: remove room from global map
      // rooms.delete(this.id);
    };
  }

  /**
   * Registers a "client" (guest) peer's WebSocket connection.
   * Generates a unique ID for the client to be used for message routing.
   */
  handleClientConn(ws: WebSocket) {
    const clientId = crypto.randomUUID();
    this.clientConns.set(clientId, ws);
    console.log(`[Room ${this.id.substring(0, 6)}] Registered client conn: ${clientId}`);

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        // Add the client's ID to the message and forward it to the server peer.
        this.sendMessageToServer(clientId, message);
      } catch (e) {
        console.error(`[Room ${this.id.substring(0, 6)}] Error processing message from client ${clientId}:`, e);
      }
    };

    ws.onclose = () => {
      console.log(`[Room ${this.id.substring(0, 6)}] Client conn closed: ${clientId}`);
      this.clientConns.delete(clientId);
    };
  }

  /**
   * Forwards a message from the server peer to a specific client peer.
   */
  private sendMessageToClient(clientId: string, message: unknown) {
    const clientWs = this.clientConns.get(clientId);
    if (!clientWs) {
      console.log(`[Room ${this.id.substring(0, 6)}] Attempted to send message to unknown client: ${clientId}`);
      return;
    }
    clientWs.send(JSON.stringify(message));
  }

  /**
   * Forwards a message from a client peer to the server peer.
   */
  private sendMessageToServer(clientId: string, message: any) {
    if (!this.serverConn) {
       console.log(`[Room ${this.id.substring(0, 6)}] No server connection available to forward message from ${clientId}`);
       return;
    }
    // The message sent to the server peer includes the original sender's ID.
    const serverMessage = { ...message, clientID: clientId };
    this.serverConn.send(JSON.stringify(serverMessage));
  }
}