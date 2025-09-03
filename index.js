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
    'male-any': [],      // Males open to any gender
    'female-any': [],    // Females open to any gender
    'male-male': [],     // Males wanting males
    'male-female': [],   // Males wanting females
    'female-male': [],   // Females wanting males
    'female-female': []  // Females wanting females
};

const users = new Map();
const rooms = new Map();

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    socket.on('user_join', (userData) => {
        users.set(socket.id, {
            userId: userData.userId,
            gender: userData.gender,
            socketId: socket.id
        });
    });
    
    socket.on('find_match', (data) => {
        const user = users.get(socket.id);
        if (!user) return;
        
        // Create appropriate queue key
        const queueKey = `${user.gender}-${data.preference}`;
        
        // Try to find match
        let matchedUser = null;
        let matchedQueueKey = '';
        
        if (data.preference === 'any') {
            // Check specific preference queues first
            const checkQueues = [
                `${data.gender}-male`,
                `${data.gender}-female`,
                `any-${data.gender}`
            ];
            
            for (let qKey of checkQueues) {
                if (queues[qKey] && queues[qKey].length > 0) {
                    matchedUser = queues[qKey].shift();
                    matchedQueueKey = qKey;
                    break;
                }
            }
        } else {
            // Check exact preference match
            const reverseQueueKey = `${data.preference}-${user.gender}`;
            const anyQueueKey = `${data.preference}-any`;
            
            if (queues[reverseQueueKey] && queues[reverseQueueKey].length > 0) {
                matchedUser = queues[reverseQueueKey].shift();
                matchedQueueKey = reverseQueueKey;
            } else if (queues[anyQueueKey] && queues[anyQueueKey].length > 0) {
                matchedUser = queues[anyQueueKey].shift();
                matchedQueueKey = anyQueueKey;
            }
        }
        
        if (matchedUser) {
            // Create match
            const roomId = `room_${Date.now()}`;
            
            // Join both users to room
            socket.join(roomId);
            io.sockets.sockets.get(matchedUser.socketId)?.join(roomId);
            
            // Store room
            rooms.set(roomId, {
                users: [socket.id, matchedUser.socketId],
                createdAt: new Date()
            });
            
            // Notify both users
            const matchData = {
                roomId: roomId,
                matchedUser: {
                    userId: matchedUser.userId,
                    gender: matchedUser.gender,
                    socketId: matchedUser.socketId
                }
            };
            
            socket.emit('match_found', {
                ...matchData,
                matchedUser: {
                    userId: matchedUser.userId,
                    gender: matchedUser.gender,
                    socketId: matchedUser.socketId
                }
            });
            
            io.to(matchedUser.socketId).emit('match_found', {
                ...matchData,
                matchedUser: {
                    userId: user.userId,
                    gender: user.gender,
                    socketId: socket.id
                }
            });
        } else {
            // No match, add to queue
            if (!queues[queueKey]) queues[queueKey] = [];
            queues[queueKey].push({
                userId: user.userId,
                gender: user.gender,
                socketId: socket.id,
                joinedAt: Date.now()
            });
            socket.emit('waiting_for_match', { message: 'Searching...' });
        }
    });
    
    socket.on('cancel_search', () => {
        // Remove from all queues
        Object.keys(queues).forEach(key => {
            queues[key] = queues[key].filter(u => u.socketId !== socket.id);
        });
        socket.emit('search_cancelled', { message: 'Search cancelled' });
    });
    
    socket.on('disconnect', () => {
        // Clean up
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
