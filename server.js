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
        if (currentUrlLength + itemLength > maxUrlLength || currentBatch.length >= 50) { // Reduced from 200 to 50 items per batch to prevent URL length issues
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
        const uniqueNames = [...new Set(items.map(item => item.marketHashName || item.name).filter(name => name && name.trim()))];
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
            const itemName = item.marketHashName || item.name;
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

            // Extract sales history data (what actually sold recently)
            let priceData = null;
            if (salesData.last_30_days && salesData.last_30_days.volume > 0) {
                priceData = salesData.last_30_days;
            } else if (salesData.last_90_days && salesData.last_90_days.volume > 0) {
                priceData = salesData.last_90_days;
            } else if (salesData.last_7_days && salesData.last_7_days.volume > 0) {
                priceData = salesData.last_7_days;
            } else {
                console.log(`[Backend] No usable sales history for: ${itemName}`);
                continue;
            }
            // HYBRID APPROACH: Use current market prices for competition, sales history for validation
            const skinportBuyPrice = typeof itemPrice === 'number' ? itemPrice : parseFloat(itemPrice.toString().replace(',', '.'));
            
            // Strategy: Undercut current market to sell quickly, but validate with sales history
            const competitiveSellPrice = currentMinPrice * 0.95; // Undercut lowest current listing by 5%
            const conservativeSellPrice = currentMinPrice * 0.90; // Undercut by 10% for guaranteed sale
            const aggressiveSellPrice = currentMinPrice * 0.98;   // Undercut by 2% for maximum profit
            
            // After Skinport's 8% seller fee
            const netCompetitivePrice = competitiveSellPrice * (1 - SKINPORT_FEE);
            const netConservativePrice = conservativeSellPrice * (1 - SKINPORT_FEE);
            const netAggressivePrice = aggressiveSellPrice * (1 - SKINPORT_FEE);
            
            // Calculate profits for different strategies
            const competitiveProfit = netCompetitivePrice - skinportBuyPrice;
            const conservativeProfit = netConservativePrice - skinportBuyPrice;
            const aggressiveProfit = netAggressivePrice - skinportBuyPrice;
            
            const competitiveProfitPercentage = (competitiveProfit / skinportBuyPrice) * 100;
            const conservativeProfitPercentage = (conservativeProfit / skinportBuyPrice) * 100;
            const aggressiveProfitPercentage = (aggressiveProfit / skinportBuyPrice) * 100;
            
            // Validate pricing against sales history
            const salesAvgPrice = priceData.avg;
            const salesMinPrice = priceData.min;
            const salesMaxPrice = priceData.max;
            const salesVolume = priceData.volume;
            
            // Check if our selling prices are realistic based on what actually sold
            const isPriceRealistic = competitiveSellPrice >= salesMinPrice && competitiveSellPrice <= salesMaxPrice;
            const pricePosition = (competitiveSellPrice - salesMinPrice) / (salesMaxPrice - salesMinPrice);
            
            // Market analysis combining current listings + sales history
            const currentMarketSpread = currentMaxPrice - currentMinPrice;
            const salesHistorySpread = salesMaxPrice - salesMinPrice;
            const marketVolatility = (currentMarketSpread / currentMeanPrice) * 100;
            const salesVolatility = (salesHistorySpread / salesAvgPrice) * 100;
            
            console.log(`[Hybrid Analysis] ${itemName}:`);
            console.log(`  Buy Price: €${skinportBuyPrice.toFixed(2)}`);
            console.log(`  Current Market: €${currentMinPrice.toFixed(2)} - €${currentMaxPrice.toFixed(2)} (${currentQuantity} listings)`);
            console.log(`  Sales History: €${salesMinPrice.toFixed(2)} - €${salesMaxPrice.toFixed(2)} (${salesVolume} sales, avg: €${salesAvgPrice.toFixed(2)})`);
            console.log(`  Competitive Strategy: €${competitiveSellPrice.toFixed(2)} → €${netCompetitivePrice.toFixed(2)} net → €${competitiveProfit.toFixed(2)} profit (${competitiveProfitPercentage.toFixed(1)}%)`);
            console.log(`  Price Validation: Realistic=${isPriceRealistic}, Position=${(pricePosition * 100).toFixed(0)}% of sales range`);
            
            // Use competitive strategy for main analysis
            const achievablePrice = competitiveSellPrice;
            const netAchievablePrice = netCompetitivePrice;
            const profitAmount = competitiveProfit;
            const profitPercentage = competitiveProfitPercentage;
            
            // Skip items with no profit potential or unrealistic pricing
            if (profitAmount <= 0) {
                console.log(`[Hybrid] ${itemName}: No profit potential - skipping`);
                continue;
            }
            
            if (!isPriceRealistic) {
                console.log(`[Hybrid] ${itemName}: Unrealistic pricing based on sales history - skipping`);
                continue;
            }

            // Enhanced validation using BOTH current market + sales history
            const minProfitAmount = parseFloat(settings.minProfitAmount || 0);
            const minProfitPercentage = parseFloat(settings.minProfitPercentage || 0);
            
            // Basic profit criteria
            const meetsBasicCriteria = profitAmount >= minProfitAmount && profitPercentage >= minProfitPercentage;
            
            // Market competition analysis (current listings)
            const hasGoodCompetition = currentQuantity >= 2 && currentQuantity <= 25; // Sweet spot for competition
            const competitionRating = currentQuantity >= 15 ? 'HIGH' : currentQuantity >= 8 ? 'MEDIUM' : currentQuantity >= 2 ? 'LOW' : 'VERY_LOW';
            
            // Sales volume analysis (historical data)  
            const hasGoodVolume = salesVolume >= 10; // At least 10 sales in the period
            const volumeRating = salesVolume >= 50 ? 'HIGH' : salesVolume >= 20 ? 'MEDIUM' : salesVolume >= 10 ? 'LOW' : 'VERY_LOW';
            
            // Price stability (how volatile the market is)
            const priceStability = Math.max(0, 100 - Math.max(marketVolatility, salesVolatility));
            const isStable = priceStability >= 30;
            
            // Weekly flip viability analysis
            const weeklyFlipViability = analyzeWeeklyFlipViability(itemName, priceData, salesData, 'STABLE', priceStability);
            const meetsWeeklyFlipCriteria = weeklyFlipViability.score >= 25;
            
            console.log(`[Validation] ${itemName}:`);
            console.log(`  Profit: €${profitAmount.toFixed(2)} (${profitPercentage.toFixed(1)}%)`);
            console.log(`  Competition: ${currentQuantity} listings (${competitionRating}), Volume: ${salesVolume} sales (${volumeRating})`);
            console.log(`  Stability: ${priceStability.toFixed(1)}%, Weekly Viability: ${weeklyFlipViability.score}/100`);
            console.log(`  Criteria: Basic=${meetsBasicCriteria}, Competition=${hasGoodCompetition}, Volume=${hasGoodVolume}, Stable=${isStable}, WeeklyFlip=${meetsWeeklyFlipCriteria}`);
            
            if (meetsBasicCriteria && hasGoodCompetition && hasGoodVolume && isStable && meetsWeeklyFlipCriteria) {
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
                    
                    // Profit calculations
                    achievablePrice: netAchievablePrice.toFixed(2), // What you'll actually get after fees
                    grossAchievablePrice: achievablePrice.toFixed(2), // What to list at before fees
                    profitAmount: profitAmount.toFixed(2),
                    profitPercentage: profitPercentage.toFixed(1),
                    
                    // Market analysis
                    priceStability: priceStability.toFixed(1),
                    competitionRating: competitionRating,
                    volumeRating: volumeRating,
                    isPriceRealistic: isPriceRealistic,
                    pricePosition: (pricePosition * 100).toFixed(0),
                    
                    // Strategy details
                    strategies: {
                        aggressive: {
                            price: aggressiveSellPrice.toFixed(2),
                            netPrice: netAggressivePrice.toFixed(2),
                            profit: aggressiveProfit.toFixed(2),
                            profitPercent: aggressiveProfitPercentage.toFixed(1)
                        },
                        competitive: {
                            price: competitiveSellPrice.toFixed(2),
                            netPrice: netCompetitivePrice.toFixed(2),
                            profit: competitiveProfit.toFixed(2),
                            profitPercent: competitiveProfitPercentage.toFixed(1)
                        },
                        conservative: {
                            price: conservativeSellPrice.toFixed(2),
                            netPrice: netConservativePrice.toFixed(2),
                            profit: conservativeProfit.toFixed(2),
                            profitPercent: conservativeProfitPercentage.toFixed(1)
                        }
                    },
                    
                    // Weekly flip analysis
                    weeklyFlipViability: weeklyFlipViability,
                    
                    recommendation: profitPercentage > 20 ? 'STRONG_BUY' : 
                                   profitPercentage > 10 ? 'BUY' : 
                                   profitPercentage > 5 ? 'CONSIDER' : 'HOLD'
                });
                
                console.log(`[Enhanced Profit] ${itemName}:`);
                console.log(`  Profit: €${profitAmount.toFixed(2)} (${profitPercentage.toFixed(1)}%)`);
                console.log(`  Risk: ${competitionRating}, Confidence: ${priceStability.toFixed(1)}%, Listings: ${currentQuantity}`);
                console.log(`  Liquidity: ${volumeRating}, Trend: STABLE`);
            } else if (profitAmount >= -2.0) {
                // Log items that are close to profitable for debugging
                console.log(`[Almost Profitable] ${itemName}:`);
                console.log(`  Buy Price: €${skinportBuyPrice.toFixed(2)}, Current Min: €${currentMinPrice.toFixed(2)}, After Fees: €${netAchievablePrice.toFixed(2)}`);
                console.log(`  Profit: €${profitAmount.toFixed(2)} (${profitPercentage.toFixed(1)}%) - Missing profit by €${Math.abs(profitAmount).toFixed(2)}`);
                console.log(`  Failed criteria: Basic=${meetsBasicCriteria}, Competition=${hasGoodCompetition}, Volume=${hasGoodVolume}, Stable=${isStable}, WeeklyFlip=${meetsWeeklyFlipCriteria}`);
                console.log(`  This item needs €${Math.abs(profitAmount + 1.0).toFixed(2)} less buy price to be profitable`);
            }
        }

        console.log(`[Backend] Analysis complete. Found ${analyzedItems.length} profitable items.`);
        
        res.json({ 
            analyzedItems,
            summary: {
                totalProcessed: items.length,
                profitableFound: analyzedItems.length,
                uniqueItemsChecked: uniqueNames.length,
                marketDataFound: Object.keys(allMarketData).length,
                salesDataFound: Object.keys(allSalesData).length,
                strategy: 'Hybrid Skinport market + sales history analysis',
                timeframe: '3-7 day flip trading'
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
