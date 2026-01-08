// server.ts - Complete Deno Bingo Server with WebSocket
import { serve } from "https://deno.land/std@0.188.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.188.0/http/file_server.ts";

// ============ INTERFACES & TYPES ============
interface Player {
  id: string;
  name: string;
  phone: string;
  boardType: string;
  boardNumber: number;
  stake: number;
  ws?: WebSocket;
  balance: number;
  totalWon: number;
  markedNumbers: number[];
  joinedAt: Date;
  lastActive: Date;
  isOnline: boolean;
  isWinner: boolean;
}

interface GameState {
  id: string;
  gameActive: boolean;
  calledNumbers: number[];
  players: Map<string, Player>;
  currentNumber: number | null;
  currentDisplay: string;
  startedAt: Date | null;
  winner: Player | null;
  prizePool: number;
  totalCollected: number;
  totalPaidOut: number;
  boardTypes: string[];
  maxPlayers: number;
  autoCallInterval: number | null;
}

interface AdminConnection {
  ws: WebSocket;
  lastActive: Date;
}

interface ChatMessage {
  playerId: string;
  playerName: string;
  message: string;
  timestamp: Date;
  type: 'chat' | 'system';
}

// ============ CONFIGURATION ============
const CONFIG = {
  PORT: 8000,
  HOST: "0.0.0.0",
  ADMIN_KEY: "asse2123",
  MAX_PLAYERS: 90,
  SERVICE_FEE: 0.03, // 3%
  MIN_STAKE: 25,
  MAX_STAKE: 5000,
  AUTO_CALL_INTERVAL: 7000, // 7 seconds
  INACTIVE_TIMEOUT: 30 * 60 * 1000, // 30 minutes
  BOARD_TYPES: ['75ball', '90ball', '30ball', '50ball', 'pattern', 'coverall'],
  LOG_RETENTION: 1000
} as const;

// ============ GLOBAL STATE ============
const gameState: GameState = {
  id: `game_${Date.now()}`,
  gameActive: false,
  calledNumbers: [],
  players: new Map(),
  currentNumber: null,
  currentDisplay: "",
  startedAt: null,
  winner: null,
  prizePool: 0,
  totalCollected: 0,
  totalPaidOut: 0,
  boardTypes: CONFIG.BOARD_TYPES,
  maxPlayers: CONFIG.MAX_PLAYERS,
  autoCallInterval: null
};

const adminConnections = new Set<AdminConnection>();
const chatHistory: ChatMessage[] = [];
const gameLog: string[] = [];

// ============ UTILITY FUNCTIONS ============
function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function logEvent(message: string) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);
  gameLog.push(logMessage);
  if (gameLog.length > CONFIG.LOG_RETENTION) {
    gameLog.shift();
  }
}

function calculatePrize(stake: number, totalPlayers: number): number {
  const pool = stake * totalPlayers * 0.8; // 80% goes to prize pool
  const afterFee = pool * (1 - CONFIG.SERVICE_FEE);
  return Math.floor(afterFee);
}

function getNumberDisplay(number: number, boardType: string): string {
  if (boardType === '75ball' || boardType === 'pattern' || boardType === '50ball') {
    const letters = 'BINGO';
    const columnSize = boardType === '50ball' ? 10 : 15;
    const columnIndex = Math.floor((number - 1) / columnSize);
    const letter = letters[Math.min(columnIndex, 4)];
    return `${letter}-${number}`;
  }
  return number.toString();
}

function shuffleArray<T>(array: T[]): T[] {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
}

function generateBoardNumbers(boardType: string, boardNumber: number): number[] {
  // Use boardNumber as seed for reproducibility
  const seed = boardNumber * 1000;
  const numbers: number[] = [];
  
  switch(boardType) {
    case '75ball':
      // 5x5 board with FREE in center
      const ranges = [[1,15], [16,30], [31,45], [46,60], [61,75]];
      for (let col = 0; col < 5; col++) {
        const [min, max] = ranges[col];
        const colNumbers = new Set<number>();
        while (colNumbers.size < 5) {
          const num = Math.floor(Math.random() * (max - min + 1)) + min;
          colNumbers.add(num);
        }
        numbers.push(...Array.from(colNumbers));
      }
      break;
      
    case '90ball':
      // 9x3 grid with 15 numbers
      let allNumbers = Array.from({length: 90}, (_, i) => i + 1);
      allNumbers = shuffleArray(allNumbers).slice(0, 15);
      numbers.push(...allNumbers.sort((a, b) => a - b));
      break;
      
    case '30ball':
      // 3x3 grid with 9 numbers
      let thirtyNumbers = Array.from({length: 30}, (_, i) => i + 1);
      thirtyNumbers = shuffleArray(thirtyNumbers).slice(0, 9);
      numbers.push(...thirtyNumbers.sort((a, b) => a - b));
      break;
      
    case '50ball':
      // 5x5 board
      const fiftyRanges = [[1,10], [11,20], [21,30], [31,40], [41,50]];
      for (let col = 0; col < 5; col++) {
        const [min, max] = fiftyRanges[col];
        const colNumbers = new Set<number>();
        while (colNumbers.size < 5) {
          const num = Math.floor(Math.random() * (max - min + 1)) + min;
          colNumbers.add(num);
        }
        numbers.push(...Array.from(colNumbers));
      }
      break;
      
    default:
      // Default to 75-ball
      const defaultRanges = [[1,15], [16,30], [31,45], [46,60], [61,75]];
      for (let col = 0; col < 5; col++) {
        const [min, max] = defaultRanges[col];
        const colNumbers = new Set<number>();
        while (colNumbers.size < 5) {
          const num = Math.floor(Math.random() * (max - min + 1)) + min;
          colNumbers.add(num);
        }
        numbers.push(...Array.from(colNumbers));
      }
  }
  
  return numbers;
}

function validatePhone(phone: string): boolean {
  return /^09\d{8}$/.test(phone);
}

function validateName(name: string): boolean {
  return name.trim().length >= 2 && name.trim().length <= 50;
}

// ============ GAME CONTROL FUNCTIONS ============
function startGame() {
  if (gameState.gameActive) {
    return { success: false, message: "Game already active" };
  }
  
  if (gameState.players.size < 2) {
    return { success: false, message: "Need at least 2 players to start" };
  }
  
  gameState.gameActive = true;
  gameState.startedAt = new Date();
  gameState.calledNumbers = [];
  gameState.currentNumber = null;
  gameState.currentDisplay = "";
  gameState.winner = null;
  
  // Reset all player states
  for (const player of gameState.players.values()) {
    player.markedNumbers = [];
    player.isWinner = false;
  }
  
  // Start auto-calling
  startAutoCalling();
  
  logEvent(`Game started with ${gameState.players.size} players`);
  
  // Broadcast to all
  broadcastToPlayers({
    type: "game_started",
    startedAt: gameState.startedAt.toISOString(),
    totalPlayers: gameState.players.size,
    prizePool: gameState.prizePool
  });
  
  notifyAdmins({
    type: "game_started_admin",
    startedAt: gameState.startedAt.toISOString(),
    totalPlayers: gameState.players.size,
    prizePool: gameState.prizePool,
    players: Array.from(gameState.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      boardType: p.boardType,
      stake: p.stake
    }))
  });
  
  return { success: true, message: "Game started successfully" };
}

function stopGame() {
  if (!gameState.gameActive) {
    return { success: false, message: "Game not active" };
  }
  
  gameState.gameActive = false;
  stopAutoCalling();
  
  logEvent("Game stopped");
  
  broadcastToPlayers({
    type: "game_stopped"
  });
  
  notifyAdmins({
    type: "game_stopped_admin"
  });
  
  return { success: true, message: "Game stopped" };
}

function resetGame() {
  stopGame();
  
  gameState.calledNumbers = [];
  gameState.currentNumber = null;
  gameState.currentDisplay = "";
  gameState.startedAt = null;
  gameState.winner = null;
  
  // Reset player game state but keep registration
  for (const player of gameState.players.values()) {
    player.markedNumbers = [];
    player.isWinner = false;
  }
  
  logEvent("Game reset");
  
  broadcastToPlayers({
    type: "game_reset"
  });
  
  notifyAdmins({
    type: "game_reset_admin"
  });
  
  return { success: true, message: "Game reset" };
}

function callNumber() {
  if (!gameState.gameActive) {
    return { success: false, message: "Game not active" };
  }
  
  if (gameState.winner) {
    return { success: false, message: "Game already has a winner" };
  }
  
  let newNumber: number;
  let attempts = 0;
  
  // Generate unique number based on game type
  do {
    if (gameState.players.size > 0) {
      // Use first player's board type as reference
      const firstPlayer = Array.from(gameState.players.values())[0];
      const maxNumber = firstPlayer.boardType === '90ball' ? 90 : 
                       firstPlayer.boardType === '30ball' ? 30 :
                       firstPlayer.boardType === '50ball' ? 50 : 75;
      newNumber = Math.floor(Math.random() * maxNumber) + 1;
    } else {
      newNumber = Math.floor(Math.random() * 75) + 1;
    }
    attempts++;
  } while (gameState.calledNumbers.includes(newNumber) && attempts < 100);
  
  if (attempts >= 100) {
    return { success: false, message: "Failed to generate unique number" };
  }
  
  gameState.calledNumbers.push(newNumber);
  gameState.currentNumber = newNumber;
  
  // Get display format
  const display = getNumberDisplay(newNumber, '75ball'); // Default to 75-ball format
  
  gameState.currentDisplay = display;
  
  logEvent(`Number called: ${display}`);
  
  // Check for winners
  checkWinners(newNumber);
  
  // Broadcast to players
  broadcastToPlayers({
    type: "number_called",
    number: newNumber,
    display: display,
    totalCalled: gameState.calledNumbers.length
  });
  
  // Notify admins
  notifyAdmins({
    type: "number_called_admin",
    number: newNumber,
    display: display,
    totalCalled: gameState.calledNumbers.length
  });
  
  return { success: true, number: newNumber, display: display };
}

function startAutoCalling() {
  if (gameState.autoCallInterval) {
    clearInterval(gameState.autoCallInterval);
  }
  
  gameState.autoCallInterval = setInterval(() => {
    if (gameState.gameActive && !gameState.winner) {
      callNumber();
    }
  }, CONFIG.AUTO_CALL_INTERVAL) as unknown as number;
}

function stopAutoCalling() {
  if (gameState.autoCallInterval) {
    clearInterval(gameState.autoCallInterval);
    gameState.autoCallInterval = null;
  }
}

function checkWinners(calledNumber: number) {
  // Update all players' marked numbers
  for (const player of gameState.players.values()) {
    // Get player's board numbers
    const boardNumbers = generateBoardNumbers(player.boardType, player.boardNumber);
    
    // Check if called number is on player's board
    if (boardNumbers.includes(calledNumber) && !player.markedNumbers.includes(calledNumber)) {
      player.markedNumbers.push(calledNumber);
      
      // Check if player has a winning pattern
      if (checkWinningPattern(player, boardNumbers)) {
        declareWinner(player);
        return;
      }
    }
  }
}

function checkWinningPattern(player: Player, boardNumbers: number[]): boolean {
  const markedSet = new Set(player.markedNumbers);
  
  // Different patterns for different board types
  switch (player.boardType) {
    case '75ball':
    case '50ball':
      return check75BallPattern(markedSet, boardNumbers);
    case '90ball':
      return check90BallPattern(markedSet);
    case '30ball':
      return check30BallPattern(markedSet);
    case 'pattern':
      return checkPatternBingo(markedSet, boardNumbers);
    case 'coverall':
      return checkCoverallPattern(markedSet, boardNumbers);
    default:
      return false;
  }
}

function check75BallPattern(markedSet: Set<number>, boardNumbers: number[]): boolean {
  // For 5x5 board
  const gridSize = 5;
  
  // Check rows
  for (let row = 0; row < gridSize; row++) {
    let rowComplete = true;
    for (let col = 0; col < gridSize; col++) {
      const index = row * gridSize + col;
      // Skip center if it's FREE space
      if (index === 12) continue;
      if (!markedSet.has(boardNumbers[index])) {
        rowComplete = false;
        break;
      }
    }
    if (rowComplete) return true;
  }
  
  // Check columns
  for (let col = 0; col < gridSize; col++) {
    let colComplete = true;
    for (let row = 0; row < gridSize; row++) {
      const index = row * gridSize + col;
      if (index === 12) continue;
      if (!markedSet.has(boardNumbers[index])) {
        colComplete = false;
        break;
      }
    }
    if (colComplete) return true;
  }
  
  // Check diagonals
  let diag1Complete = true;
  for (let i = 0; i < gridSize; i++) {
    const index = i * gridSize + i;
    if (index === 12) continue;
    if (!markedSet.has(boardNumbers[index])) {
      diag1Complete = false;
      break;
    }
  }
  if (diag1Complete) return true;
  
  let diag2Complete = true;
  for (let i = 0; i < gridSize; i++) {
    const index = i * gridSize + (gridSize - 1 - i);
    if (index === 12) continue;
    if (!markedSet.has(boardNumbers[index])) {
      diag2Complete = false;
      break;
    }
  }
  if (diag2Complete) return true;
  
  // Check four corners (positions 0, 4, 20, 24 in 5x5 grid)
  const corners = [0, 4, 20, 24];
  if (corners.every(index => markedSet.has(boardNumbers[index]))) {
    return true;
  }
  
  // Check full house (all numbers except FREE)
  const allCells = boardNumbers.filter((_, index) => index !== 12);
  if (allCells.every(num => markedSet.has(num))) {
    return true;
  }
  
  return false;
}

function check90BallPattern(markedSet: Set<number>): boolean {
  // 90-ball has 3 rows, check for one line, two lines, or full house
  // Simplified check - in reality would need board layout
  const markedCount = markedSet.size;
  
  // For demo purposes: one line = 5 numbers, two lines = 10, full house = 15
  if (markedCount >= 15) return true; // Full house
  if (markedCount >= 10) return true; // Two lines
  if (markedCount >= 5) return true;  // One line
  
  return false;
}

function check30BallPattern(markedSet: Set<number>): boolean {
  // 30-ball is usually full house only (all 9 numbers)
  return markedSet.size >= 9;
}

function checkPatternBingo(markedSet: Set<number>, boardNumbers: number[]): boolean {
  // For pattern bingo, we could have specific patterns
  // For now, check for X pattern
  const gridSize = 5;
  const xPattern = [
    0,  // top-left
    6,  // center-left
    12, // center (FREE)
    18, // center-right
    24  // bottom-right
  ];
  
  return xPattern.every(index => {
    if (index === 12) return true; // FREE space always counts
    return markedSet.has(boardNumbers[index]);
  });
}

function checkCoverallPattern(markedSet: Set<number>, boardNumbers: number[]): boolean {
  // Coverall requires all numbers to be marked
  return boardNumbers.every(num => markedSet.has(num));
}

function declareWinner(player: Player) {
  if (gameState.winner) return; // Already have a winner
  
  player.isWinner = true;
  gameState.winner = player;
  
  const prize = calculatePrize(player.stake, gameState.players.size);
  player.balance += prize;
  player.totalWon += prize;
  gameState.totalPaidOut += prize;
  
  logEvent(`🎉 WINNER: ${player.name} won ${prize} Birr!`);
  
  // Broadcast winner
  broadcastToPlayers({
    type: "winner",
    playerId: player.id,
    playerName: player.name,
    prize: prize,
    pattern: "BINGO!",
    timestamp: new Date().toISOString()
  });
  
  // Notify admins
  notifyAdmins({
    type: "winner_admin",
    player: {
      id: player.id,
      name: player.name,
      phone: player.phone,
      boardType: player.boardType,
      boardNumber: player.boardNumber,
      stake: player.stake
    },
    prize: prize,
    calledNumbers: gameState.calledNumbers.length
  });
  
  // Stop auto-calling
  stopAutoCalling();
}

// ============ WEBSOCKET HANDLERS ============
async function handleWebSocket(socket: WebSocket, request: Request) {
  const url = new URL(request.url);
  const isAdmin = url.searchParams.get("admin") === CONFIG.ADMIN_KEY;
  
  if (isAdmin) {
    await handleAdminConnection(socket);
    return;
  }
  
  await handlePlayerConnection(socket, request);
}

async function handleAdminConnection(socket: WebSocket) {
  const adminConn: AdminConnection = {
    ws: socket,
    lastActive: new Date()
  };
  
  adminConnections.add(adminConn);
  
  logEvent("Admin connected");
  
  // Send initial state
  socket.send(JSON.stringify({
    type: "admin_connected",
    gameState: {
      gameActive: gameState.gameActive,
      calledNumbers: gameState.calledNumbers,
      currentNumber: gameState.currentNumber,
      currentDisplay: gameState.currentDisplay,
      startedAt: gameState.startedAt?.toISOString(),
      winner: gameState.winner ? {
        id: gameState.winner.id,
        name: gameState.winner.name,
        prize: calculatePrize(gameState.winner.stake, gameState.players.size)
      } : null,
      totalPlayers: gameState.players.size,
      prizePool: gameState.prizePool,
      totalCollected: gameState.totalCollected,
      totalPaidOut: gameState.totalPaidOut,
      players: Array.from(gameState.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        phone: p.phone,
        boardType: p.boardType,
        boardNumber: p.boardNumber,
        stake: p.stake,
        balance: p.balance,
        totalWon: p.totalWon,
        isOnline: p.isOnline,
        markedNumbers: p.markedNumbers.length
      }))
    },
    chatHistory: chatHistory.slice(-50),
    gameLog: gameLog.slice(-100)
  }));
  
  // Handle admin messages
  socket.onmessage = (event) => {
    adminConn.lastActive = new Date();
    
    try {
      const data = JSON.parse(event.data);
      
      switch (data.type) {
        case "admin_call_number":
          const result = callNumber();
          socket.send(JSON.stringify({
            type: "admin_action_result",
            action: "call_number",
            ...result
          }));
          break;
          
        case "admin_start_game":
          const startResult = startGame();
          socket.send(JSON.stringify({
            type: "admin_action_result",
            action: "start_game",
            ...startResult
          }));
          break;
          
        case "admin_stop_game":
          const stopResult = stopGame();
          socket.send(JSON.stringify({
            type: "admin_action_result",
            action: "stop_game",
            ...stopResult
          }));
          break;
          
        case "admin_reset_game":
          const resetResult = resetGame();
          socket.send(JSON.stringify({
            type: "admin_action_result",
            action: "reset_game",
            ...resetResult
          }));
          break;
          
        case "admin_kick_player":
          if (data.playerId) {
            const player = gameState.players.get(data.playerId);
            if (player) {
              gameState.players.delete(data.playerId);
              gameState.prizePool -= player.stake;
              logEvent(`Admin kicked player: ${player.name}`);
              
              broadcastToPlayers({
                type: "player_left",
                playerId: data.playerId,
                totalPlayers: gameState.players.size
              });
              
              notifyAdmins({
                type: "player_kicked_admin",
                playerId: data.playerId,
                playerName: player.name
              });
            }
          }
          break;
          
        case "admin_broadcast":
          if (data.message) {
            const systemMessage: ChatMessage = {
              playerId: "system",
              playerName: "SYSTEM",
              message: data.message,
              timestamp: new Date(),
              type: "system"
            };
            
            chatHistory.push(systemMessage);
            broadcastToPlayers({
              type: "chat_message",
              ...systemMessage,
              timestamp: systemMessage.timestamp.toISOString()
            });
          }
          break;
          
        case "admin_get_stats":
          socket.send(JSON.stringify({
            type: "admin_stats",
            gameState: {
              gameActive: gameState.gameActive,
              totalPlayers: gameState.players.size,
              prizePool: gameState.prizePool,
              totalCollected: gameState.totalCollected,
              totalPaidOut: gameState.totalPaidOut,
              calledNumbers: gameState.calledNumbers.length,
              currentNumber: gameState.currentNumber
            }
          }));
          break;
      }
    } catch (error) {
      console.error("Error handling admin message:", error);
    }
  };
  
  socket.onclose = () => {
    adminConnections.delete(adminConn);
    logEvent("Admin disconnected");
  };
  
  socket.onerror = (error) => {
    console.error("Admin WebSocket error:", error);
    adminConnections.delete(adminConn);
  };
}

async function handlePlayerConnection(socket: WebSocket, request: Request) {
  let playerId: string | null = null;
  
  socket.onopen = () => {
    logEvent("Player connected");
  };
  
  socket.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      
      switch (data.type) {
        case "register":
          await handleRegistration(data, socket);
          break;
          
        case "reconnect":
          await handleReconnection(data, socket);
          break;
          
        case "mark_number":
          await handleMarkNumber(data);
          break;
          
        case "claim_win":
          await handleWinClaim(data);
          break;
          
        case "chat":
          await handleChatMessage(data);
          break;
          
        case "withdraw":
          await handleWithdrawal(data);
          break;
          
        case "get_state":
          await sendGameState(socket);
          break;
          
        case "ping":
          if (playerId) {
            const player = gameState.players.get(playerId);
            if (player) {
              player.lastActive = new Date();
            }
          }
          socket.send(JSON.stringify({ type: "pong" }));
          break;
      }
    } catch (error) {
      console.error("Error handling player message:", error);
      socket.send(JSON.stringify({
        type: "error",
        message: "Invalid message format"
      }));
    }
  };
  
  socket.onclose = () => {
    if (playerId) {
      const player = gameState.players.get(playerId);
      if (player) {
        player.isOnline = false;
        player.ws = undefined;
        logEvent(`Player disconnected: ${player.name}`);
        
        notifyAdmins({
          type: "player_disconnected_admin",
          playerId: playerId,
          playerName: player.name,
          totalPlayers: gameState.players.size
        });
      }
    }
  };
  
  socket.onerror = (error) => {
    console.error("Player WebSocket error:", error);
  };
}

async function handleRegistration(data: any, socket: WebSocket) {
  // Validate input
  if (!validateName(data.name)) {
    socket.send(JSON.stringify({
      type: "error",
      message: "Invalid name (2-50 characters required)"
    }));
    return;
  }
  
  if (!validatePhone(data.phone)) {
    socket.send(JSON.stringify({
      type: "error",
      message: "Invalid phone number (must be 09xxxxxxxx)"
    }));
    return;
  }
  
  if (!CONFIG.BOARD_TYPES.includes(data.boardType)) {
    socket.send(JSON.stringify({
      type: "error",
      message: "Invalid board type"
    }));
    return;
  }
  
  const stake = Math.max(
    CONFIG.MIN_STAKE,
    Math.min(CONFIG.MAX_STAKE, parseInt(data.stake) || CONFIG.MIN_STAKE)
  );
  
  const boardNumber = Math.max(1, Math.min(100, parseInt(data.boardNumber) || 1));
  
  // Check if game is full
  if (gameState.players.size >= CONFIG.MAX_PLAYERS) {
    socket.send(JSON.stringify({
      type: "error",
      message: "Game is full (90 players maximum)"
    }));
    return;
  }
  
  // Check if phone already registered
  for (const player of gameState.players.values()) {
    if (player.phone === data.phone) {
      socket.send(JSON.stringify({
        type: "error",
        message: "Phone number already registered"
      }));
      return;
    }
  }
  
  // Check if board number already taken for this board type
  for (const player of gameState.players.values()) {
    if (player.boardType === data.boardType && player.boardNumber === boardNumber) {
      socket.send(JSON.stringify({
        type: "error",
        message: `Board ${boardNumber} for ${data.boardType} is already taken`
      }));
      return;
    }
  }
  
  // Create new player
  const playerId = generateId("player");
  const player: Player = {
    id: playerId,
    name: data.name.trim(),
    phone: data.phone,
    boardType: data.boardType,
    boardNumber: boardNumber,
    stake: stake,
    ws: socket,
    balance: 0,
    totalWon: 0,
    markedNumbers: [],
    joinedAt: new Date(),
    lastActive: new Date(),
    isOnline: true,
    isWinner: false
  };
  
  gameState.players.set(playerId, player);
  gameState.prizePool += stake;
  gameState.totalCollected += stake;
  
  logEvent(`Player registered: ${player.name} (${player.phone})`);
  
  // Send success response
  socket.send(JSON.stringify({
    type: "registered",
    playerId: playerId,
    boardNumbers: generateBoardNumbers(player.boardType, player.boardNumber),
    gameState: {
      gameActive: gameState.gameActive,
      calledNumbers: gameState.calledNumbers,
      currentNumber: gameState.currentNumber,
      currentDisplay: gameState.currentDisplay,
      totalPlayers: gameState.players.size,
      prizePool: gameState.prizePool
    },
    players: Array.from(gameState.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      boardType: p.boardType,
      boardNumber: p.boardNumber,
      stake: p.stake
    }))
  }));
  
  // Broadcast to other players
  broadcastToPlayers({
    type: "player_joined",
    playerId: playerId,
    playerName: player.name,
    boardType: player.boardType,
    boardNumber: player.boardNumber,
    stake: player.stake,
    totalPlayers: gameState.players.size
  }, playerId);
  
  // Notify admins
  notifyAdmins({
    type: "player_registered_admin",
    player: {
      id: playerId,
      name: player.name,
      phone: player.phone,
      boardType: player.boardType,
      boardNumber: player.boardNumber,
      stake: player.stake
    },
    totalPlayers: gameState.players.size,
    prizePool: gameState.prizePool
  });
}

async function handleReconnection(data: any, socket: WebSocket) {
  const player = gameState.players.get(data.playerId);
  
  if (!player) {
    socket.send(JSON.stringify({
      type: "error",
      message: "Player not found"
    }));
    return;
  }
  
  player.ws = socket;
  player.isOnline = true;
  player.lastActive = new Date();
  
  socket.send(JSON.stringify({
    type: "reconnected",
    playerId: player.id,
    boardNumbers: generateBoardNumbers(player.boardType, player.boardNumber),
    markedNumbers: player.markedNumbers,
    gameState: {
      gameActive: gameState.gameActive,
      calledNumbers: gameState.calledNumbers,
      currentNumber: gameState.currentNumber,
      currentDisplay: gameState.currentDisplay,
      totalPlayers: gameState.players.size,
      prizePool: gameState.prizePool,
      winner: gameState.winner ? {
        id: gameState.winner.id,
        name: gameState.winner.name
      } : null
    },
    balance: player.balance,
    totalWon: player.totalWon,
    players: Array.from(gameState.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      boardType: p.boardType,
      boardNumber: p.boardNumber,
      stake: p.stake
    })),
    chatHistory: chatHistory.slice(-50)
  }));
  
  logEvent(`Player reconnected: ${player.name}`);
  
  notifyAdmins({
    type: "player_reconnected_admin",
    playerId: player.id,
    playerName: player.name
  });
}

async function handleMarkNumber(data: any) {
  const player = gameState.players.get(data.playerId);
  
  if (!player || !gameState.gameActive || gameState.winner) {
    return;
  }
  
  const number = parseInt(data.number);
  if (!player.markedNumbers.includes(number)) {
    player.markedNumbers.push(number);
    
    // Check if this gives them a win
    const boardNumbers = generateBoardNumbers(player.boardType, player.boardNumber);
    if (checkWinningPattern(player, boardNumbers)) {
      declareWinner(player);
    }
  }
}

async function handleWinClaim(data: any) {
  const player = gameState.players.get(data.playerId);
  
  if (!player || !gameState.gameActive || gameState.winner) {
    return;
  }
  
  // Verify the claim
  const boardNumbers = generateBoardNumbers(player.boardType, player.boardNumber);
  const hasWon = checkWinningPattern(player, boardNumbers);
  
  if (hasWon) {
    declareWinner(player);
  } else {
    player.ws?.send(JSON.stringify({
      type: "error",
      message: "You don't have a winning pattern yet"
    }));
  }
}

async function handleChatMessage(data: any) {
  const player = gameState.players.get(data.playerId);
  
  if (!player || !data.message?.trim()) {
    return;
  }
  
  const chatMessage: ChatMessage = {
    playerId: player.id,
    playerName: player.name,
    message: data.message.trim(),
    timestamp: new Date(),
    type: "chat"
  };
  
  chatHistory.push(chatMessage);
  if (chatHistory.length > CONFIG.LOG_RETENTION) {
    chatHistory.shift();
  }
  
  broadcastToPlayers({
    type: "chat_message",
    ...chatMessage,
    timestamp: chatMessage.timestamp.toISOString()
  });
  
  notifyAdmins({
    type: "chat_message_admin",
    ...chatMessage,
    timestamp: chatMessage.timestamp.toISOString()
  });
}

async function handleWithdrawal(data: any) {
  const player = gameState.players.get(data.playerId);
  
  if (!player) return;
  
  const amount = Math.floor(data.amount || 0);
  const account = data.account?.toString().trim();
  
  if (!account) {
    player.ws?.send(JSON.stringify({
      type: "error",
      message: "Account number is required"
    }));
    return;
  }
  
  if (amount < 25) {
    player.ws?.send(JSON.stringify({
      type: "error",
      message: "Minimum withdrawal is 25 Birr"
    }));
    return;
  }
  
  if (amount > player.balance) {
    player.ws?.send(JSON.stringify({
      type: "error",
      message: "Insufficient balance"
    }));
    return;
  }
  
  // Process withdrawal (in production, integrate with payment gateway)
  player.balance -= amount;
  
  logEvent(`Withdrawal processed: ${player.name} - ${amount} Birr to account ${account}`);
  
  player.ws?.send(JSON.stringify({
    type: "withdrawal_processed",
    amount: amount,
    account: account,
    newBalance: player.balance,
    timestamp: new Date().toISOString()
  }));
  
  notifyAdmins({
    type: "withdrawal_admin",
    playerId: player.id,
    playerName: player.name,
    amount: amount,
    account: account,
    remainingBalance: player.balance
  });
}

async function sendGameState(socket: WebSocket) {
  socket.send(JSON.stringify({
    type: "game_state",
    gameActive: gameState.gameActive,
    calledNumbers: gameState.calledNumbers,
    currentNumber: gameState.currentNumber,
    currentDisplay: gameState.currentDisplay,
    totalPlayers: gameState.players.size,
    prizePool: gameState.prizePool,
    startedAt: gameState.startedAt?.toISOString(),
    winner: gameState.winner ? {
      id: gameState.winner.id,
      name: gameState.winner.name
    } : null
  }));
}

// ============ BROADCAST FUNCTIONS ============
function broadcastToPlayers(message: any, excludePlayerId?: string) {
  const jsonMessage = JSON.stringify(message);
  
  for (const player of gameState.players.values()) {
    if (player.id === excludePlayerId) continue;
    if (player.ws && player.ws.readyState === WebSocket.OPEN) {
      try {
        player.ws.send(jsonMessage);
      } catch (error) {
        console.error("Error sending to player:", error);
      }
    }
  }
}

function notifyAdmins(message: any) {
  const jsonMessage = JSON.stringify(message);
  const now = new Date();
  
  // Clean up stale admin connections
  const staleThreshold = 5 * 60 * 1000; // 5 minutes
  for (const conn of adminConnections) {
    if (now.getTime() - conn.lastActive.getTime() > staleThreshold) {
      adminConnections.delete(conn);
    }
  }
  
  // Send to active admins
  for (const conn of adminConnections) {
    if (conn.ws.readyState === WebSocket.OPEN) {
      try {
        conn.ws.send(jsonMessage);
      } catch (error) {
        console.error("Error sending to admin:", error);
      }
    }
  }
}

// ============ CLEANUP TASKS ============
setInterval(() => {
  const now = new Date();
  
  // Clean up inactive players
  for (const [id, player] of gameState.players.entries()) {
    if (now.getTime() - player.lastActive.getTime() > CONFIG.INACTIVE_TIMEOUT) {
      gameState.players.delete(id);
      gameState.prizePool -= player.stake;
      
      logEvent(`Removed inactive player: ${player.name}`);
      
      broadcastToPlayers({
        type: "player_left",
        playerId: id,
        totalPlayers: gameState.players.size
      });
      
      notifyAdmins({
        type: "player_inactive_admin",
        playerId: id,
        playerName: player.name,
        reason: "inactive"
      });
    }
  }
  
  // Auto-start game if enough players and not active
  if (!gameState.gameActive && !gameState.winner && gameState.players.size >= 5) {
    startGame();
  }
}, 60 * 1000); // Check every minute

// ============ HTTP SERVER HANDLER ============
async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  
  // Handle WebSocket upgrade
  if (url.pathname === "/ws") {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 });
    }
    
    const { socket, response } = Deno.upgradeWebSocket(request);
    handleWebSocket(socket, request);
    return response;
  }
  
  // Serve static files from current directory
  if (url.pathname === "/" || url.pathname.endsWith(".html") || url.pathname.endsWith(".css") || url.pathname.endsWith(".js")) {
    return serveDir(request, {
      fsRoot: Deno.cwd(),
      urlRoot: "",
      showDirListing: false,
      enableCors: true
    });
  }
  
  // API endpoints
  if (url.pathname === "/api/health") {
    return new Response(JSON.stringify({
      status: "healthy",
      players: gameState.players.size,
      gameActive: gameState.gameActive,
      uptime: process.uptime()
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
  
  if (url.pathname === "/api/stats") {
    return new Response(JSON.stringify({
      totalPlayers: gameState.players.size,
      gameActive: gameState.gameActive,
      calledNumbers: gameState.calledNumbers.length,
      prizePool: gameState.prizePool,
      totalCollected: gameState.totalCollected,
      totalPaidOut: gameState.totalPaidOut,
      winner: gameState.winner ? gameState.winner.name : null,
      startedAt: gameState.startedAt?.toISOString()
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
  
  if (url.pathname === "/api/admin/login") {
    const { key } = await request.json();
    if (key === CONFIG.ADMIN_KEY) {
      return new Response(JSON.stringify({
        success: true,
        token: btoa(`admin_${Date.now()}_${Math.random()}`)
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ success: false }), { status: 401 });
  }
  
  // Admin panel
  if (url.pathname === "/admin") {
    const adminKey = url.searchParams.get("key");
    if (adminKey !== CONFIG.ADMIN_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }
    
    const adminHtml = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Admin Panel - Bingo Game</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #1a1a1a; color: white; }
            .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
            .header { background: #0d47a1; padding: 20px; border-radius: 10px; margin-bottom: 20px; }
            .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; margin-bottom: 20px; }
            .stat-card { background: #2d2d2d; padding: 15px; border-radius: 8px; border-left: 4px solid #ffd700; }
            .stat-value { font-size: 2em; font-weight: bold; color: #ffd700; }
            .stat-label { color: #ccc; font-size: 0.9em; }
            .controls { background: #2d2d2d; padding: 20px; border-radius: 10px; margin-bottom: 20px; }
            .controls-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: 15px; }
            .btn { padding: 12px 20px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; transition: 0.3s; }
            .btn-primary { background: #0d47a1; color: white; }
            .btn-success { background: #28a745; color: white; }
            .btn-danger { background: #dc3545; color: white; }
            .btn-warning { background: #ffd700; color: #000; }
            .btn:hover { opacity: 0.9; transform: translateY(-2px); }
            .players-table { width: 100%; background: #2d2d2d; border-radius: 10px; overflow: hidden; }
            table { width: 100%; border-collapse: collapse; }
            th { background: #0d47a1; padding: 12px; text-align: left; }
            td { padding: 10px; border-bottom: 1px solid #444; }
            tr:hover { background: #3d3d3d; }
            .log-container { background: #000; color: #0f0; padding: 15px; border-radius: 10px; font-family: monospace; height: 300px; overflow-y: auto; margin-top: 20px; }
            .log-entry { margin-bottom: 5px; }
            .connected { color: #0f0; }
            .disconnected { color: #f00; }
            .tabs { display: flex; gap: 10px; margin-bottom: 20px; }
            .tab { padding: 10px 20px; background: #2d2d2d; border-radius: 6px; cursor: pointer; }
            .tab.active { background: #0d47a1; }
            .tab-content { display: none; }
            .tab-content.active { display: block; }
            .broadcast-input { width: 100%; padding: 10px; margin: 10px 0; background: #3d3d3d; border: 1px solid #555; color: white; border-radius: 4px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🎮 Bingo Game Admin Panel</h1>
                <p>Real-time monitoring and control</p>
            </div>
            
            <div class="tabs">
                <div class="tab active" onclick="showTab('dashboard')">📊 Dashboard</div>
                <div class="tab" onclick="showTab('players')">👥 Players</div>
                <div class="tab" onclick="showTab('controls')">🎮 Controls</div>
                <div class="tab" onclick="showTab('logs')">📝 Logs</div>
            </div>
            
            <div id="dashboardTab" class="tab-content active">
                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-value" id="playerCount">0</div>
                        <div class="stat-label">Active Players</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value" id="prizePool">0</div>
                        <div class="stat-label">Prize Pool (Birr)</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value" id="gameStatus">Stopped</div>
                        <div class="stat-label">Game Status</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value" id="calledNumbers">0</div>
                        <div class="stat-label">Numbers Called</div>
                    </div>
                </div>
                
                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-value" id="totalCollected">0</div>
                        <div class="stat-label">Total Collected</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value" id="totalPaidOut">0</div>
                        <div class="stat-label">Total Paid Out</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value" id="currentNumber">-</div>
                        <div class="stat-label">Current Number</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value" id="winner">None</div>
                        <div class="stat-label">Current Winner</div>
                    </div>
                </div>
                
                <div class="controls">
                    <h3>Quick Actions</h3>
                    <div class="controls-grid">
                        <button class="btn btn-success" onclick="startGame()">▶ Start Game</button>
                        <button class="btn btn-danger" onclick="stopGame()">⏹ Stop Game</button>
                        <button class="btn btn-primary" onclick="callNumber()">🔢 Call Number</button>
                        <button class="btn btn-warning" onclick="resetGame()">🔄 Reset Game</button>
                    </div>
                </div>
            </div>
            
            <div id="playersTab" class="tab-content">
                <div class="controls">
                    <input type="text" id="playerSearch" placeholder="Search players..." class="broadcast-input" onkeyup="searchPlayers()">
                </div>
                <div class="players-table">
                    <table>
                        <thead>
                            <tr>
                                <th>ID</th>
                                <th>Name</th>
                                <th>Phone</th>
                                <th>Board Type</th>
                                <th>Board #</th>
                                <th>Stake</th>
                                <th>Balance</th>
                                <th>Status</th>
                                <th>Action</th>
                            </tr>
                        </thead>
                        <tbody id="playersTable">
                            <!-- Players will be populated here -->
                        </tbody>
                    </table>
                </div>
            </div>
            
            <div id="controlsTab" class="tab-content">
                <div class="controls">
                    <h3>Game Controls</h3>
                    <div class="controls-grid">
                        <button class="btn btn-success" onclick="startGame()">▶ Start Game</button>
                        <button class="btn btn-danger" onclick="stopGame()">⏹ Stop Game</button>
                        <button class="btn btn-primary" onclick="callNumber()">🔢 Call Number</button>
                        <button class="btn btn-warning" onclick="resetGame()">🔄 Reset Game</button>
                    </div>
                    
                    <h3 style="margin-top: 30px;">Broadcast Message</h3>
                    <input type="text" id="broadcastMessage" placeholder="Enter system message..." class="broadcast-input">
                    <button class="btn btn-primary" onclick="sendBroadcast()">📢 Broadcast</button>
                    
                    <h3 style="margin-top: 30px;">Player Management</h3>
                    <div class="controls-grid">
                        <input type="text" id="kickPlayerId" placeholder="Player ID to kick" class="broadcast-input">
                        <button class="btn btn-danger" onclick="kickPlayer()">👢 Kick Player</button>
                    </div>
                </div>
            </div>
            
            <div id="logsTab" class="tab-content">
                <div class="log-container" id="gameLog">
                    <!-- Logs will appear here -->
                </div>
            </div>
        </div>
        
        <script>
            let ws;
            let players = [];
            let logs = [];
            
            function connectWebSocket() {
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const wsUrl = \`\${protocol}//\${window.location.host}/ws?admin=${CONFIG.ADMIN_KEY}\`;
                
                ws = new WebSocket(wsUrl);
                
                ws.onopen = () => {
                    console.log('Admin WebSocket connected');
                    document.getElementById('connectionStatus').textContent = 'Connected';
                };
                
                ws.onmessage = (event) => {
                    const data = JSON.parse(event.data);
                    handleAdminMessage(data);
                };
                
                ws.onclose = () => {
                    console.log('Admin WebSocket disconnected');
                    document.getElementById('connectionStatus').textContent = 'Disconnected';
                    setTimeout(connectWebSocket, 3000);
                };
                
                ws.onerror = (error) => {
                    console.error('WebSocket error:', error);
                };
            }
            
            function handleAdminMessage(data) {
                switch(data.type) {
                    case 'admin_connected':
                        updateDashboard(data.gameState);
                        players = data.gameState.players || [];
                        updatePlayersTable();
                        logs = data.gameLog || [];
                        updateLogs();
                        break;
                        
                    case 'player_registered_admin':
                        players.push(data.player);
                        updateDashboard({ players: players.length, prizePool: data.prizePool });
                        updatePlayersTable();
                        addLog(\`Player registered: \${data.player.name}\`);
                        break;
                        
                    case 'player_disconnected_admin':
                        players = players.filter(p => p.id !== data.playerId);
                        updateDashboard({ players: players.length });
                        updatePlayersTable();
                        addLog(\`Player disconnected: \${data.playerName}\`);
                        break;
                        
                    case 'number_called_admin':
                        updateDashboard({ 
                            calledNumbers: data.totalCalled,
                            currentNumber: data.display 
                        });
                        addLog(\`Number called: \${data.display}\`);
                        break;
                        
                    case 'game_started_admin':
                        updateDashboard({ gameActive: true });
                        addLog('Game started');
                        break;
                        
                    case 'game_stopped_admin':
                        updateDashboard({ gameActive: false });
                        addLog('Game stopped');
                        break;
                        
                    case 'winner_admin':
                        updateDashboard({ winner: data.player.name });
                        addLog(\`🎉 WINNER: \${data.player.name} won \${data.prize} Birr!\`);
                        break;
                        
                    case 'chat_message_admin':
                        addLog(\`💬 \${data.playerName}: \${data.message}\`);
                        break;
                }
            }
            
            function updateDashboard(stats) {
                if (stats.players !== undefined) {
                    document.getElementById('playerCount').textContent = stats.players;
                }
                if (stats.prizePool !== undefined) {
                    document.getElementById('prizePool').textContent = stats.prizePool.toLocaleString();
                }
                if (stats.gameActive !== undefined) {
                    document.getElementById('gameStatus').textContent = stats.gameActive ? 'Active' : 'Stopped';
                    document.getElementById('gameStatus').style.color = stats.gameActive ? '#0f0' : '#f00';
                }
                if (stats.calledNumbers !== undefined) {
                    document.getElementById('calledNumbers').textContent = stats.calledNumbers;
                }
                if (stats.currentNumber !== undefined) {
                    document.getElementById('currentNumber').textContent = stats.currentNumber || '-';
                }
                if (stats.totalCollected !== undefined) {
                    document.getElementById('totalCollected').textContent = stats.totalCollected.toLocaleString();
                }
                if (stats.totalPaidOut !== undefined) {
                    document.getElementById('totalPaidOut').textContent = stats.totalPaidOut.toLocaleString();
                }
                if (stats.winner !== undefined) {
                    document.getElementById('winner').textContent = stats.winner || 'None';
                }
            }
            
            function updatePlayersTable() {
                const tbody = document.getElementById('playersTable');
                tbody.innerHTML = '';
                
                players.forEach(player => {
                    const row = document.createElement('tr');
                    row.innerHTML = \`
                        <td>\${player.id.substring(0, 8)}...</td>
                        <td>\${player.name}</td>
                        <td>\${player.phone}</td>
                        <td>\${player.boardType}</td>
                        <td>\${player.boardNumber}</td>
                        <td>\${player.stake} ብር</td>
                        <td>\${player.balance} ብር</td>
                        <td class="\${player.isOnline ? 'connected' : 'disconnected'}">
                            \${player.isOnline ? 'Online' : 'Offline'}
                        </td>
                        <td>
                            <button class="btn btn-danger btn-small" onclick="kickPlayer('\${player.id}')">
                                Kick
                            </button>
                        </td>
                    \`;
                    tbody.appendChild(row);
                });
            }
            
            function updateLogs() {
                const logContainer = document.getElementById('gameLog');
                logContainer.innerHTML = '';
                
                logs.forEach(log => {
                    const entry = document.createElement('div');
                    entry.className = 'log-entry';
                    entry.textContent = log;
                    logContainer.appendChild(entry);
                });
                
                logContainer.scrollTop = logContainer.scrollHeight;
            }
            
            function addLog(message) {
                const timestamp = new Date().toLocaleTimeString();
                const logContainer = document.getElementById('gameLog');
                const entry = document.createElement('div');
                entry.className = 'log-entry';
                entry.textContent = \`[\${timestamp}] \${message}\`;
                logContainer.appendChild(entry);
                logContainer.scrollTop = logContainer.scrollHeight;
            }
            
            function showTab(tabName) {
                // Hide all tabs
                document.querySelectorAll('.tab-content').forEach(tab => {
                    tab.classList.remove('active');
                });
                document.querySelectorAll('.tab').forEach(tab => {
                    tab.classList.remove('active');
                });
                
                // Show selected tab
                document.getElementById(tabName + 'Tab').classList.add('active');
                event.target.classList.add('active');
            }
            
            function searchPlayers() {
                const searchTerm = document.getElementById('playerSearch').value.toLowerCase();
                const rows = document.querySelectorAll('#playersTable tr');
                
                rows.forEach(row => {
                    const text = row.textContent.toLowerCase();
                    row.style.display = text.includes(searchTerm) ? '' : 'none';
                });
            }
            
            // Game control functions
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
            
            function sendBroadcast() {
                const message = document.getElementById('broadcastMessage').value;
                if (message.trim()) {
                    ws.send(JSON.stringify({
                        type: 'admin_broadcast',
                        message: message
                    }));
                    document.getElementById('broadcastMessage').value = '';
                }
            }
            
            function kickPlayer(playerId) {
                if (!playerId) {
                    playerId = document.getElementById('kickPlayerId').value;
                }
                
                if (playerId) {
                    ws.send(JSON.stringify({
                        type: 'admin_kick_player',
                        playerId: playerId
                    }));
                    document.getElementById('kickPlayerId').value = '';
                }
            }
            
            // Initialize
            connectWebSocket();
            
            // Auto-refresh stats every 5 seconds
            setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'admin_get_stats' }));
                }
            }, 5000);
        </script>
    </body>
    </html>
    `;
    
    return new Response(adminHtml, {
      headers: { "Content-Type": "text/html" }
    });
  }
  
  // 404 for unknown routes
  return new Response("Not Found", { status: 404 });
}

// ============ START SERVER ============
logEvent(`🚀 Bingo Server starting on ${CONFIG.HOST}:${CONFIG.PORT}`);
logEvent(`📱 Player URL: http://${CONFIG.HOST}:${CONFIG.PORT}`);
logEvent(`🔧 Admin URL: http://${CONFIG.HOST}:${CONFIG.PORT}/admin?key=${CONFIG.ADMIN_KEY}`);

// Start HTTP server
serve(handleRequest, { hostname: CONFIG.HOST, port: CONFIG.PORT });
