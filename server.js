// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // restrict to your app in production
    methods: ["GET", "POST"],
  },
});

// Active rooms and matchmaking queue
let activeRooms = {};
let searchingUsers = {};

io.on("connection", (socket) => {
  console.log(`[CONNECT] Socket connected: ${socket.id}`);

  // Send server ready
  socket.emit("server_ready", {
    status: "ok",
    version: "1.0.0",
    reward: "10",
    preferenceCost: "5",
    maintenance: "no",
  });

  /**
   * ----------- MATCHMAKING -----------
   */
  socket.removeAllListeners("find");
  socket.on("find", (data) => {
    console.log(`[FIND] ${socket.id} ->`, data);

    // Add to searching pool
    searchingUsers[socket.id] = {
      id: socket.id,
      username: data.username,
      gender: data.gender,
      preference: data.preference,
    };

    // Try to match with another user
    let partnerId = null;
    for (let uid in searchingUsers) {
      if (uid !== socket.id) {
        partnerId = uid;
        break;
      }
    }

    if (partnerId) {
      const roomId = `${socket.id}_${partnerId}_${Math.floor(Math.random() * 10000)}`;
      activeRooms[roomId] = {
        users: [socket.id, partnerId],
      };

      // Join room
      socket.join(roomId);
      io.sockets.sockets.get(partnerId)?.join(roomId);

      // Notify both users
      const matchPayload = {
        status: "match_found",
        roomId,
        partner: searchingUsers[partnerId],
      };

      socket.emit("status", matchPayload);
      io.to(partnerId).emit("status", {
        status: "match_found",
        roomId,
        partner: searchingUsers[socket.id],
      });

      console.log(`[MATCH] Room ${roomId} created between ${socket.id} and ${partnerId}`);

      // Remove from search pool
      delete searchingUsers[socket.id];
      delete searchingUsers[partnerId];
    } else {
      socket.emit("status", { status: "searching" });
    }
  });

  /**
   * ----------- CHAT -----------
   */
  socket.removeAllListeners("chat");
  socket.on("chat", (data) => {
    console.log(`[CHAT] ${socket.id} ->`, data);

    const { roomId, message, from } = data;
    const room = activeRooms[roomId];
    if (!room) {
      console.log(`[CHAT-ERROR] Invalid room ${roomId}`);
      return;
    }

    // Broadcast to room
    io.to(roomId).emit("chat_response", {
      status: "chatting",
      type: "text",
      roomId,
      from,
      message,
      timestamp: Date.now(),
    });

    console.log(`[CHAT] Message sent in room ${roomId} from ${from}`);
  });

  /**
   * ----------- LEAVE CHAT -----------
   */
  socket.removeAllListeners("leave_chat");
  socket.on("leave_chat", (data) => {
    console.log(`[LEAVE] ${socket.id} ->`, data);

    const { roomId } = data;
    const room = activeRooms[roomId];
    if (!room) {
      console.log(`[LEAVE-ERROR] Invalid room ${roomId}`);
      return;
    }

    // Notify partner
    io.to(roomId).emit("status", { status: "partner_left", roomId });

    // Remove users from room
    room.users.forEach((uid) => {
      io.sockets.sockets.get(uid)?.leave(roomId);
    });
    delete activeRooms[roomId];

    console.log(`[LEAVE] Room ${roomId} closed`);
  });

  /**
   * ----------- DISCONNECT -----------
   */
  socket.removeAllListeners("disconnect");
  socket.on("disconnect", () => {
    console.log(`[DISCONNECT] ${socket.id}`);

    // Remove from searching pool
    if (searchingUsers[socket.id]) {
      delete searchingUsers[socket.id];
      console.log(`[SEARCH-REMOVE] ${socket.id} removed from search pool`);
    }

    // Check active rooms
    for (const roomId in activeRooms) {
      if (activeRooms[roomId].users.includes(socket.id)) {
        io.to(roomId).emit("status", { status: "partner_left", roomId });

        activeRooms[roomId].users.forEach((uid) => {
          io.sockets.sockets.get(uid)?.leave(roomId);
        });
        delete activeRooms[roomId];

        console.log(`[ROOM-CLOSE] Room ${roomId} closed due to disconnect`);
      }
    }
  });
});

server.listen(3000, () => {
  console.log("✅ Server running on port 3000");
});
