// API Server for Skinport Tracker (to be deployed on your Render server)
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import NodeCache from 'node-cache'; // Import NodeCache

const app = express();
const port = process.env.PORT || 3000;

// Skinport API Constants
const SKINPORT_API_URL = 'https://api.skinport.com/v1';
const APP_ID_CSGO = 730;

// Rate limiting configuration - Skinport allows 8 requests per 5 minutes
const RATE_LIMIT_WINDOW = 5 * 60 * 1000; // 5 minutes in milliseconds
const MAX_REQUESTS_PER_WINDOW = 8;
const REQUEST_INTERVAL = RATE_LIMIT_WINDOW / MAX_REQUESTS_PER_WINDOW; // ~37.5 seconds between requests

// A cache for API responses to avoid hitting rate limits unnecessarily
const cache = new NodeCache({ stdTTL: 300, checkperiod: 120 }); // 5 minute cache

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

    if (requestQueue.length >= MAX_REQUESTS_PER_WINDOW) {
        // If the queue is full, we must wait for the oldest request to expire
        const timeToWait = (requestQueue[0] + RATE_LIMIT_WINDOW) - now;
        console.log(`[Rate Limiter] Waiting for ${timeToWait}ms...`);
        await delay(timeToWait + 1000); // Add a small buffer
    } else {
        // If not full, but last request was too recent, wait for the interval
        const timeSinceLastRequest = now - lastRequestTime;
        const timeToWait = REQUEST_INTERVAL - timeSinceLastRequest;
        if (timeToWait > 0) {
            console.log(`[Rate Limiter] Waiting for ${timeToWait}ms...`);
            await delay(timeToWait);
        }
    }

    // Record the new request time
    const newRequestTime = Date.now();
    requestQueue.push(newRequestTime);
    lastRequestTime = newRequestTime;
}

// Function to fetch and process sales history
async function getSalesHistory(item) {
    const cacheKey = `sales_history_${item.marketHashName}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        return cachedData;
    }

    await waitForRateLimit();
    
    const url = `${SKINPORT_API_URL}/sales/history?app_id=${APP_ID_CSGO}&market_hash_name=${encodeURIComponent(item.marketHashName)}`;
    console.log(`[Data Collection] Fetching sales history for: ${item.marketHashName}`);

    const response = await fetch(url, {
        headers: {
            'Accept': 'application/json' // Explicitly set the Accept header
        }
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch sales history for ${item.marketHashName}: ${response.statusText}`);
    }

    const data = await response.json();
    cache.set(cacheKey, data);
    return data;
}

// Function to analyze scraped items
async function analyzeItems(items, minProfit, minProfitMargin) {
    const analyzedItems = [];

    for (const item of items) {
        try {
            // Fetch sales history for each item
            const history = await getSalesHistory(item);
            if (!history || history.length === 0) {
                console.warn(`[Analysis] Skipping ${item.marketHashName} - no sales history found.`);
                continue;
            }

            // Calculate average sales price from the last 7 days
            const now = Date.now();
            const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
            
            const recentSales = history.filter(sale => new Date(sale.sold_at).getTime() > sevenDaysAgo);
            
            if (recentSales.length === 0) {
                console.warn(`[Analysis] Skipping ${item.marketHashName} - no recent sales data.`);
                continue;
            }

            const totalSalesPrice = recentSales.reduce((sum, sale) => sum + sale.price, 0);
            const averageSalesPrice = totalSalesPrice / recentSales.length;

            const profit = item.price - averageSalesPrice;
            const profitMargin = (profit / averageSalesPrice) * 100;
            
            if (profit > minProfit && profitMargin > minProfitMargin) {
                analyzedItems.push({
                    ...item,
                    averageSalesPrice: averageSalesPrice,
                    profit: profit,
                    profitMargin: profitMargin,
                });
            }
        } catch (error) {
            console.error(`[Data Collection] Error processing sales history for ${item.marketHashName}: ${error.message}`);
        }
    }

    return analyzedItems;
}

// Endpoint to analyze scraped items
app.post('/api/items/analyze', async (req, res) => {
    const { items, minProfit, minProfitMargin } = req.body;
    
    if (!items || !Array.isArray(items)) {
        return res.status(400).json({ error: 'Invalid request body. "items" array is required.' });
    }

    try {
        const analyzedItems = await analyzeItems(items, minProfit, minProfitMargin);
        res.json({ analyzedItems });
    } catch (error) {
        console.error('Error during item analysis:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Start Express server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});