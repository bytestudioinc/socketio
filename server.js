// server.js
const express = require("express");
const http = require("http");
const app = express();
const server = http.createServer(app);

// Initialize Socket.IO safely
let io;
try {
  const { Server } = require("socket.io");
  io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
  console.log("✅ Using Socket.IO v3/v4");
} catch (e) {
  const socketIo = require("socket.io");
  io = socketIo(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
  console.log("✅ Using Socket.IO v2 fallback");
}

const PORT = process.env.PORT || 10000;

// ---------------- Users & Rooms ----------------
let searchingUsers = new Map(); // socketId -> user info
let rooms = new Map();           // roomId -> [socketIds]

// ---------------- Timeout Messages ----------------
const timeoutMessagesPaid = [
  "Oops, your match is busy. Try again!",
  "Someone’s chatting, but you’ll get your turn. Try again!",
  "Patience, young grasshopper, the match awaits. Try again!",
  "Love is in the air… just not for you yet. Try again!",
  "Good things take time—your match is worth it. Try again!",
  "Your preferred partner is currently away. Try again!",
  "Looks like Cupid is tied up. Try again!",
  "They’re busy charming someone else. Try again!"
];
const timeoutMessagesFree = [  "Everyone’s chatting. Hang tight, try again!",
  "No freebirds available. Retry shortly!",
  "All ears are busy. Give it another try!",
  "Cupid is taking a nap. Try again soon!",
  "Good chats come to those who wait. Try again!",
  "Looks like everyone’s talking. Try again!",
  "No one is free right now. Try again!",
  "All your potential partners are busy. Try again!"
];

// ---------------- Helper Functions ----------------

// Normalize gender/preference input
function normalizeGenderPref(value) {
  if (!value) return "Any";
  value = value.toString().toUpperCase();
  if (["M", "MALE"].includes(value)) return "Male";
  if (["F", "FEMALE"].includes(value)) return "Female";
  if (["A", "ANY"].includes(value)) return "Any";
  return "Any";
}

// Generate random 8-digit number string
function random8Digit() {
  return Math.floor(10000000 + Math.random() * 90000000).toString();
}

// Get safe user object for emitting (avoid circular)
function getSafeUser(user) {
  return {
    userId: user.userId,
    name: user.name,
    gender: user.gender,
    preference: user.preference
  };
}

// Safe get socket by id for v2/v4
function getSocketById(socketId) {
  if (io.sockets.sockets.get) return io.sockets.sockets.get(socketId);
  return io.sockets.connected[socketId];
}

// ---------------- Socket.IO ----------------
io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  // Notify client server is ready
  socket.emit("server_ready", { state: "ready", userId: socket.id });

  // ---------------- Find Match ----------------
  // Data: { userId, name, gender, preference }
  socket.on("find", (data) => {
    let parsed = data;
    if (typeof data === "string") {
      try { parsed = JSON.parse(data); } catch { parsed = {}; }
    }

    parsed.socketId = socket.id;
    parsed.gender = normalizeGenderPref(parsed.gender);
    parsed.preference = normalizeGenderPref(parsed.preference);

    // ---------------- Matchmaking ----------------
    let matched = null;
    let paidUser = parsed.preference !== "Any";

    // Prioritize paid users matching
    for (let [otherId, otherUser] of searchingUsers) {
      if (otherId === socket.id) continue;

      const otherPaid = otherUser.preference !== "Any";
      const genderMatch = parsed.preference === "Any" || parsed.preference === otherUser.gender;
      const reverseMatch = otherUser.preference === "Any" || otherUser.preference === parsed.gender;

      if (genderMatch && reverseMatch) {
        // Prefer matching paid users first
        if (paidUser && otherPaid) { matched = otherUser; break; }
        if (!matched) matched = otherUser;
      }
    }

    if (matched) {
      // ---------------- Match Found ----------------
      const roomId = `${parsed.name}${random8Digit()}${matched.name}`;
      socket.join(roomId);
      const matchedSocket = getSocketById(matched.socketId);
      if (matchedSocket) matchedSocket.join(roomId);

      rooms.set(roomId, [socket.id, matched.socketId]);
      console.log(`🎯 Match: ${socket.id} + ${matched.socketId} in room ${roomId}`);

      socket.emit("status", { state: "match_found", roomId, partner: getSafeUser(matched) });
      matchedSocket?.emit("status", { state: "match_found", roomId, partner: getSafeUser(parsed) });

      searchingUsers.delete(socket.id);
      searchingUsers.delete(matched.socketId);
    } else {
      // ---------------- No Match → Add to Queue with Timeout ----------------
      const timeout = setTimeout(() => {
        if (searchingUsers.has(socket.id)) {
          const msgPool = parsed.preference === "Any" ? timeoutMessagesFree : timeoutMessagesPaid;
          const randomMsg = msgPool[Math.floor(Math.random() * msgPool.length)];
          socket.emit("status", { state: "timeout", message: randomMsg });
          console.log(`⏰ Timeout for ${socket.id}: ${randomMsg}`);
          searchingUsers.delete(socket.id);
        }
      }, 30000);

      parsed._timeout = timeout;
      searchingUsers.set(socket.id, parsed);
      socket.emit("status", { state: "searching", message: "Searching for a partner..." });
    }
  });

  // ---------------- Cancel Search ----------------
  // Data: { userId } (optional)
  socket.on("cancel_search", (data) => {
    if (searchingUsers.has(socket.id)) {
      const user = searchingUsers.get(socket.id);
      if (user._timeout) clearTimeout(user._timeout);
      searchingUsers.delete(socket.id);
      socket.emit("status", { state: "cancelled", message: "Search cancelled." });
      console.log(`🚫 Search cancelled by ${socket.id}`);
    }
  });

  // ---------------- Chat Messaging ----------------
  // Data: { roomId, name, gender, type, message, time }
  socket.on("chat_message", (data) => {
    let parsed = data;
    if (typeof data === "string") {
      try { parsed = JSON.parse(data); } catch { return; }
    }
    const { roomId, message, type, name, gender, time } = parsed;
    if (!roomId || !message || !type) return;

    if (rooms.has(roomId) && rooms.get(roomId).includes(socket.id)) {
      // Emit to others in the room
      socket.to(roomId).emit("chat_response", {
        status: "chatting",
        from: socket.id,
        name,
        gender,
        type,
        message,
        time
      });
      console.log(`💬 ${socket.id} in ${roomId}: ${message}`);
    } else {
      console.warn(`⚠️ ${socket.id} tried to send message to invalid room: ${roomId}`);
    }
  });

  // ---------------- Leave Chat ----------------
  // Data: { roomId }
  socket.on("leave_chat", (data) => {
    let parsed = data;
    if (typeof data === "string") {
      try { parsed = JSON.parse(data); } catch { return; }
    }
    const { roomId } = parsed;
    if (!roomId || !rooms.has(roomId)) return;

    const otherUsers = rooms.get(roomId).filter(id => id !== socket.id);
    otherUsers.forEach(id => {
      const s = getSocketById(id);
      s?.emit("chat_response", { status: "partner_left", message: "Your partner left the chat." });
    });

    socket.leave(roomId);
    rooms.delete(roomId);
    console.log(`🚪 ${socket.id} left room ${roomId}`);
  });

  // ---------------- Disconnect ----------------
  socket.on("disconnect", () => {
    console.log(`❌ User disconnected: ${socket.id}`);

    // Remove from searching queue
    if (searchingUsers.has(socket.id)) {
      const user = searchingUsers.get(socket.id);
      if (user._timeout) clearTimeout(user._timeout);
      searchingUsers.delete(socket.id);
    }

    // Remove from rooms
    for (let [roomId, sockets] of rooms) {
      if (sockets.includes(socket.id)) {
        rooms.delete(roomId);
        socket.to(roomId).emit("chat_response", { status: "partner_disconnected", message: "Your partner left the chat." });
      }
    }
  });
});

// ---------------- Start Server ----------------
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
