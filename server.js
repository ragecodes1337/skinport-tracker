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
 * Fetches sales history for multiple items in a single API call
 * @param {Array<string>} marketHashNames Array of market hash names
 * @param {string} currency The currency to use
 * @returns {Promise<object>} Object with market_hash_name as keys and sales data as values
 */
async function fetchSalesHistoryBatch(marketHashNames, currency) {
    const batchKey = `batch_${marketHashNames.sort().join(',')}_${currency}`;
    const cachedData = cache.get(batchKey);

    if (cachedData) {
        console.log(`[Cache] Batch cache hit for ${marketHashNames.length} items`);
        return cachedData;
    }

    try {
        await waitForRateLimit();
        
        // Join market hash names with commas for batch request
        const marketHashNamesParam = marketHashNames.join(',');
        
        const params = new URLSearchParams({
            app_id: APP_ID_CSGO,
            currency: currency,
            market_hash_name: marketHashNamesParam
        });
        
        const url = `${SKINPORT_API_URL}/sales/history?${params}`;
        console.log(`[API Call] Fetching batch of ${marketHashNames.length} items`);
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept-Encoding': 'br',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        if (!response.ok) {
            console.error(`[API Error] Failed to fetch batch sales history. Status: ${response.status} ${response.statusText}`);
            const responseText = await response.text();
            console.error(`[API Error] Response body: ${responseText.substring(0, 200)}...`);
            return {};
        }

        const data = await response.json();
        
        // Convert array response to object with market_hash_name as key
        const batchData = {};
        if (Array.isArray(data)) {
            data.forEach(item => {
                if (item.market_hash_name) {
                    batchData[item.market_hash_name] = item;
                }
            });
        }
        
        // Cache the batch response
        cache.set(batchKey, batchData);
        console.log(`[Cache] Batch cache set for ${marketHashNames.length} items`);
        
        return batchData;
        
    } catch (error) {
        console.error(`[Data Collection] Error fetching batch sales history: ${error.message}`);
        return {};
    }
}
/**
 * Calculates the average sales price from the last 7 days of sales.
 * @param {Array<object>} salesHistory The array of sales history data.
 * @returns {number|null} The average price or null if no sales in the last 7 days.
 */
function getAverageSalesPrice(salesHistoryData) {
    // The API returns aggregated data, not individual sales
    // Use the 7-day average if available
    if (salesHistoryData.last_7_days && salesHistoryData.last_7_days.avg !== null) {
        return salesHistoryData.last_7_days.avg;
    }
    
    // Fall back to 30-day average
    if (salesHistoryData.last_30_days && salesHistoryData.last_30_days.avg !== null) {
        return salesHistoryData.last_30_days.avg;
    }
    
    // Fall back to 90-day average
    if (salesHistoryData.last_90_days && salesHistoryData.last_90_days.avg !== null) {
        return salesHistoryData.last_90_days.avg;
    }
    
    return null;
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
    const uniqueItems = [...new Set(items.map(item => item.marketHashName))];
    
    console.log(`[Analysis] Processing ${uniqueItems.length} unique items in batches...`);
    
    // Process items in batches (let's use smaller batches to be safe)
    const BATCH_SIZE = 100; // Adjust this based on URL length limits
    
    for (let i = 0; i < uniqueItems.length; i += BATCH_SIZE) {
        const batch = uniqueItems.slice(i, i + BATCH_SIZE);
        console.log(`[Analysis] Processing batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(uniqueItems.length/BATCH_SIZE)} (${batch.length} items)`);
        
        const batchSalesHistory = await fetchSalesHistoryBatch(batch, currency);
        
        // Process each item in the batch
        for (const marketHashName of batch) {
            const salesHistoryData = batchSalesHistory[marketHashName];
            
            if (salesHistoryData) {
                const averageSalesPrice = getAverageSalesPrice(salesHistoryData);

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
        }
    }
    
    console.log(`[Analysis] Found ${analyzedItems.length} profitable deals`);
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