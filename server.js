// server.js
const express = require("express");
const http = require("http");
const app = express();
const server = http.createServer(app);

let io;

// Try v4+ style first
try {
  const { Server } = require("socket.io");
  io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
  });
  console.log("✅ Loaded Socket.IO v3/v4 style");
} catch (e) {
  // Fallback to v2
  const socketIo = require("socket.io");
  io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
  });
  console.log("✅ Loaded Socket.IO v2 style");
}

const PORT = process.env.PORT || 10000;
let searchingUsers = new Map();

io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  // Safe logger for all events
  const oldOn = socket.on;
  socket.on = function (event, listener) {
    oldOn.call(this, event, (data) => {
      console.log(`📩 Event from ${socket.id} =>`, event, data, "Type:", typeof data);
      listener(data);
    });
  };

  // Find partner
  socket.on("find", (userData) => {
    let parsedData = userData;
    if (typeof userData === "string") {
      try {
        parsedData = JSON.parse(userData);
      } catch (err) {
        console.error("❌ Invalid JSON:", err.message);
        socket.emit("status", { state: "error", message: "Invalid data format" });
        return;
      }
    }
    parsedData.socketId = socket.id;

    let matched = null;
    for (let [otherId, otherUser] of searchingUsers) {
      if (otherId !== socket.id) {
        matched = otherUser;
        break;
      }
    }

    if (matched) {
      const roomId = `room_${socket.id}_${matched.socketId}`;
      console.log(`🎯 Match found: ${socket.id} + ${matched.socketId}`);

      socket.join(roomId);
      const matchedSocket = io.sockets.sockets.get
        ? io.sockets.sockets.get(matched.socketId) // v3/v4
        : io.sockets.connected[matched.socketId];  // v2
      matchedSocket?.join(roomId);

      socket.emit("status", { state: "matched", roomId, partner: matched });
      matchedSocket?.emit("status", { state: "matched", roomId, partner: parsedData });

      searchingUsers.delete(socket.id);
      searchingUsers.delete(matched.socketId);
    } else {
      const timeout = setTimeout(() => {
        if (searchingUsers.has(socket.id)) {
          console.log(`⏰ Timeout for ${socket.id}`);
          socket.emit("status", { state: "timeout", message: "Couldn't find a match" });
          searchingUsers.delete(socket.id);
        }
      }, 30000);

      parsedData._timeout = timeout;
      searchingUsers.set(socket.id, parsedData);
      socket.emit("status", { state: "searching", message: "Searching for a partner..." });
    }
  });

  // Cancel search
  socket.on("cancel_search", () => {
    if (searchingUsers.has(socket.id)) {
      const user = searchingUsers.get(socket.id);
      if (user._timeout) clearTimeout(user._timeout);
      searchingUsers.delete(socket.id);
      socket.emit("status", { state: "cancelled", message: "Search cancelled." });
      console.log(`🚫 Cancelled by ${socket.id}`);
    }
  });

  // Disconnect
  socket.on("disconnect", () => {
    console.log(`❌ Disconnected: ${socket.id}`);
    if (searchingUsers.has(socket.id)) {
      const user = searchingUsers.get(socket.id);
      if (user._timeout) clearTimeout(user._timeout);
      searchingUsers.delete(socket.id);
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
