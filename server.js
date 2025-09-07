// server.js
const express = require("express");
const http = require("http");
const app = express();
const server = http.createServer(app);

let io;

// Detect v4 or fallback to v2
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
let searchingUsers = new Map();

// Helper to get socket object safely (v2 or v4)
function getSocketById(socketId) {
  if (io.sockets.sockets.get) return io.sockets.sockets.get(socketId); // v4
  return io.sockets.connected[socketId]; // v2
}

io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  // Universal logger
  const oldOn = socket.on;
  socket.on = function (event, listener) {
    oldOn.call(this, event, (data) => {
      console.log(`📩 Event from ${socket.id} =>`, event, data, "Type:", typeof data);
      listener(data);
    });
  };

  // Find match
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

    parsedData.socketId = socket.id;

    // Try to find match
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
      const matchedSocket = getSocketById(matched.socketId);
      if (matchedSocket) matchedSocket.join(roomId);

      // Send match status as JSON string
      socket.emit("status", JSON.stringify({ state: "matched", roomId, partner: matched }));
      matchedSocket?.emit("status", JSON.stringify({ state: "matched", roomId, partner: parsedData }));

      searchingUsers.delete(socket.id);
      searchingUsers.delete(matched.socketId);
    } else {
      // Add to search pool with 30s timeout
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

  // Cancel search
  socket.on("cancel_search", () => {
    if (searchingUsers.has(socket.id)) {
      const user = searchingUsers.get(socket.id);
      if (user._timeout) clearTimeout(user._timeout);
      searchingUsers.delete(socket.id);
      socket.emit("status", JSON.stringify({ state: "cancelled", message: "Search cancelled." }));
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
