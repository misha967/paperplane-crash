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

app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (users[username]) return res.json({ error: 'Utilisateur existe déjà' });
  const hash = await bcrypt.hash(password, 10);
  users[username] = { password: hash, balance: 1000 };
  res.json({ success: true });
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

function startBetting() {
  gameState.phase = 'betting';
  gameState.bets = {};
  gameState.multiplier = 1.0;
  io.emit('phase', { phase: 'betting', duration: 5000 });
  setTimeout(startFlying, 5000);
}

function startFlying() {
  gameState.phase = 'flying';
  const crashPoint = Math.max(1.0, parseFloat((Math.random() * 10).toFixed(2)));
  io.emit('phase', { phase: 'flying' });

  const interval = setInterval(() => {
    gameState.multiplier = parseFloat((gameState.multiplier + 0.05).toFixed(2));
    io.emit('multiplier', { value: gameState.multiplier });

    if (gameState.multiplier >= crashPoint) {
      clearInterval(interval);
      gameState.phase = 'crashed';
      io.emit('phase', { phase: 'crashed', crashPoint });
      setTimeout(startBetting, 5000);
    }
  }, 200);
}

io.on('connection', (socket) => {
  socket.emit('phase', { phase: gameState.phase });

  socket.on('bet', (data) => {
    if (gameState.phase !== 'betting') return;
    const decoded = jwt.verify(data.token, SECRET);
    const user = users[decoded.username];
    if (!user || user.balance < data.amount) return;
    user.balance -= data.amount;
    gameState.bets[decoded.username] = { amount: data.amount, socketId: socket.id };
    socket.emit('balance', { balance: user.balance });
  });

  socket.on('cashout', (data) => {
    if (gameState.phase !== 'flying') return;
    const decoded = jwt.verify(data.token, SECRET);
    const bet = gameState.bets[decoded.username];
    if (!bet || bet.cashedOut) return;
    bet.cashedOut = true;
    const winnings = parseFloat((bet.amount * gameState.multiplier).toFixed(2));
    users[decoded.username].balance += winnings;
    socket.emit('cashout', { multiplier: gameState.multiplier, winnings });
    socket.emit('balance', { balance: users[decoded.username].balance });
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log('Serveur démarré');
  startBetting();
});
