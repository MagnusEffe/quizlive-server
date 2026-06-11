const express = require('express');
const crypto  = require('crypto');
const http    = require('http');
const { Server } = require('socket.io');
const QRCode  = require('qrcode');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// CORS + body parser
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '20mb' }));

// ─── In-memory state ──────────────────────────────────────────────────────────
const rooms = {};

function generateCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sans I et O pour éviter confusion
  return Array.from({length: 5}, () => letters[Math.floor(Math.random() * letters.length)]).join('');
}

// ─── REST ─────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, rooms: Object.keys(rooms).length }));

app.post('/api/room', async (req, res) => {
  const { questions } = req.body;
  if (!questions || !questions.length) return res.status(400).json({ error: 'No questions' });

  const code = generateCode();
  rooms[code] = {
    code, hostId: null, questions,
    players: {}, state: 'lobby', currentQ: -1, timer: null, questionStart: null,
    registeredPlayers: null, // snapshot au lancement de la 1ère question
  };

  const frontendBase = process.env.FRONTEND_URL || 'https://www.effeprod.net/apps/defi-interactif';
  const url = `${frontendBase}/?room=${code}`;
  const qr  = await QRCode.toDataURL(url, { width: 300, margin: 2, color: { dark: '#1a1a2e', light: '#ffffff' } });
  res.json({ code, url, qr });
});

app.get('/api/room/:code', (req, res) => {
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ code: room.code, state: room.state, playerCount: Object.keys(room.players).length, questionCount: room.questions.length });
});

// Export endpoint: full player history for XLSX
app.get('/api/room/:code/results', (req, res) => {
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const players = Object.values(room.players)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score, history: p.history }));
  res.json({ players, questions: room.questions });
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // HOST
  socket.on('host:claim', ({ code }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', 'Room not found');
    room.hostId = socket.id;
    socket.join(`room:${code}`);
    socket.join(`host:${code}`);
    socket.emit('host:claimed', { code, playerCount: Object.keys(room.players).length, questionCount: room.questions.length });
  });

  // PLAYER JOIN
  socket.on('player:join', ({ code, name }) => {
    const roomCode = code?.toUpperCase();
    const room = rooms[roomCode];
    if (!room) return socket.emit('error', 'Room introuvable');

    const trimmed = name?.trim().substring(0, 20);
    if (!trimmed) return socket.emit('error', 'Pseudo invalide');
    const nameLower = trimmed.toLowerCase();

    if (room.state === 'lobby') {
      // Inscription normale
      if (Object.values(room.players).some(p => p.name.toLowerCase() === nameLower))
        return socket.emit('error', 'Ce pseudo est déjà pris');

      room.players[socket.id] = { name: trimmed, score: 0, answered: false, history: [] };
      socket.data.room = roomCode;
      socket.data.name = trimmed;
      socket.join(`room:${roomCode}`);
      socket.emit('player:joined', { name: trimmed, code: roomCode });
      const playerList = Object.values(room.players).map(p => ({ name: p.name }));
      io.to(`host:${roomCode}`).emit('host:playerJoined', { players: getLeaderboard(room) });
      io.to(`room:${roomCode}`).emit('lobby:players', { players: playerList });

    } else {
      // Partie en cours — reconnexion par nom
      if (!room.registeredPlayers || !room.registeredPlayers.has(nameLower))
        return socket.emit('error', "Ce pseudo n'est pas inscrit dans cette partie");

      if (Object.values(room.players).some(p => p.name.toLowerCase() === nameLower))
        return socket.emit('error', 'Ce pseudo est déjà connecté');

      // Restaurer le score et l'historique depuis le snapshot
      const saved = room.registeredPlayers.get(nameLower);
      room.players[socket.id] = {
        name: trimmed,
        score:   saved ? saved.score   : 0,
        history: saved ? saved.history : [],
        answered: false,
      };
      socket.data.room = roomCode;
      socket.data.name = trimmed;
      socket.join(`room:${roomCode}`);

      socket.emit('reconnect:ok', {
        name: trimmed, code: roomCode, token: null,
        score: room.players[socket.id].score, state: room.state,
      });

      if (room.state === 'question' && room.currentQ >= 0) {
        const q = room.questions[room.currentQ];
        const remaining = Math.max(1, (q.time||20) - Math.floor((Date.now()-room.questionStart)/1000));
        socket.emit('game:question', {
          index: room.currentQ, total: room.questions.length,
          question: q.question, answers: q.answers, timeLimit: remaining, image: q.image||null,
        });
      } else if (room.state === 'reading' && room.currentQ >= 0) {
        const q = room.questions[room.currentQ];
        socket.emit('game:reading', {
          index: room.currentQ, total: room.questions.length,
          question: q.question, image: q.image||null, readTime: 5,
        });
      } else if (room.state === 'results' && room.currentQ >= 0) {
        const q = room.questions[room.currentQ];
        const corrArr = Array.isArray(q.correct) ? q.correct : [q.correct];
        socket.emit('game:questionEnd', {
          correctAnswers: corrArr, correctLabel: corrArr.map(i => q.answers[i]).join(' / '),
          explication: q.explication||'', leaderboard: getLeaderboard(room),
          totalPlayers: Object.keys(room.players).length,
          isLast: room.currentQ === room.questions.length-1,
        });
      }
      io.to(`host:${roomCode}`).emit('host:playerJoined', { players: getLeaderboard(room) });
    }
  });
  // HOST START
  socket.on('host:start', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    if (!Object.keys(room.players).length) return socket.emit('error', 'Aucun joueur');
    nextQuestion(room);
  });

  // HOST NEXT
  socket.on('host:next', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    if (room.state === 'results') {
      // Check if last question was just played
      if (room.currentQ >= room.questions.length - 1) {
        endGame(room);
      } else {
        nextQuestion(room);
      }
    }
  });

  // PLAYER ANSWER
  socket.on('player:answer', ({ code, answerIndex }) => {
    // Priorité au code stocké dans socket.data (plus fiable que l'URL client)
    const roomCode = socket.data?.room || code?.toUpperCase();
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player || player.answered) return;
    if (room.state !== 'question') return; // ignore pendant la phase lecture

    player.answered = true;
    const elapsed = Date.now() - room.questionStart;
    const q = room.questions[room.currentQ];
    // correct peut être un tableau [0,2] ou un entier 1 (rétrocompatibilité)
    const correctArr = Array.isArray(q.correct) ? q.correct : [q.correct];
    const isCorrect = correctArr.includes(answerIndex);
    let points = 0;
    if (isCorrect) {
      const timeLimit = (q.time || 20) * 1000;
      points = 1000 + Math.round(500 * Math.max(0, 1 - elapsed / timeLimit));
      player.score += points;
    }

    // Mettre à jour le score dans le snapshot pour la reconnexion
    if (room.registeredPlayers && room.registeredPlayers.has(player.name.toLowerCase())) {
      const snap = room.registeredPlayers.get(player.name.toLowerCase());
      snap.score = player.score;
      snap.history = player.history;
    }

    // Store answer detail for export
    player.history.push({
      questionIndex: room.currentQ,
      question:      q.question,
      given:         q.answers[answerIndex],
      correct:       q.answers[q.correct],
      isCorrect,
      elapsed:       Math.round(elapsed / 100) / 10, // seconds, 1 decimal
      basePoints:    isCorrect ? 1000 : 0,
      speedBonus:    isCorrect ? points - 1000 : 0,
      points,
    });

    socket.emit('player:answerResult', {
      correct: isCorrect,
      points,
      score: player.score,
      correctAnswer: q.correct,
      correctLabel: (Array.isArray(q.correct) ? q.correct : [q.correct])
                   .map(i => q.answers[i]).join(' / '),
      explication: q.explication || '',
    });

    const answeredCount = Object.values(room.players).filter(p => p.answered).length;
    const totalPlayers  = Object.keys(room.players).length;
    io.to(`host:${roomCode}`).emit('host:answerUpdate', { answeredCount, totalPlayers });
    if (answeredCount === totalPlayers) endQuestion(room);
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    const code = socket.data?.room;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (room.hostId === socket.id) {
      clearTimeout(room.timer);
      io.to(`room:${code}`).emit('game:hostLeft');
      // Délai pour laisser le message arriver avant de supprimer la room
      setTimeout(() => { delete rooms[code]; }, 2000);
      return;
    }
    delete room.players[socket.id];
    const playerList2 = Object.values(room.players).map(p => ({ name: p.name }));
    io.to(`host:${code}`).emit('host:playerLeft', { players: getLeaderboard(room) });
    io.to(`room:${code}`).emit('lobby:players', { players: playerList2 });
  });
});

// ─── Game logic ───────────────────────────────────────────────────────────────
const READ_TIME = 5; // secondes de lecture avant les réponses

function nextQuestion(room) {
  // Snapshot à la première question : sauvegarde nom + score initial
  if (room.currentQ === -1 && !room.registeredPlayers) {
    room.registeredPlayers = new Map(
      Object.values(room.players).map(p => [p.name.toLowerCase(), { score: p.score, history: p.history }])
    );
  }
  room.currentQ++;
  if (room.currentQ >= room.questions.length) return endGame(room);

  const q = room.questions[room.currentQ];
  const timeLimit = q.time || 20;
  Object.values(room.players).forEach(p => (p.answered = false));

  // Phase lecture
  room.state = 'reading';
  io.to(`room:${room.code}`).emit('game:reading', {
    index:    room.currentQ,
    total:    room.questions.length,
    question: q.question,
    image:    q.image || null,
    readTime: READ_TIME,
  });

  // Après la phase lecture → phase question
  clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    room.state = 'question';
    room.questionStart = Date.now();
    io.to(`room:${room.code}`).emit('game:question', {
      index:     room.currentQ,
      total:     room.questions.length,
      question:  q.question,
      answers:   q.answers,
      timeLimit,
      image:     q.image || null,
    });
    room.timer = setTimeout(() => endQuestion(room), timeLimit * 1000);
  }, READ_TIME * 1000);
}

function endQuestion(room) {
  clearTimeout(room.timer);
  if (room.state !== 'question') return;
  room.state = 'results';

  const q = room.questions[room.currentQ];
  const leaderboard = getLeaderboard(room);
  const isLast = room.currentQ === room.questions.length - 1;

  io.to(`room:${room.code}`).emit('game:questionEnd', {
    correctAnswers: Array.isArray(q.correct) ? q.correct : [q.correct],
    correctLabel:  (Array.isArray(q.correct) ? q.correct : [q.correct])
                   .map(i => q.answers[i]).join(' / '),
    explication:   q.explication || '',
    leaderboard,
    totalPlayers:  Object.keys(room.players).length,
    isLast,
  });

  // Si dernière question : l'hôte déclenche la fin manuellement via host:next
}

function endGame(room) {
  room.state = 'podium';
  io.to(`room:${room.code}`).emit('game:over', { leaderboard: getLeaderboard(room) });
}

function getLeaderboard(room) {
  return Object.entries(room.players)
    .map(([id, p]) => ({ id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮 QuizLive running on port ${PORT}\n`);
});
