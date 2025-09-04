const express = require("express");
const http = require("http");
const socketIo = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
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

const users = new Map();  // socket.id -> user
const rooms = new Map();  // roomId -> {users: [socketIds]}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // When user starts finding a match
  socket.on("find", (data) => {
    const { userId, name, gender, preference } = data;

    const user = { userId, name, gender, preference, socketId: socket.id };
    users.set(socket.id, user);

    // Determine queue key
    const queueKey = `${gender}-${preference}`;
    let matchedUser = null;

    if (preference === "any") {
      // Look for mutual any-match users
      const checkQueues = ["male-any", "female-any"];
      for (let qKey of checkQueues) {
        for (let i = 0; i < queues[qKey].length; i++) {
          const candidate = queues[qKey][i];
          // Check mutual preference
          if (
            candidate.preference === "any" ||
            candidate.preference === gender
          ) {
            matchedUser = candidate;
            queues[qKey].splice(i, 1);
            break;
          }
        }
        if (matchedUser) break;
      }
    } else {
      // Look for exact match
      const reverseQueueKey = `${preference}-${gender}`;
      const anyQueueKey = `${preference}-any`;

      if (queues[reverseQueueKey] && queues[reverseQueueKey].length > 0) {
        matchedUser = queues[reverseQueueKey].shift();
      } else if (queues[anyQueueKey] && queues[anyQueueKey].length > 0) {
        matchedUser = queues[anyQueueKey].shift();
      }
    }

    if (matchedUser) {
      // ✅ Match found
      const roomId = `room_${Date.now()}`;
      socket.join(roomId);
      io.sockets.sockets.get(matchedUser.socketId)?.join(roomId);
      rooms.set(roomId, { users: [socket.id, matchedUser.socketId] });

      const statusDataForCurrent = {
        state: "match_found",
        message: "Partner found!",
        roomId,
        matchedUser: {
          userId: matchedUser.userId,
          name: matchedUser.name,
          gender: matchedUser.gender
        }
      };

      const statusDataForMatched = {
        state: "match_found",
        message: "Partner found!",
        roomId,
        matchedUser: {
          userId: user.userId,
          name: user.name,
          gender: user.gender
        }
      };

      socket.emit("status", statusDataForCurrent);
      io.to(matchedUser.socketId).emit("status", statusDataForMatched);
    } else {
      // ❌ No match found → push to queue
      if (!queues[queueKey]) queues[queueKey] = [];
      queues[queueKey].push(user);

      socket.emit("status", {
        state: "searching",
        message: "Searching for a partner..."
      });
    }
  });

  // Cancel search
  socket.on("cancel_search", () => {
    Object.keys(queues).forEach((key) => {
      queues[key] = queues[key].filter((u) => u.socketId !== socket.id);
    });
    socket.emit("status", {
      state: "cancelled",
      message: "Search cancelled."
    });
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    users.delete(socket.id);
    Object.keys(queues).forEach((key) => {
      queues[key] = queues[key].filter((u) => u.socketId !== socket.id);
    });
    io.emit("status", {
      state: "disconnected",
      message: "A user disconnected",
      socketId: socket.id
    });
    console.log("User disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
