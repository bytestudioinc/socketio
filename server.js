// server.js
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 10000;

// ------------------ DATA STRUCTURES ------------------
let searchingUsers = new Map(); // socketId -> user data
let rooms = new Map();          // roomId -> [socketIds]

// ------------------ UTILITY FUNCTIONS ------------------

// Normalize input gender/preference and capitalize properly
function normalizeGenderPref(input) {
  if (!input) return "Any";
  input = input.toString().trim().toUpperCase();
  if (input === "M" || input === "MALE") return "Male";
  if (input === "F" || input === "FEMALE") return "Female";
  if (input === "A" || input === "ANY") return "Any";
  return "Any";
}

// Generate roomId in the form: name1 + random 6-8 digits + name2
function generateRoomId(name1, name2) {
  const randomDigits = Math.floor(100000 + Math.random() * 900000); // 6 digits
  return `${name1}${randomDigits}${name2}`;
}

// Safe user object to send in responses (remove internal fields)
function getSafeUser(user) {
  return {
    userId: user.userId,
    name: user.name,
    gender: user.gender,
    preference: user.preference
  };
}

// Get socket safely for v3/v4 and v2 compatibility
function getSocketById(socketId) {
  if (io.sockets.sockets.get) return io.sockets.sockets.get(socketId);
  return io.sockets.connected[socketId];
}

// ------------------ SOCKET.IO EVENTS ------------------
io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  // Notify client that server is ready and provide socketId/userId
  socket.emit("server_ready", JSON.stringify({ state: "ready", userId: socket.id }));

  // ---------------- FIND MATCH ----------------
  // Input data: { userId, name, gender, preference }
  socket.on("find", (data) => {
    let parsedData = data;
    if (typeof data === "string") {
      try { parsedData = JSON.parse(data); } 
      catch (err) {
        console.error("❌ Invalid JSON in find:", err.message);
        socket.emit("status", JSON.stringify({ state: "error", message: "Invalid data format" }));
        return;
      }
    }

    // Normalize gender and preference
    parsedData.gender = normalizeGenderPref(parsedData.gender);
    parsedData.preference = normalizeGenderPref(parsedData.preference);
    parsedData.socketId = socket.id;

    // ---------------- PRIORITIZE PAID USERS ----------------
    let matched = null;
    const paidUsers = [];   // users with specific preference (Male/Female)
    const freeUsers = [];   // users with Any preference

    for (let [otherId, otherUser] of searchingUsers) {
      if (otherId === socket.id) continue;
      if (otherUser.preference !== "Any") paidUsers.push(otherUser);
      else freeUsers.push(otherUser);
    }

    // Paid user matching first if current user preference is specific
    if (parsedData.preference !== "Any" && paidUsers.length > 0) {
      matched = paidUsers[0];
    } else if (freeUsers.length > 0) {
      matched = freeUsers[0];
    } else if (paidUsers.length > 0) {
      matched = paidUsers[0];
    }

    if (matched) {
      const roomId = generateRoomId(parsedData.name, matched.name);
      console.log(`🎯 Match found: ${socket.id} + ${matched.socketId} => ${roomId}`);

      socket.join(roomId);
      const matchedSocket = getSocketById(matched.socketId);
      if (matchedSocket) matchedSocket.join(roomId);

      rooms.set(roomId, [socket.id, matched.socketId]);

      socket.emit("status", JSON.stringify({ state: "match_found", roomId, partner: getSafeUser(matched) }));
      matchedSocket?.emit("status", JSON.stringify({ state: "match_found", roomId, partner: getSafeUser(parsedData) }));

      // Remove from searching pool
      searchingUsers.delete(socket.id);
      searchingUsers.delete(matched.socketId);
    } else {
      // No match found → add to pool with 30s timeout
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

  // ---------------- CANCEL SEARCH ----------------
  // Input data: { userId } (optional, server can identify by socket.id)
  socket.on("cancel_search", (data) => {
    const user = searchingUsers.get(socket.id);
    if (user) {
      if (user._timeout) clearTimeout(user._timeout);
      searchingUsers.delete(socket.id);
      console.log(`🚫 Search cancelled by ${socket.id}`);
      socket.emit("status", JSON.stringify({ state: "cancelled", message: "Search cancelled." }));
    }
  });

  // ---------------- CHAT MESSAGE ----------------
  // Input data: { roomId, name, gender, type, message, time }
  socket.on("chat_message", (data) => {
    let parsedData = data;
    if (typeof data === "string") {
      try { parsedData = JSON.parse(data); } catch { return; }
    }

    const { roomId, message, type, name, gender, time } = parsedData;
    if (!roomId || !message || !type) return;

    if (rooms.has(roomId) && rooms.get(roomId).includes(socket.id)) {
      socket.to(roomId).emit("chat_response", JSON.stringify({
        status: "chatting",
        from: socket.id,
        name,
        gender: normalizeGenderPref(gender),
        type,
        message,
        time
      }));
      console.log(`💬 Message from ${socket.id} in ${roomId}: ${message}`);
    } else {
      console.warn(`⚠️ ${socket.id} tried to send message to invalid room: ${roomId}`);
    }
  });

  // ---------------- LEAVE CHAT ----------------
  // Input data: { roomId }
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

  // ---------------- DISCONNECT ----------------
  socket.on("disconnect", () => {
    console.log(`❌ User disconnected: ${socket.id}`);

    // Remove from searching pool
    if (searchingUsers.has(socket.id)) {
      const user = searchingUsers.get(socket.id);
      if (user._timeout) clearTimeout(user._timeout);
      searchingUsers.delete(socket.id);
    }

    // Remove user from rooms and notify partner
    for (let [roomId, sockets] of rooms) {
      if (sockets.includes(socket.id)) {
        rooms.delete(roomId);
        socket.to(roomId).emit("chat_response", JSON.stringify({ status: "partner_left", message: "Your partner left the chat." }));
      }
    }
  });
});

// ------------------ START SERVER ------------------
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
