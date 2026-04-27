import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { BoardStore } from "./boardStore.js";
import { PORT } from "./config.js";

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({
  server: httpServer,
  path: "/ws"
});
const HOST = process.env.HOST || "0.0.0.0";

const boardStore = new BoardStore();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const clientDistPath = resolve(__dirname, "../../client/dist");

app.use(cors({ origin: true }));
app.use(express.json());
app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    status: "healthy",
    now: Date.now()
  });
});
app.get("/api/state", (_request, response) => {
  response.json(boardStore.getSnapshot(null));
});
if (existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  app.get("*", (request, response, next) => {
    if (request.path.startsWith("/api")) {
      next();
      return;
    }
    response.sendFile(join(clientDistPath, "index.html"));
  });
}
function sendMessage(socket, message) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(message));
}
function broadcast(message) {
  const payload = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}
function broadcastStats() {
  broadcast({
    type: "stats_updated",
    payload: {
      stats: boardStore.getStats(),
      serverTime: Date.now()
    }
  });
}
function registerOrRefreshUser(socket, rawProfile) {
  const { user, changedTiles } = boardStore.ensureUser(rawProfile);
  if (socket.userId && socket.userId !== user.userId) {
    boardStore.detachSession(socket.userId);
  }
  if (!socket.userId || socket.userId !== user.userId) {
    boardStore.attachSession(user.userId);
  }
  socket.userId = user.userId;
  sendMessage(socket, {
    type: "welcome",
    payload: boardStore.getSnapshot(user.userId)
  });
  if (changedTiles.length > 0) {
    broadcast({
      type: "tiles_synced",
      payload: {
        tiles: changedTiles,
        stats: boardStore.getStats(),
        serverTime: Date.now()
      }
    });
  } else {
    broadcastStats();
  }
}
wss.on("connection", (socket) => {
  socket.isAlive = true;
  socket.userId = null;
  socket.on("pong", () => {
    socket.isAlive = true;
  });
  socket.on("message", (rawData) => {
    let message;
    try {
      message = JSON.parse(rawData.toString("utf8"));
    } catch {
      sendMessage(socket, {
        type: "claim_rejected",
        payload: {
          reason: "INVALID_MESSAGE",
          message: "Could not parse that WebSocket message."
        }
      });
      return;
    }
    switch (message.type) {
      case "hello":
        registerOrRefreshUser(socket, message.payload);
        break;
      case "update_profile": {
        if (!socket.userId) {
          sendMessage(socket, {
            type: "claim_rejected",
            payload: {
              reason: "UNKNOWN_USER",
              message: "Reconnect before changing your alias."
            }
          });
          return;
        }
        const profile = {
          ...message.payload,
          userId: socket.userId
        };
        const { user, changedTiles } = boardStore.ensureUser(profile);
        sendMessage(socket, {
          type: "profile_updated",
          payload: {
            user
          }
        });
        if (changedTiles.length > 0) {
          broadcast({
            type: "tiles_synced",
            payload: {
              tiles: changedTiles,
              stats: boardStore.getStats(),
              serverTime: Date.now()
            }
          });
        } else {
          broadcastStats();
        }
        break;
      }
      case "claim_tile": {
        if (!socket.userId) {
          sendMessage(socket, {
            type: "claim_rejected",
            payload: {
              reason: "UNKNOWN_USER",
              message: "Reconnect to the board before claiming a tile."
            }
          });
          return;
        }
        const tileId = Number(message.payload?.tileId);
        const result = boardStore.claimTile(socket.userId, tileId);
        if (!result.ok) {
          sendMessage(socket, {
            type: "claim_rejected",
            payload: {
              ...result,
              serverTime: Date.now()
            }
          });
          return;
        }
        broadcast({
          type: "tile_claimed",
          payload: result
        });
        break;
      }
      case "request_snapshot":
        sendMessage(socket, {
          type: "welcome",
          payload: boardStore.getSnapshot(socket.userId)
        });
        break;
      default:
        sendMessage(socket, {
          type: "claim_rejected",
          payload: {
            reason: "UNKNOWN_EVENT",
            message: `Unknown event type: ${message.type || "missing type"}.`
          }
        });
    }
  });
  socket.on("close", () => {
    if (socket.userId) {
      boardStore.detachSession(socket.userId);
      broadcastStats();
    }
  });
});
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((socket) => {
    if (socket.isAlive === false) {
      socket.terminate();
      return;
    }
    socket.isAlive = false;
    socket.ping();
  });
}, 30000);
wss.on("close", () => {
  clearInterval(heartbeatInterval);
});
httpServer.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `PulseGrid could not start because port ${PORT} is already in use. Stop the other process or set a different PORT.`
    );
    process.exit(1);
  }
  if (error.code === "EACCES") {
    console.error(
      `PulseGrid could not bind to ${HOST}:${PORT}. Check host/port permissions or try a different PORT.`
    );
    process.exit(1);
  }
  console.error("PulseGrid server failed to start.", error);
  process.exit(1);
});
httpServer.listen(PORT, HOST, () => {
  const servingClient = existsSync(clientDistPath);
  console.log(
    `PulseGrid server listening on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT} (${servingClient ? "serving client build" : "API/WebSocket only"})`
  );
});
