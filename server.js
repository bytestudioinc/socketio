// server.js
const express = require("express");
const http = require("http");

let socketIo;
try {
  // Try new import style (v3/v4+)
  socketIo = require("socket.io").Server;
} catch (e) {
  // Fallback for v2
  socketIo = require("socket.io");
}

const app = express();
const server = http.createServer(app);

// Detect Socket.IO version
let io;
if (typeof socketIo === "function" && socketIo.length === 1) {
  // v2 style
  io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
  });
  console.log("✅ Running with Socket.IO v2");
} else {
  // v3/v4 style
  io = new socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
  });
  console.log("✅ Running with Socket.IO v3/v4");
}

const PORT = process.env.PORT || 10000;

// Store searching users
let searchingUsers = new Map();

io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  // Universal logger for debugging
  const registerLogger = (sock) => {
    if (sock.onAny) {
      // v3/v4
      sock.onAny((event, data) => {
        console.log(`📩 Event from ${sock.id} =>`, event, data, "Type:", typeof data);
      });
    } else {
      // v2 fallback: wrap socket.on
      const oldOn = sock.on;
      sock.on = function (event, listener) {
        oldOn.call(this, event, (data) => {
          console.log(`📩 Event from ${sock.id} =>`, event, data, "Type:", typeof data);
          listener(data);
        });
      };
    }
  };
  registerLogger(socket);

  // Handle find request
  socket.on("find", (userData) => {
    console.log("🔍 Received 'find' with data:", userData);

    // Parse if JSON string
    let parsedData = userData;
    if (typeof userData === "string") {
      try {
        parsedData = JSON.parse(userData);
      } catch (err) {
        console.error("❌ Invalid JSON from user:", err.message);
        socket.emit("status", { state: "error", message: "Invalid data format" });
        return;
      }
    }

    parsedData.socketId = socket.id;

    // Try to match with someone already searching
    let matched = null;
    for (let [otherId, otherUser] of searchingUsers) {
      if (otherId !== socket.id) {
        matched = otherUser;
        break;
      }
    }

    if (matched) {
      // ✅ Match found
      const roomId = `room_${socket.id}_${matched.socketId}`;
      console.log(`🎯 Match found: ${socket.id} + ${matched.socketId} in ${roomId}`);

      socket.join(roomId);

      const matchedSocket = io.sockets.sockets.get
        ? io.sockets.sockets.get(matched.socketId) // v4
        : io.sockets.connected[matched.socketId];  // v2

      if (matchedSocket) matchedSocket.join(roomId);

      socket.emit("status", { state: "matched", roomId, partner: matched });
      matchedSocket?.emit("status", { state: "matched", roomId, partner: parsedData });

      searchingUsers.delete(socket.id);
      searchingUsers.delete(matched.socketId);
    } else {
      // ❌ No match yet → add to search pool with timeout
      const timeout = setTimeout(() => {
        if (searchingUsers.has(socket.id)) {
          console.log(`⏰ Timeout for ${socket.id}`);
          socket.emit("status", { state: "timeout", message: "Couldn't find a match" });
          searchingUsers.delete(socket.id);
        }
      }, 30000); // 30 sec timeout

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
      console.log(`🚫 Search cancelled by ${socket.id}`);
    }
  });

  // Handle disconnect
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
