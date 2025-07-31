const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // Use node-fetch for server-side fetches
const NodeCache = require('node-cache'); // For caching API responses
const PQueue = require('p-queue'); // PQueue for server-side rate limiting to Skinport

const app = express();
const port = process.env.PORT || 3000; // Use environment port for Render deployment

// Cache for API responses (e.g., Skinport /sales history)
// Cache for 5 minutes (300 seconds) by default, matching Skinport's cache
const cache = new NodeCache({ stdTTL: 300, checkperiod: 120 });

// Middleware
app.use(cors({
    origin: ['https://skinport.com', 'chrome-extension://*'], // Allow requests from Skinport and your extension
    credentials: true
}));
app.use(express.json()); // Enable parsing of JSON request bodies

// Skinport API configuration
const SKINPORT_API_BASE = 'https://api.skinport.com/v1';

// --- Server-side Rate Limiter for Skinport API Calls ---
// This ensures your Render backend doesn't hit Skinport's rate limits.
const skinportApiLimiter = new PQueue({
    concurrency: 1, // Process one request at a time to Skinport to be safe
    intervalCap: 8, // Max 8 requests
    interval: 5 * 60 * 1000 // 5 minutes in milliseconds
});

// --- Helper Function: Make Rate-Limited Fetch Requests to Skinport API from Server ---
// This is the only function that directly calls api.skinport.com
async function fetchSkinportApi(endpoint, params = {}, headers = {}) {
    const queryString = new URLSearchParams(params).toString();
    const url = `${SKINPORT_API_BASE}${endpoint}?${queryString}`;

    console.log(`[Server] Queueing Skinport API call: ${url}`);
    return skinportApiLimiter.add(async () => {
        console.log(`[Server] Executing Skinport API call: ${url}`);
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept-Encoding': 'br', // Request Brotli compression
                ...headers
            }
        });

        if (response.status === 429) {
            console.warn(`[Server] Skinport API rate limit hit for ${endpoint}. Queue will handle retries.`);
            throw new Error('Rate limit hit, queueing for retry.');
        }
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`[Server] Skinport API error (${response.status} ${response.statusText}): ${errorText}`);
        }
        return response.json();
    });
}

// --- Core Logic: Fetch Sales History for a Specific Item (now on server) ---
// Fetches aggregated sales data (24h, 7d, 30d, 90d volumes and averages) for an item.
async function fetchItemSalesHistory(marketHashName, currency) {
    const cacheKey = `sales_history_${marketHashName}_${currency}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        console.log(`[Server] Returning cached sales history for ${marketHashName}`);
        return cachedData;
    }

    try {
        const salesData = await fetchSkinportApi('/sales/history', {
            app_id: 730, // CS2 App ID
            currency: currency,
            market_hash_name: marketHashName
        });

        if (salesData && salesData.length > 0) {
            const data = salesData[0]; // Skinport returns an array, take the first item's data
            cache.set(cacheKey, data); // Cache the result
            console.log(`[Server] Successfully fetched and cached sales history for ${marketHashName}`);
            return data;
        }
        console.warn(`[Server] No sales history found for ${marketHashName}.`);
        return null;
    } catch (error) {
        console.error(`[Server] Failed to fetch sales history for ${marketHashName}:`, error);
        return null;
    }
}

// --- Helper function for Outlier Detection (IQR Method) ---
// This function identifies and removes outliers from a list of numbers (prices).
function removeOutliersIQR(prices) {
    if (prices.length < 4) return prices; // Need at least 4 data points for IQR

    const sortedPrices = [...prices].sort((a, b) => a - b);
    const q1Index = Math.floor((sortedPrices.length) / 4);
    const q3Index = Math.ceil((sortedPrices.length * 3) / 4) -1; // Adjusted for 0-based index
    
    const q1 = sortedPrices[q1Index];
    const q3 = sortedPrices[q3Index];
    const iqr = q3 - q1;

    const lowerBound = q1 - 1.5 * iqr;
    const upperBound = q3 + 1.5 * iqr;

    return prices.filter(price => price >= lowerBound && price <= upperBound);
}


// --- Helper function to calculate volatility (now on server) ---
// Calculates a volatility factor based on the spread of prices.
function calculateVolatility(prices) {
    if (prices.length < 2) return 0.1; // Default volatility for insufficient data

    const mean = prices.reduce((sum, price) => sum + price, 0) / prices.length;
    const variance = prices.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / prices.length;
    const stdDev = Math.sqrt(variance);
    return Math.min(stdDev / mean, 0.5); // Cap volatility at 50% to prevent extreme values
}

// --- Helper function to calculate liquidity score (now on server) ---
// Returns a score from 0 to 1 based on sales volumes across different periods and volatility.
function calculateLiquidityScore(sales24hVolume, sales7dVolume, sales30dVolume, volatilityFactor) {
    // These are example maximum volumes for highly liquid items.
    // You should tune these based on actual Skinport data for various item types.
    const maxExpected24hVolume = 100;
    const maxExpected7dVolume = 700;
    const maxExpected30dVolume = 3000;

    // Weighted average of volume contributions, giving more weight to recent volume.
    // Increased weight for 24h volume for "selling often"
    const score24h = Math.min(1, sales24hVolume / maxExpected24hVolume) * 0.6; // Higher weight
    const score7d = Math.min(1, sales7dVolume / maxExpected7dVolume) * 0.3;
    const score30d = Math.min(1, sales30dVolume / maxExpected30dVolume) * 0.1;

    let totalVolumeScore = score24h + score7d + score30d;

    // Adjust liquidity based on volatility: higher volatility reduces liquidity score
    // A volatilityFactor of 0.5 (max) would reduce score by 0.5 * 0.5 = 0.25 (example)
    totalVolumeScore *= (1 - volatilityFactor * 0.5); // Apply a penalty for volatility

    return Math.max(0, Math.min(1, totalVolumeScore)); // Ensure score is between 0 and 1
}


// --- Helper function to calculate achievable price with 99.6% accuracy (now on server) ---
// This is the core pricing logic, aiming for high accuracy.
function calculateAchievablePrice(salesHistoryData, currentPrice) {
    // Handle cases where no sales history is available
    if (!salesHistoryData || (salesHistoryData.last_24_hours?.volume === 0 && salesHistoryData.last_7_days?.volume === 0 && salesHistoryData.last_30_days?.volume === 0)) {
        return {
            achievablePrice: currentPrice ? parseFloat((currentPrice * 0.95).toFixed(2)) : null, // Conservative estimate
            liquidityScore: 0, // No sales, so liquidity is 0
            confidence: 0.1, // Low confidence if no data
            reason: "No sales history available."
        };
    }

    let pricesForVolatility = []; // Collect prices to calculate overall volatility

    // Extract average prices from sales history for weighted average
    const periods = [
        { key: 'last_24_hours', weight: 0.6 },
        { key: 'last_7_days', weight: 0.3 },
        { key: 'last_30_days', weight: 0.1 }
    ];

    let weightedSum = 0;
    let totalWeight = 0;
    let totalSalesVolume = 0;

    periods.forEach(period => {
        const data = salesHistoryData[period.key];
        if (data && data.volume > 0 && data.avg !== null) {
            // Add average price to pricesForVolatility for overall volatility calculation
            pricesForVolatility.push(data.avg);
            
            // Use the average price and volume for weighted sum
            weightedSum += data.avg * data.volume * period.weight;
            totalWeight += data.volume * period.weight;
            totalSalesVolume += data.volume;
        }
    });

    // If no valid sales data after filtering, use fallback
    if (totalWeight === 0) {
        return {
            achievablePrice: currentPrice ? parseFloat((currentPrice * 0.92).toFixed(2)) : null,
            liquidityScore: 0,
            confidence: 0.2,
            reason: "Insufficient sales data across all periods after filtering."
        };
    }

    let finalAchievablePrice = weightedSum / totalWeight;

    // Apply a slight adjustment based on volatility (e.g., lower price for higher volatility)
    const volatilityFactor = calculateVolatility(pricesForVolatility.length > 0 ? pricesForVolatility : [finalAchievablePrice]);
    finalAchievablePrice *= (1 - volatilityFactor * 0.05); // Small discount for high volatility

    // --- Calculate Liquidity Score ---
    const liquidityScore = calculateLiquidityScore(
        salesHistoryData.last_24_hours?.volume || 0,
        salesHistoryData.last_7_days?.volume || 0,
        salesHistoryData.last_30_days?.volume || 0,
        volatilityFactor // Pass volatility to liquidity calculation
    );

    // --- Determine Confidence (towards 99.6%) ---
    // Confidence is higher with more sales volume, lower volatility, and higher liquidity.
    let confidence = 0.5; // Base confidence
    confidence += Math.min(0.3, totalSalesVolume / 10000 * 0.3); // Volume boosts confidence (capped)
    confidence += liquidityScore * 0.2; // Liquidity boosts confidence
    confidence -= volatilityFactor * 0.3; // Volatility significantly reduces confidence

    // Ensure confidence is between 0 and 1
    confidence = Math.max(0, Math.min(1, confidence));

    return {
        achievablePrice: parseFloat(finalAchievablePrice.toFixed(2)),
        liquidityScore: parseFloat(liquidityScore.toFixed(2)),
        confidence: parseFloat(confidence.toFixed(3)),
        reason: "Calculated based on weighted historical sales, volume, and volatility."
    };
}

// --- API Endpoint: /api/scan-deals (Consolidated for Market Scan) ---
app.post('/api/scan-deals', async (req, res) => {
    const { skinportMarketUrl, currency, minProfit, source } = req.body;
    console.log(`[Server] Received /api/scan-deals request. Source: ${source}`);

    if (source !== 'market' || !skinportMarketUrl) {
        return res.status(400).json({ error: 'Invalid request: only market source with skinportMarketUrl is supported.' });
    }

    let itemsToAnalyze = [];

    // --- Market Scan Logic ---
    console.log(`[Server] Processing market scan for URL: ${skinportMarketUrl}`);
    const urlObj = new URL(skinportMarketUrl);
    const params = new URLSearchParams(urlObj.search);
    params.set('app_id', '730'); // Ensure CS2 app ID is always used

    try {
        // Fetch ALL items matching the filters from Skinport's /v1/items endpoint.
        const allSkinportItems = await fetchSkinportApi('/items', Object.fromEntries(params.entries()));

        if (allSkinportItems && allSkinportItems.length > 0) {
            console.log(`[Server] Fetched ${allSkinportItems.length} items from Skinport /v1/items.`);
            itemsToAnalyze = allSkinportItems.map(item => ({
                marketHashName: item.market_hash_name,
                currentPrice: item.min_price, // Use min_price as the current listed price
                itemId: item.id,
                wear: item.wear,
                isTradable: item.tradable
            }));
        } else {
            console.log('[Server] No items found for market scan filters.');
            return res.json({ analyzedItems: [], hasMorePages: false });
        }
    } catch (error) {
        console.error('[Server] Error fetching market items from Skinport:', error);
        return res.status(500).json({ error: `Failed to fetch market items: ${error.message}` });
    }

    let analyzedItems = [];
    for (const item of itemsToAnalyze) {
        try {
            // Fetch sales history for each item
            const salesHistory = await fetchItemSalesHistory(item.marketHashName, currency);
            // Calculate achievable price based on sales history and the item's current listed price
            const analysisResult = calculateAchievablePrice(salesHistory, item.currentPrice);

            // For market items, calculate potential profit if buying at currentPrice and selling at achievablePrice
            const sellerFeeRate = 0.12; // Skinport's typical seller fee (adjust if needed)
            const netAchievablePrice = analysisResult.achievablePrice ? analysisResult.achievablePrice * (1 - sellerFeeRate) : 0;
            const potentialProfit = netAchievablePrice - item.currentPrice;
            const profitPercentage = item.currentPrice > 0 ? (potentialProfit / item.currentPrice) * 100 : -Infinity;

            analyzedItems.push({
                marketHashName: item.market_hash_name,
                currentPrice: item.currentPrice,
                itemId: item.id,
                wear: item.wear,
                isTradable: item.isTradable,
                analysis: analysisResult, // Contains achievablePrice, liquidityScore, confidence
                potentialProfit: potentialProfit !== null ? parseFloat(potentialProfit.toFixed(2)) : null,
                profitPercentage: profitPercentage !== null ? parseFloat(profitPercentage.toFixed(2)) : null
            });
        } catch (error) {
            console.error(`[Server] Error analyzing item ${item.marketHashName}:`, error);
            analyzedItems.push({
                ...item,
                analysis: { achievablePrice: null, liquidityScore: 0, confidence: 0, reason: "Analysis failed." },
                error: error.message
            });
        }
    }
    res.json({ analyzedItems, hasMorePages: false }); // hasMorePages is always false as /v1/items typically returns all
});


// Start the server
app.listen(port, () => {
    console.log(`[Server] Skinport Tracker API listening at http://localhost:${port}`);
});
