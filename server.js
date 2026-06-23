// ============================================================
// Football Pro 3D — Multiplayer Relay Server
// ============================================================
const express = require('express');
const http    = require('http');
const path    = require('path');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

// Serve the game directory as static files
app.use(express.static(path.join(__dirname)));

// ======================== ROOMS =============================
const rooms = {};  // code → Room object

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
  let code = '';
  for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return rooms[code] ? generateRoomCode() : code;
}

function createRoom(hostSocket) {
  const code = generateRoomCode();
  rooms[code] = {
    code,
    host:       hostSocket,
    hostId:     Math.random().toString(36).substring(2, 10),
    guest:      null,
    guestId:    null,
    spectators: [],
    hostTeam:   null,
    guestTeam:  null,
    hostReady:  false,
    guestReady: false,
    matchState: 'LOBBY',     // MSM state
    createdAt:  Date.now(),
    hostDisconnectTimeout: null,
    guestDisconnectTimeout: null,
    // --- Match Validator state ---
    lastGoalTime: 0,
    prevPlayerPositions: {},  // num → {x, z, t}
  };
  return rooms[code];
}

function destroyRoom(code) {
  const room = rooms[code];
  if (!room) return;
  // Notify everyone left in the room
  if (room.host)  room.host.emit('roomDestroyed');
  if (room.guest) room.guest.emit('roomDestroyed');
  room.spectators.forEach(s => s.emit('roomDestroyed'));
  delete rooms[code];
}

// ================= MATCH VALIDATOR =========================
// Basic sanity checks on state packets relayed by the Host
// to prevent trivial DevTools cheats.

const VALIDATION = {
  MAX_SPEED_PER_TICK:  2.5,    // max units a player can move in a single 50ms tick
  MIN_GOAL_INTERVAL:   10000,  // ms between goals
  MAX_BALL_SPEED:      120,    // units/sec
};

function validateHostState(room, state) {
  const now = Date.now();
  const warnings = [];

  // 1) Goal‐rate check
  if (state.scoreA !== undefined && state.scoreB !== undefined) {
    const prevScore = (room._prevScoreA || 0) + (room._prevScoreB || 0);
    const currScore = state.scoreA + state.scoreB;
    if (currScore > prevScore) {
      if (now - room.lastGoalTime < VALIDATION.MIN_GOAL_INTERVAL) {
        warnings.push('GOAL_RATE_EXCEEDED');
      }
      room.lastGoalTime = now;
    }
    room._prevScoreA = state.scoreA;
    room._prevScoreB = state.scoreB;
  }

  // 2) Player speed check (sample up to 5 players per tick)
  if (state.players && Array.isArray(state.players)) {
    const sampleSize = Math.min(state.players.length, 5);
    for (let i = 0; i < sampleSize; i++) {
      const sp = state.players[i];
      const key = `${sp.isUserTeam ? 'H' : 'A'}_${sp.num}`;
      const prev = room.prevPlayerPositions[key];
      if (prev) {
        const dx = sp.x - prev.x;
        const dz = sp.z - prev.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > VALIDATION.MAX_SPEED_PER_TICK) {
          // Allow teleports during goal resets (matchState check)
          if (room.matchState === 'PLAYING') {
            warnings.push(`SPEED_VIOLATION:${key}:${dist.toFixed(1)}`);
          }
        }
      }
      room.prevPlayerPositions[key] = { x: sp.x, z: sp.z, t: now };
    }
  }

  return warnings;
}

// ==================== SOCKET.IO ============================
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);
  socket._roomCode = null;
  socket._role     = null; // 'host' | 'guest' | 'spectator'

  // ---- Room lifecycle ----
  socket.on('createRoom', () => {
    leaveRoom(socket);
    const room = createRoom(socket);
    socket._roomCode = room.code;
    socket._role     = 'host';
    socket._playerId = room.hostId;
    socket.join(room.code);
    socket.emit('roomCreated', { roomCode: room.code, playerId: room.hostId });
    console.log(`[Room] ${room.code} created by ${socket.id}`);
  });

  socket.on('joinRoom', ({ roomCode, version }) => {
    if (version !== '1.0.0') {
      return socket.emit('joinError', { message: 'Version Mismatch. Please refresh the page to get the latest version.' });
    }
    const code = (roomCode || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) return socket.emit('joinError', { message: 'Room not found.' });
    if (room.guest) {
      // Room already has a guest — join as spectator
      leaveRoom(socket);
      room.spectators.push(socket);
      socket._roomCode = code;
      socket._role     = 'spectator';
      socket.join(code);
      socket.emit('roomJoined', { roomCode: code, role: 'spectator' });
      console.log(`[Room] ${code} spectator: ${socket.id}`);
      return;
    }
    leaveRoom(socket);
    room.guest = socket;
    room.guestId = Math.random().toString(36).substring(2, 10);
    socket._roomCode = code;
    socket._role     = 'guest';
    socket._playerId = room.guestId;
    socket.join(code);
    socket.emit('roomJoined', { roomCode: code, role: 'guest', playerId: room.guestId });
    if (room.host) room.host.emit('opponentJoined');
    console.log(`[Room] ${code} guest: ${socket.id}`);
  });

  socket.on('reconnectToRoom', ({ roomCode, playerId }) => {
    const code = (roomCode || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) return socket.emit('joinError', { message: 'Room not found.' });
    
    if (room.hostId === playerId) {
      if (room.hostDisconnectTimeout) clearTimeout(room.hostDisconnectTimeout);
      room.hostDisconnectTimeout = null;
      room.host = socket;
      socket._roomCode = code;
      socket._role = 'host';
      socket._playerId = playerId;
      socket.join(code);
      socket.emit('reconnected', { role: 'host' });
      if (room.guest) room.guest.emit('opponentReconnected', { who: 'host' });
      console.log(`[Room] ${code} Host reconnected: ${socket.id}`);
    } else if (room.guestId === playerId) {
      if (room.guestDisconnectTimeout) clearTimeout(room.guestDisconnectTimeout);
      room.guestDisconnectTimeout = null;
      room.guest = socket;
      socket._roomCode = code;
      socket._role = 'guest';
      socket._playerId = playerId;
      socket.join(code);
      socket.emit('reconnected', { role: 'guest' });
      if (room.host) room.host.emit('opponentReconnected', { who: 'guest' });
      console.log(`[Room] ${code} Guest reconnected: ${socket.id}`);
    } else {
      socket.emit('joinError', { message: 'Invalid player ID for reconnection.' });
    }
  });

  // ---- Team selection ----
  socket.on('selectTeam', ({ teamData }) => {
    const room = rooms[socket._roomCode];
    if (!room) return;
    if (socket._role === 'host') {
      room.hostTeam = teamData;
      if (room.guest) room.guest.emit('opponentTeamSelected', { teamData });
    } else if (socket._role === 'guest') {
      room.guestTeam = teamData;
      room.host.emit('opponentTeamSelected', { teamData });
    }
  });

  // ---- Ready / Match start ----
  const crypto = require('crypto');
  socket.on('playerReady', ({ teamData, matchConfig }) => {
    const room = rooms[socket._roomCode];
    if (!room) return;
    if (socket._role === 'host') {
      room.hostReady = true;
      room.hostTeam  = teamData || room.hostTeam;
      if (matchConfig) room.matchConfig = matchConfig;
      if (room.guest) room.guest.emit('opponentReady', { teamData: room.hostTeam });
    } else if (socket._role === 'guest') {
      room.guestReady = true;
      room.guestTeam  = teamData || room.guestTeam;
      room.host.emit('opponentReady', { teamData: room.guestTeam });
    }
    if (room.hostReady && room.guestReady) {
      room.matchState = 'LOCKED';
      // Assign UUIDs to squads
      if (room.hostTeam && room.hostTeam.squad) {
         room.hostTeam.squad.forEach(p => p.mpId = crypto.randomUUID());
      }
      if (room.guestTeam && room.guestTeam.squad) {
         room.guestTeam.squad.forEach(p => p.mpId = crypto.randomUUID());
      }
      
      io.to(room.code).emit('matchLocked', {
        hostTeam:  room.hostTeam,
        guestTeam: room.guestTeam,
        matchConfig: room.matchConfig || {}
      });
      console.log(`[Room] ${room.code} MATCH LOCKED`);
      
      room.hostLoaded = false;
      room.guestLoaded = false;
      
      room.sceneLoadTimeout = setTimeout(() => {
        io.to(room.code).emit('matchCancelled', { reason: 'Timeout waiting for players to load.' });
        room.matchState = 'IDLE';
        room.hostReady = false; room.guestReady = false;
      }, 30000);
    }
  });
  
  socket.on('sceneLoaded', () => {
    const room = rooms[socket._roomCode];
    if (!room) return;
    if (socket._role === 'host') room.hostLoaded = true;
    if (socket._role === 'guest') room.guestLoaded = true;
    
    if (room.hostLoaded && room.guestLoaded) {
       clearTimeout(room.sceneLoadTimeout);
       room.matchState = 'PLAYING';
       io.to(room.code).emit('kickoff');
       console.log(`[Room] ${room.code} KICKOFF!`);
    }
  });

  // ---- NTP clock sync ----
  socket.on('clockSync', ({ clientTime }) => {
    socket.emit('clockSyncReply', { clientTime, serverTime: Date.now() });
  });

  // ---- Relay: Guest → Host ----
  socket.on('guestInput', (input) => {
    const room = rooms[socket._roomCode];
    if (room && room.host) room.host.emit('guestInput', input);
  });

  socket.on('guestAction', (action) => {
    const room = rooms[socket._roomCode];
    if (room && room.host) room.host.emit('guestAction', action);
  });

  socket.on('guestSwitchPlayer', (data) => {
    const room = rooms[socket._roomCode];
    if (room && room.host) room.host.emit('guestSwitchPlayer', data);
  });

  // ---- Relay: Host → Guest + Spectators ----
  socket.on('hostGameState', (state) => {
    const room = rooms[socket._roomCode];
    if (!room || socket._role !== 'host') return;

    // Run Match Validator
    const warnings = validateHostState(room, state);
    if (warnings.length > 0) {
      console.warn(`[Validator] ${room.code}: ${warnings.join(', ')}`);
      // For now, log warnings. In production, repeated violations → disconnect.
    }

    // Relay to guest
    if (room.guest) room.guest.emit('hostGameState', state);
    // Relay to spectators
    room.spectators.forEach(s => s.emit('hostGameState', state));
  });

  socket.on('hostEvent', (event) => {
    const room = rooms[socket._roomCode];
    if (!room || socket._role !== 'host') return;
    if (room.guest) room.guest.emit('hostEvent', event);
    room.spectators.forEach(s => s.emit('hostEvent', event));
  });

  // ---- Match state changes from Host ----
  socket.on('matchStateChange', ({ newState }) => {
    const room = rooms[socket._roomCode];
    if (!room || socket._role !== 'host') return;
    room.matchState = newState;
    if (room.guest) room.guest.emit('matchStateChange', { newState });
    room.spectators.forEach(s => s.emit('matchStateChange', { newState }));
  });

  // ---- Pause / Resume ----
  socket.on('requestPause', () => {
    const room = rooms[socket._roomCode];
    if (!room) return;
    room.matchState = 'PAUSED';
    io.to(room.code).emit('matchPaused', { by: socket._role });
  });

  socket.on('requestResume', () => {
    const room = rooms[socket._roomCode];
    if (!room) return;
    room.matchState = 'PLAYING';
    io.to(room.code).emit('matchResumed');
  });

  // ---- Disconnect ----
  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    leaveRoom(socket);
  });
});

function leaveRoom(socket) {
  const code = socket._roomCode;
  if (!code) return;
  const room = rooms[code];
  if (!room) { socket._roomCode = null; socket._role = null; socket._playerId = null; return; }

  if (socket._role === 'host') {
    room.host = null;
    if (room.guest) room.guest.emit('opponentDisconnectedGrace', { who: 'host' });
    console.log(`[Room] ${code} Host disconnected. Starting 10s grace period.`);
    room.hostDisconnectTimeout = setTimeout(() => {
      io.to(code).emit('opponentDisconnected', { who: 'host' });
      destroyRoom(code);
    }, 10000);
  } else if (socket._role === 'guest') {
    room.guest = null;
    if (room.host) room.host.emit('opponentDisconnectedGrace', { who: 'guest' });
    console.log(`[Room] ${code} Guest disconnected. Starting 10s grace period.`);
    room.guestDisconnectTimeout = setTimeout(() => {
      room.guestReady = false;
      room.guestTeam  = null;
      room.guestId    = null;
      if (room.matchState === 'LOBBY') {
        room.matchState = 'LOBBY';
      } else {
        // Technical Surrender
        room.matchState = 'ENDED';
      }
      if (room.host) room.host.emit('opponentDisconnected', { who: 'guest' });
    }, 10000);
  } else if (socket._role === 'spectator') {
    room.spectators = room.spectators.filter(s => s !== socket);
  }
  socket._roomCode = null;
  socket._role     = null;
  socket._playerId = null;
}

// ======================== START =============================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  ⚽ Football Pro 3D Server`);
  console.log(`  🌐 http://localhost:${PORT}\n`);
});
