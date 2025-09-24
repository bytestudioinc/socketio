// server.js
const express = require("express");
const http = require("http");
const app = express();
const server = http.createServer(app);

// ---------------- Socket.IO Setup ----------------
let io;
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

// ---------------- Data Stores ----------------
const searchingUsers = new Map(); // socketId -> userData
const rooms = new Map(); // roomId -> [socketIds]

// ---------------- Helper Functions ----------------
function getSocketById(socketId) {
  if (io.sockets.sockets?.get) return io.sockets.sockets.get(socketId);
  return io.sockets.connected[socketId];
}

function getSafeUser(user) {
  return {
    userId: user.userId,
    name: user.name,
    gender: user.gender,
    preference: user.preference
  };
}

function normalizeGender(gender) {
  gender = gender?.toUpperCase();
  if (gender === "M") return "MALE";
  if (gender === "F") return "FEMALE";
  return gender; // "MALE", "FEMALE", "ANY"
}

function normalizePreference(pref) {
  pref = pref?.toUpperCase();
  if (pref === "M") return "MALE";
  if (pref === "F") return "FEMALE";
  if (pref === "A") return "ANY";
  return pref; // "MALE", "FEMALE", "ANY"
}

function generateRoomId(user1, user2) {
  const random8 = Math.floor(10000000 + Math.random() * 90000000);
  return `${user1}${random8}${user2}`;
}

// ---------------- Socket.IO Events ----------------
io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  // Notify client server is ready
  socket.emit("server_ready", JSON.stringify({ state: "ready", userId: socket.id }));

  // ---------------- Matchmaking ----------------
  socket.on("find", (data) => {
    let parsedData = data;
    if (typeof data === "string") {
      try { parsedData = JSON.parse(data); } catch { return; }
    }

    // Normalize gender/preference
    parsedData.gender = normalizeGender(parsedData.gender);
    parsedData.preference = normalizePreference(parsedData.preference);
    parsedData.socketId = socket.id;

    console.log(`📩 Find request from ${socket.id}:`, parsedData);

    // Separate paid (specific preference) and free (ANY) users
    let matched = null;
    let paidPriority = parsedData.preference !== "ANY";

    for (let [otherId, otherUser] of searchingUsers) {
      if (otherId === socket.id) continue;

      const otherPaid = otherUser.preference !== "ANY";

      // Match if paid user matches preference
      if (paidPriority) {
        if (otherUser.preference === parsedData.gender || otherUser.preference === "ANY") {
          matched = otherUser;
          break;
        }
      } else {
        // Free user matches free user
        if (!otherPaid && (otherUser.preference === parsedData.gender || otherUser.preference === "ANY")) {
          matched = otherUser;
          break;
        }
      }
    }

    if (matched) {
      const roomId = generateRoomId(parsedData.userId, matched.userId);
      socket.join(roomId);
      const matchedSocket = getSocketById(matched.socketId);
      if (matchedSocket) matchedSocket.join(roomId);

      rooms.set(roomId, [socket.id, matched.socketId]);

      console.log(`🎯 Match found: ${socket.id} + ${matched.socketId} → Room: ${roomId}`);

      socket.emit("status", JSON.stringify({ state: "match_found", roomId, partner: getSafeUser(matched) }));
      matchedSocket?.emit("status", JSON.stringify({ state: "match_found", roomId, partner: getSafeUser(parsedData) }));

      // Clear from searching queue
      clearTimeout(matched._timeout);
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

  // ---------------- Cancel Search ----------------
  socket.on("cancel_search", (data) => {
    let parsedData = data;
    if (typeof data === "string") {
      try { parsedData = JSON.parse(data); } catch { return; }
    }

    if (searchingUsers.has(socket.id)) {
      const user = searchingUsers.get(socket.id);
      if (user._timeout) clearTimeout(user._timeout);
      searchingUsers.delete(socket.id);
      socket.emit("status", JSON.stringify({ state: "cancelled", message: "Search cancelled." }));
      console.log(`🚫 Search cancelled by ${socket.id}`);
    }
  });

  // ---------------- Chat Messaging ----------------
  socket.on("chat_message", (data) => {
    let parsedData = data;
    if (typeof data === "string") {
      try { parsedData = JSON.parse(data); } catch { return; }
    }

    const { roomId, message, type, name, gender, time } = parsedData;
    if (!roomId || !message || !type) return;

    if (rooms.has(roomId) && rooms.get(roomId).includes(socket.id)) {
      socket.to(roomId).emit("chat_response", JSON.stringify({
        from: socket.id,
        name, gender, type, message, time, status: "chatting"
      }));
      console.log(`💬 Message from ${socket.id} in ${roomId}:`, message);
    } else {
      console.warn(`⚠️ ${socket.id} tried to send message to invalid room: ${roomId}`);
    }
  });

  // ---------------- Leave Chat ----------------
  socket.on("leave_chat", (data) => {
    let parsedData = data;
    if (typeof data === "string") {
      try { parsedData = JSON.parse(data); } catch { return; }
    }
    const { roomId } = parsedData;
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

    // Notify rooms
    for (let [roomId, sockets] of rooms) {
      if (sockets.includes(socket.id)) {
        rooms.delete(roomId);
        socket.to(roomId).emit("chat_response", JSON.stringify({ status: "partner_left", message: "Your partner disconnected." }));
      }
    }
  });

});

// ---------------- Start Server ----------------
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
