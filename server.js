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
    requestQueue = requestQueue.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW);

    if (requestQueue.length >= MAX_REQUESTS_PER_WINDOW) {
        const oldestRequestTime = requestQueue[0];
        const timeToWait = (oldestRequestTime + RATE_LIMIT_WINDOW) - now;
        if (timeToWait > 0) {
            console.log(`[Rate Limiter] Waiting for ${timeToWait}ms...`);
            await delay(timeToWait);
        }
    }
    requestQueue.push(Date.now());
}

// Function to fetch and analyze prices
async function analyzePrices(items, settings) {
    const analyzedItems = [];
    const minProfit = settings.minProfit || 5;
    const minProfitMargin = settings.minProfitMargin || 8;
    const currency = settings.currency || 'EUR';

    for (const item of items) {
        const { marketHashName, price, wear } = item;
        const cacheKey = `${marketHashName}-${currency}`;
        let salesHistory;

        // Check cache first
        salesHistory = cache.get(cacheKey);

        if (!salesHistory) {
            await waitForRateLimit();

            try {
                const response = await fetch(`${SKINPORT_API_URL}/sales/history?app_id=${APP_ID_CSGO}&market_hash_name=${encodeURIComponent(marketHashName)}&currency=${currency}`);

                if (response.ok) {
                    salesHistory = await response.json();
                    if (salesHistory) {
                        cache.set(cacheKey, salesHistory);
                    }
                } else {
                    console.error(`[Data Collection] Error fetching sales history for ${marketHashName}: ${response.statusText}`);
                    continue;
                }
            } catch (error) {
                console.error(`[Data Collection] Fetch error for ${marketHashName}:`, error);
                continue;
            }
        }

        if (salesHistory && salesHistory.length > 0) {
            // Filter to remove outlier sales (optional, but good practice)
            const recentSales = salesHistory.filter(sale => sale.last_sale_time * 1000 > Date.now() - (7 * 24 * 60 * 60 * 1000)); // Last 7 days
            
            if (recentSales.length > 0) {
                const totalSalesPrice = recentSales.reduce((sum, sale) => sum + sale.last_sale_price, 0);
                const averageSalesPrice = totalSalesPrice / recentSales.length;

                // Calculate profit and profit margin
                // Skinport takes a 12% commission, with a min of 0.01 EUR.
                const profit = averageSalesPrice * 0.88 - price;
                const profitMargin = (profit / price) * 100;

                if (profit >= minProfit && profitMargin >= minProfitMargin) {
                    analyzedItems.push({
                        marketHashName,
                        price,
                        wear,
                        averageSalesPrice: averageSalesPrice.toFixed(2),
                        profit: profit.toFixed(2),
                        profitMargin: profitMargin.toFixed(2)
                    });
                }
            }
        }
    }
    
    return analyzedItems;
}

// API endpoint to receive prices and return deals
app.post('/analyze-prices', async (req, res) => {
    const { items, settings } = req.body;
    if (!items || !Array.isArray(items)) {
        return res.status(400).json({ error: 'Invalid input. Expected an array of items.' });
    }

    console.log(`[Backend] Received ${items.length} items for analysis.`);

    try {
        const analyzedItems = await analyzePrices(items, settings);
        res.json({ analyzedItems });
    } catch (error) {
        console.error(`[Backend] Failed to analyze prices: ${error}`);
        res.status(500).json({ error: 'Failed to process items.' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    const now = Date.now();
    requestQueue = requestQueue.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW);

    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        rateLimit: {
            requestsInLast5Min: requestQueue.length,
            maxRequests: MAX_REQUESTS_PER_WINDOW,
            nextAvailableSlot: requestQueue.length >= MAX_REQUESTS_PER_WINDOW ?
                new Date(Math.min(...requestQueue) + RATE_LIMIT_WINDOW + 1000).toISOString() :
                'now'
        }
    });
});

// Start Express server
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
