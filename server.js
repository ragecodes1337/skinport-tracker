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
    console.log(`[API] Attempting to fetch historical data for: ${market_hash_name}`);

    try {
        const response = await fetch(apiUrl);

        if (response.status === 404) {
            console.warn(`[API] Historical data not found for ${market_hash_name}. Skipping this item.`);
            return null; // Return null gracefully
        }
        
        if (!response.ok) {
            throw new Error(`Failed to fetch historical data. Status: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        
        // The API returns an array of history data
        if (data && data.length > 0) {
            // Cache the first item in the array, as we are searching for a specific one
            const itemData = data[0];
            cache.set(market_hash_name, itemData);
            return itemData;
        } else {
            console.warn(`[API] Historical data for ${market_hash_name} is empty or malformed. Skipping item.`);
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
    console.log('[Server] Received a new deal scan request.');
    try {
        const { items, settings } = req.body;
        if (!items || !Array.isArray(items)) {
            return res.status(400).json({ error: 'Invalid request body: "items" array is required.' });
        }
        console.log(`[Server] Processing ${items.length} items.`);

        const analyzedItems = [];

        // Loop through each item and get its data
        for (const item of items) {
            try {
                // Fetch historical data for each item using the full market_hash_name
                const historicalData = await fetchSkinportHistoricalData(item.market_hash_name);
                
                // If historical data is available, perform analysis
                if (historicalData) {
                    let historicalAvgPrice;
                    
                    // Step 1: Collect historical average price with preference order
                    if (historicalData.last_7_days?.avg) {
                        historicalAvgPrice = historicalData.last_7_days.avg;
                    } else if (historicalData.last_30_days?.avg) {
                        historicalAvgPrice = historicalData.last_30_days.avg;
                    } else if (historicalData.last_90_days?.avg) {
                        historicalAvgPrice = historicalData.last_90_days.avg;
                    }

                    if (!historicalAvgPrice) {
                        console.warn(`[Server] No valid historical average price found for ${item.market_hash_name}. Skipping.`);
                        continue; // Skip to the next item if no valid price is found
                    }

                    // Step 2: Calculate net selling price with 8% fee
                    const netSellingPrice = item.current_price * 0.92;

                    // Step 3: Calculate profit margin
                    const potentialProfit = historicalAvgPrice - netSellingPrice;
                    const profitPercentage = (potentialProfit / historicalAvgPrice) * 100;
                    
                    analyzedItems.push({
                        market_hash_name: item.market_hash_name,
                        market_hash_name_slug: item.market_hash_name_slug,
                        currentPrice: item.current_price,
                        historicalAvgPrice,
                        netSellingPrice,
                        potentialProfit,
                        profitPercentage
                    });
                }
            } catch (itemError) {
                console.error(`[Server] Error processing item ${item.market_hash_name}:`, itemError);
                // Continue to the next item instead of failing the entire request
            }
        }
        console.log(`[Server] Finished analyzing ${analyzedItems.length} deals.`);
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