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
const searchTimeouts = new Map(); // socket.id -> timeoutId

io.on("connection", (socket) => {
  console.log("✅ User connected:", socket.id);

  // Log all incoming events & raw data
  socket.onAny((event, data) => {
    console.log("📩 Event from client:", event);
    console.log("   Raw data:", data);
    console.log("   Data type:", typeof data);
  });

  // Handle find request
  socket.on("find", (data) => {
    try {
      if (typeof data === "string") {
        console.log("🔄 Parsing JSON string from client...");
        data = JSON.parse(data);
      }

      const { userId, name, gender, preference } = data;
      const user = { userId, name, gender, preference, socketId: socket.id };
      users.set(socket.id, user);

      console.log("✅ Parsed user:", user);

      // Determine queue key
      const queueKey = `${gender}-${preference}`;
      let matchedUser = null;

      if (preference === "any") {
        // Look for mutual any-match users
        const checkQueues = ["male-any", "female-any"];
        for (let qKey of checkQueues) {
          for (let i = 0; i < queues[qKey].length; i++) {
            const candidate = queues[qKey][i];
            if (candidate.preference === "any" || candidate.preference === gender) {
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

        // Cross-version compatible socket lookup
        const matchedSocket = io.sockets.sockets.get
          ? io.sockets.sockets.get(matchedUser.socketId) // v3+
          : io.sockets.sockets[matchedUser.socketId];    // v2

        socket.join(roomId);
        matchedSocket?.join(roomId);
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

        console.log("📤 Emitting match_found to:", socket.id, matchedUser.socketId);

        socket.emit("status", JSON.stringify(statusDataForCurrent));
        matchedSocket?.emit("status", JSON.stringify(statusDataForMatched));

        // Clear timeouts if any
        clearTimeout(searchTimeouts.get(socket.id));
        clearTimeout(searchTimeouts.get(matchedUser.socketId));
        searchTimeouts.delete(socket.id);
        searchTimeouts.delete(matchedUser.socketId);
      } else {
        // ❌ No match found → push to queue
        if (!queues[queueKey]) queues[queueKey] = [];
        queues[queueKey].push(user);

        console.log("ℹ️ Added to queue:", queueKey);

        socket.emit("status", JSON.stringify({
          state: "searching",
          message: "Searching for a partner..."
        }));

        // Timeout after 30s if still unmatched
        const timeoutId = setTimeout(() => {
          console.log("⏰ Timeout: No match found for", socket.id);
          socket.emit("status", JSON.stringify({
            state: "timeout",
            message: "Couldn't find a match. Try again!"
          }));

          // Remove from queues
          Object.keys(queues).forEach((key) => {
            queues[key] = queues[key].filter((u) => u.socketId !== socket.id);
          });
          searchTimeouts.delete(socket.id);
        }, 30000);

        searchTimeouts.set(socket.id, timeoutId);
      }
    } catch (err) {
      console.error("❌ Error handling 'find':", err);
      socket.emit("status", JSON.stringify({
        state: "error",
        message: "Invalid data format"
      }));
    }
  });

  // Cancel search
  socket.on("cancel_search", () => {
    Object.keys(queues).forEach((key) => {
      queues[key] = queues[key].filter((u) => u.socketId !== socket.id);
    });

    clearTimeout(searchTimeouts.get(socket.id));
    searchTimeouts.delete(socket.id);

    console.log("🚫 Search cancelled for:", socket.id);

    socket.emit("status", JSON.stringify({
      state: "cancelled",
      message: "Search cancelled."
    }));
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    console.log("❌ User disconnected:", socket.id);

    users.delete(socket.id);
    Object.keys(queues).forEach((key) => {
      queues[key] = queues[key].filter((u) => u.socketId !== socket.id);
    });

    clearTimeout(searchTimeouts.get(socket.id));
    searchTimeouts.delete(socket.id);

    io.emit("status", JSON.stringify({
      state: "disconnected",
      message: "A user disconnected",
      socketId: socket.id
    }));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
