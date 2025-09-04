const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

const queues = {
    "male-any": [],
    "female-any": [],
    "male-male": [],
    "male-female": [],
    "female-male": [],
    "female-female": []
};

const users = new Map();
const rooms = new Map();

const port = process.env.PORT || 3000;
http.listen(port, () => console.log("Listening on port " + port));

app.get("/", (req, res) => {
    res.send("Server is live!");
});

io.on("connection", (socket) => {
    console.log("User connected: " + socket.id);

    // store user details
    socket.on("user_join", (userData) => {
        users.set(socket.id, {
            userId: userData.userId,
            gender: userData.gender,
            socketId: socket.id
        });
    });

    // find match request
    socket.on("find_match", (data) => {
        const user = users.get(socket.id);
        if (!user) return;

        const queueKey = `${user.gender}-${data.preference}`;
        let matchedUser = null;

        if (data.preference === "any") {
            const checkQueues = [
                `male-${user.gender}`,
                `female-${user.gender}`,
                `${user.gender}-any`
            ];
            for (let qKey of checkQueues) {
                if (queues[qKey]?.length > 0) {
                    matchedUser = queues[qKey].shift();
                    break;
                }
            }
        } else {
            const reverseQueueKey = `${data.preference}-${user.gender}`;
            const anyQueueKey = `${data.preference}-any`;

            if (queues[reverseQueueKey]?.length > 0) {
                matchedUser = queues[reverseQueueKey].shift();
            } else if (queues[anyQueueKey]?.length > 0) {
                matchedUser = queues[anyQueueKey].shift();
            }
        }

        if (matchedUser) {
            const roomId = "room_" + Date.now();
            rooms.set(roomId, {
                users: [socket.id, matchedUser.socketId],
                createdAt: new Date()
            });

            socket.join(roomId);
            io.sockets.sockets.get(matchedUser.socketId)?.join(roomId);

            // notify both
            socket.emit("status", {
                state: "match_found",
                roomId,
                matchedUser: {
                    userId: matchedUser.userId,
                    gender: matchedUser.gender
                }
            });

            io.to(matchedUser.socketId).emit("status", {
                state: "match_found",
                roomId,
                matchedUser: {
                    userId: user.userId,
                    gender: user.gender
                }
            });
        } else {
            // add to queue
            if (!queues[queueKey]) queues[queueKey] = [];
            queues[queueKey].push({
                userId: user.userId,
                gender: user.gender,
                socketId: socket.id,
                joinedAt: Date.now()
            });

            socket.emit("status", {
                state: "search",
                message: "Searching for a partner..."
            });

            // auto-timeout after 30s
            setTimeout(() => {
                const stillWaiting = queues[queueKey].find(u => u.socketId === socket.id);
                if (stillWaiting) {
                    queues[queueKey] = queues[queueKey].filter(u => u.socketId !== socket.id);
                    socket.emit("status", {
                        state: "timeout",
                        message: "No match found, try again"
                    });
                }
            }, 30000);
        }
    });

    // cancel search
    socket.on("cancel_search", () => {
        Object.keys(queues).forEach(key => {
            queues[key] = queues[key].filter(u => u.socketId !== socket.id);
        });
        socket.emit("status", {
            state: "cancel",
            message: "Search cancelled"
        });
    });

    // disconnect cleanup
    socket.on("disconnect", () => {
        users.delete(socket.id);
        Object.keys(queues).forEach(key => {
            queues[key] = queues[key].filter(u => u.socketId !== socket.id);
        });
        socket.emit("status", {
            state: "disconnected",
            message: "User disconnected"
        });
        console.log("User disconnected: " + socket.id);
    });
});
