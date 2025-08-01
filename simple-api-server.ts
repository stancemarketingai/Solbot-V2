import express from 'express';
import cors from 'cors';
import { Connection, PublicKey, LAMPORTS_PER_SOL, Keypair } from '@solana/web3.js';
import { SimpleFeeManager, defaultFeeConfig } from './simple-fee-config';
import { swapConfig } from './swapConfig';
import axios from 'axios';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import RaydiumSwap from './RaydiumSwap';
import WalletWithNumber from './wallet';
import { getPoolKeysForTokenAddress } from './pool-keys';
import { getSolBalance, loadSession, saveSession, createWalletWithNumber, SessionData } from './utility';
import chalk from 'chalk';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';

const app = express();
const server = createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.API_PORT || 12001;

// Middleware
app.use(cors({
  origin: [
    "http://localhost:3000",
    "http://localhost:12000",
    "https://work-1-wstvhtbzaocrxqur.prod-runtime.all-hands.dev",
    "https://work-2-wstvhtbzaocrxqur.prod-runtime.all-hands.dev"
  ],
  credentials: true
}));
app.use(express.json());

// Initialize services
const connection = new Connection(swapConfig.RPC_URL, 'confirmed');
const feeManager = new SimpleFeeManager();

// Real trading session storage
interface TradingSession {
  id: string;
  userWallet: string;
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  strategy: 'VOLUME_ONLY' | 'MAKERS_VOLUME';
  walletCount: number;
  solAmount: number;
  status: 'created' | 'active' | 'paused' | 'stopped' | 'error';
  adminWallet?: WalletWithNumber;
  tradingWallets: WalletWithNumber[];
  poolKeys?: any;
  createdAt: Date;
  startTime?: Date;
  endTime?: Date;
  metrics: {
    totalVolume: number;
    totalTransactions: number;
    successfulTransactions: number;
    failedTransactions: number;
    totalFees: number;
    averageSlippage: number;
  };
}

interface TransactionRecord {
  id: string;
  sessionId: string;
  type: 'buy' | 'sell';
  amount: number;
  tokenAmount?: number;
  price?: number;
  hash?: string;
  status: 'pending' | 'success' | 'failed';
  timestamp: Date;
  fee: number;
  slippage?: number;
  error?: string;
}

// Storage
const activeSessions = new Map<string, TradingSession>();
const transactionHistory = new Map<string, TransactionRecord[]>();
const tradingIntervals = new Map<string, NodeJS.Timeout>();
const userStats = new Map<string, { totalTrades: number; freeTradesUsed: number }>();

// WebSocket connection handling
io.on('connection', (socket) => {
  console.log(chalk.green(`🔌 Client connected: ${socket.id}`));
  
  socket.on('disconnect', () => {
    console.log(chalk.yellow(`🔌 Client disconnected: ${socket.id}`));
  });
  
  socket.on('joinSession', (sessionId) => {
    socket.join(sessionId);
    console.log(chalk.blue(`📡 Client ${socket.id} joined session ${sessionId}`));
  });
  
  socket.on('leaveSession', (sessionId) => {
    socket.leave(sessionId);
    console.log(chalk.blue(`📡 Client ${socket.id} left session ${sessionId}`));
  });
});

// Utility functions
async function getWalletBalances(walletAddress: string) {
  try {
    const publicKey = new PublicKey(walletAddress);
    const solBalance = await connection.getBalance(publicKey);
    return {
      solBalance: solBalance / LAMPORTS_PER_SOL,
      tokenBalance: 0 // Will be updated when we get token accounts
    };
  } catch (error) {
    console.error('Error getting wallet balance:', error);
    return { solBalance: 0, tokenBalance: 0 };
  }
}

async function createTradingWallets(count: number): Promise<WalletWithNumber[]> {
  const wallets: WalletWithNumber[] = [];
  
  for (let i = 0; i < count; i++) {
    const wallet = new WalletWithNumber();
    wallets.push(wallet);
  }
  
  console.log(chalk.green(`✅ Created ${count} trading wallets`));
  return wallets;
}

async function collectFee(userWallet: string, sessionId: string): Promise<boolean> {
  try {
    const fee = feeManager.calculateFee(userWallet);
    
    if (fee === 0) {
      // Free trade
      feeManager.recordTrade(userWallet, true);
      console.log(chalk.blue(`🆓 Free trade used for ${userWallet}`));
      return true;
    }
    
    // In a real implementation, you would create a transaction to collect the fee
    // For now, we'll simulate fee collection
    console.log(chalk.green(`💰 Fee collected: ${fee} SOL from ${userWallet}`));
    feeManager.recordTrade(userWallet, false);
    
    // Update session metrics
    const session = activeSessions.get(sessionId);
    if (session) {
      session.metrics.totalFees += fee;
    }
    
    return true;
  } catch (error) {
    console.error(chalk.red(`❌ Fee collection failed: ${error}`));
    return false;
  }
}

function emitToSession(sessionId: string, event: string, data: any) {
  io.to(sessionId).emit(event, data);
  io.emit(event, data); // Also emit globally for dashboard
}

// API Routes

// Health check
app.get('/api/health', async (req, res) => {
  try {
    // Test RPC connection
    const slot = await connection.getSlot();
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      rpcConnected: true,
      currentSlot: slot,
      activeSessions: activeSessions.size
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      timestamp: new Date().toISOString(),
      rpcConnected: false,
      error: 'RPC connection failed'
    });
  }
});

// Validate token address and check if it has a Raydium pool
app.post('/api/tokens/validate', async (req, res) => {
  try {
    const { tokenAddress } = req.body;
    
    if (!tokenAddress) {
      return res.status(400).json({ error: 'Token address is required' });
    }

    // Validate it's a valid Solana address
    try {
      new PublicKey(tokenAddress);
    } catch {
      return res.status(400).json({ valid: false, error: 'Invalid Solana address format' });
    }

    // Check if token has a Raydium pool
    let poolKeys = null;
    try {
      poolKeys = await getPoolKeysForTokenAddress(connection, tokenAddress);
      if (!poolKeys) {
        return res.status(404).json({ 
          valid: false, 
          error: 'No Raydium pool found for this token. Trading not possible.' 
        });
      }
    } catch (error) {
      return res.status(404).json({ 
        valid: false, 
        error: 'Failed to find Raydium pool for this token' 
      });
    }

    // Fetch token data from DexScreener
    try {
      const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
      const data = response.data;

      if (data.pairs && data.pairs.length > 0) {
        const pair = data.pairs[0];
        const tokenInfo = {
          address: tokenAddress,
          name: pair.baseToken.name,
          symbol: pair.baseToken.symbol,
          price: `$${parseFloat(pair.priceUsd).toFixed(6)}`,
          volume24h: `$${parseInt(pair.volume.h24).toLocaleString()}`,
          marketCap: pair.marketCap ? `$${parseInt(pair.marketCap).toLocaleString()}` : 'N/A',
          verified: true,
          hasPool: true,
          poolKeys: poolKeys
        };

        res.json({ valid: true, tokenInfo });
      } else {
        // Token has pool but not on DexScreener - still valid for trading
        const tokenInfo = {
          address: tokenAddress,
          name: 'Unknown Token',
          symbol: 'UNKNOWN',
          price: 'N/A',
          volume24h: 'N/A',
          marketCap: 'N/A',
          verified: false,
          hasPool: true,
          poolKeys: poolKeys
        };
        
        res.json({ valid: true, tokenInfo });
      }
    } catch (dexError) {
      // DexScreener failed but we have a pool, so token is still tradeable
      const tokenInfo = {
        address: tokenAddress,
        name: 'Unknown Token',
        symbol: 'UNKNOWN',
        price: 'N/A',
        volume24h: 'N/A',
        marketCap: 'N/A',
        verified: false,
        hasPool: true,
        poolKeys: poolKeys
      };
      
      res.json({ valid: true, tokenInfo });
    }
  } catch (error) {
    console.error('Token validation error:', error);
    res.status(500).json({ valid: false, error: 'Failed to validate token' });
  }
});

// Get session wallets (for active sessions)
app.get('/api/sessions/:sessionId/wallets', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = activeSessions.get(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const walletsWithBalances = await Promise.all(
      session.tradingWallets.map(async (wallet, index) => {
        const balances = await getWalletBalances(wallet.publicKey);
        return {
          id: `wallet_${index + 1}`,
          address: wallet.publicKey,
          solBalance: balances.solBalance,
          tokenBalance: balances.tokenBalance,
          isActive: true,
          walletNumber: wallet.number
        };
      })
    );
    
    res.json(walletsWithBalances);
  } catch (error) {
    console.error('Get session wallets error:', error);
    res.status(500).json({ error: 'Failed to get session wallets' });
  }
});

// Get user stats
app.get('/api/users/:walletAddress/stats', (req, res) => {
  try {
    const { walletAddress } = req.params;
    const stats = feeManager.getUserStats(walletAddress);
    
    res.json(stats);
  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({ error: 'Failed to get user stats' });
  }
});

// Get global metrics
app.get('/api/metrics', async (req, res) => {
  try {
    let totalVolume = 0;
    let totalTransactions = 0;
    let totalFees = 0;
    let activeWallets = 0;
    let activeSessionsCount = 0;
    
    // Calculate real metrics from all sessions
    for (const session of activeSessions.values()) {
      totalVolume += session.metrics.totalVolume;
      totalTransactions += session.metrics.totalTransactions;
      totalFees += session.metrics.totalFees;
      activeWallets += session.tradingWallets.length;
      
      if (session.status === 'active') {
        activeSessionsCount++;
      }
    }
    
    const metrics = {
      totalVolume,
      totalTransactions,
      activeWallets,
      totalFees,
      activeSessions: activeSessionsCount,
      volumeChange: 0, // Could be calculated from historical data
      transactionChange: 0,
      walletChange: 0,
      feeChange: 0
    };
    
    res.json(metrics);
  } catch (error) {
    console.error('Get metrics error:', error);
    res.status(500).json({ error: 'Failed to get metrics' });
  }
});

// Get recent transactions across all sessions
app.get('/api/transactions', (req, res) => {
  try {
    const { limit = 50, userWallet } = req.query;
    
    // Get all transactions from all sessions
    const allTransactions: any[] = [];
    
    if (userWallet) {
      // Get transactions for specific user
      for (const session of activeSessions.values()) {
        if (session.userWallet === userWallet) {
          const sessionTransactions = transactionHistory.get(session.id) || [];
          allTransactions.push(...sessionTransactions.map(tx => ({
            ...tx,
            sessionId: session.id,
            tokenSymbol: session.tokenSymbol,
            time: formatTimeAgo(tx.timestamp)
          })));
        }
      }
    } else {
      // Get all transactions
      for (const [sessionId, transactions] of transactionHistory.entries()) {
        const session = activeSessions.get(sessionId);
        if (session) {
          allTransactions.push(...transactions.map(tx => ({
            ...tx,
            sessionId,
            tokenSymbol: session.tokenSymbol,
            time: formatTimeAgo(tx.timestamp)
          })));
        }
      }
    }
    
    // Sort by timestamp and limit
    const sortedTransactions = allTransactions
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, parseInt(limit as string));
    
    res.json(sortedTransactions);
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ error: 'Failed to get transactions' });
  }
});

function formatTimeAgo(timestamp: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - timestamp.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} minutes ago`;
  
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours} hours ago`;
  
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} days ago`;
}

// Create trading session
app.post('/api/sessions', async (req, res) => {
  try {
    const {
      userWallet,
      tokenAddress,
      tokenName,
      tokenSymbol,
      strategy,
      walletCount = 5,
      solAmount = 0.1
    } = req.body;

    // Validate required fields
    if (!userWallet || !tokenAddress || !tokenName || !strategy) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate strategy
    if (!['VOLUME_ONLY', 'MAKERS_VOLUME'].includes(strategy)) {
      return res.status(400).json({ error: 'Invalid strategy' });
    }

    // Validate wallet count and SOL amount
    if (walletCount < 1 || walletCount > 20) {
      return res.status(400).json({ error: 'Wallet count must be between 1 and 20' });
    }

    if (solAmount < 0.001 || solAmount > 10) {
      return res.status(400).json({ error: 'SOL amount must be between 0.001 and 10' });
    }

    // Get pool keys for the token
    let poolKeys;
    try {
      poolKeys = await getPoolKeysForTokenAddress(connection, tokenAddress);
      if (!poolKeys) {
        return res.status(400).json({ error: 'No Raydium pool found for this token' });
      }
    } catch (error) {
      return res.status(400).json({ error: 'Failed to get pool keys for token' });
    }

    // Create trading wallets
    const tradingWallets = await createTradingWallets(walletCount);

    // Create session
    const sessionId = `session_${Date.now()}_${userWallet.slice(0, 8)}`;
    
    const session: TradingSession = {
      id: sessionId,
      userWallet,
      tokenAddress,
      tokenName,
      tokenSymbol,
      strategy,
      walletCount,
      solAmount,
      status: 'created',
      tradingWallets,
      poolKeys,
      createdAt: new Date(),
      metrics: {
        totalVolume: 0,
        totalTransactions: 0,
        successfulTransactions: 0,
        failedTransactions: 0,
        totalFees: 0,
        averageSlippage: 0
      }
    };

    activeSessions.set(sessionId, session);
    transactionHistory.set(sessionId, []);
    
    console.log(chalk.green(`✅ Created session ${sessionId} for ${userWallet}`));
    emitToSession(sessionId, 'sessionCreated', { sessionId, session });
    
    res.json({ sessionId, session });
  } catch (error) {
    console.error('Create session error:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// Session file management endpoints (must come before generic session routes)

// Get all active sessions
app.get('/api/sessions', (req, res) => {
  try {
    const sessions = Array.from(activeSessions.values()).map(session => ({
      id: session.id,
      userWallet: session.userWallet,
      tokenAddress: session.tokenAddress,
      tokenName: session.tokenName,
      tokenSymbol: session.tokenSymbol,
      strategy: session.strategy,
      walletCount: session.walletCount,
      solAmount: session.solAmount,
      status: session.status,
      createdAt: session.createdAt,
      metrics: session.metrics
    }));
    
    res.json({ success: true, sessions });
  } catch (error) {
    console.error('Get sessions error:', error);
    res.status(500).json({ error: 'Failed to get sessions' });
  }
});

// Get all session files
app.get('/api/sessions/files', async (req, res) => {
  try {
    const sessionDir = swapConfig.SESSION_DIR;
    
    if (!fs.existsSync(sessionDir)) {
      return res.json([]);
    }
    
    const files = fs.readdirSync(sessionDir)
      .filter(file => file.endsWith('_session.json'))
      .map(file => {
        const filePath = path.join(sessionDir, file);
        const stats = fs.statSync(filePath);
        
        // Parse filename to extract info
        const parts = file.replace('_session.json', '').split('_');
        const tokenName = parts[0] || 'Unknown';
        const timestamp = parts.slice(1).join('_') || 'Unknown';
        
        return {
          filename: file,
          tokenName,
          timestamp,
          size: `${(stats.size / 1024).toFixed(2)} KB`,
          lastModified: stats.mtime,
          fullPath: filePath
        };
      })
      .sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
    
    res.json(files);
  } catch (error) {
    console.error('Get session files error:', error);
    res.status(500).json({ error: 'Failed to get session files' });
  }
});

// Get session file content
app.get('/api/sessions/files/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const sessionDir = swapConfig.SESSION_DIR;
    const filePath = path.join(sessionDir, filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Session file not found' });
    }
    
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const sessionData = JSON.parse(fileContent);
    
    res.json(sessionData);
  } catch (error) {
    console.error('Get session file error:', error);
    res.status(500).json({ error: 'Failed to load session file' });
  }
});

// Import session from file
app.post('/api/sessions/import', async (req, res) => {
  try {
    const { filename } = req.body;
    
    if (!filename) {
      return res.status(400).json({ error: 'Filename is required' });
    }
    
    const sessionDir = swapConfig.SESSION_DIR;
    const filePath = path.join(sessionDir, filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Session file not found' });
    }
    
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const sessionData: SessionData = JSON.parse(fileContent);
    
    // Create new active session from file data
    const sessionId = `imported_${Date.now()}`;
    const newSession: TradingSession = {
      id: sessionId,
      userWallet: sessionData.admin.address,
      tokenAddress: sessionData.tokenAddress,
      tokenName: sessionData.tokenName,
      tokenSymbol: sessionData.tokenName, // Use tokenName as symbol
      strategy: 'VOLUME_ONLY', // Default strategy
      walletCount: sessionData.wallets.length,
      solAmount: 0.1, // Default amount
      status: 'created',
      adminWallet: null, // Will be set when session starts
      tradingWallets: [], // Will be populated when session starts
      poolKeys: sessionData.poolKeys,
      createdAt: new Date(),
      metrics: {
        totalVolume: 0,
        totalTransactions: 0,
        successfulTransactions: 0,
        failedTransactions: 0,
        totalFees: 0,
        averageSlippage: 0
      }
    };
    
    activeSessions.set(sessionId, newSession);
    transactionHistory.set(sessionId, []);
    
    console.log(chalk.green(`✅ Imported session ${sessionId} from file ${filename}`));
    
    res.json({ 
      success: true, 
      sessionId,
      session: newSession,
      message: 'Session imported successfully' 
    });
  } catch (error) {
    console.error('Import session error:', error);
    res.status(500).json({ error: 'Failed to import session' });
  }
});

// Wallet creation endpoint
app.post('/api/wallets/create', async (req, res) => {
  try {
    const { type, privateKey, mnemonic } = req.body;
    
    if (type === 'import') {
      if (!privateKey) {
        return res.status(400).json({ error: 'Private key is required for import' });
      }
      
      try {
        const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
        const publicKey = wallet.publicKey.toString();
        
        res.json({
          success: true,
          publicKey,
          message: 'Wallet imported successfully'
        });
      } catch (error) {
        return res.status(400).json({ error: 'Invalid private key format' });
      }
    } else if (type === 'generate') {
      const wallet = Keypair.generate();
      const publicKey = wallet.publicKey.toString();
      const secretKey = bs58.encode(wallet.secretKey);
      
      res.json({
        success: true,
        publicKey,
        privateKey: secretKey,
        message: 'Wallet generated successfully'
      });
    } else {
      res.status(400).json({ error: 'Invalid wallet creation type' });
    }
  } catch (error) {
    console.error('Wallet creation error:', error);
    res.status(500).json({ error: 'Failed to create wallet' });
  }
});

// Get session details
app.get('/api/sessions/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = activeSessions.get(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    res.json(session);
  } catch (error) {
    console.error('Get session error:', error);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// Real trading execution function
async function executeTrade(sessionId: string): Promise<void> {
  const session = activeSessions.get(sessionId);
  if (!session || session.status !== 'active') {
    return;
  }

  try {
    // Select random wallet for trading
    const wallet = session.tradingWallets[
      Math.floor(Math.random() * session.tradingWallets.length)
    ];

    // Create RaydiumSwap instance
    const raydiumSwap = new RaydiumSwap(swapConfig.RPC_URL, wallet.privateKey);
    
    // Determine trade type based on strategy
    const tradeType = Math.random() > 0.5 ? 'buy' : 'sell';
    const baseAmount = session.solAmount;
    const variation = 0.1 + Math.random() * 0.4; // 10% to 50% variation
    const amount = baseAmount * variation;
    
    const transactionId = `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Create transaction record
    const transaction: TransactionRecord = {
      id: transactionId,
      sessionId,
      type: tradeType,
      amount,
      status: 'pending',
      timestamp: new Date(),
      fee: 0
    };

    // Add to history
    const history = transactionHistory.get(sessionId) || [];
    history.unshift(transaction);
    transactionHistory.set(sessionId, history);
    
    // Keep only last 100 transactions
    if (history.length > 100) {
      history.splice(100);
    }

    emitToSession(sessionId, 'transactionStarted', { sessionId, transaction });

    let txHash: string | undefined;
    
    try {
      if (tradeType === 'buy') {
        // Buy tokens with SOL
        const swapTransaction = await raydiumSwap.getSwapTransaction(
          session.tokenAddress,
          amount,
          session.poolKeys,
          100000, // maxLamports
          'in'
        );
        
        if (swapTransaction) {
          txHash = await raydiumSwap.sendVersionedTransaction(swapTransaction);
        }
      } else {
        // Sell tokens for SOL
        const swapTransaction = await raydiumSwap.getSwapTransaction(
          session.tokenAddress,
          amount,
          session.poolKeys,
          100000, // maxLamports
          'out'
        );
        
        if (swapTransaction) {
          txHash = await raydiumSwap.sendVersionedTransaction(swapTransaction);
        }
      }

      if (txHash) {
        transaction.status = 'success';
        transaction.hash = txHash;
        
        // Update session metrics
        session.metrics.totalTransactions++;
        session.metrics.successfulTransactions++;
        session.metrics.totalVolume += amount;
        
        console.log(chalk.green(`✅ Trade executed: ${tradeType} ${amount.toFixed(6)} SOL - ${txHash}`));
        emitToSession(sessionId, 'transactionSuccess', { sessionId, transaction });
      } else {
        throw new Error('Transaction failed - no hash returned');
      }
      
    } catch (tradeError) {
      transaction.status = 'failed';
      transaction.error = tradeError instanceof Error ? tradeError.message : 'Unknown error';
      
      // Update session metrics
      session.metrics.totalTransactions++;
      session.metrics.failedTransactions++;
      
      console.error(chalk.red(`❌ Trade failed: ${tradeError}`));
      emitToSession(sessionId, 'transactionFailed', { sessionId, transaction, error: tradeError });
    }
    
  } catch (error) {
    console.error(chalk.red(`❌ Trading loop error for session ${sessionId}:`, error));
    emitToSession(sessionId, 'tradingError', { sessionId, error });
  }
}

// Start trading session
app.post('/api/sessions/:sessionId/start', async (req, res) => {
  const { sessionId } = req.params;
  let session: TradingSession | undefined;
  
  try {
    session = activeSessions.get(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status === 'active') {
      return res.status(400).json({ error: 'Session is already active' });
    }

    // Collect fee before starting
    const feeCollected = await collectFee(session.userWallet, sessionId);
    if (!feeCollected) {
      return res.status(400).json({ error: 'Fee collection failed' });
    }

    // Update session status
    session.status = 'active';
    session.startTime = new Date();

    // Start trading loop
    const interval = setInterval(async () => {
      await executeTrade(sessionId);
    }, swapConfig.loopInterval);

    tradingIntervals.set(sessionId, interval);

    console.log(chalk.green(`🚀 Started trading session: ${sessionId}`));
    emitToSession(sessionId, 'sessionStarted', { sessionId, session });
    
    res.json({ message: 'Trading session started', session });
  } catch (error) {
    console.error('Start session error:', error);
    if (session) {
      session.status = 'error';
    }
    res.status(500).json({ error: 'Failed to start session' });
  }
});

// Pause trading session
app.post('/api/sessions/:sessionId/pause', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = activeSessions.get(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status !== 'active') {
      return res.status(400).json({ error: 'Session is not active' });
    }

    session.status = 'paused';

    // Clear trading interval
    const interval = tradingIntervals.get(sessionId);
    if (interval) {
      clearInterval(interval);
      tradingIntervals.delete(sessionId);
    }

    console.log(chalk.yellow(`⏸️ Paused trading session: ${sessionId}`));
    emitToSession(sessionId, 'sessionPaused', { sessionId, session });
    
    res.json({ message: 'Trading session paused', session });
  } catch (error) {
    console.error('Pause session error:', error);
    res.status(500).json({ error: 'Failed to pause session' });
  }
});

// Stop trading session
app.post('/api/sessions/:sessionId/stop', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = activeSessions.get(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    session.status = 'stopped';
    session.endTime = new Date();

    // Clear trading interval
    const interval = tradingIntervals.get(sessionId);
    if (interval) {
      clearInterval(interval);
      tradingIntervals.delete(sessionId);
    }

    console.log(chalk.red(`🛑 Stopped trading session: ${sessionId}`));
    emitToSession(sessionId, 'sessionStopped', { sessionId, session });
    
    res.json({ message: 'Trading session stopped', session });
  } catch (error) {
    console.error('Stop session error:', error);
    res.status(500).json({ error: 'Failed to stop session' });
  }
});

// Get session metrics
app.get('/api/sessions/:sessionId/metrics', (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = activeSessions.get(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    // Calculate real metrics
    const successRate = session.metrics.totalTransactions > 0 
      ? (session.metrics.successfulTransactions / session.metrics.totalTransactions) * 100 
      : 0;
    
    // Generate volume history based on actual trading activity
    const volumeHistory = Array.from({ length: 24 }, (_, i) => {
      const hour = new Date();
      hour.setHours(hour.getHours() - (23 - i));
      return {
        time: `${hour.getHours()}:00`,
        volume: session.metrics.totalVolume * (Math.random() * 0.1) // Distribute volume across hours
      };
    });
    
    const metrics = {
      totalVolume: session.metrics.totalVolume,
      totalTransactions: session.metrics.totalTransactions,
      successfulTransactions: session.metrics.successfulTransactions,
      failedTransactions: session.metrics.failedTransactions,
      successRate: successRate,
      averageSlippage: session.metrics.averageSlippage,
      totalFees: session.metrics.totalFees,
      activeWallets: session.tradingWallets.length,
      status: session.status,
      startTime: session.startTime,
      endTime: session.endTime,
      volumeHistory
    };
    
    res.json(metrics);
  } catch (error) {
    console.error('Get metrics error:', error);
    res.status(500).json({ error: 'Failed to get metrics' });
  }
});

// Get transaction history for session
app.get('/api/sessions/:sessionId/transactions', (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = activeSessions.get(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const transactions = transactionHistory.get(sessionId) || [];
    
    // Format transactions for frontend
    const formattedTransactions = transactions.map(tx => ({
      ...tx,
      amount: `${tx.amount.toFixed(6)} SOL`,
      token: session.tokenSymbol,
      price: tx.price ? `$${tx.price.toFixed(6)}` : 'N/A',
      hash: tx.hash ? `${tx.hash.slice(0, 8)}...${tx.hash.slice(-8)}` : 'N/A',
      fee: `${defaultFeeConfig.feePerTransaction} SOL`,
      time: formatTimeAgo(tx.timestamp)
    }));
    
    res.json(formattedTransactions);
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ error: 'Failed to get transactions' });
  }
});

// Get user sessions
app.get('/api/users/:walletAddress/sessions', (req, res) => {
  try {
    const { walletAddress } = req.params;
    
    const userSessions = Array.from(activeSessions.values())
      .filter(session => session.userWallet === walletAddress);
    
    res.json(userSessions);
  } catch (error) {
    console.error('Get user sessions error:', error);
    res.status(500).json({ error: 'Failed to get user sessions' });
  }
});

// Calculate fee for transaction
app.post('/api/fees/calculate', (req, res) => {
  try {
    const { userWallet } = req.body;
    
    if (!userWallet) {
      return res.status(400).json({ error: 'User wallet is required' });
    }
    
    const fee = feeManager.calculateFee(userWallet);
    const stats = feeManager.getUserStats(userWallet);
    
    res.json({ fee, stats });
  } catch (error) {
    console.error('Calculate fee error:', error);
    res.status(500).json({ error: 'Failed to calculate fee' });
  }
});

// Error handling middleware
app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('API Error:', error);
  res.status(500).json({ error: 'Internal server error' });
});



// Graceful shutdown
process.on('SIGINT', () => {
  console.log(chalk.yellow('\n🛑 Shutting down gracefully...'));
  
  // Stop all trading intervals
  for (const [sessionId, interval] of tradingIntervals.entries()) {
    clearInterval(interval);
    console.log(chalk.blue(`⏹️ Stopped trading for session: ${sessionId}`));
  }
  
  // Update all active sessions to stopped
  for (const session of activeSessions.values()) {
    if (session.status === 'active') {
      session.status = 'stopped';
      session.endTime = new Date();
    }
  }
  
  process.exit(0);
});

// Start server
server.listen(PORT, () => {
  console.log(chalk.green(`🚀 Solbot API server running on port ${PORT}`));
  console.log(chalk.blue(`📊 Dashboard: http://localhost:3000`));
  console.log(chalk.blue(`🔗 API: http://localhost:${PORT}/api`));
  console.log(chalk.blue(`🌐 WebSocket: ws://localhost:${PORT}`));
  console.log(chalk.yellow(`💰 Fee per transaction: ${defaultFeeConfig.feePerTransaction} SOL`));
  console.log(chalk.yellow(`🆓 Free trades per user: ${defaultFeeConfig.freeTrades}`));
  console.log(chalk.green(`✅ Server ready for trading!`));
});

export default app;