// API Server for Skinport Tracker (to be deployed on your Render server)
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import NodeCache from 'node-cache';
import { MongoClient } from 'mongodb';

const app = express();
const port = process.env.PORT || 3000;

// Cache for API responses (5 minutes = 300 seconds)
const cache = new NodeCache({ stdTTL: 300, checkperiod: 120 });

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

        // Ensure indexes
        await db.collection('items').createIndex({ market_hash_name: 1 }, { unique: true });
        await db.collection('sales_history').createIndex({ market_hash_name: 1 }, { unique: true });
        console.log('[Server] Connected to MongoDB successfully.');
    } catch (error) {
        console.error('[Server] Failed to connect to MongoDB:', error);
        throw error;
    }
}

// Function to fetch historical data from Skinport API
async function fetchSkinportHistoricalData(market_hash_name) {
    const cachedData = cache.get(market_hash_name);
    if (cachedData) {
        console.log(`[Cache] Cache hit for ${market_hash_name}`);
        return cachedData;
    }

    const apiUrl = `https://api.skinport.com/v1/items/history?app_id=730&market_hash_name=${encodeURIComponent(market_hash_name)}`;
    console.log(`[API] Fetching historical data for ${market_hash_name}`);

    try {
        const response = await fetch(apiUrl);

        // Handle a 404 (Not Found) gracefully
        if (response.status === 404) {
            console.warn(`[API] Historical data not found for ${market_hash_name}. Skipping item.`);
            return null;
        }

        if (!response.ok) {
            throw new Error(`Failed to fetch historical data. Status: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        
        // The API returns an array, so we check for an empty array
        if (data && data.length > 0) {
            cache.set(market_hash_name, data);
            return data;
        } else {
            console.warn(`[API] Historical data for ${market_hash_name} is empty. Skipping item.`);
            return null;
        }
    } catch (error) {
        console.error(`[API] Error fetching data for ${market_hash_name}:`, error.message);
        throw error;
    }
}

// Middleware
app.use(cors());
app.use(express.json());

// API route to scan deals
app.post('/api/scan-deals', async (req, res) => {
    try {
        const { items, settings } = req.body;
        if (!items || !Array.isArray(items)) {
            return res.status(400).json({ error: 'Invalid request body: "items" array is required.' });
        }

        const analyzedItems = [];

        // Loop through each item and get its historical data
        for (const item of items) {
            try {
                // Fetch historical data for each item
                const historicalData = await fetchSkinportHistoricalData(item.market_hash_name);
                
                // If historical data is available and not an empty array, perform analysis
                if (historicalData && historicalData.length > 0) {
                    const totalSales = historicalData.reduce((acc, curr) => acc + curr.price, 0);
                    const avg_24h = totalSales / historicalData.length;
                    
                    // The profit is the difference between the average 24h sales price and the current price
                    const potentialProfit = avg_24h - item.current_price;
                    const profitPercentage = (potentialProfit / item.current_price) * 100;

                    analyzedItems.push({
                        market_hash_name: item.market_hash_name,
                        currentPrice: item.current_price,
                        avg_24h,
                        potentialProfit,
                        profitPercentage
                    });
                }
            } catch (itemError) {
                console.error(`[Server] Error processing item ${item.market_hash_name}:`, itemError);
                // Continue to the next item instead of failing the entire request
            }
        }

        res.json({ analyzedItems });

    } catch (error) {
        console.error('[Server] API route error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Start the server and connect to MongoDB
async function startServer() {
    try {
        await connectToMongoDB();
        
        // Start Express server
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
    mongoClient?.close().finally(() => {
        process.exit(1);
    });
});

startServer();