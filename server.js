const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// CORS headers pour les endpoints REST Express
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// Health check for Render (keeps the instance awake)
app.get('/health', (_, res) => res.json({ ok: true, rooms: Object.keys(rooms).length }));

// ─── In-memory state ──────────────────────────────────────────────────────────
const rooms = {}; // roomCode → RoomState

function generateCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function createRoom(hostId, questions) {
  const code = generateCode();
  rooms[code] = {
    code,
    hostId,
    questions,
    players: {},       // socketId → { name, score, answered }
    state: 'lobby',    // lobby | question | results | podium
    currentQ: -1,
    timer: null,
    questionStart: null,
  };
  return code;
}

// ─── REST endpoints ───────────────────────────────────────────────────────────

// Create a room (called by host)
app.post('/api/room', async (req, res) => {
  const { questions } = req.body;
  if (!questions || !questions.length) return res.status(400).json({ error: 'No questions' });
  const hostId = 'pending'; // Will be set on socket connect
  const code = generateCode();
  rooms[code] = {
    code,
    hostId: null,
    questions,
    players: {},
    state: 'lobby',
    currentQ: -1,
    timer: null,
    questionStart: null,
  };
  // QR code pointe vers le frontend sur effeprod.net
  const frontendBase = process.env.FRONTEND_URL || 'https://www.effeprod.net/apps/defi-interactif';
  const url = `${frontendBase}/?room=${code}`;
  const qr = await QRCode.toDataURL(url, { width: 300, margin: 2, color: { dark: '#1a1a2e', light: '#ffffff' } });
  res.json({ code, url, qr });
});

// Get room info (for join page)
app.get('/api/room/:code', (req, res) => {
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    code: room.code,
    state: room.state,
    playerCount: Object.keys(room.players).length,
    questionCount: room.questions.length,
  });
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // HOST: claim a room
  socket.on('host:claim', ({ code }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', 'Room not found');
    room.hostId = socket.id;
    socket.join(`room:${code}`);
    socket.join(`host:${code}`);
    socket.emit('host:claimed', {
      code,
      playerCount: Object.keys(room.players).length,
      questionCount: room.questions.length,
    });
  });

  // PLAYER: join a room
  socket.on('player:join', ({ code, name }) => {
    const room = rooms[code?.toUpperCase()];
    if (!room) return socket.emit('error', 'Room introuvable');
    if (room.state !== 'lobby') return socket.emit('error', 'Partie déjà commencée');

    const trimmedName = name?.trim().substring(0, 20);
    if (!trimmedName) return socket.emit('error', 'Pseudo invalide');

    // Check duplicate names
    const names = Object.values(room.players).map(p => p.name.toLowerCase());
    if (names.includes(trimmedName.toLowerCase())) {
      return socket.emit('error', 'Ce pseudo est déjà pris');
    }

    room.players[socket.id] = { name: trimmedName, score: 0, answered: false };
    socket.join(`room:${code}`);
    socket.data.room = code;
    socket.data.name = trimmedName;

    socket.emit('player:joined', { name: trimmedName, code });

    // Notify host
    io.to(`host:${code}`).emit('host:playerJoined', {
      players: getLeaderboard(room),
    });
  });

  // HOST: start the game
  socket.on('host:start', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    if (Object.keys(room.players).length < 1) return socket.emit('error', 'Aucun joueur');
    nextQuestion(room);
  });

  // HOST: next question (manual mode)
  socket.on('host:next', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    if (room.state === 'results') nextQuestion(room);
  });

  // PLAYER: submit answer
  socket.on('player:answer', ({ code, answerIndex }) => {
    const room = rooms[code?.toUpperCase() || socket.data?.room];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player || player.answered) return;
    if (room.state !== 'question') return;

    player.answered = true;
    const elapsed = Date.now() - room.questionStart;
    const q = room.questions[room.currentQ];
    const isCorrect = answerIndex === q.correct;

    // Score: 1000 base, up to 500 bonus for speed (within timer duration)
    let points = 0;
    if (isCorrect) {
      const timeLimit = (q.time || 20) * 1000;
      const speedBonus = Math.round(500 * Math.max(0, 1 - elapsed / timeLimit));
      points = 1000 + speedBonus;
      player.score += points;
    }

    socket.emit('player:answerResult', {
      correct: isCorrect,
      points,
      score: player.score,
      correctAnswer: q.correct,
    });

    // Tell host someone answered
    const answeredCount = Object.values(room.players).filter(p => p.answered).length;
    const totalPlayers = Object.keys(room.players).length;
    io.to(`host:${code}`).emit('host:answerUpdate', { answeredCount, totalPlayers });

    // Auto-advance if everyone answered
    if (answeredCount === totalPlayers) {
      endQuestion(room);
    }
  });

  // Disconnect cleanup
  socket.on('disconnect', () => {
    const code = socket.data?.room;
    if (!code || !rooms[code]) return;
    const room = rooms[code];

    if (room.hostId === socket.id) {
      io.to(`room:${code}`).emit('game:hostLeft');
      clearTimeout(room.timer);
      delete rooms[code];
      return;
    }

    delete room.players[socket.id];
    io.to(`host:${code}`).emit('host:playerLeft', {
      players: getLeaderboard(room),
    });
  });
});

// ─── Game logic helpers ───────────────────────────────────────────────────────
function nextQuestion(room) {
  room.currentQ++;
  if (room.currentQ >= room.questions.length) {
    return endGame(room);
  }

  const q = room.questions[room.currentQ];
  const timeLimit = q.time || 20;

  // Reset answered state
  Object.values(room.players).forEach(p => (p.answered = false));

  room.state = 'question';
  room.questionStart = Date.now();

  const payload = {
    index: room.currentQ,
    total: room.questions.length,
    question: q.question,
    answers: q.answers,
    timeLimit,
    image: q.image || null,
  };

  io.to(`room:${room.code}`).emit('game:question', payload);

  // Auto-end after time limit
  clearTimeout(room.timer);
  room.timer = setTimeout(() => endQuestion(room), timeLimit * 1000);
}

function endQuestion(room) {
  clearTimeout(room.timer);
  if (room.state !== 'question') return;
  room.state = 'results';

  const q = room.questions[room.currentQ];
  const leaderboard = getLeaderboard(room);

  io.to(`room:${room.code}`).emit('game:questionEnd', {
    correctAnswer: q.correct,
    correctLabel: q.answers[q.correct],
    leaderboard,
    isLast: room.currentQ === room.questions.length - 1,
  });
}

function endGame(room) {
  room.state = 'podium';
  const leaderboard = getLeaderboard(room);
  io.to(`room:${room.code}`).emit('game:over', { leaderboard });
}

function getLeaderboard(room) {
  return Object.entries(room.players)
    .map(([id, p]) => ({ id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮 Kahoot PWA running on http://localhost:${PORT}`);
  console.log(`   Host:   http://localhost:${PORT}/host.html`);
  console.log(`   Player: http://localhost:${PORT}/\n`);
});
