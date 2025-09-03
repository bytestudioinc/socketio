const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Queues for different preference combinations
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

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Unified join + find event
  socket.on('join_and_find', (data) => {
    const { userId, name, gender, preference } = data;

    // Save user
    const user = { userId, name, gender, socketId: socket.id };
    users.set(socket.id, user);

    // Create queue key
    const queueKey = `${gender}-${preference}`;
    let matchedUser = null;

    if (preference === 'any') {
      // Look for anyone waiting for this gender
      const checkQueues = [
        `male-${gender}`,
        `female-${gender}`,
        `${gender === 'male' ? 'female' : 'male'}-any`
      ];

      for (let qKey of checkQueues) {
        if (queues[qKey] && queues[qKey].length > 0) {
          matchedUser = queues[qKey].shift();
          break;
        }
      }
    } else {
      // Check exact preference or "any"
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

      socket.join(roomId);
      io.sockets.sockets.get(matchedUser.socketId)?.join(roomId);

      rooms.set(roomId, {
        users: [socket.id, matchedUser.socketId],
        createdAt: new Date()
      });

      // Notify both users with unified "status"
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
      // ❌ No match yet → enqueue
      if (!queues[queueKey]) queues[queueKey] = [];
      queues[queueKey].push({
        userId,
        name,
        gender,
        socketId: socket.id,
        joinedAt: Date.now()
      });

      socket.emit('status', {
        state: 'searching',
        message: 'Searching for a partner...'
      });

      // Optional timeout (e.g., 60 sec)
      setTimeout(() => {
        const stillWaiting = queues[queueKey].some(u => u.socketId === socket.id);
        if (stillWaiting) {
          // Remove from queue
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
