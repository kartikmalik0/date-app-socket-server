// server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const PORT = process.env.PORT || 3001;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
    },
});

const rooms = {}; // Store rooms

// Helper function to find nearby users
async function findNearbyUser(user) {
    const { pincode, gender } = user;

    // Find the first three digits of the pincode for city comparison
    const cityPincode = pincode?.substring(0, 3);
    const statePincode = pincode?.substring(0, 2);

    // Query for users with the same city but different gender and not the same pincode
    let nearbyUser = await prisma.user.findFirst({
        where: {
            pincode: {
                not: pincode,
                startsWith: cityPincode, // Users from the same city
            },
            gender: gender === "male" ? "female" : "male",
            status: "waiting",
        },
    });

    if (nearbyUser) return nearbyUser;

    // If no user found in the same city, search in the same state
    nearbyUser = await prisma.user.findFirst({
        where: {
            pincode: {
                not: pincode,
                startsWith: statePincode, // Users from the same state
            },
            gender: gender === "male" ? "female" : "male",
            status: "waiting",
        },
    });

    return nearbyUser;
}

// Handle socket connections
io.on('connection', async (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Handle user login
    socket.on('login', async ({ username, id, pincode, gender }) => {
        socket.username = username;
        socket.userId = id;
        socket.pincode = pincode;
        socket.gender = gender;

        if (socket.userId) {
            await prisma.user.update({
                where: { id: socket.userId },
                data: { status: 'waiting' },
            });
        }
        // Check if the user is already in a room
        if (socket.currentRoom) {
            // Leave the current room and delete the reference
            socket.leave(socket.currentRoom);
            delete socket.currentRoom;
        }

        // Check if the user is already marked as 'joined'
        const user = await prisma.user.findUnique({
            where: { id },
            select: { status: true },
        });

        if (user.status === 'joined') {
            socket.emit('loginError', { message: 'You are already joined' });
        }
        socket.emit('loadingNearbyUser', true);
        // Find a nearby user based on proximity and opposite gender
        const nearbyUser = await findNearbyUser({ pincode, gender });

        let room = null;
        if (nearbyUser) {
            // Check if the nearby user is already in a room
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

        // If no suitable room found, create a new room
        if (!room) {
            const roomId = `room-${Date.now()}`;
            room = { id: roomId, users: [] };
            rooms[roomId] = room;
        }

        // Join the room
        socket.join(room.id);
        room.users.push({ id: socket.id, userId: socket.userId });

        socket.currentRoom = room.id;

        if (socket.userId) {
            await prisma.user.update({
                where: { id: socket.userId },
                data: { status: 'waiting' },
            });
        }
        // Notify users in the room
        io.to(room.id).emit('roomJoined', room);

        socket.emit('loadingNearbyUser', false);

        if (nearbyUser) {
            socket.emit('nearbyUser', nearbyUser);
        } else {
            socket.emit('nearbyUser', null);
        }

        if (room.users.length === 2) {
            const userIds = room.users.map((user) => user.userId);
            await prisma.user.updateMany({
                where: { id: { in: userIds } },
                data: { status: 'joined' },
            });

            // Notify users in the room that they are now joined
            io.to(room.id).emit('userJoined', { userIds });
        }
    });

    // Handle manual disconnect from a room
    socket.on('disconnectFromRoom', async (roomId) => {
        if (socket.currentRoom) {
            const room = rooms[roomId];
            if (room) {
                const userIds = room.users.map((user) => user.userId);

                // Update user status to "waiting"
                await prisma.user.updateMany({
                    where: { id: { in: userIds } },
                    data: { status: 'waiting' },
                });

                // Notify users in the room that a user left
                io.to(socket.currentRoom).emit('userLeftRoom', socket.username);

                // Remove the user from the room
                room.users = room.users.filter((user) => user.id !== socket.id);

                // If no users left in the room, delete the room
                if (room.users.length === 0) {
                    delete rooms[socket.currentRoom];
                }

                // Leave the socket room and reset currentRoom
                socket.leave(socket.currentRoom);
                socket.currentRoom = null;

                // Notify remaining users about their new status
                room.users.forEach((user) => {
                    const remainingUserSocket = io.sockets.sockets.get(user.id);
                    if (remainingUserSocket) {
                        remainingUserSocket.emit('userWaiting');
                    }
                });

                // Delete the room so user can create and join another room
                delete rooms[roomId];
            }
        }
    });

    // Handle chat messages
    socket.on('sendMessage', ({ message }) => {
        io.to(socket.currentRoom).emit('message', {
            username: socket.username,
            message,
        });
    });

    // Handle disconnect
    socket.on('disconnect', async () => {
        console.log('user id ', socket.userId);
        console.log(`User disconnected: ${socket.id}`);
        // Remove user from room if applicable
        if (socket.currentRoom) {
            const room = rooms[socket.currentRoom];
            if (room) {
                room.users = room.users.filter((user) => user.id !== socket.id);
                if (room.users.length === 1) {
                    delete rooms[socket.currentRoom];
                }
            }

            // Emit userDisconnected event to notify clients in the room
            io.to(socket.currentRoom).emit('userDisconnected', socket.username);

            socket.leave(socket.currentRoom);
            socket.currentRoom = null;
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
