// server.js
const express = require("express");
const http = require("http");
const app = express();
const server = http.createServer(app);

let io;

// Detect Socket.IO v4 or fallback to v2
try {
  const { Server } = require("socket.io");
  io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
  console.log("✅ Using Socket.IO v3/v4");
} catch (e) {
  const socketIo = require("socket.io");
  io = socketIo(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
  console.log("✅ Using Socket.IO v2");
}

const PORT = process.env.PORT || 10000;

// Users searching for match: socketId -> user info
let searchingUsers = new Map();
// Rooms: roomId -> [socketIds]
let rooms = new Map();

// Get socket safely (v2/v4)
function getSocketById(socketId) {
  if (io.sockets.sockets.get) return io.sockets.sockets.get(socketId);
  return io.sockets.connected[socketId];
}

// Remove internal _timeout before sending partner info
function getSafeUser(user) {
  return {
    userId: user.userId,
    name: user.name,
    gender: user.gender,
    preference: user.preference
  };
}

io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  // ---------------- Matchmaking ----------------
  socket.on("find", (data) => {
    let parsedData = data;
    if (typeof data === "string") {
      try {
        parsedData = JSON.parse(data);
      } catch (err) {
        console.error("❌ Invalid JSON:", err.message);
        socket.emit("status", JSON.stringify({ state: "error", message: "Invalid data format" }));
        return;
      }
    }

    parsedData.socketId = socket.id;

    // Look for any available match
    let matched = null;
    for (let [otherId, otherUser] of searchingUsers) {
      if (otherId !== socket.id) {
        matched = otherUser;
        break;
      }
    }

    if (matched) {
      const roomId = `room_${socket.id}_${matched.socketId}`;
      console.log(`🎯 Match found: ${socket.id} + ${matched.socketId}`);

      socket.join(roomId);
      const matchedSocket = getSocketById(matched.socketId);
      if (matchedSocket) matchedSocket.join(roomId);

      rooms.set(roomId, [socket.id, matched.socketId]);

      // Send match info to both users
      socket.emit("status", JSON.stringify({ state: "matched", roomId, partner: getSafeUser(matched) }));
      matchedSocket?.emit("status", JSON.stringify({ state: "matched", roomId, partner: getSafeUser(parsedData) }));

      searchingUsers.delete(socket.id);
      searchingUsers.delete(matched.socketId);
    } else {
      // No match → add to pool with 30s timeout
      const timeout = setTimeout(() => {
        if (searchingUsers.has(socket.id)) {
          console.log(`⏰ Timeout for ${socket.id}`);
          socket.emit("status", JSON.stringify({ state: "timeout", message: "Couldn't find a match" }));
          searchingUsers.delete(socket.id);
        }
      }, 30000);

      parsedData._timeout = timeout;
      searchingUsers.set(socket.id, parsedData);
      socket.emit("status", JSON.stringify({ state: "searching", message: "Searching for a partner..." }));
    }
  });

  // Cancel search
  socket.on("cancel_search", () => {
    if (searchingUsers.has(socket.id)) {
      const user = searchingUsers.get(socket.id);
      if (user._timeout) clearTimeout(user._timeout);
      searchingUsers.delete(socket.id);
      socket.emit("status", JSON.stringify({ state: "cancelled", message: "Search cancelled." }));
      console.log(`🚫 Search cancelled by ${socket.id}`);
    }
  });

  // ---------------- Chat Messaging ----------------
  // Sending message: { roomId, name, gender, type, message, time }
  socket.on("chat_message", (data) => {
    let parsedData = data;
    if (typeof data === "string") {
      try {
        parsedData = JSON.parse(data);
      } catch (err) {
        console.error("❌ Invalid chat JSON:", err.message);
        return;
      }
    }

    const { roomId, message, type, name, gender, time } = parsedData;
    if (!roomId || !message || !type) return;

    if (rooms.has(roomId) && rooms.get(roomId).includes(socket.id)) {
      // Emit message to everyone in the room except sender
      socket.to(roomId).emit("chat_response", JSON.stringify({
        from: socket.id,
        name,
        gender,
        type,
        message,
        time
      }));
      console.log(`💬 Message from ${socket.id} in ${roomId}: ${message}`);
    } else {
      console.warn(`⚠️ ${socket.id} tried to send message to invalid room: ${roomId}`);
    }
  });

  // ---------------- Leave Chat ----------------
  socket.on("leave_chat", (data) => {
    let parsedData = data;
    if (typeof data === "string") {
      try { parsedData = JSON.parse(data); } 
      catch { return; }
    }
    const { roomId } = parsedData;
    if (!roomId || !rooms.has(roomId)) return;

    const otherUsers = rooms.get(roomId).filter(id => id !== socket.id);
    otherUsers.forEach(id => {
      const s = getSocketById(id);
      s?.emit("status", JSON.stringify({ state: "partner_disconnected", message: "Your partner left the chat." }));
    });

    socket.leave(roomId);
    rooms.delete(roomId);
    console.log(`🚪 ${socket.id} left room ${roomId}`);
  });

  // ---------------- Disconnect ----------------
  socket.on("disconnect", () => {
    console.log(`❌ User disconnected: ${socket.id}`);

    // Remove from searching pool
    if (searchingUsers.has(socket.id)) {
      const user = searchingUsers.get(socket.id);
      if (user._timeout) clearTimeout(user._timeout);
      searchingUsers.delete(socket.id);
    }

    // Remove user from rooms
    for (let [roomId, sockets] of rooms) {
      if (sockets.includes(socket.id)) {
        rooms.delete(roomId);
        socket.to(roomId).emit("status", JSON.stringify({ state: "partner_disconnected", message: "Your partner left the chat." }));
      }
    }
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
