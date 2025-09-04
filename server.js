const express = require("express");
const http = require("http");
const socketIo = require("socket.io");

const app = express();
const server = http.createServer(app);

// ✅ Force v2 compatibility for Kodular Socket.IO
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  allowEIO3: true,
  transports: ["websocket", "polling"],
});

// -------------------------
// Matchmaking Data
// -------------------------
const queues = {
  "male-any": [],
  "female-any": [],
  "male-male": [],
  "male-female": [],
  "female-male": [],
  "female-female": [],
};

const users = new Map();
const rooms = new Map();

// -------------------------
// Socket Handlers
// -------------------------
io.on("connection", (socket) => {
  console.log("✅ User connected:", socket.id);

  // Emit joined event
  socket.emit("status", { type: "joined", socketId: socket.id });

  // User starts searching
  socket.on("find_match", (data) => {
    console.log("🔍 Find match request:", data);

    const user = {
      socketId: socket.id,
      userId: data.userId,
      gender: data.gender,
      preference: data.preference,
      joinedAt: Date.now(),
    };
    users.set(socket.id, user);

    // Try to match
    const queueKey = `${user.gender}-${user.preference}`;
    let matchedUser = null;

    if (user.preference === "any") {
      // Look in gender-specific queues
      const checkQueues = [`male-${user.gender}`, `female-${user.gender}`];
      for (let q of checkQueues) {
        if (queues[q] && queues[q].length > 0) {
          matchedUser = queues[q].shift();
          break;
        }
      }
    } else {
      // Look for exact or "any" match
      const reverseKey = `${user.preference}-${user.gender}`;
      const anyKey = `${user.preference}-any`;
      if (queues[reverseKey] && queues[reverseKey].length > 0) {
        matchedUser = queues[reverseKey].shift();
      } else if (queues[anyKey] && queues[anyKey].length > 0) {
        matchedUser = queues[anyKey].shift();
      }
    }

    if (matchedUser) {
      // ✅ Found a match
      const roomId = `room_${Date.now()}`;
      rooms.set(roomId, {
        users: [socket.id, matchedUser.socketId],
        createdAt: new Date(),
      });

      socket.join(roomId);
      io.sockets.sockets.get(matchedUser.socketId)?.join(roomId);

      console.log("🎯 Match found:", roomId);

      // Notify both users
      socket.emit("status", {
        type: "match_found",
        roomId,
        matchedUser,
      });

      io.to(matchedUser.socketId).emit("status", {
        type: "match_found",
        roomId,
        matchedUser: user,
      });
    } else {
      // ❌ No match, add to queue
      if (!queues[queueKey]) queues[queueKey] = [];
      queues[queueKey].push(user);
      socket.emit("status", { type: "search", message: "Searching..." });
    }
  });

  // Cancel search
  socket.on("cancel_search", () => {
    Object.keys(queues).forEach((key) => {
      queues[key] = queues[key].filter((u) => u.socketId !== socket.id);
    });
    socket.emit("status", { type: "cancelled" });
    console.log("⚠️ Search cancelled:", socket.id);
  });

  // Disconnection cleanup
  socket.on("disconnect", () => {
    console.log("❌ Disconnected:", socket.id);

    users.delete(socket.id);

    Object.keys(queues).forEach((key) => {
      queues[key] = queues[key].filter((u) => u.socketId !== socket.id);
    });

    // If in a room, notify other user
    rooms.forEach((room, roomId) => {
      if (room.users.includes(socket.id)) {
        const otherUser = room.users.find((id) => id !== socket.id);
        if (otherUser) {
          io.to(otherUser).emit("status", {
            type: "disconnected",
            userId: socket.id,
          });
        }
        rooms.delete(roomId);
      }
    });
  });
});

// -------------------------
// Start Server
// -------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
