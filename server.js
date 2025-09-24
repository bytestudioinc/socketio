// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // TODO: Replace with your app’s domain in production
    methods: ["GET", "POST"],
  },
});

// In-memory store
let waitingUsers = []; // users searching for matches
let activeRooms = {}; // { roomId: { users: [], sockets: [] } }

/**
 * Helper: Normalize gender/preference
 * Supports both long-form and short-form
 */
function normalizeInput(value, type) {
  if (!value) return null;

  value = value.toString().toLowerCase();

  if (type === "gender") {
    if (value === "m" || value === "male") return "male";
    if (value === "f" || value === "female") return "female";
  }

  if (type === "preference") {
    if (value === "a" || value === "any") return "any";
    if (value === "m" || value === "male") return "male";
    if (value === "f" || value === "female") return "female";
  }

  return null;
}

io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  // Send ready event with unique userId
  socket.emit("server_ready", { userId: socket.id });

  /**
   * Event: find (start searching for a match)
   * Input: { userId, name, gender, preference }
   */
  socket.on("find", (data) => {
    const { userId, name, gender, preference } = data;

    const normGender = normalizeInput(gender, "gender");
    const normPref = normalizeInput(preference, "preference");

    if (!userId || !name || !normGender || !normPref) {
      socket.emit("status", { status: "error", message: "Invalid input" });
      return;
    }

    console.log(`🔍 User ${name} searching: ${normGender}, prefers ${normPref}`);

    // Try to find a match
    let matchIndex = waitingUsers.findIndex((u) => {
      const prefOk =
        (u.preference === "any" || u.preference === normGender) &&
        (normPref === "any" || normPref === u.gender);

      return prefOk;
    });

    if (matchIndex !== -1) {
      // Found a match
      const partner = waitingUsers.splice(matchIndex, 1)[0];
      const roomId = uuidv4();

      activeRooms[roomId] = {
        users: [userId, partner.userId],
        sockets: [socket.id, partner.socketId],
      };

      socket.join(roomId);
      io.to(partner.socketId).socketsJoin(roomId);

      io.to(roomId).emit("match_found", {
        roomId,
        users: [
          { userId, name, gender: normGender },
          { userId: partner.userId, name: partner.name, gender: partner.gender },
        ],
      });

      console.log(`🎉 Match found! Room ${roomId}`);
    } else {
      // Add user to waiting queue
      waitingUsers.push({
        userId,
        socketId: socket.id,
        name,
        gender: normGender,
        preference: normPref,
      });
      socket.emit("status", { status: "searching" });
    }
  });

  /**
   * Event: cancel_search
   * Input: { userId }
   */
  socket.on("cancel_search", (data) => {
    const { userId } = data || {};
    if (!userId) {
      socket.emit("status", { status: "error", message: "userId required" });
      return;
    }

    waitingUsers = waitingUsers.filter((u) => u.userId !== userId);
    socket.emit("status", { status: "search_cancelled" });

    console.log(`❌ User ${userId} cancelled search`);
  });

  /**
   * Event: leave_chat
   * Input: { roomId, userId }
   */
  socket.on("leave_chat", (data) => {
    const { roomId, userId } = data || {};
    if (!roomId || !userId) return;

    if (activeRooms[roomId]) {
      const partnerSockets = activeRooms[roomId].sockets.filter(
        (sid) => sid !== socket.id
      );

      // Notify partner
      partnerSockets.forEach((sid) =>
        io.to(sid).emit("chat_response", {
          status: "partner_left",
          message: "Your partner has left the chat.",
        })
      );

      delete activeRooms[roomId];
      console.log(`👋 User ${userId} left chat room ${roomId}`);
    }
  });

  /**
   * Event: chat_message
   * Input: { roomId, userId, message }
   */
  socket.on("chat_message", (data) => {
    const { roomId, userId, message } = data || {};
    if (!roomId || !userId || !message) return;

    if (activeRooms[roomId]) {
      socket.to(roomId).emit("chat_response", {
        status: "chatting",
        userId,
        message,
      });
    }
  });

  /**
   * Handle disconnection
   */
  socket.on("disconnect", () => {
    console.log(`⚠️ User disconnected: ${socket.id}`);

    // Remove from waiting queue
    waitingUsers = waitingUsers.filter((u) => u.socketId !== socket.id);

    // Handle if in active room
    for (const [roomId, room] of Object.entries(activeRooms)) {
      if (room.sockets.includes(socket.id)) {
        const partnerSockets = room.sockets.filter((sid) => sid !== socket.id);

        partnerSockets.forEach((sid) =>
          io.to(sid).emit("chat_response", {
            status: "disconnected",
            message: "Your partner disconnected.",
          })
        );

        delete activeRooms[roomId];
        console.log(`💔 Room ${roomId} closed due to disconnect`);
      }
    }
  });
});

server.listen(3000, () => {
  console.log("🚀 Server running on http://localhost:3000");
});
