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
 * Assesses item liquidity based on sales frequency
 */
function assessLiquidity(apiData) {
    const sales7d = apiData.last_7_days?.volume || 0;
    const sales30d = apiData.last_30_days?.volume || 0;
    const sales90d = apiData.last_90_days?.volume || 0;
    
    let liquidityRating;
    let sellTimeEstimate;
    
    // MORE CONSERVATIVE LIQUIDITY THRESHOLDS
    if (sales7d >= 100) {
        liquidityRating = 'EXCELLENT';
        sellTimeEstimate = 'Few hours to 1 day';
    } else if (sales7d >= 50) {
        liquidityRating = 'VERY_GOOD';
        sellTimeEstimate = '1-2 days';
    } else if (sales7d >= 25) {
        liquidityRating = 'GOOD';
        sellTimeEstimate = '2-4 days';
    } else if (sales7d >= 10) {
        liquidityRating = 'MODERATE';
        sellTimeEstimate = '1-2 weeks';
    } else if (sales7d >= 5) {
        liquidityRating = 'POOR';
        sellTimeEstimate = '2-4 weeks';
    } else {
        liquidityRating = 'TERRIBLE';
        sellTimeEstimate = '1+ months';
    }
    
    // Calculate liquidity score with higher thresholds
    let score = 0;
    
    // Primary score from 7-day sales (higher thresholds)
    if (sales7d >= 100) score += 70;
    else if (sales7d >= 50) score += 55;
    else if (sales7d >= 25) score += 40;
    else if (sales7d >= 10) score += 25;
    else if (sales7d >= 5) score += 10;
    else score += 0; // No score for terrible liquidity
    
    // Consistency bonus (more strict)
    if (sales30d > 0) {
        const consistency = (sales7d * 4.3) / sales30d;
        if (consistency >= 0.9 && consistency <= 1.1) score += 25;
        else if (consistency > 1.1) score += 20;
        else score += 5;
    }
    
    // Volume bonus (higher thresholds)
    if (sales90d >= 1000) score += 25;
    else if (sales90d >= 500) score += 20;
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
        sellTimeEstimate
    };
}

/**
 * Analyzes market competition and supply/demand dynamics
 */
function analyzeMarketCompetition(apiData) {
    const day7 = apiData.last_7_days;
    const day30 = apiData.last_30_days;
    
    if (!day7 || !day30) return null;
    
    // Calculate supply vs demand metrics
    const avgPrice7d = day7.median || 0;
    const avgPrice30d = day30.median || 0;
    const volume7d = day7.volume || 0;
    const volume30d = day30.volume || 0;
    
    // Price momentum (recent vs longer term)
    const priceMomentum = avgPrice7d > 0 && avgPrice30d > 0 ? 
        ((avgPrice7d - avgPrice30d) / avgPrice30d) * 100 : 0;
    
    // Volume momentum
    const volumeMomentum = volume30d > 0 ? 
        ((volume7d * 4.3) - volume30d) / volume30d * 100 : 0;
    
    // Market saturation (high volume + falling prices = oversupply)
    let marketCondition = 'BALANCED';
    let competitionMultiplier = 1.0;
    
    if (priceMomentum < -10 && volumeMomentum > 20) {
        marketCondition = 'OVERSATURATED';
        competitionMultiplier = 0.95; // 5% discount for oversupply
    } else if (priceMomentum > 10 && volumeMomentum < -20) {
        marketCondition = 'UNDERSUPPLIED';
        competitionMultiplier = 1.03; // 3% premium for undersupply
    } else if (priceMomentum < -5 && volumeMomentum > 10) {
        marketCondition = 'WEAK_DEMAND';
        competitionMultiplier = 0.97; // 3% discount
    } else if (priceMomentum > 5 && volumeMomentum < -10) {
        marketCondition = 'STRONG_DEMAND';
        competitionMultiplier = 1.02; // 2% premium
    }
    
    return {
        priceMomentum: parseFloat(priceMomentum.toFixed(2)),
        volumeMomentum: parseFloat(volumeMomentum.toFixed(2)),
        marketCondition,
        competitionMultiplier,
        avgPrice7d,
        avgPrice30d,
        volume7d,
        volume30d
    };
}

/**
 * Comprehensive item analysis with realistic profit calculations
 */
function analyzeItemOpportunity(currentPrice, apiData, minProfit, minProfitMargin) {
    const trends = analyzePriceTrends(apiData);
    const liquidity = assessLiquidity(apiData);
    
    if (!trends || !trends.mostRecentPrice) {
        return null; // Skip items with insufficient data
    }
    
    // ENHANCED PRICE PREDICTION WITH MARKET SLIPPAGE
    let predictedSellingPrice = trends.mostRecentPrice;
    
    // Market slippage based on liquidity (worse liquidity = more slippage)
    let slippageMultiplier = 1.0;
    if (liquidity.rating === 'EXCELLENT') slippageMultiplier = 0.98; // 2% slippage
    else if (liquidity.rating === 'VERY_GOOD') slippageMultiplier = 0.96; // 4% slippage
    else if (liquidity.rating === 'GOOD') slippageMultiplier = 0.94; // 6% slippage
    else if (liquidity.rating === 'MODERATE') slippageMultiplier = 0.90; // 10% slippage
    else if (liquidity.rating === 'POOR') slippageMultiplier = 0.85; // 15% slippage
    else slippageMultiplier = 0.75; // 25% slippage for terrible
    
    predictedSellingPrice *= slippageMultiplier;
    
    // Trend adjustments (more conservative)
    if (trends.trend === 'rising' && trends.confidence > 70) {
        predictedSellingPrice *= 1.02; // Only 2% optimism for very strong rising trend
    } else if (trends.trend === 'falling' && trends.confidence > 70) {
        predictedSellingPrice *= 0.95; // 5% pessimism for strong falling trend
    }
    
    // Additional market condition adjustments
    const volatility7d = apiData.last_7_days ? 
        ((apiData.last_7_days.max - apiData.last_7_days.min) / apiData.last_7_days.median) * 100 : 0;
    
    // High volatility = more conservative pricing
    if (volatility7d > 50) {
        predictedSellingPrice *= 0.97; // 3% additional discount for high volatility
    }
    
    // Market competition analysis
    const competition = analyzeMarketCompetition(apiData);
    if (competition) {
        predictedSellingPrice *= competition.competitionMultiplier;
    }
    
    // Calculate realistic profits after fees
    const netSellingPrice = predictedSellingPrice * (1 - SKINPORT_FEE);
    const profit = netSellingPrice - currentPrice;
    const profitMargin = (profit / currentPrice) * 100;
    
    // ENHANCED RISK ASSESSMENT
    let riskScore = 30; // Lower base risk
    
    // Volatility risk (more weight)
    if (volatility7d > 100) riskScore += 35;
    else if (volatility7d > 50) riskScore += 25;
    else if (volatility7d > 20) riskScore += 15;
    else if (volatility7d > 10) riskScore += 5;
    
    // Liquidity risk (more weight)
    if (liquidity.rating === 'EXCELLENT') riskScore -= 20;
    else if (liquidity.rating === 'VERY_GOOD') riskScore -= 15;
    else if (liquidity.rating === 'GOOD') riskScore -= 5;
    else if (liquidity.rating === 'MODERATE') riskScore += 10;
    else if (liquidity.rating === 'POOR') riskScore += 25;
    else if (liquidity.rating === 'TERRIBLE') riskScore += 40;
    
    // Trend risk
    if (trends.trend === 'falling' && trends.confidence > 60) riskScore += 25;
    else if (trends.trend === 'rising' && trends.confidence > 60) riskScore -= 10;
    
    // Profit margin risk (more conservative)
    if (profitMargin > 50) riskScore += 35; // Very suspicious
    else if (profitMargin > 30) riskScore += 25;
    else if (profitMargin > 20) riskScore += 15;
    else if (profitMargin < 5) riskScore += 15; // Too low margin
    
    // Market depth risk
    if (liquidity.sales7d < 10) riskScore += 20;
    if (liquidity.sales30d < 50) riskScore += 15;
    
    riskScore = Math.max(5, Math.min(95, riskScore));
    
    // Determine risk level
    let riskLevel;
    if (riskScore <= 25) riskLevel = 'LOW';
    else if (riskScore <= 45) riskLevel = 'MEDIUM';
    else if (riskScore <= 65) riskLevel = 'HIGH';
    else riskLevel = 'VERY_HIGH';
    
    // ENHANCED RECOMMENDATION LOGIC
    let recommendation;
    if (profit <= 0) recommendation = 'AVOID - No profit';
    else if (riskScore > 75) recommendation = 'AVOID - Too risky';
    else if (liquidity.rating === 'TERRIBLE' || liquidity.rating === 'POOR') recommendation = 'AVOID - Poor liquidity';
    else if (profitMargin >= 25 && liquidity.score >= 70 && riskScore <= 25) recommendation = 'STRONG BUY';
    else if (profitMargin >= 18 && liquidity.score >= 60 && riskScore <= 35) recommendation = 'BUY';
    else if (profitMargin >= 12 && liquidity.score >= 45 && riskScore <= 45) recommendation = 'CONSIDER';
    else if (profitMargin >= 8 && liquidity.score >= 30 && riskScore <= 55) recommendation = 'WEAK BUY';
    else recommendation = 'AVOID - Unfavorable risk/reward';
    
    // Apply user filters
    if (profit < minProfit || profitMargin < minProfitMargin) {
        return null; // Doesn't meet user criteria
    }
    
    // ENHANCED LIQUIDITY FILTER - Skip items with terrible liquidity
    if (liquidity.rating === 'TERRIBLE' || liquidity.rating === 'POOR') {
        return null; // Skip items with poor liquidity
    }
    
    // Minimum sales volume filter
    if (liquidity.sales7d < 5) {
        return null; // Skip items with very low sales volume
    }
    
    return {
        currentPrice,
        predictedSellingPrice: parseFloat(predictedSellingPrice.toFixed(2)),
        netSellingPrice: parseFloat(netSellingPrice.toFixed(2)),
        profit: parseFloat(profit.toFixed(2)),
        profitMargin: parseFloat(profitMargin.toFixed(2)),
        trends,
        liquidity,
        riskScore,
        riskLevel,
        recommendation,
        volatility7d: parseFloat(volatility7d.toFixed(2)),
        slippageApplied: parseFloat(((1 - slippageMultiplier) * 100).toFixed(1)) + '%',
        competition: competition || null
    };
}

/**
 * UPDATED MAIN ANALYSIS FUNCTION
 */
async function analyzePrices(items, minProfit, minProfitMargin, currency) {
    const analyzedItems = [];
    const uniqueItems = [...new Set(items.map(item => item.marketHashName))];
    
    console.log(`[Analysis] Processing ${uniqueItems.length} unique items with ENHANCED PROFITABILITY analysis...`);
    
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
    
    console.log(`[Analysis] Found ${analyzedItems.length} profitable deals using ENHANCED PROFITABILITY analysis`);
    if (analyzedItems.length > 0) {
        console.log(`[Analysis] Top deal: ${analyzedItems[0].profitMargin.toFixed(2)}% margin (${analyzedItems[0].recommendation})`);
        console.log(`[Analysis] Liquidity filter applied: ${analyzedItems.length} items passed liquidity requirements`);
    }
    
    return analyzedItems;
}

// API endpoint to receive prices and return deals
app.post('/analyze-prices', async (req, res) => {
    const { items, settings } = req.body;
    if (!items || !Array.isArray(items) || !settings) {
        return res.status(400).json({ error: 'Invalid input. Expected an array of items and settings.' });
    }

    console.log(`[Backend] Received ${items.length} items for ENHANCED PROFITABILITY analysis.`);

    try {
        const analyzedItems = await analyzePrices(items, settings.minProfit, settings.minProfitMargin, settings.currency);
        res.json({ 
            analyzedItems,
            summary: {
                totalProcessed: items.length,
                profitableFound: analyzedItems.length,
                analysisType: 'ENHANCED_PROFITABILITY',
                includedFactors: [
                    'price_trends', 
                    'liquidity_assessment', 
                    'market_slippage', 
                    'volatility_analysis', 
                    'competition_analysis',
                    'risk_assessment',
                    '8%_fee_calculation'
                ],
                filters: {
                    'min_liquidity': 'GOOD or better',
                    'min_sales_volume': '5+ sales/week',
                    'risk_threshold': '75 or lower'
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
    console.log(`Enhanced Profitability Skinport Tracker API listening on port ${port}`);
    console.log(`Features: Market slippage, competition analysis, strict liquidity filtering`);
    console.log(`8% fee calculation, volatility assessment, and risk-based recommendations`);
});