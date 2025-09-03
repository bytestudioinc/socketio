const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Queues for preferences
const queues = {
  'male-any': [],
  'female-any': [],
  'male-male': [],
  'male-female': [],
  'female-male': [],
  'female-female': []
};

const users = new Map();
const rooms = new Map();

// ✅ Helper: check if both sides accept each other
function isMutualMatch(userA, userB) {
  const wantsB = (userA.preference === "any" || userA.preference === userB.gender);
  const wantsA = (userB.preference === "any" || userB.preference === userA.gender);
  return wantsA && wantsB;
}

io.on('connect', (socket) => {
  console.log('User connected:', socket.id);

  // User joins and searches
  socket.on('join_and_find', (data) => {
    const { userId, name, gender, preference } = data;

    // Save user
    const user = { userId, name, gender, preference, socketId: socket.id };
    users.set(socket.id, user);

    let matchedUser = null;

    // Try to find a match from all queues
    for (const [qKey, qUsers] of Object.entries(queues)) {
      if (qUsers.length > 0) {
        const candidate = qUsers.find(u => isMutualMatch(user, u));
        if (candidate) {
          matchedUser = candidate;
          queues[qKey] = qUsers.filter(u => u.socketId !== candidate.socketId);
          break;
        }
      }
    }

    if (matchedUser) {
      // ✅ Match found
      const roomId = `room_${Date.now()}`;
      socket.join(roomId);
      io.sockets.sockets.get(matchedUser.socketId)?.join(roomId);

      rooms.set(roomId, {
        users: [socket.id, matchedUser.socketId],
        createdAt: new Date()
      });

      // Notify both
      socket.emit('status', {
        state: 'match_found',
        roomId,
        matchedUser
      });

      io.to(matchedUser.socketId).emit('status', {
        state: 'match_found',
        roomId,
        matchedUser: user
      });

    } else {
      // ❌ No match found → push into queue
      const queueKey = `${gender}-${preference}`;
      if (!queues[queueKey]) queues[queueKey] = [];
      queues[queueKey].push(user);

      socket.emit('status', {
        state: 'searching',
        message: 'Searching for a partner...'
      });

      // Timeout after 60 seconds
      setTimeout(() => {
        const stillWaiting = queues[queueKey].some(u => u.socketId === socket.id);
        if (stillWaiting) {
          queues[queueKey] = queues[queueKey].filter(u => u.socketId !== socket.id);
          socket.emit('status', {
            state: 'timeout',
            message: 'No match found. Please try again.'
          });
        }
      }, 60000);
    }
  });

  // Cancel search
  socket.on('cancel_search', () => {
    Object.keys(queues).forEach(key => {
      queues[key] = queues[key].filter(u => u.socketId !== socket.id);
    });
    socket.emit('status', { state: 'cancelled', message: 'Search cancelled' });
  });

  // Disconnect cleanup
  socket.on('disconnect', () => {
    users.delete(socket.id);
    Object.keys(queues).forEach(key => {
      queues[key] = queues[key].filter(u => u.socketId !== socket.id);
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
