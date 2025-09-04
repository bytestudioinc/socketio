const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// Queues for matchmaking
const queues = {
  "male-any": [],
  "female-any": [],
  "male-male": [],
  "male-female": [],
  "female-male": [],
  "female-female": [],
};

// Map of connected users
const users = new Map();

// Rooms
const rooms = new Map();

// Helper function to find mutual match
function findMutualMatch(user) {
  let matchedUser = null;

  const { gender, preference } = user;

  // If user wants any
  if (preference === "any") {
    // Check any opposite or same gender queue
    const possibleQueues = [
      `male-any`,
      `female-any`,
      `male-male`,
      `female-female`,
      `male-female`,
      `female-male`,
    ];

    for (let qKey of possibleQueues) {
      for (let i = 0; i < queues[qKey].length; i++) {
        const candidate = queues[qKey][i];
        // Mutual check
        if (
          candidate.preference === "any" ||
          candidate.preference === gender
        ) {
          matchedUser = queues[qKey].splice(i, 1)[0];
          return matchedUser;
        }
      }
    }
  } else {
    // Specific preference
    const reverseQueueKey = `${preference}-${gender}`;
    const anyQueueKey = `${preference}-any`;

    if (queues[reverseQueueKey] && queues[reverseQueueKey].length > 0) {
      matchedUser = queues[reverseQueueKey].shift();
    } else if (queues[anyQueueKey] && queues[anyQueueKey].length > 0) {
      matchedUser = queues[anyQueueKey].shift();
    }
  }

  return matchedUser;
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // When user starts searching
  socket.on("status.search", (data) => {
    const { userId, name, gender, preference } = data;

    const user = { userId, name, gender, preference, socketId: socket.id };
    users.set(socket.id, user);

    const matchedUser = findMutualMatch(user);

    if (matchedUser) {
      // Create room
      const roomId = `room_${Date.now()}`;
      socket.join(roomId);
      io.sockets.sockets[matchedUser.socketId].join(roomId);

      rooms.set(roomId, { users: [socket.id, matchedUser.socketId] });

      // Notify both users
      const payloadForUser = {
        state: "match_found",
        roomId,
        matchedUser: {
          userId: matchedUser.userId,
          name: matchedUser.name,
          gender: matchedUser.gender,
        },
      };

      const payloadForMatched = {
        state: "match_found",
        roomId,
        matchedUser: {
          userId: user.userId,
          name: user.name,
          gender: user.gender,
        },
      };

      socket.emit("status.match_found", payloadForUser);
      io.to(matchedUser.socketId).emit("status.match_found", payloadForMatched);
    } else {
      // Add user to appropriate queue
      const queueKey = `${gender}-${preference}`;
      if (!queues[queueKey]) queues[queueKey] = [];
      queues[queueKey].push(user);

      socket.emit("status.searching", { state: "searching", message: "Searching for a partner..." });
    }
  });

  // When user cancels search
  socket.on("status.cancel", () => {
    Object.keys(queues).forEach((key) => {
      queues[key] = queues[key].filter((u) => u.socketId !== socket.id);
    });
    socket.emit("status.cancelled", { state: "cancelled", message: "Search cancelled" });
  });

  // On disconnect
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    // Remove from queues
    Object.keys(queues).forEach((key) => {
      queues[key] = queues[key].filter((u) => u.socketId !== socket.id);
    });

    users.delete(socket.id);

    socket.broadcast.emit("status.disconnected", { state: "disconnected", socketId: socket.id });
  });
});

// Test route
app.get("/", (req, res) => {
  res.send("Matchmaking server is live!");
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
