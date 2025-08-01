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
        /^chrome-extension:\/\/[a-z0-9-]+$/  // Matches any extension ID
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
            await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS)); // Use the main delay
        }
    }
    isProcessingQueue = false;
    console.log('[Queue] Finished processing');
}

// Make rate-limited API requests
async function fetchSkinportApi(endpoint, params = {}) {
    const queryString = new URLSearchParams(params).toString();
    const url = `${SKINPORT_API_BASE}${endpoint}?${queryString}`;
    return new Promise((resolve, reject) => {
        requestQueue.push({
            task: async () => {
                console.log(`[API] Fetching: ${url}`);
                const response = await fetch(url, {
                    headers: { 'Accept-Encoding': 'br' }
                });
                if (response.status === 429) {
                    throw new Error('Rate limit hit'); // Throw a specific error for rate limits
                }
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`API error: ${response.status} ${response.statusText} - ${errorText}`);
                }
                return response.json();
            },
            resolve,
            reject
        });
        processQueue(); // Start processing the queue if not already running
    });
}

// =============================================================================
// DATA COLLECTION SYSTEM (MongoDB)
// =============================================================================

// Removed updateAllItemsData from automated cycle to prevent memory issues.
// Items will now be added to the 'items' collection and 'data_collection_queue'
// when they are encountered via the /api/scan-deals endpoint or when their
// sales history is updated.

// Fetch sales history for a specific item - MODIFIED TO ALSO UPDATE ITEM DATA
async function updateItemSalesHistory(marketHashName) {
    try {
        console.log(`[Data Collection] Fetching sales history for: ${marketHashName}`);
        // Always fetch in EUR as per user request
        const salesData = await fetchSkinportApi('/sales/history', {
            app_id: 730,
            currency: 'EUR',
            market_hash_name: marketHashName
        });

        if (!salesData || !Array.isArray(salesData) || salesData.length === 0) {
            console.log(`[Data Collection] No sales history found for: ${marketHashName}`);
            return false;
        }
        const data = salesData[0]; // Skinport returns an array, take the first item's data
        const now = Math.floor(Date.now() / 1000);

        // --- Update/Insert item data in 'items' collection ---
        // This ensures basic item data is present even if not from a full /items fetch
        await db.collection('items').updateOne(
            { market_hash_name: marketHashName },
            {
                $set: {
                    current_min_price: data.min_price || 0, // Use sales history min_price if available
                    current_max_price: data.max_price || 0,
                    current_mean_price: data.mean_price || 0,
                    current_median_price: data.median_price || 0,
                    current_quantity: data.quantity || 0,
                    suggested_price: data.suggested_price || 0,
                    last_updated_items: now,
                    updated_at: data.updated_at || now // Use Skinport's updated_at or current time
                },
                $setOnInsert: {
                    created_at: data.created_at || now // Use Skinport's created_at or current time
                }
            },
            { upsert: true }
        );
        console.log(`[Data Collection] Updated item data for: ${marketHashName}`);


        // Update or insert sales history document in MongoDB
        await db.collection('sales_history').updateOne(
            { market_hash_name: marketHashName }, // Filter by market_hash_name
            {
                $set: { // Set all sales history fields
                    sales_24h_avg: data.last_24_hours?.avg,
                    sales_24h_min: data.last_24_hours?.min,
                    sales_24h_max: data.last_24_hours?.max,
                    sales_24h_median: data.last_24_hours?.median,
                    sales_24h_volume: data.last_24_hours?.volume || 0,
                    sales_7d_avg: data.last_7_days?.avg,
                    sales_7d_min: data.last_7_days?.min,
                    sales_7d_max: data.last_7_days?.max,
                    sales_7d_median: data.last_7_days?.median,
                    sales_7d_volume: data.last_7_days?.volume || 0,
                    sales_30d_avg: data.last_30_days?.avg,
                    sales_30d_min: data.last_30_days?.min,
                    sales_30d_max: data.last_30_days?.max,
                    sales_30d_median: data.last_30_days?.median,
                    sales_30d_volume: data.last_30_days?.volume || 0,
                    sales_90d_avg: data.last_90_days?.avg,
                    sales_90d_min: data.last_90_days?.min,
                    sales_90d_max: data.last_90_days?.max,
                    sales_90d_median: data.last_90_days?.median,
                    sales_90d_volume: data.last_90_days?.volume || 0,
                    last_updated_history: now // Our internal timestamp
                }
            },
            { upsert: true } // Insert if not found, update if found
        );
        console.log(`[Data Collection] Updated sales history for: ${marketHashName}`);
        return true;
    } catch (error) {
        console.error(`[Data Collection] Error updating sales history for ${marketHashName}:`, error);
        return false;
    }
}

// Background data collection worker
async function runDataCollection() {
    try {
        // Removed the updateAllItemsData() call to prevent memory issues.
        // The 'items' collection will now be populated as items are encountered
        // through the /api/scan-deals endpoint or when their sales history is updated.

        // Step 2: Process a batch of items from the queue for sales history (uses more API requests)
        const queueItems = await db.collection('data_collection_queue')
            .find({}) // Find all items in the queue
            .sort({ priority: -1, last_attempted: 1 }) // Sort by priority (desc) and least recently attempted (asc)
            .limit(2) // Process a small batch (2 items = 2 API requests to /sales/history)
            .toArray();
        console.log(`[Data Collection] Processing ${queueItems.length} items from queue`);

        for (const item of queueItems) {
            const success = await updateItemSalesHistory(item.market_hash_name);

            // Update queue item based on success
            if (success) {
                // Remove from queue if successful
                await db.collection('data_collection_queue').deleteOne({ market_hash_name: item.market_hash_name });
            } else {
                // Update retry count and last attempted time if failed
                await db.collection('data_collection_queue').updateOne(
                    { market_hash_name: item.market_hash_name },
                    {
                        $set: { last_attempted: Math.floor(Date.now() / 1000) },
                        $inc: { retry_count: 1 } // Increment retry count
                    }
                );
            }
        }

        console.log('[Data Collection] Cycle completed');
    } catch (error) {
        console.error('[Data Collection] Error in collection cycle:', error);
    }
}

// =============================================================================
// PROFIT ANALYSIS SYSTEM
// =============================================================================

function calculateProfitability(currentItem, salesHistory) {
    if (!salesHistory) {
        return {
            recommendedAction: 'SKIP',
            confidence: 0,
            reason: 'No sales history available'
        };
    }
    const currentPrice = currentItem.current_min_price;
    const suggestedPrice = currentItem.suggested_price;

    // Calculate weighted average sell price from historical data
    let weightedPrice = 0;
    let totalWeight = 0;

    // Weight recent sales more heavily
    const periods = [
        { data: salesHistory, key: '24h', weight: 0.6 },
        { data: salesHistory, key: '7d', weight: 0.3 },
        { data: salesHistory, key: '30d', weight: 0.1 }
    ];

    periods.forEach(period => {
        const avg = salesHistory[`sales_${period.key}_avg`];
        const volume = salesHistory[`sales_${period.key}_volume`];

        if (avg && volume > 0) {
            weightedPrice += avg * period.weight * Math.min(volume / 10, 1); // Volume factor
            totalWeight += period.weight * Math.min(volume / 10, 1);
        }
    });

    if (totalWeight === 0) {
        return {
            recommendedAction: 'SKIP',
            confidence: 0,
            reason: 'Insufficient sales volume'
        };
    }

    const expectedSellPrice = weightedPrice / totalWeight;
    const sellerFee = 0.08; // 8% Skinport fee
    const netSellPrice = expectedSellPrice * (1 - sellerFee);
    const potentialProfit = netSellPrice - currentPrice;
    const profitMargin = (potentialProfit / currentPrice) * 100;

    // Liquidity score based on recent trading volume
    const recentVolume = (salesHistory.sales_24h_volume || 0) + (salesHistory.sales_7d_volume || 0);
    const liquidityScore = Math.min(recentVolume / 50, 1); // Normalize to 0-1

    // Confidence based on data quality and consistency
    let confidence = 0.5;
    confidence += liquidityScore * 0.3; // More volume = higher confidence
    confidence += Math.min(totalWeight, 1) * 0.2; // Better data coverage = higher confidence

    // Price consistency check
    if (salesHistory.sales_7d_avg && salesHistory.sales_30d_avg) {
        const priceStability = 1 - Math.abs(salesHistory.sales_7d_avg - salesHistory.sales_30d_avg) / salesHistory.sales_30d_avg;
        confidence += priceStability * 0.2;
    }

    confidence = Math.max(0, Math.min(1, confidence));

   return {
        currentPrice,
        expectedSellPrice: parseFloat(expectedSellPrice.toFixed(2)),
        netSellPrice: parseFloat(netSellPrice.toFixed(2)),
        potentialProfit: parseFloat(potentialProfit.toFixed(2)),
        profitMargin: parseFloat(profitMargin.toFixed(2)),
        liquidityScore: parseFloat(liquidityScore.toFixed(2)),
        confidence: parseFloat(confidence.toFixed(3)),
        recommendedAction: potentialProfit > 1 && // Increased from 0.50 to 1 EUR
            profitMargin > 8 && // Increased from 5% to 8%
            confidence > 0.65 && // Increased from 0.6 to 0.65
            liquidityScore > 0.4 && // Added minimum liquidity requirement
            salesHistory.sales_24h_volume > 0 ? 'BUY' : 'SKIP', // Must have recent sales
        reason: potentialProfit <= 1 ? 'Insufficient profit' :
            profitMargin <= 8 ? 'Profit margin too low' :
            confidence <= 0.65 ? 'Low confidence' :
            liquidityScore <= 0.4 ? 'Poor liquidity' :
            salesHistory.sales_24h_volume === 0 ? 'No recent sales' :
            'Good profit opportunity'
    };
}

// =============================================================================
// API ENDPOINTS
// =============================================================================

// Scan for profitable deals
app.post('/api/scan-deals', async (req, res) => {
    try {
        const { minProfit = 0.50, minProfitMargin = 5, limit = 50, currency, skinportMarketUrl } = req.body;

        if (currency !== 'EUR') {
            console.warn(`[API] Received scan request for currency ${currency}, but backend only supports EUR for analysis.`);
        }

        console.log(`[API] Scanning for deals with minProfit: €${minProfit}, minMargin: ${minProfitMargin}% (Currency: EUR)`);

        // --- NEW LOGIC: Query MongoDB for items based on URL filters ---
        const urlObj = new URL(skinportMarketUrl);
        const params = new URLSearchParams(urlObj.search);
        
        const queryFilters = {};
        if (params.has('cat')) {
            queryFilters['category'] = params.get('cat');
        }
        if (params.has('type')) {
            queryFilters['type'] = params.get('type');
        }
        if (params.has('exterior')) {
            queryFilters['wear'] = params.get('exterior'); // Assuming 'exterior' maps to 'wear' in your DB
        }
        // Add other filters as needed (e.g., 'item_name', 'rarity', etc.)

        // Always filter by app_id 730 (CS2) if not already present in URL
        queryFilters['app_id'] = 730;

        // Fetch items from YOUR MongoDB 'items' collection
        const itemsFromDb = await db.collection('items')
            .find(queryFilters)
            .limit(limit * 2) // Fetch more than limit to ensure enough for analysis after filtering
            .toArray();

        if (!itemsFromDb || itemsFromDb.length === 0) {
            console.log('[API] No items found in database matching filters.');
            return res.json({ analyzedItems: [], totalFound: 0, timestamp: new Date().toISOString(), hasMorePages: false });
        }

        console.log(`[API] Found ${itemsFromDb.length} items in database matching filters.`);

        const now = Math.floor(Date.now() / 1000);
        const analyzedItems = [];

        for (const item of itemsFromDb) {
            // Add item to data_collection_queue if its sales history is old or missing
            const existingHistory = await db.collection('sales_history').findOne(
                { market_hash_name: item.market_hash_name },
                { projection: { last_updated_history: 1 } }
            );

            if (!existingHistory || (now - existingHistory.last_updated_history > 3600)) { // Update history if older than 1 hour
                await db.collection('data_collection_queue').updateOne(
                    { market_hash_name: item.market_hash_name },
                    {
                        $set: {
                            market_hash_name: item.market_hash_name,
                            priority: existingHistory ? 1 : 3, // Lower priority if already exists
                            last_attempted: 0,
                            retry_count: 0,
                            created_at: now
                        }
                    },
                    { upsert: true }
                );
            }

            // Get sales history for analysis (from DB, potentially just updated by background worker)
            const salesHistoryData = await db.collection('sales_history').findOne({ market_hash_name: item.market_hash_name });

            // Perform analysis
            const analysis = calculateProfitability(item, salesHistoryData);

            if (analysis.potentialProfit >= minProfit &&
                analysis.profitMargin >= minProfitMargin &&
                analysis.recommendedAction === 'BUY') {

                analyzedItems.push({
                    marketHashName: item.market_hash_name,
                    currentPrice: item.current_min_price, // Use current_min_price from DB
                    suggestedPrice: item.suggested_price,
                    quantity: item.current_quantity,
                    analysis: analysis,
                    itemUrl: `https://skinport.com/market?item=${encodeURIComponent(item.market_hash_name)}`,
                    itemId: item.id,
                    wear: item.wear,
                    isTradable: item.isTradable,
                    potentialProfit: analysis.potentialProfit,
                    profitPercentage: analysis.profitMargin
                });
            }
        }

        analyzedItems.sort((a, b) => b.potentialProfit - a.potentialProfit);

        res.json({
            analyzedItems: analyzedItems.slice(0, limit),
            totalFound: analyzedItems.length,
            timestamp: new Date().toISOString(),
            hasMorePages: false // Always false as we're serving from DB, not paginating Skinport API
        });

    } catch (error) {
        console.error('[API] Error in scan-deals:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update current prices for items
app.post('/api/update-current-prices', async (req, res) => {
    try {
        const { items } = req.body;
        const now = Math.floor(Date.now() / 1000);
        
        for (const item of items) {
            await db.collection('items').updateOne(
                { market_hash_name: item.market_hash_name },
                {
                    $set: {
                        current_min_price: item.current_price,
                        current_quantity: item.quantity,
                        last_updated_items: now
                    },
                    $setOnInsert: {
                        created_at: now
                    }
                },
                { upsert: true }
            );
        }
        console.log(`[API] Updated prices for ${items.length} items from extension`);
        res.json({ success: true, updated: items.length });
    } catch (error) {
        console.error('[API] Error updating prices:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get collection statistics
app.get('/api/stats', async (req, res) => {
    try {
        const totalItems = await db.collection('items').countDocuments();
        const itemsWithHistory = await db.collection('sales_history').countDocuments();
        const queueSize = await db.collection('data_collection_queue').countDocuments();

        // Get count of items updated in the last hour
        const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
        const recentlyUpdatedItems = await db.collection('items').countDocuments({
            last_updated_items: { $gt: oneHourAgo }
        });

        res.json({
            total_items: totalItems,
            items_with_history: itemsWithHistory,
            queue_size: queueSize,
            recently_updated_items: recentlyUpdatedItems,
            collection_progress: totalItems > 0 ? (itemsWithHistory / totalItems * 100).toFixed(1) : 0,
            last_update: new Date().toISOString()
        });
    } catch (error) {
        console.error('[API] Error in stats:', error);
        res.status(500).json({ error: error.message });
    }
});

// =============================================================================
// STARTUP AND SCHEDULING
// =============================================================================

async function startServer() {
    try {
        await connectToMongoDB(); // Connect to MongoDB

        // Handle MongoDB disconnections
        mongoClient.on('close', () => {
            console.warn('[Database] MongoDB connection closed. Attempting to reconnect...');
            setTimeout(connectToMongoDB, 5000);
        });

        mongoClient.on('timeout', () => {
            console.warn('[Database] MongoDB operation timeout. Reconnecting...');
            mongoClient.close().then(() => connectToMongoDB());
        });

        // Start the collection cycle with error handling
        console.log('[Server] Starting initial data collection (processing queue)...');
        runDataCollection().catch(error => {
            console.error('[Server] Error in initial data collection:', error);
        });

        // Schedule data collection with error handling
        setInterval(() => {
            runDataCollection().catch(error => {
                console.error('[Server] Error in scheduled data collection:', error);
            });
        }, 5 * 60 * 1000);

        // Start Express server
        app.listen(port, () => {
            console.log(`[Server] Skinport Tracker running on port ${port}`);
            console.log(`[Server] Data collection queue will be processed every 5 minutes`);
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

// Start the server
startServer();