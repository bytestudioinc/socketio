// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: "*", // change this later to your app URL for security
    methods: ["GET", "POST"]
  }
});

// Store connected users and matchmaking queue
const connectedUsers = new Map(); // socketId -> userId
const matchmakingQueue = new Map(); // userId -> {socketId, gender, preference}
const activeChats = new Map(); // roomId -> {user1, user2}

// Helper to normalize gender/preference
function normalizeValue(value) {
  if (!value) return null;
  switch (value.toUpperCase()) {
    case "M": return "male";
    case "F": return "female";
    case "A": return "all";
    case "MALE": return "male";
    case "FEMALE": return "female";
    case "ALL": return "all";
    default: return null;
  }
}

// Helper to generate roomId
function generateRoomId(user1, user2) {
  const random8 = Math.floor(10000000 + Math.random() * 90000000);
  return `${user1}${random8}${user2}`;
}

io.on("connection", (socket) => {
  console.log("New connection:", socket.id);

  // Send server_ready with a unique userId
  const userId = `user_${Math.floor(Math.random() * 1000000)}`;
  connectedUsers.set(socket.id, userId);
  socket.emit("server_ready", { status: "ready", userId });

  // Handle matchmaking
  socket.on("find", (data) => {
    let { userId, gender, preference } = data;

    gender = normalizeValue(gender);
    preference = normalizeValue(preference);

    if (!userId || !gender || !preference) {
      socket.emit("status", { status: "error", message: "Invalid input" });
      return;
    }

    matchmakingQueue.set(userId, { socketId: socket.id, gender, preference });

    // Try to find match
    for (let [otherId, other] of matchmakingQueue.entries()) {
      if (otherId === userId) continue;

      const userPrefOk = (preference === "all" || preference === other.gender);
      const otherPrefOk = (other.preference === "all" || other.preference === gender);

      if (userPrefOk && otherPrefOk) {
        const roomId = generateRoomId(userId, otherId);

        activeChats.set(roomId, { user1: userId, user2: otherId });

        io.to(socket.id).emit("status", {
          status: "matched",
          roomId,
          partner: { userId: otherId, gender: other.gender }
        });

        io.to(other.socketId).emit("status", {
          status: "matched",
          roomId,
          partner: { userId, gender }
        });

        matchmakingQueue.delete(userId);
        matchmakingQueue.delete(otherId);
        return;
      }
    }

    socket.emit("status", { status: "searching" });
  });

  // Cancel search
  socket.on("cancel_search", (data) => {
    const { userId } = data;
    matchmakingQueue.delete(userId);
    socket.emit("status", { status: "search_cancelled" });
  });

  // Handle chat messages
  socket.on("chat_message", (data) => {
    const { roomId, senderId, message } = data;
    const chat = activeChats.get(roomId);

    if (!chat) return;

    const receiverId = chat.user1 === senderId ? chat.user2 : chat.user1;
    const receiverSocket = [...connectedUsers.entries()]
      .find(([sid, uid]) => uid === receiverId)?.[0];

    if (receiverSocket) {
      io.to(receiverSocket).emit("chat_response", {
        status: "chatting",
        roomId,
        senderId,
        message
      });
    }
  });

  // Leave chat voluntarily
  socket.on("leave_chat", (data) => {
    const { roomId, userId } = data;
    const chat = activeChats.get(roomId);

    if (!chat) return;

    const partnerId = chat.user1 === userId ? chat.user2 : chat.user1;
    const partnerSocket = [...connectedUsers.entries()]
      .find(([sid, uid]) => uid === partnerId)?.[0];

    if (partnerSocket) {
      io.to(partnerSocket).emit("chat_response", {
        status: "partner_left",
        roomId
      });
    }

    activeChats.delete(roomId);
    socket.emit("chat_response", { status: "left", roomId });
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    const userId = connectedUsers.get(socket.id);
    console.log("User disconnected:", userId);

    connectedUsers.delete(socket.id);
    matchmakingQueue.delete(userId);

    for (let [roomId, chat] of activeChats.entries()) {
      if (chat.user1 === userId || chat.user2 === userId) {
        const partnerId = chat.user1 === userId ? chat.user2 : chat.user1;
        const partnerSocket = [...connectedUsers.entries()]
          .find(([sid, uid]) => uid === partnerId)?.[0];

        if (partnerSocket) {
          io.to(partnerSocket).emit("chat_response", {
            status: "disconnected",
            roomId
          });
        }

        activeChats.delete(roomId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
