const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { PrismaClient } = require("@prisma/client");
const path = require("path");

const prisma = new PrismaClient();
const PORT = process.env.PORT || 3005;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
    },
});

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, "public")));

const rooms = {}; // Store rooms

// Helper function to find nearby users
async function findNearbyUser(user) {
    const { pincode, gender } = user;
    const cityPincode = pincode?.substring(0, 3);
    const statePincode = pincode?.substring(0, 2);

    let nearbyUser = await prisma.user.findFirst({
        where: {
            // pincode: {
            //     not: pincode,
            //     startsWith: cityPincode,
            // },
            gender: gender === "male" ? "female" : "male",
            status: "waiting",
        },
    });

    if (nearbyUser) return nearbyUser;

    nearbyUser = await prisma.user.findFirst({
        where: {
            // pincode: {
            //     not: pincode,
            //     startsWith: statePincode,
            // },
            gender: gender === "male" ? "female" : "male",
            status: "waiting",
        },
    });

    return nearbyUser;
}

io.on("connection", async (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on("login", async ({ username, id, pincode, gender }) => {
        socket.username = username;
        socket.userId = id;
        socket.pincode = pincode;
        socket.gender = gender;

        if (socket.userId) {
            await prisma.user.update({
                where: { id: socket.userId },
                data: { status: "waiting" },
            });
        }

        if (socket.currentRoom) {
            socket.leave(socket.currentRoom);
            delete socket.currentRoom;
        }

        const user = await prisma.user.findUnique({
            where: { id },
            select: { status: true },
        });

        if (user.status === "joined") {
            socket.emit("loginError", { message: "You are already joined" });
        }
        socket.emit("loadingNearbyUser", true);

        const nearbyUser = await findNearbyUser({ pincode, gender });

        let room = null;
        if (nearbyUser) {
            for (const [roomId, roomData] of Object.entries(rooms)) {
                if (
                    roomData.users.some(
                        (user) => user.userId === nearbyUser.id
                    ) &&
                    roomData.users.length < 2
                ) {
                    room = roomData;
                    break;
                }
            }
        }

        if (!room) {
            const roomId = `room-${Date.now()}`;
            room = { id: roomId, users: [] };
            rooms[roomId] = room;
        }

        socket.join(room.id);
        room.users.push({
            id: socket.id,
            userId: socket.userId,
            username: socket.username,
            gender: socket.gender,
        });

        socket.currentRoom = room.id;

        if (socket.userId) {
            await prisma.user.update({
                where: { id: socket.userId },
                data: { status: "waiting" },
            });
        }

        io.to(room.id).emit("roomJoined", room);

        socket.emit("loadingNearbyUser", false);

        if (nearbyUser) {
            socket.emit("nearbyUser", nearbyUser);
        } else {
            socket.emit("nearbyUser", null);
        }

        if (room.users.length === 2) {
            const userIds = room.users.map((user) => user.userId);
            await prisma.user.updateMany({
                where: { id: { in: userIds } },
                data: { status: "joined" },
            });

            io.to(room.id).emit("userJoined", { userIds });
        }

        // Handle typing event
        socket.on("typing", (typingUserDetails) => {
            io.to(typingUserDetails.currentRoom).emit(
                "typingServer",
                typingUserDetails.username
            );
        });

        // Handle stop typing event
        socket.on("stopTyping", (typingUserDetails) => {
            io.to(typingUserDetails.currentRoom).emit(
                "stopTypingServer",
                typingUserDetails.username
            );
        });
    });

    socket.on("disconnectFromRoom", async (roomId) => {
        if (socket.currentRoom) {
            const room = rooms[roomId];
            if (room) {
                const userIds = room.users.map((user) => user.userId);

                await prisma.user.updateMany({
                    where: { id: { in: userIds } },
                    data: { status: "offline" },
                });

                io.to(socket.currentRoom).emit("userLeftRoom", socket.username);

                room.users = room.users.filter((user) => user.id !== socket.id);

                if (room.users.length === 0) {
                    delete rooms[socket.currentRoom];
                }

                socket.leave(socket.currentRoom);
                socket.currentRoom = null;

                room.users.forEach((user) => {
                    const remainingUserSocket = io.sockets.sockets.get(user.id);
                    if (remainingUserSocket) {
                        remainingUserSocket.emit("userWaiting");
                    }
                });

                delete rooms[roomId];
            }
        }
    });

    socket.on("sendMessage", ({ message }) => {
        io.to(socket.currentRoom).emit("message", {
            username: socket.username,
            message,
        });
    });

    socket.on("disconnect", async () => {
        console.log(`User disconnected: ${socket.id}`);

        if (socket.currentRoom) {
            const room = rooms[socket.currentRoom];
            if (room) {
                const userIds = room.users.map((user) => user.userId);

                // Update all users in the room to offline status
                await prisma.user.updateMany({
                    where: { id: { in: userIds } },
                    data: { status: "offline" },
                });

                // Remove the disconnecting user from the room
                room.users = room.users.filter((user) => user.id !== socket.id);

                // Emit user left and user disconnected events to the remaining users
                // io.to(socket.currentRoom).emit("userLeftRoom", socket.username);
                io.to(socket.currentRoom).emit(
                    "userDisconnected",
                    socket.username
                );

                // If the room is now empty, delete it
                if (room.users.length === 0) {
                    delete rooms[socket.currentRoom];
                }

                // Leave the room
                socket.leave(socket.currentRoom);
                socket.currentRoom = null;
            }
        }

        if (socket.userId) {
            await prisma.user.update({
                where: { id: socket.userId },
                data: { status: "offline" },
            });
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
