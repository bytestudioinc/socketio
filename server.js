const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// 👇 v4 server but allowEIO3 for Kodular (old v2 clients)
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  allowEIO3: true
});

// Queues for different preference combinations
const queues = {
  "male-any": [],
  "female-any": [],
  "male-male": [],
  "male-female": [],
  "female-male": [],
  "female-female": []
};

const users = new Map();
const rooms = new Map();

io.on("connection", (socket) => {
  console.log("✅ User connected:", socket.id);

  // User sends details when they join
  socket.on("user_join", (userData) => {
    users.set(socket.id, {
      userId: userData.userId,
      gender: userData.gender,
      socketId: socket.id
    });

    socket.emit("status", { type: "joined", userId: userData.userId });
  });

  // User starts searching
  socket.on("find_match", (data) => {
    const user = users.get(socket.id);
    if (!user) return;

    const queueKey = `${user.gender}-${data.preference}`;
    let matchedUser = null;

    if (data.preference === "any") {
      // Check opposite queues first
      const checkQueues = [
        `male-${user.gender}`,
        `female-${user.gender}`,
        `${user.gender}-any`
      ];

      for (let qKey of checkQueues) {
        if (queues[qKey] && queues[qKey].length > 0) {
          matchedUser = queues[qKey].shift();
          break;
        }
      }
    } else {
      const reverseQueueKey = `${data.preference}-${user.gender}`;
      const anyQueueKey = `${data.preference}-any`;

      if (queues[reverseQueueKey]?.length > 0) {
        matchedUser = queues[reverseQueueKey].shift();
      } else if (queues[anyQueueKey]?.length > 0) {
        matchedUser = queues[anyQueueKey].shift();
      }
    }

    if (matchedUser) {
      // Create a room
      const roomId = `room_${Date.now()}`;
      socket.join(roomId);
      io.sockets.sockets.get(matchedUser.socketId)?.join(roomId);

      rooms.set(roomId, {
        users: [socket.id, matchedUser.socketId],
        createdAt: new Date()
      });

      // Notify both users
      socket.emit("status", {
        type: "match_found",
        roomId,
        matchedUser
      });

      io.to(matchedUser.socketId).emit("status", {
        type: "match_found",
        roomId,
        matchedUser: user
      });
    } else {
      // Add user to queue
      if (!queues[queueKey]) queues[queueKey] = [];
      queues[queueKey].push({
        userId: user.userId,
        gender: user.gender,
        socketId: socket.id,
        joinedAt: Date.now()
      });

      socket.emit("status", { type: "searching" });
    }
  });

  // User cancels search
  socket.on("cancel_search", () => {
    Object.keys(queues).forEach((key) => {
      queues[key] = queues[key].filter((u) => u.socketId !== socket.id);
    });
    socket.emit("status", { type: "cancelled" });
  });

  // User disconnects
  socket.on("disconnect", () => {
    users.delete(socket.id);
    Object.keys(queues).forEach((key) => {
      queues[key] = queues[key].filter((u) => u.socketId !== socket.id);
    });

    socket.emit("status", { type: "disconnected" });
    console.log("❌ User disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
