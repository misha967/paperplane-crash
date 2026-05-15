const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(express.static('public'));

const SECRET = 'paperplane_secret';
const users = {};
const connectedUsers = {}; // socketId -> username
const gameState = {
  multiplier: 1.0,
  phase: 'waiting',
  bets: {}
};
let gameInterval = null;
const crashHistory = []; // derniers 10 crashs

// ─── AUTH ─────────────────────────────────────────────────────
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (users[username]) return res.json({ error: 'Utilisateur existe déjà' });
  const hash = await bcrypt.hash(password, 10);
  users[username] = { password: hash, balance: 1000 };
  const token = jwt.sign({ username }, SECRET);
  res.json({ success: true, token, balance: 1000 });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user) return res.json({ error: 'Utilisateur introuvable' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.json({ error: 'Mot de passe incorrect' });
  const token = jwt.sign({ username }, SECRET);
  res.json({ token, balance: user.balance });
});

// ─── HELPERS ──────────────────────────────────────────────────
function getLeaderboard() {
  return Object.entries(users)
    .map(([username, data]) => ({ username, balance: data.balance }))
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 10);
}

function getActiveBets() {
  return Object.entries(gameState.bets).map(([username, bet]) => ({
    username,
    amount: bet.amount,
    cashedOut: bet.cashedOut,
    multiplier: bet.cashoutMultiplier || null
  }));
}

function broadcastLobby() {
  io.emit('lobby_update', {
    connectedCount: Object.keys(connectedUsers).length,
    connectedUsers: Object.values(connectedUsers),
    leaderboard: getLeaderboard(),
    activeBets: getActiveBets()
  });
}

// ─── GAME LOOP ────────────────────────────────────────────────
function startBetting() {
  gameState.phase = 'betting';
  gameState.bets = {};
  gameState.multiplier = 1.0;
  io.emit('betting_phase', { duration: 5000 });
  broadcastLobby();
  setTimeout(startFlying, 5000);
}

function startFlying() {
  gameState.phase = 'flying';
  const crashPoint = parseFloat((1.2 + Math.random() * 8.8).toFixed(2));
  io.emit('game_start');

  if (gameInterval) clearInterval(gameInterval);

  gameInterval = setInterval(() => {
    gameState.multiplier = parseFloat((gameState.multiplier + 0.05).toFixed(2));
    io.emit('multiplier_update', { multiplier: gameState.multiplier });
    io.emit('bets_update', { activeBets: getActiveBets() });

    if (gameState.multiplier >= crashPoint) {
      clearInterval(gameInterval);
      gameInterval = null;
      gameState.phase = 'crashed';

      // Historique
      crashHistory.unshift(parseFloat(gameState.multiplier.toFixed(2)));
      if (crashHistory.length > 10) crashHistory.pop();

      // Notifier les perdants
      Object.entries(gameState.bets).forEach(([username, bet]) => {
        if (!bet.cashedOut) {
          io.to(bet.socketId).emit('lost', { crashAt: gameState.multiplier });
        }
      });

      io.emit('game_crash', {
        crashAt: gameState.multiplier,
        crashHistory: [...crashHistory]
      });

      broadcastLobby();
      setTimeout(startBetting, 4000);
    }
  }, 200);
}

// ─── SOCKETS ──────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('🔌 Connecté :', socket.id);

  // Envoyer l'état actuel
  socket.emit('crash_history', { crashHistory: [...crashHistory] });
  if (gameState.phase === 'betting') {
    socket.emit('betting_phase', { duration: 3000 });
  } else if (gameState.phase === 'flying') {
    socket.emit('game_start');
    socket.emit('multiplier_update', { multiplier: gameState.multiplier });
  }

  // ── IDENTIFY (après login/register) ──
  socket.on('identify', (data) => {
    try {
      const decoded = jwt.verify(data.token, SECRET);
      connectedUsers[socket.id] = decoded.username;
      broadcastLobby();
    } catch (e) {}
  });

  // ── BET ──
  socket.on('place_bet', (data) => {
    if (gameState.phase !== 'betting') {
      return socket.emit('bet_error', { message: 'Phase de mise terminée' });
    }
    try {
      const decoded = jwt.verify(data.token, SECRET);
      const user = users[decoded.username];
      if (!user) return socket.emit('bet_error', { message: 'Utilisateur introuvable' });
      if (!data.amount || data.amount <= 0) return socket.emit('bet_error', { message: 'Mise invalide' });
      if (user.balance < data.amount) return socket.emit('bet_error', { message: 'Solde insuffisant' });
      if (gameState.bets[decoded.username]) return socket.emit('bet_error', { message: 'Mise déjà placée' });

      user.balance = parseFloat((user.balance - data.amount).toFixed(2));
      gameState.bets[decoded.username] = {
        amount: data.amount,
        socketId: socket.id,
        cashedOut: false,
        cashoutMultiplier: null
      };

      socket.emit('bet_placed', { balance: user.balance, amount: data.amount });
      broadcastLobby();
    } catch (e) {
      socket.emit('bet_error', { message: 'Token invalide' });
    }
  });

  // ── CASHOUT ──
  socket.on('cashout', (data) => {
    if (gameState.phase !== 'flying') {
      return socket.emit('cashout_error', { message: 'Pas en vol' });
    }
    try {
      const decoded = jwt.verify(data.token, SECRET);
      const bet = gameState.bets[decoded.username];
      if (!bet) return socket.emit('cashout_error', { message: 'Aucune mise trouvée' });
      if (bet.cashedOut) return socket.emit('cashout_error', { message: 'Déjà cashout' });

      bet.cashedOut = true;
      bet.cashoutMultiplier = gameState.multiplier;
      const winnings = parseFloat((bet.amount * gameState.multiplier).toFixed(2));
      const profit = parseFloat((winnings - bet.amount).toFixed(2));
      users[decoded.username].balance = parseFloat(
        (users[decoded.username].balance + winnings).toFixed(2)
      );

      socket.emit('cashout_success', {
        multiplier: gameState.multiplier,
        winnings,
        profit,
        balance: users[decoded.username].balance
      });

      broadcastLobby();
    } catch (e) {
      socket.emit('cashout_error', { message: 'Token invalide' });
    }
  });

  // ── EMOJI ──
  socket.on('send_emoji', (data) => {
    try {
      const decoded = jwt.verify(data.token, SECRET);
      const allowed = ['💩', '🖕', '🍆', '😂', '🔥', '💸', '😱'];
      if (!allowed.includes(data.emoji)) return;
      io.emit('emoji_received', {
        username: decoded.username,
        emoji: data.emoji
      });
    } catch (e) {}
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    delete connectedUsers[socket.id];
    broadcastLobby();
    console.log('❌ Déconnecté :', socket.id);
  });
});

// ─── START ────────────────────────────────────────────────────
server.listen(3000, () => {
  console.log('✈️  Paperplane Crash → http://localhost:3000');
  startBetting();
});
