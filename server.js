// server.js
const express = require("express");
const http = require("http");
const app = express();
const server = http.createServer(app);

// Initialize Socket.IO safely (v2/v3+ support)
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
  "Someone's chatting, but you'll get your turn. Try again!",
  "Patience, young grasshopper, the match awaits. Try again!",
  "Love is in the air… just not for you yet. Try again!",
  "Good things take time—your match is worth it. Try again!",
  "Your preferred partner is currently away. Try again!",
  "Looks like Cupid is tied up. Try again!",
  "They're busy charming someone else. Try again!"
];
const timeoutMessagesFree = [
  "Everyone's chatting. Hang tight, try again!",
  "No freebirds available. Retry shortly!",
  "All ears are busy. Give it another try!",
  "Cupid is taking a nap. Try again soon!",
  "Good chats come to those who wait. Try again!",
  "Looks like everyone's talking. Try again!",
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
    name: user.name,
    gender: user.gender,
    preference: user.preference,
    userId: user.socketId // Add userId (socketId)
  };
}

function getSocketById(socketId) {
  if (io.sockets.sockets.get) return io.sockets.sockets.get(socketId);
  return io.sockets.connected[socketId];
}

function parseClientData(data) {
  let parsed = {};
  try {
    if (!data) return {};
    if (typeof data === "string") parsed = JSON.parse(data);
    else if (typeof data === "object") parsed = JSON.parse(JSON.stringify(data));
  } catch (e) {
    console.warn("⚠️ parseClientData failed:", e);
  }
  return parsed;
}

function sendToClient(socket, event, payload) {
  try {
    if (!socket) return;
    const str = JSON.stringify(payload);
    socket.emit(event, str);
    console.log(`📤 Sent '${event}' to ${socket.id}: ${str}`);
  } catch (e) {
    console.warn("⚠️ sendToClient failed:", e);
  }
}

// ---------------- Emit to room safely (fixed duplication) ----------------
function emitToRoomOnce(roomId, event, payload) {
  if (!rooms.has(roomId)) return;
  
  const activeSockets = rooms.get(roomId).filter(id => getSocketById(id));
  rooms.set(roomId, activeSockets); // update with only active sockets
  
  activeSockets.forEach(socketId => {
    const targetSocket = getSocketById(socketId);
    if (targetSocket) {
      targetSocket.emit(event, JSON.stringify(payload));
      console.log(`📤 Emitted '${event}' to ${socketId}: ${JSON.stringify(payload)}`);
    }
  });
}

// ---------------- Clean socket from all rooms ----------------
function cleanSocketFromAllRooms(socketId) {
  for (let [existingRoomId, sockets] of rooms) {
    if (sockets.includes(socketId)) {
      const socket = getSocketById(socketId);
      if (socket) {
        socket.leave(existingRoomId);
      }
      const updatedSockets = sockets.filter(id => id !== socketId);
      if (updatedSockets.length === 0) {
        rooms.delete(existingRoomId);
      } else {
        rooms.set(existingRoomId, updatedSockets);
      }
    }
  }
}

// ---------------- Check if socket is in room (version compatible) ----------------
function isSocketInRoom(socketId, roomId) {
  const socket = getSocketById(socketId);
  if (!socket) return false;
  
  // For newer Socket.IO versions
  if (io.sockets.adapter.rooms) {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (room) {
      return room.has(socketId);
    }
  }
  
  // Fallback: check our rooms map
  if (rooms.has(roomId)) {
    return rooms.get(roomId).includes(socketId);
  }
  
  return false;
}

// ---------------- Socket.IO ----------------
io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  // Server ready response (no socketId)
  sendToClient(socket, "server_ready", {
    state: "ready",
    version: "1.13",
    reward: 1,
    preferenceCost: 10,
    maintenance: "no",
    url: "https://play.google.com/store/apps/details?id=com.byte.strangerchat"
  });

  // ---------------- Find Match ----------------
  socket.on("find", (data) => {
    const parsed = parseClientData(data);
    console.log(`📥 Received 'find' from ${socket.id}: ${JSON.stringify(parsed)}`);

    parsed.socketId = socket.id;
    parsed.gender = normalizeGenderPref(parsed.gender);
    parsed.preference = normalizeGenderPref(parsed.preference);

    if (searchingUsers.has(socket.id)) {
      const oldUser = searchingUsers.get(socket.id);
      if (oldUser._timeout) clearTimeout(oldUser._timeout);
    }

    let matched = null;
    const paidUser = parsed.preference !== "Any";

    for (let [otherId, otherUser] of searchingUsers) {
      if (otherId === socket.id) continue;
      const otherPaid = otherUser.preference !== "Any";
      const genderMatch = parsed.preference === "Any" || parsed.preference === otherUser.gender;
      const reverseMatch = otherUser.preference === "Any" || otherUser.preference === parsed.gender;

      if (genderMatch && reverseMatch) {
        if (paidUser && otherPaid) { matched = otherUser; break; }
        if (!matched) matched = otherUser;
      }
    }

    if (matched) {
      const roomId = `${parsed.name}${random8Digit()}${matched.name}`;
      
      // Clean up both sockets from any previous rooms
      cleanSocketFromAllRooms(socket.id);
      cleanSocketFromAllRooms(matched.socketId);
      
      // Join the new room
      socket.join(roomId);
      const matchedSocket = getSocketById(matched.socketId);
      if (matchedSocket) {
        matchedSocket.join(roomId);
      }

      rooms.set(roomId, [socket.id, matched.socketId]);
      console.log(`🎯 Match: ${socket.id} + ${matched.socketId} in room ${roomId}`);

      if (parsed._timeout) clearTimeout(parsed._timeout);
      if (matched._timeout) clearTimeout(matched._timeout);
      searchingUsers.delete(socket.id);
      searchingUsers.delete(matched.socketId);

      setTimeout(() => {
        sendToClient(socket, "status", {
          state: "match_found",
          roomId,
          partner: getSafeUser(matched)
        });
        if (matchedSocket) sendToClient(matchedSocket, "status", {
          state: "match_found",
          roomId,
          partner: getSafeUser(parsed)
        });
      }, 100);
    } else {
      const timeout = setTimeout(() => {
        if (searchingUsers.has(socket.id)) {
          const msgPool = parsed.preference === "Any" ? timeoutMessagesFree : timeoutMessagesPaid;
          const randomMsg = msgPool[Math.floor(Math.random() * msgPool.length)];
          sendToClient(socket, "status", { state: "timeout", message: randomMsg });
          console.log(`⏰ Timeout for ${socket.id}: ${randomMsg}`);
          searchingUsers.delete(socket.id);
        }
      }, 30000);

      parsed._timeout = timeout;
      searchingUsers.set(socket.id, parsed);
      sendToClient(socket, "status", { state: "searching", message: "Searching for a partner..." });
    }
  });

  // ---------------- Cancel Search ----------------
  socket.on("cancel_search", () => {
    if (searchingUsers.has(socket.id)) {
      const user = searchingUsers.get(socket.id);
      if (user._timeout) clearTimeout(user._timeout);
      searchingUsers.delete(socket.id);
      sendToClient(socket, "status", { state: "cancelled", message: "Search cancelled." });
      console.log(`🚫 Search cancelled by ${socket.id}`);
    }
  });

  // ---------------- Chat Messaging ----------------
  socket.on("chat_message", (data) => {
    const parsed = parseClientData(data);
    const { roomId, message, type, name, gender, time } = parsed;
    if (!roomId || !message || !type) return;

    // Verify socket is in room (using our version-compatible function)
    if (isSocketInRoom(socket.id, roomId)) {
      const payload = {
        status: "chatting",
        roomId,
        from: socket.id,
        name,
        gender,
        type,
        message,
        time
      };
      
      // Use our safe emit function
      emitToRoomOnce(roomId, "chat_response", payload);
      console.log(`💬 Message sent in room ${roomId}: ${message}`);
    } else {
      console.warn(`⚠️ ${socket.id} tried to send message to invalid room: ${roomId}`);
    }
  });

  // ---------------- Leave Chat ----------------
  socket.on("leave_chat", (data) => {
    const parsed = parseClientData(data);
    const { roomId } = parsed;
    if (!roomId || !rooms.has(roomId)) return;

    const otherUsers = rooms.get(roomId).filter(id => id !== socket.id);
    otherUsers.forEach(id => {
      const s = getSocketById(id);
      if (s) sendToClient(s, "chat_response", {
        status: "partner_left",
        roomId,
        message: "Your partner left the chat."
      });
    });

    socket.leave(roomId);
    rooms.delete(roomId);
    console.log(`🚪 ${socket.id} voluntarily left room ${roomId}`);
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
        const otherUsers = sockets.filter(id => id !== socket.id);
        
        // Notify other users
        otherUsers.forEach(otherId => {
          const s = getSocketById(otherId);
          if (s) {
            sendToClient(s, "chat_response", {
              status: "partner_left",
              roomId,
              message: "Your partner left the chat."
            });
          }
        });

        // Leave room and update room list
        socket.leave(roomId);
        const updatedSockets = sockets.filter(id => getSocketById(id) && id !== socket.id);
        if (updatedSockets.length === 0) {
          rooms.delete(roomId);
        } else {
          rooms.set(roomId, updatedSockets);
        }
        
        console.log(`🚪 ${socket.id} disconnected from ${roomId}`);
      }
    }
  });
});

// ---------------- Start Server ----------------
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
