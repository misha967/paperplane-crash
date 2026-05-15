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
  running: false,
  bets: {}
};

// Auth routes
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

// Game loop
function startGame() {
  gameState.running = true;
  gameState.multiplier = 1.0;
  gameState.bets = {};
  io.emit('game_start');

  const crashPoint = Math.max(1, -Math.log(Math.random()) * 2);
  
  const interval = setInterval(() => {
    gameState.multiplier += 0.01;
    io.emit('multiplier_update', { multiplier: gameState.multiplier.toFixed(2) });

    if (gameState.multiplier >= crashPoint) {
      clearInterval(interval);
      gameState.running = false;
      io.emit('game_crash', { crashAt: gameState.multiplier.toFixed(2) });
      
      // Perte pour ceux qui n'ont pas cashout
      for (const user in gameState.bets) {
        if (!gameState.bets[user].cashedOut) {
          users[user].balance -= gameState.bets[user].amount;
        }
      }
      
      setTimeout(startGame, 5000);
    }
  }, 100);
}

// Socket events
io.on('connection', (socket) => {
  socket.on('place_bet', ({ token, amount }) => {
    try {
      const { username } = jwt.verify(token, SECRET);
      if (!gameState.running) return;
      if (users[username].balance < amount) return;
      gameState.bets[username] = { amount, cashedOut: false };
      socket.username = username;
    } catch(e) {}
  });

  socket.on('cashout', ({ token }) => {
    try {
      const { username } = jwt.verify(token, SECRET);
      if (!gameState.bets[username] || gameState.bets[username].cashedOut) return;
      gameState.bets[username].cashedOut = true;
      const profit = gameState.bets[username].amount * gameState.multiplier;
      users[username].balance += profit;
      socket.emit('cashout_success', { 
        balance: users[username].balance.toFixed(2),
        profit: profit.toFixed(2)
      });
    } catch(e) {}
  });
});

server.listen(3000, () => {
  console.log('Server running on port 3000');
  startGame();
});
