// server.js

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins, adjust if needed
    methods: ["GET", "POST"],
  },
});

// --- Store active matches in memory ---
let searchingUsers = new Map(); // socketId -> { name, gender }
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

  // Tell the client the server is ready
  socket.emit("server_ready", {
    state: "server_ready",
    message: "Connected to server",
  });

  // --- Find a match ---
  socket.on("find", (data) => {
    console.log(`🔎 Match request from ${socket.id}:`, data);

    // Save user into searching pool
    searchingUsers.set(socket.id, { ...data, socketId: socket.id });

    // Try to find another user
    for (let [otherId, otherUser] of searchingUsers.entries()) {
      if (otherId !== socket.id) {
        // Found a match
        const roomId = generateRoomId(socket.id, otherId);

        activeRooms.set(roomId, [socket.id, otherId]);

        // Join sockets to the room
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
        console.log(`   → ${socket.id} (${data.name})`);
        console.log(`   → ${otherId} (${otherUser.name})`);

        // Remove both from searching pool
        searchingUsers.delete(socket.id);
        searchingUsers.delete(otherId);

        break;
      }
    }
  });

  // --- Chat messaging ---
  socket.on("chat", (payload) => {
    console.log(`💬 Chat event from ${socket.id}:`, payload);

    const { roomId, message, name, gender, time } = payload;

    if (!roomId || !message) {
      console.warn(`⚠️ Invalid chat payload from ${socket.id}:`, payload);
      return;
    }

    if (!activeRooms.has(roomId)) {
      console.warn(`⚠️ Room ${roomId} not active for ${socket.id}`);
      return;
    }

    // Relay the message to the room
    io.to(roomId).emit("chat", {
      roomId,
      name,
      gender,
      message,
      time,
    });

    console.log(`📤 Relayed message to room ${roomId}: ${message}`);
  });

  // --- Handle disconnect ---
  socket.on("disconnect", () => {
    console.log(`❌ User disconnected: ${socket.id}`);

    // Remove from searching
    searchingUsers.delete(socket.id);

    // Remove from rooms
    for (let [roomId, participants] of activeRooms.entries()) {
      if (participants.includes(socket.id)) {
        activeRooms.delete(roomId);

        // Notify other participant
        participants.forEach((id) => {
          if (id !== socket.id) {
            io.to(id).emit("status", {
              state: "partner_left",
              roomId,
            });
          }
        });

        console.log(`🗑️ Room ${roomId} closed because ${socket.id} left`);
      }
    }
  });
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
