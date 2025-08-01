// API Server for Skinport Tracker (to be deployed on your Render server)
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { MongoClient } from 'mongodb';

const app = express();
const port = process.env.PORT || 3000;

// Skinport API Constants
const SKINPORT_API_URL = 'https://api.skinport.com/v1';
const APP_ID_CSGO = 730;

// Rate limiting configuration - Skinport allows 8 requests per 5 minutes
const RATE_LIMIT_WINDOW = 5 * 60 * 1000; // 5 minutes in milliseconds
const REQUEST_INTERVAL = 37500; // ~37.5 seconds, as 5 mins / 8 requests

// Track API requests
let lastRequestTime = 0;

// Middleware
app.use(cors());
app.use(express.json());

// Helper function to delay execution
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Rate limiter that respects Skinport's 8 requests per 5 minutes limit
async function waitForRateLimit() {
    const now = Date.now();
    const elapsedTime = now - lastRequestTime;
    if (elapsedTime < REQUEST_INTERVAL) {
        const timeToWait = REQUEST_INTERVAL - elapsedTime;
        console.log(`[Rate Limiter] Waiting for ${timeToWait}ms...`);
        await delay(timeToWait);
    }
    lastRequestTime = Date.now();
}

// MongoDB Connection Variables
let db;
let mongoClient;

// Function to connect to MongoDB
async function connectToMongoDB() {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
        console.error('MONGO_URI environment variable is not set!');
        process.exit(1);
    }

    try {
        mongoClient = new MongoClient(mongoUri);
        await mongoClient.connect();
        const dbName = new URL(mongoUri).pathname.substring(1) || 'skinport_tracker_db';
        db = mongoClient.db(dbName);

        // Ensure indexes for efficient querying
        await db.collection('sales_history').createIndex({ market_hash_name: 1 }, { unique: true });

        console.log('[Server] Successfully connected to MongoDB.');
    } catch (error) {
        console.error('[Server] Failed to connect to MongoDB:', error);
        throw error;
    }
}

// Function to fetch and cache historical data for a specific item
async function fetchAndCacheHistoricalData(marketHashName, currency) {
    // Check if data is already in the database and not too old
    const existingData = await db.collection('sales_history').findOne({ market_hash_name: marketHashName });
    const isStale = existingData && (new Date() - existingData.lastUpdated) > (24 * 60 * 60 * 1000); // 24 hours

    if (existingData && !isStale) {
        // Use cached data if it's fresh
        return existingData.averagePrice;
    }

    // If data is missing or stale, fetch it from the Skinport API
    await waitForRateLimit();
    const apiUrl = `${SKINPORT_API_URL}/sales/history?app_id=${APP_ID_CSGO}&currency=${currency}&market_hash_name=${encodeURIComponent(marketHashName)}`;
    
    try {
        const response = await fetch(apiUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch sales history for ${marketHashName}: ${response.statusText}`);
        }
        const salesHistory = await response.json();
        
        if (salesHistory.length > 0) {
            // Calculate historical average price
            const averagePrice = salesHistory.reduce((sum, sale) => sum + sale.price, 0) / salesHistory.length;
            
            // Save or update the sales history data in MongoDB
            await db.collection('sales_history').updateOne(
                { market_hash_name: marketHashName },
                {
                    $set: {
                        market_hash_name: marketHashName,
                        history: salesHistory,
                        averagePrice: averagePrice,
                        lastUpdated: new Date()
                    }
                },
                { upsert: true }
            );
            return averagePrice;
        }
    } catch (error) {
        console.error(`[Data Collection] Error processing sales history for ${marketHashName}:`, error.message);
    }

    return null; // Return null if fetching fails
}


// Endpoint to handle deal analysis requests from the extension
app.post('/api/items/analyze', async (req, res) => {
    const { items, minProfit, minProfitMargin } = req.body;

    if (!items || !Array.isArray(items)) {
        return res.status(400).json({ error: 'Invalid input: "items" array is required.' });
    }

    try {
        const analyzedItems = [];
        const currency = 'EUR'; // Hardcoded for this example
        const exchangeRate = 1.0; // Assuming 1.0 for EUR

        for (const item of items) {
            const historicalAvgPrice = await fetchAndCacheHistoricalData(item.market_hash_name, currency);

            if (historicalAvgPrice) {
                const netSellingPrice = historicalAvgPrice * (1 - 0.15); // 15% Skinport fee
                const potentialProfit = (netSellingPrice - item.current_price) * exchangeRate;
                const profitPercentage = (potentialProfit / item.current_price) * 100;

                const analysis = {
                    historicalAvgPrice,
                    netSellingPrice,
                    potentialProfit,
                    profitPercentage
                };

                if (potentialProfit >= minProfit && profitPercentage >= minProfitMargin) {
                    analyzedItems.push({ ...item, analysis });
                }
            }
        }

        res.json({ analyzedItems });
    } catch (error) {
        console.error('Error analyzing items:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start the server
async function startServer() {
    try {
        await connectToMongoDB();
        app.listen(port, () => {
            console.log(`[Server] Skinport Tracker running on port ${port}`);
        });

        // Graceful shutdown handling
        process.on('SIGINT', async () => {
            try {
                console.log('[Server] Shutting down gracefully...');
                await mongoClient?.close();
                process.exit(0);
            } catch (error) {
                console.error('[Server] Error during shutdown:', error);
                process.exit(1);
            }
        });
    } catch (error) {
        console.error('[Server] Failed to start server:', error);
        process.exit(1);
    }
}

// Global error handlers
process.on('unhandledRejection', (error) => {
    console.error('[Server] Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
    console.error('[Server] Uncaught exception:', error);
    // Attempt graceful shutdown
    mongoClient?.close().finally(() => process.exit(1));
});

startServer();