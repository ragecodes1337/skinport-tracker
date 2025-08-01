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
    
    // Remove requests older than 5 minutes
    requestQueue = requestQueue.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW);
    
    // If we've made 8 requests in the last 5 minutes, wait
    if (requestQueue.length >= MAX_REQUESTS_PER_WINDOW) {
        const oldestRequest = Math.min(...requestQueue);
        const waitTime = RATE_LIMIT_WINDOW - (now - oldestRequest) + 1000; // Add 1 second buffer
        console.log(`[API] Rate limit reached. Waiting ${Math.round(waitTime / 1000)} seconds...`);
        await delay(waitTime);
        return waitForRateLimit(); // Recursive call to check again
    }
    
    // Ensure minimum interval between requests (37.5 seconds)
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < REQUEST_INTERVAL) {
        const waitTime = REQUEST_INTERVAL - timeSinceLastRequest;
        console.log(`[API] Waiting ${Math.round(waitTime / 1000)} seconds for rate limit interval...`);
        await delay(waitTime);
    }
    
    // Record this request
    requestQueue.push(Date.now());
    lastRequestTime = Date.now();
}

// Function to fetch historical data from Skinport API with strict rate limiting
async function fetchHistoricalData(marketHashName, currency) {
    // Clean the market hash name by removing common prefixes and suffixes
    const cleanedMarketHashName = marketHashName
        .replace(/★\s*/, '') // Remove the star prefix
        .replace(/StatTrak™\s*/, '') // Remove StatTrak prefix
        .replace(/Souvenir\s*/, '') // Remove Souvenir prefix
        .trim();

    const cacheKey = `historical_${cleanedMarketHashName}_${currency}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        console.log(`[API] Cache hit for ${marketHashName}.`);
        return cachedData;
    }

    try {
        // Wait for rate limit before making request
        await waitForRateLimit();

        const url = `${SKINPORT_API_URL}/sales/history?app_id=${APP_ID_CSGO}&currency=${currency}&market_hash_name=${encodeURIComponent(cleanedMarketHashName)}`;
        
        console.log(`[API] Fetching historical data for: ${cleanedMarketHashName}`);
        console.log(`[API] Request URL: ${url}`);
        console.log(`[API] Requests made in last 5 minutes: ${requestQueue.length}/${MAX_REQUESTS_PER_WINDOW}`);
        
        const response = await fetch(url, {
            headers: {
                'Accept-Encoding': 'br',
                'User-Agent': 'SkinportTracker/1.0'
            }
        });

        if (response.status === 429) {
            console.log(`[API] Rate limited despite precautions. Waiting 5 minutes...`);
            await delay(5 * 60 * 1000); // Wait 5 minutes
            requestQueue = []; // Reset the queue
            return null; // Skip this item
        }

        if (!response.ok) {
            throw new Error(`API request failed with status: ${response.status}`);
        }

        const data = await response.json();
        return processHistoricalData(data, cleanedMarketHashName, cacheKey);

    } catch (error) {
        console.error(`[API] Error fetching historical data for ${cleanedMarketHashName}:`, error);
        return null;
    }
}

// Helper function to process historical data using the aggregated statistics
function processHistoricalData(data, cleanedMarketHashName, cacheKey) {
    // Skinport's /v1/sales/history returns an array of objects
    // Find the item that matches our cleaned market hash name
    
    console.log(`[API] Processing response data for ${cleanedMarketHashName}:`, JSON.stringify(data, null, 2));
    
    if (!Array.isArray(data) || data.length === 0) {
        console.log(`[API] No data array found or empty array for ${cleanedMarketHashName}`);
        return null;
    }
    
    // Find the matching item in the response array
    const itemData = data.find(item => 
        item.market_hash_name && 
        item.market_hash_name.toLowerCase().includes(cleanedMarketHashName.toLowerCase())
    );
    
    if (!itemData) {
        console.log(`[API] No matching item found in response for ${cleanedMarketHashName}`);
        console.log(`[API] Available items in response:`, data.map(item => item.market_hash_name));
        return null;
    }
    
    console.log(`[API] Found matching item:`, itemData.market_hash_name);
    
    // Try to get 7-day average first, then fallback to 30-day, then 90-day
    let historicalAvgPrice = null;
    let salesVolume = 0;
    let period = null;
    
    if (itemData.last_7_days && itemData.last_7_days.avg && itemData.last_7_days.avg > 0) {
        historicalAvgPrice = itemData.last_7_days.avg;
        salesVolume = itemData.last_7_days.volume || 0;
        period = '7 days';
    } else if (itemData.last_30_days && itemData.last_30_days.avg && itemData.last_30_days.avg > 0) {
        historicalAvgPrice = itemData.last_30_days.avg;
        salesVolume = itemData.last_30_days.volume || 0;
        period = '30 days';
    } else if (itemData.last_90_days && itemData.last_90_days.avg && itemData.last_90_days.avg > 0) {
        historicalAvgPrice = itemData.last_90_days.avg;
        salesVolume = itemData.last_90_days.volume || 0;
        period = '90 days';
    }
    
    if (historicalAvgPrice && historicalAvgPrice > 0) {
        const result = { 
            historicalAvgPrice,
            salesVolume,
            period,
            periodData: {
                last_24_hours: itemData.last_24_hours,
                last_7_days: itemData.last_7_days,
                last_30_days: itemData.last_30_days,
                last_90_days: itemData.last_90_days
            },
            item_page: itemData.item_page,
            market_page: itemData.market_page
        };
        
        cache.set(cacheKey, result); // Cache the result for 5 minutes
        console.log(`[API] Found ${period} avg price for ${cleanedMarketHashName}: €${historicalAvgPrice.toFixed(2)} (${salesVolume} sales)`);
        return result;
    }
    
    console.log(`[API] No sufficient historical data found for ${cleanedMarketHashName}. Item data:`, {
        last_7_days: itemData.last_7_days,
        last_30_days: itemData.last_30_days,
        last_90_days: itemData.last_90_days
    });
    return null;
}

// Main analysis endpoint
app.post('/scan', async (req, res) => {
    console.log('[Server] Received a new deal scan request.');
    const { items, settings } = req.body;
    console.log(`[Server] Processing ${items.length} items with strict rate limiting (8 requests per 5 minutes).`);

    const analyzedItems = [];
    let processedCount = 0;
    let skippedCount = 0;

    // With 8 requests per 5 minutes, we need to be very selective about which items to analyze
    // Prioritize items by price (higher price items first, as they may have better profit potential)
    const sortedItems = items.sort((a, b) => b.current_price - a.current_price);
    
    // Limit to first 8 items to respect rate limit, or use cached data for more
    const itemsToProcess = sortedItems.slice(0, MAX_REQUESTS_PER_WINDOW);
    
    if (items.length > MAX_REQUESTS_PER_WINDOW) {
        console.log(`[Server] Due to rate limits, processing top ${MAX_REQUESTS_PER_WINDOW} highest-priced items out of ${items.length} total items.`);
    }

    // Process items sequentially to respect rate limits
    for (const item of itemsToProcess) {
        try {
            const historicalData = await fetchHistoricalData(item.market_hash_name, settings.currency);
            processedCount++;
            
            console.log(`[Server] Processed ${processedCount}/${itemsToProcess.length} items`);
            
            if (historicalData) {
                console.log(`[Server] Historical data found for ${item.market_hash_name}.`);

                // Perform profit calculation based on the aggregated historical data
                const skinportFee = 0.12;
                const netSellingPrice = historicalData.historicalAvgPrice * (1 - skinportFee);
                const potentialProfit = netSellingPrice - item.current_price;
                const profitPercentage = (potentialProfit / item.current_price) * 100;

                // Only add to the list if it meets the profit criteria
                if (potentialProfit >= settings.minProfit && profitPercentage >= settings.minProfitMargin) {
                    analyzedItems.push({
                        market_hash_name: item.market_hash_name,
                        market_hash_name_slug: item.market_hash_name_slug,
                        current_price: item.current_price,
                        historicalAvgPrice: historicalData.historicalAvgPrice,
                        salesVolume: historicalData.salesVolume,
                        period: historicalData.period,
                        netSellingPrice,
                        potentialProfit,
                        profitPercentage,
                        periodData: historicalData.periodData,
                        item_page: historicalData.item_page,
                        market_page: historicalData.market_page
                    });
                }
            } else {
                skippedCount++;
                console.log(`[Server] Historical data not found for ${item.market_hash_name}. Skipping this item.`);
            }
        } catch (error) {
            skippedCount++;
            console.error(`[Server] Error processing ${item.market_hash_name}:`, error);
        }
    }

    console.log(`[Server] Finished analyzing. Found ${analyzedItems.length} profitable deals out of ${processedCount} processed items (${skippedCount} skipped).`);
    
    res.json({ 
        analyzedItems,
        stats: {
            totalItems: items.length,
            processedItems: processedCount,
            skippedItems: skippedCount,
            foundDeals: analyzedItems.length,
            rateLimitInfo: {
                maxRequestsPer5Min: MAX_REQUESTS_PER_WINDOW,
                requestsInQueue: requestQueue.length
            }
        }
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
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

// Endpoint to check rate limit status
app.get('/rate-limit-status', (req, res) => {
    const now = Date.now();
    const activeRequests = requestQueue.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW);
    
    res.json({
        requestsInLast5Minutes: activeRequests.length,
        maxRequestsPer5Minutes: MAX_REQUESTS_PER_WINDOW,
        availableRequests: MAX_REQUESTS_PER_WINDOW - activeRequests.length,
        nextResetTime: activeRequests.length > 0 ? 
            new Date(Math.min(...activeRequests) + RATE_LIMIT_WINDOW).toISOString() : 
            new Date().toISOString()
    });
});

// Start Express server
app.listen(port, () => {
    console.log(`[Server] Skinport Tracker running on port ${port}`);
    console.log(`[Server] Rate limit: ${MAX_REQUESTS_PER_WINDOW} requests per 5 minutes (~${Math.round(REQUEST_INTERVAL / 1000)} seconds between requests)`);
});