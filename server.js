// server.js
const express = require("express");
const http = require("http");
const app = express();
const server = http.createServer(app);

// Detect Socket.IO version (v4 or fallback to v2)
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

// ---------------- Queues ----------------
// Each queue: [ { userId, name, gender, preference, socketId, coinsUsed, _timeout } ]
const searchingUsers = new Map(); // socketId -> user info
const rooms = new Map(); // roomId -> [socketIds]

// Utility: get socket by ID (v2/v4)
function getSocketById(socketId) {
  if (io.sockets.sockets.get) return io.sockets.sockets.get(socketId);
  return io.sockets.connected[socketId];
}

// Translate short form to full form
function normalizeGender(g) {
  if (!g) return "ANY";
  g = g.toUpperCase();
  if (g === "M") return "MALE";
  if (g === "F") return "FEMALE";
  if (g === "A") return "ANY";
  if (g === "MALE" || g === "FEMALE" || g === "ANY") return g;
  return "ANY";
}

// Generate roomId: user1+random8digit+user2
function generateRoomId(user1, user2) {
  const rand8 = Math.floor(10000000 + Math.random() * 90000000);
  return `${user1}${rand8}${user2}`;
}

// Safe user info (for sending to client)
function getSafeUser(user) {
  return {
    userId: user.userId,
    name: user.name,
    gender: user.gender,
    preference: user.preference
  };
}

// ---------------- Connection ----------------
io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  // Notify client server is ready
  socket.emit("server_ready", JSON.stringify({ state: "ready", userId: socket.id }));

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

    // Normalize gender and preference
    parsedData.gender = normalizeGender(parsedData.gender);
    parsedData.preference = normalizeGender(parsedData.preference);
    parsedData.socketId = socket.id;

    // Default coinsUsed flag if not provided
    parsedData.coinsUsed = parsedData.coinsUsed || false;

    console.log(`📩 Event from ${socket.id} => find:`, parsedData);

    // ---------------- Priority matchmaking ----------------
    let matched = null;
    let matchedSocket = null;

    // Priority 1: find users who also paid coins and match specific gender
    for (let [otherId, otherUser] of searchingUsers) {
      if (otherId === socket.id) continue;

      const canMatch =
        (parsedData.preference === "ANY" || parsedData.preference === otherUser.gender) &&
        (otherUser.preference === "ANY" || otherUser.preference === parsedData.gender);

      // Both users paid coins for specific preference
      if (canMatch && parsedData.coinsUsed && otherUser.coinsUsed && parsedData.preference !== "ANY") {
        matched = otherUser;
        break;
      }
    }

    // Priority 2: match free users or any combination if no priority found
    if (!matched) {
      for (let [otherId, otherUser] of searchingUsers) {
        if (otherId === socket.id) continue;

        const canMatch =
          (parsedData.preference === "ANY" || parsedData.preference === otherUser.gender) &&
          (otherUser.preference === "ANY" || otherUser.preference === parsedData.gender);

        if (canMatch) {
          matched = otherUser;
          break;
        }
      }
    }

    if (matched) {
      const roomId = generateRoomId(parsedData.userId, matched.userId);
      console.log(`🎯 Match found: ${socket.id} + ${matched.socketId} => Room: ${roomId}`);

      socket.join(roomId);
      matchedSocket = getSocketById(matched.socketId);
      if (matchedSocket) matchedSocket.join(roomId);

      rooms.set(roomId, [socket.id, matched.socketId]);

      // Clear timeouts
      if (parsedData._timeout) clearTimeout(parsedData._timeout);
      if (matched._timeout) clearTimeout(matched._timeout);

      // Remove from searching
      searchingUsers.delete(socket.id);
      searchingUsers.delete(matched.socketId);

      // Emit match info
      const currentData = { state: "matched", roomId, partner: getSafeUser(matched) };
      const matchedData = { state: "matched", roomId, partner: getSafeUser(parsedData) };

      socket.emit("status", JSON.stringify(currentData));
      matchedSocket?.emit("status", JSON.stringify(matchedData));
    } else {
      // No match found → add to pool with timeout
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
    let userId = socket.id;
    if (data && typeof data === "string") {
      try { userId = JSON.parse(data).userId || socket.id; } catch {}
    }

    if (searchingUsers.has(userId)) {
      const user = searchingUsers.get(userId);
      if (user._timeout) clearTimeout(user._timeout);
      searchingUsers.delete(userId);
      socket.emit("status", JSON.stringify({ state: "cancelled", message: "Search cancelled." }));
      console.log(`🚫 Search cancelled by ${userId}`);
    }
  });

  // ---------------- Chat Message ----------------
  socket.on("chat_message", (data) => {
    let parsedData = data;
    if (typeof data === "string") {
      try { parsedData = JSON.parse(data); } catch { return; }
    }

    const { roomId, message, type, name, gender, time } = parsedData;
    if (!roomId || !message || !type) return;

    if (rooms.has(roomId) && rooms.get(roomId).includes(socket.id)) {
      // Broadcast to other users in the room
      socket.to(roomId).emit("chat_response", JSON.stringify({
        from: socket.id,
        status: "chatting",
        name, gender, type, message, time
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
        socket.to(roomId).emit("chat_response", JSON.stringify({ status: "partner_left", message: "Your partner disconnected." }));
      }
    }
  });
});

// ---------------- Start Server ----------------
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
