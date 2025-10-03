// VERSION 1.15
const express = require("express");
const http = require("http");
const app = express();
const server = http.createServer(app);

let io;
try {
  // Try Socket.IO v3+ style
  const { Server } = require("socket.io");
  io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
  console.log("✅ Using Socket.IO v3/v4");
} catch (e) {
  // Fallback to v2
  const socketIo = require("socket.io");
  io = socketIo(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
  console.log("✅ Using Socket.IO v2 fallback");
}

const PORT = process.env.PORT || 10000;

// ---------------- Users & Rooms ----------------
let searchingUsers = new Map(); // socketId -> user object (contains _timeout, _statusInterval, etc.)
let rooms = new Map();          // roomId -> [socketId1, socketId2]

// ---------------- Timeout / Message Pools ----------------
const MATCH_TIMEOUT_MS = 30000; // 30 seconds
const STATUS_INTERVAL_MS = 5000; // 5 seconds for rotating messages

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
  // preserve original fields if provided by client
  return {
    userId: user.userId,
    name: user.name,
    gender: user.gender,
    preference: user.preference
  };
}

function getSocketById(socketId) {
  // compatible with v3+ and v2
  if (io.sockets && io.sockets.sockets && typeof io.sockets.sockets.get === "function") {
    return io.sockets.sockets.get(socketId);
  }
  return io.sockets && io.sockets.connected ? io.sockets.connected[socketId] : undefined;
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
  // Kodular-safe: always send string
  try {
    if (!socket) return;
    socket.emit(event, JSON.stringify(payload));
  } catch (e) {
    console.warn("⚠️ sendToClient failed:", e);
  }
}

// ---------------- Socket.IO ----------------
io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  // server_ready (no socketId sent)
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
    // store socket id internally; client does not need to keep it
    parsed.socketId = socket.id;
    parsed.gender = normalizeGenderPref(parsed.gender);
    parsed.preference = normalizeGenderPref(parsed.preference);

    console.log(`🔍 find from ${socket.id}:`, parsed);

    let matched = null;
    const paidUser = parsed.preference !== "Any";

    // Try to find a match respecting preference/genders and paid preference
    for (let [otherId, otherUser] of searchingUsers) {
      if (otherId === socket.id) continue;

      const otherPaid = otherUser.preference !== "Any";
      const genderMatch = (parsed.preference === "Any") || (parsed.preference === otherUser.gender);
      const reverseMatch = (otherUser.preference === "Any") || (otherUser.preference === parsed.gender);

      if (genderMatch && reverseMatch) {
        if (paidUser && otherPaid) { matched = otherUser; break; }
        if (!matched) matched = otherUser;
      }
    }

    if (matched) {
      // Clear any timers/intervals for both users so timeout won't fire later
      try { if (matched._timeout) clearTimeout(matched._timeout); } catch(e){}
      try { if (matched._statusInterval) clearInterval(matched._statusInterval); } catch(e){}
      try { if (parsed._timeout) clearTimeout(parsed._timeout); } catch(e){}
      try { if (parsed._statusInterval) clearInterval(parsed._statusInterval); } catch(e){}

      const roomId = `${parsed.name}${random8Digit()}${matched.name}`;
      socket.join(roomId);
      const matchedSocket = getSocketById(matched.socketId);
      if (matchedSocket) matchedSocket.join(roomId);

      rooms.set(roomId, [socket.id, matched.socketId]);
      console.log(`🎯 Match: ${socket.id} + ${matched.socketId} in room ${roomId}`);

      // Emit 'status' (string) to both clients so AmritB/Kodular sees match_found
      sendToClient(socket, "status", { state: "match_found", roomId, partner: getSafeUser(matched) });
      if (matchedSocket) sendToClient(matchedSocket, "status", { state: "match_found", roomId, partner: getSafeUser(parsed) });

      // Also emit 'chat_response' (string) so clients listening to chat_response get an initial payload if desired
      try {
        io.to(roomId).emit("chat_response", JSON.stringify({
          status: "match_found",
          roomId,
          partnerA: getSafeUser(parsed),
          partnerB: getSafeUser(matched)
        }));
      } catch (e) {
        // fallback: send individually
        try { sendToClient(socket, "chat_response", { status: "match_found", roomId, partner: getSafeUser(matched) }); } catch(e){}
        try { if (matchedSocket) sendToClient(matchedSocket, "chat_response", { status: "match_found", roomId, partner: getSafeUser(parsed) }); } catch(e){}
      }

      // Remove both users from searchingUsers
      searchingUsers.delete(socket.id);
      searchingUsers.delete(matched.socketId);
    } else {
      // Not matched: add to searchingUsers and start rotating messages + timeout
      parsed._msgIndex = 0;

      parsed._statusInterval = setInterval(() => {
        if (!searchingUsers.has(socket.id)) {
          try { clearInterval(parsed._statusInterval); } catch (e) {}
          return;
        }
        const pool = (parsed.preference === "Any") ? timeoutMessagesFree : timeoutMessagesPaid;
        const msg = pool[parsed._msgIndex % pool.length];
        parsed._msgIndex++;
        sendToClient(socket, "status", { state: "searching", message: msg });
      }, STATUS_INTERVAL_MS);

      parsed._timeout = setTimeout(() => {
        if (searchingUsers.has(socket.id)) {
          const pool = (parsed.preference === "Any") ? timeoutMessagesFree : timeoutMessagesPaid;
          const randomMsg = pool[Math.floor(Math.random() * pool.length)];
          sendToClient(socket, "status", { state: "timeout", message: randomMsg });
          console.log(`⏰ Timeout for ${socket.id}: ${randomMsg}`);
          // clear the status interval if still present
          try { clearInterval(parsed._statusInterval); } catch(e){}
          searchingUsers.delete(socket.id);
        }
      }, MATCH_TIMEOUT_MS);

      searchingUsers.set(socket.id, parsed);
      // Immediately send initial searching message (optional)
      const initialPool = (parsed.preference === "Any") ? timeoutMessagesFree : timeoutMessagesPaid;
      sendToClient(socket, "status", { state: "searching", message: initialPool[0] });
    }
  });

  // ---------------- Cancel Search ----------------
  socket.on("cancel_search", (data) => {
    // data may be "{}" or empty; we ignore content and use socket.id
    if (searchingUsers.has(socket.id)) {
      const user = searchingUsers.get(socket.id);
      if (user && user._timeout) {
        try { clearTimeout(user._timeout); } catch (e) {}
      }
      if (user && user._statusInterval) {
        try { clearInterval(user._statusInterval); } catch (e) {}
      }
      searchingUsers.delete(socket.id);
      sendToClient(socket, "status", { state: "cancelled", message: "Search cancelled." });
      console.log(`🚫 Search cancelled by ${socket.id}`);
    } else {
      // Still acknowledge the client
      sendToClient(socket, "status", { state: "cancelled", message: "No active search." });
      console.log(`ℹ️ cancel_search received but no active search for ${socket.id}`);
    }
  });

  // ---------------- Chat Messaging ----------------
  socket.on("chat_message", (data) => {
    const parsed = parseClientData(data);
    const { roomId, message, type, name, gender, time } = parsed;

    if (!roomId || !message || !type) {
      console.warn(`⚠️ Invalid chat_message from ${socket.id}:`, parsed);
      return;
    }

    if (rooms.has(roomId) && rooms.get(roomId).includes(socket.id)) {
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
      try {
        io.to(roomId).emit("chat_response", JSON.stringify(payload)); // Kodular-safe string
      } catch (e) {
        try { socket.to(roomId).emit("chat_response", JSON.stringify(payload)); } catch (ee) {}
      }
      console.log(`💬 ${socket.id} in ${roomId}: ${message}`);
    } else {
      console.warn(`⚠️ ${socket.id} tried sending message to invalid room: ${roomId}`);
    }
  });

  // ---------------- Leave Chat ----------------
  socket.on("leave_chat", (data) => {
    const parsed = parseClientData(data);
    const { roomId } = parsed;
    if (!roomId || !rooms.has(roomId)) {
      console.log(`ℹ️ leave_chat from ${socket.id} ignored, invalid room: ${roomId}`);
      return;
    }

    const participants = rooms.get(roomId);
    const otherUsers = participants.filter(id => id !== socket.id);

    otherUsers.forEach(id => {
      const s = getSocketById(id);
      if (s) {
        // partner_left via chat_response with only message field (no extra 'reason' key)
        sendToClient(s, "chat_response", { status: "partner_left", message: "Your partner left the chat.", roomId });
      }
    });

    try { socket.leave(roomId); } catch (e) {}
    rooms.delete(roomId);
    console.log(`🚪 ${socket.id} left room ${roomId}`);
  });

  // ---------------- Disconnect ----------------
  socket.on("disconnect", () => {
    console.log(`❌ User disconnected: ${socket.id}`);

    // If searching, clear timers and remove
    if (searchingUsers.has(socket.id)) {
      const user = searchingUsers.get(socket.id);
      try { if (user._timeout) clearTimeout(user._timeout); } catch(e){}
      try { if (user._statusInterval) clearInterval(user._statusInterval); } catch(e){}
      searchingUsers.delete(socket.id);
      console.log(`ℹ️ Cleared searching info for disconnected ${socket.id}`);
    }

    // If in any room, notify partner(s) via chat_response (partner_left with message only)
    for (let [roomId, participants] of rooms) {
      if (participants.includes(socket.id)) {
        const otherUsers = participants.filter(id => id !== socket.id);
        otherUsers.forEach(id => {
          const s = getSocketById(id);
          if (s) {
            sendToClient(s, "chat_response", { status: "partner_left", message: "Your partner disconnected.", roomId });
          }
        });
        rooms.delete(roomId);
        console.log(`⚡ Notified partner(s) in room ${roomId} about ${socket.id} disconnect`);
      }
    }
  });

}); // io.on connection end

// ---------------- Start Server ----------------
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
