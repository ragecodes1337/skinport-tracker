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
const CURRENCY = 'EUR';

// Rate limiting configuration - Skinport allows 8 requests per 5 minutes
const RATE_LIMIT_WINDOW = 5 * 60 * 1000; // 5 minutes in milliseconds
const MAX_REQUESTS_PER_WINDOW = 8;
const requestQueue = []; // Queue to store timestamps of requests

// Middleware
app.use(cors());
app.use(express.json());

/**
 * Delays execution for a given number of milliseconds.
 * @param {number} ms The number of milliseconds to wait.
 * @returns {Promise<void>} A promise that resolves after the delay.
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * A rate limiter that respects Skinport's 8 requests per 5 minutes limit.
 * It waits if the request queue is full.
 */
async function waitForRateLimit() {
    const now = Date.now();
    // Remove old requests from the queue
    while (requestQueue.length > 0 && now - requestQueue[0] > RATE_LIMIT_WINDOW) {
        requestQueue.shift();
    }

    if (requestQueue.length >= MAX_REQUESTS_PER_WINDOW) {
        // Queue is full, wait for the oldest request to expire
        const oldestRequestTime = requestQueue[0];
        const timeToWait = (oldestRequestTime + RATE_LIMIT_WINDOW) - now;
        if (timeToWait > 0) {
            console.log(`[Rate Limiter] Waiting ${timeToWait}ms for the next available slot.`);
            await delay(timeToWait);
        }
    }
    // Add the new request timestamp to the queue
    requestQueue.push(Date.now());
}

/**
 * Fetches the sales history for an item from the Skinport API.
 * @param {string} marketHashName The market hash name of the item.
 * @param {string} currency The currency to use.
 * @returns {Promise<object|null>} The sales history data or null on error.
 */
async function fetchSalesHistory(marketHashName, currency) {
    const cacheKey = `salesHistory_${marketHashName}_${currency}`;
    const cachedData = cache.get(cacheKey);

    if (cachedData) {
        console.log(`[Cache] Cache hit for ${marketHashName}`);
        return cachedData;
    }

    try {
        await waitForRateLimit();
        const response = await fetch(`${SKINPORT_API_URL}/sales/history/${encodeURIComponent(marketHashName)}?app_id=${APP_ID_CSGO}&currency=${currency}`);
        
        if (!response.ok) {
            console.error(`[API Error] Failed to fetch sales history for ${marketHashName}. Status: ${response.status}`);
            return null;
        }

        const data = await response.json();
        // Cache the response
        cache.set(cacheKey, data);
        console.log(`[Cache] Cache set for ${marketHashName}`);
        return data;
    } catch (error) {
        console.error(`[Data Fetch] Error fetching sales history for ${marketHashName}: ${error}`);
        return null;
    }
}

/**
 * Calculates the average sales price from the last 7 days of sales.
 * @param {Array<object>} salesHistory The array of sales history data.
 * @returns {number|null} The average price or null if no sales in the last 7 days.
 */
function getAverageSalesPrice(salesHistory) {
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const recentSales = salesHistory.filter(sale => new Date(sale.sold_at * 1000) > sevenDaysAgo);

    if (recentSales.length === 0) {
        return null;
    }

    const totalSalesPrice = recentSales.reduce((sum, sale) => sum + sale.price, 0);
    return totalSalesPrice / recentSales.length;
}

/**
 * Analyzes a list of items to find profitable deals.
 * @param {Array<object>} items The list of items scraped from Skinport.
 * @param {number} minProfit The minimum profit threshold.
 * @param {number} minProfitMargin The minimum profit margin threshold.
 * @param {string} currency The currency to use.
 * @returns {Promise<Array<object>>} An array of profitable deals.
 */
async function analyzePrices(items, minProfit, minProfitMargin, currency) {
    const analyzedItems = [];
    const uniqueItems = new Set(items.map(item => item.marketHashName));

    for (const marketHashName of uniqueItems) {
        try {
            const salesHistory = await fetchSalesHistory(marketHashName, currency);
            if (salesHistory && salesHistory.length > 0) {
                const averageSalesPrice = getAverageSalesPrice(salesHistory);

                if (averageSalesPrice) {
                    const marketItems = items.filter(item => item.marketHashName === marketHashName);
                    for (const { price, wear } of marketItems) {
                        const profit = averageSalesPrice - price;
                        const profitMargin = (profit / price) * 100;

                        if (profit >= minProfit && profitMargin >= minProfitMargin) {
                            analyzedItems.push({
                                marketHashName,
                                price,
                                wear,
                                averageSalesPrice,
                                profit: parseFloat(profit.toFixed(2)),
                                profitMargin: parseFloat(profitMargin.toFixed(2))
                            });
                        }
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
    const { items, settings } = req.body;
    if (!items || !Array.isArray(items) || !settings) {
        return res.status(400).json({ error: 'Invalid input. Expected an array of items and settings.' });
    }

    console.log(`[Backend] Received ${items.length} items for analysis.`);

    try {
        const analyzedItems = await analyzePrices(items, settings.minProfit, settings.minProfitMargin, settings.currency);
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
    console.log(`Skinport Tracker API listening on port ${port}`);
});