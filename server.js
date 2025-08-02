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
const SKINPORT_FEE = 0.08; // 8% seller fee

// IMPROVED: More conservative liquidity thresholds for profitable trading
const MIN_SALES_7D_FOR_CONSIDERATION = 5; // Minimum 5 sales in 7 days
const MIN_LIQUIDITY_SCORE_FOR_RECOMMENDATION = 30; // Minimum liquidity score
const MAX_ACCEPTABLE_VOLATILITY = 80; // Maximum 80% volatility for recommendations
const CONSERVATIVE_PRICE_FACTOR = 0.98; // Apply 2% conservative factor to predicted prices

// Rate limiting configuration - Skinport allows 8 requests per 5 minutes
const RATE_LIMIT_WINDOW = 5 * 60 * 1000; // 5 minutes in milliseconds
const MAX_REQUESTS_PER_WINDOW = 7; // Use 7 to be safe
const requestQueue = []; // Queue to store timestamps of requests

// Middleware
app.use(cors());
app.use(express.json());

/**
 * Delays execution for a given number of milliseconds.
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Rate limiter that respects Skinport's 8 requests per 5 minutes limit.
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
        const timeToWait = (oldestRequestTime + RATE_LIMIT_WINDOW) - now + 1000; // +1s buffer
        if (timeToWait > 0) {
            console.log(`[Rate Limiter] Waiting ${Math.round(timeToWait/1000)}s for the next available slot.`);
            await delay(timeToWait);
        }
    }
    // Add the new request timestamp to the queue
    requestQueue.push(Date.now());
}

/**
 * Creates optimal batches based on URL length limits
 */
function createOptimalBatches(uniqueItems, maxUrlLength = 7000) {
    const batches = [];
    let currentBatch = [];
    let currentUrlLength = SKINPORT_API_URL.length + 100; // Base URL + params overhead
    
    for (const item of uniqueItems) {
        const itemLength = encodeURIComponent(item).length + 1; // +1 for comma
        
        // If adding this item would exceed URL limit or we hit reasonable batch size
        if (currentUrlLength + itemLength > maxUrlLength || currentBatch.length >= 100) {
            if (currentBatch.length > 0) {
                batches.push([...currentBatch]);
                currentBatch = [];
                currentUrlLength = SKINPORT_API_URL.length + 100;
            }
        }
        
        currentBatch.push(item);
        currentUrlLength += itemLength;
    }
    
    // Add remaining items
    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }
    
    return batches;
}

/**
 * Fetches sales history for multiple items in a single API call
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
 * ADVANCED ANALYSIS FUNCTIONS
 */

/**
 * Analyzes price trends using median prices (more accurate than averages)
 */
function analyzePriceTrends(apiData) {
    const periods = {
        day1: apiData.last_24_hours,
        day7: apiData.last_7_days,
        day30: apiData.last_30_days,
        day90: apiData.last_90_days
    };
    
    // IMPROVED: Data quality check - need at least 7-day data for reliable analysis
    if (!periods.day7 || !periods.day7.median || periods.day7.volume < 3) {
        return null; // Insufficient data quality
    }
    
    // Use MEDIAN prices for more accurate trend analysis (filters outliers)
    const prices = [];
    const timeframes = [];
    
    if (periods.day1?.median) {
        prices.push(periods.day1.median);
        timeframes.push('24h');
    }
    if (periods.day7?.median) {
        prices.push(periods.day7.median);
        timeframes.push('7d');
    }
    if (periods.day30?.median) {
        prices.push(periods.day30.median);
        timeframes.push('30d');
    }
    if (periods.day90?.median) {
        prices.push(periods.day90.median);
        timeframes.push('90d');
    }
    
    if (prices.length === 0) return null;
    
    // Calculate trend
    let trend = 'stable';
    let trendStrength = 0;
    
    if (prices.length >= 2) {
        const recentPrice = prices[0]; // Most recent (24h or 7d)
        const longerTermPrice = prices[Math.min(2, prices.length - 1)]; // 30d if available
        const change = ((recentPrice - longerTermPrice) / longerTermPrice) * 100;
        
        trendStrength = Math.abs(change);
        
        if (change > 5) trend = 'rising';
        else if (change < -5) trend = 'falling';
        else trend = 'stable';
    }
    
    // Calculate confidence based on data availability and volume
    let confidence = 0;
    confidence += prices.length * 20; // 20 per timeframe
    
    if (periods.day7?.volume > 20) confidence += 20;
    else if (periods.day7?.volume > 10) confidence += 15;
    else if (periods.day7?.volume > 5) confidence += 10;
    
    if (periods.day30?.volume > 50) confidence += 15;
    if (periods.day1?.volume > 5) confidence += 15;
    
    confidence = Math.min(confidence, 100);
    
    return {
        prices: prices.map((p, i) => ({ period: timeframes[i], price: p })),
        trend,
        trendStrength: parseFloat(trendStrength.toFixed(2)),
        mostRecentPrice: prices[0],
        confidence
    };
}

/**
 * Assesses item liquidity based on sales frequency - IMPROVED for better filtering
 */
function assessLiquidity(apiData) {
    const sales7d = apiData.last_7_days?.volume || 0;
    const sales30d = apiData.last_30_days?.volume || 0;
    const sales90d = apiData.last_90_days?.volume || 0;
    
    // EARLY FILTER: Immediately flag items that don't meet minimum requirements
    const meetsMinimumRequirements = sales7d >= MIN_SALES_7D_FOR_CONSIDERATION;
    
    let liquidityRating;
    let sellTimeEstimate;
    
    if (sales7d >= 50) {
        liquidityRating = 'EXCELLENT';
        sellTimeEstimate = 'Few hours to 1 day';
    } else if (sales7d >= 20) {
        liquidityRating = 'VERY_GOOD';
        sellTimeEstimate = '1-2 days';
    } else if (sales7d >= 10) {
        liquidityRating = 'GOOD';
        sellTimeEstimate = '2-4 days';
    } else if (sales7d >= 5) {
        liquidityRating = 'MODERATE';
        sellTimeEstimate = '1-2 weeks';
    } else if (sales7d >= 2) {
        liquidityRating = 'POOR';
        sellTimeEstimate = '2-4 weeks';
    } else {
        liquidityRating = 'TERRIBLE';
        sellTimeEstimate = '1+ months';
    }
    
    // Calculate liquidity score
    let score = 0;
    
    // Primary score from 7-day sales
    if (sales7d >= 50) score += 60;
    else if (sales7d >= 20) score += 45;
    else if (sales7d >= 10) score += 30;
    else if (sales7d >= 5) score += 15;
    else if (sales7d >= 2) score += 5;
    
    // Consistency bonus
    if (sales30d > 0) {
        const consistency = (sales7d * 4.3) / sales30d;
        if (consistency >= 0.8 && consistency <= 1.2) score += 20;
        else if (consistency > 1.2) score += 15;
        else score += 5;
    }
    
    // Volume bonus
    if (sales90d >= 500) score += 20;
    else if (sales90d >= 200) score += 15;
    else if (sales90d >= 100) score += 10;
    else if (sales90d >= 50) score += 5;
    
    score = Math.min(Math.round(score), 100);
    
    return {
        rating: liquidityRating,
        score,
        sales7d,
        sales30d,
        sales90d,
        dailyAvg7d: parseFloat((sales7d / 7).toFixed(2)),
        sellTimeEstimate,
        meetsMinimumRequirements // ADDED: Flag for early filtering
    };
}

/**
 * Comprehensive item analysis with realistic profit calculations - IMPROVED
 */
function analyzeItemOpportunity(currentPrice, apiData, minProfit, minProfitMargin) {
    const trends = analyzePriceTrends(apiData);
    const liquidity = assessLiquidity(apiData);
    
    if (!trends || !trends.mostRecentPrice) {
        return null; // Skip items with insufficient data
    }
    
    // EARLY FILTER: Skip items that don't meet liquidity requirements
    if (!liquidity.meetsMinimumRequirements) {
        console.log(`[FILTER] Skipping item due to insufficient liquidity: ${liquidity.sales7d} sales in 7 days`);
        return null;
    }
    
    // EARLY FILTER: Skip items with terrible liquidity rating
    if (liquidity.rating === 'TERRIBLE') {
        console.log(`[FILTER] Skipping item with TERRIBLE liquidity rating`);
        return null;
    }
    
    // Predict realistic selling price based on trends and market conditions
    let predictedSellingPrice = trends.mostRecentPrice;
    
    // Trend adjustments
    if (trends.trend === 'rising' && trends.confidence > 60) {
        predictedSellingPrice *= 1.03; // 3% optimism for strong rising trend
    } else if (trends.trend === 'falling' && trends.confidence > 60) {
        predictedSellingPrice *= 0.97; // 3% pessimism for strong falling trend
    }
    
    // IMPROVED: More conservative liquidity and market adjustments
    if (liquidity.rating === 'POOR') {
        predictedSellingPrice *= 0.92; // 8% discount for poor liquidity
    } else if (liquidity.rating === 'MODERATE') {
        predictedSellingPrice *= 0.96; // 4% discount for moderate liquidity
    }
    
    // Apply conservative factor for more realistic predictions
    predictedSellingPrice *= CONSERVATIVE_PRICE_FACTOR;
    
    // Calculate realistic profits after fees (IMPROVED: More precise)
    const grossSellingPrice = predictedSellingPrice;
    const skinportFee = grossSellingPrice * SKINPORT_FEE;
    const netSellingPrice = grossSellingPrice - skinportFee;
    const profit = netSellingPrice - currentPrice;
    const profitMargin = (profit / currentPrice) * 100;
    
    // Risk assessment
    let riskScore = 40; // Base risk
    
    // IMPROVED: Volatility risk with early filtering
    const volatility7d = apiData.last_7_days ? 
        ((apiData.last_7_days.max - apiData.last_7_days.min) / apiData.last_7_days.median) * 100 : 0;
    
    // EARLY FILTER: Skip extremely volatile items
    if (volatility7d > MAX_ACCEPTABLE_VOLATILITY) {
        console.log(`[FILTER] Skipping item due to high volatility: ${volatility7d.toFixed(2)}%`);
        return null;
    }
    
    if (volatility7d > 60) riskScore += 25;
    else if (volatility7d > 40) riskScore += 15;
    else if (volatility7d > 20) riskScore += 5;
    
    // Liquidity risk
    if (liquidity.rating === 'EXCELLENT' || liquidity.rating === 'VERY_GOOD') riskScore -= 15;
    else if (liquidity.rating === 'POOR') riskScore += 15;
    else if (liquidity.rating === 'TERRIBLE') riskScore += 30;
    
    // Trend risk
    if (trends.trend === 'falling' && trends.confidence > 60) riskScore += 20;
    else if (trends.trend === 'rising' && trends.confidence > 60) riskScore -= 10;
    
    // Profit margin risk
    if (profitMargin > 100) riskScore += 30; // Suspiciously high
    else if (profitMargin > 50) riskScore += 15;
    else if (profitMargin < 3) riskScore += 10;
    
    riskScore = Math.max(5, Math.min(95, riskScore));
    
    // Determine risk level
    let riskLevel;
    if (riskScore <= 20) riskLevel = 'LOW';
    else if (riskScore <= 40) riskLevel = 'MEDIUM';
    else if (riskScore <= 60) riskLevel = 'HIGH';
    else riskLevel = 'VERY_HIGH';
    
    // IMPROVED: More conservative recommendation system
    let recommendation;
    if (profit <= 0) recommendation = 'AVOID - No profit';
    else if (riskScore > 70) recommendation = 'AVOID - Too risky';
    else if (liquidity.score < MIN_LIQUIDITY_SCORE_FOR_RECOMMENDATION) recommendation = 'AVOID - Poor liquidity';
    else if (profitMargin > 80) recommendation = 'AVOID - Suspiciously high margin';
    else if (profitMargin >= 25 && liquidity.score >= 60 && riskScore <= 25) recommendation = 'STRONG BUY';
    else if (profitMargin >= 18 && liquidity.score >= 45 && riskScore <= 35) recommendation = 'BUY';
    else if (profitMargin >= 12 && liquidity.score >= 35 && riskScore <= 45) recommendation = 'CONSIDER';
    else if (profitMargin >= 8 && liquidity.score >= 25 && riskScore <= 55) recommendation = 'WEAK BUY';
    else recommendation = 'AVOID - Unfavorable risk/reward';
    
    // Apply user filters
    if (profit < minProfit || profitMargin < minProfitMargin) {
        return null; // Doesn't meet user criteria
    }
    
    return {
        currentPrice,
        predictedSellingPrice: parseFloat(predictedSellingPrice.toFixed(2)),
        grossSellingPrice: parseFloat(grossSellingPrice.toFixed(2)), // ADDED: Show gross before fees
        skinportFee: parseFloat(skinportFee.toFixed(2)), // ADDED: Show exact fee amount
        netSellingPrice: parseFloat(netSellingPrice.toFixed(2)),
        profit: parseFloat(profit.toFixed(2)),
        profitMargin: parseFloat(profitMargin.toFixed(2)),
        trends,
        liquidity,
        riskScore,
        riskLevel,
        recommendation,
        volatility7d: parseFloat(volatility7d.toFixed(2))
    };
}

/**
 * UPDATED MAIN ANALYSIS FUNCTION
 */
async function analyzePrices(items, minProfit, minProfitMargin, currency) {
    const analyzedItems = [];
    const uniqueItems = [...new Set(items.map(item => item.marketHashName))];
    
    console.log(`[Analysis] Processing ${uniqueItems.length} unique items with IMPROVED PROFITABLE analysis...`);
    
    // Create optimal batches
    const batches = createOptimalBatches(uniqueItems);
    
    if (batches.length > MAX_REQUESTS_PER_WINDOW) {
        console.warn(`[Analysis] Warning: ${batches.length} batches exceed rate limit of ${MAX_REQUESTS_PER_WINDOW} requests per 5 minutes`);
        console.warn(`[Analysis] Processing first ${MAX_REQUESTS_PER_WINDOW} batches only`);
    }
    
    const batchesToProcess = batches.slice(0, MAX_REQUESTS_PER_WINDOW);
    
    for (let i = 0; i < batchesToProcess.length; i++) {
        const batch = batchesToProcess[i];
        console.log(`[Analysis] Processing batch ${i + 1}/${batchesToProcess.length} (${batch.length} items)`);
        
        const batchSalesHistory = await fetchSalesHistoryBatch(batch, currency);
        
        // Process each item in the batch
        for (const marketHashName of batch) {
            const apiData = batchSalesHistory[marketHashName];
            
            if (apiData) {
                const marketItems = items.filter(item => item.marketHashName === marketHashName);
                
                for (const { price, wear } of marketItems) {
                    const analysis = analyzeItemOpportunity(price, apiData, minProfit, minProfitMargin);
                    
                    if (analysis) {
                        analyzedItems.push({
                            marketHashName,
                            wear,
                            ...analysis
                        });
                    }
                }
            }
        }
    }
    
    // Sort by profit margin descending
    analyzedItems.sort((a, b) => b.profitMargin - a.profitMargin);
    
    console.log(`[Analysis] Found ${analyzedItems.length} HIGH-QUALITY profitable deals with strict filtering`);
    if (analyzedItems.length > 0) {
        console.log(`[Analysis] Top deal: ${analyzedItems[0].profitMargin.toFixed(2)}% margin (${analyzedItems[0].recommendation})`);
        console.log(`[Analysis] Filtered out items with: terrible liquidity, high volatility (>${MAX_ACCEPTABLE_VOLATILITY}%), insufficient data`);
    }
    
    return analyzedItems;
}

// API endpoint to receive prices and return deals
app.post('/analyze-prices', async (req, res) => {
    const { items, settings } = req.body;
    if (!items || !Array.isArray(items) || !settings) {
        return res.status(400).json({ error: 'Invalid input. Expected an array of items and settings.' });
    }

    console.log(`[Backend] Received ${items.length} items for ADVANCED analysis.`);

    try {
        const analyzedItems = await analyzePrices(items, settings.minProfit, settings.minProfitMargin, settings.currency);
        res.json({ 
            analyzedItems,
            summary: {
                totalProcessed: items.length,
                profitableFound: analyzedItems.length,
                analysisType: 'IMPROVED_PROFITABLE',
                includedFactors: ['price_trends', 'liquidity', 'volatility', 'risk_assessment', 'data_quality_filtering'],
                appliedFilters: {
                    minSales7d: MIN_SALES_7D_FOR_CONSIDERATION,
                    minLiquidityScore: MIN_LIQUIDITY_SCORE_FOR_RECOMMENDATION,
                    maxVolatility: MAX_ACCEPTABLE_VOLATILITY,
                    conservativeFactor: CONSERVATIVE_PRICE_FACTOR,
                    skinportFee: SKINPORT_FEE
                }
            }
        });
    } catch (error) {
        console.error(`[Backend] Failed to analyze prices: ${error}`);
        res.status(500).json({ error: 'Failed to process items.' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        rateLimit: {
            requestsInQueue: requestQueue.length,
            maxRequests: MAX_REQUESTS_PER_WINDOW,
            windowMinutes: 5
        }
    });
});

// Start Express server
app.listen(port, () => {
    console.log(`Advanced Skinport Tracker API listening on port ${port}`);
    console.log(`Using MEDIAN prices and comprehensive risk analysis`);
});