// API Server for Skinport Tracker (to be deployed on your Render server)
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import NodeCache from 'node-cache';

const app = express();
const port = process.env.PORT || 3000;

// Cache for API responses (5 minutes = 300 seconds, matching the Skinport cache)
const cache = new NodeCache({ stdTTL: 300, checkperiod: 120 });

// Skinport API Constants
const SKINPORT_API_URL = 'https://api.skinport.com/v1';
const APP_ID_CSGO = 730;

// Rate limiting configuration - Skinport allows 8 requests per 5 minutes
const RATE_LIMIT_WINDOW = 5 * 60 * 1000; // 5 minutes in milliseconds
const MAX_REQUESTS_PER_WINDOW = 8;
const REQUEST_INTERVAL = RATE_LIMIT_WINDOW / MAX_REQUESTS_PER_WINDOW; // ~37.5 seconds between requests

// Track API requests
let requestQueue = [];
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
    // Clean up old requests from the queue
    requestQueue = requestQueue.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW);

    // If queue is full, wait until the oldest request falls out of the window
    if (requestQueue.length >= MAX_REQUESTS_PER_WINDOW) {
        const oldestRequestTime = requestQueue[0];
        const timeToWait = (oldestRequestTime + RATE_LIMIT_WINDOW) - now;
        console.log(`[Rate Limiter] Waiting for ${timeToWait}ms...`);
        await delay(timeToWait);
        // Recurse to re-check the queue
        await waitForRateLimit();
    } else {
        // If there are requests, but we're too fast, wait for the minimum interval
        const timeSinceLastRequest = now - lastRequestTime;
        if (timeSinceLastRequest < REQUEST_INTERVAL) {
            const timeToWait = REQUEST_INTERVAL - timeSinceLastRequest;
            console.log(`[Rate Limiter] Delaying for ${timeToWait}ms to respect interval...`);
            await delay(timeToWait);
        }
    }
}

// Helper function to fetch from Skinport API with rate limiting and caching
async function fetchSkinportAPI(endpoint, params) {
    const url = new URL(`${SKINPORT_API_URL}${endpoint}`);
    // Add default params
    url.searchParams.append('app_id', APP_ID_CSGO);
    url.searchParams.append('currency', 'EUR'); // Hardcoding to EUR for now

    // Add any provided params
    if (params) {
        Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));
    }
    
    // Check cache first
    const cacheKey = url.toString();
    const cachedResponse = cache.get(cacheKey);
    if (cachedResponse) {
        console.log(`[Cache] Cache hit for ${cacheKey}`);
        return cachedResponse;
    }

    // Wait for rate limit
    await waitForRateLimit();

    const now = Date.now();
    requestQueue.push(now);
    lastRequestTime = now;
    console.log(`[Rate Limiter] Executing API call. Queue size: ${requestQueue.length}`);
    
    try {
        // --- FIX ---
        // Adding standard headers to prevent 406 Not Acceptable error
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
            'Accept': 'application/json'
        };

        const response = await fetch(url, { headers });
        if (!response.ok) {
            throw new Error(`API call failed with status ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        cache.set(cacheKey, data); // Cache the new data
        return data;
    } catch (error) {
        console.error(`Error fetching from Skinport API: ${error.message}`);
        throw error;
    }
}

// Function to analyze prices
async function analyzePrices(itemsToAnalyze) {
    const analyzedItems = [];

    for (const item of itemsToAnalyze) {
        const { marketHashName, price, wear } = item;
        
        try {
            console.log(`[Data Collection] Fetching sales history for: ${marketHashName}`);

            // Fetch sales history for the item
            const salesHistory = await fetchSkinportAPI(`/sales/history`, { 
                market_hash_name: marketHashName 
            });

            if (salesHistory && salesHistory.length > 0) {
                // Calculate average sales price from the last 7 days of data
                const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
                const recentSales = salesHistory.filter(sale => new Date(sale.sold_at * 1000) > sevenDaysAgo);

                if (recentSales.length > 0) {
                    const totalSalesPrice = recentSales.reduce((sum, sale) => sum + sale.price, 0);
                    const averageSalesPrice = totalSalesPrice / recentSales.length;

                    // Calculate profit and margin
                    const profit = averageSalesPrice - price;
                    const profitMargin = (profit / price) * 100;
                    
                    // Add to analyzed items if it meets the criteria
                    // Note: These criteria should be configurable by the user, but we'll use a fixed value for now
                    if (profit >= 5 && profitMargin >= 8) {
                        analyzedItems.push({
                            marketHashName,
                            price,
                            wear,
                            averageSalesPrice,
                            profit,
                            profitMargin
                        });
                    }
                }
            }
        } catch (error) {
            console.error(`[Data Collection] Error processing sales history for ${marketHashName}: ${error}`);
        }
    }
    
    return analyzedItems;
}

// API endpoint to receive prices and return deals
app.post('/analyze-prices', async (req, res) => {
    const { items } = req.body;
    if (!items || !Array.isArray(items)) {
        return res.status(400).json({ error: 'Invalid input. Expected an array of items.' });
    }

    console.log(`[Backend] Received ${items.length} items for analysis.`);

    try {
        const analyzedItems = await analyzePrices(items);
        res.json({ analyzedItems });
    } catch (error) {
        console.error(`[Backend] Failed to analyze prices: ${error}`);
        res.status(500).json({ error: 'Failed to process items.' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString()
    });
});

// Start Express server
app.listen(port, () => {
    console.log(`Skinport Deal Tracker backend listening at http://localhost:${port}`);
});