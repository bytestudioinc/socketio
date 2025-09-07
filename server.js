// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // allow all origins for now
  },
});

const PORT = process.env.PORT || 10000;

// In-memory user storage
let searchingUsers = new Map();

io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  // --- UNIVERSAL EVENT LOGGER ---
  if (socket.onAny) {
    // Newer socket.io
    socket.onAny((event, data) => {
      console.log(`📩 Event from ${socket.id} =>`, event, data, "Type:", typeof data);
    });
  } else {
    // Older socket.io (wrap .on)
    const oldOn = socket.on;
    socket.on = function (event, listener) {
      oldOn.call(this, event, (data) => {
        console.log(`📩 Event from ${socket.id} =>`, event, data, "Type:", typeof data);
        listener(data);
      });
    };
  }

  // --- FIND MATCH EVENT ---
  socket.on("find", (userData) => {
    console.log("🔍 Received 'find' with data:", userData);

    // Ensure JSON object
    let parsedData = userData;
    if (typeof userData === "string") {
      try {
        parsedData = JSON.parse(userData);
      } catch (err) {
        console.error("❌ Failed to parse userData:", err.message);
        socket.emit("status", { state: "error", message: "Invalid data format" });
        return;
      }
    }

    parsedData.socketId = socket.id;

    // Store user in searching pool
    searchingUsers.set(socket.id, parsedData);
    console.log("👥 Current searching users:", Array.from(searchingUsers.keys()));

    // Try to find a match
    let matched = null;
    for (let [otherId, otherUser] of searchingUsers) {
      if (otherId !== socket.id) {
        matched = otherUser;
        break;
      }
    }

    if (matched) {
      // Create room
      const roomId = `room_${socket.id}_${matched.socketId}`;
      console.log(`🎯 Match found! Room: ${roomId}`);

      socket.join(roomId);
      const matchedSocket = io.sockets.sockets.get(matched.socketId);
      if (matchedSocket) matchedSocket.join(roomId);

      // Notify both
      socket.emit("status", { state: "matched", roomId, partner: matched });
      matchedSocket?.emit("status", { state: "matched", roomId, partner: parsedData });

      // Remove from pool
      searchingUsers.delete(socket.id);
      searchingUsers.delete(matched.socketId);
    } else {
      // No match, start timeout
      const timeout = setTimeout(() => {
        if (searchingUsers.has(socket.id)) {
          console.log(`⏰ Timeout for user ${socket.id}`);
          socket.emit("status", { state: "timeout", message: "Couldn't find a match" });
          searchingUsers.delete(socket.id);
        }
      }, 30000); // 30s

      // Save timeout handle for cleanup
      parsedData._timeout = timeout;
      searchingUsers.set(socket.id, parsedData);
    }
  });

  // --- DISCONNECT EVENT ---
  socket.on("disconnect", () => {
    console.log(`❌ User disconnected: ${socket.id}`);
    if (searchingUsers.has(socket.id)) {
      const user = searchingUsers.get(socket.id);
      if (user._timeout) clearTimeout(user._timeout);
      searchingUsers.delete(socket.id);
    }
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
