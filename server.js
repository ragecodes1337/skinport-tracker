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
const MINIMUM_PROFIT_THRESHOLD = 0.20; // Minimum €0.20 profit (lowered from €0.50 for more opportunities)

// Rate limiting configuration - Skinport allows 8 requests per 5 minutes
const RATE_LIMIT_WINDOW = 5 * 60 * 1000; // 5 minutes in milliseconds
const MAX_REQUESTS_PER_WINDOW = 7; // Use 7 to be safe (was 5, now closer to the 8 limit)
const requestQueue = []; // Queue to store timestamps of requests

// Middleware
app.use(cors());
app.use(express.json());

/**
 * Normalize item names for consistent matching between server and content script
 */
function normalizeItemName(name) {
    if (!name) return null;
    
    return name.trim()
        // Normalize StatTrak symbol
        .replace(/StatTrak™?/g, 'StatTrak™')
        // Normalize knife star symbol
        .replace(/★/g, '★')
        // Normalize spaces
        .replace(/\s+/g, ' ')
        // Remove any trailing/leading spaces
        .trim();
}

/**
 * Multi-timeframe analysis to find the best data source and detect trends
 */
function analyzeMultiTimeframe(salesData) {
    const timeframes = [];
    
    // Check all available timeframes
    if (salesData.last_24_hours && salesData.last_24_hours.volume > 0) {
        timeframes.push({
            period: '24h',
            data: salesData.last_24_hours,
            weight: 4, // Most recent = highest weight
            recency: 1
        });
    }
    
    if (salesData.last_7_days && salesData.last_7_days.volume > 0) {
        timeframes.push({
            period: '7d',
            data: salesData.last_7_days,
            weight: 3,
            recency: 2
        });
    }
    
    if (salesData.last_30_days && salesData.last_30_days.volume > 0) {
        timeframes.push({
            period: '30d',
            data: salesData.last_30_days,
            weight: 2,
            recency: 3
        });
    }
    
    if (salesData.last_90_days && salesData.last_90_days.volume > 0) {
        timeframes.push({
            period: '90d',
            data: salesData.last_90_days,
            weight: 1, // Oldest = lowest weight
            recency: 4
        });
    }
    
    if (timeframes.length === 0) {
        return null;
    }
    
    // Select best timeframe based on volume and recency
    const bestTimeframe = timeframes.reduce((best, current) => {
        const currentScore = (current.data.volume * current.weight) + (current.data.volume >= 5 ? 10 : 0);
        const bestScore = (best.data.volume * best.weight) + (best.data.volume >= 5 ? 10 : 0);
        return currentScore > bestScore ? current : best;
    });
    
    // Detect price trend across timeframes
    let trend = 'STABLE';
    if (timeframes.length >= 2) {
        const recent = timeframes.find(t => t.recency === 1) || timeframes.find(t => t.recency === 2);
        const older = timeframes.find(t => t.recency === 3) || timeframes.find(t => t.recency === 4);
        
        if (recent && older) {
            const recentPrice = recent.data.avg;
            const olderPrice = older.data.avg;
            const priceChange = ((recentPrice - olderPrice) / olderPrice) * 100;
            
            if (priceChange > 10) trend = 'RISING';
            else if (priceChange < -10) trend = 'FALLING';
        }
    }
    
    return {
        bestTimeframe,
        allTimeframes: timeframes,
        trend,
        confidence: timeframes.length >= 2 ? 'HIGH' : timeframes.length === 1 ? 'MEDIUM' : 'LOW'
    };
}

/**
 * Smart achievable price calculation using actual sales data
 */
function calculateSmartAchievablePrice(buyPrice, marketData, multiTimeframeData, currentMinPrice) {
    if (!multiTimeframeData || !multiTimeframeData.bestTimeframe) {
        // Fallback to simple competitive pricing
        return {
            achievablePrice: currentMinPrice * 0.95,
            confidence: 'LOW',
            strategy: 'FALLBACK_COMPETITIVE',
            reasoning: 'Limited sales data, using competitive pricing'
        };
    }
    
    const salesData = multiTimeframeData.bestTimeframe.data;
    const trend = multiTimeframeData.trend;
    
    // Calculate various price points from sales data
    const salesMedian = salesData.median || salesData.avg;
    const salesAvg = salesData.avg;
    const salesMin = salesData.min;
    const salesMax = salesData.max;
    const salesVolume = salesData.volume;
    
    // Check if current listings are realistic compared to sales
    const listingVsSalesRatio = currentMinPrice / salesAvg;
    
    let basePrice;
    let strategy;
    let confidence;
    let reasoning;
    
    if (listingVsSalesRatio > 1.3) {
        // Current listings are 30%+ above average sales - use sales data
        basePrice = salesMedian;
        strategy = 'SALES_BASED';
        reasoning = 'Current listings overpriced vs actual sales';
    } else if (listingVsSalesRatio < 0.8) {
        // Current listings are 20%+ below average sales - use competitive pricing
        basePrice = currentMinPrice * 0.95;
        strategy = 'COMPETITIVE';
        reasoning = 'Current listings below typical sales price';
    } else {
        // Listings and sales are aligned - use hybrid approach
        basePrice = (salesMedian * 0.6) + (currentMinPrice * 0.95 * 0.4);
        strategy = 'HYBRID';
        reasoning = 'Balanced between sales data and current competition';
    }
    
    // Adjust for trend
    if (trend === 'RISING') {
        basePrice *= 1.05; // Price 5% higher in rising market
        reasoning += ', adjusted up for rising trend';
    } else if (trend === 'FALLING') {
        basePrice *= 0.95; // Price 5% lower in falling market
        reasoning += ', adjusted down for falling trend';
    }
    
    // Adjust for volume (confidence factor)
    if (salesVolume >= 20) {
        confidence = 'HIGH';
    } else if (salesVolume >= 10) {
        confidence = 'MEDIUM';
    } else if (salesVolume >= 3) {
        confidence = 'LOW';
        basePrice *= 0.97; // Price more conservatively with low volume
    } else {
        confidence = 'VERY_LOW';
        basePrice *= 0.94; // Price very conservatively with minimal volume
    }
    
    // Ensure we don't price below break-even
    const minProfitablePrice = buyPrice * 1.10; // Minimum 10% markup before fees
    if (basePrice < minProfitablePrice) {
        basePrice = minProfitablePrice;
        reasoning += ', adjusted to minimum profitable price';
    }
    
    // Ensure we don't price way above what actually sells
    if (basePrice > salesMax) {
        basePrice = salesMax * 0.95;
        reasoning += ', capped at max sales price';
    }
    
    return {
        achievablePrice: basePrice,
        confidence,
        strategy,
        reasoning,
        salesData: {
            median: salesMedian,
            avg: salesAvg,
            min: salesMin,
            max: salesMax,
            volume: salesVolume
        },
        marketContext: {
            listingVsSalesRatio: listingVsSalesRatio.toFixed(2),
            trend
        }
    };
}

/**
 * Simple 3-level confidence calculation
 */
function calculateOverallConfidence(marketData, multiTimeframeData, smartPricing, salesVolume, currentQuantity) {
    let score = 0;
    const factors = [];
    
    // Sales data quality (40% of confidence)
    if (salesVolume >= 20) {
        score += 40;
        factors.push('Excellent sales volume (20+)');
    } else if (salesVolume >= 10) {
        score += 32;
        factors.push('Good sales volume (10+)');
    } else if (salesVolume >= 5) {
        score += 24;
        factors.push('Moderate sales volume (5+)');
    } else if (salesVolume >= 2) {
        score += 16;
        factors.push('Low sales volume (2+)');
    } else {
        score += 8;
        factors.push('Very low sales volume');
    }
    
    // Market competition (30% of confidence)
    if (currentQuantity >= 5 && currentQuantity <= 20) {
        score += 30;
        factors.push('Healthy competition (5-20 listings)');
    } else if (currentQuantity >= 2 && currentQuantity <= 30) {
        score += 24;
        factors.push('Good competition (2-30 listings)');
    } else if (currentQuantity >= 1) {
        score += 18;
        factors.push('Limited competition');
    } else {
        score += 10;
        factors.push('No current competition');
    }
    
    // Pricing strategy confidence (30% of confidence)
    if (smartPricing.strategy === 'SALES_BASED' && smartPricing.confidence === 'HIGH') {
        score += 30;
        factors.push('High-confidence sales-based pricing');
    } else if (smartPricing.strategy === 'HYBRID' && smartPricing.confidence !== 'VERY_LOW') {
        score += 25;
        factors.push('Balanced pricing strategy');
    } else if (smartPricing.confidence !== 'VERY_LOW') {
        score += 20;
        factors.push('Reasonable pricing confidence');
    } else {
        score += 10;
        factors.push('Limited pricing confidence');
    }
    
    // Determine final confidence level
    let confidenceLevel;
    if (score >= 80) {
        confidenceLevel = 'HIGH';
    } else if (score >= 60) {
        confidenceLevel = 'MEDIUM';
    } else {
        confidenceLevel = 'LOW';
    }
    
    return {
        level: confidenceLevel,
        score: Math.round(score),
        factors
    };
}

// WEEKLY FLIP Trading Analysis - 3-7 Day Strategy for Best Accuracy & Sales
function analyzeWeeklyFlipViability(itemName, priceData, salesData, trend, stability) {
    const volume = priceData.volume;
    const avgPrice = priceData.avg;
    const maxPrice = priceData.max;
    const minPrice = priceData.min;
    const hasRecentActivity = salesData.last_7_days && salesData.last_7_days.volume > 0;
    
    let score = 0;
    let reasons = [];
    let recommendation = 'AVOID';
    
    // For weekly flips, we need good weekly volume (35% of score) - LOWERED THRESHOLDS
    const weeklyVolume = Math.max(volume / 4, salesData.last_7_days?.volume || 0); // Weekly estimate
    if (weeklyVolume >= 30) { // Lowered from 50
        score += 35;
        reasons.push('Excellent weekly volume (30+ sales) - reliable liquidity');
    } else if (weeklyVolume >= 15) { // Lowered from 25
        score += 30;
        reasons.push('Good weekly volume (15+ sales) - good liquidity');
    } else if (weeklyVolume >= 8) { // Lowered from 15
        score += 20;
        reasons.push('Moderate weekly volume (8+ sales) - decent liquidity');
    } else if (weeklyVolume >= 4) { // Lowered from 8
        score += 15; // Increased score for this tier
        reasons.push('Low weekly volume (4+ sales) - may take longer');
    } else if (weeklyVolume >= 2) { // New tier for very low volume
        score += 10;
        reasons.push('Very low weekly volume (2+ sales) - higher risk but possible');
    } else {
        score += 5; // Give some points even for minimal volume
        reasons.push('Minimal weekly volume (<2 sales) - HIGH RISK but not impossible');
    }
    
    // Price stability is important for 3-7 day holds (25% of score)
    const priceRange = maxPrice - minPrice;
    const priceStability = 100 - ((priceRange / avgPrice) * 100);
    if (priceStability >= 80) {
        score += 25;
        reasons.push('Very stable pricing (>80%) - low risk');
    } else if (priceStability >= 60) {
        score += 20;
        reasons.push('Stable pricing (60-80%) - manageable risk');
    } else if (priceStability >= 40) {
        score += 15;
        reasons.push('Somewhat stable pricing (40-60%)');
    } else if (priceStability >= 20) {
        score += 10;
        reasons.push('Unstable pricing (20-40%) - higher risk');
    } else {
        reasons.push('Very unstable pricing (<20%) - HIGH RISK');
    }
    
    // Market position - buying in bottom 30% is ideal (20% of score)
    const currentPos = (avgPrice - minPrice) / (maxPrice - minPrice || 1);
    if (currentPos <= 0.3) {
        score += 20;
        reasons.push('Excellent entry point (bottom 30% of range)');
    } else if (currentPos <= 0.5) {
        score += 15;
        reasons.push('Good entry point (below median)');
    } else if (currentPos <= 0.7) {
        score += 10;
        reasons.push('Fair entry point (above median)');
    } else {
        score += 5;
        reasons.push('Poor entry point (top 30% of range)');
    }
    
    // Recent activity check - should have sales within week (20% of score) - LOWERED THRESHOLDS
    if (hasRecentActivity) {
        const weeklyVol = salesData.last_7_days.volume;
        if (weeklyVol >= 15) { // Lowered from 20
            score += 20;
            reasons.push('High weekly activity (15+ sales this week)');
        } else if (weeklyVol >= 7) { // Lowered from 10
            score += 17; // Increased score
            reasons.push('Good weekly activity (7+ sales this week)');
        } else if (weeklyVol >= 3) { // Lowered from 5
            score += 15; // Increased score
            reasons.push('Moderate weekly activity (3+ sales this week)');
        } else if (weeklyVol >= 1) { // Lowered threshold
            score += 12; // Increased score
            reasons.push('Low weekly activity (1+ sales this week)');
        } else {
            score += 8; // Give some points even if no recent sales
            reasons.push('Minimal weekly activity but still trackable');
        }
    } else {
        score += 5; // Give some base points even without recent activity
        reasons.push('No recent weekly activity data - estimated from total volume');
    }
    
    // Determine recommendation for weekly flips - LOWERED THRESHOLDS
    if (score >= 65) { // Lowered from 80
        recommendation = 'WEEKLY_FLIP_EXCELLENT';
    } else if (score >= 45) { // Lowered from 65
        recommendation = 'WEEKLY_FLIP_GOOD';
    } else if (score >= 25) { // Lowered from 45
        recommendation = 'WEEKLY_FLIP_MODERATE';
    } else {
        recommendation = 'AVOID_WEEKLY_FLIP';
    }
    
    // Calculate weekly flip metrics - ADJUSTED THRESHOLDS
    let estimatedSellDays = '5-7'; // Default estimate
    let targetMarginPercentage = 10; // Realistic margins for weekly flips
    let sellProbability = 60;
    
    if (score >= 65) { // Lowered from 80
        estimatedSellDays = '1-3';
        targetMarginPercentage = 12;
        sellProbability = 90;
    } else if (score >= 45) { // Lowered from 65
        estimatedSellDays = '3-5';
        targetMarginPercentage = 10;
        sellProbability = 75;
    } else if (score >= 25) { // Lowered from 45
        estimatedSellDays = '5-7';
        targetMarginPercentage = 8;
        sellProbability = 60;
    } else {
        estimatedSellDays = '7+';
        targetMarginPercentage = 15;
        sellProbability = 40;
    }
    
    return {
        score,
        recommendation,
        reasons,
        estimatedSellDays,
        targetMarginPercentage,
        sellProbability,
        hasRecentActivity,
        priceStability: priceStability.toFixed(1),
        weeklyVolume: Math.round(weeklyVolume)
    };
}

// Calculate weekly flip selling strategy - balanced pricing for 3-7 day sales
function calculateWeeklyFlipStrategy(buyPrice, marketData, viability) {
    const avg = marketData.avg;
    const max = marketData.max;
    const min = marketData.min;
    
    // For weekly flips, we can price closer to average but still competitive
    // Target 75th-90th percentile for good balance of speed and profit
    
    // Quick sale pricing (3-4 days): 75th percentile 
    const quickSalePrice = min + ((avg - min) * 0.75);
    
    // Standard pricing (4-6 days): 80th percentile
    const standardPrice = min + ((avg - min) * 0.80);
    
    // Patient pricing (5-7 days): 85th percentile
    const patientPrice = min + ((avg - min) * 0.85);
    
    // Choose pricing based on viability and desired sell time
    let recommendedPrice;
    let expectedDays;
    
    if (viability.recommendation === 'WEEKLY_FLIP_EXCELLENT' && viability.score >= 65) { // Lowered from 80
        recommendedPrice = patientPrice; // Can afford to wait for better price
        expectedDays = '2-4';
    } else if (viability.recommendation === 'WEEKLY_FLIP_GOOD') {
        recommendedPrice = standardPrice; // Balanced approach
        expectedDays = '3-5';
    } else {
        recommendedPrice = quickSalePrice; // Price aggressively to ensure sale
        expectedDays = '4-7';
    }
    
    // Ensure minimum profit margin
    const minProfitMargin = 0.08; // 8% minimum
    const minPrice = buyPrice * (1 + minProfitMargin);
    if (recommendedPrice < minPrice) {
        recommendedPrice = minPrice;
        expectedDays = '5-7'; // Might take longer with higher price
    }
    
    return {
        quick: quickSalePrice,
        standard: standardPrice,
        patient: patientPrice,
        recommended: recommendedPrice,
        expectedProfit: recommendedPrice - buyPrice,
        expectedMargin: ((recommendedPrice - buyPrice) / buyPrice) * 100,
        expectedDays
    };
}

/**
 * Delays execution for a given number of milliseconds.
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Rate limiter that respects Skinport's 8 requests per 5 minutes limit.
 * We use 5 requests per 5 minutes to be conservative.
 */
async function waitForRateLimit() {
    const now = Date.now();
    
    // Remove old requests from the queue
    while (requestQueue.length > 0 && now - requestQueue[0] > RATE_LIMIT_WINDOW) {
        requestQueue.shift();
    }

    console.log(`[Rate Limiter] Current queue: ${requestQueue.length}/${MAX_REQUESTS_PER_WINDOW} requests in last ${RATE_LIMIT_WINDOW/1000}s`);

    if (requestQueue.length >= MAX_REQUESTS_PER_WINDOW) {
        // Queue is full, wait for the oldest request to expire
        const oldestRequestTime = requestQueue[0];
        const timeToWait = (oldestRequestTime + RATE_LIMIT_WINDOW) - now + 2000; // +2s buffer
        if (timeToWait > 0) {
            console.log(`[Rate Limiter] Rate limit reached. Waiting ${Math.round(timeToWait/1000)}s for the next available slot.`);
            await delay(timeToWait);
            
            // Clean up queue again after waiting
            const afterWait = Date.now();
            while (requestQueue.length > 0 && afterWait - requestQueue[0] > RATE_LIMIT_WINDOW) {
                requestQueue.shift();
            }
        }
    }
    
    // Add the new request timestamp to the queue
    requestQueue.push(Date.now());
    console.log(`[Rate Limiter] Request added. Queue now: ${requestQueue.length}/${MAX_REQUESTS_PER_WINDOW}`);
}

/**
 * Creates optimal batches based on URL length limits
 */
function createOptimalBatches(uniqueItems, maxUrlLength = 7000) {
    const batches = [];
    let currentBatch = [];
    let currentUrlLength = SKINPORT_API_URL.length + 100; // Base URL + params overhead
    
    // Helper function to clean and validate item names - MUCH MORE PERMISSIVE
    const cleanItemName = (name) => {
        // Only trim whitespace and normalize spaces - preserve all other characters
        return name.trim()
            .replace(/\s+/g, ' ');          // Normalize spaces only
    };

    // Filter and clean items before batching
    const validItems = uniqueItems
        .map(item => cleanItemName(item))
        .filter(item => {
            const isValid = item.length > 0 && item.length < 150; // Increased limit
            if (!isValid) {
                console.log(`[Batch] Skipping invalid item name: ${item}`);
            }
            return isValid;
        });
    
    for (const item of validItems) {
        const itemLength = encodeURIComponent(item).length + 1; // +1 for comma
        
        // If adding this item would exceed URL limit or we hit reasonable batch size
        if (currentUrlLength + itemLength > maxUrlLength || currentBatch.length >= 100) { // Increased to 100 items per batch for better efficiency while avoiding URL length issues
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
 * Fetches ALL Skinport items with current market data (prices, quantities)
 */
async function fetchAllSkinportItems(currency) {
    const cacheKey = `all_items_${currency}`;
    const cachedData = cache.get(cacheKey);

    if (cachedData) {
        console.log(`[Cache] All items cache hit`);
        return cachedData;
    }

    try {
        await waitForRateLimit();
        
        const params = new URLSearchParams({
            app_id: APP_ID_CSGO,
            currency: currency
        });
        
        const url = `${SKINPORT_API_URL}/items?${params}`;
        console.log(`[API Call] Fetching ALL Skinport items for current market data`);
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept-Encoding': 'br',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        if (!response.ok) {
            console.error(`[API Error] Failed to fetch all Skinport items. Status: ${response.status}`);
            return {};
        }

        const data = await response.json();
        console.log(`[API Response] Received ${data.length} total Skinport items`);
        
        // Convert to lookup object by market_hash_name
        const itemsLookup = {};
        data.forEach(item => {
            if (item.market_hash_name) {
                itemsLookup[item.market_hash_name] = {
                    market_hash_name: item.market_hash_name,
                    min_price: item.min_price,
                    max_price: item.max_price,
                    mean_price: item.mean_price,
                    median_price: item.median_price,
                    quantity: item.quantity,
                    created_at: item.created_at,
                    updated_at: item.updated_at
                };
            }
        });
        
        // Cache for 5 minutes
        cache.set(cacheKey, itemsLookup);
        console.log(`[Cache] All items cached: ${Object.keys(itemsLookup).length} items`);
        
        return itemsLookup;
        
    } catch (error) {
        console.error(`[Data Collection] Error fetching all Skinport items: ${error.message}`);
        return {};
    }
}

/**
 * Fetches sales history for multiple items in a single API call
 */
async function fetchSalesHistoryBatch(marketHashNames, currency) {
    // Validate and clean market hash names
    const validNames = marketHashNames.filter(name => {
        const isValid = typeof name === 'string' && 
                       name.trim().length > 0 && 
                       name.length < 200;
        
        if (!isValid) {
            console.log(`[API] Skipping invalid market_hash_name: ${name}`);
        }
        return isValid;
    }).map(name => name.trim());

    if (validNames.length === 0) {
        console.log(`[API] No valid items in batch`);
        return {};
    }

    const batchKey = `sales_history_${validNames.sort().join(',')}_${currency}`;
    const cachedData = cache.get(batchKey);

    if (cachedData) {
        console.log(`[Cache] Sales history cache hit for ${validNames.length} items`);
        return cachedData;
    }

    try {
        await waitForRateLimit();
        
        const marketHashNamesParam = validNames.join(',');
            
        const params = new URLSearchParams({
            app_id: APP_ID_CSGO,
            currency: currency,
            market_hash_name: marketHashNamesParam
        });
        
        const url = `${SKINPORT_API_URL}/sales/history?${params}`;
        console.log(`[API Call] Fetching sales history for batch of ${validNames.length} items`);
        console.log(`[API Call] Sample names:`, validNames.slice(0, 3));
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept-Encoding': 'br',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        if (!response.ok) {
            const responseText = await response.text();
            console.error(`[API Error] Failed to fetch sales history. Status: ${response.status} ${response.statusText}`);
            console.error(`[API Error] Response body: ${responseText.substring(0, 200)}...`);
            
            // Add retry logic for 502 errors
            if (response.status === 502) {
                console.log('[API Error] Received 502 Bad Gateway, waiting 5 seconds before retry...');
                await delay(5000);
                
                const retryResponse = await fetch(url, {
                    method: 'GET',
                    headers: {
                        'Accept-Encoding': 'br',
                        'Accept': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });
                
                if (retryResponse.ok) {
                    return await retryResponse.json();
                } else {
                    console.error('[API Error] Retry also failed');
                }
            }
            
            return {};
        }

        const data = await response.json();
        console.log(`[API Response] Sales history received for ${data.length} items`);
        
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
        console.log(`[Cache] Sales history cached for ${validNames.length} items`);
        
        return batchData;
        
    } catch (error) {
        console.error(`[Data Collection] Error fetching sales history: ${error.message}`);
        return {};
    }
}

// API endpoint to receive prices and return deals
app.post('/analyze-prices', async (req, res) => {
    const { items, settings } = req.body;
    if (!items || !Array.isArray(items) || !settings) {
        return res.status(400).json({ error: 'Invalid input. Expected an array of items and settings.' });
    }

    console.log(`[Backend] Received ${items.length} items for analysis.`);
    console.log(`[Backend] Sample items:`, items.slice(0, 3));
    
    // Debug StatTrak items specifically
    const statTrakItems = items.filter(item => {
        const itemName = item.marketHashName || item.name;
        return itemName && itemName.includes('StatTrak');
    });
    if (statTrakItems.length > 0) {
        console.log(`[StatTrak Debug] Found ${statTrakItems.length} StatTrak items:`);
        statTrakItems.slice(0, 3).forEach(item => {
            const itemName = item.marketHashName || item.name;
            console.log(`  - Name: "${itemName}"`);
            console.log(`  - Unicode chars: ${Array.from(itemName).map(c => `${c}(${c.charCodeAt(0)})`).join(' ')}`);
        });
    }

    try {
        const analyzedItems = [];
        
        // Extract unique market hash names (item names)
        const uniqueNames = [...new Set(items.map(item => {
            const rawName = item.marketHashName || item.name;
            return normalizeItemName(rawName);
        }).filter(name => name && name.trim()))];
        console.log(`[Backend] Extracted ${uniqueNames.length} unique item names.`);

        if (uniqueNames.length === 0) {
            return res.json({ 
                analyzedItems, 
                summary: { totalProcessed: 0, profitableFound: 0, message: 'No valid item names found' }
            });
        }

        // Fetch BOTH current market data AND sales history
        console.log(`[Backend] Fetching current market data for all items...`);
        const allMarketData = await fetchAllSkinportItems(settings.currency || 'EUR');
        
        console.log(`[Backend] Fetching sales history in batches...`);
        const batches = createOptimalBatches(uniqueNames);
        console.log(`[Backend] Split into ${batches.length} batches.`);

        // Fetch sales history for all batches
        const allSalesData = {};
        for (let i = 0; i < batches.length; i++) {
            console.log(`[Backend] Processing sales history batch ${i + 1}/${batches.length} (${batches[i].length} items)`);
            const batchData = await fetchSalesHistoryBatch(batches[i], settings.currency || 'EUR');
            Object.assign(allSalesData, batchData);
            
            // Delay between batches for rate limiting
            if (i < batches.length - 1) {
                console.log(`[Backend] Waiting 5 seconds before next batch...`);
                await delay(5000);
            }
        }

        console.log(`[Backend] Got market data for ${Object.keys(allMarketData).length} items`);
        console.log(`[Backend] Got sales history for ${Object.keys(allSalesData).length} items`);
        
        // Debug which items got both market and sales data
        if (statTrakItems.length > 0) {
            console.log(`[StatTrak Debug] Data availability check:`);
            statTrakItems.slice(0, 3).forEach(item => {
                const itemName = item.marketHashName || item.name;
                const hasMarketData = allMarketData[itemName];
                const hasSalesData = allSalesData[itemName];
                console.log(`  - "${itemName}": Market=${hasMarketData ? 'YES' : 'NO'}, Sales=${hasSalesData ? 'YES' : 'NO'}`);
            });
        }

        // Analyze each item for profitability using BOTH current market + sales history
        for (const item of items) {
            const rawItemName = item.marketHashName || item.name;
            const itemName = normalizeItemName(rawItemName);
            const itemPrice = item.price || item.skinportPrice;
            
            if (!itemName || !itemPrice) continue;

            // Get both current market data AND sales history
            const marketData = allMarketData[itemName];
            const salesData = allSalesData[itemName];
            
            if (!marketData) {
                console.log(`[Backend] No current market data for: ${itemName}`);
                continue;
            }
            
            if (!salesData) {
                console.log(`[Backend] No sales history for: ${itemName}`);
                continue;
            }

            // Debug: Log the structure for first few items
            if (analyzedItems.length < 3) {
                console.log(`[Debug] Market data for "${itemName}":`, JSON.stringify(marketData, null, 2));
                console.log(`[Debug] Sales data for "${itemName}":`, JSON.stringify(salesData, null, 2).substring(0, 500) + '...');
            }

            // Extract current market data (what people are selling for NOW)
            const currentMinPrice = marketData.min_price;
            const currentMaxPrice = marketData.max_price;
            const currentMeanPrice = marketData.mean_price;
            const currentMedianPrice = marketData.median_price;
            const currentQuantity = marketData.quantity;
            
            if (!currentMinPrice || currentMinPrice <= 0) {
                console.log(`[Backend] No valid current market price for: ${itemName}`);
                continue;
            }

            // Extract sales history data using multi-timeframe analysis
            const multiTimeframeAnalysis = analyzeMultiTimeframe(salesData);
            if (!multiTimeframeAnalysis) {
                console.log(`[Backend] No usable sales history for: ${itemName}`);
                continue;
            }
            
            const priceData = multiTimeframeAnalysis.bestTimeframe.data;
            const timeframePeriod = multiTimeframeAnalysis.bestTimeframe.period;
            
            console.log(`[Multi-Timeframe] ${itemName}: Using ${timeframePeriod} data (${priceData.volume} sales, trend: ${multiTimeframeAnalysis.trend})`);
            
            // SMART ACHIEVABLE PRICE: Use actual sales data for realistic pricing
            const skinportBuyPrice = typeof itemPrice === 'number' ? itemPrice : parseFloat(itemPrice.toString().replace(',', '.'));
            
            // Calculate smart achievable price based on sales data
            const smartPricing = calculateSmartAchievablePrice(skinportBuyPrice, marketData, multiTimeframeAnalysis, currentMinPrice);
            const achievableGrossPrice = smartPricing.achievablePrice;
            const achievableNetPrice = achievableGrossPrice * (1 - SKINPORT_FEE);
            
            // Calculate profit
            const profitAmount = achievableNetPrice - skinportBuyPrice;
            const profitPercentage = (profitAmount / skinportBuyPrice) * 100;
            
            console.log(`[Smart Pricing] ${itemName}:`);
            console.log(`  Strategy: ${smartPricing.strategy}`);
            console.log(`  Reasoning: ${smartPricing.reasoning}`);
            console.log(`  Buy Price: €${skinportBuyPrice.toFixed(2)}`);
            console.log(`  Achievable Price: €${achievableGrossPrice.toFixed(2)} → €${achievableNetPrice.toFixed(2)} net`);
            console.log(`  Profit: €${profitAmount.toFixed(2)} (${profitPercentage.toFixed(1)}%)`);
            
            // Skip items with no profit potential
            if (profitAmount <= 0) {
                console.log(`[Smart Pricing] ${itemName}: No profit potential - skipping`);
                continue;
            }
            
            // Apply user's minimum criteria (only basic filters now)
            const minProfitAmount = parseFloat(settings.minProfitAmount || 0);
            const minProfitPercentage = parseFloat(settings.minProfitPercentage || 0);
            
            if (profitAmount < minProfitAmount || profitPercentage < minProfitPercentage) {
                console.log(`[Smart Pricing] ${itemName}: Below user minimum (€${profitAmount.toFixed(2)}, ${profitPercentage.toFixed(1)}%) - skipping`);
                continue;
            }
            
            // Calculate overall confidence using simplified system
            const overallConfidence = calculateOverallConfidence(
                marketData, 
                multiTimeframeAnalysis, 
                smartPricing, 
                priceData.volume, 
                currentQuantity
            );
            
            // Calculate alternative pricing strategies for comparison
            const competitivePrice = currentMinPrice * 0.95;
            const conservativePrice = currentMinPrice * 0.90;
            const aggressivePrice = currentMinPrice * 0.98;
            
            // Time estimate based on confidence and market conditions
            let timeEstimate;
            if (overallConfidence.level === 'HIGH') {
                timeEstimate = '1-3 days';
            } else if (overallConfidence.level === 'MEDIUM') {
                timeEstimate = '2-5 days';
            } else {
                timeEstimate = '4-7 days';
            }
            
            // Validate pricing against sales history
            const salesAvgPrice = priceData.avg;
            const salesMinPrice = priceData.min;
            const salesMaxPrice = priceData.max;
            const salesVolume = priceData.volume;
            
            // Market analysis
            const pricePosition = (achievableGrossPrice - salesMinPrice) / (salesMaxPrice - salesMinPrice);
            const marketSpread = currentMaxPrice - currentMinPrice;
            const marketVolatility = (marketSpread / currentMeanPrice) * 100;
            
            // Calculate weekly flip viability and enhanced sell time estimates
            const weeklyFlipAnalysis = analyzeWeeklyFlipViability(itemName, priceData, salesData, multiTimeframeAnalysis.trend, marketVolatility);
            
            // Enhanced sell time estimate based on weekly flip analysis
            let enhancedTimeEstimate = timeEstimate; // Default from confidence
            if (weeklyFlipAnalysis && weeklyFlipAnalysis.estimatedSellDays) {
                enhancedTimeEstimate = weeklyFlipAnalysis.estimatedSellDays;
            }
            
            // Calculate market metrics for volatility display
            const marketMetrics = {
                vol7: marketVolatility / 100, // Convert to decimal for percentage display
                volatilityLevel: marketVolatility > 15 ? 'HIGH' : marketVolatility > 8 ? 'MEDIUM' : 'LOW',
                priceStability: weeklyFlipAnalysis ? weeklyFlipAnalysis.priceStability : 'Unknown'
            };
            
            // Create analyzed item with smart pricing
            analyzedItems.push({
                ...item,
                name: itemName,
                skinportPrice: itemPrice,
                
                // Current market data (what's listed now)
                currentMinPrice: currentMinPrice.toFixed(2),
                currentMaxPrice: currentMaxPrice.toFixed(2),
                currentMeanPrice: currentMeanPrice.toFixed(2),
                currentMedianPrice: currentMedianPrice.toFixed(2),
                currentQuantity: currentQuantity,
                
                // Sales history data (what actually sold)
                salesAvgPrice: salesAvgPrice.toFixed(2),
                salesMinPrice: salesMinPrice.toFixed(2),
                salesMaxPrice: salesMaxPrice.toFixed(2),
                salesVolume: salesVolume,
                timeframePeriod: timeframePeriod,
                
                // Smart pricing results
                achievablePrice: achievableNetPrice.toFixed(2), // What you'll actually get after fees
                grossAchievablePrice: achievableGrossPrice.toFixed(2), // What to list at before fees
                profitAmount: profitAmount.toFixed(2),
                profitPercentage: profitPercentage.toFixed(1),
                
                // Confidence and market analysis
                confidence: overallConfidence.level,
                confidenceScore: overallConfidence.score,
                confidenceFactors: overallConfidence.factors,
                timeEstimate: enhancedTimeEstimate,
                pricingStrategy: smartPricing.strategy,
                pricingReasoning: smartPricing.reasoning,
                trend: multiTimeframeAnalysis.trend,
                pricePosition: Math.round(pricePosition * 100),
                marketVolatility: marketVolatility.toFixed(1),
                
                // Market metrics for volatility display
                metrics: marketMetrics,
                
                // Weekly flip trading analysis
                weeklyFlipTrading: weeklyFlipAnalysis ? {
                    score: weeklyFlipAnalysis.score,
                    recommendation: weeklyFlipAnalysis.recommendation,
                    estimatedSellDays: weeklyFlipAnalysis.estimatedSellDays,
                    weeklyVolume: weeklyFlipAnalysis.weeklyVolume,
                    priceStability: weeklyFlipAnalysis.priceStability,
                    sellProbability: weeklyFlipAnalysis.sellProbability,
                    reasons: weeklyFlipAnalysis.reasons
                } : null,
                
                // Alternative pricing strategies for comparison
                strategies: {
                    smart: {
                        price: achievableGrossPrice.toFixed(2),
                        netPrice: achievableNetPrice.toFixed(2),
                        profit: profitAmount.toFixed(2),
                        profitPercent: profitPercentage.toFixed(1)
                    },
                    aggressive: {
                        price: aggressivePrice.toFixed(2),
                        netPrice: (aggressivePrice * (1 - SKINPORT_FEE)).toFixed(2),
                        profit: ((aggressivePrice * (1 - SKINPORT_FEE)) - skinportBuyPrice).toFixed(2),
                        profitPercent: (((aggressivePrice * (1 - SKINPORT_FEE)) - skinportBuyPrice) / skinportBuyPrice * 100).toFixed(1)
                    },
                    competitive: {
                        price: competitivePrice.toFixed(2),
                        netPrice: (competitivePrice * (1 - SKINPORT_FEE)).toFixed(2),
                        profit: ((competitivePrice * (1 - SKINPORT_FEE)) - skinportBuyPrice).toFixed(2),
                        profitPercent: (((competitivePrice * (1 - SKINPORT_FEE)) - skinportBuyPrice) / skinportBuyPrice * 100).toFixed(1)
                    },
                    conservative: {
                        price: conservativePrice.toFixed(2),
                        netPrice: (conservativePrice * (1 - SKINPORT_FEE)).toFixed(2),
                        profit: ((conservativePrice * (1 - SKINPORT_FEE)) - skinportBuyPrice).toFixed(2),
                        profitPercent: (((conservativePrice * (1 - SKINPORT_FEE)) - skinportBuyPrice) / skinportBuyPrice * 100).toFixed(1)
                    }
                },
                
                // Recommendation based on confidence and profit (UPDATED FOR REALISTIC MARGINS)
                recommendation: overallConfidence.level === 'HIGH' && profitPercentage > 5 ? 'STRONG_BUY' :
                               overallConfidence.level === 'HIGH' && profitPercentage > 3 ? 'BUY' :
                               overallConfidence.level === 'MEDIUM' && profitPercentage > 6 ? 'BUY' :
                               overallConfidence.level === 'MEDIUM' && profitPercentage > 3 ? 'CONSIDER' :
                               profitPercentage > 2 ? 'CONSIDER' : 'HOLD'
            });
            
            console.log(`[Smart Analysis] ${itemName}:`);
            console.log(`  Confidence: ${overallConfidence.level} (${overallConfidence.score}/100)`);
            console.log(`  Profit: €${profitAmount.toFixed(2)} (${profitPercentage.toFixed(1)}%)`);
            console.log(`  Time Estimate: ${timeEstimate}`);
            console.log(`  Strategy: ${smartPricing.strategy}`);
        }

        console.log(`[Backend] Analysis complete. Found ${analyzedItems.length} profitable items.`);
        
        // Add debug logging for item matching
        console.log(`[DEBUG] Final item names for matching:`);
        analyzedItems.slice(0, 5).forEach((item, index) => {
            console.log(`  ${index + 1}. Server: "${item.marketHashName}" | Wear: "${item.wear}" | Profit: €${item.profitAmount}`);
        });
        
        res.json({ 
            analyzedItems,
            summary: {
                totalProcessed: items.length,
                profitableFound: analyzedItems.length,
                uniqueItemsChecked: uniqueNames.length,
                marketDataFound: Object.keys(allMarketData).length,
                salesDataFound: Object.keys(allSalesData).length,
                strategy: 'Smart multi-timeframe pricing with sales data analysis',
                timeframe: 'Dynamic (24h, 7d, 30d, 90d)',
                algorithm: 'Enhanced smart pricing v2.0'
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
    console.log(`Enhanced Skinport Tracker API listening on port ${port}`);
    console.log(`Server started successfully with basic API endpoint`);
});
