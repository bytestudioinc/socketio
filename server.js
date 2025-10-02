// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ------------------ Data Stores ------------------
let searchingUsers = new Map(); // socketId -> user info
let rooms = new Map();           // roomId -> [socketIds]

// ------------------ Helper ------------------
function parseClientData(data) {
  try {
    return typeof data === "string" ? JSON.parse(data) : data;
  } catch (e) {
    console.error("❌ Failed to parse client data:", data);
    return {};
  }
}

function getSocketById(socketId) {
  if (io.sockets.sockets.get) return io.sockets.sockets.get(socketId);
  return io.sockets.connected[socketId];
}

function sendToClient(socket, event, payload, roomId = null) {
  try {
    const evt = roomId ? `${event}/${roomId}` : event;
    socket.emit(evt, JSON.stringify(payload));
  } catch (e) {
    console.warn("⚠️ sendToClient failed:", e);
  }
}

function random8Digit() {
  return Math.floor(10000000 + Math.random() * 90000000).toString();
}

// ------------------ Socket.IO ------------------
io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  // Notify client server is ready
  sendToClient(socket, "server_ready", { 
    state: "ready",
    userId: socket.id,
    version: "1.15",
    reward: 1,
    preferenceCost: 10,
    maintenance: "no"
  });

  // ---------------- Find Match ----------------
  socket.on("find", (data) => {
    let parsed = parseClientData(data);
    parsed.socketId = socket.id;

    console.log(`🔍 find from ${socket.id}:`, parsed);

    let matched = null;
    for (let [otherId, otherUser] of searchingUsers) {
      if (otherId === socket.id) continue;
      matched = otherUser;
      break; // match first available
    }

    if (matched) {
      const roomId = `${parsed.socketId}-${matched.socketId}-${random8Digit()}`;
      socket.join(roomId);
      const matchedSocket = getSocketById(matched.socketId);
      if (matchedSocket) matchedSocket.join(roomId);

      rooms.set(roomId, [socket.id, matched.socketId]);
      console.log(`🤝 Match: ${socket.id} + ${matched.socketId} in room ${roomId}`);

      sendToClient(socket, "chat_response", { status: "match_found", roomId, partner: matched.socketId }, roomId);
      if (matchedSocket) sendToClient(matchedSocket, "chat_response", { status: "match_found", roomId, partner: socket.id }, roomId);

      searchingUsers.delete(socket.id);
      searchingUsers.delete(matched.socketId);
    } else {
      console.log(`⌛ ${socket.id} added to searching list`);
      searchingUsers.set(socket.id, parsed);
      sendToClient(socket, "status", { state: "searching" });
    }
  });

  // ---------------- Chat Messaging ----------------
  socket.on("chat_message", (data) => {
    const parsed = parseClientData(data);
    const { roomId, message, type, name, gender, time } = parsed;

    console.log(`📩 chat_message from ${socket.id}:`, parsed);

    if (!roomId || !message || !type) {
      console.warn(`⚠️ Invalid chat_message from ${socket.id}`);
      return;
    }

    if (rooms.has(roomId) && rooms.get(roomId).includes(socket.id)) {
      socket.to(roomId).emit(`chat_response/${roomId}`, JSON.stringify({
        status: "chatting",
        roomId,
        from: socket.id,
        name,
        gender,
        type,
        message,
        time
      }));
      console.log(`📤 Forwarded message from ${socket.id} to room ${roomId}`);
    } else {
      console.warn(`⚠️ ${socket.id} tried sending message to invalid room ${roomId}`);
    }
  });

  // ---------------- Leave Chat ----------------
  socket.on("leave_chat", (data) => {
    const parsed = parseClientData(data);
    const { roomId } = parsed;

    console.log(`🚪 leave_chat from ${socket.id} for room ${roomId}`);

    if (roomId && rooms.has(roomId)) {
      const participants = rooms.get(roomId);
      const partnerId = participants.find(id => id !== socket.id);

      if (partnerId) {
        console.log(`   Notifying partner ${partnerId} that ${socket.id} left`);
        sendToClient(getSocketById(partnerId), "chat_response", { status: "partner_left", roomId, partner: socket.id }, roomId);
      }

      socket.leave(roomId);
      rooms.delete(roomId); // remove room after one leaves (optional: or keep it)
    }
  });

  // ---------------- Disconnect ----------------
  socket.on("disconnect", () => {
    console.log(`❌ ${socket.id} disconnected`);

    searchingUsers.delete(socket.id);

    for (let [roomId, participants] of rooms.entries()) {
      if (participants.includes(socket.id)) {
        const partnerId = participants.find(id => id !== socket.id);
        if (partnerId) {
          console.log(`⚡ ${socket.id} disconnected, notifying partner ${partnerId}`);
          sendToClient(getSocketById(partnerId), "chat_response", { status: "partner_disconnected", roomId, partner: socket.id }, roomId);
        }
        rooms.delete(roomId); // optional: delete room here if you want
      }
    }
  });
});

// ------------------ Start Server ------------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
