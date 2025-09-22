// server.js

const express = require("express");
const http = require("http");
const socketIO = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*", // Allow all origins (adjust for prod)
    methods: ["GET", "POST"],
  },
});

// --- Store active matches in memory ---
let searchingUsers = new Map(); // socketId -> { name, gender, timer }
let activeRooms = new Map(); // roomId -> [socketId1, socketId2]

/**
 * Utility to generate roomId
 */
function generateRoomId(socket1, socket2) {
  return `room_${socket1}_${socket2}`;
}

// --- Socket.io logic ---
io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  // Tell the client the server is ready + set timeout
  socket.emit("server_ready", {
    state: "server_ready",
    message: "Connected to server",
    timeout: 60, // seconds
  });

  // --- Find a match ---
  socket.on("find", (data) => {
    console.log(`🔎 Match request from ${socket.id}:`, data);

    // Add user to searching pool
    searchingUsers.set(socket.id, { ...data, socketId: socket.id });

    // Set timeout for matchmaking
    const timer = setTimeout(() => {
      if (searchingUsers.has(socket.id)) {
        searchingUsers.delete(socket.id);
        io.to(socket.id).emit("status", { state: "timeout" });
        console.log(`⌛ Match timeout for ${socket.id}`);
      }
    }, 60000); // 60s timeout

    // Attach timer to user
    searchingUsers.get(socket.id).timer = timer;

    // Try to find a partner
    for (let [otherId, otherUser] of searchingUsers.entries()) {
      if (otherId !== socket.id) {
        // Found match → clear timers
        clearTimeout(searchingUsers.get(socket.id).timer);
        clearTimeout(otherUser.timer);

        const roomId = generateRoomId(socket.id, otherId);
        activeRooms.set(roomId, [socket.id, otherId]);

        socket.join(roomId);
        io.sockets.sockets.get(otherId)?.join(roomId);

        // Notify both users
        io.to(socket.id).emit("status", {
          state: "match_found",
          roomId,
          partner: otherUser,
        });

        io.to(otherId).emit("status", {
          state: "match_found",
          roomId,
          partner: data,
        });

        console.log(`🎉 Match found! Room: ${roomId}`);

        searchingUsers.delete(socket.id);
        searchingUsers.delete(otherId);
        break;
      }
    }
  });

  // --- Chat messaging ---
  socket.on("chat", (payload) => {
    const { roomId, message, name, gender, time } = payload;

    if (!roomId || !message) {
      console.warn(`⚠️ Invalid chat payload from ${socket.id}:`, payload);
      return;
    }

    if (!activeRooms.has(roomId)) {
      console.warn(`⚠️ Room ${roomId} not active for ${socket.id}`);
      return;
    }

    io.to(roomId).emit("chat", {
      roomId,
      name,
      gender,
      message,
      time,
    });

    console.log(`💬 Message in ${roomId}: ${message}`);
  });

  // --- Handle disconnect ---
  socket.on("disconnect", () => {
    console.log(`❌ User disconnected: ${socket.id}`);

    // Cancel timeout if still searching
    if (searchingUsers.has(socket.id)) {
      clearTimeout(searchingUsers.get(socket.id).timer);
      searchingUsers.delete(socket.id);
    }

    // Clean up rooms
    for (let [roomId, participants] of activeRooms.entries()) {
      if (participants.includes(socket.id)) {
        activeRooms.delete(roomId);

        participants.forEach((id) => {
          if (id !== socket.id) {
            io.to(id).emit("status", {
              state: "partner_left",
              roomId,
            });
          }
        });

        console.log(`🗑️ Room ${roomId} closed (user ${socket.id} left)`);
      }
    }
  });
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
