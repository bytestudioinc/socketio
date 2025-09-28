// server.js
const express = require("express");
const http = require("http");
const app = express();
const server = http.createServer(app);

// Initialize Socket.IO safely (v2/v3/v4 compatible)
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
let rooms = new Map();          // roomId -> [socketIds]

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
const timeoutMessagesFree = [
  "Everyone’s chatting. Hang tight, try again!",
  "No freebirds available. Retry shortly!",
  "All ears are busy. Give it another try!",
  "Cupid is taking a nap. Try again soon!",
  "Good chats come to those who wait. Try again!",
  "Looks like everyone’s talking. Try again!",
  "No one is free right now. Try again!",
  "All your potential partners are busy. Try again!"
];

// ---------------- Helper Functions ----------------

function normalizeGenderPref(value) {
  if (!value) return "Any";
  value = value.toString().toUpperCase();
  if (["M", "MALE"].includes(value)) return "Male";
  if (["F", "FEMALE"].includes(value)) return "Female";
  if (["A", "ANY"].includes(value)) return "Any";
  return "Any";
}

function random8Digit() {
  return Math.floor(10000000 + Math.random() * 90000000).toString();
}

function getSafeUser(user) {
  return {
    userId: user.userId,
    name: user.name,
    gender: user.gender,
    preference: user.preference
  };
}

function getSocketById(socketId) {
  if (!socketId) return null;
  if (io.sockets && io.sockets.sockets && typeof io.sockets.sockets.get === "function") {
    return io.sockets.sockets.get(socketId); // v3/v4
  }
  return io.sockets.connected && io.sockets.connected[socketId]; // v2
}

function parseClientData(data) {
  let parsed = {};
  try {
    if (!data) return {};
    if (typeof data === "string") parsed = JSON.parse(data);
    else if (typeof data === "object") parsed = JSON.parse(JSON.stringify(data)); // handle JSONObject from Kodular
  } catch (e) {
    console.warn("⚠️ parseClientData failed:", e);
  }
  return parsed;
}

function sendToClient(socketOrSocketId, event, payload) {
  try {
    // socketOrSocketId can be a socket instance or a socket id
    if (!socketOrSocketId) return;
    if (typeof socketOrSocketId === "string") {
      const s = getSocketById(socketOrSocketId);
      if (s) s.emit(event, JSON.stringify(payload));
    } else {
      socketOrSocketId.emit(event, JSON.stringify(payload));
    }
  } catch (e) {
    console.warn("⚠️ sendToClient failed:", e);
  }
}

// Remove / clean up a room (notify partner(s), make sockets leave, delete room)
function cleanupRoom(roomId, leavingSocketId) {
  const socketsInRoom = rooms.get(roomId);
  if (!socketsInRoom) return;
  console.log(`🧹 Cleaning room ${roomId} due to ${leavingSocketId}`);

  socketsInRoom.forEach((sid) => {
    const s = getSocketById(sid);
    if (!s) return;
    if (sid !== leavingSocketId) {
      sendToClient(s, "chat_response", { status: "partner_left", message: "Your partner left the chat." });
    }
    try { s.leave(roomId); } catch (e) { /* ignore */ }
  });

  rooms.delete(roomId);
  console.log(`🗑 Room ${roomId} removed`);
}

// Remove socket from any rooms it's in and cleanup those rooms
function removeSocketFromAllRooms(socketId) {
  for (let [roomId, socketsInRoom] of Array.from(rooms.entries())) {
    if (socketsInRoom.includes(socketId)) {
      cleanupRoom(roomId, socketId);
    }
  }
}

// Debug helpers
function logSearchingUsers() {
  console.log("🔎 searchingUsers count:", searchingUsers.size);
}
function logRooms() {
  console.log("📦 active rooms:", Array.from(rooms.keys()));
}

// ---------------- Socket.IO ----------------
io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`);
  logSearchingUsers();
  logRooms();

  // send server_ready (static config values included)
  sendToClient(socket, "server_ready", {
    state: "ready",
    userId: socket.id,
    version: "1.13",
    reward: 1,
    preferenceCost: 10,
    maintenance: "no",
    url: "https://play.google.com/store/apps/details?id=com.byte.strangerchat"
  });

  // ---------------- Find Match ----------------
  socket.on("find", (data) => {
    const parsed = parseClientData(data);

    // normalize and set socketId
    parsed.socketId = socket.id;
    parsed.gender = normalizeGenderPref(parsed.gender);
    parsed.preference = normalizeGenderPref(parsed.preference);

    console.log(`📩 find from ${socket.id}:`, { userId: parsed.userId, name: parsed.name, gender: parsed.gender, preference: parsed.preference });

    // Ensure this socket isn't in any old room(s) — clean up previous rooms to prevent ghosts
    removeSocketFromAllRooms(socket.id);

    // ---------------- Matchmaking (priority: specific preference over Any) ----------------
    let matched = null;
    const isPaid = parsed.preference !== "Any";

    for (let [otherSocketId, otherUser] of searchingUsers) {
      if (otherSocketId === socket.id) continue;
      const otherPaid = otherUser.preference !== "Any";
      const genderMatch = (parsed.preference === "Any") || (parsed.preference === otherUser.gender);
      const reverseMatch = (otherUser.preference === "Any") || (otherUser.preference === parsed.gender);
      if (genderMatch && reverseMatch) {
        if (isPaid && otherPaid) { matched = otherUser; break; }
        if (!matched) matched = otherUser;
      }
    }

    if (matched) {
      // clear any timeouts from previously waiting users
      if (matched._timeout) clearTimeout(matched._timeout);
      if (parsed._timeout) clearTimeout(parsed._timeout);

      // remove matched users from searching pool
      searchingUsers.delete(socket.id);
      searchingUsers.delete(matched.socketId);

      // ensure matched user isn't in any other rooms (cleanup)
      removeSocketFromAllRooms(matched.socketId);

      // generate room using names (sanitized simple join)
      const roomId = `${(parsed.name || "user")}${random8Digit()}${(matched.name || "user")}`;

      // join both
      try { socket.join(roomId); } catch (e) {}
      const matchedSocket = getSocketById(matched.socketId);
      if (matchedSocket) try { matchedSocket.join(roomId); } catch (e) {}

      rooms.set(roomId, [socket.id, matched.socketId]);
      console.log(`🎯 Match: ${socket.id} + ${matched.socketId} => ${roomId}`);
      logRooms();

      // send match info
      sendToClient(socket, "status", { state: "match_found", roomId, partner: getSafeUser(matched) });
      if (matchedSocket) sendToClient(matchedSocket, "status", { state: "match_found", roomId, partner: getSafeUser(parsed) });
    } else {
      // add to search pool with timeout
      const timeout = setTimeout(() => {
        if (searchingUsers.has(socket.id)) {
          const pool = parsed.preference === "Any" ? timeoutMessagesFree : timeoutMessagesPaid;
          const msg = pool[Math.floor(Math.random() * pool.length)];
          sendToClient(socket, "status", { state: "timeout", message: msg });
          console.log(`⏰ Timeout for ${socket.id}: ${msg}`);
          searchingUsers.delete(socket.id);
          logSearchingUsers();
        }
      }, 30000);

      parsed._timeout = timeout;
      searchingUsers.set(socket.id, parsed);
      sendToClient(socket, "status", { state: "searching", message: "Searching for a partner..." });
      logSearchingUsers();
    }
  });

  // ---------------- Cancel Search ----------------
  socket.on("cancel_search", () => {
    if (searchingUsers.has(socket.id)) {
      const u = searchingUsers.get(socket.id);
      if (u._timeout) clearTimeout(u._timeout);
      searchingUsers.delete(socket.id);
      sendToClient(socket, "status", { state: "cancelled", message: "Search cancelled." });
      console.log(`🚫 cancel_search by ${socket.id}`);
      logSearchingUsers();
    } else {
      sendToClient(socket, "status", { state: "cancelled", message: "Not currently searching." });
    }
  });

  // ---------------- Chat Messaging ----------------
  socket.on("chat_message", (data) => {
    const parsed = parseClientData(data);
    const { roomId, message, type, name, gender, time } = parsed;
    if (!roomId || !message || !type) {
      console.warn(`⚠️ Invalid chat_message from ${socket.id}`, parsed);
      return;
    }

    const participants = rooms.get(roomId);
    if (!participants || !participants.includes(socket.id)) {
      console.warn(`⚠️ ${socket.id} tried to send to invalid/unknown room ${roomId}`);
      return;
    }

    // send directly to each partner socket to avoid room ghost duplication
    let recipients = 0;
    for (const sid of participants) {
      if (sid === socket.id) continue;
      const s = getSocketById(sid);
      if (s) {
        sendToClient(s, "chat_response", {
          status: "chatting",
          croomId: socket.roomId,
          from: socket.id,
          name,
          gender,
          type,
          message,
          time
        });
        recipients++;
        console.log(`📨 Delivered chat from ${socket.id} to ${sid} in ${roomId}`);
      } else {
        console.log(`⚠️ recipient ${sid} socket not found for room ${roomId}`);
      }
    }
    console.log(`💬 [${roomId}] ${socket.id} -> ${recipients} recipient(s): ${message}`);
  });

  // ---------------- Leave Chat ----------------
  socket.on("leave_chat", (data) => {
    const parsed = parseClientData(data);
    const { roomId } = parsed;
    if (!roomId) return;
    if (!rooms.has(roomId)) return;

    console.log(`🚪 leave_chat by ${socket.id} for room ${roomId}`);
    cleanupRoom(roomId, socket.id);
    logRooms();
  });

  // ---------------- Disconnect ----------------
  socket.on("disconnect", (reason) => {
    console.log(`❌ disconnect: ${socket.id} reason: ${reason}`);
    // remove from searching pool
    if (searchingUsers.has(socket.id)) {
      const u = searchingUsers.get(socket.id);
      if (u._timeout) clearTimeout(u._timeout);
      searchingUsers.delete(socket.id);
      logSearchingUsers();
    }

    // cleanup rooms where this socket is a participant
    removeSocketFromAllRooms(socket.id);
    logRooms();
  });
});

// ---------------- Start Server ----------------
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
