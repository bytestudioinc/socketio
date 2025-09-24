// server.js
const express = require("express");
const http = require("http");
const app = express();
const server = http.createServer(app);

let io;
try {
  const { Server } = require("socket.io");
  io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
  console.log("✅ Using Socket.IO v4");
} catch (e) {
  const socketIo = require("socket.io");
  io = socketIo(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
  console.log("✅ Using Socket.IO v2");
}

const PORT = process.env.PORT || 10000;

// ---------------- Utils ----------------
let searchingUsers = new Map(); // socketId -> user
let rooms = new Map(); // roomId -> [socketIds]

function sanitizeName(name) {
  if (!name) return "user";
  return String(name).replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_]/g, "");
}

function generateRoomId(name1, name2) {
  const rand = Math.floor(10000000 + Math.random() * 90000000);
  return `${sanitizeName(name1)}${rand}${sanitizeName(name2)}`;
}

function getSafeUser(user) {
  return {
    userId: user.userId,
    name: user.name,
    gender: user.gender,
    preference: user.preference
  };
}

// Socket helper for v2/v4
function getSocketById(id) {
  if (io.sockets.sockets.get) return io.sockets.sockets.get(id);
  return io.sockets.connected[id];
}

// ---------------- Socket.IO ----------------
io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  // Notify app that server is ready
  socket.emit("server_ready", JSON.stringify({ state: "ready", userId: socket.id }));

  // ---------------- Matchmaking ----------------
  socket.on("find", (data) => {
    let user = data;
    if (typeof data === "string") {
      try { user = JSON.parse(data); } 
      catch { 
        socket.emit("status", JSON.stringify({ state: "error", message: "Invalid data" }));
        return;
      }
    }

    // Handle short forms
    if (user.gender === "M") user.gender = "MALE";
    else if (user.gender === "F") user.gender = "FEMALE";

    if (user.preference === "A") user.preference = "ANY";
    else if (user.preference === "M") user.preference = "MALE";
    else if (user.preference === "F") user.preference = "FEMALE";

    user.socketId = socket.id;

    // Check for available match
    let matched = null;
    for (let [otherId, otherUser] of searchingUsers) {
      if (otherId !== socket.id) {
        matched = otherUser;
        break;
      }
    }

    if (matched) {
      const roomId = generateRoomId(user.name, matched.name);
      socket.join(roomId);
      const matchedSocket = getSocketById(matched.socketId);
      if (matchedSocket) matchedSocket.join(roomId);
      rooms.set(roomId, [socket.id, matched.socketId]);

      console.log(`🎯 Match found: ${socket.id} + ${matched.socketId} => Room: ${roomId}`);

      socket.emit("status", JSON.stringify({ state: "match_found", roomId, partner: getSafeUser(matched) }));
      matchedSocket?.emit("status", JSON.stringify({ state: "match_found", roomId, partner: getSafeUser(user) }));

      searchingUsers.delete(socket.id);
      searchingUsers.delete(matched.socketId);
    } else {
      // Add to searching pool with timeout
      const timeout = setTimeout(() => {
        if (searchingUsers.has(socket.id)) {
          console.log(`⏰ Timeout for ${socket.id}`);
          socket.emit("status", JSON.stringify({ state: "timeout", message: "Couldn't find a match" }));
          searchingUsers.delete(socket.id);
        }
      }, 30000);

      user._timeout = timeout;
      searchingUsers.set(socket.id, user);
      socket.emit("status", JSON.stringify({ state: "searching", message: "Searching for a partner..." }));
    }
  });

  // Cancel search voluntarily
  socket.on("cancel_search", (data) => {
    let userData = data;
    if (typeof data === "string") {
      try { userData = JSON.parse(data); } catch { userData = {}; }
    }
    if (searchingUsers.has(socket.id)) {
      clearTimeout(searchingUsers.get(socket.id)._timeout);
      searchingUsers.delete(socket.id);
      console.log(`🚫 Search cancelled by ${socket.id}`);
      socket.emit("status", JSON.stringify({ state: "cancelled", message: "Search cancelled." }));
    }
  });

  // Leave chat voluntarily
  socket.on("leave_chat", (data) => {
    let payload = data;
    if (typeof data === "string") {
      try { payload = JSON.parse(data); } catch { return; }
    }
    const { roomId } = payload;
    if (!roomId || !rooms.has(roomId)) return;

    const otherUsers = rooms.get(roomId).filter(id => id !== socket.id);
    otherUsers.forEach(id => {
      const s = getSocketById(id);
      s?.emit("chat_response", JSON.stringify({ status: "partner_left", message: "Your partner left the chat." }));
    });

    socket.leave(roomId);
    rooms.delete(roomId);
    console.log(`🚪 ${socket.id} left room ${roomId}`);
  });

  // Chat messaging
  socket.on("chat_message", (data) => {
    let msg = data;
    if (typeof data === "string") {
      try { msg = JSON.parse(data); } catch { return; }
    }

    const { roomId, name, gender, message, type, time } = msg;
    if (!roomId || !message) return;

    if (rooms.has(roomId) && rooms.get(roomId).includes(socket.id)) {
      socket.to(roomId).emit("chat_response", JSON.stringify({ status: "chatting", from: socket.id, name, gender, message, type, time }));
      console.log(`💬 Message from ${socket.id} in ${roomId}: ${message}`);
    } else {
      console.warn(`⚠️ ${socket.id} tried to send message to invalid room: ${roomId}`);
    }
  });

  // ---------------- Disconnect ----------------
  socket.on("disconnect", () => {
    console.log(`❌ User disconnected: ${socket.id}`);

    // Remove from searching
    if (searchingUsers.has(socket.id)) {
      clearTimeout(searchingUsers.get(socket.id)._timeout);
      searchingUsers.delete(socket.id);
    }

    // Remove from rooms
    for (let [roomId, sockets] of rooms) {
      if (sockets.includes(socket.id)) {
        rooms.delete(roomId);
        socket.to(roomId).emit("chat_response", JSON.stringify({ status: "partner_left", message: "Your partner disconnected." }));
      }
    }
  });
});

server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
