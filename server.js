// server.js
const express = require("express");
const http = require("http");
const socketIoModule = require("socket.io"); // require module (v2-v4 compatible)
const app = express();
const server = http.createServer(app);

// initialize io robustly for both v2 and v3/v4
const ioOptions = { cors: { origin: "*", methods: ["GET", "POST"] } };
let io;
if (typeof socketIoModule === "function") {
  // socket.io v2 style: module is a function
  io = socketIoModule(server, ioOptions);
  console.log("✅ socket.io: v2-style initialization");
} else if (socketIoModule && typeof socketIoModule.Server === "function") {
  // v3/v4 style: has Server constructor property
  io = new socketIoModule.Server(server, ioOptions);
  console.log("✅ socket.io: v3/v4-style initialization");
} else {
  // fallback (very unlikely)
  throw new Error("Unsupported socket.io module export.");
}

const PORT = process.env.PORT || 10000;

// In-memory stores
const searchingUsers = new Map(); // socket.id -> { userId, name, gender, preference, socketId, _timeout }
const rooms = new Map(); // roomId -> [socketId1, socketId2]

// Helper: safe get socket by socketId (works for v2/v4)
function getSocketById(socketId) {
  if (!socketId) return null;
  if (io.sockets && io.sockets.sockets && typeof io.sockets.sockets.get === "function") {
    return io.sockets.sockets.get(socketId); // v3/v4
  }
  return io.sockets.connected && io.sockets.connected[socketId]; // v2
}

// Helper: normalize gender/preference supporting short forms & capitals
function normalizeGenderPref(value, field) {
  if (value === undefined || value === null) return null;
  const v = String(value).trim().toUpperCase();
  if (field === "gender") {
    if (v === "M" || v === "MALE") return "male";
    if (v === "F" || v === "FEMALE") return "female";
    return null;
  }
  if (field === "preference") {
    if (v === "A" || v === "ANY") return "any";
    if (v === "M" || v === "MALE") return "male";
    if (v === "F" || v === "FEMALE") return "female";
    return null;
  }
  return null;
}

// Helper: safe partner object to send to clients (no circular fields)
function safePartner(userObj) {
  return {
    userId: userObj.userId,
    name: userObj.name,
    gender: userObj.gender,
    preference: userObj.preference
  };
}

// Helper: generate roomId = user1 + random8digit + user2
function generateRoomId(user1, user2) {
  const rand = Math.floor(10000000 + Math.random() * 90000000); // 8-digit
  return `${user1}${rand}${user2}`;
}

// Log incoming event wrapper for debugging
function logIncoming(socket, event, data) {
  console.log(`📩 Event from ${socket.id} => ${event}`, data, "Type:", typeof data);
}

// Connection handler
io.on("connection", (socket) => {
  console.log("✅ User connected:", socket.id);

  // send server_ready with userId (socket.id). Kodular can store this.
  socket.emit("server_ready", JSON.stringify({ userId: socket.id }));
  console.log(`📡 server_ready sent to ${socket.id} (userId=${socket.id})`);

  // --- FIND (matchmaking) ---
  // Input expected (stringified or object): { userId?, name, gender, preference }
  socket.on("find", (raw) => {
    logIncoming(socket, "find", raw);
    let data = raw;
    if (typeof raw === "string") {
      try { data = JSON.parse(raw); } catch (err) {
        console.error("❌ find: invalid JSON", err);
        socket.emit("status", JSON.stringify({ state: "error", message: "Invalid JSON" }));
        return;
      }
    }

    const name = data.name || "";
    const userId = data.userId || socket.id; // prefer provided userId but fallback to socket.id
    const gender = normalizeGenderPref(data.gender, "gender");
    const preference = normalizeGenderPref(data.preference, "preference");

    if (!name || !gender || !preference) {
      console.warn("⚠️ find: missing or invalid fields", { name, gender, preference });
      socket.emit("status", JSON.stringify({ state: "error", message: "Invalid input (name/gender/preference required)" }));
      return;
    }

    // create user object stored by socket.id
    const user = { userId, name, gender, preference, socketId: socket.id };

    // try to find a mutual match
    let matched = null;
    for (let [otherSocketId, otherUser] of searchingUsers) {
      if (otherSocketId === socket.id) continue; // skip self

      const otherPref = otherUser.preference;
      const otherGender = otherUser.gender;

      const thisPrefOk = (preference === "any") || (preference === otherGender);
      const otherPrefOk = (otherPref === "any") || (otherPref === gender);

      if (thisPrefOk && otherPrefOk) {
        matched = otherUser;
        break;
      }
    }

    if (matched) {
      // match found
      const roomId = generateRoomId(user.userId, matched.userId);
      console.log(`🎯 Match found: ${user.userId} <-> ${matched.userId}  room:${roomId}`);

      socket.join(roomId);
      const matchedSocketInstance = getSocketById(matched.socketId);
      if (matchedSocketInstance) matchedSocketInstance.join(roomId);

      rooms.set(roomId, [socket.id, matched.socketId]);

      // emit match info as JSON string (Kodular expects string)
      socket.emit("status", JSON.stringify({ state: "matched", roomId, partner: safePartner(matched) }));
      matchedSocketInstance?.emit("status", JSON.stringify({ state: "matched", roomId, partner: safePartner(user) }));

      // cleanup any timeouts if existed on the matched user (safety)
      if (matched._timeout) clearTimeout(matched._timeout);
      searchingUsers.delete(socket.id);
      searchingUsers.delete(matched.socketId);
    } else {
      // add to search pool with timeout
      const timeoutId = setTimeout(() => {
        if (searchingUsers.has(socket.id)) {
          console.log(`⏰ Timeout: couldn't find match for ${user.userId}`);
          socket.emit("status", JSON.stringify({ state: "timeout", message: "Couldn't find a match" }));
          searchingUsers.delete(socket.id);
        }
      }, 30000);

      user._timeout = timeoutId;
      searchingUsers.set(socket.id, user);
      socket.emit("status", JSON.stringify({ state: "searching", message: "Searching for a partner..." }));
      console.log(`⌛ Added to search pool: ${user.userId} (socket ${socket.id})`);
    }
  });

  // --- cancel_search (voluntary) ---
  // Input optionally: { userId } (string or object allowed). Server uses socket.id if not provided.
  socket.on("cancel_search", (raw) => {
    logIncoming(socket, "cancel_search", raw);
    let data = raw;
    if (typeof raw === "string" && raw.trim() !== "") {
      try { data = JSON.parse(raw); } catch { data = {}; }
    }
    const userId = (data && data.userId) ? data.userId : socket.id;

    // find and remove the searching user by socket.id or userId
    let removed = false;
    for (let [sId, user] of searchingUsers) {
      if (sId === socket.id || user.userId === userId) {
        if (user._timeout) clearTimeout(user._timeout);
        searchingUsers.delete(sId);
        removed = true;
        console.log(`🚫 cancel_search: removed ${user.userId} (socket ${sId})`);
        break;
      }
    }

    socket.emit("status", JSON.stringify({ state: "cancelled", message: removed ? "Search cancelled." : "Not in search." }));
  });

  // --- chat_message (send message within room) ---
  // Input: { roomId, name, gender, type, message, time } OR JSON string
  socket.on("chat_message", (raw) => {
    logIncoming(socket, "chat_message", raw);
    let data = raw;
    if (typeof raw === "string") {
      try { data = JSON.parse(raw); } catch (err) {
        console.error("❌ chat_message: invalid JSON from", socket.id);
        return;
      }
    }

    let { roomId, name, gender, type, message, time } = data || {};
    if (!roomId || !message) {
      console.warn("⚠️ chat_message: missing roomId or message", data);
      return;
    }

    // default type to "text" if missing
    if (!type) type = "text";

    // Ensure sender is in room
    const room = rooms.get(roomId);
    if (!room || !room.includes(socket.id)) {
      console.warn(`⚠️ chat_message: ${socket.id} not in room ${roomId}`);
      return;
    }

    // emit chat_response as JSON string to other members
    const payload = { status: "chatting", from: socket.id, name, gender, type, message, time };
    socket.to(roomId).emit("chat_response", JSON.stringify(payload));
    console.log(`💬 [${roomId}] ${socket.id}:`, message);
  });

  // --- leave_chat (voluntary) ---
  // Input: { roomId, userId? } (string or object)
  socket.on("leave_chat", (raw) => {
    logIncoming(socket, "leave_chat", raw);
    let data = raw;
    if (typeof raw === "string" && raw.trim() !== "") {
      try { data = JSON.parse(raw); } catch { data = {}; }
    }
    const roomId = data && data.roomId ? data.roomId : null;
    if (!roomId || !rooms.has(roomId)) return;

    const socketsInRoom = rooms.get(roomId) || [];
    const otherSockets = socketsInRoom.filter(sid => sid !== socket.id);
    otherSockets.forEach(sid => {
      const s = getSocketById(sid);
      s?.emit("chat_response", JSON.stringify({ status: "partner_left", from: socket.id }));
    });

    socket.leave(roomId);
    rooms.delete(roomId);
    console.log(`🚪 ${socket.id} left room ${roomId}`);
  });

  // --- disconnect (automatic) ---
  socket.on("disconnect", (reason) => {
    console.log(`❌ disconnect: ${socket.id} Reason:`, reason);

    // remove from searching pool if present
    if (searchingUsers.has(socket.id)) {
      const u = searchingUsers.get(socket.id);
      if (u._timeout) clearTimeout(u._timeout);
      searchingUsers.delete(socket.id);
      console.log(`🗑️ removed from search pool: ${socket.id}`);
    }

    // notify partner(s) in any room and cleanup
    for (let [roomId, socketsInRoom] of rooms) {
      if (socketsInRoom.includes(socket.id)) {
        // notify others
        socket.to(roomId).emit("chat_response", JSON.stringify({ status: "disconnected", from: socket.id, message: "Your partner disconnected." }));
        // remove room
        rooms.delete(roomId);
        console.log(`💔 Room ${roomId} closed due to disconnect of ${socket.id}`);
      }
    }
  });

  // (optional) you can listen to other events for debugging
  // socket.onAny((event, data) => { logIncoming(socket, event, data); });
});

// start server
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
