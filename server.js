const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Game state
const rooms = new Map();
const players = new Map();

// Helper functions
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function createRoom(hostId, roomCode = null) {
    const code = roomCode || generateRoomCode();
    const room = {
        code: code,
        players: new Map(),
        gameStarted: false,
        gameEnded: false,
        host: hostId
    };
    rooms.set(code, room);
    return room;
}

function addPlayerToRoom(playerId, playerName, roomCode = null) {
    let room;
    
    if (roomCode) {
        room = rooms.get(roomCode);
        if (!room) {
            throw new Error('Room not found');
        }
    } else {
        // Find a room with space or create new one
        room = Array.from(rooms.values()).find(r => 
            !r.gameStarted && r.players.size < 4
        );
        
        if (!room) {
            room = createRoom(playerId);
        }
    }
    
    if (room.players.size >= 4) {
        throw new Error('Room is full');
    }
    
    if (room.gameStarted) {
        throw new Error('Game already started');
    }
    
    const player = {
        id: playerId,
        name: playerName,
        progress: 0,
        isHost: room.players.size === 0 || room.host === playerId,
        ready: true,
        crashed: false,
        sabotageEffects: {
            slowed: false,
            frozen: false
        },
        lastProgressTime: Date.now()
    };
    
    room.players.set(playerId, player);
    players.set(playerId, { roomCode: room.code, ...player });
    
    return room;
}

function removePlayerFromRoom(playerId) {
    const player = players.get(playerId);
    if (!player) return;
    
    const room = rooms.get(player.roomCode);
    if (!room) return;
    
    room.players.delete(playerId);
    players.delete(playerId);
    
    // If host left, assign new host
    if (room.host === playerId && room.players.size > 0) {
        const newHost = Array.from(room.players.values())[0];
        newHost.isHost = true;
        room.host = newHost.id;
        players.get(newHost.id).isHost = true;
    }
    
    // Remove empty rooms
    if (room.players.size === 0) {
        rooms.delete(room.code);
    }
    
    return room;
}

function startGame(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || room.gameStarted) return false;
    
    room.gameStarted = true;
    
    // Reset all player progress
    room.players.forEach(player => {
        player.progress = 0;
        player.crashed = false;
        player.sabotageEffects = { slowed: false, frozen: false };
        player.lastProgressTime = Date.now();
    });
    
    return true;
}

function updatePlayerProgress(playerId, amount = 1, decrease = false) {
    const player = players.get(playerId);
    if (!player) return null;
    
    const room = rooms.get(player.roomCode);
    if (!room || !room.gameStarted || room.gameEnded) return null;
    
    const roomPlayer = room.players.get(playerId);
    if (!roomPlayer) return null;
    
    // Check if player is affected by sabotage
    if (roomPlayer.sabotageEffects.frozen) return null;
    
    const progressAmount = decrease ? -amount : amount;
    const multiplier = roomPlayer.sabotageEffects.slowed ? 0.15 : 1;
    
    roomPlayer.progress += progressAmount * multiplier;
    roomPlayer.progress = Math.max(0, Math.min(100, roomPlayer.progress));
    
    // Update player data
    players.set(playerId, { ...player, progress: roomPlayer.progress });
    
    // Check win condition
    if (roomPlayer.progress >= 100 && !room.gameEnded) {
        room.gameEnded = true;
        return { winner: roomPlayer, room };
    }
    
    return { room };
}

function applySabotage(fromPlayerId, targetPlayerId, sabotageType) {
    const fromPlayer = players.get(fromPlayerId);
    const targetPlayer = players.get(targetPlayerId);
    
    if (!fromPlayer || !targetPlayer || fromPlayer.roomCode !== targetPlayer.roomCode) {
        return null;
    }
    
    const room = rooms.get(fromPlayer.roomCode);
    if (!room || !room.gameStarted) return null;
    
    const targetRoomPlayer = room.players.get(targetPlayerId);
    if (!targetRoomPlayer) return null;
    
    switch (sabotageType) {
        case 'slow':
            targetRoomPlayer.sabotageEffects.slowed = true;
            setTimeout(() => {
                if (room.players.has(targetPlayerId)) {
                    targetRoomPlayer.sabotageEffects.slowed = false;
                }
            }, 20000);
            break;
            
        case 'freeze':
            targetRoomPlayer.sabotageEffects.frozen = true;
            setTimeout(() => {
                if (room.players.has(targetPlayerId)) {
                    targetRoomPlayer.sabotageEffects.frozen = false;
                }
            }, 12000);
            break;
            
        case 'bloatware':
            targetRoomPlayer.progress = Math.max(0, targetRoomPlayer.progress - 5);
            break;
            
        case 'crash':
            targetRoomPlayer.crashed = true;
            targetRoomPlayer.progress = Math.max(0, targetRoomPlayer.progress - 10);
            setTimeout(() => {
                if (room.players.has(targetPlayerId)) {
                    targetRoomPlayer.crashed = false;
                }
            }, 3000);
            break;
            
        case 'popup':
            // Popup is handled on client side
            break;
    }
    
    return {
        type: sabotageType,
        fromPlayer: fromPlayer.name,
        targetPlayer: targetPlayer.name
    };
}

function generateSabotageAbilities(playerId) {
    const player = players.get(playerId);
    if (!player) return [];
    
    const room = rooms.get(player.roomCode);
    if (!room || !room.gameStarted) return [];
    
    const otherPlayers = Array.from(room.players.values()).filter(p => p.id !== playerId);
    if (otherPlayers.length === 0) return [];
    
    const abilities = [
        { type: 'slow', name: 'Slow Down' },
        { type: 'freeze', name: 'Freeze System' },
        { type: 'popup', name: 'Spam Popup' },
        { type: 'bloatware', name: 'Install Bloatware' },
        { type: 'crash', name: 'System Crash' }
    ];
    
    // Randomly select 2-3 abilities
    const selectedAbilities = [];
    const numAbilities = Math.floor(Math.random() * 2) + 2; // 2-3 abilities
    
    for (let i = 0; i < numAbilities && i < abilities.length; i++) {
        const randomIndex = Math.floor(Math.random() * abilities.length);
        const ability = abilities.splice(randomIndex, 1)[0];
        selectedAbilities.push(ability);
    }
    
    return selectedAbilities;
}

// Socket connection handling
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);
    
    socket.on('joinGame', ({ playerName, roomCode }) => {
        try {
            const room = addPlayerToRoom(socket.id, playerName, roomCode);
            
            socket.join(room.code);
            
            // Send game state to joining player
            socket.emit('gameJoined', {
                roomCode: room.code,
                players: Object.fromEntries(room.players)
            });
            
            // Notify other players
            socket.to(room.code).emit('playerJoined', {
                players: Object.fromEntries(room.players)
            });
            
            console.log(`${playerName} joined room ${room.code}`);
            
        } catch (error) {
            socket.emit('error', error.message);
        }
    });
    
    socket.on('startGame', () => {
        const player = players.get(socket.id);
        if (!player || !player.isHost) {
            socket.emit('error', 'Only host can start the game');
            return;
        }
        
        const room = rooms.get(player.roomCode);
        if (!room || room.players.size < 2) {
            socket.emit('error', 'Need at least 2 players to start');
            return;
        }
        
        if (startGame(room.code)) {
            io.to(room.code).emit('gameStarted');
            console.log(`Game started in room ${room.code}`);
        }
    });
    
    socket.on('increaseProgress', ({ auto = false, decrease = false } = {}) => {
        const amount = auto ? 0.05 : (decrease ? 2 : 0.3);
        const result = updatePlayerProgress(socket.id, amount, decrease);
        
        if (!result) return;
        
        if (result.winner) {
            // Game ended
            io.to(result.room.code).emit('gameEnded', {
                winner: result.winner
            });
            console.log(`${result.winner.name} won in room ${result.room.code}`);
        } else {
            // Update progress
            io.to(result.room.code).emit('progressUpdate', {
                players: Object.fromEntries(result.room.players)
            });
        }
    });
    
    socket.on('useSabotage', ({ type, targetId }) => {
        const result = applySabotage(socket.id, targetId, type);
        if (result) {
            // Send sabotage to target
            socket.to(targetId).emit('sabotageReceived', result);
            
            // Update game state for everyone
            const player = players.get(socket.id);
            if (player) {
                const room = rooms.get(player.roomCode);
                if (room) {
                    io.to(room.code).emit('progressUpdate', {
                        players: Object.fromEntries(room.players)
                    });
                }
            }
        }
    });
    
    socket.on('requestSabotage', () => {
        const abilities = generateSabotageAbilities(socket.id);
        socket.emit('sabotageAbility', abilities);
    });
    
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        
        const room = removePlayerFromRoom(socket.id);
        if (room) {
            socket.to(room.code).emit('playerLeft', {
                players: Object.fromEntries(room.players)
            });
        }
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🖥️ Competitive Loading Screens server running on port ${PORT}`);
    console.log(`Visit http://localhost:${PORT} to play!`);
});

// Cleanup empty rooms periodically
setInterval(() => {
    for (const [code, room] of rooms.entries()) {
        if (room.players.size === 0) {
            rooms.delete(code);
        }
    }
}, 60000); // Clean up every minute