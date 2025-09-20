const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

let waitingUsers = []; // store users waiting for match

io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  // Listen for all events
  socket.onAny((event, data) => {
    console.log(`📩 Event from ${socket.id} => ${event}`, data, "Type:", typeof data);
  });

  // Handle matchmaking request
  socket.on("find", (data) => {
    try {
      // Always parse JSON string from client
      const user = typeof data === "string" ? JSON.parse(data) : data;
      user.socketId = socket.id;
      console.log("🔍 Find request:", user);

      // Search for available partner
      const partnerIndex = waitingUsers.findIndex(
        (u) =>
          u.userId !== user.userId &&
          (user.preference === "any" || u.gender === user.preference) &&
          (u.preference === "any" || user.gender === u.preference)
      );

      if (partnerIndex !== -1) {
        const matched = waitingUsers.splice(partnerIndex, 1)[0];
        const roomId = `room_${user.userId}_${matched.userId}_${Date.now()}`;

        // Join both sockets to room
        socket.join(roomId);
        io.sockets.sockets.get(matched.socketId)?.join(roomId);

        console.log(`🎉 Match found! Room: ${roomId}`);
        console.log("👉 Matched Users:", user, matched);

        // Notify both users
        socket.emit(
          "status",
          JSON.stringify({ state: "matched", roomId, partner: matched })
        );
        io.sockets.sockets
          .get(matched.socketId)
          ?.emit(
            "status",
            JSON.stringify({ state: "matched", roomId, partner: user })
          );
      } else {
        // Add to waiting list
        waitingUsers.push(user);
        console.log("⏳ User added to waiting list:", user);

        socket.emit(
          "status",
          JSON.stringify({ state: "searching", message: "Searching for partner..." })
        );

        // Set timeout if no match found
        setTimeout(() => {
          const idx = waitingUsers.findIndex((u) => u.userId === user.userId);
          if (idx !== -1) {
            waitingUsers.splice(idx, 1);
            console.log("⌛ Timeout: No match found for", user.userId);
            socket.emit(
              "status",
              JSON.stringify({ state: "timeout", message: "Couldn't find match" })
            );
          }
        }, 30000); // 30 sec
      }
    } catch (err) {
      console.error("❌ Error in find:", err);
    }
  });

  // Handle chat messages
  socket.on("chat", (data) => {
    try {
      const msg = typeof data === "string" ? JSON.parse(data) : data;
      console.log(`💬 Message from ${socket.id} to room ${msg.roomId}:`, msg);

      // Send to other users in room
      socket.to(msg.roomId).emit("chat_response", JSON.stringify(msg));
    } catch (err) {
      console.error("❌ Error in chat:", err);
    }
  });

  // Handle disconnect
  socket.on("disconnect", (reason) => {
    console.log(`❌ Disconnected: ${socket.id} Reason: ${reason}`);
    waitingUsers = waitingUsers.filter((u) => u.socketId !== socket.id);
  });
});

// Start server
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
