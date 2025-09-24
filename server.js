// server.js
const express = require("express");
const http = require("http");
const app = express();
const server = http.createServer(app);

const socketIo = require("socket.io");
const io = socketIo(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const PORT = process.env.PORT || 10000;

let searchingUsers = new Map();
let rooms = new Map();

// 🔹 Normalize gender & preference input
function normalize(value, type) {
  if (!value) return null;
  const v = value.toString().toUpperCase();
  if (type === "gender") {
    if (v === "M") return "male";
    if (v === "F") return "female";
    return "other";
  }
  if (type === "preference") {
    if (v === "M") return "male";
    if (v === "F") return "female";
    if (v === "A") return "all";
  }
  return value.toLowerCase();
}

// 🔹 Generate RoomId
function generateRoomId(user1, user2) {
  const rand = Math.floor(10000000 + Math.random() * 90000000);
  return `${user1}${rand}${user2}`;
}

// Get socket safely
function getSocketById(socketId) {
  if (io.sockets.sockets.get) return io.sockets.sockets.get(socketId); // v3/v4
  return io.sockets.connected[socketId]; // v2
}

// Remove internal fields
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

  // ---------------- Server Ready ----------------
  socket.emit("server_ready", JSON.stringify({ state: "ready", userId: socket.id }));

  // ---------------- Matchmaking ----------------
  socket.on("find", (data) => {
    let parsedData = typeof data === "string" ? JSON.parse(data) : data;
    parsedData.socketId = socket.id;

    // Normalize gender/preference
    parsedData.gender = normalize(parsedData.gender, "gender");
    parsedData.preference = normalize(parsedData.preference, "preference");

    // Try to find a match
    let matched = null;
    for (let [otherId, otherUser] of searchingUsers) {
      if (otherId !== socket.id) {
        matched = otherUser;
        break;
      }
    }

    if (matched) {
      const roomId = generateRoomId(socket.id, matched.socketId);
      console.log(`🎯 Match found: ${socket.id} + ${matched.socketId} = ${roomId}`);

      socket.join(roomId);
      const matchedSocket = getSocketById(matched.socketId);
      if (matchedSocket) matchedSocket.join(roomId);

      rooms.set(roomId, [socket.id, matched.socketId]);

      socket.emit("status", JSON.stringify({ state: "matched", roomId, partner: getSafeUser(matched) }));
      matchedSocket?.emit("status", JSON.stringify({ state: "matched", roomId, partner: getSafeUser(parsedData) }));

      searchingUsers.delete(socket.id);
      searchingUsers.delete(matched.socketId);
    } else {
      // Add to queue with timeout
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

  // ---------------- Cancel Search ----------------
  socket.on("cancel_search", (data) => {
    let parsedData = typeof data === "string" ? JSON.parse(data) : data;
    const { userId } = parsedData || {};

    if (userId && searchingUsers.has(userId)) {
      const user = searchingUsers.get(userId);
      if (user._timeout) clearTimeout(user._timeout);
      searchingUsers.delete(userId);
      socket.emit("status", JSON.stringify({ state: "cancelled", message: "Search cancelled." }));
      console.log(`🚫 Search cancelled by ${userId}`);
    }
  });

  // ---------------- Chat Messaging ----------------
  socket.on("chat_message", (data) => {
    let parsedData = typeof data === "string" ? JSON.parse(data) : data;
    const { roomId, message, type, name, gender, time } = parsedData;
    if (!roomId || !message || !type) {
      console.warn(`⚠️ Invalid chat payload from ${socket.id}:`, parsedData);
      return;
    }

    if (rooms.has(roomId) && rooms.get(roomId).includes(socket.id)) {
      socket.to(roomId).emit("chat_response", JSON.stringify({
        status: "chatting",
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
    let parsedData = typeof data === "string" ? JSON.parse(data) : data;
    const { roomId } = parsedData || {};
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

  // ---------------- Disconnect ----------------
  socket.on("disconnect", () => {
    console.log(`❌ User disconnected: ${socket.id}`);

    if (searchingUsers.has(socket.id)) {
      const user = searchingUsers.get(socket.id);
      if (user._timeout) clearTimeout(user._timeout);
      searchingUsers.delete(socket.id);
    }

    for (let [roomId, sockets] of rooms) {
      if (sockets.includes(socket.id)) {
        rooms.delete(roomId);
        socket.to(roomId).emit("chat_response", JSON.stringify({ status: "disconnected", message: "Your partner disconnected." }));
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
