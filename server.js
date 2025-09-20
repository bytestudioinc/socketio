const express = require("express");
const http = require("http");
const socketIo = require("socket.io");

const app = express();
const server = http.createServer(app);

// Handle different socket.io versions
let io;
try {
  const { Server } = require("socket.io"); // v3/v4
  io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
  });
} catch (e) {
  io = require("socket.io")(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
  }); // v2 fallback
}

// Queues and maps
const queues = {
  "male-any": [],
  "female-any": [],
  "male-male": [],
  "male-female": [],
  "female-male": [],
  "female-female": []
};

const users = new Map();   // socket.id -> user
const rooms = new Map();   // roomId -> { users: [socketIds] }
const timeouts = new Map();// socket.id -> timeoutId

io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  // --- Matchmaking event ---
  socket.on("find", (rawData) => {
    console.log(`📩 Find event from ${socket.id} =>`, rawData, "Type:", typeof rawData);

    let data;
    try {
      data = typeof rawData === "string" ? JSON.parse(rawData) : rawData;
    } catch (err) {
      console.error("❌ Invalid JSON from client:", rawData);
      return;
    }

    const { userId, name, gender, preference } = data;
    const user = { userId, name, gender, preference, socketId: socket.id };
    users.set(socket.id, user);

    const queueKey = `${gender}-${preference}`;
    let matchedUser = null;

    if (preference === "any") {
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
      const reverseQueueKey = `${preference}-${gender}`;
      const anyQueueKey = `${preference}-any`;

      if (queues[reverseQueueKey]?.length > 0) {
        matchedUser = queues[reverseQueueKey].shift();
      } else if (queues[anyQueueKey]?.length > 0) {
        matchedUser = queues[anyQueueKey].shift();
      }
    }

    if (matchedUser) {
      const roomId = `room_${Date.now()}`;
      socket.join(roomId);

      const matchedSocket = io.sockets.sockets.get
        ? io.sockets.sockets.get(matchedUser.socketId) // v3+
        : io.sockets.connected[matchedUser.socketId];  // v2

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

      console.log(`🤝 Match found! Room: ${roomId}, Users: ${socket.id}, ${matchedUser.socketId}`);
      socket.emit("status", statusDataForCurrent);
      matchedSocket?.emit("status", statusDataForMatched);
    } else {
      if (!queues[queueKey]) queues[queueKey] = [];
      queues[queueKey].push(user);

      console.log(`⌛ User ${socket.id} added to queue ${queueKey}`);

      socket.emit("status", {
        state: "searching",
        message: "Searching for a partner..."
      });

      const timeoutId = setTimeout(() => {
        console.log(`⏰ Timeout for user ${socket.id}`);
        socket.emit("status", {
          state: "timeout",
          message: "Couldn't find a match."
        });
        Object.keys(queues).forEach(
          (key) => (queues[key] = queues[key].filter((u) => u.socketId !== socket.id))
        );
      }, 30000);

      timeouts.set(socket.id, timeoutId);
    }
  });

  // --- Chat message event ---
  socket.on("chat_message", (rawData) => {
    console.log(`📩 Chat_message from ${socket.id} =>`, rawData, "Type:", typeof rawData);

    let data;
    try {
      data = typeof rawData === "string" ? JSON.parse(rawData) : rawData;
    } catch (err) {
      console.error("❌ Invalid JSON in chat_message:", rawData);
      return;
    }

    const { roomId, userId, name, gender, msgType, content, time } = data;
    console.log(`💬 User ${socket.id} sending to Room ${roomId}:`, data);

    // Emit to others in the same room
    socket.to(roomId).emit("chat_response", {
      userId,
      name,
      gender,
      msgType,
      content,
      time
    });
  });

  // --- Cancel search ---
  socket.on("cancel_search", () => {
    clearTimeout(timeouts.get(socket.id));
    timeouts.delete(socket.id);

    Object.keys(queues).forEach((key) => {
      queues[key] = queues[key].filter((u) => u.socketId !== socket.id);
    });
    console.log(`❌ Search cancelled for ${socket.id}`);

    socket.emit("status", {
      state: "cancelled",
      message: "Search cancelled."
    });
  });

  // --- Leave chat ---
  socket.on("leave_chat", ({ roomId }) => {
    console.log(`👋 User ${socket.id} leaving room ${roomId}`);

    socket.leave(roomId);

    if (rooms.has(roomId)) {
      const partners = rooms.get(roomId).users.filter((id) => id !== socket.id);
      partners.forEach((partnerId) => {
        const partnerSocket = io.sockets.sockets.get
          ? io.sockets.sockets.get(partnerId)
          : io.sockets.connected[partnerId];
        partnerSocket?.emit("status", {
          state: "partner_left",
          message: "Your partner has left the chat."
        });
      });
      rooms.delete(roomId);
    }
  });

  // --- Disconnect handler ---
  socket.on("disconnect", (reason) => {
    console.log(`❌ Disconnected: ${socket.id} Reason: ${reason}`);

    clearTimeout(timeouts.get(socket.id));
    timeouts.delete(socket.id);

    users.delete(socket.id);

    Object.keys(queues).forEach((key) => {
      queues[key] = queues[key].filter((u) => u.socketId !== socket.id);
    });

    rooms.forEach((room, roomId) => {
      if (room.users.includes(socket.id)) {
        const partners = room.users.filter((id) => id !== socket.id);
        partners.forEach((partnerId) => {
          const partnerSocket = io.sockets.sockets.get
            ? io.sockets.sockets.get(partnerId)
            : io.sockets.connected[partnerId];
          partnerSocket?.emit("status", {
            state: "partner_disconnected",
            message: "Your partner has disconnected."
          });
        });
        rooms.delete(roomId);
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
