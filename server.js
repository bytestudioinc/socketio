const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// ✅ Allow only your app domain instead of "*"
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Matchmaking queue
let waitingUsers = {};

// Chatrooms
let chatRooms = {};

// 🔹 Normalize gender & preference (support short forms + capitals)
function normalizeInput(input, type) {
  if (!input) return null;
  const val = input.toLowerCase();

  if (type === "gender") {
    if (val === "m" || val === "male") return "male";
    if (val === "f" || val === "female") return "female";
  }

  if (type === "preference") {
    if (val === "a" || val === "any") return "any";
    if (val === "m" || val === "male") return "male";
    if (val === "f" || val === "female") return "female";
  }

  return null;
}

// 🔹 Helper: generate roomId
function generateRoomId(user1, user2) {
  const randomNum = Math.floor(10000000 + Math.random() * 90000000); // 8-digit
  return `${user1}_${randomNum}_${user2}`;
}

io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  // 🔹 Send server_ready when connected
  socket.emit("server_ready", {
    state: "ready",
    userId: socket.id,
  });

  // 🔹 Handle matchmaking request
  socket.on("find", (data) => {
    try {
      const parsed = typeof data === "string" ? JSON.parse(data) : data;

      const userId = parsed.userId;
      const name = parsed.name;
      const gender = normalizeInput(parsed.gender, "gender");
      const preference = normalizeInput(parsed.preference, "preference");

      if (!userId || !name || !gender || !preference) {
        console.log(`⚠️ Invalid matchmaking payload from ${socket.id}:`, parsed);
        return socket.emit("status", { state: "error", message: "Invalid matchmaking data" });
      }

      console.log(`📩 Match request from ${socket.id}:`, parsed);

      // Try to find a match
      let matchedUserId = null;
      for (let uid in waitingUsers) {
        const candidate = waitingUsers[uid];
        if (
          candidate &&
          uid !== userId &&
          (candidate.preference === "any" || candidate.preference === gender) &&
          (preference === "any" || preference === candidate.gender)
        ) {
          matchedUserId = uid;
          break;
        }
      }

      if (matchedUserId) {
        const matchedUser = waitingUsers[matchedUserId];
        delete waitingUsers[matchedUserId];

        const roomId = generateRoomId(userId, matchedUser.userId);
        chatRooms[roomId] = { users: [userId, matchedUser.userId] };

        socket.join(roomId);
        io.to(matchedUserId).socketsJoin(roomId);

        socket.emit("status", {
          state: "matched",
          roomId,
          partner: {
            userId: matchedUser.userId,
            name: matchedUser.name,
            gender: matchedUser.gender,
            preference: matchedUser.preference,
          },
        });

        io.to(matchedUserId).emit("status", {
          state: "matched",
          roomId,
          partner: { userId, name, gender, preference },
        });

        console.log(`🤝 Match found: ${userId} <-> ${matchedUser.userId} in ${roomId}`);
      } else {
        waitingUsers[userId] = { userId, name, gender, preference, socketId: socket.id };
        socket.emit("status", { state: "searching" });
        console.log(`⏳ User waiting: ${userId}`);
      }
    } catch (err) {
      console.error("❌ Error in find event:", err);
      socket.emit("status", { state: "error", message: "Server error" });
    }
  });

  // 🔹 Cancel search
  socket.on("cancel_search", (data) => {
    const parsed = typeof data === "string" ? JSON.parse(data) : data;
    const userId = parsed?.userId;

    if (userId && waitingUsers[userId]) {
      delete waitingUsers[userId];
      console.log(`🚫 User canceled search: ${userId}`);
      socket.emit("status", { state: "canceled" });
    }
  });

  // 🔹 Leave chat
  socket.on("leave_chat", (data) => {
    const parsed = typeof data === "string" ? JSON.parse(data) : data;
    const roomId = parsed?.roomId;

    if (roomId && chatRooms[roomId]) {
      const users = chatRooms[roomId].users;
      delete chatRooms[roomId];

      users.forEach((uid) => {
        io.to(uid).emit("chat_response", {
          state: "partner_left",
          roomId,
        });
      });

      console.log(`👋 Chat ended in ${roomId}`);
    }
  });

  // 🔹 Chat message
  socket.on("chat_message", (data) => {
    const parsed = typeof data === "string" ? JSON.parse(data) : data;
    const { roomId, name, gender, message, type, time } = parsed || {};

    if (!roomId || !chatRooms[roomId]) {
      console.log(`⚠️ Invalid chat payload from ${socket.id}:`, parsed);
      return;
    }

    console.log(`💬 Message in ${roomId} from ${name}:`, message);

    socket.to(roomId).emit("chat_response", {
      state: "chatting",
      roomId,
      name,
      gender,
      message,
      type,
      time,
    });
  });

  // 🔹 Handle disconnect
  socket.on("disconnect", () => {
    console.log(`❌ Disconnected: ${socket.id}`);

    for (let uid in waitingUsers) {
      if (waitingUsers[uid].socketId === socket.id) {
        delete waitingUsers[uid];
        console.log(`🗑️ Removed waiting user: ${uid}`);
      }
    }

    for (let roomId in chatRooms) {
      const users = chatRooms[roomId].users;
      if (users.includes(socket.id)) {
        users.forEach((uid) => {
          if (uid !== socket.id) {
            io.to(uid).emit("chat_response", {
              state: "disconnected",
              roomId,
            });
          }
        });
        delete chatRooms[roomId];
        console.log(`💔 Room closed due to disconnect: ${roomId}`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
