// API Server for Skinport Tracker (to be deployed on your Render server)
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import NodeCache from 'node-cache';
import { MongoClient } from 'mongodb';

// Queue system for rate limiting
const requestQueue = [];
let isProcessingQueue = false;

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
        await db.collection('data_collection_queue').createIndex({ priority: -1, last_attempted: 1 });

        console.log(`[Database] Connected to MongoDB: ${dbName}`);
    } catch (error) {
        console.error('[Database] Connection failed:', error);
        process.exit(1);
    }
}

app.use(cors({
    origin: [
        'https://skinport.com',
        'chrome-extension://*',
        /^chrome-extension:\/\/[a-z0-9-]+$/ // Matches any extension ID
    ],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Accept'],
    credentials: true,
    maxAge: 86400 // Cache preflight requests for 24 hours
}));

app.use(express.json());

// Add error handling middleware
app.use((err, req, res, next) => {
    console.error('[Server] Error:', err);
    res.status(500).json({ 
        error: 'Internal server error', 
        message: err.message 
    });
});
// Skinport API configuration
const SKINPORT_API_BASE = 'https://api.skinport.com/v1';

// Rate Limiter Configuration
const REQUEST_DELAY_MS = 37500; // 37.5 seconds (8 requests per 5 minutes)
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 10000;
// Request counter for the rate limit window
let requestCount = 0;
let windowStartTime = Date.now();

// Reset rate limit window
function resetRateLimitWindow() {
    requestCount = 0;
    windowStartTime = Date.now();
    console.log('[Rate Limiter] Window reset');
}

// Process request queue with proper rate limiting
async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    console.log('[Queue] Started processing');

    while (requestQueue.length > 0) {
        const now = Date.now();

        // Reset window if 5 minutes have passed
        if (now - windowStartTime >= (5 * 60 * 1000)) { // 5 minutes window
            resetRateLimitWindow();
        }

        // Wait if we've hit the rate limit for the current window
        if (requestCount >= 8) { // Skinport's limit is 8 requests per 5 minutes
            const waitTime = (5 * 60 * 1000) - (now - windowStartTime);
            console.log(`[Rate Limiter] Waiting ${Math.round(waitTime / 1000)}s for window reset`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            resetRateLimitWindow();
        }
        
        const { task, resolve, reject, retries = 0 } = requestQueue.shift();

        try {
            const result = await task();
            requestCount++; // Increment count only after successful execution
            resolve(result);
            console.log(`[Rate Limiter] Request completed (${requestCount}/8)`);
        } catch (error) {
            if (error.message.includes('Rate limit hit') && retries < MAX_RETRIES) {
                console.warn(`[Server] Rate limit hit for task. Retrying in ${RETRY_DELAY_MS / 1000} seconds (Retry ${retries + 1}/${MAX_RETRIES}).`);
                // Re-queue the task with an incremented retry count at the front
                requestQueue.unshift({ task, resolve, reject, retries: retries + 1 });
                await new Promise(res => setTimeout(res, RETRY_DELAY_MS)); // Wait longer before retry
            } else {
                reject(error); // Reject if not a rate limit error or max retries reached
            }
        }
        
        // Wait between requests if more are queued (to avoid burst limits)
        if (requestQueue.length > 0) {
            await new Promise(res => setTimeout(res, REQUEST_DELAY_MS));
        }
    }

    isProcessingQueue = false;
    console.log('[Queue] Finished processing');
}

// Enqueue a task to be executed by the rate limiter
function enqueueTask(task) {
    return new Promise((resolve, reject) => {
        requestQueue.push({ task, resolve, reject });
        if (!isProcessingQueue) {
            processQueue();
        }
    });
}

// Function to fetch historical data from Skinport API
async function fetchHistoricalData(marketHashName) {
    const cacheKey = `historicalData_${marketHashName}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        console.log(`[Cache] Cache hit for ${marketHashName}`);
        return cachedData;
    }

    console.log(`[API] Fetching historical data for ${marketHashName}`);
    const res = await fetch(`${SKINPORT_API_BASE}/items/history?app_id=730&currency=EUR&market_hash_name=${encodeURIComponent(marketHashName)}`);
    
    // Handle rate limiting gracefully
    if (res.status === 429) {
        throw new Error('Rate limit hit');
    }

    if (!res.ok) {
        throw new Error(`Failed to fetch historical data: ${res.statusText}`);
    }

    const data = await res.json();
    if (data && data.length > 0) {
        cache.set(cacheKey, data[0]);
        // Also store it in MongoDB
        try {
            await db.collection('sales_history').updateOne(
                { market_hash_name: marketHashName },
                { $set: data[0] },
                { upsert: true }
            );
        } catch (dbError) {
            console.error(`[Database] Failed to save historical data for ${marketHashName}:`, dbError);
        }
        return data[0];
    } else {
        return null;
    }
}

// --- API Endpoints ---

// Main endpoint to scan deals
app.post('/api/scan-deals', async (req, res, next) => {
    try {
        const { items, settings } = req.body;
        if (!items || !Array.isArray(items)) {
            return res.status(400).json({ error: 'Invalid input: "items" array is required.' });
        }

        const analyzedItems = [];
        
        // Loop through each item and get its historical data
        for (const item of items) {
            const marketHashName = item.market_hash_name;
            const currentPrice = item.current_price;
            
            // Enqueue the API call to respect rate limits
            const historicalData = await enqueueTask(() => fetchHistoricalData(marketHashName));

            if (historicalData) {
                // Perform the profit calculation and analysis, including the 8% sell fee
                const avg_24h = historicalData.last_24h_sales_avg;
                const net_sale_price = avg_24h * 0.92; // Calculate price after 8% fee
                const potentialProfit = net_sale_price - currentPrice;
                const profitPercentage = (potentialProfit / currentPrice) * 100;
                
                // Add to analyzed items if it meets the user's criteria
                if (potentialProfit >= settings.minProfit && profitPercentage >= settings.minProfitMargin) {
                    analyzedItems.push({
                        market_hash_name: marketHashName,
                        currentPrice: currentPrice,
                        avg_24h: avg_24h,
                        potentialProfit: potentialProfit,
                        profitPercentage: profitPercentage
                    });
                }
            }
        }
        
        // Return the list of profitable deals
        res.json({ analyzedItems });

    } catch (error) {
        console.error('[API] Error processing /api/scan-deals:', error);
        next(error); // Pass to the error handling middleware
    }
});

// Initial startup logic
async function startServer() {
    try {
        await connectToMongoDB();
        
        // Start Express server
        app.listen(port, () => {
            console.log(`[Server] Skinport Tracker running on port ${port}`);
        });

    } catch (error) {
        console.error('[Server] Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
