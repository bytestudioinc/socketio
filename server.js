const express = require("express");
const http = require("http");
const { Server } = require("socket.io"); // Strict v4 import

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO v4
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 10000;

console.log("🚀 Starting Socket.IO v4 Server...");

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
    userId: user.userId || user.socketId
  };
}

// v4: Get socket instance
function getSocketById(socketId) {
  return io.sockets.sockets.get(socketId);
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
    const str = JSON.stringify(payload); // We keep sending strings as per your client logic
    socket.emit(event, str);
    console.log(`📤 Sent '${event}' to ${socket.id}`);
  } catch (e) {
    console.warn("⚠️ sendToClient failed:", e);
  }
}

// ---------------- Emit to room (Strict v4) ----------------
function emitToRoomOnce(roomId, event, payload) {
  // v4: io.to(roomId).emit(...) broadcasts to everyone in the room automatically
  // But since your client expects a JSON string, we stringify first.
  const str = JSON.stringify(payload);
  io.to(roomId).emit(event, str);
  console.log(`📤 Broadcast '${event}' to room ${roomId}`);
}

// ---------------- Clean socket from all rooms ----------------
function cleanSocketFromAllRooms(socketId) {
  const socket = getSocketById(socketId);
  if (!socket) return;

  // v4: socket.rooms is a Set containing the socketId itself + rooms
  socket.rooms.forEach(room => {
    if (room !== socketId) {
      socket.leave(room);
    }
  });
  
  // Cleanup our internal map
  for (let [rid, members] of rooms) {
    if (members.includes(socketId)) {
        const newMembers = members.filter(id => id !== socketId);
        if (newMembers.length === 0) rooms.delete(rid);
        else rooms.set(rid, newMembers);
    }
  }
}

function isSocketInRoom(socketId, roomId) {
  const socket = getSocketById(socketId);
  if (!socket) return false;
  return socket.rooms.has(roomId);
}

// ---------------- Socket.IO Logic ----------------
io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  // Server ready response
  sendToClient(socket, "server_ready", {
    state: "ready",
    version: "1.0.0",
    reward: 5,
    preferenceCost: 10,
    maintenance: "no",
    url: "https://play.google.com/store/apps/details?id=com.byte.strangerchat"
  });

  // ---------------- Find Match ----------------
  socket.on("find", (data) => {
    const parsed = parseClientData(data);
    console.log(`📥 Received 'find' from ${socket.id}`);

    parsed.socketId = socket.id;
    parsed.gender = normalizeGenderPref(parsed.gender);
    parsed.preference = normalizeGenderPref(parsed.preference);
    parsed.userId = parsed.userId || socket.id;

    if (searchingUsers.has(socket.id)) {
      const oldUser = searchingUsers.get(socket.id);
      if (oldUser._timeout) clearTimeout(oldUser._timeout);
    }

    let matched = null;
    const paidUser = parsed.preference !== "Any";

    // Matchmaking Algorithm
    for (let [otherId, otherUser] of searchingUsers) {
      if (otherId === socket.id) continue;
      
      const otherPaid = otherUser.preference !== "Any";
      const genderMatch = parsed.preference === "Any" || parsed.preference === otherUser.gender;
      const reverseMatch = otherUser.preference === "Any" || otherUser.preference === parsed.gender;

      if (genderMatch && reverseMatch) {
        if (paidUser && otherPaid) { matched = otherUser; break; } // Prioritize double-paid
        if (!matched) matched = otherUser;
      }
    }

    if (matched) {
      const roomId = `${parsed.name}${random8Digit()}${matched.name}`;
      
      // Cleanup previous rooms
      cleanSocketFromAllRooms(socket.id);
      cleanSocketFromAllRooms(matched.socketId);
      
      // Join Room
      socket.join(roomId);
      const matchedSocket = getSocketById(matched.socketId);
      if (matchedSocket) matchedSocket.join(roomId);

      rooms.set(roomId, [socket.id, matched.socketId]);
      console.log(`🎯 Match: ${socket.id} + ${matched.socketId} in room ${roomId}`);

      // Clear Timeouts
      if (parsed._timeout) clearTimeout(parsed._timeout);
      if (matched._timeout) clearTimeout(matched._timeout);
      
      searchingUsers.delete(socket.id);
      searchingUsers.delete(matched.socketId);

      // Notify Clients
      setTimeout(() => {
        sendToClient(socket, "status", {
          state: "match_found",
          roomId,
          partner: getSafeUser(matched)
        });
        if (matchedSocket) {
          sendToClient(matchedSocket, "status", {
            state: "match_found",
            roomId,
            partner: getSafeUser(parsed)
          });
        }
      }, 100);

    } else {
      // No Match Found - Add to Queue
      const timeout = setTimeout(() => {
        if (searchingUsers.has(socket.id)) {
          const msgPool = parsed.preference === "Any" ? timeoutMessagesFree : timeoutMessagesPaid;
          const randomMsg = msgPool[Math.floor(Math.random() * msgPool.length)];
          sendToClient(socket, "status", { state: "timeout", message: randomMsg });
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
    }
  });

  // ---------------- Chat Messaging ----------------
  socket.on("chat_message", (data) => {
    const parsed = parseClientData(data);
    const { roomId, message, type, name, gender, time } = parsed;
    
    if (roomId && isSocketInRoom(socket.id, roomId)) {
      emitToRoomOnce(roomId, "chat_response", {
        status: "chatting",
        roomId,
        from: socket.id, // Client uses this to distinguish own vs partner message
        name,
        gender,
        type,
        message,
        time
      });
    }
  });

  // ---------------- Leave Chat ----------------
  socket.on("leave_chat", (data) => {
    const parsed = parseClientData(data);
    const { roomId } = parsed;

    if (roomId && rooms.has(roomId)) {
      // Notify others in the room BEFORE destroying it
      io.to(roomId).emit("chat_response", JSON.stringify({
        status: "partner_left",
        roomId,
        message: "Your partner left the chat."
      }));

      // Make everyone leave
      io.in(roomId).socketsLeave(roomId);
      rooms.delete(roomId);
    }
  });

  // ---------------- Disconnect ----------------
  socket.on("disconnect", () => {
    console.log(`❌ User disconnected: ${socket.id}`);

    // Remove from search queue
    if (searchingUsers.has(socket.id)) {
      const user = searchingUsers.get(socket.id);
      if (user._timeout) clearTimeout(user._timeout);
      searchingUsers.delete(socket.id);
    }

    // Handle active chats
    // v4: We don't need to manually iterate rooms for this socket, 
    // but our 'rooms' Map needs to be kept in sync.
    for (let [roomId, members] of rooms) {
      if (members.includes(socket.id)) {
        // Notify partner
        io.to(roomId).emit("chat_response", JSON.stringify({
          status: "partner_left",
          roomId,
          message: "Your partner disconnected."
        }));
        
        // Cleanup room map
        const remaining = members.filter(id => id !== socket.id);
        if (remaining.length === 0) rooms.delete(roomId);
        else rooms.set(roomId, remaining);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
