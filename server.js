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
const gameState = {
  multiplier: 1.0,
  phase: 'waiting',
  bets: {}
};
let gameInterval = null;

// ─── AUTH ───────────────────────────────────────────────
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

// ─── GAME LOOP ───────────────────────────────────────────
function startBetting() {
  gameState.phase = 'betting';
  gameState.bets = {};
  gameState.multiplier = 1.0;
  io.emit('betting_phase', { duration: 5000 });
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

    if (gameState.multiplier >= crashPoint) {
      clearInterval(gameInterval);
      gameInterval = null;
      gameState.phase = 'crashed';

      // Notifier ceux qui n'ont pas cashout
      Object.entries(gameState.bets).forEach(([username, bet]) => {
        if (!bet.cashedOut) {
          io.to(bet.socketId).emit('lost', {
            crashAt: gameState.multiplier
          });
        }
      });

      io.emit('game_crash', { crashAt: gameState.multiplier });
      setTimeout(startBetting, 4000);
    }
  }, 100);
}

// ─── SOCKET ──────────────────────────────────────────────
io.on('connection', (socket) => {
  // Envoie l'état au nouveau connecté
  if (gameState.phase === 'betting') {
    socket.emit('betting_phase', { duration: 2000 });
  } else if (gameState.phase === 'flying') {
    socket.emit('game_start');
    socket.emit('multiplier_update', { multiplier: gameState.multiplier });
  } else if (gameState.phase === 'crashed') {
    socket.emit('game_crash', { crashAt: gameState.multiplier });
  }

  // ── MISE ──
  socket.on('place_bet', (data) => {
    if (gameState.phase !== 'betting') {
      return socket.emit('bet_error', { message: 'Phase de mise terminée' });
    }
    try {
      const decoded = jwt.verify(data.token, SECRET);
      const user = users[decoded.username];
      if (!user) return socket.emit('bet_error', { message: 'Utilisateur introuvable' });
      if (data.amount <= 0) return socket.emit('bet_error', { message: 'Mise invalide' });
      if (user.balance < data.amount) return socket.emit('bet_error', { message: 'Solde insuffisant' });

      user.balance = parseFloat((user.balance - data.amount).toFixed(2));
      gameState.bets[decoded.username] = {
        amount: data.amount,
        socketId: socket.id,
        cashedOut: false
      };

      socket.emit('bet_placed', { balance: user.balance, amount: data.amount });
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
    } catch (e) {
      socket.emit('cashout_error', { message: 'Token invalide' });
    }
  });

  socket.on('disconnect', () => {});
});

// ─── START ───────────────────────────────────────────────
server.listen(3000, () => {
  console.log('✈️  Paperplane Crash sur http://localhost:3000');
  startBetting();
});
