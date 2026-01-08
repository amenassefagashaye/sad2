// server.ts - Deno Backend Server
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { WebSocket, isWebSocketCloseEvent } from "https://deno.land/std@0.168.0/ws/mod.ts";

// Game State Interface
interface Player {
  id: string;
  name: string;
  phone: string;
  boardType: string;
  boardNumber: string;
  stake: number;
  ws?: WebSocket;
  balance: number;
  totalWon: number;
  joinedAt: Date;
  lastActive: Date;
}

interface GameState {
  gameActive: boolean;
  calledNumbers: number[];
  players: Map<string, Player>;
  currentNumber: number | null;
  startedAt: Date | null;
  winner: string | null;
  prizePool: number;
  adminConnections: Set<WebSocket>;
}

// Config
const CONFIG = {
  MAX_PLAYERS: 90,
  SERVICE_FEE: 0.03, // 3%
  MIN_STAKE: 25,
  MAX_STAKE: 5000,
  ADMIN_KEY: "asse2123",
  PORT: 8000,
  HOST: "0.0.0.0"
};

// Initialize Game State
const gameState: GameState = {
  gameActive: false,
  calledNumbers: [],
  players: new Map(),
  currentNumber: null,
  startedAt: null,
  winner: null,
  prizePool: 0,
  adminConnections: new Set()
};

// Utility Functions
function generatePlayerId(): string {
  return `player_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function calculatePrize(stake: number, totalPlayers: number): number {
  const pool = stake * totalPlayers * 0.8; // 80% prize pool
  const prize = Math.floor(pool * (1 - CONFIG.SERVICE_FEE));
  return prize;
}

function getNumberDisplay(number: number, boardType: string): string {
  if (boardType === '75ball' || boardType === 'pattern') {
    const letters = 'BINGO';
    const columnSize = 15;
    const columnIndex = Math.floor((number - 1) / columnSize);
    const letter = letters[Math.min(columnIndex, 4)];
    return `${letter}-${number}`;
  }
  return number.toString();
}

function validateAdmin(request: Request): boolean {
  const url = new URL(request.url);
  const adminKey = url.searchParams.get('admin');
  return adminKey === CONFIG.ADMIN_KEY;
}

// WebSocket Handler
async function handleWebSocket(socket: WebSocket, request: Request) {
  const isAdmin = validateAdmin(request);
  
  if (isAdmin) {
    console.log('Admin connected');
    gameState.adminConnections.add(socket);
    
    socket.send(JSON.stringify({
      type: 'admin_connected',
      gameState: {
        gameActive: gameState.gameActive,
        calledNumbers: gameState.calledNumbers,
        players: Array.from(gameState.players.values()).map(p => ({
          id: p.id,
          name: p.name,
          boardType: p.boardType,
          boardNumber: p.boardNumber,
          stake: p.stake,
          balance: p.balance
        })),
        prizePool: gameState.prizePool
      }
    }));
  }
  
  try {
    for await (const event of socket) {
      if (typeof event === 'string') {
        await handleMessage(event, socket, isAdmin);
      } else if (isWebSocketCloseEvent(event)) {
        await handleDisconnect(socket, isAdmin);
        break;
      }
    }
  } catch (err) {
    console.error('WebSocket error:', err);
    await handleDisconnect(socket, isAdmin);
  }
}

// Handle Incoming Messages
async function handleMessage(message: string, socket: WebSocket, isAdmin: boolean) {
  try {
    const data = JSON.parse(message);
    
    if (isAdmin) {
      await handleAdminMessage(data, socket);
      return;
    }
    
    switch (data.type) {
      case 'register':
        await handleRegistration(data, socket);
        break;
        
      case 'reconnect':
        await handleReconnection(data, socket);
        break;
        
      case 'claim_win':
        await handleWinClaim(data);
        break;
        
      case 'chat':
        await handleChatMessage(data);
        break;
        
      case 'withdraw':
        await handleWithdrawal(data);
        break;
        
      case 'disconnect':
        await handlePlayerDisconnect(data.playerId);
        break;
        
      default:
        console.log('Unknown message type:', data.type);
    }
  } catch (err) {
    console.error('Error handling message:', err);
  }
}

// Handle Registration
async function handleRegistration(data: any, socket: WebSocket) {
  if (gameState.players.size >= CONFIG.MAX_PLAYERS) {
    socket.send(JSON.stringify({
      type: 'error',
      message: 'ጨዋታ ተሞልቷል! / Game is full!'
    }));
    return;
  }
  
  const playerId = generatePlayerId();
  const player: Player = {
    id: playerId,
    name: data.name,
    phone: data.phone,
    boardType: data.boardType,
    boardNumber: data.boardNumber,
    stake: Math.max(CONFIG.MIN_STAKE, Math.min(CONFIG.MAX_STAKE, data.stake || CONFIG.MIN_STAKE)),
    balance: 0,
    totalWon: 0,
    ws: socket,
    joinedAt: new Date(),
    lastActive: new Date()
  };
  
  gameState.players.set(playerId, player);
  
  // Update prize pool
  gameState.prizePool += player.stake;
  
  // Send confirmation
  socket.send(JSON.stringify({
    type: 'connected',
    playerId: playerId,
    gameState: {
      gameActive: gameState.gameActive,
      calledNumbers: gameState.calledNumbers,
      players: Array.from(gameState.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        boardType: p.boardType,
        boardNumber: p.boardNumber,
        stake: p.stake
      }))
    }
  }));
  
  // Notify all players
  broadcast({
    type: 'player_joined',
    players: Array.from(gameState.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      boardType: p.boardType,
      boardNumber: p.boardNumber,
      stake: p.stake
    }))
  });
  
  // Notify admins
  notifyAdmins({
    type: 'player_registered',
    player: {
      id: playerId,
      name: data.name,
      phone: data.phone,
      boardType: data.boardType,
      boardNumber: data.boardNumber,
      stake: player.stake
    },
    totalPlayers: gameState.players.size,
    prizePool: gameState.prizePool
  });
}

// Handle Reconnection
async function handleReconnection(data: any, socket: WebSocket) {
  const player = gameState.players.get(data.playerId);
  
  if (player) {
    player.ws = socket;
    player.lastActive = new Date();
    
    socket.send(JSON.stringify({
      type: 'reconnected',
      playerId: data.playerId,
      gameState: {
        gameActive: gameState.gameActive,
        calledNumbers: gameState.calledNumbers,
        players: Array.from(gameState.players.values()).map(p => ({
          id: p.id,
          name: p.name,
          boardType: p.boardType,
          boardNumber: p.boardNumber,
          stake: p.stake
        }))
      }
    }));
  }
}

// Handle Win Claim
async function handleWinClaim(data: any) {
  const player = gameState.players.get(data.playerId);
  
  if (!player || !gameState.gameActive || gameState.winner) {
    return;
  }
  
  // Verify the win (simplified - in production, verify actual pattern)
  const prize = calculatePrize(player.stake, gameState.players.size);
  
  // Mark as winner
  gameState.winner = player.id;
  player.balance += prize;
  player.totalWon += prize;
  
  // Broadcast winner
  broadcast({
    type: 'winner',
    playerId: player.id,
    playerName: player.name,
    prize: prize,
    pattern: data.pattern || 'የተለያየ ንድፍ'
  });
  
  // Stop the game
  gameState.gameActive = false;
  
  // Notify admins
  notifyAdmins({
    type: 'winner_declared',
    player: {
      id: player.id,
      name: player.name,
      phone: player.phone
    },
    prize: prize,
    pattern: data.pattern
  });
}

// Handle Chat Message
async function handleChatMessage(data: any) {
  const player = gameState.players.get(data.playerId);
  
  if (player) {
    player.lastActive = new Date();
    
    broadcast({
      type: 'chat_message',
      player: player.name,
      message: data.message,
      timestamp: new Date().toISOString()
    });
  }
}

// Handle Withdrawal
async function handleWithdrawal(data: any) {
  const player = gameState.players.get(data.playerId);
  
  if (player && player.balance >= data.amount) {
    player.balance -= data.amount;
    
    // In production, integrate with payment gateway
    player.ws?.send(JSON.stringify({
      type: 'withdrawal_processed',
      amount: data.amount,
      account: data.account,
      newBalance: player.balance
    }));
    
    notifyAdmins({
      type: 'withdrawal_request',
      player: {
        id: player.id,
        name: player.name
      },
      amount: data.amount,
      account: data.account
    });
  }
}

// Handle Admin Messages
async function handleAdminMessage(data: any, socket: WebSocket) {
  if (data.type === 'admin_call_number') {
    await callNewNumber();
  } else if (data.type === 'admin_start_game') {
    await startGame();
  } else if (data.type === 'admin_stop_game') {
    await stopGame();
  } else if (data.type === 'admin_reset_game') {
    await resetGame();
  }
}

// Game Control Functions
async function callNewNumber() {
  if (!gameState.gameActive) return;
  
  // Generate unique number
  let number: number;
  do {
    number = Math.floor(Math.random() * 75) + 1;
  } while (gameState.calledNumbers.includes(number));
  
  gameState.calledNumbers.push(number);
  gameState.currentNumber = number;
  
  broadcast({
    type: 'number_called',
    number: number,
    display: getNumberDisplay(number, '75ball'), // Default to 75-ball display
    totalCalled: gameState.calledNumbers.length
  });
  
  notifyAdmins({
    type: 'number_called',
    number: number,
    totalCalled: gameState.calledNumbers.length
  });
}

async function startGame() {
  if (gameState.gameActive) return;
  
  gameState.gameActive = true;
  gameState.startedAt = new Date();
  gameState.winner = null;
  gameState.calledNumbers = [];
  gameState.currentNumber = null;
  
  broadcast({
    type: 'game_started',
    startedAt: gameState.startedAt.toISOString(),
    totalPlayers: gameState.players.size,
    prizePool: gameState.prizePool
  });
  
  notifyAdmins({
    type: 'game_started',
    startedAt: gameState.startedAt.toISOString(),
    totalPlayers: gameState.players.size,
    prizePool: gameState.prizePool
  });
  
  // Start auto-calling every 7 seconds
  const interval = setInterval(async () => {
    if (gameState.gameActive && !gameState.winner) {
      await callNewNumber();
    } else {
      clearInterval(interval);
    }
  }, 7000);
}

async function stopGame() {
  gameState.gameActive = false;
  
  broadcast({
    type: 'game_stopped'
  });
  
  notifyAdmins({
    type: 'game_stopped'
  });
}

async function resetGame() {
  gameState.gameActive = false;
  gameState.calledNumbers = [];
  gameState.currentNumber = null;
  gameState.startedAt = null;
  gameState.winner = null;
  
  // Reset player balances but keep registration
  for (const player of gameState.players.values()) {
    player.balance = 0;
    player.totalWon = 0;
  }
  
  broadcast({
    type: 'game_reset'
  });
  
  notifyAdmins({
    type: 'game_reset',
    totalPlayers: gameState.players.size
  });
}

// Handle Disconnection
async function handleDisconnect(socket: WebSocket, isAdmin: boolean) {
  if (isAdmin) {
    gameState.adminConnections.delete(socket);
    console.log('Admin disconnected');
    return;
  }
  
  // Find and remove player
  for (const [id, player] of gameState.players.entries()) {
    if (player.ws === socket) {
      gameState.players.delete(id);
      
      // Update prize pool
      gameState.prizePool -= player.stake;
      
      // Notify other players
      broadcast({
        type: 'player_left',
        players: Array.from(gameState.players.values()).map(p => ({
          id: p.id,
          name: p.name,
          boardType: p.boardType,
          boardNumber: p.boardNumber,
          stake: p.stake
        }))
      });
      
      // Notify admins
      notifyAdmins({
        type: 'player_disconnected',
        playerId: id,
        playerName: player.name,
        totalPlayers: gameState.players.size,
        prizePool: gameState.prizePool
      });
      
      break;
    }
  }
}

async function handlePlayerDisconnect(playerId: string) {
  const player = gameState.players.get(playerId);
  if (player) {
    gameState.players.delete(playerId);
    gameState.prizePool -= player.stake;
  }
}

// Broadcast to all players
function broadcast(message: any) {
  const jsonMessage = JSON.stringify(message);
  
  for (const player of gameState.players.values()) {
    if (player.ws && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(jsonMessage);
    }
  }
}

// Notify all admin connections
function notifyAdmins(message: any) {
  const jsonMessage = JSON.stringify(message);
  
  for (const adminSocket of gameState.adminConnections) {
    if (adminSocket.readyState === WebSocket.OPEN) {
      adminSocket.send(jsonMessage);
    }
  }
}

// Cleanup inactive players
setInterval(() => {
  const now = new Date();
  const inactiveThreshold = 30 * 60 * 1000; // 30 minutes
  
  for (const [id, player] of gameState.players.entries()) {
    const inactiveTime = now.getTime() - player.lastActive.getTime();
    
    if (inactiveTime > inactiveThreshold) {
      gameState.players.delete(id);
      gameState.prizePool -= player.stake;
      
      notifyAdmins({
        type: 'player_timeout',
        playerId: id,
        playerName: player.name,
        reason: 'inactive'
      });
    }
  }
}, 5 * 60 * 1000); // Check every 5 minutes

// HTTP Server Handler
async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  
  // Handle WebSocket upgrade
  if (url.pathname === '/ws') {
    const { socket, response } = Deno.upgradeWebSocket(request);
    handleWebSocket(socket, request);
    return response;
  }
  
  // Serve frontend
  if (url.pathname === '/' || url.pathname === '/index.html') {
    // In production, serve the HTML file
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Bingo Game</title>
        <meta http-equiv="refresh" content="0;url=/game">
    </head>
    <body>
        <p>Redirecting to game...</p>
    </body>
    </html>
    `;
    
    return new Response(html, {
      headers: { 'Content-Type': 'text/html' }
    });
  }
  
  // Admin panel
  if (url.pathname === '/admin') {
    if (!validateAdmin(request)) {
      return new Response('Unauthorized', { status: 401 });
    }
    
    const adminHtml = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Admin Panel - Bingo Game</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 20px; }
            .stats { background: #f0f0f0; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
            .controls { margin-bottom: 20px; }
            button { margin: 5px; padding: 10px 20px; font-size: 16px; cursor: pointer; }
            #log { background: #000; color: #0f0; padding: 10px; font-family: monospace; height: 300px; overflow-y: auto; }
        </style>
    </head>
    <body>
        <h1>Bingo Game Admin Panel</h1>
        
        <div class="stats" id="stats">
            <h3>Game Statistics</h3>
            <p>Players: <span id="playerCount">0</span>/90</p>
            <p>Game Status: <span id="gameStatus">Stopped</span></p>
            <p>Prize Pool: <span id="prizePool">0</span> Birr</p>
            <p>Called Numbers: <span id="calledNumbers">0</span></p>
            <p>Current Number: <span id="currentNumber">-</span></p>
        </div>
        
        <div class="controls">
            <button onclick="startGame()">Start Game</button>
            <button onclick="stopGame()">Stop Game</button>
            <button onclick="callNumber()">Call Number</button>
            <button onclick="resetGame()">Reset Game</button>
        </div>
        
        <h3>Players List</h3>
        <div id="playersList"></div>
        
        <h3>Activity Log</h3>
        <div id="log"></div>
        
        <script>
            const ws = new WebSocket(\`ws://\${window.location.host}/ws?admin=${CONFIG.ADMIN_KEY}\`);
            
            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                console.log('Admin message:', data);
                
                switch(data.type) {
                    case 'admin_connected':
                        updateStats(data.gameState);
                        break;
                    case 'player_registered':
                        logActivity(\`Player registered: \${data.player.name} (\${data.player.phone})\`);
                        updateStats({ players: data.totalPlayers, prizePool: data.prizePool });
                        break;
                    case 'player_disconnected':
                        logActivity(\`Player disconnected: \${data.playerName}\`);
                        updateStats({ players: data.totalPlayers, prizePool: data.prizePool });
                        break;
                    case 'winner_declared':
                        logActivity(\`🎉 WINNER: \${data.player.name} won \${data.prize} Birr!\`);
                        break;
                    case 'number_called':
                        document.getElementById('currentNumber').textContent = data.number;
                        document.getElementById('calledNumbers').textContent = data.totalCalled;
                        logActivity(\`Number called: \${data.number}\`);
                        break;
                    case 'game_started':
                        document.getElementById('gameStatus').textContent = 'Active';
                        logActivity('Game started');
                        break;
                    case 'game_stopped':
                        document.getElementById('gameStatus').textContent = 'Stopped';
                        logActivity('Game stopped');
                        break;
                }
            };
            
            function updateStats(state) {
                if (state.players !== undefined) {
                    document.getElementById('playerCount').textContent = state.players;
                }
                if (state.prizePool !== undefined) {
                    document.getElementById('prizePool').textContent = state.prizePool;
                }
                if (state.gameActive !== undefined) {
                    document.getElementById('gameStatus').textContent = state.gameActive ? 'Active' : 'Stopped';
                }
                if (state.calledNumbers !== undefined) {
                    document.getElementById('calledNumbers').textContent = state.calledNumbers.length;
                }
                if (state.currentNumber !== undefined) {
                    document.getElementById('currentNumber').textContent = state.currentNumber || '-';
                }
            }
            
            function startGame() {
                ws.send(JSON.stringify({ type: 'admin_start_game' }));
            }
            
            function stopGame() {
                ws.send(JSON.stringify({ type: 'admin_stop_game' }));
            }
            
            function callNumber() {
                ws.send(JSON.stringify({ type: 'admin_call_number' }));
            }
            
            function resetGame() {
                ws.send(JSON.stringify({ type: 'admin_reset_game' }));
            }
            
            function logActivity(message) {
                const logDiv = document.getElementById('log');
                const entry = document.createElement('div');
                entry.textContent = \`[\${new Date().toLocaleTimeString()}] \${message}\`;
                logDiv.appendChild(entry);
                logDiv.scrollTop = logDiv.scrollHeight;
            }
            
            // Auto-refresh stats every 10 seconds
            setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'get_stats' }));
                }
            }, 10000);
        </script>
    </body>
    </html>
    `;
    
    return new Response(adminHtml, {
      headers: { 'Content-Type': 'text/html' }
    });
  }
  
  // API endpoints
  if (url.pathname === '/api/stats') {
    const stats = {
      totalPlayers: gameState.players.size,
      gameActive: gameState.gameActive,
      calledNumbers: gameState.calledNumbers.length,
      prizePool: gameState.prizePool,
      winner: gameState.winner
    };
    
    return new Response(JSON.stringify(stats), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // 404 for other routes
  return new Response('Not Found', { status: 404 });
}

// Start Server
console.log(`🚀 Bingo Server starting on ${CONFIG.HOST}:${CONFIG.PORT}`);
console.log(`📱 Player URL: http://${CONFIG.HOST}:${CONFIG.PORT}`);
console.log(`🔧 Admin URL: http://${CONFIG.HOST}:${CONFIG.PORT}/admin?admin=${CONFIG.ADMIN_KEY}`);

serve(handleRequest, { hostname: CONFIG.HOST, port: CONFIG.PORT });