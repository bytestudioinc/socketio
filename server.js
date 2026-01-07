const express = require("express");
const http = require("http");
const { Server } = require("socket.io"); // Strict v4 import

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO v4
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 10000;

console.log("🚀 Starting Socket.IO v4 Server...");

// ---------------- Users & Rooms ----------------
let searchingUsers = new Map(); // socketId -> user info
let rooms = new Map();          // roomId -> [socketIds]

// ---------------- Timeout Messages ----------------
const timeoutMessagesPaid = [
  "Oops, your match is busy. Try again!",
  "Someone's chatting, but you'll get your turn. Try again!",
  "Patience, young grasshopper, the match awaits. Try again!",
  "Love is in the air… just not for you yet. Try again!",
  "Good things take time—your match is worth it. Try again!",
  "Your preferred partner is currently away. Try again!",
  "Looks like Cupid is tied up. Try again!",
  "They're busy charming someone else. Try again!"
];
const timeoutMessagesFree = [
  "Everyone's chatting. Hang tight, try again!",
  "No freebirds available. Retry shortly!",
  "All ears busy right now. Try again!",
  "The chatroom is packed! Try again!",
  "Looks like a full house. Try again!",
  "Popular time! No match found yet. Try again!",
  "Searching for a signal… none found. Try again!",
  "Quiet on the line. Try again!"
];

// ---------------- Helper Functions ----------------
function getRandomMessage(type) {
  const messages = type === "paid" ? timeoutMessagesPaid : timeoutMessagesFree;
  return messages[Math.floor(Math.random() * messages.length)];
}

function findMatch(socket, userData) {
  const { gender, preference } = userData;
  const isPaid = preference !== "any"; 

  // Look for a partner in the queue
  for (let [partnerId, partnerData] of searchingUsers) {
    if (partnerId === socket.id) continue; // Skip self

    // Check matching criteria
    // 1. My preference matches their gender?
    const matchMyPref = (preference === "any") || (preference === partnerData.gender.toLowerCase());
    // 2. Their preference matches my gender?
    const matchTheirPref = (partnerData.preference === "any") || (partnerData.preference === gender.toLowerCase());

    if (matchMyPref && matchTheirPref) {
      // --- MATCH FOUND ---
      searchingUsers.delete(socket.id);
      searchingUsers.delete(partnerId);

      // Create a unique room ID
      const roomId = `${socket.id}#${partnerId}`;
      
      // Join both sockets to the room
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        socket.join(roomId);
        partnerSocket.join(roomId);
        
        rooms.set(roomId, [socket.id, partnerId]);

        // Notify User A (Current Socket)
        socket.emit("status", JSON.stringify({
          status: "match_found",
          state: "match_found", // Redundant for client compatibility
          roomId,
          partnerId: partnerId,
          partnerName: partnerData.name,
          partnerGender: partnerData.gender,
          partner: { // Nested object for client compatibility
             name: partnerData.name,
             gender: partnerData.gender,
             userId: partnerId
          }
        }));

        // Notify User B (Partner)
        partnerSocket.emit("status", JSON.stringify({
          status: "match_found",
          state: "match_found",
          roomId,
          partnerId: socket.id,
          partnerName: userData.name,
          partnerGender: userData.gender,
          partner: {
             name: userData.name,
             gender: userData.gender,
             userId: socket.id
          }
        }));

        console.log(`✅ Match: ${userData.name} <-> ${partnerData.name} in room ${roomId}`);
        return true;
      }
    }
  }
  return false;
}

// ---------------- Socket Events ----------------
io.on("connection", (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  // 1. Find Match
  socket.on("find", (data) => {
    // data: { name, gender, preference }
    console.log(`🔍 Search request from ${socket.id}:`, data);

    // If already searching, remove old entry first
    if (searchingUsers.has(socket.id)) {
      clearTimeout(searchingUsers.get(socket.id)._timeout);
      searchingUsers.delete(socket.id);
    }

    const userData = { ...data, socketId: socket.id };

    // Try to match immediately
    const matched = findMatch(socket, userData);

    if (!matched) {
      // Add to queue with timeout
      userData._timeout = setTimeout(() => {
        if (searchingUsers.has(socket.id)) {
          searchingUsers.delete(socket.id);
          const msg = getRandomMessage(data.preference !== "any" ? "paid" : "free");
          socket.emit("status", JSON.stringify({ status: "timeout", state: "timeout", message: msg }));
        }
      }, 30000); // 30s timeout

      searchingUsers.set(socket.id, userData);
      socket.emit("status", JSON.stringify({ status: "searching", state: "searching", message: "Searching for a partner..." }));
    }
  });

  // 2. Chat Message
  socket.on("chat_message", (data) => {
    // data: { roomId, content, type (optional), ... }
    const { roomId, content } = data;
    if (roomId && rooms.has(roomId)) {
      // Broadcast to everyone in the room (including sender, for confirmation/sync if needed)
      // Usually better to use socket.to(roomId) to send to partner, 
      // but io.to(roomId) ensures order consistency for both.
      io.to(roomId).emit("chat_response", JSON.stringify({
        ...data,
        from: socket.id, // Sender ID
        timestamp: new Date().toISOString()
      }));
    }
  });

  // 3. Typing Events
  socket.on("typing", (data) => {
    const { roomId } = data;
    if (roomId) {
      // Send to partner only
      socket.to(roomId).emit("typing", { from: socket.id });
    }
  });

  socket.on("stop_typing", (data) => {
    const { roomId } = data;
    if (roomId) {
      // Send to partner only
      socket.to(roomId).emit("stop_typing", { from: socket.id });
    }
  });

  // 4. Read Receipts
  socket.on("mark_read", (data) => {
    const { roomId } = data;
    if (roomId) {
      // Notify the partner that their messages were read
      socket.to(roomId).emit("receipt_read", { from: socket.id, timestamp: new Date().toISOString() });
    }
  });

  // 5. Leave Chat (Manual)
  socket.on("leave_chat", (data) => {
    const roomId = data?.roomId;
    if (roomId && rooms.has(roomId)) {
      // Notify partner
      socket.to(roomId).emit("chat_response", JSON.stringify({
        status: "partner_left",
        state: "partner_left",
        roomId,
        message: "Your partner left the chat."
      }));

      io.in(roomId).socketsLeave(roomId);
      rooms.delete(roomId);
    } else {
        // Fallback: If no roomId provided, try to find room this socket is in
        for (let [rId, members] of rooms) {
            if (members.includes(socket.id)) {
                socket.to(rId).emit("chat_response", JSON.stringify({
                    status: "partner_left",
                    state: "partner_left",
                    message: "Your partner left."
                }));
                io.in(rId).socketsLeave(rId);
                rooms.delete(rId);
                break;
            }
        }
    }
    
    // Also remove from queue if they were searching
    if (searchingUsers.has(socket.id)) {
        clearTimeout(searchingUsers.get(socket.id)._timeout);
        searchingUsers.delete(socket.id);
    }
  });

  // 6. Disconnect
  socket.on("disconnect", () => {
    console.log(`❌ Disconnected: ${socket.id}`);

    // Remove from search
    if (searchingUsers.has(socket.id)) {
      clearTimeout(searchingUsers.get(socket.id)._timeout);
      searchingUsers.delete(socket.id);
    }

    // Handle active rooms
    for (let [roomId, members] of rooms) {
      if (members.includes(socket.id)) {
        socket.to(roomId).emit("chat_response", JSON.stringify({
          status: "partner_left",
          state: "partner_left",
          roomId,
          message: "Your partner disconnected."
        }));
        io.in(roomId).socketsLeave(roomId);
        rooms.delete(roomId);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
